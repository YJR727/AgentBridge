// 极小的 PNG 编码器（只处理 RGBA8、无隔行）。
//
// 为什么自己写：需求要求零 npm 依赖，而图标必须是真实可用的 PNG
// （PWA 安装、推送通知大图都会校验图片格式，塞一个假文件会在手机上暴露成"图标空白"）。
// 只用 node:zlib 的 deflate + CRC32，几十行就够。

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * 把 RGBA 像素编成 PNG。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 长度必须是 width*height*4
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`像素数据长度不符：期望 ${width * height * 4}，实际 ${rgba.length}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // 位深
  ihdr.writeUInt8(6, 9); // 颜色类型 6 = RGBA
  ihdr.writeUInt8(0, 10); // 压缩方法
  ihdr.writeUInt8(0, 11); // 过滤方法
  ihdr.writeUInt8(0, 12); // 隔行

  // 每行前面加一个 filter 字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 画一个圆角方块 + 中间一个"桥"形状的图标。
 * 用纯函数式画法：按像素算距离，带 4x 超采样抗锯齿。
 */
export function drawIcon(size, { bg1 = [37, 99, 235], bg2 = [14, 165, 233], fg = [255, 255, 255] } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const ss = 3; // 每像素采样 ss*ss 次

  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  // 桥的两个桥墩 + 桥面
  const pierW = size * 0.1;
  const pierH = size * 0.3;
  const deckY = size * 0.44;
  const deckH = size * 0.09;
  const leftPierX = size * 0.26;
  const rightPierX = size * 0.64;
  const deckX = size * 0.2;
  const deckW = size * 0.6;

  const inBridge = (x, y) => {
    if (x >= deckX && x <= deckX + deckW && y >= deckY && y <= deckY + deckH) return true;
    if (x >= leftPierX && x <= leftPierX + pierW && y >= deckY && y <= deckY + pierH) return true;
    if (x >= rightPierX && x <= rightPierX + pierW && y >= deckY && y <= deckY + pierH) return true;
    // 桥面下的拱
    const archCx = size / 2;
    const archCy = deckY + deckH;
    const archR = size * 0.19;
    const d = Math.hypot(x - archCx, (y - archCy) * 1.15);
    if (d <= archR && d >= archR - size * 0.055 && y >= archCy) return true;
    return false;
  };

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let fgHits = 0;
      let samples = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = px + (sx + 0.5) / ss;
          const y = py + (sy + 0.5) / ss;
          samples++;
          if (inRounded(x, y)) {
            bgHits++;
            if (inBridge(x, y)) fgHits++;
          }
        }
      }
      const i = (py * size + px) * 4;
      if (bgHits === 0) {
        rgba[i] = 0;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
        rgba[i + 3] = 0;
        continue;
      }
      const t = py / Math.max(1, size - 1);
      const base = [
        Math.round(bg1[0] + (bg2[0] - bg1[0]) * t),
        Math.round(bg1[1] + (bg2[1] - bg1[1]) * t),
        Math.round(bg1[2] + (bg2[2] - bg1[2]) * t),
      ];
      const fgRatio = fgHits / samples;
      const bgRatio = bgHits / samples;
      rgba[i] = Math.round(base[0] * (1 - fgRatio) + fg[0] * fgRatio);
      rgba[i + 1] = Math.round(base[1] * (1 - fgRatio) + fg[1] * fgRatio);
      rgba[i + 2] = Math.round(base[2] * (1 - fgRatio) + fg[2] * fgRatio);
      rgba[i + 3] = Math.round(255 * bgRatio);
    }
  }
  return rgba;
}
