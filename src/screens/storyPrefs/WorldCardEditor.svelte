<script>
  /* 阶段 4 屏 2 · 世界状态卡编辑器（独立组件，不进设置字段配置系统——它是故事数据的编辑器）
   * 只产标记、不带读写：w-* 的回填 / 判变 / 落盘仍在 src/app/settings.js
   *（renderStoryPanels / worldFormChanged / saveWorldFromForm），人物行由 charEditor
   *（variant: card）渲染进 #w-characters，摘要栈与留痕照旧由界面层填。
   * 布局：正文内滚 + 底部 sticky 保存栏（btn-save-world + world-scribe-at，§3.2）；
   * 「保存世界卡」只在表单真的改动过才可点（panel.dirty ← A.worldFormChanged）。 */
  import { panel, syncDirty } from './panel.svelte.js';
</script>

<div class="prefs-world" id="prefs-world" oninput={syncDirty} onclick={syncDirty}>
  <div class="world-edit-body">
    <div class="grid2">
      <label>地点<input id="w-place" type="text" /></label>
      <label>时间<input id="w-time" type="text" /></label>
    </div>
    <label>画面参考（喂给画师）<input id="w-scene" type="text" /></label>
    <label>伏笔（每行一条）<textarea id="w-threads" rows="3" spellcheck="false"></textarea></label>
    <div class="char-editor">
      <label>人物（每人一行：姓名 / 在场或离场 / 性格 / 说话方式 / 备注）</label>
      <div id="w-characters" class="char-rows"></div>
      <button type="button" id="btn-w-char-add" class="mini-btn char-add">+ 添加人物</button>
      <span class="hint">还没填也可以：剧情里出现的人物会在书记员校对时自动补上，随时能改</span>
    </div>
    <label>关系·阶段<input id="w-rel-stage" type="text" /></label>
    <label>关系·纽带（每行一条；书记员随校对维护，也可手改）<textarea id="w-rel-bonds" rows="2" spellcheck="false"></textarea></label>
    <label>关系·备注<input id="w-rel-notes" type="text" /></label>
    <details class="panel-block">
      <summary>摘要栈（<span id="sum-count">0</span> 幕）</summary>
      <div id="summary-list" class="mono-list"></div>
    </details>
    <details class="panel-block">
      <summary>工具与校对留痕</summary>
      <div id="tool-list" class="mono-list"></div>
    </details>
  </div>
  <div class="world-save-bar">
    <button id="btn-save-world" class="btn primary" type="button" disabled={!panel.dirty}>保存世界卡</button>
    <span id="world-scribe-at" class="hint"></span>
  </div>
</div>
