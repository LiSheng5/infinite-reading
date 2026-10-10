#!/usr/bin/env node
/**
 * 应用图标生成器（PWA / favicon / 桌面图标）
 *
 * 图形就是「∞」：一条 Gerono 双纽线（x = a·cos t，y = b·sin t·cos t）描粗，
 * 同一个数学定义同时产出矢量（icon.svg 的 polyline）与位图（PNG 全手写，零依赖）。
 *
 * 产物（已随仓库提交，运行时不需要跑这个脚本）：
 *   icons/icon.svg              矢量图标（可无限缩放，也供 maskable 用）
 *   icons/icon-192.png          favicon / manifest
 *   icons/icon-512.png          manifest / 商店图
 *   icons/icon-maskable-512.png maskable（满幅底色 + 安全区内图形）
 *   icons/apple-touch-icon.png  iOS 主屏图标（180，满幅）
 *
 * 用法：node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');

/* ---------- 配色：与 css/style.css 的 :root 保持一致 ---------- */
const BG = [37, 99, 235];      // --accent  #2563eb
const FG = [255, 255, 255];    // --on-accent

/* ---------- PNG 手写编码（IHDR + IDAT + IEND），不引第三方库 ---------- */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // 位深
  ihdr[9] = 6;      // 颜色类型：RGBA
  ihdr[10] = 0;     // 压缩
  ihdr[11] = 0;     // 滤波
  ihdr[12] = 0;     // 非隔行
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;                                   // 每行滤波器 = None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 图形：Gerono 双纽线 ---------- */
function lemniscate(a, b, samples) {
  const pts = [];
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * Math.PI * 2;
    pts.push([a * Math.cos(t), b * Math.sin(t) * Math.cos(t)]);
  }
  return pts;
}

/**
 * 画一个图标。
 *   size     画布边长
 *   bleed    true = 满幅底色（maskable / iOS）；false = 圆角矩形
 *   glyphPct 图形占画布的比例（对半宽而言）
 */
function draw(size, bleed, glyphPct) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const a = size * glyphPct;
  const b = a * 1.26;
  const half = Math.max(2, size * (bleed ? 0.055 : 0.065));   // 笔画半宽
  const pts = lemniscate(a, b, size >= 512 ? 720 : 320);

  // 图形包围盒（留出笔画与外扩）
  const pad = half + 2;
  const x0 = Math.max(0, Math.floor(size / 2 - a - pad));
  const x1 = Math.min(size, Math.ceil(size / 2 + a + pad));
  const y0 = Math.max(0, Math.floor(size / 2 - b / 2 - pad));
  const y1 = Math.min(size, Math.ceil(size / 2 + b / 2 + pad));

  const inRounded = (x, y) => {
    if (bleed) return true;
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    const dx = x - cx, dy = y - cy;
    if (dx === 0 && dy === 0) return true;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRounded(x + 0.5, y + 0.5)) continue;             // 圆角外保持透明
      const px = x + 0.5 - size / 2;
      const py = y + 0.5 - size / 2;

      // 底色
      let r = BG[0], g = BG[1], bl = BG[2], alpha = 255;

      // 离曲线最近的距离（够近就画图形）
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        let best = Infinity;
        for (let k = 0; k < pts.length; k++) {
          const dx = px - pts[k][0];
          const dy = py - pts[k][1];
          const d2 = dx * dx + dy * dy;
          if (d2 < best) best = d2;
        }
        const cover = Math.min(1, Math.max(0, half + 0.5 - Math.sqrt(best)));
        if (cover > 0) {
          r = Math.round(r + (FG[0] - r) * cover);
          g = Math.round(g + (FG[1] - g) * cover);
          bl = Math.round(bl + (FG[2] - bl) * cover);
        }
      }

      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = bl;
      rgba[i + 3] = alpha;
    }
  }
  return encodePNG(size, rgba);
}

/* ---------- 矢量版：同一组采样点直接写成 polyline ---------- */
function svg() {
  const S = 512;
  const a = S * 0.30, b = a * 1.26;
  const pts = lemniscate(a, b, 240)
    .map(([x, y]) => (S / 2 + x).toFixed(1) + ',' + (S / 2 + y).toFixed(1))
    .join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="无限阅读">
  <rect width="${S}" height="${S}" rx="113" fill="#2563eb"/>
  <polyline points="${pts}" fill="none" stroke="#ffffff" stroke-width="${(S * 0.065 * 2).toFixed(1)}"
            stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

mkdirSync(OUT, { recursive: true });
const files = [
  ['icon.svg', Buffer.from(svg(), 'utf8')],
  ['icon-192.png', draw(192, false, 0.30)],
  ['icon-512.png', draw(512, false, 0.30)],
  ['icon-maskable-512.png', draw(512, true, 0.26)],
  ['apple-touch-icon.png', draw(180, true, 0.28)],
];
for (const [name, buf] of files) {
  writeFileSync(join(OUT, name), buf);
  console.log('已生成 icons/' + name + '（' + (buf.length / 1024).toFixed(1) + ' KB）');
}
