<script>
 /* 首页（Svelte 5 重写）
   * 版式：双纽线符号 → 「继续上次」→ 两张模式卡 → 底部文字入口 → 版本文字。
   * 主视觉在挂载时随机选一颗（本屏只在启动时挂载一次，之后只切 hidden，刷新才重新随机）：光流版（InfinityStage）或逐格版（GridStage）——
   * 两者同一位置、同一体量，都是 canvas 逐字粒子、无底板、角标与控件，
   * 系统减少动效或页面不可见时停在静态帧；无 JS 时 index.html 的兜底仍是 art.js 的静态字符画。
   * 动作直连应用层注册表（src/app/core.js 的 A）。 */
  import Icon from '../../ui/Icon.svelte';
  import InfinityStage from './InfinityStage.svelte';
  import GridStage from './GridStage.svelte';
  import { home } from './home.svelte.js';
  import { A as appApi } from '../../app/core.js';

  const VERSION = __IR_VERSION__;   // 构建注入（vite.config.mjs 的 define）：版本号不再手写

  // 随机选一颗：组件挂载那一刻定下来（刷新才重新随机），另一颗的 canvas 不创建、不跑帧
  const useGridStage = Math.random() < 0.5;

  const MODES = [
    { mode: 'choice', icon: 'book', label: '剧情' },
    { mode: 'chat', icon: 'chat', label: '聊天' },
  ];

</script>

<div class="start-card">
  <h1 class="start-mark" aria-label="无限阅读">
    {#if useGridStage}
      <GridStage />
    {:else}
      <InfinityStage />
    {/if}
  </h1>

  <!-- 有存档时才出现：回访用户最常做的就是接着读（可见性与标题走 home 状态桥） -->
  <button id="btn-continue" class="start-continue" class:hidden={home.recent === null} type="button"
          onclick={() => appApi.continueLast()}>
    <Icon name="history" /><span class="sc-label">继续上次</span><span id="continue-title" class="sc-title">{home.recent || ''}</span><Icon name="chev" />
  </button>

  <div id="start-modes" class="mode-cards start-mode-cards">
    {#each MODES as m (m.mode)}
      <button class="mode-card" data-mode={m.mode} type="button" onclick={() => appApi.startFromStart(m.mode)}>
        <Icon name={m.icon} /><b>{m.label}</b>
      </button>
    {/each}
  </div>

  <nav class="start-links" aria-label="更多入口">
    <button id="btn-start-shelf" class="link-btn" type="button" onclick={() => appApi.showShelf()}>书架</button>
    <button id="btn-start-import" class="link-btn" type="button" onclick={() => appApi.openImportText()}>文本导入</button>
    <button id="btn-open-settings" class="link-btn" type="button" onclick={() => appApi.openSettings()}>接入模型</button>
  </nav>
  <p class="version">v{VERSION} · 纯本地运行 · 数据只保存在你的浏览器里</p>
</div>
