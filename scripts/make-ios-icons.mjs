// 程序化生成 iOS 占位图标与启动屏（docs/11 M1）——仓库无品牌视觉素材、Linux 侧无
// ImageMagick/sharp，故用 Node 标准库手写 PNG 编码器逐像素绘制：
//   暖纸底（--paper）+ 橄榄棕硬币（--accent）内嵌纸色新芽 —— 「钱 + 长出活法」的极简占位。
// 正式视觉定稿后重跑本脚本（改 PAPER/ACCENT/图形判定）即可整体替换，目录结构不变。
// 用法：node scripts/make-ios-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'shell/ios/App/App/Assets.xcassets');

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
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // 滤波 0
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// —— 图形判定：硬币 + 新芽。坐标以硬币半径 R 为单位，屏幕坐标 y 向下 ——
// 硬币盘；0.84–0.88R 一圈纸色内环（硬币边缘的刻线）。
function sampleCoin(x, y, cx, cy, R) {
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > R) return PAPER;
  if (d > R * 0.84 && d < R * 0.88) return PAPER;
  return ACCENT;
}

// 新芽（纸色，压在硬币盘上）：中茎 + 左右两片斜叶（单位轴向量法判旋转椭圆）。
function sampleSprout(x, y, cx, cy, R) {
  const dx = x - cx;
  const dy = y - cy;
  // 茎：竖条，从盘心下方 0.40R 到叶柄上方 0.52R
  if (Math.abs(dx) <= R * 0.035 && dy >= -R * 0.52 && dy <= R * 0.4) return PAPER;
  // 叶：长轴 a、短轴 b，轴向量 (ax, ay)；u = 沿轴投影，v = 垂直投影
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
  if (leaf(-R * 0.24, -R * 0.3, -S, -S)) return PAPER; // 左叶，指向左上
  if (leaf(R * 0.24, -R * 0.3, S, -S)) return PAPER; // 右叶，指向右上
  return null;
}

function sample(x, y, cx, cy, R) {
  const sprout = sampleSprout(x, y, cx, cy, R);
  if (sprout) return sprout;
  return sampleCoin(x, y, cx, cy, R);
}

// 渲染一张正方形画布（2× 超采样抗锯齿；曲线都是大半径，2× 足够）
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
      const n = SS * SS;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = 255;
    }
  }
  return encodePNG(size, size, rgba);
}

// 图标：1024×1024，硬币半径 316（盘面直径 ≈62%，留足 iOS 圆角裁切余量）
const icon = render(1024, 316);
writeFileSync(join(ASSETS, 'AppIcon.appiconset/AppIcon-512@2x.png'), icon);
console.log('AppIcon-512@2x.png', icon.length, 'bytes');

// 启动屏：2732×2732 ×3（1x/2x/3x 同图，Contents.json 已如此声明），
// 硬币半径 300（组合约占宽 22%，居中，避开各机型裁切）
const splash = render(2732, 300);
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  writeFileSync(join(ASSETS, 'Splash.imageset', name), splash);
  console.log(name, splash.length, 'bytes');
}
