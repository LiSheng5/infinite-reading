/*
 * src/ui/gallery.js —— 组件库展示页挂载点（阶段 3）
 *
 * 只在 URL 带 ?ui=1 时把 Gallery 挂到全屏面板；默认形态零像素变化（与 src/spike/index.js 同一套「开关切换」模式）。
 * 用途：阶段 3 起组件库的视觉 / 动效自查（Playwright 截图、三档切换、循环预算演示），阶段 4 起对照开发。
 */
import { mount } from 'svelte';
import Gallery from './Gallery.svelte';

if (new URLSearchParams(location.search).get('ui') === '1') {
  const host = document.createElement('div');
  host.id = 'ir-ui-host';
  document.body.appendChild(host);
  mount(Gallery, { target: host });
}
