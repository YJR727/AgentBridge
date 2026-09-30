// 生成 PWA 图标与 Apple touch icon。零依赖：lib/png.mjs 自己编码 PNG。
//
// 运行：node tools/make-icons.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drawIcon, encodePng } from '../lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'public');

const targets = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'favicon.png', size: 64 },
];

fs.mkdirSync(outDir, { recursive: true });

for (const { name, size } of targets) {
  const rgba = drawIcon(size);
  const png = encodePng(size, size, rgba);
  const file = path.join(outDir, name);
  fs.writeFileSync(file, png);
  console.log(`已生成 ${name}  ${size}x${size}  ${png.length} 字节`);
}

// 顺带写一个 SVG 版，给浏览器标签页用（体积小、任意缩放）
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Agent Bridge">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2563eb"/>
      <stop offset="1" stop-color="#0ea5e9"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="112" fill="url(#g)"/>
  <rect x="102" y="225" width="308" height="46" rx="8" fill="#ffffff"/>
  <rect x="133" y="225" width="51" height="154" rx="8" fill="#ffffff"/>
  <rect x="328" y="225" width="51" height="154" rx="8" fill="#ffffff"/>
  <path d="M150 379 A106 106 0 0 1 362 379" fill="none" stroke="#ffffff" stroke-width="28" stroke-linecap="round"/>
</svg>
`;
fs.writeFileSync(path.join(outDir, 'icon.svg'), svg);
console.log('已生成 icon.svg');
