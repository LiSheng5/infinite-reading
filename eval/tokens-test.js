/* 令牌与动效纪律回归检查（UI-1 → 阶段 3 §6）——零依赖、不开浏览器。
 *
 * 阶段 3 口径（旧检查一条不删，按统一 motion 模块更新；新增项标 [新]）：
 * 1. 必需令牌（颜色 + 动效 + 档位参数）都在 css/tokens.css 的 :root；
 * 2. :root 之外不得出现颜色字面量（#hex / rgb() / hsl()），允许名单见 ALLOW_COLORS；
 * 3. [新] @keyframes 只准定义在 css/motion.css（统一 motion 模块），且与
 *    src/core/motion.ts 的 ANIMATIONS 声明表逐名双向对齐；
 * 4. @keyframes 只动合成层属性（transform / opacity / filter / stroke-dashoffset /
 *    stroke-dasharray）；[新] 放宽项：小面积装饰元素可用 @property 注册的自定义属性
 *    （注册块须 syntax 可动画、inherits: false，且声明表注 decorative 理由）；
 * 5. animation / transition 引用的令牌都存在（含 var(…, 回退) 形式；JS 动态写入的见 JS_WRITTEN）；
 * 6. transition 不得动画 width / height / box-shadow 等重排属性；
 * 7. [新] 时长 / 缓动只走令牌：animation 时长 var(--m-dur-*|--loop-*)、transition 时长
 *    var(--m-t-*|--m-dur-*)、缓动 var(--ease-*)，时间字面量只准 0；
 * 8. [新] 循环只准 var(--m-iter)（字面量 infinite 全禁）；带 var(--m-iter) 的动画在
 *    声明表必须是 rich: 'loop'（§6.2：standard 无循环、off 无循环）；
 * 9. [新] 动画名一律经声明表：animation 简写必须 var(--an-*)，--an-* 名表三档值
 *    与 ANIMATIONS 逐条推导一致（off/standard/rich 各一块）；
 * 10. [新] 暂停机制在位：data-paused / data-loops-paused / data-loop="wait" 都有
 *    animation-play-state: paused 规则（页面不可见、子树挂起、循环预算排队）；
 * 11. [新] 图标 lint（§6.3）：CSS content: 值与 Svelte 模板不得出现 emoji /
 *    符号字符当图标（▶ ⚙ ⚡ ← ↑ ↓ ＋ ⋯ ✕ ✓ 等；部分系统会渲染成彩色 emoji）。
 *
 * 用法：node eval/tokens-test.js（任一不过 → 退出码 1）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TOK = read('css/tokens.css');        // 令牌真源（:root）
const STYLE = read('css/style.css');       // 屏幕样式（只消费）
const MOTION = read('css/motion.css');     // 统一 motion 模块（@keyframes + 档位政策 + 声明表镜像）

// Svelte 组件的 <style> 块按「文件#style」并入 CSS 检查面
const svelteFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.svelte')) svelteFiles.push(p);
  }
})(path.join(ROOT, 'src'));

const CSS_SOURCES = [
  { name: 'css/style.css', text: STYLE },
  { name: 'css/motion.css', text: MOTION },
];
for (const f of svelteFiles) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const src = fs.readFileSync(f, 'utf8');
  const styles = [...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  if (styles.trim()) CSS_SOURCES.push({ name: rel + '#style', text: styles });
}

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
  {
    file: 'js/app/video.js',
    reason: '视频抓帧失败时的兜底封面是 canvas 现画的「图片内容」（黑底 + 手绘播放三角，§6.3 特意不依赖字体画 ▶），不是 UI 配色',
  },
];

function allowedFor(file, hit) {
  return ALLOW_COLORS.some(a => a.file === file && (!a.pattern || a.pattern.test(hit)));
}

/* ---------- 工具：把 CSS 拆成「规则」与「声明」，跳过选择器 ---------- */

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

// 规则遍历：fn(selector, body)。@keyframes / @media 也走这里（selector 带前缀）
function eachRule(text, fn) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(src, open);
    fn(m[1].trim(), src.slice(open + 1, close));
    re.lastIndex = close + 1;
  }
}

/* ---------- 令牌集合 ---------- */

const rootMatch = TOK.match(/:root\s*\{([\s\S]*?)\}/);
if (!rootMatch) {
  console.error('FAIL  找不到 css/tokens.css 的 :root 令牌块');
  process.exit(1);
}
const rootDecl = rootMatch[1];
const tokenNames = new Set();
for (const m of rootDecl.matchAll(/(--[\w-]+)\s*:/g)) tokenNames.add(m[1]);

