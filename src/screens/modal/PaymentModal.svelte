<script>
  /* PaymentModal.svelte —— #modal-payment「代为下单」（屏 6c 重建）
   * 只展示本地服务策略，前端不做金额 / 额度校验：额度、冷静期、商户与品类黑白名单
   * 全部由 sidecar 在代码层强制（js/app/features.js 的 openPaymentModal / doPaymentSubmit）。
   * 结果行（#pm-result）由 doPaymentSubmit 写 textContent；提交钮 handler 在 js/app.js，不重复挂。
   */
  import Card from './Card.svelte';
  import Field from '../../ui/Field.svelte';
  import TextInput from '../../ui/TextInput.svelte';
  import Button from '../../ui/Button.svelte';
</script>

{#snippet foot()}
  <Button id="btn-pm-submit" variant="primary">提交购买意图</Button>
{/snippet}

<Card title="代为下单" closeId="btn-close-payment" footer={foot}>
  <p class="hint" id="pay-status"></p>

  <div class="grid2">
    <Field label="金额（分）" for="pm-amount">
      <TextInput id="pm-amount" type="number" min="1" step="1" placeholder="例如 1999 = 19.99 元" />
    </Field>
    <Field label="商户" for="pm-merchant">
      <TextInput id="pm-merchant" placeholder="例如 某某书店" />
    </Field>
  </div>
  <div class="grid2">
    <Field label="品类" for="pm-category">
      <TextInput id="pm-category" placeholder="例如 图书" />
    </Field>
    <Field label="商品描述（可选）" for="pm-items">
      <TextInput id="pm-items" placeholder="书名 x1" />
    </Field>
  </div>

  <div id="pm-result" class="pay-result"></div>
</Card>
