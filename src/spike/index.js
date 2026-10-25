/*
 * src/spike/index.js —— 阶段 1 spike 挂载点（铁律 3：新旧共存，开关切换）
 *
 * 只在 URL 带 ?spike=1 时把 Svelte 5 的设置切片挂到页面右下角；
 * 默认形态零像素变化（与 0.12.1 基线字节一致，见验收记录）。
 * 阶段 4 逐屏重写时，新屏幕的挂载沿用这个「开关切换」模式，稳定后删旧屏。
 */
import { mount } from 'svelte';
import SettingsSpike from './SettingsSpike.svelte';

if (new URLSearchParams(location.search).has('spike')) {
  const host = document.createElement('div');
  host.id = 'ir-spike-host';
  document.body.appendChild(host);
  mount(SettingsSpike, { target: host });
}
