/*
 * src/screens/storyPrefs/panel.svelte.js —— 本对话设置面板的状态桥（Svelte 5 runes）
 *
 * view：'list'（一级：对话覆盖行 + 故事数据）/ 'world'（二级：世界状态卡编辑器，面板内下钻，
 *  见 docs/phase4-settings-plan.md §3.2 方案 A）。窄屏 76vh 底部弹层与桌面停靠面板同一套交互。
 * dirty：世界卡表单是否改动过——真源是 js/app/settings.js 的 worldFormChanged（判变账本），
 *  决定「保存世界卡」是否可点；输入事件与界面层 renderStoryPanels 重绘后都对账一次。
 *
 * 界面层（js/app/*）经 window.IR.StoryPanel 调 syncDirty / onOpen / esc：
 * 旧屏（?ui=legacy）不注册这个桥，行为与 0.12.1 一致。
 */
export const panel = $state({ view: 'list', dirty: false, listScroll: 0 });

const app = () => (globalThis.IR && globalThis.IR.App) || null;

/** 用「判变」真源对账保存钮状态（表单没动过就不给点，防误锁备注） */
export function syncDirty() {
  const A = app();
  if (!A || typeof A.worldFormChanged !== 'function') return;
  const story = A.state && A.state.story;
  panel.dirty = !!story && A.worldFormChanged(story.world || {});
}

/** 进二级视图：记下一级滚动位置（返回时还原） */
export function openWorld() {
  const scroll = document.querySelector('#story-prefs .prefs-scroll');
  panel.listScroll = scroll ? scroll.scrollTop : 0;
  syncDirty();
  panel.view = 'world';
}

/** 回一级视图（滚动还原与焦点管理在 StoryPrefsPanel 的 $effect 里做） */
export function backToList() {
  panel.view = 'list';
}

/** 打开面板时复位：回一级视图 + 对账判变（界面层 openStoryPrefs 调） */
export function onOpen() {
  panel.view = 'list';
  syncDirty();
}

/** Esc 层级（§3.2）：先退二级、再关面板；都没开就交回全局 Esc 链 */
export function esc() {
  if (panel.view === 'world') { backToList(); return true; }
  const A = app();
  const aside = document.getElementById('story-prefs');
  if (aside && !aside.classList.contains('hidden') && A && A.closeStoryPrefs) {
    A.closeStoryPrefs();
    return true;
  }
  return false;
}
