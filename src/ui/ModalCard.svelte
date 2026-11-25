<script>
  /* ModalCard.svelte —— 弹窗卡片骨架：头 / 身 / 脚 + 关闭（全站只此一份）
   *
   * 结构刻意与迁移前的 .modal-card 一致（modal-head / modal-body / modal-foot 三个全局类），
   * 样式全部来自 css/overlays.css 与 css/settings.css —— 组件只产标记，不写第二份配色，
   * 所以窄屏底部弹层规则（#modal-new / #modal-export）与设置页的定高卡片都原样生效。
   *
   * 之前这套骨架散在各弹窗内部的 Card.svelte 与设置屏里，
   * 现在统一到这一份（含头 / 身 / 脚与关闭钮）。
   * 「遮罩 / 层级 / 焦点 / 开合过渡」不归本组件：那是 index.html 的 .modal 容器与
   * src/ui/modalHost.js 的弹窗栈。
   *
   * 索引 / 关闭钮的 id 由各调用方传进来：legacy 界面层按 id 绑定，一个都不能少；
   * 不传 closeId 就不画关闭钮（当前 12 个弹窗都传）。
   * onclose 只给「关闭动作就在组件里」的弹窗用（导出 / 开局向导 / 接入向导）；其余仍由 src/app/main.js
   * 按 #btn-close-* 绑 onclick，因此这里必须允许 onclose 为空。 */
  import IconButton from './IconButton.svelte';

  let {
    title = '',
    titleId = null,
    closeId = null,
    onclose = undefined,
    narrow = false,
    children,
    footer = null,
  } = $props();
</script>

<div class="modal-card" class:narrow>
  <div class="modal-head">
    <h2 id={titleId}>{title}</h2>
    {#if closeId}
      <IconButton id={closeId} icon="x" label="关闭" onclick={onclose} />
    {/if}
  </div>
  <div class="modal-body">
    {@render children?.()}
  </div>
  {#if footer}
    <div class="modal-foot">{@render footer()}</div>
  {/if}
</div>
