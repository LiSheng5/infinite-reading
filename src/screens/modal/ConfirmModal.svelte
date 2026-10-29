<script>
  /* ConfirmModal.svelte —— #modal-confirm「通用确认 / 输入弹窗」（屏 6b 重建）
   * 替代原生 confirm / prompt（沙箱 iframe 里原生弹窗会被静默忽略）。
   * 内容全部由 src/app/core.js 的 irConfirm 在打开前写入（按 id），这里只保留稳定的骨架：
   *   #cf-title / #cf-message / #cf-input-wrap(.hidden) / #cf-input / #cf-check-wrap(.hidden)
   *   #cf-check / #cf-check-text / #cf-ok（文案会被换成「保存」等）
   * 确定 / 取消 / 关闭 / 回车 / 点遮罩仍由 src/app/main.js 的既有绑定收口（走 closeConfirm 收 Promise），
   * 所以本组件一个 handler 都不挂——挂了会重复 resolve。 */
  import Card from './Card.svelte';
  import TextInput from '../../ui/TextInput.svelte';
  import Button from '../../ui/Button.svelte';
</script>

{#snippet foot()}
  <Button id="cf-cancel" variant="ghost">取消</Button>
  <Button id="cf-ok" variant="primary">确定</Button>
{/snippet}

<Card title="确认" titleId="cf-title" closeId="btn-close-confirm" footer={foot}>
  <p id="cf-message"></p>
  <label id="cf-input-wrap" class="hidden">
    <TextInput id="cf-input" spellcheck="false" />
  </label>
  <label id="cf-check-wrap" class="check hidden">
    <input id="cf-check" type="checkbox" />
    <span id="cf-check-text">本次打开期间不再提示</span>
  </label>
</Card>
