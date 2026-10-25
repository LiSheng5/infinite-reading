<script>
  /* Field.svelte —— 表单字段容器（阶段 3 组件库）
   * 一行副标题（hint），长说明由屏幕层放「填写说明」（§7.2：字段间不夹长段文字）。
   * 控件放在 children 里；id 由使用方传给控件并回传给本组件（label for 对齐）。 */
  let { label = '', hint = '', for: forId = null, error = '', children } = $props();
</script>

<div class="field">
  {#if label}
    <label class="field-label" for={forId}>{label}</label>
  {/if}
  {@render children?.()}
  {#if error}
    <p class="field-hint error">{error}</p>
  {:else if hint}
    <p class="field-hint">{hint}</p>
  {/if}
</div>

<style>
  .field { margin-bottom: 12px; }
  .field-label {
    display: block;
    font-family: var(--font-ui);
    font-size: 12.5px;
    color: var(--ink-dim);
    letter-spacing: .05em;
    margin-bottom: 6px;
  }
  .field-hint {
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--ink-faint);
    line-height: 1.9;
    margin-top: 6px;
  }
  .field-hint.error { color: var(--danger); }
</style>
