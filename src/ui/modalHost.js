/*
 * src/ui/modalHost.js —— 弹窗的唯一入口（阶段 4 · 屏 6a「外壳与通用出入」）
 *
 * 为什么要有这个文件：0.12.1 起「弹窗怎么开、怎么叠、怎么关」的规则散在两处——
 *   · js/app/core.js 里的 modalStack / openModal / closeModal / dismissModal / closeTopModal（栈与层级）
 *   · js/app.js 里的 Esc 与遮罩点击绑定（按 modalStack 引用判「是不是最上层」）
 * 屏 6 要把 11 个弹窗换成 Svelte 重写、第 7 步还要给开合接视图过渡，必须先有**一个地方**
 * 知道「弹窗有哪几个、当前叠了几层、外壳在哪」，否则过渡内核没有稳定的收口点。
 *
 * 分工：
 *   · 本文件 = 弹窗登记表 + 栈 / 层级 / 互斥 / 关窗语义的唯一实现 + 外壳的挂载
 *   · src/ui/Modal.svelte = 外壳（shell 模式只出一个 display:contents 的层容器，不画任何像素）
 *   · js/app/core.js 只转发（IR.App.openModal 等仍是同一批函数，app/ 下其余模块零改动）
 *   · 第 7 步（弹窗开合过渡）在这里接 runTransition，不动调用方
 *
 * 6a 的硬约束是**零视觉变化**，所以外壳不重建弹窗，而是把它们「整块搬」进来：
 *   #app > #app-modals(display:contents) > #modal-shell-host(display:contents) > #modal-*
 * 两层 display:contents 都不生成盒子 → 不产生新的包含块 / 层叠上下文 / 布局盒，
 * 弹窗仍是 `position:absolute; inset:0` 相对 #app，尺寸与绘制顺序与搬之前逐字节一致。
 * 11 个弹窗的顺序保持 index.html 里的原顺序（MODAL_IDS 就是这个顺序），内部 DOM 一行不改。
 *
 * 原样保留的语义（逐条对齐 0.12.1）：
 *   · 层级：打开时 z-index = 30 + 栈深（首层 31）；关闭时清空并重排剩下几层（30 + i + 1）。
 *     注意 .modal-top 的 32 只是 CSS 兜底，被内联 z-index 覆盖——这一行为故意不「修正」。
 *   · 互斥：FEATURE_MODALS（邮件 / 支付 / 设置）开一个先关掉其它功能类；确认弹窗不参与互斥。
 *   · Esc：只关最上层；确认弹窗必须走 closeConfirm（收掉 Promise），见 dismissModal。
 *   · 遮罩点击：规则仍写在 js/app.js 的绑定里（本步允许改的文件不含它），
 *     它读的 modalStack 就是本文件导出的同一个数组实例。
 *   · 焦点还原：0.12.1 没有（关窗后焦点留在已隐藏的元素上）。6a 补上「开第一个弹窗前的那一帧」
 *     的还原，且 focus({ preventScroll:true })——不抢脚本新放的焦点、不触发滚动。
 *   · 滚动锁：0.12.1 没有，也不需要——body 已 overflow:hidden、#app 定高，
 *     滚动都在屏幕 / 弹窗内部的滚动容器里；6a 不新增（新增会改动 iOS Safari 的手势链）。
 */

import { mount } from 'svelte';
import Modal from './Modal.svelte';

/** 11 个弹窗（顺序 = index.html 里的 DOM 顺序，搬进外壳时按它排，别改成字母序） */
export const MODAL_IDS = [
  'modal-new', 'modal-wizard', 'modal-import-text', 'modal-export', 'modal-painter',
  'modal-anchor', 'modal-card', 'modal-settings', 'modal-confirm',
  'modal-email', 'modal-payment',
];

/** 功能类弹窗：互斥（开一个先关掉其它功能类） */
export const FEATURE_MODALS = ['modal-email', 'modal-payment', 'modal-settings'];

/** 栈：活的数组实例（core.js 把它挂到 IR.App 上，js/app.js 的遮罩点击按引用读它） */
export const modalStack = [];

const HIDDEN = 'hidden';
const BASE_Z = 30;          // css/style.css 的 .modal z-index；栈深往上叠
const ANCHOR_ID = 'app-modals';        // 插在第一个弹窗原位置上的壳锚点（display:contents）
const SHELL_HOST_ID = 'modal-shell-host';   // Modal.svelte shell 模式的根（display:contents）

let shellReady = false;
let openDepth = 0;          // >0 = 正在执行 openModal（互斥关窗不得顺手还原焦点）
let focusReturn = null;     // 开第一个弹窗前聚焦的元素（关闭最后一层时收回去）

/* ---------- 外壳 ---------- */

/** 外壳根（未安装 / 半挂载时为 null） */
export function shellHostEl() {
  return typeof document === 'undefined' ? null : document.getElementById(SHELL_HOST_ID);
}

/** 外壳是否已接管 11 个弹窗 */
export function shellInstalled() {
  return shellReady;
}

/**
 * 安装外壳：把 index.html 里的 11 个弹窗整块搬进 Modal.svelte 的壳层。
 * 幂等；DOM 不在（?ui=legacy 半挂载 / 极早期）时什么都不做，弹窗照原样留在 #app 下。
 * @returns {HTMLElement|null} 壳层根
 */
