/*
 * src/screens/branch/index.js —— 分支页挂载（阶段 4 · 屏 5）
 *
 * 挂载把 #branch-page 里的旧 DOM 清空换成组件输出，并在容器上打 data-impl="svelte"：
 *   - 外层 #branch-page 仍在 index.html（role="dialog" / aria-modal / .hidden 的开关由
 *     src/app/branch.js 的 openBranch / closeBranch 管）；
 *   - 返回 / 缩放 / 居中 / 展开全部 / 关闭面板 / 三个切换钮 / 画布拖拽缩放，全部由
 *     src/app/branch.js 的 initBranch 与 bindCanvas 按 id 原样挂上；
 *   - 节点详情面板的文本与 disabled 由 src/app/branch.js 写 branch.panel（同一份 $state）；
 *     SVG 画布仍由 src/app/branch.js 用 createElementNS 命令式构建。
 */
import { mount } from 'svelte';
import BranchScreen from './BranchScreen.svelte';

const page = document.getElementById('branch-page');
if (page) {
  page.replaceChildren();
  page.dataset.impl = 'svelte';
  mount(BranchScreen, { target: page });
}
