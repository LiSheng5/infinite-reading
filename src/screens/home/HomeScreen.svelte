<script>
 /* 首页（Svelte 5 重写）
   * 版式：双纽线符号 → 「继续上次」→ 两张模式卡 → 底部文字入口 → 版本文字。
   * 主视觉每次打开随机播一颗：光流版（InfinityStage）或逐格版（GridStage）——
   * 两者同一位置、同一体量，都是 canvas 逐字粒子、无底板、角标与控件，
   * rich 档自动循环，其余档停在静态帧；无 JS 时 index.html 的兜底仍是 art.js 的静态字符画。
   * 动作直连应用层注册表（src/app/core.js 的 A）。 */
  import Icon from '../../ui/Icon.svelte';
  import InfinityStage from './InfinityStage.svelte';
  import GridStage from './GridStage.svelte';
  import { home } from './home.svelte.js';
  import { A as appApi } from '../../app/core.js';

  const VERSION = __IR_VERSION__;   // 构建注入（vite.config.mjs 的 define）：版本号不再手写

  // 随机播一颗：每次打开首页只挂载其中一个（另一颗的 canvas 不创建、不跑帧）
  const useGridStage = Math.random() < 0.5;

  const A = () => appApi;
  const MODES = [
    { mode: 'choice', icon: 'book', label: '剧情' },
    { mode: 'chat', icon: 'chat', label: '聊天' },
  ];

  // 语言切换（右上角）：英文文案还没上线，先落按钮与偏好——
  // 选择写 home.lang（状态桥）+ localStorage（ir:lang），并同步 <html lang>；
  // 之后 i18n 文案接管时直接消费 home.lang，不必另起状态。
  // 交互：点击切换；左右方向键在两个选项间移动并选中（焦点跟随，radio 惯例）；
  // 选中态全在 CSS（aria-checked → 文字加深 + 蓝边框），JS 只改状态。
  const LANGS = [
    { id: 'zh', label: '中文' },
    { id: 'en', label: 'English' },
  ];
  let langOptEls = {};

  function setLang(id, moveFocus) {
    home.lang = id;
    try { localStorage.setItem('ir:lang', id); } catch { /* 隐私模式等存不进时只当次会话生效 */ }
    if (moveFocus) langOptEls[id]?.focus();
  }
  function onLangKeydown(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setLang(e.key === 'ArrowLeft' ? 'zh' : 'en', true);
  }
  // 挂载即按恢复出的偏好对齐 <html lang>（无 JS 兜底的 html 标签写死 zh-CN）
  $effect(() => { document.documentElement.lang = home.lang === 'en' ? 'en' : 'zh-CN'; });
</script>

<!-- 语言切换：挂在 #screen-start（.screen 是定位父级）右上角；样式见 css/home.css 的 .lang-switch -->
<div class="lang-switch" role="radiogroup" aria-label="界面语言">
  {#each LANGS as l (l.id)}
    <button class="lang-opt" type="button" role="radio" aria-checked={home.lang === l.id}
            tabindex={home.lang === l.id ? 0 : -1}
            bind:this={langOptEls[l.id]}
            onclick={() => setLang(l.id, false)}
            onkeydown={onLangKeydown}>{l.label}</button>
  {/each}
</div>

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
          onclick={() => A().continueLast()}>
    <Icon name="history" /><span class="sc-label">继续上次</span><span id="continue-title" class="sc-title">{home.recent || ''}</span><Icon name="chev" />
  </button>

  <div id="start-modes" class="mode-cards start-mode-cards">
    {#each MODES as m (m.mode)}
      <button class="mode-card" data-mode={m.mode} type="button" onclick={() => A().startFromStart(m.mode)}>
        <Icon name={m.icon} /><b>{m.label}</b>
      </button>
    {/each}
  </div>

  <nav class="start-links" aria-label="更多入口">
    <button id="btn-start-shelf" class="link-btn" type="button" onclick={() => A().showShelf()}>书架</button>
    <button id="btn-start-import" class="link-btn" type="button" onclick={() => A().openImportText()}>文本导入</button>
    <button id="btn-open-settings" class="link-btn" type="button" onclick={() => A().openSettings()}>接入模型</button>
  </nav>
  <p class="version">v{VERSION} · 纯本地运行 · 数据只保存在你的浏览器里</p>
</div>
