<script>
  /* ImportTextModal.svelte —— #modal-import-text「粘贴剧情文本导入」（屏 6b 重建）
   * 三步（粘贴 → 整理中 → 确认）仍由 js/app/importer.js 切 .hidden 控制：
   *   #it-step-paste / #it-step-run.hidden / #it-step-confirm.hidden
   * 所以三个容器只渲染一次、不写 class 表达式（避免 Svelte 重渲染把 legacy 的显隐打回去）。
   * 人物行同样走状态桥（kind = 'import'），与确认页的 itChars() 是同一份数据。 */
  import Card from './Card.svelte';
  import Field from '../../ui/Field.svelte';
  import TextInput from '../../ui/TextInput.svelte';
  import Select from '../../ui/Select.svelte';
  import Button from '../../ui/Button.svelte';
  import Textarea from './Textarea.svelte';
  import CharRows from './CharRows.svelte';

  const MODEL_OPTIONS = [
    { value: 'follow', label: '跟随剧情模型（默认）' },
    { value: 'draft', label: '起草模型（「模型设置」里单独配的那个）' },
  ];
</script>

{#snippet footPaste()}
  <Button id="btn-it-run" variant="primary" icon="pencil">开始整理</Button>
  <Button id="btn-it-cancel" variant="ghost">取消</Button>
{/snippet}

{#snippet footConfirm()}
  <Button id="btn-it-start" variant="primary">用它开局</Button>
  <Button id="btn-it-back" variant="ghost" icon="back">重新粘贴</Button>
{/snippet}

<Card title="粘贴剧情文本导入" closeId="btn-close-import-text">
  <div id="it-step-paste">
    <Field label="整理模型（用谁来把文本整理成故事设定）" for="it-model-mode">
      <Select id="it-model-mode" options={MODEL_OPTIONS} />
    </Field>

    <Field label="粘贴任意剧情文本（设定文 / 小说片段 / 别人游戏的聊天记录）" for="it-text">
      <Textarea id="it-text" rows={10} placeholder="把文本整段粘进来，点「开始整理」……" spellcheck="false" />
    </Field>

    <p class="hint" id="it-plan-hint"></p>
    <p class="hint">文本会原样发给上面选的模型；整理产物只在这里预览，你确认之后才会建新档。想单独指定一个便宜的整理模型：在「模型设置 · 起草模型」里填，然后这里选「起草模型」。</p>
    <div class="row-inline step-actions">{@render footPaste()}</div>
  </div>

  <div id="it-step-run" class="hidden">
    <p class="hint" id="it-run-info"></p>
    <p class="hint" id="it-status"></p>
  </div>

  <div id="it-step-confirm" class="hidden">
    <p class="hint" id="it-confirm-info"></p>

    <Field label="标题" for="it-title">
      <TextInput id="it-title" spellcheck="false" />
    </Field>

    <Field label="故事设定（进入对局后常驻）" for="it-premise">
      <Textarea id="it-premise" rows={6} spellcheck="false" />
    </Field>

    <div class="grid2">
      <Field label="地点" for="it-place"><TextInput id="it-place" spellcheck="false" /></Field>
      <Field label="时间" for="it-time"><TextInput id="it-time" spellcheck="false" /></Field>
    </div>

    <Field label="画面参考（喂给画师的一句话）" for="it-scene">
      <TextInput id="it-scene" spellcheck="false" />
    </Field>

    <div class="char-editor">
      <p class="char-title">人物（每人一行：姓名 / 在场或离场 / 性格 / 说话方式）</p>
      <CharRows kind="import" rowsId="it-characters" addId="btn-it-char-add" />
    </div>

    <Field label="伏笔（每行一条）" for="it-threads">
      <Textarea id="it-threads" rows={3} spellcheck="false" />
    </Field>

    <Field label="画风关键词（英文逗号分隔，用于开局试画 4 张候选）" for="it-style">
      <TextInput id="it-style" spellcheck="false" />
    </Field>

    <p class="hint">确认后建新档并走试画锚定。「用户确认修改」这一步是设计里明确不能跳过的：导入文本是别人的内容，由你把关。</p>
    <div class="row-inline step-actions">{@render footConfirm()}</div>
  </div>
</Card>

<style>
  .step-actions { margin-top: 10px; }
  .char-editor { margin-bottom: 12px; }
  .char-title {
    font-family: var(--font-ui);
    font-size: 12.5px;
    color: var(--ink-dim);
    letter-spacing: .05em;
    margin-bottom: 6px;
  }
  .grid2 :global(.field) { margin-bottom: 0; }
</style>
