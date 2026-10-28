<script>
  /* CharRows.svelte —— 人物设定行编辑器（屏 6b：接管 0.12.1 的 A.charEditor 的两个用例）
   * 开局向导（姓名 / 性格 / 说话方式）与文本导入确认页（多一列「在场 / 离场」）。
   * 行存在 state.svelte.js 的 charRows 里，legacy 经 IR.ModalScreens.chars(kind) 读写，
   * 因此 startFromWizard / startFromImport 取到的是同一份数据（不再从 DOM 里捞输入框）。
   * 容器 id（#wz-characters / #it-characters）与添加按钮 id（#btn-wz-char-add / #btn-it-char-add）
   * 都按 legacy 的绑定表保留。 */
  import TextInput from '../../ui/TextInput.svelte';
  import IconButton from '../../ui/IconButton.svelte';
  import Button from '../../ui/Button.svelte';
  import { CHAR_FIELDS, charRows, addRow, removeRow } from './state.svelte.js';

  let { kind, rowsId = null, addId = null, addLabel = '+ 添加人物' } = $props();

  const fields = $derived(CHAR_FIELDS[kind] || []);
  const rows = $derived(charRows[kind]);
</script>

<div class="char-head">
  {#each fields as f}<span>{f.label}</span>{/each}
  <span class="del-gap"></span>
</div>

<div id={rowsId} class="char-rows">
  {#each rows as row (row.id)}
    <div class="char-row">
      {#each fields as f}
        <div class="cell">
          <TextInput bind:value={row.values[f.key]} placeholder={f.placeholder} spellcheck="false" data-k={f.key} />
        </div>
      {/each}
      <div class="del-cell">
        <IconButton icon="x" label="删除这一行" onclick={() => removeRow(kind, row.id)} />
      </div>
    </div>
  {/each}
</div>

<div class="add-row">
  <Button id={addId} size="slim" onclick={() => addRow(kind, null)}>{addLabel}</Button>
</div>

<style>
  .char-head {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
  }
  .char-head span {
    flex: 1 1 0;
    min-width: 0;
    font-family: var(--font-ui);
    font-size: 12px;
    letter-spacing: .08em;
    color: var(--ink-dim);
  }
  .char-head .del-gap { flex: 0 0 40px; }

  .char-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .char-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .cell { flex: 1 1 0; min-width: 0; }
  .del-cell { flex: 0 0 40px; display: flex; }

  .add-row { margin-top: 8px; }

  /* 窄屏：四个人物字段并排会挤成一条线，改成两列（表头在窄屏不显示，靠 placeholder） */
  @media (max-width: 720px) {
    .char-head { display: none; }
    .char-row { flex-wrap: wrap; }
    .cell { flex: 1 1 44%; }
  }
</style>
