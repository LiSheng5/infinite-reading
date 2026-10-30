<script>
  /* 阶段 4 · 屏 1 首页（Svelte 5 重写）
   * 版式与 0.12.1 保持：ASCII 无限符号 → 「继续上次」→ 三张模式卡 → 底部文字入口 → 版本文字。
   * 无限符号沿用逐字拆 span 的实现（深色在底、浅色在 ::after 叠层只动 opacity），
   * 三档行为不变：只有 rich 档循环，其余档停在「深 → 浅 → 深」静态渐变（css/home.css 的 .inf）。
   * 动作直连应用层注册表（src/app/core.js 的 A）。 */
  import Icon from '../../ui/Icon.svelte';
  import { home } from './home.svelte.js';
  import { A as appApi } from '../../app/core.js';
  import { HOME_ART } from './art.js';

  const VERSION = __IR_VERSION__;   // 构建注入（vite.config.mjs 的 define）：版本号不再手写

  // 字符画来自 ./art.js（唯一真源）：无 JS 兜底那份由构建期从同一个文件注入 index.html
  // 逐字拆行（把每个非空白字符包成 span.c）：
  //   --x = 所在列（循环相位，色带从左往右流）；--t = 静态时的浅蓝占比
  // 深色在底层、浅色在 ::after 叠层，只改叠层 opacity 做深浅循环（守住动画白名单），
  // 循环强度跟随 data-motion（css/home.css 的 .inf）
  const width = Math.max(...HOME_ART.map(r => r.length));
  const rows = HOME_ART.map(row => {
    const cells = [];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      cells.push(ch === ' '
        ? { space: true }
        : { space: false, ch, x, t: (0.5 - 0.5 * Math.cos(2 * Math.PI * x / Math.max(1, width - 1))).toFixed(2) });
    }
    return cells;
  });

  const A = () => appApi;
  const MODES = [
    { mode: 'choice', icon: 'book', label: '剧情' },
    { mode: 'chat', icon: 'chat', label: '智能体' },
    { mode: 'rp', icon: 'mask', label: '扮演' },
  ];
</script>

<div class="start-card">
  <h1 class="start-mark" aria-label="无限阅读"><pre class="inf" aria-hidden="true">{#each rows as row, ri}{#each row as cell}{#if cell.space}{' '}{:else}<span class="c" data-c={cell.ch} style="--x: {cell.x}; --t: {cell.t};">{cell.ch}</span>{/if}{/each}{#if ri < rows.length - 1}{'\n'}{/if}{/each}</pre></h1>

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
