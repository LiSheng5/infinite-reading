/*
 * src/screens/settings/index.js —— 设置屏挂载（阶段 4 · 屏 2）
 *
 * 挂载只替换 #modal-settings 的内容并打 data-impl（共用外壳见 src/screens/_mount.js）；
 * 容器本身（含 hidden 开关、遮罩点击、modalStack）不动，事件仍由 src/app/* 按 id 绑定。
 * 分组面板由组件按字段配置直接渲染（settingsForm.js）；prefsui 只负责导航态与模型库等动态列表。
 */
import { mountScreen } from '../_mount.js';
import SettingsScreen from './SettingsScreen.svelte';

mountScreen('modal-settings', SettingsScreen);
