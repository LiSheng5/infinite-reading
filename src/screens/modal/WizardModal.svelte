<script>
 /* WizardModal.svelte —— #modal-wizard「新故事 · 剧情」（剧情模式的开局向导）
   * 行为仍在 src/app/wizard.js：openWizard 往里灌 prefill、draftWizard 起草、startFromWizard 建新档，
   * 全部按 id 读写；这里只把标记换成组件库（Field / TextInput / 本目录的 Textarea / Button）。
   * 人物行是唯一走状态桥的部分（见 CharRows.svelte / state.svelte.js）：
   * wizard.js 的 wzChars() 在 Svelte 形态下取 state.svelte.js 的 charApi('wizard')。
   * 骨架（三模式同一套）：标题 + 一句话说明 → 主操作 → 折叠的「更多设定（可选）」→ 底部固定主按钮。
   * 可选块里的字段 id（wz-characters / wz-style / wz-development）始终在 DOM 里，
   * details 收起不影响 startFromWizard 读取；起草提示、必填红字、折叠摘要由 wizard.js 就地改写。
   * 取消 / 关闭统一走 closeModal：旧实现直接 classList.add('hidden')，会把弹窗留在栈里；
   * 这里借重建收口，界面层只绑开局与起草按钮，不再有第二处 hidden 绑定。 */
  import Card from '../../ui/ModalCard.svelte';
  import Field from '../../ui/Field.svelte';
  import TextInput from '../../ui/TextInput.svelte';
  import Button from '../../ui/Button.svelte';
  import Textarea from './Textarea.svelte';
  import CharRows from './CharRows.svelte';
  import { closeModal } from '../../ui/modalHost.js';
  import { A as appApi } from '../../app/core.js';

  const close = () => closeModal('modal-wizard');
</script>

{#snippet foot()}
  <Button id="btn-wz-cancel" variant="ghost" onclick={close}>取消</Button>
  <Button id="btn-wz-start" variant="primary">下一步：试画（可跳过）</Button>
{/snippet}

<Card title="新故事 · 剧情" closeId="btn-close-wizard" onclose={close} footer={foot}>
  <p class="hint wz-intro">先搭个舞台，故事从这里生长</p>

  <div class="draft-row">
    <div class="draft-field">
      <Field label="一句话起个头" for="wz-draft-input">
        <TextInput id="wz-draft-input" placeholder="例如：雨夜便利店里的十年之约" />
      </Field>
    </div>
    <Button id="btn-wz-draft" icon="pencil"><span id="wz-draft-label">起草</span></Button>
  </div>
  <div class="draft-status">
    <p class="hint" id="wz-draft-hint"></p>
    <Button id="btn-wz-connect" size="slim" class="hidden" onclick={() => appApi.openConnectWizard()}>去接入 →</Button>
    <Button id="btn-wz-undo" size="slim" class="hidden" onclick={() => appApi.undoDraft()}>撤销起草</Button>
  </div>

  <p class="hint hidden" id="wz-required-hint">至少填一点世界观、人物或你的角色吧</p>

  <Field label="世界观" for="wz-world">
    <Textarea id="wz-world" rows={3} placeholder="时代、地点、规则、气氛……" spellcheck="false" />
  </Field>

  <Field label="你的角色" for="wz-role">
    <Textarea id="wz-role" rows={2} placeholder="你是谁、从哪来、想做什么……" spellcheck="false" />
  </Field>

  <details id="wz-more" class="opt-fold">
    <summary>更多设定（可选）<span class="fold-sum" id="wz-more-sum">人物 · 风格 · 发展</span></summary>
    <div class="char-editor">
      <p class="char-title">主要人物（姓名 / 性格 / 说话方式）</p>
      <CharRows kind="wizard" rowsId="wz-characters" addId="btn-wz-char-add" variant="cards" />
    </div>

    <Field label="风格基调（画面与文字的调子，之后用于试画锚定）" for="wz-style">
      <TextInput id="wz-style" placeholder="克制的悬疑，冷色，雨夜霓虹" />
    </Field>

    <Field label="想看的发展" for="wz-development">
      <Textarea id="wz-development" rows={2} placeholder="你希望故事朝哪个方向走……" spellcheck="false" />
    </Field>
  </details>
</Card>

<style>
  .draft-field { flex: 1 1 auto; min-width: 0; }
  .draft-field :global(.field) { margin-bottom: 0; }
  .wz-intro { margin: 0 0 14px; }
  /* 起草结果行：提示文字 + 「去接入」「撤销起草」两个行内小按钮 */
  .draft-status { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  .draft-status .hint { margin: 0; flex: 1 1 auto; }
  #wz-required-hint { color: var(--danger); margin-bottom: 10px; }
</style>
