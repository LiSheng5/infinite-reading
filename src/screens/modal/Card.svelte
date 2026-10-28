<script>
  /* Card.svelte —— 弹窗卡片骨架（屏 6b 内部复用，不是新组件库成员）
   * 结构刻意与 0.12.1 的 .modal-card 一致（modal-head / modal-body / modal-foot 三个全局类），
   * 这样 css/style.css 里已有一整套弹窗样式、窄屏底部弹层规则（#modal-new / #modal-export）
   * 都原样生效——6b 换的是「内容怎么产」，不是「弹窗长什么样」。
   * 索引 / 关闭钮的 id 由各弹窗传进来：legacy 界面层按 id 绑定，一个都不能少。 */
  import IconButton from '../../ui/IconButton.svelte';

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
