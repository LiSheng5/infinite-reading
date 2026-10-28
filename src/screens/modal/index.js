/*
 * src/screens/modal/index.js —— 阶段 4 · 屏 6「弹窗内容重写」挂载（铁律 3：新旧共存，开关切换）
 *
 * 6b：5 个轻弹窗 —— modal-new / modal-wizard / modal-import-text / modal-export / modal-confirm。
 * 6c：5 个重弹窗 —— modal-painter / modal-anchor / modal-card / modal-email / modal-payment。
 * 第 11 个弹窗 #modal-settings 是屏 2 的产物（src/screens/settings，字段配置生成），
 * 在本文件之前已挂好，这里不再重复挂载；6c 只保证它与这 10 个共存、互不覆盖。
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
 *   has(id)        —— 这个弹窗是不是 Svelte 形态（legacy 逻辑据此选新旧取数方式）
 *   chars(kind)    —— 与 A.charEditor 同形的 { set, get, add }，直接操作 state.svelte.js 的行数组
 *                     （wizard 开局向导 / import 文本导入确认页共用一套实现）
 *   mounted()      —— 6b 口径：只数 5 个轻弹窗（6b 的验收脚本按这个数断言，别改它的含义）
 *   heavyMounted() —— 6c 新增：5 个重弹窗（画师 / 锚定 / 角色卡 / 邮件 / 支付）
 *
 * 重弹窗的动态面（画师线程 / 视频列表 / 锚定候选网格 / 邮件草稿 / 支付台账）没有搬进组件：
 * 它们都是「清空 + 重新 append」的只读列表，子节点全由 legacy 生成，组件只给一个空容器，
 * 两边不会各写一半（与屏 2 设置屏的 mono-list / box 节点同一口径）。
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
import { charApi } from './state.svelte.js';

const SCREENS = [
  ['modal-new', NewStoryModal],
  ['modal-wizard', WizardModal],
  ['modal-import-text', ImportTextModal],
  ['modal-export', ExportModal],
  ['modal-confirm', ConfirmModal],
];

const HEAVY_SCREENS = [
  ['modal-painter', PainterModal],
  ['modal-anchor', AnchorModal],
  ['modal-card', CardModal],
  ['modal-email', EmailModal],
  ['modal-payment', PaymentModal],
];

const legacy = new URLSearchParams(location.search).get('ui') === 'legacy';

if (!legacy) {
  const mounted = [];
  const heavy = [];
  for (const [id, Component] of SCREENS.concat(HEAVY_SCREENS)) {
    const host = document.getElementById(id);
    if (!host) continue;             // 半挂载 / 极早期：不动它，旧 DOM 继续可用
    host.replaceChildren();
    host.dataset.impl = 'svelte';
    mount(Component, { target: host });
    (SCREENS.some(s => s[0] === id) ? mounted : heavy).push(id);
  }
  (window.IR = window.IR || {}).ModalScreens = {
    mounted() { return mounted.slice(); },
    heavyMounted() { return heavy.slice(); },
    has(id) { return mounted.indexOf(id) >= 0 || heavy.indexOf(id) >= 0; },
    chars(kind) { return charApi(kind); },
  };
}