const motionVars = new Set();
for (const m of MOTION.matchAll(/(--[\w-]+)\s*:/g)) motionVars.add(m[1]);
const allVars = new Set([...tokenNames, ...motionVars]);

// JS 动态写入的自定义属性（inline style，带 var() 回退；不是令牌，但合法引用）
const JS_WRITTEN = new Set(['--t', '--x', '--split-ratio', '--content-w', '--density', '--font-scale']);

// 声明表（真源）
const MotionApi = require(path.join(ROOT, 'src', 'core', 'motion.ts')).Motion;
const ANIMATIONS = MotionApi.ANIMATIONS;

/* ---------- 1. 必需令牌 ---------- */

const REQUIRED = [
  // 颜色
  '--bg', '--surface', '--surface-2', '--line', '--line-strong', '--ink', '--ink-dim',
  '--accent', '--accent-soft', '--on-accent', '--on-ink', '--danger',
  '--shadow-1', '--shadow-2', '--bg-glass',
  // 圆角（阶段 3 补定义：0.12.1 漏定义导致全站方角）
  '--radius',
  // 动效
  '--dur-fast', '--dur-base', '--dur-slow', '--dur-off', '--dur-shift', '--dur-flash', '--dur-none',
  '--ease-out', '--ease-spring', '--ease-inout', '--ease-io', '--ease-linear',
  '--loop-busy', '--loop-kb', '--loop-ambient', '--loop-flow', '--loop-inf', '--loop-inf-step',
  // 首页符号两端色
  '--inf-deep', '--inf-light',
];
for (const name of REQUIRED) {
  check('必需令牌 ' + name, tokenNames.has(name));
}

// 动效模块的档位政策变量（css/motion.css）
const REQUIRED_MOTION_VARS = [
  '--m-dur-fast', '--m-dur-base', '--m-dur-slow', '--m-dur-flash',
  '--m-t-shift-fast', '--m-t-shift-base', '--m-t-color-fast', '--m-t-color-base', '--m-iter',
];
for (const name of REQUIRED_MOTION_VARS) {
  check('动效政策变量 ' + name, motionVars.has(name));
}

/* ---------- 2. :root 之外无颜色字面量 ---------- */

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;

// css/tokens.css：颜色只准在 :root 里
{
  const outside = TOK.replace(rootMatch[0], '');
  const hits = [];
  eachDeclaration(outside, (prop, value) => {
    const hit = COLOR_RE.exec(value);
    if (hit) hits.push(prop + ': ' + value.slice(0, 60));
  });
  check('tokens.css 颜色字面量只在 :root 里', hits.length === 0, hits.join(' | '));
}

// 其余 CSS（含 Svelte 样式）：只查声明的值（不把选择器里的 #id 当颜色）
const cssHits = [];
for (const { name, text } of CSS_SOURCES) {
  eachDeclaration(text, (prop, value) => {
    const hit = COLOR_RE.exec(value);
    if (hit) cssHits.push(name + ' ' + prop + ': ' + value.slice(0, 60));
  });
}
check('style/motion/组件样式 :root 之外无颜色字面量', cssHits.length === 0, cssHits.join(' | '));

// js/*.js 与 src/**（.ts/.js）：业务代码不得写死颜色（canvas 画图内容进允许名单）
const jsHits = [];
const SCAN_DIRS = [
  { dir: path.join(ROOT, 'js'), rel: 'js', exts: ['.js'] },
  { dir: path.join(ROOT, 'src'), rel: 'src', exts: ['.js', '.ts'] },
];
for (const { dir, rel, exts } of SCAN_DIRS) {
  if (!fs.existsSync(dir)) continue;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, f.name);
      if (f.isDirectory()) { stack.push(abs); continue; }
      if (!exts.some(e => f.name.endsWith(e))) continue;
      const rf = rel + '/' + path.relative(dir, abs).split(path.sep).join('/');
      const text = fs.readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)) {
        const line = text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ');
        if (!allowedFor(rf, line)) jsHits.push(rf + ' …' + line + '…');
      }
    }
  }
}
check('js/* 与 src/** 无未允许的颜色字面量', jsHits.length === 0, jsHits.slice(0, 5).join(' | '));

/* ---------- 3. [新] @keyframes 只在 css/motion.css，与声明表逐名对齐 ---------- */

