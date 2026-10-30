<script>
  /* Collapse.svelte —— 折叠块（阶段 3 组件库）
   * 高级参数 / 长说明 /「单独配置」默认折叠，摘要行右侧带状态标签
   * （如「沿用剧情模型」/「已单独配置」/「未启用」）；是否自动展开由使用方决定后写 open。
   * open 双向绑定。展开内容只做单次淡入位移（--an-leafIn，档位由动效模块收口），
   * 高度不参与过渡（transition 不动 height / max-height，tokens-test 硬禁令）。 */
  import Icon from './Icon.svelte';

  let {
    summary,
    status = '',
    open = $bindable(false),
    onToggle = undefined,
    children,
    class: cls = '',
  } = $props();

  function toggle() {
    open = !open;
    if (onToggle) onToggle(open);
  }
</script>

<div class={['ui-collapse', cls].filter(Boolean).join(' ')}>
  <button type="button" class="ui-collapse-head" aria-expanded={open} onclick={toggle}>
    <Icon name="chev" class={open ? 'chev-open' : ''} />
    <span class="summary">{summary}</span>
    {#if status}
      <span class="status">{status}</span>
    {/if}
  </button>
  {#if open}
    <div class="ui-collapse-body">
      {@render children?.()}
    </div>
  {/if}
</div>

<style>
  .ui-collapse {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--fieldset-tint);
    margin-bottom: 12px;
  }
  .ui-collapse-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 40px;              /* 触屏可点目标 ≥ 40px */
    padding: 8px 12px;
    font-family: var(--font-ui);
    font-size: 13px;
    letter-spacing: .04em;
    color: var(--ink);
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
    text-align: left;
  }
  .ui-collapse-head :global(svg) {
    transition: transform var(--m-t-shift-fast) var(--ease-out);
  }
  .ui-collapse-head :global(svg.chev-open) {
    transform: rotate(90deg);
  }
  .summary {
    flex: 1;
    min-width: 0;
  }
  .status {
    flex: none;
    font-size: 11.5px;
    color: var(--accent);
    background: var(--accent-soft);
    border-radius: 999px;
    padding: 2px 10px;
  }
  .ui-collapse-body {
    padding: 4px 12px 12px;
    animation: var(--an-leafIn) var(--m-dur-fast) var(--ease-out) both;
  }
</style>
