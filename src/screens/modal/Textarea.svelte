<script>
  /* Textarea.svelte —— 多行输入（屏 6b 就地补齐；组件库只有单行的 TextInput）
   * 视觉与 src/ui/TextInput.svelte 同一套令牌与尺寸，只多 resize:vertical / line-height。
   * 值同样支持 bind:value；legacy 直接写 .value 也不会被覆盖（组件没有别的响应式来源）。 */
  let {
    value = $bindable(''),
    id = null,
    rows = 3,
    placeholder = '',
    disabled = false,
    class: cls = '',
    ...rest
  } = $props();
</script>

<textarea
  class={cls ? 'area ' + cls : 'area'}
  {id}
  {rows}
  {placeholder}
  {disabled}
  bind:value
  {...rest}
></textarea>

<style>
  textarea {
    display: block;
    width: 100%;
    font-family: var(--font-ui);
    font-size: 14px;
    line-height: 1.85;
    letter-spacing: .01em;
    color: var(--ink);
    background: var(--field-bg);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    padding: 8px 10px;
    outline: none;
    resize: vertical;
    transition: border-color var(--m-t-color-base) var(--ease-out);
  }
  textarea:focus {
    border-color: var(--accent-line);
    box-shadow: var(--field-inset), 0 0 0 3px var(--accent-soft);
  }
  textarea:disabled { opacity: .45; }
</style>
