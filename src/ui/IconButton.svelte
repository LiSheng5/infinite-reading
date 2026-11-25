<script>
 /* IconButton.svelte —— 纯图标按钮（组件库）
   * label 必填：既当 aria-label / title，也当无障碍兜底；可点目标 40×40（触屏下限）。
   * 外观是 .ui-btn 的 .icon-only 修饰类（css/base.css），组件内不再写第二份样式。
   * 不提供 variant：没有对应样式规则，传了也只是多一个空类名。 */
  import Icon from './Icon.svelte';

  let {
    icon,
    label,
    type = 'button',
    disabled = false,
    onclick = undefined,
    class: cls = '',
    ...rest
  } = $props();
</script>

<button
  class={['ui-btn', 'icon-only', cls].filter(Boolean).join(' ')}
  {type}
  {disabled}
  aria-label={label}
  title={label}
  {onclick}
  {...rest}
>
  <Icon name={icon} />
</button>
