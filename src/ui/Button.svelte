<script>
  /* Button.svelte —— 通用按钮（阶段 3 组件库）
   * 视觉语言统一在 css/base.css 的 .ui-btn：扁平细边、唯一实心是黑底主按钮（蓝不填主按钮）；
   * variant: default | primary | ghost | danger；size: md | slim —— 都只是修饰类名，不在这里写第二份样式。
   * 本组件只保留「结构」：图标 + 文字一行居中、40px 触屏下限。
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
  /* 只写结构：配色 / 描边 / 圆角 / 悬停 / 禁用一律来自 .ui-btn 与修饰类 */
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 40px;           /* 触屏可点目标 ≥ 40px */
  }
  button.slim { min-height: 32px; }
</style>
