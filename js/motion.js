/* 动效强度解析（UI-1）：纯逻辑，不碰 DOM，Node 可 require。
 *
 *   IR.Motion.resolve(pref, prefersReduced) → 'off' | 'standard' | 'rich'
 *     pref: 'auto' | 'off' | 'standard' | 'rich'（未知值当 'auto'）
 *     auto  → prefersReduced ? 'off' : 'rich'
 *     显式选择优先于系统偏好（用户知情地选了丰富就尊重）
 *
 * 强度档位的视觉规则见 css/style.css 的 html[data-motion] 规则块；
 * 应用层（app.js）启动时与 prefers-reduced-motion 变化时，
 * 把 resolve 的结果写进 document.documentElement.dataset.motion。 */
(function (global) {
  'use strict';

  var LEVELS = ['off', 'standard', 'rich'];

  function resolve(pref, prefersReduced) {
    if (LEVELS.indexOf(pref) >= 0) return pref;
    return prefersReduced ? 'off' : 'rich';
  }

  global.IR = Object.assign(global.IR || {}, {
    Motion: { resolve: resolve, LEVELS: LEVELS.slice() },
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.IR.Motion;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
