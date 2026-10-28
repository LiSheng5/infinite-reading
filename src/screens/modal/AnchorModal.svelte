<script>
  /* AnchorModal.svelte —— #modal-anchor「锚定画风」（屏 6c 重建）
   * 两步：挑候选（#anchor-step-pick）→ 改设定卡（#anchor-step-card）。
   * 步骤显隐、候选网格内容、卡表单回填 / 读取都由 js/app/styleanchor.js 直接操作：
   *   #anchor-grid 是候选卡容器（legacy 逐个 createElement + onclick），组件只给空容器；
   *   #anchor-step-* 的 hidden 由 openAnchor / anchorDraftCard / #btn-anchor-back 切换；
   *   #btn-anchor-use 的 disabled 与文案由 setAnchorBusy / anchorDraftCard 改。
   * 所有按钮的 handler 都在 js/app.js；这里一个都不挂（否则双触发一次开锚定 / 锁定）。
   */
  import Card from './Card.svelte';
  import Field from '../../ui/Field.svelte';
  import TextInput from '../../ui/TextInput.svelte';
  import Button from '../../ui/Button.svelte';
  import Textarea from './Textarea.svelte';
</script>

<Card title="锚定画风" closeId="btn-close-anchor">
  <p class="hint" id="anchor-intro"></p>

  <div id="anchor-step-pick">
    <div id="anchor-grid" class="anchor-grid"></div>
    <div class="row-inline">
      <Button id="btn-anchor-more" icon="redo">再试一批</Button>
      <Button id="btn-anchor-skip" variant="ghost">跳过，自由发挥</Button>
      <Button id="btn-anchor-use" variant="primary" disabled>用这张定画风</Button>
    </div>
    <p class="hint">4 张候选按你设置的比例试画；选定后画师会起草一张视觉设定卡，之后每张画都带着它。</p>
  </div>

  <div id="anchor-step-card" class="hidden">
    <div class="ac-top">
      <img id="anchor-card-preview" class="anchor-preview" alt="" />
      <p class="hint" id="ac-picked-kw"></p>
    </div>
    <Field label="画风关键词（英文，逗号分隔）" for="ac-keywords">
      <TextInput id="ac-keywords" spellcheck="false" />
    </Field>
    <div class="grid2">
      <Field label="媒介" for="ac-medium">
        <TextInput id="ac-medium" spellcheck="false" />
      </Field>
      <Field label="色板" for="ac-palette">
        <TextInput id="ac-palette" spellcheck="false" />
      </Field>
    </div>
    <Field label="人物设定（名字｜英文外貌｜服饰｜特征，每行一个）" for="ac-characters">
      <Textarea id="ac-characters" rows={3} spellcheck="false" />
    </Field>
    <div class="grid2">
      <Field label="负面提示词" for="ac-negative">
        <TextInput id="ac-negative" spellcheck="false" />
      </Field>
      <Field label="备注" for="ac-note">
        <TextInput id="ac-note" spellcheck="false" />
      </Field>
    </div>
    <fieldset>
      <legend>跟画师说着改（例如「更冷一些」「人物更接近水彩」）</legend>
      <div class="input-row">
        <div class="grow">
          <TextInput id="ac-chat" placeholder="说说你想怎么调" autocomplete="off" />
        </div>
        <Button id="btn-anchor-chat">发送</Button>
      </div>
      <p class="hint" id="ac-status"></p>
    </fieldset>
    <div class="row-inline">
      <Button id="btn-anchor-back" variant="ghost" icon="back">重选</Button>
      <Button id="btn-anchor-lock" variant="primary">锁定这张卡</Button>
      <span class="hint">锁定后记入版本；每张图都会带上它</span>
    </div>
  </div>
</Card>

<style>
  .grow { flex: 1 1 auto; min-width: 0; }
</style>
