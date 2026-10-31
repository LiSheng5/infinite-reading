#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 样式结构门禁
 *
 * 不开浏览器、不联网。把 2344 行的 css/style.css 拆成「入口 + 9 个分片」之后，
 * 下面这些约定光靠注释守不住了，必须可执行：
 *   1. css/style.css 只是入口：只有 @import，没有规则；@import 顺序 = 层叠顺序清单；
 *   2. 目录里的每个屏幕分片都在清单里，清单里的每个文件都在目录里（不多不少），且都带分片文件头；
 *   3. 断点标尺：media query 只用 480 / 640 / 720 / 721 / 900 / hover:none——新数值必须先在
 *      css/style.css 的标尺表里登记，否则「8 处 720px」会重新长回来；
 *   4. 按钮词汇：唯一基座 .ui-btn（只准 base.css 定义一次），primary / ghost / danger / slim /
 *      mini / icon-only 只能当修饰类；历史类名 btn / hud-btn / mini-btn / icon-btn 全仓不得再出现
 *      （CSS 选择器与类名字符串都算）；
 *   5. 组件不再写第二份按钮视觉：Button / IconButton 的 <style> 只管结构（配色 / 描边 / 圆角归 .ui-btn）；
 *   6. 圆角标尺：border-radius 只用 var(--radius) 或 css/style.css 里登记的例外——新数值先登记再写，
 *      否则「主圆角 8px」会在各分片里重新长出 5 / 7 / 12px。
 *   7. 表单字号收口：input / select / textarea 的 font-size 只准 var(--fs-field)，窄屏由
 *      responsive.css 在 :root 上抬到 16px——写在控件选择器上的 16px 会被更高特异性盖掉。
 *
 * 用法：node eval/css-structure-test.js（任一不过 → 退出码 1）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed += 1; }
}
function eq(a, b, msg) {
  ok(a === b, msg + (a === b ? '' : '（实际 ' + JSON.stringify(a) + ' ≠ 期望 ' + JSON.stringify(b) + '）'));
}

/* ---------- 清单：分片顺序 = 层叠顺序（改顺序 = 改优先级，必须同步改这里） ---------- */
const ORDER = [
  'base.css',      // 复位 / 链接 / 按钮 / 动效挂点
  'home.css',      // 开始页
  'shelf.css',     // 书架
  'read.css',      // 阅读屏
  'overlays.css',  // 弹窗 / 画师 / 锚定 / Toast
  'responsive.css',// 全局窄屏兜底
  'settings.css',  // 设置（含设置页）
  'branch.css',    // 分支页
  'icons.css',     // 图标尺寸
];
const BREAKPOINTS = new Set([
  'max-width: 480px',
  'max-width: 640px',
  'max-width: 720px',
  'min-width: 721px',
  'max-width: 900px',
  'hover: none',
]);

const stripCss = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '');
const stripJs = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');

const cssDir = path.join(ROOT, 'css');
const cssFiles = fs.readdirSync(cssDir).filter((n) => n.endsWith('.css'));
const screenFiles = cssFiles.filter((n) => n !== 'tokens.css' && n !== 'motion.css' && n !== 'style.css').sort();

