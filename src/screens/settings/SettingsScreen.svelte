<script>
  /* 阶段 4 屏 2 · 设置屏（Svelte 5 重写，任务书 §7.2）
   * 界面由 settingsForm.js 的字段配置生成（id / 标签 / 类型 / 分组 / 是否高级 / 自动展开规则），
   * 取代 0.12.1 的 legend 文字正则归类（GROUP_BY_LEGEND）。行为零改动：
   * syncSettingsToForm / applyFormToSettings / syncAdvPanels / openSettingsGroup … 仍按 id 读写，
   * 因此这里只产标记、不建响应式值绑定（legacy 界面层直接改 value / classList）。
   * 分组面板（section.set-panel）按配置直接落位，src/app/prefsui.js 的 initSettingsNav
   * 分组面板由本组件按字段配置直接渲染（不再按 legend 归类搬 DOM）。 */
  import Icon from '../../ui/Icon.svelte';
  import Inline from './Inline.svelte';
  import Node from './Node.svelte';
  import { GROUPS, BASE_URL_OPTIONS } from './settingsForm.js';
</script>

<div class="modal-card">
  <div class="modal-head">
    <h2>设置</h2>
    <button id="btn-close-settings" class="hud-btn" title="关闭" aria-label="关闭"><Icon name="x" /></button>
  </div>
  <div class="modal-body">
    <datalist id="dl-base-url">
      {#each BASE_URL_OPTIONS as opt}<option value={opt[0]}>{opt[1]}</option>{/each}
    </datalist>

    <div class="set-shell" id="set-shell">
      <nav class="set-nav" id="set-nav" aria-label="设置分组">
        {#each GROUPS as g}
          <button type="button" class="set-nav-item" data-group={g.id}><span>{g.title}</span><Icon name="chev" /></button>
        {/each}
      </nav>
      <div class="set-panels" id="set-panels" data-impl="svelte">
        <button type="button" id="set-back" class="btn ghost set-back hidden"><Icon name="back" class="ic-l" />返回</button>
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
  </div>
  <div class="modal-foot">
    <button id="btn-save-settings" class="btn primary" type="button">保存</button>
  </div>
</div>
