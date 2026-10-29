<script>
  /* BranchScreen.svelte —— 阶段 4 · 屏 5 分支页重写（整页分支树 + 节点详情面板）
   * 任务书 §7.3：功能与交互不变，视觉套新组件库；分支页的布局算法（TreeLayout）与
   * SVG 构造方式（createElementNS、绝不用 innerHTML）**保持**。
   *
   * 分工：
   *   - 静态骨架（顶栏 / 画布容器 / 面板外壳）→ 本组件，id 与 0.12.1 的 #branch-page 子树逐个保留，
   *     旧逻辑（src/app/branch.js 的 openBranch / render / bindCanvas / initBranch）按 id 照常命中，
   *     行为零改动；
   *   - 节点详情面板（六个文本字段 + 三个按钮的 disabled）→ 状态桥 BranchScreen（branch.svelte.js），
   *     renderPanel 推视图模型，组件按旧 DOM 渲染；
   *   - SVG 画布（边 / 节点 / 箭头 / 折叠超级节点）→ 仍由 src/app/branch.js 命令式构建：任务书明确
   *     要求保持 createElementNS，且 400 节点级的重建属命令式渲染，组件化只会把几何算两遍。
   * 安全红线（§8）：标签文本 / 面板文本一律文本插值；本组件不含任何 {@html}。
   */
  import Icon from '../../ui/Icon.svelte';
  import { branch } from './branch.svelte.js';
</script>

<header class="branch-top">
  <button id="btn-branch-back" class="btn" type="button"><Icon name="back" class="ic-l" />返回对话</button>
  <h2 id="branch-title" class="branch-title"></h2>
  <div class="branch-tools">
    <button id="btn-branch-zoom-out" class="hud-btn hud-icon" type="button" title="缩小" aria-label="缩小"><Icon name="minus" /></button>
    <button id="btn-branch-zoom-in" class="hud-btn hud-icon" type="button" title="放大" aria-label="放大"><Icon name="plus" /></button>
    <button id="btn-branch-center" class="btn" type="button" title="居中并选中当前回合">回到当前</button>
    <button id="btn-branch-expand-all" class="btn" type="button" aria-pressed="false">展开全部折叠</button>
  </div>
</header>

<div class="branch-body">
  <div id="branch-canvas" class="branch-canvas">
    <!-- SVG 一律 createElementNS 构造，不用 innerHTML（由 src/app/branch.js 命令式填充） -->
    <svg id="branch-svg" role="tree" aria-label="分支树" tabindex="0"></svg>
  </div>
  <aside id="branch-panel" class="branch-panel" class:hidden={!branch.panelOpen} aria-label="节点详情">
    <div class="branch-panel-head">
      <div id="bp-turn" class="bp-turn">{branch.panel.turn}</div>
      <button id="btn-bp-close" class="hud-btn hud-icon" type="button" title="关闭面板" aria-label="关闭面板"><Icon name="x" /></button>
    </div>
    <div class="branch-panel-body">
      <div class="bp-field"><div class="bp-label">玩家行动</div><div id="bp-action" class="bp-text">{branch.panel.action}</div></div>
      <div class="bp-field"><div class="bp-label">AI 回复</div><div id="bp-reply" class="bp-text">{branch.panel.reply}</div></div>
      <div class="bp-field"><div class="bp-label">时间</div><div id="bp-time" class="bp-text">{branch.panel.time}</div></div>
      <div class="bp-field"><div class="bp-label">模型</div><div id="bp-model" class="bp-text">{branch.panel.model}</div></div>
      {#if branch.panel.warn}<p id="bp-warn" class="bp-warn">{branch.panel.warn}</p>{/if}
    </div>
    <div class="branch-panel-actions">
      <button id="btn-bp-resume" class="btn primary" type="button" disabled={branch.panel.resumeDisabled}>回到这里并从此继续</button>
      <button id="btn-bp-fork" class="btn" type="button" disabled={branch.panel.forkDisabled}>改我说的，从这之前分叉</button>
      <button id="btn-bp-latest" class="btn" type="button" disabled={branch.panel.latestDisabled}>切到这条分支的最新处</button>
    </div>
  </aside>
</div>
