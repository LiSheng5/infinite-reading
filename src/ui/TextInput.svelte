<script>
  /* TextInput.svelte —— 单行输入（阶段 3 组件库）
   * 值双向绑定：bind:value。其余原生属性透传（type / name / placeholder / autocomplete …）。
   * 用户内容一律走 value 文本渲染，不经 {@html}（安全红线）。 */
  let {
    value = $bindable(''),
    type = 'text',
    id = null,
    placeholder = '',
    disabled = false,
    class: cls = '',
    ...rest
  } = $props();
</script>

<input
  class={cls ? 'input ' + cls : 'input'}
  {type}
  {id}
  {placeholder}
  {disabled}
  bind:value
  {...rest}
/>

<style>
  input {
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
    min-height: 40px;           /* 触屏可点目标 ≥ 40px */
    outline: none;
    transition: border-color var(--m-t-color-base) var(--ease-out);
  }
  input:focus {
    border-color: var(--accent-line);
    box-shadow: var(--field-inset), 0 0 0 3px var(--accent-soft);
  }
  input:disabled { opacity: .45; }
</style>
