/* src/screens/branch/branch.svelte.js —— 分支页屏的状态桥（Svelte 5 runes）
 *
 * src/app/branch.js 的 renderPanel 经 BranchScreen 把「节点详情」视图模型推进来：
 *   panelOpen  —— 面板显隐（窄屏底部弹层 / 桌面右侧停靠）
 *   panel      —— 六个文本字段 + 三个按钮的 disabled（口径与旧 renderPanel 逐字一致）
 *
 * 分工（同屏 4 阅读页的约定）：动态面里只有面板是「文本 + 布尔」的形状，走状态桥；
 * SVG 画布（节点 / 边 / 标签）按任务书 §7.3「构造方式保持」仍由 src/app/branch.js
 * 用 createElementNS 命令式构建——那是画布，不是组件能替的表单。
 */
import { flushSync } from 'svelte';

export const branch = $state({
  panelOpen: false,
  panel: {
    turn: '',
    action: '',
    reply: '',
    time: '',
    model: '',
    warn: '',
    resumeDisabled: true,
    forkDisabled: true,
    latestDisabled: true,
  },
});

/* 推视图模型的两个入口（src/app/branch.js 调用）。
 * flushSync：renderPanel 是同步语义（点节点后立刻要读到面板里的新值 / 新 disabled 态）。 */
export function setBranchPanelOpen(open) {
  flushSync(() => { branch.panelOpen = !!open; });
}

export function setBranchPanel(model) {
  flushSync(() => {
    branch.panel = model;
    branch.panelOpen = true;
  });
}
