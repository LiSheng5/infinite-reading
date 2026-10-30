/*  动效强度解析 + 三档声明表单测（阶段 3）——纯逻辑、不开浏览器、不联网。
 *
 * IR.Motion.resolve(pref, prefersReduced)：
 *   auto → prefersReduced ? 'off' : 'rich'
 *   显式 off / standard / rich 优先于系统偏好
 *   未知值 / undefined / null 当 'auto'
 *
 * 阶段 3 新增（统一 motion 模块）：
 *   TIERS 三档政策：off 无位移无循环 ≤80ms 透明度；standard 无循环、短位移 ≤160ms；rich 全开
 *   LOOP_BUDGET 循环动画上限（同屏 ≤3 组）
 *   ANIMATIONS 逐动画三档行为声明：off ⊆ {none,fade}、standard ⊆ {none,fade,shift}、
 *   rich ⊆ {none,fade,shift,full,loop}；档次富度 off ≤ standard ≤ rich
 *
 * 阶段 5 新增（过渡内核的声明表）：
 *   TRANSITIONS 逐过渡动作三档 kind / 时长：off 一律 instant/0；standard 只准 instant|fade；
 *   rich 可到 shift|shared；时长 ≤ 该档 TIERS 上限（shift/shared 按 maxShiftMs，fade 按 maxOpacityMs）；
 *   shared 只准 rich；五个动作的 standard / rich 形态与三档矩阵逐条对齐。
 *
 * 用法：node eval/motion-test.js（任一不过 → 退出码 1）
 */
'use strict';

const Motion = require('../src/core/motion.ts').Motion;

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

/* ---------- resolve（0.12.1 语义，逐字保留） ---------- */

eq("resolve('auto', false)", Motion.resolve('auto', false), 'rich');
eq("resolve('auto', true)", Motion.resolve('auto', true), 'off');
eq("resolve('rich', true)（显式优先）", Motion.resolve('rich', true), 'rich');
eq("resolve('off', false)", Motion.resolve('off', false), 'off');
eq("resolve('standard', false)", Motion.resolve('standard', false), 'standard');
eq("resolve('standard', true)", Motion.resolve('standard', true), 'standard');
eq('resolve(undefined, false) 当 auto', Motion.resolve(undefined, false), 'rich');
eq('resolve(null, true) 当 auto', Motion.resolve(null, true), 'off');
eq("resolve('nonsense', false) 当 auto", Motion.resolve('nonsense', false), 'rich');
eq('resolve(42, true) 当 auto', Motion.resolve(42, true), 'off');

/* ---------- 三档政策 ---------- */

eq('LEVELS', Motion.LEVELS.join(','), 'off,standard,rich');
ok('TIERS 三档齐备', ['off', 'standard', 'rich'].every(l => Motion.TIERS && Motion.TIERS[l]));

const off = Motion.TIERS.off;
const std = Motion.TIERS.standard;
const rich = Motion.TIERS.rich;
eq('off 透明度上限 80ms', off.maxOpacityMs, 80);
eq('off 无位移', off.maxShiftMs, 0);
eq('off 无循环', off.loops, false);
eq('standard 短位移 ≤160ms', std.maxShiftMs, 160);
eq('standard 无循环', std.loops, false);
eq('rich 全开', rich.loops, true);
eq('LOOP_BUDGET = 3（同屏循环上限）', Motion.LOOP_BUDGET, 3);
eq('rich 的循环预算 = LOOP_BUDGET', rich.loopBudget, Motion.LOOP_BUDGET);
eq('off/standard 循环预算为 0', off.loopBudget + std.loopBudget, 0);

/* ---------- 逐动画三档行为声明表 ---------- */

const SPECS = Motion.ANIMATIONS;
const VOCAB = {
  off: new Set(['none', 'fade']),
  standard: new Set(['none', 'fade', 'shift']),
  rich: new Set(['none', 'fade', 'shift', 'full', 'loop']),
};
const RICHNESS = { none: 0, fade: 1, shift: 2, full: 3, loop: 4 };

ok('ANIMATIONS 非空', SPECS && Object.keys(SPECS).length > 0, '声明表为空');
ok('fadeIn 是全档淡入的兜底动画', SPECS.fadeIn && SPECS.fadeIn.off === 'fade' && SPECS.fadeIn.rich === 'fade');

