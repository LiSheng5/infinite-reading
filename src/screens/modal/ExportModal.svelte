<script>
  /* ExportModal.svelte —— #modal-export「导出故事」（屏 6b 重建）
   * 文案由 js/app/library.js 的 openExport 写入 #export-story-name；
   * 选项读取（input[name=export-kind]:checked / #export-src.checked）与导出动作
   * （#btn-do-export → A.doExport）都不变。导出按钮的文案会在打包原图时临时改成
   * 「打包原图中…」再还原，所以它只能有纯文本子节点（不能塞图标）。
   * 关闭钮额外挂一次 closeModal：0.12.1 的 #btn-close-export 也是直接 hidden，绕过了弹窗栈。 */
  import Card from './Card.svelte';
  import Checkbox from '../../ui/Checkbox.svelte';
  import Button from '../../ui/Button.svelte';
  import { closeModal } from '../../ui/modalHost.js';

  const close = () => closeModal('modal-export');
</script>

{#snippet foot()}
  <Button id="btn-do-export" variant="primary">导出 .irstory.json</Button>
{/snippet}

<Card title="导出故事" narrow closeId="btn-close-export" onclose={close} footer={foot}>
  <p class="hint" id="export-story-name"></p>
  <div class="radio-col">
    <label class="check"><input type="radio" name="export-kind" value="full" checked /> <b>完整档案</b> —— 含全部剧情记录，别人导入后可原样续玩</label>
    <label class="check"><input type="radio" name="export-kind" value="premise" /> <b>精简设定包</b> —— 只含开局材料（premise / 世界卡 / 画风），导入后预填向导重新开局</label>
  </div>
  <Checkbox id="export-src" label="附带原图（文件更大；默认只带缩略图 + 提示词）" />
  <p class="hint">导入的图片在书架作画风参考展示；缺原图的场景可「按原 prompt 重画」恢复。</p>
</Card>
