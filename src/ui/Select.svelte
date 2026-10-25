<script>
  /* Select.svelte —— 下拉选择（阶段 3 组件库）
   * options: [{ value, label }]；值双向绑定：bind:value。 */
  let {
    value = $bindable(''),
    options = [],
    id = null,
    disabled = false,
    class: cls = '',
    ...rest
  } = $props();
</script>

<select
  class={cls ? 'select ' + cls : 'select'}
  {id}
  {disabled}
  bind:value
  {...rest}
>
  {#each options as opt (opt.value)}
    <option value={opt.value}>{opt.label}</option>
  {/each}
</select>

<style>
  select {
    display: block;
    width: 100%;
    font-family: var(--font-ui);
    font-size: 14px;
    letter-spacing: .01em;
    color: var(--ink);
    background: var(--field-bg);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    padding: 8px 10px;
    min-height: 40px;           /* 触屏可点目标 ≥ 40px（§7.2） */
    outline: none;
    transition: border-color var(--m-t-color-base) var(--ease-out);
  }
  select:focus {
    border-color: var(--accent-line);
    box-shadow: var(--field-inset), 0 0 0 3px var(--accent-soft);
  }
  select:disabled { opacity: .45; }
</style>
