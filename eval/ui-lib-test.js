/* 基础组件库回归检查（阶段 3 §6.3 / §8）——不开浏览器、不联网（svelte/compiler 只编译不执行）。
 *
 * 1. src/ 下所有 .svelte 组件都能被 Svelte 5 编译（语法 / runes 用法门禁）；
 * 2. 图标逐字对账：Icon.svelte 每个分支的图形与 index.html 的 <symbol id="i-名字"> 完全一致
 *    （任务书 §6.3「图标本身保持不变」），名字集合一致且 28 个；
 * 3. 安全红线（§8）：src/** 不得出现 {@html} 与 innerHTML——用户 / 模型产出一律 textContent 等价渲染；
 * 4. 组件样式只走令牌：Svelte <style> 里不得出现颜色字面量（与 tokens-test 双保险）。
 *
 * 用法：node eval/ui-lib-test.js（任一不过 → 退出码 1）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { compile } = require('svelte/compiler');

const ROOT = path.join(__dirname, '..');
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('  ok  ' + name);
    return;
  }
  failed += 1;
  console.error('FAIL  ' + name + (detail ? ' — ' + detail : ''));
}

const svelteFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.svelte')) svelteFiles.push(p);
  }
})(path.join(ROOT, 'src'));

/* ---------- 1. Svelte 编译冒烟 ---------- */

const compileBad = [];
for (const f of svelteFiles) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  try {
    compile(fs.readFileSync(f, 'utf8'), { filename: rel, generate: 'client' });
  } catch (e) {
    compileBad.push(rel + '：' + e.message.split('\n')[0]);
  }
}
check('Svelte 组件全部可编译（' + svelteFiles.length + ' 个）', compileBad.length === 0, compileBad.join(' | '));

/* ---------- 2. 图标逐字对账 ---------- */

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const sprite = new Map();
for (const m of html.matchAll(/<symbol id="i-([\w-]+)"[^>]*>([\s\S]*?)<\/symbol>/g)) {
  sprite.set(m[1], m[2].trim());
}

const iconSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'Icon.svelte'), 'utf8');
const branches = new Map();
for (const m of iconSrc.matchAll(/^\{#if name === '([^']+)'\}(.*)$|^\{:else if name === '([^']+)'\}(.*)$/gm)) {
  const name = m[1] || m[3];
  const content = (m[2] != null ? m[2] : m[4]).trim();
  branches.set(name, content);
}

check('sprite 与 Icon.svelte 图标数一致（28 个）', sprite.size === 28 && branches.size === 28,
  'sprite=' + sprite.size + ' Icon=' + branches.size);

const nameMismatch = [];
for (const n of sprite.keys()) if (!branches.has(n)) nameMismatch.push('Icon 缺 ' + n);
for (const n of branches.keys()) if (!sprite.has(n)) nameMismatch.push('sprite 缺 ' + n);
check('图标名字集合一致', nameMismatch.length === 0, nameMismatch.join(' | '));

const artMismatch = [];
const norm = (s) => s.replace(/\s+/g, ' ').trim();
for (const [n, art] of sprite) {
  if (branches.has(n) && norm(branches.get(n)) !== norm(art)) artMismatch.push(n);
}
check('图标图形逐字一致（图标本身保持不变）', artMismatch.length === 0, artMismatch.join(' | '));

// 实心圆点（stroke="none" 的圆）必须直接带 fill（<use> 历史坑；内联后同样保留该写法）。
// 描边圆（gear 齿环 / clock 表盘等）不填色，走 .ic 的 fill: none + stroke: currentColor。
const fillBad = [...sprite.entries()]
  .filter(([, art]) => /<circle(?![^>]*fill=)[^>]*stroke="none"/.test(art))
  .map(([n]) => n);
check('实心圆点都在元素上直接写 fill', fillBad.length === 0, fillBad.join(' | '));

/* ---------- 3. 安全红线：{@html} / innerHTML ---------- */

const unsafe = [];
const srcFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(svelte|js|ts)$/.test(e.name)) srcFiles.push(p);
  }
})(path.join(ROOT, 'src'));
for (const f of srcFiles) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  // 剥掉注释再查：注释里提到 {@html} / innerHTML（红线说明）不算使用
  const text = fs.readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  if (text.includes('{@html')) unsafe.push(rel + ' 用了 {@html}');
  if (/\binnerHTML\s*=/.test(text)) unsafe.push(rel + ' 用了 innerHTML');
}
check('src/** 无 {@html} / innerHTML（用户内容一律文本渲染）', unsafe.length === 0, unsafe.join(' | '));

/* ---------- 4. 组件样式无颜色字面量 ---------- */

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;
const colorBad = [];
for (const f of svelteFiles) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    const decls = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
    if (COLOR_RE.test(decls)) colorBad.push(rel);
  }
}
check('Svelte <style> 无颜色字面量（只走令牌）', colorBad.length === 0, colorBad.join(' | '));

/* ---------- 汇总 ---------- */

if (failed) {
  console.error('ui-lib-test：' + failed + ' 项未过');
  process.exit(1);
}
console.log('ui-lib-test：全部通过');
