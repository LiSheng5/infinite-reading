<script>
 /* 设置屏（Svelte 5 重写）
   * 界面由 settingsForm.js 的字段配置生成（id / 标签 / 类型 / 分组 / 是否高级 / 自动展开规则），
   * 取代旧的 legend 文字正则归类（GROUP_BY_LEGEND）；控件 id 与读写函数保持不变：
   * syncSettingsToForm / applyFormToSettings / syncAdvPanels / openSettingsGroup … 仍按 id 读写，
   * 因此这里只产标记、不建响应式值绑定（legacy 界面层直接改 value / classList）。
   * 分组面板（section.set-panel）由本组件按字段配置直接渲染，
   * 不再像旧实现那样按 legend 文字归类后再搬 DOM。
   *
   * 卡片外壳走 src/ui/ModalCard.svelte：头 / 身 / 脚与关闭钮全站只维护这一份，
   * 这里只交标题、关闭钮 id 和一段脚注（保存）。#btn-close-settings / #btn-save-settings
   * 仍由 src/app/main.js 按 id 绑定，所以两个 id 一个都不能少。 */
  import Icon from '../../ui/Icon.svelte';
  import ModalCard from '../../ui/ModalCard.svelte';
  import Inline from './Inline.svelte';
  import Node from './Node.svelte';
  import { GROUPS, BASE_URL_OPTIONS } from './settingsForm.js';
</script>

{#snippet foot()}
  <button id="btn-save-settings" class="ui-btn primary" type="button">保存</button>
{/snippet}

<ModalCard title="设置" closeId="btn-close-settings" footer={foot}>
  <datalist id="dl-base-url">
    {#each BASE_URL_OPTIONS as opt}<option value={opt[0]}>{opt[1]}</option>{/each}
  </datalist>

  <!-- 接入状态行：接入向导入口（随时重走）+ 聚合模式常驻警示徽章（一键切回直连） -->
  <div class="conn-row">
    <button id="btn-open-connect" class="ui-btn mini" type="button">接入向导</button>
    <div id="conn-badge" class="conn-badge hidden">
      <span id="conn-badge-text"></span>
      <button id="btn-conn-direct" class="ui-btn mini" type="button">切回直连</button>
    </div>
  </div>

  <div class="set-shell" id="set-shell">
    <nav class="set-nav" id="set-nav" aria-label="设置分组">
      {#each GROUPS as g}
        <button type="button" class="set-nav-item" data-group={g.id}><span>{g.title}</span><Icon name="chev" /></button>
      {/each}
    </nav>
    <div class="set-panels" id="set-panels" data-impl="svelte">
      <button type="button" id="set-back" class="ui-btn ghost set-back hidden"><Icon name="back" class="ic-l" />返回</button>
      {#each GROUPS as g}
        <section class="set-panel" data-group={g.id}>
          <h3 class="set-panel-title">{g.title}</h3>
          {#each g.blocks as b}
            {#if b.danger}
              <div class="danger-row">
                {#each b.nodes as n}<Node node={n} />{/each}
              </div>
            {:else}
              <fieldset id={b.id || null}>
                <legend>{b.legend}</legend>
                {#if b.sub}<p class="set-sub"><Inline html={b.sub} /></p>{/if}
                {#each b.nodes as n}<Node node={n} />{/each}
              </fieldset>
            {/if}
          {/each}
        </section>
      {/each}
    </div>
  </div>
</ModalCard>

<style>
  /* 接入状态行：向导入口 + 聚合模式琥珀色警示徽章（.hidden 是全局 !important，照样藏得住） */
  .conn-row {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .conn-badge {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 5px 12px;
    border: 1px solid var(--warn-line);
    border-radius: 999px;
    background: var(--warn-soft);
    color: var(--warn);
    font-family: var(--font-ui);
    font-size: 12.5px;
    line-height: 1.7;
  }
</style>
