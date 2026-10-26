/*
 * src/screens/settings/index.js —— 阶段 4 屏 2 设置屏挂载（铁律 3：新旧共存，开关切换）
 *
 * 默认挂 Svelte 新设置屏（字段配置生成，见 settingsForm.js）；URL 带 ?ui=legacy 时留
 * 0.12.1 的旧设置 DOM（过渡期逃生口，阶段 6 删）。挂载把 #modal-settings 里的旧 DOM 清空换成
 * 组件输出；容器本身（含 hidden 开关、遮罩点击、modalStack）不动，事件仍由 js/app/* 按 id 绑定。
 * #set-panels 上的 data-impl="svelte" 告诉 prefsui.initSettingsNav 跳过 legend 归类搬 DOM。
 */
import { mount } from 'svelte';
import SettingsScreen from './SettingsScreen.svelte';

const legacy = new URLSearchParams(location.search).get('ui') === 'legacy';

if (!legacy) {
  const modal = document.getElementById('modal-settings');
  if (modal) {
    modal.replaceChildren();
    modal.dataset.impl = 'svelte';
    mount(SettingsScreen, { target: modal });
  }
}
