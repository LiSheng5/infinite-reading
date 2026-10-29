/*
 * src/screens/home/index.js —— 首页挂载（阶段 4 · 屏 1）
 *
 * 挂载把 #screen-start 里的旧 DOM 清空换成组件输出，并在容器上打 data-impl="svelte"。
 * 屏幕可见性仍由界面层的 showStart / showShelf 切 #screen-start 的 hidden（Nav.showScreen）。
 * 「继续上次」的状态由 src/app/library.js 写 home.recent（同一份 $state）。
 */
import { mount } from 'svelte';
import HomeScreen from './HomeScreen.svelte';

const section = document.getElementById('screen-start');
if (section) {
  section.replaceChildren();
  section.dataset.impl = 'svelte';
  mount(HomeScreen, { target: section });
}
