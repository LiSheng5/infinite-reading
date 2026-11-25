/*
 * 无限阅读 · PWA 注册
 *
 * 只做一件事：在 https / localhost 下注册 Service Worker（见根目录 sw.js）。
 * 由 src/main.js 静态 import：不依赖界面状态、不改任何界面状态，只是「装个帽子」。
 *
 * 会静默跳过的情形（都不影响使用）：
 *   - file:// 双击打开：浏览器不支持在 file:// 下注册 SW
 *   - 老浏览器没有 navigator.serviceWorker
 *   - 注册失败（比如 sw.js 404 / 证书问题）
 */
const host = location.hostname;
const canRegister = 'serviceWorker' in navigator
  && (location.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1');

if (canRegister) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 静默：离线能力是加分项，不是必需项 */ });
  });
}
