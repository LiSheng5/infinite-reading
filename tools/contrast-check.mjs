#!/usr/bin/env node
/**
 * 对比度护栏（UI-1 §6.1）：解析 css/tokens.css 的 :root 自定义属性（阶段 3 起令牌真源），
 * 按「令牌对」清单计算 WCAG 对比度；不达标 / 令牌缺失 → exit 1。
 * 零依赖（纯 Node）。带透明度的色值先叠到其底色上再算。
 *
 * 用法：node tools/contrast-check.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'css', 'tokens.css'), 'utf8');

/* ---------------- :root 令牌 ---------------- */

const rootMatch = CSS.match(/:root\s*\{([\s\S]*?)\}/);
if (!rootMatch) {
  console.error('找不到 :root 令牌块');
  process.exit(1);
}
const VARS = new Map();
for (const m of rootMatch[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
  VARS.set(m[1], m[2].trim());
}

function rawOf(name) {
  const key = name.startsWith('--') ? name : '--' + name;
  if (!VARS.has(key)) {
    const err = new Error('令牌缺失：' + key);
    err.missing = true;
    throw err;
  }
  let v = VARS.get(key);
  const seen = new Set([key]);
  for (;;) {
    const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
    if (!m) return v;
    if (seen.has(m[1])) throw new Error('令牌循环引用：' + key);
    seen.add(m[1]);
    if (!VARS.has(m[1])) {
      const err = new Error('令牌缺失：' + m[1] + '（' + key + ' 引用）');
      err.missing = true;
      throw err;
    }
    v = VARS.get(m[1]);
  }
}

/* ---------------- 颜色解析与合成 ---------------- */

function parseColor(str) {
  const s = String(str).trim();
  let m = /^#([0-9a-fA-F]{3})$/.exec(s);
  if (m) {
    const h = m[1];
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
      a: 1,
    };
  }
  m = /^#([0-9a-fA-F]{6})$/.exec(s);
  if (m) {
    const h = m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = /^#([0-9a-fA-F]{8})$/.exec(s);
  if (m) {
    const h = m[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: parseInt(h.slice(6, 8), 16) / 255,
    };
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const parts = m[1].split(/[,/]+/).map(x => x.trim()).filter(Boolean);
    if (parts.length < 3) throw new Error('颜色通道不足：' + str);
    const num = (p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    return {
      r: num(parts[0]),
      g: num(parts[1]),
      b: num(parts[2]),
      a: parts.length > 3 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1,
    };
  }
  throw new Error('无法解析颜色：' + str);
}

// 带透明度的前景叠到底色上（不透明结果）
function composite(fg, bg) {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function luminance(c) {
  const f = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrast(c1, c2) {
  const l1 = luminance(c1);
  const l2 = luminance(c2);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// 取「实际参与对比的不透明颜色」：tokenName 的色值，带 alpha 时先叠到 overName 上
function opaqueColorOf(tokenName, overName) {
  const raw = rawOf(tokenName);
  const c = parseColor(raw);
  if (c.a >= 1) return c;
  return composite(c, parseColor(rawOf(overName || 'bg')));
}

/* ---------------- 令牌对清单（§6.1） ---------------- */

const PAIRS = [
  // 文字类 ≥ 4.5:1
  { fg: 'ink', bg: 'bg', min: 4.5, kind: 'text' },
  { fg: 'ink', bg: 'surface', min: 4.5, kind: 'text' },
  { fg: 'ink', bg: 'surface-2', min: 4.5, kind: 'text' },
  { fg: 'ink', bg: 'accent-soft', over: 'bg', min: 4.5, kind: 'text' },
  { fg: 'ink-dim', bg: 'bg', min: 4.5, kind: 'text' },
  { fg: 'ink-dim', bg: 'surface', min: 4.5, kind: 'text' },
  { fg: 'ink-dim', bg: 'surface-2', min: 4.5, kind: 'text' },
  { fg: 'accent', bg: 'bg', min: 4.5, kind: 'text' },
  { fg: 'accent', bg: 'surface', min: 4.5, kind: 'text' },
  { fg: 'accent', bg: 'surface-2', min: 4.5, kind: 'text' },
  { fg: 'on-accent', bg: 'accent', min: 4.5, kind: 'text' },
  { fg: 'on-ink', bg: 'ink', min: 4.5, kind: 'text' },
  { fg: 'danger', bg: 'bg', min: 4.5, kind: 'text' },
  // 图形与控件边界 ≥ 3:1
  { fg: 'accent', bg: 'bg', min: 3, kind: 'graphics' },
  { fg: 'line-strong', bg: 'bg', min: 3, kind: 'graphics' },
  { fg: 'line-strong', bg: 'surface', min: 3, kind: 'graphics' },
  // 装饰线 ≥ 1.1:1（仅纯装饰分隔线，阈值刻意放宽）
  { fg: 'line', bg: 'bg', min: 1.1, kind: 'decor' },
];

const rows = [];
let failed = 0;

for (const p of PAIRS) {
  const label = '--' + p.fg + ' / --' + p.bg;
  try {
    const fg = opaqueColorOf(p.fg, p.over || p.bg);
    const bg = opaqueColorOf(p.bg, 'bg');
    const ratio = contrast(fg, bg);
    const ok = ratio + 1e-9 >= p.min;
    if (!ok) failed += 1;
    rows.push({
      令牌对: label,
      用途: p.kind,
      比值: ratio.toFixed(2) + ':1',
      要求: '≥ ' + p.min + ':1',
      结果: ok ? '✅' : '❌',
    });
  } catch (e) {
    failed += 1;
    rows.push({ 令牌对: label, 用途: p.kind, 比值: '—', 要求: '≥ ' + p.min + ':1', 结果: '❌ ' + e.message });
  }
}

console.log('UI-1 对比度检查（css/tokens.css :root）');
console.table(rows);

if (failed) {
  console.error('对比度不达标或令牌缺失：' + failed + ' 项');
  process.exit(1);
}
console.log('全部通过（' + rows.length + ' 项）');
