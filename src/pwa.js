/*
 * 无限阅读 · PWA 注册（开源路线图 W3 / L2）
 *
 * 只做一件事：在 https / localhost 下注册 Service Worker（见根目录 sw.js）。
 * 放在 app.js 之后加载是刻意的：它不依赖 IR、不改任何界面状态，只是「装个帽子」。
 *
 * 会静默跳过的情形（都不影响使用）：
 *   - file:// 双击打开：浏览器不支持在 file:// 下注册 SW
 *   - 老浏览器没有 navigator.serviceWorker
 *   - 注册失败（比如 sw.js 404 / 证书问题）
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  const host = location.hostname;
  const okProto = location.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1';
  if (!okProto) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 静默：离线能力是加分项，不是必需项 */ });
  });
})();