const kfNames = new Set();
for (const m of MOTION.matchAll(/@(?:-\w+-)?keyframes\s+([\w-]+)\s*\{/g)) kfNames.add(m[1]);

const strayKf = [];
for (const { name, text } of CSS_SOURCES) {
  if (name === 'css/motion.css') continue;
  for (const m of text.matchAll(/@(?:-\w+-)?keyframes\s+([\w-]+)\s*\{/g)) strayKf.push(name + ' → ' + m[1]);
}
check('@keyframes 只定义在 css/motion.css', strayKf.length === 0, strayKf.join(' | '));

const declared = new Set(Object.keys(ANIMATIONS));
const undeclared = [...kfNames].filter(n => !declared.has(n));
const orphan = [...declared].filter(n => !kfNames.has(n));
check('每个 @keyframes 都在 ANIMATIONS 声明三档', undeclared.length === 0, undeclared.join(' | '));
check('ANIMATIONS 每条都有 @keyframes（不多不少）', orphan.length === 0, orphan.join(' | '));

/* ---------- 3b. [新] --an-* 名表与 ANIMATIONS 逐档推导一致 ---------- */

function derived(name, tier) {
  const spec = ANIMATIONS[name][tier];
  if (spec === 'none') return 'none';
  if (spec === 'fade') return ANIMATIONS[name].rich === 'fade' ? name : 'fadeIn';
  return name;
}

const anTable = {};   // name → { off, standard, rich }
eachRule(MOTION, (selector, body) => {
  let tier = null;
  if (/data-motion="off"/.test(selector)) tier = 'off';
  else if (/data-motion="standard"/.test(selector)) tier = 'standard';
  else if (/data-motion="rich"/.test(selector) || /(^|[,\s]):root/.test(selector)) tier = 'rich';
  if (!tier) return;
  eachDeclaration(body, (prop, value) => {
    const m = /^--an-([\w-]+)$/.exec(prop);
    if (m) (anTable[m[1]] ||= {})[tier] = value.trim();
  });
});

const anBad = [];
for (const [name, tiers] of Object.entries(anTable)) {
  if (!declared.has(name)) { anBad.push('--an-' + name + ' 没有声明表条目'); continue; }
  for (const tier of ['off', 'standard', 'rich']) {
    const got = tiers[tier];
    const want = derived(name, tier);
    if (got == null) anBad.push('--an-' + name + ' 缺 ' + tier + ' 档');
    else if (got !== want) anBad.push('--an-' + name + ' ' + tier + ' 档应为 ' + want + '，实为 ' + got);
  }
}
for (const name of declared) {
  if (!anTable[name]) anBad.push('ANIMATIONS.' + name + ' 没有 --an-' + name + ' 名表');
}
check('--an-* 名表三档与 ANIMATIONS 推导一致', anBad.length === 0, anBad.join(' | '));

/* ---------- 4. @keyframes 只动合成层属性（放宽：@property 注册的自定义属性） ---------- */

const KEYFRAME_OK = new Set(['transform', 'opacity', 'filter', 'stroke-dashoffset', 'stroke-dasharray']);

// @property 注册块：注册名 → { syntax, inherits }
const registered = new Map();
for (const text of [TOK, MOTION]) {
  for (const m of text.matchAll(/@property\s+(--[\w-]+)\s*\{([\s\S]*?)\}/g)) {
    const body = m[2];
    const syntax = (body.match(/syntax\s*:\s*["']([^"']+)["']/) || [])[1] || '';
    const inherits = (body.match(/inherits\s*:\s*(\w+)/) || [])[1] || '';
    registered.set(m[1], { syntax, inherits });
  }
}
const ANIMATABLE_SYNTAX = /<(color|number|percentage|length|angle|length-percentage|transform)>/;
const regBad = [];
for (const [name, info] of registered) {
  if (!ANIMATABLE_SYNTAX.test(info.syntax)) regBad.push(name + ' syntax 不可动画：' + info.syntax);
  if (info.inherits !== 'false') regBad.push(name + ' 必须 inherits: false');
}
check('@property 注册块合规（可动画 syntax + inherits: false）', regBad.length === 0, regBad.join(' | '));

const kfBad = [];
const kfCustom = [];
const kfRe = /@(?:-\w+-)?keyframes\s+[\w-]+\s*\{/g;
let km;
while ((km = kfRe.exec(MOTION))) {
  const open = km.index + km[0].length - 1;
  const close = matchBrace(MOTION, open);
  const body = MOTION.slice(open + 1, close);
  const name = km[0].replace(/\s*\{$/, '').replace(/^@(?:-\w+-)?keyframes\s+/, '');
  eachDeclaration(body, (prop) => {
    const p = prop.replace(/^-\w+-/, '');
    if (prop.startsWith('animation-')) return;   // keyframes 内的 timing 子属性不属「被动画的属性」
    if (KEYFRAME_OK.has(p)) return;
    if (prop.startsWith('--')) {
      if (!registered.has(prop)) kfBad.push(name + ' → ' + prop + '（未 @property 注册）');
      else kfCustom.push(name);
      return;
    }
    kfBad.push(name + ' → ' + prop);
  });
  kfRe.lastIndex = close + 1;
}
check('@keyframes 只动 transform/opacity/filter/stroke-dashoffset/stroke-dasharray（或注册自定义属性）', kfBad.length === 0, kfBad.join(' | '));

// 用自定义属性做动画的，声明表必须注 decorative 理由（小面积装饰元素才放行）
const customBad = [...new Set(kfCustom)].filter((name) => {
  const spec = ANIMATIONS[name];
  return !spec || typeof spec.decorative !== 'string' || !spec.decorative.trim();
});
check('自定义属性动画都注了 decorative 理由', customBad.length === 0, customBad.join(' | '));

/* ---------- 5. animation / transition 引用的令牌都存在 ---------- */

const missingTok = [];
eachDeclaration(STYLE + '\n' + MOTION, (prop, value) => {
  if (!/^(animation|transition)(-[\w-]+)?$/.test(prop)) return;
  for (const m of value.matchAll(/var\(\s*(--[\w-]+)\s*(?:,|\))/g)) {
    const n = m[1];
    if (!allVars.has(n) && !JS_WRITTEN.has(n)) missingTok.push(prop + ' 引用 ' + n);
  }
});
for (const { name, text } of CSS_SOURCES) {
  if (name === 'css/style.css' || name === 'css/motion.css') continue;
  eachDeclaration(text, (prop, value) => {
    if (!/^(animation|transition)(-[\w-]+)?$/.test(prop)) return;
    for (const m of value.matchAll(/var\(\s*(--[\w-]+)\s*(?:,|\))/g)) {
      const n = m[1];
      if (!allVars.has(n) && !JS_WRITTEN.has(n)) missingTok.push(name + ' ' + prop + ' 引用 ' + n);
    }
  });
}
check('animation/transition 引用的令牌都存在', missingTok.length === 0, missingTok.join(' | '));

/* ---------- 6. transition 不得动画重排 / 重绘开销大的属性 ---------- */

const BANNED_TRANSITION = /^(width|height|max-height|min-height|max-width|min-width|top|left|right|bottom|margin(-\w+)?|padding(-\w+)?|box-shadow|font-size|line-height|letter-spacing|background-size|background-position|flex|grid-template-\w+|all)$/;
const bannedHit = [];
for (const { name, text } of [{ name: 'css/tokens.css', text: TOK }, ...CSS_SOURCES]) {
  eachDeclaration(text, (prop, value) => {
    if (!/^transition(-property)?$/.test(prop)) return;
    const list = prop === 'transition-property' ? value.split(',') : value.split(',').map(item => item.trim().split(/\s+/)[0]);
    for (const item of list) {
      const p = item.trim().replace(/^-\w+-/, '');
      if (p && BANNED_TRANSITION.test(p)) bannedHit.push(name + ' ' + prop + ' → ' + p);
    }
  });
}
check('transition 不动 width/height/box-shadow 等重排属性', bannedHit.length === 0, bannedHit.join(' | '));

/* ---------- 7. [新] 时长 / 缓动只走令牌 ---------- */

const TIME_LITERAL = /(^|[\s,()])((?:\d+\.)?\d+)(m?s)\b/g;   // 0 / 0s 放行
const EASING_KEYWORD = /(^|[\s,])(linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\(|steps\()/;
const ANIM_DUR_OK = /^(--m-dur-[\w-]+|--loop-[\w-]+|--dur-none)$/;
const TRANS_DUR_OK = /^(--m-t-[\w-]+|--m-dur-[\w-]+|--dur-none)$/;

const timingBad = [];
function scanTiming(name, text) {
  eachDeclaration(text, (prop, value) => {
    const isAnim = /^animation/.test(prop);
    const isTrans = /^transition/.test(prop);
    if (!isAnim && !isTrans) return;
    // 时间字面量只准 0
    for (const m of value.matchAll(TIME_LITERAL)) {
      if (parseFloat(m[2]) !== 0) timingBad.push(name + ' ' + prop + ' 写死时长 ' + m[0].trim());
    }
    // 缓动关键字只准 var(--ease-*)
    const vwoVar = value.replace(/var\([^)]*\)/g, '');
    if (EASING_KEYWORD.test(vwoVar)) timingBad.push(name + ' ' + prop + ' 写死缓动');
    // 时长必须经档位收口变量
    if (prop === 'animation' || prop === 'animation-duration') {
      const rawDur = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1])
        .filter(n => /^--dur-|^--loop-|^--m-/.test(n) && !ANIM_DUR_OK.test(n) && n !== '--m-iter');
      if (rawDur.length) timingBad.push(name + ' ' + prop + ' 时长未走 --m-dur-*/--loop-*：' + rawDur.join(','));
    }
    if (prop === 'transition' || prop === 'transition-duration') {
      const rawDur = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1])
        .filter(n => /^--dur-|^--loop-|^--m-/.test(n) && !TRANS_DUR_OK.test(n));
      if (rawDur.length) timingBad.push(name + ' ' + prop + ' 时长未走 --m-t-*/--m-dur-*：' + rawDur.join(','));
    }
    if (/-timing-function$/.test(prop) && !/var\(\s*--ease-/.test(value)) {
      timingBad.push(name + ' ' + prop + ' 缓动未走 --ease-*');
    }
    // animation 简写：名字必须经 --an-* 名表
    if (prop === 'animation' && value.trim() !== 'none') {
      const an = [...value.matchAll(/var\(\s*--an-([\w-]+)\s*\)/g)].map(m => m[1]);
      if (an.length !== 1) timingBad.push(name + ' animation 应恰好引用一个 var(--an-*)，实为 ' + an.length + ' 个');
      for (const n of an) {
        if (!declared.has(n)) timingBad.push(name + ' animation 引用未声明的 --an-' + n);
      }
    }
    // [新] 8. 循环只准 var(--m-iter)
    if (/(^|[\s,])infinite([\s,)]|$)/.test(value)) {
      timingBad.push(name + ' ' + prop + ' 用了字面量 infinite（必须 var(--m-iter)）');
    }
    if (prop === 'animation' && /var\(\s*--m-iter\s*\)/.test(value)) {
      const n = ([...value.matchAll(/var\(\s*--an-([\w-]+)\s*\)/g)].map(m => m[1]))[0];
      if (n && (!ANIMATIONS[n] || ANIMATIONS[n].rich !== 'loop')) {
        timingBad.push(name + ' ' + n + ' 带 var(--m-iter) 但声明表 rich 不是 loop');
      }
    }
  });
}
scanTiming('css/style.css', STYLE);
scanTiming('css/motion.css', MOTION);
for (const { name, text } of CSS_SOURCES) {
  if (name === 'css/style.css' || name === 'css/motion.css') continue;
  scanTiming(name, text);
}
check('时长/缓动只走令牌，循环只走 var(--m-iter)，名字只走 --an-*', timingBad.length === 0, timingBad.slice(0, 8).join(' | '));

/* ---------- 10. [新] 暂停机制在位 ---------- */

function ruleHasMotionPause(text, selectorNeedle) {
  let ok = false;
  eachRule(text, (selector, body) => {
    if (selector.includes(selectorNeedle) && /animation-play-state:\s*paused/.test(body)) ok = true;
  });
  return ok;
}
check('页面不可见暂停（html[data-paused]）规则在位', ruleHasMotionPause(MOTION, 'html[data-paused]'));
check('子树挂起（[data-loops-paused]）规则在位', ruleHasMotionPause(MOTION, '[data-loops-paused]'));
check('循环预算排队（[data-loop="wait"]）规则在位', ruleHasMotionPause(MOTION, '[data-loop="wait"]'));

/* ---------- 11. [新] 图标 lint：emoji / 符号字符不得当图标 ---------- */

const BANNED_GLYPHS = ['▶', '⚙', '⚡', '←', '↑', '↓', '＋', '⋯', '✕', '✓'];
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

const glyphHits = [];
function scanGlyphs(name, text) {
  for (const m of text.matchAll(/content:\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const v = m[2];
    const bad = [...v].filter(c => BANNED_GLYPHS.includes(c) || EMOJI_RE.test(c));
    if (bad.length) glyphHits.push(name + ' content: 用了 ' + [...new Set(bad)].join(''));
  }
}
for (const text of [TOK, STYLE, MOTION]) scanGlyphs('css', text);
for (const f of svelteFiles) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const tmpl = fs.readFileSync(f, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const ch of tmpl) {
    if (BANNED_GLYPHS.includes(ch) || EMOJI_RE.test(ch)) {
      glyphHits.push(rel + ' 模板里出现符号/emoji 字符（图标一律用 Icon.svelte）');
      break;
    }
  }
}
check('CSS content: 与 Svelte 模板无 emoji / 符号字符当图标', glyphHits.length === 0, glyphHits.join(' | '));

/* ---------- 汇总 ---------- */

if (failed) {
  console.error('tokens-test：' + failed + ' 项未过');
  process.exit(1);
}
console.log('tokens-test：全部通过');
