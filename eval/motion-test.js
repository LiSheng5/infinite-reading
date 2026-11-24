/* 动效单档（rich）+ 静默例外断言——纯逻辑 + 源码口径。
 *
 * 运行时只有 rich 一档（完整动效）：
 *   TIERS 只有 rich；LOOP_BUDGET 同屏循环上限 ≤3 组；
 *   ANIMATIONS 每条是单个行为值（none | fade | shift | full | loop）；
 *   TRANSITIONS 每条是单个 { kind, ms }，时长 ≤ rich 档上限。
 *   Motion 只暴露单档声明（三档机制已删除）。
 *
 * 静默例外（系统「减少动态效果」）：
 *   · 不是档位、不出现在 UI；只由 JS 动画路径跳过（src/app/core.js 的 motionLevel 两态）；
 *   · CSS 侧由 css/motion.css 末尾的 @media (prefers-reduced-motion: reduce) 无条件兜底；
 *   · index.html 的 <html> 静态写 data-motion="rich"，不再有首帧内联脚本。
 *
 * 用法：node eval/motion-test.js（任一不过 → 退出码 1）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Motion = require('../src/core/motion.ts').Motion;

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function eq(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    console.log('  ok  ' + name + ' → ' + actual);
    return;
  }
  failed += 1;
  console.error('FAIL  ' + name + ' — 得到 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expected));
}
function ok(name, cond, detail) {
  if (cond) {
    console.log('  ok  ' + name);
    return;
  }
  failed += 1;
  console.error('FAIL  ' + name + (detail ? ' — ' + detail : ''));
}

/* ---------- 单档语义 ---------- */

eq('TIERS 只有 rich 一档', Object.keys(Motion.TIERS).sort().join(','), 'rich');
const rich = Motion.TIERS.rich;
eq('rich 透明度上限 420ms', rich.maxOpacityMs, 420);
eq('rich 短位移上限 220ms', rich.maxShiftMs, 220);
eq('rich 颜色上限 220ms', rich.maxColorMs, 220);
eq('rich 允许循环', rich.loops, true);
eq('LOOP_BUDGET = 3（同屏循环上限）', Motion.LOOP_BUDGET, 3);
eq('rich 的循环预算 = LOOP_BUDGET', rich.loopBudget, Motion.LOOP_BUDGET);

/* ---------- 逐动画行为声明（单值） ---------- */

const SPECS = Motion.ANIMATIONS;
const VOCAB = new Set(['none', 'fade', 'shift', 'full', 'loop']);

ok('ANIMATIONS 非空', SPECS && Object.keys(SPECS).length > 0, '声明表为空');
eq('fadeIn 是淡入兜底动画', SPECS.fadeIn, 'fade');

for (const [name, spec] of Object.entries(SPECS)) {
  ok(name + ' 是单值声明（不是三档对象）', typeof spec === 'string', '实为 ' + JSON.stringify(spec));
  ok(name + ' 行为合法（' + spec + '）', VOCAB.has(spec), '不允许 ' + spec);
}

/* 循环清单必须与「只有这几条循环」一致 */
const LOOPS = Object.keys(SPECS).filter((n) => SPECS[n] === 'loop').sort();
eq('循环动画清单', LOOPS.join(','),
  ['ambientDrift', 'breathe', 'busyFlow', 'flowLight', 'infWave', 'kenBurns', 'nodePulse'].join(','));

/* ---------- 过渡声明（单档） ---------- */

const TRANS = Motion.TRANSITIONS;
ok('TRANSITIONS 非空', TRANS && Object.keys(TRANS).length > 0, '过渡声明表为空');

const TRANS_ACTIONS = ['screen', 'stageArt', 'sibling', 'branchPage', 'modal'];
const TKIND = new Set(['instant', 'fade', 'shift', 'shared']);
const TRANS_MATRIX = {
  screen: 'shift',       // 切屏：淡入 + 短位移
  stageArt: 'shared',    // 舞台换画：共享元素
  sibling: 'shift',      // 分支切换：方向性短位移
  branchPage: 'shift',   // 分支页开合：淡入 + 位移
  modal: 'shift',        // 弹窗开合：缩放 / 位移 + 背景渐隐
};

for (const name of TRANS_ACTIONS) {
  const spec = TRANS && TRANS[name];
  ok('TRANSITIONS.' + name + ' 已声明', !!spec, '缺少 ' + name);
  if (!spec) continue;
  const keys = Object.keys(spec).sort().join(',');
  eq(name + ' 是单值声明（kind,ms）', keys, 'kind,ms');
  ok(name + ' kind 合法（' + spec.kind + '）', TKIND.has(spec.kind), '不允许 ' + spec.kind);
  ok(name + ' 有毫秒时长', typeof spec.ms === 'number' && spec.ms >= 0, '实为 ' + spec.ms);
  const cap = (spec.kind === 'shift' || spec.kind === 'shared')
    ? rich.maxShiftMs
    : rich.maxOpacityMs;
  ok(name + ' 时长 ≤ rich 上限（' + spec.ms + ' ≤ ' + cap + 'ms）', spec.ms <= cap,
    '上限 ' + cap + 'ms');
  eq(name + ' 形态（单档矩阵）', spec.kind, TRANS_MATRIX[name]);
}

/* ---------- 静默例外：系统「减少动态效果」 ---------- */

const coreSrc = read('src/app/core.js');
ok('motionLevel 两态：reduced-motion ? off : rich',
  /return\s*\(motionMQ\s*&&\s*motionMQ\.matches\)\s*\?\s*'off'\s*:\s*'rich'/.test(coreSrc),
  'src/app/core.js 的 motionLevel 不是两态实现');
ok('JS 侧不再读设置里的动效档位', !/S\.settings\.ui/.test(coreSrc), 'core.js 仍读 S.settings.ui');

const motionCss = read('css/motion.css');
ok('CSS 兜底 @media (prefers-reduced-motion: reduce) 在位',
  /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?animation-duration:\s*var\(--dur-none\)/.test(motionCss),
  'css/motion.css 末尾的兜底块缺失');
ok('CSS 不再有 standard / off 档选择器',
  !/data-motion="(standard|off)"/.test(motionCss), 'css/motion.css 仍有标准 / 关闭档选择器');

const html = read('index.html');
ok('<html> 静态声明 data-motion="rich"', /<html[^>]*\sdata-motion="rich"/.test(html), 'index.html 缺少静态属性');
const head = html.slice(0, html.indexOf('</head>'));
ok('<head> 不再有首帧内联脚本', head.indexOf("setAttribute('data-motion'") < 0, '内联脚本仍在');

const storeSrc = read('src/core/store.ts');
ok('store 不再写动效档位镜像', !/MOTION_MIRROR|mirrorMotion/.test(storeSrc), 'store.ts 仍有镜像逻辑');

if (failed) {
  console.error('motion-test：' + failed + ' 项未过');
  process.exit(1);
}
console.log('motion-test：全部通过');