for (const [name, spec] of Object.entries(SPECS)) {
  const keys = Object.keys(spec).filter(k => k !== 'decorative').sort().join(',');
  ok(name + ' 恰好声明 off/standard/rich', keys === 'off,rich,standard', '实为 ' + keys);
  for (const tier of ['off', 'standard', 'rich']) {
    ok(name + '.' + tier + ' 合法（' + spec[tier] + '）', VOCAB[tier].has(spec[tier]),
      tier + ' 不允许 ' + spec[tier]);
  }
  ok(name + ' 档次富度 off ≤ standard ≤ rich',
    RICHNESS[spec.off] <= RICHNESS[spec.standard] && RICHNESS[spec.standard] <= RICHNESS[spec.rich]);
  if (spec.rich === 'loop') {
    ok(name + ' 循环只在 rich（standard/off 必须收成 none/fade）',
      VOCAB.off.has(spec.off) && spec.standard !== 'loop');
  }
}

/* ---------- 阶段 5：过渡声明表 TRANSITIONS ---------- */

const TRANS = Motion.TRANSITIONS;
ok('TRANSITIONS 非空', TRANS && Object.keys(TRANS).length > 0, '过渡声明表为空');

const TRANS_ACTIONS = ['screen', 'stageArt', 'sibling', 'branchPage', 'modal'];
for (const name of TRANS_ACTIONS) {
  ok('TRANSITIONS.' + name + ' 已声明', !!(TRANS && TRANS[name]), '缺少 ' + name);
}

// 「三档验收矩阵」：standard = 交叉淡入、rich = 位移 / 共享元素
const TRANS_MATRIX = {
  screen: ['fade', 'shift'],       // 切屏：standard 交叉淡入 / rich 淡入 + 短位移
  stageArt: ['fade', 'shared'],    // 舞台换画：standard 淡入 / rich 共享元素
  sibling: ['fade', 'shift'],      // 分支切换：standard 交叉淡入无横向位移 / rich 方向性短位移
  branchPage: ['fade', 'shift'],   // 分支页开合：standard 淡入 / rich 淡入 + 位移
  modal: ['fade', 'shift'],        // 弹窗开合：standard 淡入 / rich 缩放 / 位移 + 背景渐隐
};

const TKIND = {
  off: new Set(['instant']),
  standard: new Set(['instant', 'fade']),
  rich: new Set(['instant', 'fade', 'shift', 'shared']),
};
const TRICH = { instant: 0, fade: 1, shift: 2, shared: 3 };

for (const [name, spec] of Object.entries(TRANS || {})) {
  const keys = Object.keys(spec).sort().join(',');
  ok(name + ' 过渡恰好声明 off/standard/rich', keys === 'off,rich,standard', '实为 ' + keys);
  for (const tier of ['off', 'standard', 'rich']) {
    const s = spec[tier] || {};
    ok(name + '.' + tier + ' kind 合法（' + s.kind + '）', TKIND[tier].has(s.kind),
      '三档矩阵：' + tier + ' 不允许 ' + s.kind);
    ok(name + '.' + tier + ' 有毫秒时长', typeof s.ms === 'number' && s.ms >= 0 && s.ms <= 1000, '实为 ' + s.ms);
    const cap = (s.kind === 'shift' || s.kind === 'shared')
      ? Motion.TIERS[tier].maxShiftMs
      : Motion.TIERS[tier].maxOpacityMs;
    ok(name + '.' + tier + ' 时长 ≤ 该档上限（' + s.ms + ' ≤ ' + cap + 'ms）', s.ms <= cap,
      tier + ' 上限 ' + cap + 'ms');
    if (s.kind === 'shared') ok(name + '.' + tier + ' 共享元素只准 rich', tier === 'rich', 'shared 仅 rich');
  }
  ok(name + ' 过渡档次富度 off ≤ standard ≤ rich',
    (TRICH[spec.off.kind] || 0) <= (TRICH[spec.standard.kind] || 0)
    && (TRICH[spec.standard.kind] || 0) <= (TRICH[spec.rich.kind] || 0));
  ok(name + '.off 必须即时且 0ms（off 无过渡）', spec.off.kind === 'instant' && spec.off.ms === 0,
    '实为 ' + spec.off.kind + '/' + spec.off.ms + 'ms');
  const want = TRANS_MATRIX[name];
  if (want) {
    ok(name + '.standard = ' + want[0] + '（三档矩阵）', spec.standard.kind === want[0], '实为 ' + spec.standard.kind);
    ok(name + '.rich = ' + want[1] + '（三档矩阵）', spec.rich.kind === want[1], '实为 ' + spec.rich.kind);
  }
}

if (failed) {
  console.error('motion-test：' + failed + ' 项未过');
  process.exit(1);
}
console.log('motion-test：全部通过');
