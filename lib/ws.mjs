// 极小的 WebSocket 服务端实现（RFC 6455 子集）。
//
// 为什么不用 ws 这个包：技术路线要求零 npm 依赖。
// 我们只需要服务"同机 codex app-server 连过来"这一种场景：
//   - 握手：校验 Sec-WebSocket-Key，回 101
//   - 帧：文本帧（opcode 1）、掩码（客户端必须掩码）、分片不需要支持
//   - 控制帧：ping / pong / close
// 不支持的（明确不做，遇到就报错而不是装作支持）：扩展、压缩、二进制大帧、复杂分片。

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.handlers = { message: [], close: [] };
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#emitClose());
    socket.on('error', () => this.#emitClose());
  }

  on(event, fn) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(fn);
    return this;
  }

  #emitClose() {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.handlers.close ?? []) {
      try {
        fn();
      } catch {
        /* 单点错误不影响其他监听者 */
      }
    }
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // 防御：单条控制帧不该大到这个程度，超过就直接断开，避免被人塞爆内存
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.close(1009, '消息太大');
      return;
    }
    for (;;) {
      const frame = decodeFrame(this.buffer);
      if (!frame) break;
      this.buffer = this.buffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        this.close();
        break;
      }
      if (frame.opcode === 0x9) {
        this.#sendFrame(0xa, frame.payload);
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode === 0x1) {
        for (const fn of this.handlers.message ?? []) {
          try {
            fn(frame.payload.toString('utf8'));
          } catch {
            /* 交给上层自己记日志 */
          }
        }
        continue;
      }
      // 二进制或分片：这个实现不处理，直接关闭并说明原因
      this.close(1003, '暂不支持该帧类型');
      break;
    }
  }

  #sendFrame(opcode, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.#emitClose();
    }
  }

  /** 发送一条文本消息。 */
  send(text) {
    this.#sendFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  /** 发送一条 JSON-RPC 消息。 */
  sendJson(obj) {
    this.send(JSON.stringify(obj));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.#sendFrame(0x8, payload);
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* 已经断了 */
    }
    this.#emitClose();
  }
}

/** 解析一帧；数据不够返回 null。 */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(8 * 1024 * 1024)) throw new Error('帧太大（>8MB），拒绝');
    len = Number(big);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (mask) {
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
    payload = out;
  }
  return { fin, opcode, payload, consumed: offset + len };
}

/**
 * 把一条 HTTP upgrade 请求升级成 WebSocket。
 * @returns {WebSocketConnection}
 */
export function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    throw new Error('缺少 Sec-WebSocket-Key');
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'),
  );
  return new WebSocketConnection(socket);
}
