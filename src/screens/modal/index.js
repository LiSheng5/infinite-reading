/*
 * src/screens/modal/index.js —— 阶段 4 · 屏 6b「轻弹窗内容重写」挂载（铁律 3：新旧共存，开关切换）
 *
 * 只负责 5 个轻弹窗：modal-new / modal-wizard / modal-import-text / modal-export / modal-confirm。
 * 重弹窗（画师 / 锚定 / 角色卡 / 邮件 / 支付 / 设置）留给 6c，本文件一个字符都不碰。
 *
 * 挂法与其他屏一致：**外层容器不动**，只替换内容。
 *   #modal-* 仍是 index.html 里的那个 .modal（遮罩 / position / z-index / hidden 全由
 *   src/ui/modalHost.js 管），这里 replaceChildren() 后 mount(组件) —— 于是：
 *     · 弹窗栈、层级、互斥、Esc、遮罩点击、焦点还原，全部走 6a 已经收口的那一套；
 *     · 组件内部只产标记，读写仍按 legacy 的 id 契约（js/app.js 的 bind() 在 boot 之后跑，
 *       晚于本次 import 期挂载，按 id 取到的就是组件产出的元素）。
 *
 * ?ui=legacy 时整段跳过：旧 DOM 原样留着，wizard.js / importer.js 会退回 A.charEditor
 * （状态桥没注册 → 走命令式注入），过桥的只有新形态。
 *
 * 状态桥（window.IR.ModalScreens）：
 *   has(id)      —— 这个弹窗是不是 Svelte 形态（legacy 逻辑据此选新旧取数方式）
 *   chars(kind)  —— 与 A.charEditor 同形的 { set, get, add }，直接操作 state.svelte.js 的行数组
 *                   （wizard 开局向导 / import 文本导入确认页共用一套实现）
 */
import { mount } from 'svelte';
import NewStoryModal from './NewStoryModal.svelte';
import WizardModal from './WizardModal.svelte';
import ImportTextModal from './ImportTextModal.svelte';
import ExportModal from './ExportModal.svelte';
import ConfirmModal from './ConfirmModal.svelte';
import { charApi } from './state.svelte.js';

const SCREENS = [
  ['modal-new', NewStoryModal],
  ['modal-wizard', WizardModal],
  ['modal-import-text', ImportTextModal],
  ['modal-export', ExportModal],
  ['modal-confirm', ConfirmModal],
];

const legacy = new URLSearchParams(location.search).get('ui') === 'legacy';

if (!legacy) {
  const mounted = [];
  for (const [id, Component] of SCREENS) {
    const host = document.getElementById(id);
    if (!host) continue;             // 半挂载 / 极早期：不动它，旧 DOM 继续可用
    host.replaceChildren();
    host.dataset.impl = 'svelte';
    mount(Component, { target: host });
    mounted.push(id);
  }
  (window.IR = window.IR || {}).ModalScreens = {
    mounted() { return mounted.slice(); },
    has(id) { return mounted.indexOf(id) >= 0; },
    chars(kind) { return charApi(kind); },
  };
}
