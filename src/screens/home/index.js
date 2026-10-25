/*
 * src/screens/home/index.js —— 阶段 4 · 屏 1 首页重写挂载（铁律 3：新旧共存，开关切换）
 *
 * 默认挂 Svelte 新首页；URL 带 ?ui=legacy 时退回 0.12.1 的旧首页（过渡期逃生口，阶段 6 随 legacy 入口一起删）。
 * 挂载把 #screen-start 里的旧 DOM 清空换成组件输出，并在容器上打 data-impl="svelte"：
 *   - js/app.js 的旧事件绑定见这个标记即跳过（否则新旧两套 handler 双重触发）；
 *   - js/app/library.js 的 showStart 经 IR.HomeScreen 桥把「继续上次」状态推进来。
 * 屏幕可见性仍由界面层的 showStart / showShelf 切 #screen-start 的 hidden，与旧实现同一套开关。
 */
import { mount } from 'svelte';
import HomeScreen from './HomeScreen.svelte';
import { home } from './home.svelte.js';

const legacy = new URLSearchParams(location.search).get('ui') === 'legacy';

if (!legacy) {
  const section = document.getElementById('screen-start');
  if (section) {
    section.replaceChildren();
    section.dataset.impl = 'svelte';
    mount(HomeScreen, { target: section });
    (window.IR = window.IR || {}).HomeScreen = {
      setRecent(label) { home.recent = label; },
    };
  }
}