export function installShell() {
  if (typeof document === 'undefined') return null;
  if (shellReady) return shellHostEl();

  const nodes = MODAL_IDS.map(id => document.getElementById(id)).filter(Boolean);
  if (!nodes.length) return null;

  const anchor = document.createElement('div');
  anchor.id = ANCHOR_ID;
  anchor.style.display = 'contents';   // 不生成盒子：包含块 / 层叠上下文 / 布局全不变
  nodes[0].parentNode.insertBefore(anchor, nodes[0]);

  mount(Modal, { target: anchor, props: { shell: true } });

  const host = shellHostEl();
  if (!host) {   // 理论上不会发生（壳层根由 Modal.svelte 同步渲染）；兜底不留半截锚点
    anchor.remove();
    return null;
  }
  // 整块搬：移动的是节点本身（事件监听、Svelte 挂载的子组件、输入值都跟着走），内部 DOM 一行不改
  for (const el of nodes) host.appendChild(el);
  shellReady = true;
  return host;
}

function ensureShell() {
  if (!shellReady) installShell();
}

/* ---------- 焦点还原 ---------- */

function modalEl(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

function isFocusable(el) {
  if (!el || !el.isConnected || typeof el.focus !== 'function') return false;
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
  return !cs || (cs.display !== 'none' && cs.visibility !== 'hidden');
}

function foldFocusInsideModal(el) {
  if (!el) return false;
  for (const id of MODAL_IDS) {
    const m = modalEl(id);
    if (m && m !== el && m.contains(el)) return true;
  }
  return false;
}

function rememberFocus() {
  if (modalStack.length) return;                 // 已经有层开着：留第一次开之前那个
  const el = typeof document === 'undefined' ? null : document.activeElement;
  focusReturn = (el && el !== document.body && el !== document.documentElement) ? el : null;
}

function restoreFocus() {
  const el = focusReturn;
  focusReturn = null;
  if (!isFocusable(el)) return;
  const active = document.activeElement;
  // 只有在「焦点还留在弹窗里」或「已落回 body」时才收回——不抢脚本 / 用户新放上去的焦点
  if (active && active !== document.body && !foldFocusInsideModal(active)) return;
  try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (__) {} }
}

/* ---------- 栈 ---------- */

/** 是否开着 */
export function isModalOpen(id) {
  return modalStack.indexOf(id) >= 0;
}

/** 最上层（没开时返回 ''） */
export function topModal() {
  return modalStack.length ? modalStack[modalStack.length - 1] : '';
}

function restack() {
  modalStack.forEach((mid, i) => {
    const m = modalEl(mid);
    if (m) m.style.zIndex = String(BASE_Z + i + 1);
  });
}

/**
 * 开弹窗（语义与 0.12.1 的 core.js 完全一致）。
 * @param {string} id MODAL_IDS 里的 id
 */
export function openModal(id) {
  ensureShell();
  const el = modalEl(id);
  if (!el) return;
  openDepth++;
  try {
    rememberFocus();   // 必须在互斥关窗之前：否则焦点基准会被「刚刚关掉的那层」污染
    if (FEATURE_MODALS.indexOf(id) >= 0) {
      for (const other of modalStack.slice()) {
        if (other !== id && FEATURE_MODALS.indexOf(other) >= 0) closeModal(other);
      }
    }
    const at = modalStack.indexOf(id);
    if (at >= 0) modalStack.splice(at, 1);
    modalStack.push(id);
    el.classList.remove(HIDDEN);
    el.setAttribute('aria-hidden', 'false');
    el.style.zIndex = String(BASE_Z + modalStack.length);
  } finally {
    openDepth--;
  }
}

/**
 * 关弹窗（只改显隐与层级；需要清状态 / 收 Promise 的走 dismissModal）。
 * @param {string} id
 */
export function closeModal(id) {
  const el = modalEl(id);
  if (el) {
    el.classList.add(HIDDEN);
    el.setAttribute('aria-hidden', 'true');
    el.style.zIndex = '';
  }
  const at = modalStack.indexOf(id);
  if (at >= 0) modalStack.splice(at, 1);
  restack();   // 关掉后重排剩下几层的层序，保持「后开的在上面」
  if (!modalStack.length && !openDepth) restoreFocus();
}

/**
 * Esc / 点遮罩：按弹窗自己的关闭函数收尾（有的要清状态、有的要 resolve Promise）。
 * @param {string} id
 */
export function dismissModal(id) {
  const A = (typeof IR !== 'undefined' && IR.App) || {};
  if (id === 'modal-confirm') {
    if (typeof A.closeConfirm === 'function') A.closeConfirm(null);
    else closeModal(id);
    return;
  }
  if (id === 'modal-painter') { if (typeof A.closeWorkbench === 'function') A.closeWorkbench(); else closeModal(id); return; }
  if (id === 'modal-anchor') { if (typeof A.closeAnchor === 'function') A.closeAnchor(); else closeModal(id); return; }
  if (id === 'modal-import-text') { if (typeof A.closeImportText === 'function') A.closeImportText(); else closeModal(id); return; }
  if (id === 'modal-card') { if (typeof A.closeCardEditor === 'function') A.closeCardEditor(true); else closeModal(id); return; }
  closeModal(id);
}

/** 关最上层（Esc 用）：没有层可关时返回 false，调用方接着处理菜单 / 沉浸态 */
export function closeTopModal() {
  if (!modalStack.length) return false;
  dismissModal(modalStack[modalStack.length - 1]);
  return true;
}

/* ---------- IR 兼容层（legacy 界面层的既定桥法；阶段 6 随 IR 一起删） ---------- */
export const ModalHost = {
  MODAL_IDS,
  FEATURE_MODALS,
  modalStack,
  installShell,
  shellHostEl,
  shellInstalled,
  openModal,
  closeModal,
  dismissModal,
  closeTopModal,
  isModalOpen,
  topModal,
};

const g = globalThis;
g.IR = g.IR || {};
g.IR.ModalHost = ModalHost;
