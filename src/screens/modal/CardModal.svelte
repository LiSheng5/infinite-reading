<script>
  /* CardModal.svelte —— #modal-card「角色卡」（屏 6c 重建）
   * 统一编辑器：自建空白表单 / 导入 SillyTavern V2/V3 PNG 后编辑。
   * 表单一律由 src/app/cards.js 按 id 灌值（fillCardForm）与读取（readCardForm）；
   * 标题（#card-modal-title）、来源提示（#card-source-hint）、保存钮文案（#btn-rc-save）
   * 也会被 openCardEditor 改写——所以标题与按钮只放纯文本子节点。
   * 取消 / 保存 / 关闭 / 导入的 handler 都在 src/app/main.js（cards.js），组件不挂。
   */
  import Card from '../../ui/ModalCard.svelte';
  import Field from '../../ui/Field.svelte';
  import TextInput from '../../ui/TextInput.svelte';
  import Checkbox from '../../ui/Checkbox.svelte';
  import Button from '../../ui/Button.svelte';
  import Textarea from './Textarea.svelte';
</script>

{#snippet foot()}
  <Button id="btn-rc-cancel" variant="ghost">取消</Button>
  <Button id="btn-rc-save" variant="primary">保存角色卡</Button>
{/snippet}

<Card title="角色卡" titleId="card-modal-title" closeId="btn-close-card" footer={foot}>
  <p class="hint" id="card-source-hint"></p>

  <div class="grid2">
    <Field label="名字" for="rc-name">
      <TextInput id="rc-name" spellcheck="false" placeholder="例如：周叙" />
    </Field>
    <Field label="外貌" for="rc-appearance">
      <TextInput id="rc-appearance" spellcheck="false" placeholder="一两句；会给画师当参考" />
    </Field>
  </div>

  <Field label="性格" for="rc-personality">
    <Textarea id="rc-personality" rows={2} spellcheck="false" placeholder="话里有话、克制……" />
  </Field>
  <Field label="场景（你们在哪、什么情况）" for="rc-scene">
    <Textarea id="rc-scene" rows={2} spellcheck="false" placeholder="凌晨的便利店，雨声很大……" />
  </Field>
  <Field label="开场白（扮演开局的第一条旁白，由角色卡写）" for="rc-opening">
    <Textarea id="rc-opening" rows={3} spellcheck="false" placeholder="「这么晚还来买东西？」" />
  </Field>
  <Field label="示例对话（喂给模型学口吻，不照抄内容）" for="rc-example">
    <Textarea id="rc-example" rows={3} spellcheck="false" placeholder={'{{char}}: 「挑便宜的就走。」'} />
  </Field>
  <Field label="系统提示（这张卡自带的设定要求，可选）" for="rc-note">
    <TextInput id="rc-note" spellcheck="false" />
  </Field>

  <Checkbox id="rc-sync-world" checked label="同时初始化世界卡人物条目（性格 / 说话方式对接）" />

  <p class="hint">导入的是你自己的卡：只兼容 SillyTavern V2/V3 的 PNG 内嵌 JSON 格式，不复制任何代码与内容。</p>
  <div class="row-inline">
    <Button id="btn-rc-import" size="slim" icon="up">选择 PNG 卡</Button>
  </div>
</Card>
