/*
 * src/screens/shelf/index.js —— 书架挂载（阶段 4 · 屏 3）
 *
 * 挂载把 #screen-shelf 里的旧 DOM 清空换成组件输出，并在容器上打 data-impl="svelte"：
 *   - 搜索框 / 键盘 / 空状态按钮仍由 src/app/shelf.js 的 initShelf 按 id 绑定；
 *   - 行列表 / 搜索结果由 src/app/shelf.js 写 shelf.groups / shelf.hits（同一份 $state）。
 * 屏幕可见性仍由界面层的 showShelf / showStart 切 hidden（Nav.showScreen）。
 */
import { mount } from 'svelte';
import ShelfScreen from './ShelfScreen.svelte';

const section = document.getElementById('screen-shelf');
if (section) {
  section.replaceChildren();
  section.dataset.impl = 'svelte';
  mount(ShelfScreen, { target: section });
}