/* ---------------- 1. 入口只有 @import ---------------- */
console.log('[1] css/style.css 是入口：只有 @import');
{
  const entry = stripCss(read('css/style.css'));
  const imports = [...entry.matchAll(/@import\s+url\("([^"]+)"\)\s*;/g)].map((m) => m[1]);
  const rest = entry.replace(/@import\s+url\("[^"]+"\)\s*;/g, '').trim();

  ok(rest === '', '入口里没有规则残留（' + (rest ? rest.slice(0, 60) + '…' : '干净') + '）');
  eq(imports.join(' '), ORDER.join(' '), '@import 顺序 = 层叠顺序清单');
  ok(new Set(imports).size === imports.length, '@import 没有重复项');
  ok(!/@layer/.test(entry), '入口不引入 @layer（层序会压过特异性，等于静默改优先级）');
}

/* ---------------- 2. 清单与目录一一对应 ---------------- */
console.log('[2] 分片清单与 css/ 目录一一对应，且都带文件头');
{
  eq(screenFiles.join(' '), ORDER.slice().sort().join(' '), '目录里的屏幕分片 = 清单（不多不少）');
  for (const name of ORDER) {
    const file = path.join(cssDir, name);
    if (!fs.existsSync(file)) { ok(false, name + ' 存在'); continue; }
    const head = read('css/' + name).split('\n').slice(0, 5).join('\n');
    ok(/^\/\* =+ /.test(head) && head.includes('屏幕样式的一个分片'), name + ' 带分片文件头（说明自己在层叠里的位置）');
  }
}

/* ---------------- 3. 断点标尺 ---------------- */
console.log('[3] 断点标尺：media query 只用登记过的值');
{
  const bad = [];
  for (const name of screenFiles) {
    const css = stripCss(read('css/' + name));
    for (const m of css.matchAll(/@media\s*([^{]+)\{/g)) {
      // 「(max-width: 720px)」与「screen and (max-width: 720px)」都要能对上标尺：括号去掉、空白归一
      const cond = m[1].replace(/\s+/g, ' ').trim().replace(/^\((.*)\)$/, '$1');
      if (!BREAKPOINTS.has(cond)) bad.push(name + ' → @media ' + cond);
    }
  }
  ok(bad.length === 0, '没有标尺外的断点' + (bad.length ? '：' + bad.slice(0, 6).join(' | ') : ''));
  ok(read('css/style.css').includes('断点标尺'), '入口里写着标尺表（新断点先登记再写）');
}

/* ---------------- 4. 按钮词汇 ---------------- */
console.log('[4] 按钮词汇：唯一基座 .ui-btn');
{
  // 4.1 基座只定义一次
  const baseDefs = [];
  for (const name of screenFiles) {
    const css = stripCss(read('css/' + name));
    if (/(^|\})\s*\.ui-btn\s*\{/.test(css) || /(^|\n)\.ui-btn\s*\{/.test(css)) baseDefs.push(name);
  }
  eq(baseDefs.join(' '), 'base.css', '基座 .ui-btn 只在 base.css 定义一次');

  // 4.2 旧类名不得再出现
  const legacyCss = [];
  for (const name of [...screenFiles, 'tokens.css', 'motion.css']) {
    const css = stripCss(read('css/' + name));
    for (const m of css.matchAll(/\.(hud-btn|mini-btn|icon-btn|btn)(?![\w-])/g)) {
      legacyCss.push(name + ' → .' + m[1]);
    }
  }
  ok(legacyCss.length === 0, 'CSS 里没有旧按钮选择器' + (legacyCss.length ? '：' + legacyCss.slice(0, 6).join(' | ') : ''));

  // 4.3 类名字符串：旧名字清零；修饰类必须带基座
  const OLD = /(?<![\w-])(btn|hud-btn|mini-btn|icon-btn)(?![\w-])/;
  const MODS = /(?<![\w-])(primary|ghost|danger|slim|mini|icon-only)(?![\w-])/;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const markup = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'index.html')]
    .filter((f) => /\.(js|svelte|html)$/.test(f));

  const legacyDom = [];
  const orphanMod = [];
  for (const f of markup) {
    const src = stripJs(fs.readFileSync(f, 'utf8'));
    const strings = [
      ...src.matchAll(/\bclass="([^"]*)"/g),
      ...src.matchAll(/\bclassName\s*=\s*(['"])([^'"]*)\1/g),
      ...src.matchAll(/\bcls\s*:\s*(['"])([^'"]*)\1/g),
    ].map((m) => m[2] ?? m[1]);
    for (const v of strings) {
      if (OLD.test(v)) legacyDom.push(rel(f) + ' → ' + v.trim());
      // .hud 既是顶栏容器名也是按钮修饰类，单独放行
      if (MODS.test(v) && !/(?<![\w-])ui-btn(?![\w-])/.test(v)) orphanMod.push(rel(f) + ' → ' + v.trim());
    }
  }
  ok(legacyDom.length === 0, 'DOM / 类名字符串里没有旧按钮类名' + (legacyDom.length ? '：' + legacyDom.slice(0, 6).join(' | ') : ''));
  ok(orphanMod.length === 0, 'primary/ghost/danger/slim/mini/icon-only 都挂在 .ui-btn 上' + (orphanMod.length ? '：' + orphanMod.slice(0, 6).join(' | ') : ''));
}

/* ---------------- 5. 组件不写第二份按钮视觉 ---------------- */
console.log('[5] Button / IconButton 只保留结构');
{
  const VISUAL = /(^|[;{\s])(background|background-color|border|border-color|border-radius|color|font-size|letter-spacing|box-shadow)\s*:/;
  const button = read('src/ui/Button.svelte');
  const iconButton = read('src/ui/IconButton.svelte');
  const styleOf = (src) => (src.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];

  ok(/'ui-btn'/.test(button), 'Button.svelte 输出 .ui-btn');
  ok(/'ui-btn',\s*'icon-only'/.test(iconButton), 'IconButton.svelte 输出 .ui-btn.icon-only');
  ok(!VISUAL.test(styleOf(button)), 'Button.svelte 的样式块不写视觉属性（配色 / 描边 / 圆角归 .ui-btn）');
  ok(!VISUAL.test(styleOf(iconButton)), 'IconButton.svelte 的样式块不写视觉属性');
}

/* ---------------- 6. 三层加载顺序（index.html） ---------------- */
console.log('[6] index.html 的样式三层顺序');
{
  const html = read('index.html');
  const at = (href) => html.indexOf('href="' + href + '"');
  const tok = at('css/tokens.css');
  const screen = at('css/style.css');
  const motion = at('css/motion.css');
  ok(tok >= 0 && screen > tok, '令牌在屏幕样式之前');
  ok(motion > screen, '动效模块最后加载（暂停 / 循环预算优先）');
}

/* ---------------- 7. 圆角标尺 ---------------- */
console.log('[7] 圆角标尺：border-radius 只用 var(--radius) 或登记过的例外');
{
  // 标尺表就在入口文件里（与断点标尺同一处）：4 空格缩进的值 + 两个以上空格 + 说明
  const entrySrc = read('css/style.css');
  const start = entrySrc.indexOf('圆角标尺');
  const end = entrySrc.indexOf('按钮词汇', start);
  const block = start >= 0 && end > start ? entrySrc.slice(start, end) : '';
  const scale = new Set();
  for (const line of block.split('\n')) {
    const m = line.match(/^ {4}(\S.*?)\s{2,}\S/);
    if (m) scale.add(m[1].trim());
  }
  ok(scale.has('var(--radius)'), '标尺表以主圆角 var(--radius) 打底（共 ' + scale.size + ' 个取值）');
  ok(scale.size >= 2, '标尺表解析出了例外（防表格式改坏后静默放行）');

  const bad = [];
  for (const name of screenFiles) {
    const css = stripCss(read('css/' + name));
    for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) {
      const value = m[1].replace(/\s+/g, ' ').trim();
      if (!scale.has(value)) bad.push(name + ' → border-radius: ' + value);
    }
  }
  ok(bad.length === 0, '分片里的圆角都在标尺上' + (bad.length ? '：' + bad.slice(0, 6).join(' | ') : ''));
  ok(read('css/tokens.css').includes('圆角标尺'), 'tokens.css 的 --radius 注释指向圆角标尺（改圆角先看表）');
}

/* ---------------- 8. 表单字号收口 ---------------- */
console.log('[8] 表单字号只走 --fs-field（窄屏抬到 16px，防 iOS 聚焦放大）');
{
  const tok = read('css/tokens.css');
  const tokenValue = (name) => ((tok.match(new RegExp('(?:^|\\s)' + name + ':\\s*([^;]+);')) || [])[1] || '').trim();
  eq(tokenValue('--fs-field'), '14px', 'tokens.css 的 --fs-field 桌面值 = 14px');
  eq(tokenValue('--fs-field-mono'), '12px', 'tokens.css 的 --fs-field-mono（等宽输入框）桌面值 = 12px');

  // 窄屏抬升必须落在 :root 上。写在 input / select / textarea 上的规则只是 0,0,1，
  // 会被 #player-input、.shelf-search-input、label input、组件里的 input.svelte-* 整条盖掉
  // ——「写了 16px 但几乎没生效」正是这里要守住的回归。
  const resp = stripCss(read('css/responsive.css'));
  const raise = /:root\s*\{[^}]*--fs-field:\s*16px[^}]*\}/.exec(resp);
  ok(!!raise, 'responsive.css 用 :root 把 --fs-field 抬到 16px');
  ok(!!raise && /--fs-field-mono:\s*16px/.test(raise[0]), '同一个 :root 块里 --fs-field-mono 也抬到 16px');
  if (raise) {
    const head = resp.slice(0, raise.index);
    const at = head.lastIndexOf('@media');
    ok(at >= 0 && /max-width:\s*720px/.test(head.slice(at)),
      '抬升写在 @media (max-width: 720px) 里');
  }

  // 命中表单控件的每条 font-size 都必须读其中一个字段字号令牌：字号只留一套口径，
  // 不给「新控件又写回 14px、窄屏又漏一个」留口子。
  // 元素选择器抓不到 #pw-prompt / #player-input 这类纯 ID 规则（正是它们盖掉了旧的兜底），
  // 所以把「只靠 id / class 命中的字段」登记下来——改名或删控件时下面「都还在」会红。
  const FIELD_TOKENS = /^var\(\s*--fs-field(?:-mono)?\s*\)$/;
  const FIELD_SEL = /(?:^|[\s,>+~(])(?:input|select|textarea)(?![\w-])/;
  const FIELD_NAMES = ['#player-input', '.shelf-search-input', '#pw-prompt'];
  const sources = screenFiles.map((name) => ({ name: 'css/' + name, css: stripCss(read('css/' + name)) }));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(ROOT, 'src'))) {
    if (!f.endsWith('.svelte')) continue;
    const styleText = [...fs.readFileSync(f, 'utf8').matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1]).join('\n');
    if (styleText.trim()) sources.push({ name: rel(f) + '#style', css: stripCss(styleText) });
  }

  const bad = [];
  const seen = new Set();
  for (const { name, css } of sources) {
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1].replace(/\s+/g, ' ').trim();
      for (const n of FIELD_NAMES) if (selector.includes(n)) seen.add(n);
      if (!FIELD_SEL.test(selector) && !FIELD_NAMES.some((n) => selector.includes(n))) continue;
      for (const decl of rule[2].matchAll(/font-size\s*:\s*([^;]+)/g)) {
        const value = decl[1].trim();
        if (!FIELD_TOKENS.test(value)) {
          bad.push(name + ' → ' + selector + ' { font-size: ' + value + ' }');
        }
      }
    }
  }
  ok(bad.length === 0, '表单控件的 font-size 一律 var(--fs-field) / var(--fs-field-mono)'
    + (bad.length ? '：' + bad.slice(0, 6).join(' | ') : ''));
  ok(FIELD_NAMES.every((n) => seen.has(n)), '登记过的字段控件都还在（改名 / 删控件后同步 FIELD_NAMES）：'
    + FIELD_NAMES.filter((n) => !seen.has(n)).join(' , '));
}

if (failed) {
  console.error('css-structure-test：' + failed + ' 项未通过');
  process.exit(1);
}
console.log('css-structure-test：全部通过');
