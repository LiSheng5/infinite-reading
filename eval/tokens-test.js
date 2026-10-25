/* UI-1 令牌回归检查（§6.2）——零依赖、不开浏览器。
 *
 * 1. 必需令牌（颜色 + 动效）都在 :root 里；
 * 2. :root 之外不得出现颜色字面量（#hex / rgb() / hsl()），允许名单见 ALLOW_COLORS；
 * 3. 所有 @keyframes 只允许动画 transform / opacity / filter / stroke-dashoffset / stroke-dasharray；
 * 4. 带 animation / transition 的规则不得引用不存在的动效令牌；
 * 5. transition 不得动画 width / height / box-shadow 等触发重排的属性（3.4 的硬禁令）。
 *
 * 用法：node eval/tokens-test.js（任一不过 → 退出码 1）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('  ok  ' + name);
    return;
  }
  failed += 1;
  console.error('FAIL  ' + name + (detail ? ' — ' + detail : ''));
}

/* ---------- 允许名单：确实不能用令牌的色值（每条带理由） ---------- */
const ALLOW_COLORS = [
  {
    file: 'src/core/demo.ts',
    reason: '离线演示占位图是 canvas 现画的「图片内容」（天空渐变 / 光源 / 剪影 / 雨丝 / 信息条），不是 UI 配色，走不了 CSS 令牌；其中信息条的深色遮罩与白字属于任务书 §2 的「图片上叠字」允许情形',
  },
];

function allowedFor(file, hit) {
  return ALLOW_COLORS.some(a => a.file === file && (!a.pattern || a.pattern.test(hit)));
}

/* ---------- 工具：把 CSS 拆成「声明」（属性: 值），跳过选择器 ---------- */

function matchBrace(text, openAt) {
  let depth = 0;
  for (let i = openAt; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return text.length - 1;
}

function eachDeclaration(text, fn) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const flush = (chunk) => {
    const ci = chunk.indexOf(':');
    if (ci > 0) fn(chunk.slice(0, ci).trim(), chunk.slice(ci + 1).trim());
  };
  const walk = (t) => {
    let p = 0;
    while (p < t.length) {
      const m = /[{;]/.exec(t.slice(p));
      if (!m) { flush(t.slice(p)); return; }   // 块尾没有分号的最后一条声明也要收
      const at = p + m.index;
      if (t[at] === '{') {
        const close = matchBrace(t, at);
        walk(t.slice(at + 1, close));          // 选择器不进声明表
        p = close + 1;
      } else {
        flush(t.slice(p, at));
        p = at + 1;
      }
    }
  };
  walk(src);
}

const rootMatch = CSS.match(/:root\s*\{([\s\S]*?)\}/);
if (!rootMatch) {
  console.error('FAIL  找不到 :root 令牌块');
  process.exit(1);
}
const rootDecl = rootMatch[1];
const tokenNames = new Set();
for (const m of rootDecl.matchAll(/(--[\w-]+)\s*:/g)) tokenNames.add(m[1]);
const cssNoRoot = CSS.replace(rootMatch[0], '/* [tokens-test] :root 已排除 */');

/* ---------- 1. 必需令牌 ---------- */

const REQUIRED = [
  // 颜色
  '--bg', '--surface', '--surface-2', '--line', '--line-strong', '--ink', '--ink-dim',
  '--accent', '--accent-soft', '--on-accent', '--on-ink', '--danger',
  '--shadow-1', '--shadow-2', '--bg-glass',
  // 动效
  '--dur-fast', '--dur-base', '--dur-slow',
  '--ease-out', '--ease-spring', '--ease-inout',
];
for (const name of REQUIRED) {
  check('必需令牌 ' + name, tokenNames.has(name));
}

/* ---------- 2. :root 之外无颜色字面量 ---------- */

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;

// css/style.css：只查声明的值（不把选择器里的 #id 当颜色）
const cssHits = [];
eachDeclaration(cssNoRoot, (prop, value) => {
  const hit = COLOR_RE.exec(value);
  if (hit) cssHits.push(prop + ': ' + value.slice(0, 60));
});
check('style.css :root 之外无颜色字面量', cssHits.length === 0, cssHits.join(' | '));

// js/*.js 与 src/core/*.ts：业务代码不得写死颜色（canvas 画图内容进允许名单）
const jsHits = [];
const SCAN_DIRS = [
  { dir: path.join(ROOT, 'js'), rel: 'js', exts: ['.js'] },
  { dir: path.join(ROOT, 'src', 'core'), rel: 'src/core', exts: ['.js', '.ts'] },
];
for (const { dir, rel, exts } of SCAN_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter(f => exts.some(e => f.endsWith(e)))) {
    const rf = rel + '/' + f;
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)) {
      const line = text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ');
      if (!allowedFor(rf, line)) jsHits.push(rf + ' …' + line + '…');
    }
  }
}
check('js/*.js 与 src/core 无未允许的颜色字面量', jsHits.length === 0, jsHits.slice(0, 5).join(' | '));

