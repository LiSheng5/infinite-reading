<script>
  /* 阶段 4 屏 2 · 「本对话设置」面板（Svelte 5 重写）
   * 两级视图（面板内下钻，阶段 4 屏 2 迁移方案 · 方案 A）：
   *   一级 = 对话覆盖行（#prefs-body，界面层 renderStoryPrefs 按 Prefs.visibleFor 渲染，本次不动）
   *        + 故事数据（推进模式 / 存档点 / 世界状态卡摘要与编辑入口 / 角色卡）；
   *   二级 = 世界状态卡编辑器（WorldCardEditor）。
   * 行为仍由 src/app/* 按 id 完成（s-story-mode / sp-* / memory-* / rc-status / btn-edit-card …），
   * 本组件只产标记 + 视图切换（滚动位置 / 焦点 / Esc 见 panel.svelte.js）。 */
  import Icon from '../../ui/Icon.svelte';
  import WorldCardEditor from './WorldCardEditor.svelte';
  import { panel, openWorld, backToList } from './panel.svelte.js';

  // 下钻 / 返回：进二级把焦点移到标题（tabindex=-1），返回还原一级滚动位置并把焦点交回「编辑」
  let mounted = false;
  $effect(() => {
    const view = panel.view;
    if (!mounted) { mounted = true; return; }   // 首次挂载不抢焦点
    if (view === 'world') {
      const t = document.getElementById('prefs-world-title');
      if (t) t.focus();
      return;
    }
    const scroll = document.querySelector('#story-prefs .prefs-scroll');
    if (scroll) scroll.scrollTop = panel.listScroll;
    const btn = document.getElementById('btn-world-edit');
    if (btn) btn.focus();
  });
</script>

<div class="prefs-head">
  <h3 class:hidden={panel.view === 'world'}>本对话设置</h3>
  <div class="prefs-head-world" class:hidden={panel.view !== 'world'}>
    <button id="prefs-world-back" class="btn ghost world-back" type="button" onclick={backToList}>
      <Icon name="back" class="ic-l" />返回
    </button>
    <h3 id="prefs-world-title" class="world-title" tabindex="-1">世界状态卡</h3>
  </div>
  <button id="prefs-close" class="hud-btn" title="关闭" aria-label="关闭"><Icon name="x" /></button>
</div>

<div class="prefs-scroll" data-view={panel.view}>
  <div class="prefs-body" id="prefs-body"></div>

  <div class="prefs-body prefs-story" id="prefs-story">
    <div class="prefs-story-list">
      <fieldset>
        <legend>推进模式</legend>
        <label>当前故事模式
          <select id="s-story-mode">
            <option value="choice">剧情（结尾给选项）</option>
            <option value="chat">智能体（带工具的助手）</option>
            <option value="rp">角色扮演（角色卡）</option>
          </select>
        </label>
        <p class="set-sub">切换只改提示词与渲染，不影响记忆 / 重试 / 作画；记忆数据不随切换清空。</p>
      </fieldset>

      <fieldset>
        <legend>故事 · 存档点</legend>
        <p class="hint" id="sp-empty">进入一个故事后，这里可以打存档点、回到旧存档点。</p>
        <div id="sp-panel" class="hidden">
          <p class="hint" id="sp-summary"></p>
          <div class="row-inline">
            <button id="btn-add-savepoint" class="btn" type="button">打一个存档点</button>
            <span class="hint">退出故事时会自动存档；存档点保留最近 5 个</span>
          </div>
          <div id="sp-list" class="mono-list"></div>
        </div>
      </fieldset>

      <fieldset>
        <legend>故事记忆 · 世界状态卡</legend>
        <p class="hint" id="memory-empty">开始一个故事后，这里显示它的世界状态卡、摘要栈与留痕。</p>
        <div id="memory-panels" class="hidden">
          <div class="row-inline">
            <button id="btn-inject-memory" class="btn" type="button">注入记忆</button>
            <span class="hint" id="inject-state"></span>
          </div>
          <p class="hint" id="world-summary"></p>
          <div class="row-inline">
            <button id="btn-world-edit" class="btn" type="button" onclick={openWorld}>编辑世界状态卡</button>
          </div>
          <div class="panel-block">
            <p class="hint" id="rc-status"></p>
            <div class="row-inline">
              <button id="btn-edit-card" class="btn" type="button">编辑角色卡 / 导入 PNG</button>
            </div>
          </div>
        </div>
      </fieldset>
    </div>

    <WorldCardEditor />
  </div>
</div>

<p class="hint prefs-foot" id="prefs-note">改动只影响当前对话，随时点「重置」回到全局默认；换模型从下一条消息起生效。</p>
