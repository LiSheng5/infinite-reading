<script>
  /* PainterModal.svelte —— #modal-painter「画师工作台」（屏 6c 重建）
   * 行为全在 js/app/painter.js + js/app/video.js，按 legacy 的 id 读写：
   *   pw-preview / pw-alt / pw-prompt / pw-meta（renderWorkbench 灌值）
   *   pw-aspect / pw-width / pw-height / pw-size（pwParamsToForm / pwShowWh 双向读写）
   *   pw-thread（renderPainterThread 逐条 append）/ pw-video-list（renderWorkbenchVideo append）
   * 这三块动态面仍由 legacy 负责：组件只给一个空容器，Svelte 不管它的子节点，
   * 所以「清空 + 重新追加」的老写法不会和组件打架（与屏 2 设置屏的 mono-list 同一口径）。
   * 关闭按钮（btn-close-painter / btn-pw-close）由 js/app.js 绑到 A.closeWorkbench，
   * 这里不挂 handler——挂了会双触发一次 closeModal。
   */
  import Card from './Card.svelte';
  import Field from '../../ui/Field.svelte';
  import TextInput from '../../ui/TextInput.svelte';
  import Select from '../../ui/Select.svelte';
  import Button from '../../ui/Button.svelte';
  import Textarea from './Textarea.svelte';

  const ASPECTS = [
    { value: '16:9', label: '16:9 横屏' },
    { value: '9:16', label: '9:16 竖屏' },
    { value: '1:1', label: '1:1 方形' },
    { value: 'custom', label: '自定义' },
  ];
</script>

{#snippet foot()}
  <Button id="btn-pw-close">关闭</Button>
{/snippet}

<Card title="画师工作台" closeId="btn-close-painter" footer={foot}>
  <div class="pw-top">
    <img id="pw-preview" class="pw-preview" alt="" />
    <div class="pw-meta-col">
      <Field label="这张画的说明（alt）" for="pw-alt">
        <TextInput id="pw-alt" spellcheck="false" />
      </Field>
      <p class="hint" id="pw-meta"></p>
    </div>
  </div>

  <Field label="完整 prompt（发给生图模型的原话，可改）" for="pw-prompt">
    <Textarea id="pw-prompt" rows={4} spellcheck="false" />
  </Field>

  <div class="row-inline">
    <Button id="btn-pw-redraw" variant="primary">按此重画</Button>
    <Button id="btn-pw-force" title="把视觉设定卡的画风与人物设定压进这张图重画">按设定卡强制重画</Button>
    <Button id="btn-pw-reset" variant="ghost" icon="redo" title="丢掉手改，回到画师写的原稿">回到画师原稿</Button>
    <Button id="btn-pw-anchor" variant="ghost" title="重走「试画 4 张候选 → 定视觉设定卡」">锚定画风</Button>
    <span class="hint" id="pw-status"></span>
  </div>

  <fieldset>
    <legend>出图参数（与「模型设置 · 生图模型」同一份设置）</legend>
    <div class="grid2">
      <Field label="比例" for="pw-aspect">
        <Select id="pw-aspect" value="16:9" options={ASPECTS} />
      </Field>
      <Field label="本次尺寸" for="pw-size">
        <TextInput id="pw-size" readonly />
      </Field>
    </div>
    <div class="grid2" id="pw-row-wh">
      <Field label="宽" for="pw-width">
        <TextInput id="pw-width" type="number" min="64" step="16" />
      </Field>
      <Field label="高" for="pw-height">
        <TextInput id="pw-height" type="number" min="64" step="16" />
      </Field>
    </div>
    <p class="hint">改了这里，下一张图也用同样的尺寸；服务商只认固定档位时按报错提示调整。</p>
  </fieldset>

  <fieldset id="pw-video-area">
    <legend>视频（MiniMax · 会按秒计费）</legend>
    <Field label="动态提示词（留空 = 交画师构思，有内容 = 直出）" for="pw-video-prompt">
      <Textarea
        id="pw-video-prompt"
        rows={3}
        spellcheck="false"
        placeholder="留空：画师按这张图与最近剧情写「动起来的部分」；有内容：直接用这段提示词生成"
      />
    </Field>
    <div class="row-inline">
      <Button id="btn-pw-video" icon="film">以此图生视频</Button>
      <span class="hint">视频生成是独立的异步任务，不堵出图；进度看舞台左上的视频胶囊。</span>
    </div>
    <div id="pw-video-list" class="pw-video-list"></div>
  </fieldset>

  <fieldset>
    <legend>与画师对话（说「灯光暖一点」，它会改上面的 prompt）</legend>
    <div id="pw-thread" class="pw-thread"></div>
    <div class="input-row">
      <div class="grow">
        <TextInput id="pw-input" placeholder="例如：灯光暖一点 / 改成特写 / 雾气再重些" autocomplete="off" />
      </div>
      <Button id="btn-pw-send">发送</Button>
    </div>
    <p class="hint">画师子代理是隔离调用：只看这张图的提示词、画风锚与最近剧情，用完即弃，不污染剧情对话；线程随存档保留。</p>
  </fieldset>
</Card>

<style>
  .grow { flex: 1 1 auto; min-width: 0; }
  .pw-meta-col :global(.field) { margin-bottom: 8px; }
</style>
