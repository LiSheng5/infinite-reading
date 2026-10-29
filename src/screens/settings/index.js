/*
 * src/screens/settings/index.js —— 设置屏挂载（阶段 4 · 屏 2）
 *
 * 挂载把 #modal-settings 里的旧 DOM 清空换成组件输出（字段配置生成，见 settingsForm.js）；
 * 容器本身（含 hidden 开关、遮罩点击、modalStack）不动，事件仍由 src/app/* 按 id 绑定。
 * 分组面板由组件按字段配置直接渲染；prefsui 只负责导航态与模型库等动态列表。
 */
import { mount } from 'svelte';
import SettingsScreen from './SettingsScreen.svelte';

const modal = document.getElementById('modal-settings');
if (modal) {
  modal.replaceChildren();
  modal.dataset.impl = 'svelte';
  mount(SettingsScreen, { target: modal });
}
