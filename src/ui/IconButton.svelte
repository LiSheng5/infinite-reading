<script>
  /* IconButton.svelte —— 纯图标按钮（阶段 3 组件库）
   * label 必填：既当 aria-label / title，也当无障碍兜底；可点目标 40×40（§7.2 触屏下限）。 */
  import Icon from './Icon.svelte';

  let {
    icon,
    label,
    type = 'button',
    disabled = false,
    variant = 'quiet',
    onclick = undefined,
    class: cls = '',
    ...rest
  } = $props();
</script>

<button
  class={['icon-btn', variant, cls].filter(Boolean).join(' ')}
  {type}
  {disabled}
  aria-label={label}
  title={label}
  {onclick}
  {...rest}
>
  <Icon name={icon} />
</button>

<style>
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;              /* 触屏可点目标 ≥ 40px */
    padding: 0;
    color: var(--ink-dim);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius);
    cursor: pointer;
    transition:
      color var(--m-t-color-fast) var(--ease-out),
      border-color var(--m-t-color-fast) var(--ease-out),
      background-color var(--m-t-color-fast) var(--ease-out);
  }
  button:hover { color: var(--ink); border-color: var(--line); background: var(--hover-tint); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  button.bordered { border-color: var(--line-strong); }
  button.bordered:hover { color: var(--ink); border-color: var(--accent-line); background: var(--accent-soft); }

  button.danger { color: var(--danger); }
  button.danger:hover { background: var(--danger-soft); border-color: var(--danger-line); }

  button:disabled { opacity: .4; cursor: not-allowed; }
</style>
