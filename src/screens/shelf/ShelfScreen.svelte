<script>
  /* 阶段 4 · 屏 3 书架（Svelte 5 重写，任务书 §7.3）
   * 行列表（shelf-row-* / thumb / row-menu）、搜索结果（shelf-hit + mark 高亮）、空态的 DOM
   * 与 0.12.1 的 src/app/shelf.js 拼装结果逐节点同结构——旧行为函数（openStory / rename /
   * regen / search / keyboard）零改动，靠 id / class 选择器继续工作（titleElOf、moveActive 等）。
   * 行菜单（.menu.row-menu）仍由 shelf.js 的 openRowMenu 原样 appendChild 到行上（组件不管它的 DOM）；
   * 标题打字机（typewriteTitle）直接改 .shelf-row-title 的 textContent——{#key} 每次推送整体重建行，
   * 与旧 renderShelf 的 innerHTML='' 同语义，打字机中途不会被组件重绘冲掉。
   * 安全红线（§8）：缩略图走 Store.safeThumb + JSON.stringify 转义进 url()；命中高亮只用 <mark>
   * 元素 + 文本插值，绝不用 {@html}（用户 / 模型产出一律文本渲染）。
   * 顶部按钮的动作直连应用层注册表（src/app/core.js 的 A）；
   * 搜索框 / 键盘 / 空状态按钮不带 handler——由 src/app/shelf.js 的 initShelf 按 id 原样绑定。 */
  import Icon from '../../ui/Icon.svelte';
  import { shelf } from './shelf.svelte.js';
  import { A as appApi } from '../../app/core.js';

  const A = () => appApi;

  function openHit(h) {
    A().openStory(h.id, { focusNodeId: h.focusNid });
  }

  // 行 / 命中行键盘（与 rowOf / resultRowOf 的 keydown 同语义）：Enter 打开；Shift+F10 / ContextMenu 菜单
  function rowKey(e, it) {
    if (e.key === 'Enter') { e.preventDefault(); A().openStory(it.id); }
    else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      A().openRowMenu(e.currentTarget, it);
    }
  }

  function hitKey(e, h) {
    if (e.key === 'Enter') { e.preventDefault(); openHit(h); }
    else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      A().openRowMenu(e.currentTarget, { id: h.id, title: h.rawTitle });
    }
  }

  function rowMenu(e, it) {
    e.stopPropagation();
    A().openRowMenu(e.currentTarget.closest('.shelf-row'), it);
  }
</script>

<div class="shelf-wrap">
  <header class="shelf-head">
    <h1 class="shelf-title">书架</h1>
    <div class="shelf-search">
      <!-- aria-activedescendant 初值为空串与旧 DOM 同结构（结果行出现后由 shelf.js 填充） -->
      <!-- svelte-ignore a11y_incorrect_aria_attribute_type -->
      <input id="shelf-search" class="shelf-search-input" type="text" autocomplete="off" spellcheck="false"
             placeholder="搜索标题与正文…（/ 或 Ctrl+K）" aria-label="搜索对话"
             role="combobox" aria-expanded="false" aria-controls="shelf-results" aria-activedescendant="">
      <button id="shelf-search-clear" class="hud-btn hidden" title="清空搜索" aria-label="清空搜索"><Icon name="x" /></button>
    </div>
    <div class="shelf-actions">
      <button id="btn-new-story" class="btn primary" onclick={() => A().openModal('modal-new')}><Icon name="plus" class="ic-l" />新建</button>
      <button id="btn-import" class="btn ghost" title="导入 .irstory.json / .irbackup.json / .zip" onclick={() => document.getElementById('file-import').click()}><Icon name="up" class="ic-l" />导入</button>
      <button id="btn-import-text" class="btn ghost" title="粘贴文本导入" onclick={() => A().openImportText()}>文本导入</button>
      <button id="btn-shelf-settings" class="btn ghost" title="设置" onclick={() => A().openSettings()}><Icon name="gear" class="ic-l" />设置</button>
      <button id="btn-shelf-home" class="btn ghost" title="回到首页" onclick={() => A().showStart()}><Icon name="back" class="ic-l" />首页</button>
    </div>
  </header>

  <div id="shelf-list" class="shelf-list" role="listbox" aria-label="对话列表">
    {#key shelf.seq}
      {#each shelf.groups as g (g.key)}
        <div class="shelf-group-head">{g.label} · {g.count}</div>
        {#each g.items as it (it.id)}
          <div class="shelf-row" class:current={it.current} class:row-in={it.rowIn}
               id={'shelf-row-' + it.id} data-story-id={it.id} role="option"
               aria-selected={it.current ? 'true' : 'false'} tabindex="0"
               style={it.delay ? 'animation-delay: ' + it.delay : null}
               onclick={() => A().openStory(it.id)} onkeydown={(e) => rowKey(e, it)}>
            <div class="shelf-row-thumb" class:empty={!it.thumb}
                 style={it.thumb ? 'background-image: url(' + JSON.stringify(it.thumb) + ')' : null}>
              {#if !it.thumb}<Icon name={it.icon} />{/if}
            </div>
            <div class="shelf-row-body">
              <div class="shelf-row-title">{it.title}</div>
              <div class="shelf-row-meta">{it.meta}</div>
              <div class="shelf-row-snippet">{it.snippet}</div>
            </div>
            <button class="shelf-row-more" title="更多操作" aria-label="更多操作" onclick={(e) => rowMenu(e, it)}><Icon name="more" /></button>
          </div>
        {/each}
        {#if g.capped}
          <button class="btn ghost shelf-more" onclick={() => A().showAllEarlier()}>展开更多（还有 {g.moreCount} 条）</button>
        {/if}
      {/each}
    {/key}
  </div>

  <div id="shelf-results" class="shelf-results hidden" role="listbox" aria-label="搜索结果">
    {#key shelf.resSeq}
      {#each shelf.hits as h (h.id)}
        <div class="shelf-hit" id={'shelf-hit-' + h.id} data-story-id={h.id} role="option"
             aria-selected="false" tabindex="0"
             onclick={() => openHit(h)} onkeydown={(e) => hitKey(e, h)}>
          <div class="shelf-hit-title">{#each h.titleSegs as s}{#if s.mark}<mark>{s.t}</mark>{:else}{s.t}{/if}{/each}</div>
          <div class="shelf-hit-meta">{h.meta}</div>
          {#each h.snippets as segs}
            <div class="shelf-hit-snippet">{#each segs as s}{#if s.mark}<mark>{s.t}</mark>{:else}{s.t}{/if}{/each}</div>
          {/each}
        </div>
      {/each}
    {/key}
  </div>

  <div id="shelf-empty" class="shelf-empty hidden">
    <p class="shelf-empty-text">还没有对话。点「新建」开始第一段。</p>
    <button id="btn-empty-new" class="btn primary empty-new"><Icon name="plus" class="ic-l" />新建</button>
    <p class="hint">也可以把 <b>.irstory.json</b> / <b>.irbackup.json</b> / <b>.zip</b>（带原图的备份包）文件拖进这个窗口导入。</p>
  </div>
  <div id="shelf-search-empty" class="shelf-empty hidden">
    <p class="shelf-empty-text">没有找到匹配「<span id="shelf-search-term"></span>」的对话。</p>
    <p class="hint">换个词试试：标题与正文（含所有分支）都会被搜到。</p>
  </div>

  <p class="shelf-foot">数据只保存在你的浏览器里 · 退出即自动存档</p>
</div>
