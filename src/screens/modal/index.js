/*
 * src/screens/modal/index.js —— 弹窗内容挂载（阶段 4 · 屏 6）
 *
 * 10 个弹窗（6b 轻弹窗 5 个 + 6c 重弹窗 5 个）挂进各自的 #modal-*；
 * 第 11 个弹窗 #modal-settings 是屏 2 的产物（src/screens/settings），这里不重复挂载。
 *
 * 挂法与其他屏一致：**外层容器不动**，只替换内容。
 *   #modal-* 仍是 index.html 里的那个 .modal（遮罩 / position / z-index / hidden 全由
 *   src/ui/modalHost.js 管），这里 replaceChildren() 后 mount(组件) —— 于是：
 *     · 弹窗栈、层级、互斥、Esc、遮罩点击、焦点还原，全部走 modalHost 已经收口的那一套；
 *     · 组件内部只产标记，读写仍按既有 id 契约（src/app/main.js 的 bind() 在 boot 之后跑，
 *       晚于本次 import 期挂载，按 id 取到的就是组件产出的元素）。
 *
 * 人物行（开局向导 / 文本导入确认页）的数据在 state.svelte.js，src/app/wizard.js 与
 * src/app/importer.js 直接 import charApi，不再经全局桥。
 */
import { mount } from 'svelte';
import NewStoryModal from './NewStoryModal.svelte';
import WizardModal from './WizardModal.svelte';
import ImportTextModal from './ImportTextModal.svelte';
import ExportModal from './ExportModal.svelte';
import ConfirmModal from './ConfirmModal.svelte';
import PainterModal from './PainterModal.svelte';
import AnchorModal from './AnchorModal.svelte';
import CardModal from './CardModal.svelte';
import EmailModal from './EmailModal.svelte';
import PaymentModal from './PaymentModal.svelte';

const SCREENS = [
  ['modal-new', NewStoryModal],
  ['modal-wizard', WizardModal],
  ['modal-import-text', ImportTextModal],
  ['modal-export', ExportModal],
  ['modal-confirm', ConfirmModal],
  ['modal-painter', PainterModal],
  ['modal-anchor', AnchorModal],
  ['modal-card', CardModal],
  ['modal-email', EmailModal],
  ['modal-payment', PaymentModal],
];

for (const [id, Component] of SCREENS) {
  const host = document.getElementById(id);
  if (!host) continue;
  host.replaceChildren();
  host.dataset.impl = 'svelte';
  mount(Component, { target: host });
}
