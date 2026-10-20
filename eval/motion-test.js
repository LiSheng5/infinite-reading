/* UI-1 动效强度解析单测（§6.3）——纯逻辑、不开浏览器、不联网。
 *
 * IR.Motion.resolve(pref, prefersReduced)：
 *   auto → prefersReduced ? 'off' : 'rich'
 *   显式 off / standard / rich 优先于系统偏好
 *   未知值 / undefined / null 当 'auto'
 *
 * 用法：node eval/motion-test.js（任一不过 → 退出码 1）
 */
'use strict';

const Motion = require('../js/motion.js');

let failed = 0;
function eq(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    console.log('  ok  ' + name + ' → ' + actual);
    return;
  }
  failed += 1;
  console.error('FAIL  ' + name + ' — 得到 ' + actual + '，期望 ' + expected);
}

eq("resolve('auto', false)", Motion.resolve('auto', false), 'rich');
eq("resolve('auto', true)", Motion.resolve('auto', true), 'off');
eq("resolve('rich', true)（显式优先）", Motion.resolve('rich', true), 'rich');
eq("resolve('off', false)", Motion.resolve('off', false), 'off');
eq("resolve('standard', false)", Motion.resolve('standard', false), 'standard');
eq("resolve('standard', true)", Motion.resolve('standard', true), 'standard');
eq('resolve(undefined, false) 当 auto', Motion.resolve(undefined, false), 'rich');
eq('resolve(null, true) 当 auto', Motion.resolve(null, true), 'off');
eq("resolve('nonsense', false) 当 auto", Motion.resolve('nonsense', false), 'rich');
eq("resolve(42, true) 当 auto", Motion.resolve(42, true), 'off');

if (failed) {
  console.error('motion-test：' + failed + ' 项未过');
  process.exit(1);
}
console.log('motion-test：全部通过');
