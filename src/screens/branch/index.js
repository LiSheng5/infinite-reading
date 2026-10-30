/*
 * src/screens/branch/index.js —— 分支页挂载（阶段 4 · 屏 5）
 *
 * 挂载只替换 #branch-page 的内容并打 data-impl（共用外壳见 src/screens/_mount.js）：
 *   - 外层 #branch-page 仍在 index.html（role="dialog" / aria-modal / .hidden 的开关由
 *     src/app/branch.js 的 openBranch / closeBranch 管）；
 *   - 返回 / 缩放 / 居中 / 展开全部 / 关闭面板 / 三个切换钮 / 画布拖拽缩放，全部由
 *     src/app/branch.js 的 initBranch 与 bindCanvas 按 id 原样挂上；
 *   - 节点详情面板的文本与 disabled 由 src/app/branch.js 写 branch.panel（同一份 $state）；
 *     SVG 画布仍由 src/app/branch.js 用 createElementNS 命令式构建。
 */
import { mountScreen } from '../_mount.js';
import BranchScreen from './BranchScreen.svelte';

mountScreen('branch-page', BranchScreen);
