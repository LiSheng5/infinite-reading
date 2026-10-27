/*
 * src/screens/shelf/index.js —— 阶段 4 · 屏 3 书架重写挂载（铁律 3：新旧共存，开关切换）
 *
 * 默认挂 Svelte 新书架；URL 带 ?ui=legacy 时退回 0.12.1 的旧书架 DOM（过渡期逃生口，阶段 6 删）。
 * 挂载把 #screen-shelf 里的旧 DOM 清空换成组件输出，并在容器上打 data-impl="svelte"：
 *   - js/app.js 的顶部按钮旧绑定见这个标记即跳过（搜索 / 键盘 / 空状态按钮仍由
 *     js/app/shelf.js 的 initShelf 按 id 绑定，行为零改动）；
 *   - js/app/shelf.js 的 renderShelf / runSearch 经 IR.ShelfScreen 状态桥把视图模型推进来，
 *     行列表 / 搜索结果 / 高亮片段由组件按旧 DOM 结构渲染。
 * 屏幕可见性仍由界面层的 showShelf / showStart 切 #screen-shelf 的 hidden，与旧实现同一套开关。
 */
import { mount } from 'svelte';
import ShelfScreen from './ShelfScreen.svelte';
import { shelf } from './shelf.svelte.js';

const legacy = new URLSearchParams(location.search).get('ui') === 'legacy';

if (!legacy) {
  const section = document.getElementById('screen-shelf');
  if (section) {
    section.replaceChildren();
    section.dataset.impl = 'svelte';
    mount(ShelfScreen, { target: section });
    (window.IR = window.IR || {}).ShelfScreen = {
      render(model) { shelf.seq += 1; shelf.groups = model; },
      results(hits) { shelf.resSeq += 1; shelf.hits = hits; },
    };
  }
}
