/*
 * src/screens/storyPrefs/panel.svelte.js —— 本对话设置面板的状态桥（Svelte 5 runes）
 *
 * view：'list'（一级：对话覆盖行 + 故事数据）/ 'world'（二级：世界状态卡编辑器，面板内下钻，
 *  见阶段 4 屏 2 迁移方案 · 方案 A）。窄屏 76vh 底部弹层与桌面停靠面板同一套交互。
 * dirty：世界卡表单是否改动过——真源是 src/app/settings.js 的 worldFormChanged（判变账本），
 *  决定「保存世界卡」是否可点；输入事件与界面层 renderStoryPanels 重绘后都对账一次。
 *
 * 界面层（src/app/*）直接 import syncDirty / onOpen / esc（阶段 6 去掉了 应用层注册表 桥）。
 */
import { A } from '../../app/core.js';

export const panel = $state({ view: 'list', dirty: false });

/* 一级滚动位置（进二级前快照，返回时还原）。**故意是普通模块变量，不是 $state**：
 * StoryPrefsPanel 的 $effect 要读它，读了 $state 就成了响应式依赖 —— 而 openWorld() 先写
 * 滚动位置再写 view，effect 会在「滚动位置刚变」时多跑一遍、把焦点从标题抢到「编辑」上。
 * 读普通变量不进依赖图，effect 只在 view 变化时跑。 */
let listScroll = 0;

const app = () => A;

/** 用「判变」真源对账保存钮状态（表单没动过就不给点，防误锁备注） */
export function syncDirty() {
  const A = app();
  if (!A || typeof A.worldFormChanged !== 'function') return;
  const story = A.state && A.state.story;
  panel.dirty = !!story && A.worldFormChanged(story.world || {});
}

/** 一级视图上次的滚动位置（普通变量的读取口，调用方不会因此建立响应式依赖） */
export function listScrollTop() {
  return listScroll;
}

/** 进二级视图：记下一级滚动位置（返回时还原） */
export function openWorld() {
  const scroll = document.querySelector('#story-prefs .prefs-scroll');
  listScroll = scroll ? scroll.scrollTop : 0;
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

/** Esc 层级：先退二级、再关面板；都没开就交回全局 Esc 链 */
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