/* ---------- 3. @keyframes 只动合成层属性 ---------- */

const KEYFRAME_OK = new Set(['transform', 'opacity', 'filter', 'stroke-dashoffset', 'stroke-dasharray']);
const kfBad = [];
const kfRe = /@(?:-\w+-)?keyframes\s+[\w-]+\s*\{/g;
let km;
while ((km = kfRe.exec(CSS))) {
  const open = km.index + km[0].length - 1;
  const close = matchBrace(CSS, open);
  const body = CSS.slice(open + 1, close);
  const name = km[0].replace(/\s*\{$/, '');
  eachDeclaration(body, (prop) => {
    const p = prop.replace(/^-\w+-/, '');
    if (prop.startsWith('animation-')) return;   // keyframes 内的 timing 子属性不属「被动画的属性」
    if (!KEYFRAME_OK.has(p)) kfBad.push(name + ' → ' + prop);
  });
  kfRe.lastIndex = close + 1;
}
check('@keyframes 只动 transform/opacity/filter/stroke-dashoffset/stroke-dasharray', kfBad.length === 0, kfBad.join(' | '));

/* ---------- 4. animation / transition 引用的动效令牌必须存在 ---------- */

const missingTok = [];
eachDeclaration(CSS, (prop, value) => {
  if (!/^(animation|transition)(-[\w-]+)?$/.test(prop)) return;
  for (const m of value.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
    if (!tokenNames.has(m[1])) missingTok.push(prop + ' 引用 ' + m[1]);
  }
});
check('animation/transition 引用的令牌都存在', missingTok.length === 0, missingTok.join(' | '));

/* ---------- 5. transition 不得动画重排 / 重绘开销大的属性 ---------- */

const BANNED_TRANSITION = /^(width|height|max-height|min-height|max-width|min-width|top|left|right|bottom|margin(-\w+)?|padding(-\w+)?|box-shadow|font-size|line-height|letter-spacing|background-size|background-position|flex|grid-template-\w+|all)$/;
const bannedHit = [];
eachDeclaration(CSS, (prop, value) => {
  if (!/^transition(-property)?$/.test(prop)) return;
  const list = prop === 'transition-property' ? value.split(',') : value.split(',').map(item => item.trim().split(/\s+/)[0]);
  for (const item of list) {
    const p = item.trim().replace(/^-\w+-/, '');
    if (p && BANNED_TRANSITION.test(p)) bannedHit.push(prop + ' → ' + p);
  }
});
check('transition 不动 width/height/box-shadow 等重排属性', bannedHit.length === 0, bannedHit.join(' | '));

/* ---------- 汇总 ---------- */

if (failed) {
  console.error('tokens-test：' + failed + ' 项未过');
  process.exit(1);
}
console.log('tokens-test：全部通过');
