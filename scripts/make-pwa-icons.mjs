// 程序化生成 PWA 图标（2026-11-14）——与 iOS 占位图标同一套图形与色板
// （scripts/make-ios-icons.mjs 的 sample/render 逻辑，抽成公用模块）。
//
// 为什么需要：Qin 2（无 GMS、系统 WebView 过旧）跑不了 Capacitor 壳，
// 但浏览器可用——「添加到主屏幕」的 PWA 形态是那台设备的正解。
// 浏览器要把它当 App 装，主屏必须有图标（192/512），否则只有一坨文字。
//
// 用法：node scripts/make-pwa-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/icons');

// —— 产品色板（src/app/globals.css :root，同源）——
const PAPER = [250, 247, 242]; // #faf7f2
const ACCENT = [122, 106, 79]; // #7a6a4f

// —— PNG 编码（RGBA8、每行 0 号滤波、zlib deflate、CRC32 表驱动）——
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// —— 图形判定（与 iOS 图标同款：硬币 + 新芽）——
function sampleCoin(x, y, cx, cy, R) {
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > R) return PAPER;
  if (d > R * 0.84 && d < R * 0.88) return PAPER;
  return ACCENT;
}

function sampleSprout(x, y, cx, cy, R) {
  const dx = x - cx;
  const dy = y - cy;
  if (Math.abs(dx) <= R * 0.035 && dy >= -R * 0.52 && dy <= R * 0.4) return PAPER;
  const leaf = (ex, ey, ax, ay) => {
    const lx = dx - ex;
    const ly = dy - ey;
    const u = lx * ax + ly * ay;
    const v = -lx * ay + ly * ax;
    const A = R * 0.28;
    const B = R * 0.12;
    return (u / A) * (u / A) + (v / B) * (v / B) <= 1;
  };
  const S = Math.SQRT1_2;
  if (leaf(-R * 0.24, -R * 0.3, -S, -S)) return PAPER;
  if (leaf(R * 0.24, -R * 0.3, S, -S)) return PAPER;
  return null;
}

function sample(x, y, cx, cy, R) {
  const sprout = sampleSprout(x, y, cx, cy, R);
  if (sprout) return sprout;
  return sampleCoin(x, y, cx, cy, R);
}

function render(size, R) {
  const SS = 2;
  const step = 1 / SS;
  const rgba = new Uint8Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const col = sample(x + (sx + 0.5) * step, y + (sy + 0.5) * step, c, c, R);
          r += col[0];
          g += col[1];
          b += col[2];
        }
      }
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / (SS * SS));
      rgba[i + 1] = Math.round(g / (SS * SS));
      rgba[i + 2] = Math.round(b / (SS * SS));
      rgba[i + 3] = 255;
    }
  }
  return encodePNG(size, size, rgba);
}

mkdirSync(OUT, { recursive: true });
const TARGETS = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 },
];
for (const t of TARGETS) {
  writeFileSync(join(OUT, t.file), render(t.size, t.size * 0.34));
  console.log(`✅ public/icons/${t.file}（${t.size}×${t.size}）`);
}
