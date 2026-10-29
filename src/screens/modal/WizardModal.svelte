<script>
  /* WizardModal.svelte —— #modal-wizard「开局设定」（屏 6b 重建，剧情模式的开局向导）
   * 行为仍在 src/app/wizard.js：openWizard 往里灌 prefill、draftWizard 起草、startFromWizard 建新档，
   * 全部按 id 读写；这里只把标记换成组件库（Field / TextInput / 本目录的 Textarea / Button）。
   * 人物行是唯一走状态桥的部分（见 CharRows.svelte / state.svelte.js）：
   * wizard.js 的 wzChars() 在 Svelte 形态下取 ModalScreens.chars('wizard')。
   * 取消 / 关闭额外挂一次 closeModal：0.12.1 这两个钮是直接 classList.add('hidden')，
   * 会把记录留在弹窗栈里（6a 清单里的遗留），这里借重建顺手收口；app.js 的旧绑定
   * 随后再执行一次 hidden 也无害（关过一次的弹窗 class 已经对了）。 */
  import Card from './Card.svelte';
  import Field from '../../ui/Field.svelte';
  import TextInput from '../../ui/TextInput.svelte';
  import Button from '../../ui/Button.svelte';
  import Textarea from './Textarea.svelte';
  import CharRows from './CharRows.svelte';
  import { closeModal } from '../../ui/modalHost.js';

  const close = () => closeModal('modal-wizard');
</script>

{#snippet foot()}
  <Button id="btn-wz-cancel" variant="ghost" onclick={close}>取消</Button>
  <Button id="btn-wz-start" variant="primary">开始故事</Button>
{/snippet}

<Card title="开局设定" closeId="btn-close-wizard" onclose={close} footer={foot}>
  <div class="draft-row">
    <div class="draft-field">
      <Field label="一句话让 AI 起草" for="wz-draft-input">
        <TextInput id="wz-draft-input" placeholder="例如：雨夜便利店里的十年之约" />
      </Field>
    </div>
    <Button id="btn-wz-draft" icon="pencil"><span id="wz-draft-label">起草</span></Button>
  </div>
  <p class="hint" id="wz-draft-hint"></p>

  <Field label="世界观" for="wz-world">
    <Textarea id="wz-world" rows={3} placeholder="时代、地点、规则、气氛……" spellcheck="false" />
  </Field>

  <div class="char-editor">
    <p class="char-title">主要人物（每人一行：姓名 / 性格 / 说话方式）</p>
    <CharRows kind="wizard" rowsId="wz-characters" addId="btn-wz-char-add" />
  </div>

  <Field label="你的角色" for="wz-role">
    <Textarea id="wz-role" rows={2} placeholder="你是谁、从哪来、想做什么……" spellcheck="false" />
  </Field>

  <Field label="风格基调（画面与文字的调子，之后用于试画锚定）" for="wz-style">
    <TextInput id="wz-style" placeholder="克制的悬疑，冷色，雨夜霓虹" />
  </Field>

  <Field label="想看的发展（可选）" for="wz-development">
    <Textarea id="wz-development" rows={2} placeholder="你希望故事朝哪个方向走……" spellcheck="false" />
  </Field>
</Card>

<style>
  .draft-field { flex: 1 1 auto; min-width: 0; }
  .draft-field :global(.field) { margin-bottom: 0; }
  .char-editor { margin-bottom: 12px; }
  .char-title {
    font-family: var(--font-ui);
    font-size: 12.5px;
    color: var(--ink-dim);
    letter-spacing: .05em;
    margin-bottom: 6px;
  }
</style>
