// WebSocket 极小实现的测试。
//
// 这个模块是给"同机 codex app-server 连过来"用的，写错了会表现成"连上但收不到消息"。
// 所以这里用一个真 socket 走完整握手 + 掩码帧 + 两种扩展长度（126 / 127）路径。
//
// 注意：每个测试都带硬超时。node:test 在套件跑完前不打印，一旦有测试挂住，
// 表现是"完全没有输出"，没有超时的话极难定位。

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import { acceptUpgrade } from '../lib/ws.mjs';

const T = { timeout: 5000 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按 RFC 6455 编一个客户端帧（客户端必须掩码）。 */
function encodeClientFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const mask = crypto.randomBytes(4);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** 解一个服务端帧（服务端不掩码）。返回 null 表示数据还不够。 */
function decodeServerFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (buf.length < offset + len) return null;
  return { opcode, payload: buf.subarray(offset, offset + len), consumed: offset + len };
}

/** 起一个只跑握手的服务端。 */
async function startWsServer() {
  const connections = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(426).end('需要 WebSocket 升级');
  });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    const conn = acceptUpgrade(req, socket);
    conn.on('close', () => sockets.delete(socket));
    connections.push(conn);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    connections,
    /** 强制关掉一切，保证测试结束后没有残留句柄。 */
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** 极简客户端：完成握手后收集收到的帧。 */
function connectClient(port) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        [
          'GET / HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n',
        ].join('\r\n'),
      );
    });
    let buf = Buffer.alloc(0);
    let handshakeDone = false;
    const frames = [];
    const api = {
      socket,
      frames,
      send: (payload) => socket.write(encodeClientFrame(payload)),
      sendRaw: (b) => socket.write(b),
      close: () => socket.destroy(),
    };

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString('utf8');
        buf = buf.subarray(idx + 4);
        const expected = crypto
          .createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        if (!head.includes('101')) return reject(new Error(`握手失败：${head.split('\r\n')[0]}`));
        if (!head.includes(expected)) return reject(new Error('Sec-WebSocket-Accept 不正确'));
        handshakeDone = true;
        resolve(api);
      }
      for (;;) {
        const frame = decodeServerFrame(buf);
        if (!frame) break;
        buf = buf.subarray(frame.consumed);
        frames.push({ opcode: frame.opcode, text: frame.payload.toString('utf8') });
      }
    });
    socket.on('error', reject);
    socket.on('close', () => {
      if (!handshakeDone) reject(new Error('连接在握手前关闭'));
    });
  });
}

test('WebSocket 握手成功，且 Sec-WebSocket-Accept 计算正确', T, async () => {
  const srv = await startWsServer();
  const client = await connectClient(srv.port);
  assert.equal(srv.connections.length, 1);
  client.close();
  await srv.close();
});

test('服务端能收到客户端发来的掩码文本帧（短帧）', T, async () => {
  const srv = await startWsServer();
  const received = [];
  const client = await connectClient(srv.port);
  await wait(30);
  srv.connections[0].on('message', (text) => received.push(text));
  client.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
  await wait(60);
  assert.deepEqual(received, ['{"jsonrpc":"2.0","id":1,"method":"initialize"}']);
  client.close();
  await srv.close();
});

test('扩展长度帧：126（中）与 127（大）两条路径都能解对', T, async () => {
  const srv = await startWsServer();
  const received = [];
  const client = await connectClient(srv.port);
  await wait(30);
  srv.connections[0].on('message', (text) => received.push(text));

  const mid = '中'.repeat(200); // UTF-8 下 600 字节 > 125，走 126 分支
  const big = 'x'.repeat(70_000); // 走 127 分支
  client.send(mid);
  client.send(big);
  await wait(200);

  assert.equal(received.length, 2);
  assert.equal(received[0], mid);
  assert.equal(received[1], big);
  client.close();
  await srv.close();
});

test('服务端能向客户端回发 JSON-RPC 消息', T, async () => {
  const srv = await startWsServer();
  const client = await connectClient(srv.port);
  await wait(30);
  srv.connections[0].sendJson({ jsonrpc: '2.0', method: 'turn/completed', params: { turnId: 't1' } });
  await wait(60);
  assert.equal(client.frames.length, 1);
  assert.equal(client.frames[0].opcode, 0x1);
  assert.deepEqual(JSON.parse(client.frames[0].text), {
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: { turnId: 't1' },
  });
  client.close();
  await srv.close();
});

test('ping 会被回 pong，close 帧会关闭连接', T, async () => {
  const srv = await startWsServer();
  const client = await connectClient(srv.port);
  await wait(30);
  client.sendRaw(encodeClientFrame('ping-payload', 0x9));
  await wait(60);
  const pong = client.frames.find((f) => f.opcode === 0xa);
  assert.ok(pong, '应当收到 pong');
  assert.equal(pong.text, 'ping-payload');

  client.sendRaw(encodeClientFrame('', 0x8));
  await wait(80);
  assert.equal(srv.connections[0].closed, true, '收到 close 帧后连接应标记为已关闭');
  client.close();
  await srv.close();
});

test('非升级请求不会走进 WebSocket 逻辑（426）', T, async () => {
  const srv = await startWsServer();
  const res = await fetch(`http://127.0.0.1:${srv.port}/`);
  assert.equal(res.status, 426);
  await res.text();
  await srv.close();
});
