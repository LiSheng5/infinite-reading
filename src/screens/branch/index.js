/*
 * src/screens/branch/index.js —— 阶段 4 · 屏 5 分支页重写挂载（铁律 3：新旧共存，开关切换）
 *
 * 默认挂 Svelte 新分支页（顶栏 / 画布容器 / 节点详情面板）；URL 带 ?ui=legacy 时退回 0.12.1
 * 的旧 DOM（过渡期逃生口，阶段 6 删）。
 *
 * 挂载把 #branch-page 里的旧 DOM 清空换成组件输出，并在容器上打 data-impl="svelte"：
 *   - 外层 #branch-page 仍在 index.html（role="dialog" / aria-modal / .hidden 的开关由
 *     js/app/branch.js 的 openBranch / closeBranch 管，与旧实现同一套开关）；
 *   - 事件绑定一个都不跳过：返回 / 缩放 / 居中 / 展开全部 / 关闭面板 / 三个切换钮 / 画布
 *     拖拽缩放，全部由 js/app/branch.js 的 initBranch 与 bindCanvas 按 id 原样挂上
 *     （挂载在 import 期同步完成，boot 之后才 bind，组件输出的同 id 元素照常被绑到）；
 *   - 节点详情面板改由 IR.BranchScreen 状态桥推视图模型（js/app/branch.js 的 renderPanel
 *     双路取用）；SVG 画布仍由旧代码 createElementNS 命令式构建（任务书 §7.3 明确保持）。
 * 屏幕可见性仍由 openBranch / closeBranch 切 #branch-page 的 hidden，与旧实现同一套开关。
 */
import { mount, flushSync } from 'svelte';
import BranchScreen from './BranchScreen.svelte';
import { branch } from './branch.svelte.js';

const legacy = new URLSearchParams(location.search).get('ui') === 'legacy';

if (!legacy) {
  const page = document.getElementById('branch-page');
  if (page) {
    page.replaceChildren();
    page.dataset.impl = 'svelte';
    mount(BranchScreen, { target: page });
    (window.IR = window.IR || {}).BranchScreen = {
      // flushSync：renderPanel 是同步语义（点节点后立刻要读到面板里的新值 / 断言的 disabled 态）
      panelOpen(open) { flushSync(() => { branch.panelOpen = !!open; }); },
      panel(model) {
        flushSync(() => {
          branch.panel = model;
          branch.panelOpen = true;
        });
      },
    };
  }
}
