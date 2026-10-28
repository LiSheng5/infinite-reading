<script>
  /* EmailModal.svelte —— #modal-email「写邮件」（屏 6c 重建）
   * 只展示本地服务策略，前端不做收件人 / 白名单校验：白名单、每日上限、审计都由
   * sidecar 在代码层强制（js/app/features.js 的 openEmailModal / doEmailSend）。
   * 状态行（#email-status）与待确认草稿（#email-drafts，legacy 逐条 append 并带「确认发送 / 丢弃」）
   * 都由 features.js 维护；组件只给容器。发送钮 handler 在 js/app.js（A.doEmailSend），不重复挂。
   */
  import Card from './Card.svelte';
  import Field from '../../ui/Field.svelte';
  import TextInput from '../../ui/TextInput.svelte';
  import Button from '../../ui/Button.svelte';
  import Textarea from './Textarea.svelte';
</script>

{#snippet foot()}
  <Button id="btn-em-send" variant="primary">发送</Button>
{/snippet}

<Card title="写邮件" closeId="btn-close-email" footer={foot}>
  <p class="hint" id="email-status"></p>

  <Field label="收件人" for="em-to">
    <TextInput id="em-to" spellcheck="false" placeholder="buddy@example.com" />
  </Field>
  <Field label="主题" for="em-subject">
    <TextInput id="em-subject" />
  </Field>
  <Field label="正文" for="em-body">
    <Textarea id="em-body" rows={6} />
  </Field>

  <p class="hint">不在白名单里的收件人只会先生成草稿，需要你确认后才会真正发出。</p>

  <details class="panel-block">
    <summary>待确认草稿</summary>
    <div id="email-drafts" class="mono-list"></div>
  </details>
</Card>
