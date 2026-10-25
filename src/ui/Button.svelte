<script>
  /* Button.svelte —— 通用按钮（阶段 3 组件库）
   * 视觉语言沿用 css/style.css 的 .btn：扁平细边、唯一实心是黑底主按钮（蓝不填主按钮）；
   * variant: default | primary | ghost | danger；size: md | slim。
   * 过渡时长走动效模块的档位变量（--m-t-*），off 档自动收成即时 / 80ms 透明度。 */
  import Icon from './Icon.svelte';

  let {
    variant = 'default',
    size = 'md',
    icon = null,
    iconSide = 'left',
    type = 'button',
    disabled = false,
    title = null,
    onclick = undefined,
    class: cls = '',
    children,
    ...rest
  } = $props();
</script>

<button
  class={['ui-btn', variant !== 'default' ? variant : '', size === 'slim' ? 'slim' : '', cls].filter(Boolean).join(' ')}
  {type}
  {disabled}
  {title}
  {onclick}
  {...rest}
>
  {#if icon && iconSide === 'left'}<Icon name={icon} />{/if}
  {@render children?.()}
  {#if icon && iconSide === 'right'}<Icon name={icon} />{/if}
</button>

<style>
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    font-family: var(--font-ui);
    font-weight: 500;
    font-size: 14px;
    letter-spacing: .04em;
    color: var(--ink);
    background: transparent;
    border: 1px solid var(--btn-line);
    border-radius: var(--radius);
    padding: 9px 18px;
    min-height: 40px;           /* 触屏可点目标 ≥ 40px（§7.2） */
    cursor: pointer;
    box-shadow: none;
    transition:
      color var(--m-t-color-fast) var(--ease-out),
      border-color var(--m-t-color-fast) var(--ease-out),
      background-color var(--m-t-color-fast) var(--ease-out),
      transform var(--m-t-shift-fast) var(--ease-out);
  }
  button:hover {
    color: var(--ink);
    border-color: var(--accent);
    background: var(--accent-soft);
    transform: translateY(-1px);
  }
  button:active { transform: scale(.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* 唯一实心：主操作——黑底白字（--ink / --on-ink） */
  button.primary {
    background: var(--ink);
    color: var(--on-ink);
    border-color: var(--ink);
    font-weight: 600;
    letter-spacing: .08em;
  }
  button.primary:hover {
    background: var(--ink-hover);
    border-color: var(--ink-hover);
    color: var(--on-ink);
    transform: none;
  }
  button.primary:active { transform: scale(.97); }

  button.ghost { background: transparent; border-color: var(--line); color: var(--ink-dim); }
  button.ghost:hover { background: transparent; color: var(--accent); border-color: var(--accent-line); transform: none; }

  button.danger { color: var(--danger); border-color: var(--danger-line); background: transparent; }
  button.danger:hover { background: var(--danger-soft); border-color: var(--danger); color: var(--danger); transform: none; }

  button.slim { padding: 6px 14px; font-size: 13px; min-height: 32px; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  button:disabled:hover { transform: none; background: transparent; border-color: var(--btn-line); color: var(--ink); }
  button:disabled.primary:hover { background: var(--ink); border-color: var(--ink); color: var(--on-ink); }
</style>
