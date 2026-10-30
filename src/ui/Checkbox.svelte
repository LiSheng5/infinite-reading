<script>
  /* Checkbox.svelte —— 勾选项（阶段 3 组件库）
   * 值双向绑定：bind:checked；label 为纯文本（用户内容不做 HTML 解释）。 */
  let {
    checked = $bindable(false),
    label = '',
    id = null,
    disabled = false,
    class: cls = '',
    ...rest
  } = $props();
</script>

<label class={['ui-check', cls].filter(Boolean).join(' ')}>
  <input {id} type="checkbox" {disabled} bind:checked {...rest} />
  {#if label}<span>{label}</span>{/if}
</label>

<style>
  label {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-family: var(--font-ui);
    font-size: 13.5px;
    color: var(--ink);
    cursor: pointer;
    margin-bottom: 9px;
    line-height: 1.8;
  }
  input {
    width: auto;
    margin: 5px 0 0;
    flex: 0 0 auto;
    accent-color: var(--accent);
  }
  label:has(input:disabled) { opacity: .45; cursor: not-allowed; }
</style>
