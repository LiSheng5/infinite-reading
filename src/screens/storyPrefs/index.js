/*
 * src/screens/storyPrefs/index.js —— 阶段 4 屏 2「本对话设置」面板挂载（铁律 3：新旧共存，开关切换）
 *
 * 默认挂 Svelte 新面板；URL 带 ?ui=legacy 时留 0.12.1 的旧面板 DOM（过渡期逃生口，阶段 6 删）。
 * 挂载把 #story-prefs 里的旧 DOM 清空换成组件输出，并注册 window.IR.StoryPanel 状态桥：
 *   syncDirty() —— js/app/settings.js 的 renderStoryPanels 重绘世界卡表单后对账「判变」；
 *   onOpen()    —— js/app/prefsui.js 的 openStoryPrefs 打开面板时复位到一级视图；
 *   esc()       —— js/app.js 的 Esc 链：先退二级、再关面板。
 * 旧屏不注册这个桥（各调用点都有判空），行为与 0.12.1 一致。
 */
import { mount } from 'svelte';
import StoryPrefsPanel from './StoryPrefsPanel.svelte';
import { panel, syncDirty, onOpen, esc } from './panel.svelte.js';

const legacy = new URLSearchParams(location.search).get('ui') === 'legacy';

if (!legacy) {
  const aside = document.getElementById('story-prefs');
  if (aside) {
    aside.replaceChildren();
    aside.dataset.impl = 'svelte';
    mount(StoryPrefsPanel, { target: aside });
    (window.IR = window.IR || {}).StoryPanel = {
      syncDirty,
      onOpen,
      esc,
      get view() { return panel.view; },
    };
  }
}
