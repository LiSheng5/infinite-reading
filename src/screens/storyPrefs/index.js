/*
 * src/screens/storyPrefs/index.js —— 「本对话设置」面板挂载（阶段 4 · 屏 2）
 *
 * 挂载只替换 #story-prefs 的内容并打 data-impl（共用外壳见 src/screens/_mount.js）。
 * 面板状态在 panel.svelte.js：
 *   syncDirty() ── src/app/settings.js 的 renderStoryPanels 重绘世界卡表单后对账「判变」；
 *   onOpen()    ── src/app/prefsui.js 的 openStoryPrefs 打开面板时复位到一级视图；
 *   esc()       ── src/app/main.js 的 Esc 链：先退二级、再关面板。
 */
import { mountScreen } from '../_mount.js';
import StoryPrefsPanel from './StoryPrefsPanel.svelte';

mountScreen('story-prefs', StoryPrefsPanel);
