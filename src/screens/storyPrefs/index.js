/*
 * src/screens/storyPrefs/index.js —— 「本对话设置」面板挂载（阶段 4 · 屏 2）
 *
 * 挂载把 #story-prefs 里的旧 DOM 清空换成组件输出。面板状态在 panel.svelte.js：
 *   syncDirty() ── src/app/settings.js 的 renderStoryPanels 重绘世界卡表单后对账「判变」；
 *   onOpen()    ── src/app/prefsui.js 的 openStoryPrefs 打开面板时复位到一级视图；
 *   esc()       ── src/app/main.js 的 Esc 链：先退二级、再关面板。
 */
import { mount } from 'svelte';
import StoryPrefsPanel from './StoryPrefsPanel.svelte';

const aside = document.getElementById('story-prefs');
if (aside) {
  aside.replaceChildren();
  aside.dataset.impl = 'svelte';
  mount(StoryPrefsPanel, { target: aside });
}
