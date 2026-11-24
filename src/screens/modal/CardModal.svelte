<script>
 /* CardModal.svelte —— #modal-card「角色卡」（选卡 / 编辑两个视图）
  * 视图 A「选卡」：导入 PNG 卡（拖入或点选）/ 自己写一张——开局选卡、以及故事里还没有卡时先到这里；
  * 视图 B「编辑」：名字 + 开场白直给，其余折进「更多设定（可选）」。
  * 视图切换是组件内的 cardView 状态（state.svelte.js）：两块都常驻 DOM 只切 hidden，
  * 于是 main.js 启动时按 id 绑的 #btn-rc-import / #btn-rc-cancel / #btn-rc-save 不会因
  * 视图重建而丢监听，cards.js 也能照常按 id 灌值（fillCardForm / readCardForm）。
  * 表单一律由 src/app/cards.js 按 id 灌值与读取；标题（#card-modal-title）、
  * 来源提示（#card-source-hint）、保存钮文案（#btn-rc-save）由 openCardEditor / showCardView
  * 改写——所以标题与按钮只放纯文本子节点。
  * 点击行为走 A 注册表（writeCardFromScratch / showCardView / pickCardFile），组件不写业务。 */
  import Card from '../../ui/ModalCard.svelte';
  import Field from '../../ui/Field.svelte';
  import TextInput from '../../ui/TextInput.svelte';
  import Checkbox from '../../ui/Checkbox.svelte';
  import Button from '../../ui/Button.svelte';
  import Icon from '../../ui/Icon.svelte';
  import Textarea from './Textarea.svelte';
  import { cardView } from './state.svelte.js';
  import { A as appApi } from '../../app/core.js';

  const isPick = $derived(cardView.name === 'pick');

  // 拖放导入（桌面）：拖进来的不是 PNG 由 importCardFile 给一句话提示，不弹错误框
  function dropCard(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');
    appApi.importCardFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  }
</script>

{#snippet foot()}
  <!-- 选卡视图没有页脚（两个大卡就是入口）：按钮留在 DOM 保住 id 绑定，整条页脚由 hidden 收起 -->
  <div class="rc-foot-row" class:hidden={isPick}>
    <Button id="btn-rc-cancel" variant="ghost">取消</Button>
    <Button id="btn-rc-save" variant="primary">保存角色卡</Button>
  </div>
{/snippet}

<Card title="扮演" titleId="card-modal-title" closeId="btn-close-card" footer={foot}>
  <!-- 视图 A：选卡 -->
  <div id="rc-view-pick" class:hidden={!isPick}>
    <p class="hint rc-intro">以一张角色卡登场，玩的是关系</p>
    <div class="rc-pick-cards">
      <button type="button" class="mode-card" id="btn-rc-import"
        ondragover={e => { e.preventDefault(); e.currentTarget.classList.add('dragover'); }}
        ondragleave={e => e.currentTarget.classList.remove('dragover')}
        ondrop={dropCard}>
        <b><Icon name="up" />导入角色卡</b>
        <span>拖入或选择 PNG（兼容 SillyTavern V2/V3）</span>
      </button>
      <button type="button" class="mode-card" id="btn-rc-write" onclick={() => appApi.writeCardFromScratch()}>
        <b><Icon name="pencil" />自己写一张</b>
        <span>名字和开场白就能开演</span>
      </button>
    </div>
    <p class="hint">导入的是你自己的卡：只兼容 SillyTavern V2/V3 的 PNG 内嵌 JSON 格式，不复制任何代码与内容。</p>
  </div>

  <!-- 视图 B：编辑 -->
  <div id="rc-view-edit" class:hidden={isPick}>
    <Button id="btn-rc-back" size="slim" icon="back"
      class={isPick || !cardView.backable ? 'hidden' : ''}
      onclick={() => appApi.showCardView('pick')}>选卡</Button>

    <p class="hint" id="card-source-hint"></p>
    <p class="hint hidden" id="rc-required-hint">先给角色起个名字吧</p>

    <Field label="名字 *" for="rc-name">
      <TextInput id="rc-name" spellcheck="false" placeholder="例如：周叙" />
    </Field>
    <Field label="开场白（建议填）" for="rc-opening" hint="扮演开局的第一条旁白，由角色卡写">
      <Textarea id="rc-opening" rows={3} spellcheck="false" placeholder="「这么晚还来买东西？」" />
    </Field>

    <details id="rc-more" class="opt-fold">
      <summary>更多设定（可选）<span class="fold-sum" id="rc-more-sum">外貌 · 性格 · 场景 · 其他</span></summary>
      <Field label="外貌" for="rc-appearance">
        <TextInput id="rc-appearance" spellcheck="false" placeholder="一两句；会给画师当参考" />
      </Field>
      <Field label="性格" for="rc-personality">
        <Textarea id="rc-personality" rows={2} spellcheck="false" placeholder="话里有话、克制……" />
      </Field>
      <Field label="场景（你们在哪、什么情况）" for="rc-scene">
        <Textarea id="rc-scene" rows={2} spellcheck="false" placeholder="凌晨的便利店，雨声很大……" />
      </Field>
      <Field label="示例对话（喂给模型学口吻，不照抄内容）" for="rc-example">
        <Textarea id="rc-example" rows={3} spellcheck="false" placeholder={'{{char}}: 「挑便宜的就走。」'} />
      </Field>
      <Field label="系统提示（这张卡自带的设定要求，可选）" for="rc-note">
        <TextInput id="rc-note" spellcheck="false" />
      </Field>
      <Checkbox id="rc-sync-world" checked label="同时初始化世界卡人物条目（性格 / 说话方式对接）" />
    </details>

    <div class="rc-import-row">
      <Button id="btn-rc-reimport" size="slim" icon="up"
        title="导入 SillyTavern V2/V3 PNG 卡，读入后覆盖表单里的内容"
        onclick={() => appApi.pickCardFile()}>导入 PNG 卡</Button>
    </div>
  </div>
</Card>

<style>
  .rc-intro { margin: 0 0 14px; }
  #card-source-hint { margin-bottom: 12px; }   /* 来源提示与「名字」标签之间留一口气 */
  /* 选卡视图的两张入口卡：内容居中，观感像投放框（导入卡同时是拖放目标） */
  .rc-pick-cards { display: flex; flex-direction: column; gap: 14px; }
  .rc-pick-cards .mode-card {
    display: flex; flex-direction: column; align-items: center; gap: 7px;
    width: 100%; text-align: center; padding: 22px 20px;
  }
  .rc-pick-cards .mode-card b { display: flex; align-items: center; gap: 8px; margin-bottom: 0; }
  #rc-back { margin-bottom: 10px; }
  #rc-required-hint { color: var(--danger); margin-bottom: 10px; }
  .rc-import-row { margin-top: 14px; }
</style>
