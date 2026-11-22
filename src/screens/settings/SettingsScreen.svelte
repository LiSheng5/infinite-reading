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

  <!-- 接入状态行 / 聚合徽章不再游离在分组外面：都住进「剧情对话模型」块里（见 settingsForm.js），
       其它分组里不再出现与模型无关的入口 -->
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
            {:else if b.fold}
              <!-- 块级折叠（低频可选功能）：整块收成一行，标题旁「可选」小标签 + 状态标签。
                   自动展开 / 状态规则走 syncAdvPanels 的 data-auto / data-status（fold.auto / fold.on） -->
              <details class="adv opt-fold" id={b.id || null}
                data-auto={b.fold.auto || null} data-status={b.fold.on || null}
                data-tag-on={b.fold.tagOn || null} data-tag-off={b.fold.tagOff || null}>
                <summary>
                  <span class="adv-t">{b.legend}</span>
                  {#if b.opt}<span class="opt-tag">可选</span>{/if}
                  {#if b.fold.tagOn}<span class="adv-tag"></span>{/if}
                </summary>
                <div class="adv-body">
                  {#if b.sub}<p class="set-sub"><Inline html={b.sub} /></p>{/if}
                  {#each b.nodes as n}<Node node={n} />{/each}
                </div>
              </details>
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
