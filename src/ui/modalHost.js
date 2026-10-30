/*
 * src/ui/modalHost.js —— 弹窗的唯一入口（阶段 4 · 屏 6a「外壳与通用出入」）
 *
 * 为什么要有这个文件：0.12.1 起「弹窗怎么开、怎么叠、怎么关」的规则散在两处——
 *   · src/app/core.js 里的 modalStack / openModal / closeModal / dismissModal / closeTopModal（栈与层级）
 *   · src/app/main.js 里的 Esc 与遮罩点击绑定（按 modalStack 引用判「是不是最上层」）
 * 屏 6 要把 11 个弹窗换成 Svelte 重写、还要给开合接视图过渡，必须先有**一个地方**
 * 知道「弹窗有哪几个、当前叠了几层、外壳在哪」，否则过渡内核没有稳定的收口点。
 *
 * 分工：
 *   · 本文件 = 弹窗登记表 + 栈 / 层级 / 互斥 / 关窗语义的唯一实现 + 外壳的挂载 + 开合过渡
 *   · 外壳 = installShell() 就地建的一个 display:contents 层容器（只做「层」，不画任何像素）
 *   · 卡片外观 = src/ui/ModalCard.svelte（头 / 身 / 脚 + 关闭；11 个弹窗共用同一份）
 *   · src/app/core.js 只转发（App.openModal 等仍是同一批函数，app/ 下其余模块零改动）
 *   · （弹窗开合过渡）已在 openModal / closeModal 里接上 runTransition，调用方一律不动
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
 *   · 遮罩点击：规则仍写在 src/app/main.js 的绑定里（本步允许改的文件不含它），
 *     它读的 modalStack 就是本文件导出的同一个数组实例。
 *   · 焦点还原：0.12.1 没有（关窗后焦点留在已隐藏的元素上）。6a 补上「开第一个弹窗前的那一帧」
 *     的还原，且 focus({ preventScroll:true })——不抢脚本新放的焦点、不触发滚动。
 *   · 背景惰性化：0.12.1 没有，补上——弹窗开着时各屏 / 灯箱加 inert + aria-hidden
 *     （只在焦点已经进弹窗之后加，关窗时先撤再还焦点，见 src/ui/backdrop.js 文件头）。
 *   · 滚动锁：0.12.1 没有，也不需要——body 已 overflow:hidden、#app 定高，
 *     滚动都在屏幕 / 弹窗内部的滚动容器里；6a 不新增（新增会改动 iOS Safari 的手势链）。
 */

import { trapFocus } from './focusTrap.js';
import { setModalBackdrop } from './backdrop.js';
import { runTransition, transitionSpec, supportsVT, vtDisabled } from './viewTransition.js';
// 应用层注册表（循环依赖是安全的：只在 dismissModal 被调用时读，eval 期不取值）
import { A as appApi } from '../app/core.js';

/** 11 个弹窗（顺序 = index.html 里的 DOM 顺序，搬进外壳时按它排，别改成字母序） */
export const MODAL_IDS = [
  'modal-new', 'modal-wizard', 'modal-import-text', 'modal-export', 'modal-painter',
  'modal-anchor', 'modal-card', 'modal-settings', 'modal-confirm',
  'modal-email', 'modal-payment',
];

/** 功能类弹窗：互斥（开一个先关掉其它功能类） */
export const FEATURE_MODALS = ['modal-email', 'modal-payment', 'modal-settings'];

/** 栈：活的数组实例（core.js 把它挂到 App 上，src/app/main.js 的遮罩点击按引用读它） */
export const modalStack = [];

const HIDDEN = 'hidden';
const BASE_Z = 30;          // css/overlays.css 的 .modal z-index；栈深往上叠
const ANCHOR_ID = 'app-modals';        // 插在第一个弹窗原位置上的壳锚点（display:contents）
const SHELL_HOST_ID = 'modal-shell-host';   // installShell() 建的壳层根（display:contents）

let shellReady = false;
let openDepth = 0;          // >0 = 正在执行 openModal（互斥关窗不得顺手还原焦点）
let focusReturn = null;     // 开第一个弹窗前聚焦的元素（关闭最后一层时收回去）
const modalTraps = new Map();   // id → trapFocus 的卸载函数（Tab 不得穿透遮罩）

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
 * 安装外壳：把 index.html 里的 11 个弹窗整块搬进壳层。
 * 幂等；DOM 不在（极早期 / 单测环境）时什么都不做，弹窗照原样留在 #app 下。
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

  /* 壳层根：外壳这件事就是一个 display:contents 的 div。
   * 之前这里 mount 的是 src/ui/Modal.svelte —— 同一份组件里除了外壳还藏着一份
   * 「画卡片的」分支（唯一使用点永远 shell:true，那份分支 + 120 行 scoped CSS 从未生效）；
   * 卡片分支已删（卡片只剩 src/ui/ModalCard.svelte），外壳也就没有理由再包一层组件。 */
  const host = document.createElement('div');
  host.id = SHELL_HOST_ID;
  host.style.display = 'contents';
  anchor.appendChild(host);

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

/* ---------- 焦点陷阱----------
 * 每个弹窗根节点一个：Tab / Shift+Tab 在弹窗内循环，关闭时焦点收回原处。
 * moveFocus=false 用于「已经开着的弹窗又被点到」——只补装陷阱，不打断用户当前焦点。 */
function armTrap(id, el, moveFocus) {
  disarmTrap(id);
  if (!el) return;
  modalTraps.set(id, trapFocus(el, moveFocus === false ? { initial: false } : undefined));
}

function disarmTrap(id) {
  const fn = modalTraps.get(id);
  if (!fn) return;
  modalTraps.delete(id);
  try { fn(); } catch (_) {}
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

/* ---------- 开合过渡（阶段 5 ·）----------
 * 形态（三档验收矩阵「弹窗开合」一行，声明表 = src/core/motion.ts 的 TRANSITIONS.modal）：
 *   off       即时：改 DOM 同步做，焦点与滚动位置都不动；不挂名字、不开快照
 *   standard  遮罩层整体交叉淡入 / 淡出（≤160ms）：背景随遮罩一起渐隐，卡片不位移
 *   rich      同上 + 卡片从 scale(.96) translateY(6px) 收进来（关窗时反向退到 scale(.98)
 *             translateY(-4px)）；时长取 TRANSITIONS.modal.rich.ms
 *   降级      ?vt=0 / 浏览器没有 startViewTransition：开窗对弹窗容器整块淡入；关窗即时（理由见下）
 *
 * 命名范围（根快照会曝光 fixed 层与内部滚动）：
 *   · 过渡期间给根节点挂 `view-transition-name: none` —— 根不参与快照，弹窗只要自己那一层。
 *     这是**临时**改（计数式 holdRootOutOfSnapshot），不写进 css：切屏 / 分支页的过渡仍要用
 *     ::view-transition-new(root) 做位移，常驻 none 会把那两步弄坏。
 *   · 容器名 = 弹窗 id（modal-settings…），卡片名 = id + '-card'（rich 才挂：standard 不许位移）。
 *     一次只给「这一个弹窗」的两个节点命名，嵌套弹窗各用各的名字，同屏不重名。
 *   · 名字只在过渡期存在：开窗过渡一结束就撤（与 stage-art 同一口径），
 *     免得开着弹窗去切屏时，弹窗被拖进那一层快照里做无意义的自交叉淡入。
 *
 * 为什么关窗在降级路径不做淡出：隐藏必须同步——焦点还原、栈、以及 20 多处调用点「关完立刻判
 * 可见性」都是同步语义，淡出则要求把隐藏延后一二百毫秒；按「off 档不许 await 后再改 DOM」
 * 的同一条理由选同步，只在真有 View Transition 时才演出退场。
 *
 * 开窗那一侧（0.12.1 的同步语义不能破）：
 *   · 显示、层级、焦点基准全部在调用当帧做完；旧快照里用 opacity:0 把这层挡掉（旧态是一张全透明图，
 *     淡出等于什么都不发生），新快照照常淡入。
 *   · 为什么不能把显示推迟到 update 回调：`openModal` 之后同步 focus / 量布局 / scrollIntoView 的
 *     调用点有一批（irConfirm 的 #cf-input、文本导入的 #it-text、「定时主动」入口滚到 #fs-schedule）。
 *     第一版正是推迟的，实测这三个全部落空（activeElement 停在触发按钮上）。
 *   · 关窗那一侧只能把「隐藏」放进 update 回调（退场要求旧态可见、新态消失），栈仍在调用当下就撤。
 *
 * 连点 / 嵌套的正确性：
 *   · 每个 id 一个单调序号，旧的收尾（撤名字 / 还原焦点）碰不到新状态；
 *   · runTransition 自己会 skipTransition 收掉上一段（连续触发不留快照）；
 *   · openModal 内部互相排斥关功能类弹窗时（openDepth>0）走同步关窗，不排一串过渡。
 */
const CARD_SEL = '.modal-card';
const CARD_IN_Y = 6;        // rich 入场：卡片从 +6px 收上来
const CARD_IN_SCALE = 0.96;
const CARD_OUT_Y = -4;      // rich 退场：卡片往 -4px 退、略缩
const CARD_OUT_SCALE = 0.98;

let rootHold = 0;           // 根节点「不进快照」的嵌套计数（与切屏过渡共用同一份状态）
let rootHoldPrev = '';
const modalSeq = new Map();   // id → 最近一次开 / 关的序号
const snapAnims = new Map();  // 伪元素选择器 → Animation（连点先收上一段，避免叠帧）

function nextSeq(id) {
  const n = (modalSeq.get(id) || 0) + 1;
  modalSeq.set(id, n);
  return n;
}

function seqIs(id, n) {
  return (modalSeq.get(id) || 0) === n;
}

/** 当前动效档（与 src/ui/viewTransition.js 的 tierOf 同口径：没写 data-motion 时按 rich） */
function motionTier() {
  let v = '';
  try { v = document.documentElement.dataset.motion || ''; } catch (_) {}
  return v === 'off' || v === 'standard' ? v : 'rich';
}

/** 这批改动要不要真的开 View Transition（off / 降级都不挂名字） */
function planModal() {
  const spec = transitionSpec('modal', motionTier());
  const willVT = spec.kind !== 'instant' && !vtDisabled() && supportsVT();
  return { spec, willVT, rich: willVT && spec.kind === 'shift' };
}

/** 根节点在快照期间 opt-out（计数式：切屏 / 分支页的过渡同时在跑也不会互相清掉） */
function holdRootOutOfSnapshot() {
  const root = typeof document === 'undefined' ? null : document.documentElement;
  if (!root) return () => {};
  if (!rootHold) {
    rootHoldPrev = root.style.viewTransitionName;
    root.style.viewTransitionName = 'none';
  }
  rootHold++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rootHold = Math.max(0, rootHold - 1);
    if (!rootHold) {
      try { root.style.viewTransitionName = rootHoldPrev || ''; } catch (_) {}
      rootHoldPrev = '';
    }
  };
}

function cardOf(el) {
  return el ? el.querySelector(CARD_SEL) : null;
}

/** 挂名字：容器（遮罩 + 卡片）永远挂，卡片只在 rich（有位移的那一档）挂 */
function applyNames(id, withCard) {
  const el = modalEl(id);
  if (!el) return;
  el.style.viewTransitionName = id;
  const card = withCard ? cardOf(el) : null;
  if (card) card.style.viewTransitionName = id + '-card';
}

function clearNames(id) {
  const el = modalEl(id);
  if (!el) return;
  try { el.style.viewTransitionName = ''; } catch (_) {}
  const card = cardOf(el);
  if (card) { try { card.style.viewTransitionName = ''; } catch (_) {} }
}

function easeToken() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim();
    if (v) return v;
  } catch (_) {}
  return 'ease-out';
}

/* 给快照伪元素挂一段 transform（与第 3 / 6 步 shiftNewSnapshot 同一手法：位移若写成 @keyframes
 * 就要同步 motion.ts 与两份 eval 测试，这一步的改动面不含那三处）。
 * 只动 transform：伪元素自己的淡入淡出仍由 css/motion.css 的 ::view-transition-* 时长收口。 */
function animateSnapshot(pseudo, frames, ms) {
  if (!(ms > 0) || typeof document === 'undefined') return;
  const prev = snapAnims.get(pseudo);
  if (prev) {
    try { prev.cancel(); } catch (_) {}
    snapAnims.delete(pseudo);
  }
  let anim;
  try {
    anim = document.documentElement.animate(frames, {
      duration: ms,
      easing: easeToken(),
      pseudoElement: pseudo,
    });
  } catch (_) {
    return;   // 伪元素 WAAPI 不可用：只保留交叉淡入，不算失败
  }
  snapAnims.set(pseudo, anim);
  const done = () => { if (snapAnims.get(pseudo) === anim) snapAnims.delete(pseudo); };
  try { anim.finished.then(done, done); } catch (_) { done(); }
}

function animateCardIn(id, ms) {
  const card = cardOf(modalEl(id));
  if (!card) return;
  animateSnapshot('::view-transition-new(' + id + '-card)', [
    { transform: 'translateY(' + CARD_IN_Y + 'px) scale(' + CARD_IN_SCALE + ')' },
    { transform: 'none' },
  ], ms);
}

function animateCardOut(id, ms) {
  const card = cardOf(modalEl(id));
  if (!card) return;
  animateSnapshot('::view-transition-old(' + id + '-card)', [
    { transform: 'none' },
    { transform: 'translateY(' + CARD_OUT_Y + 'px) scale(' + CARD_OUT_SCALE + ')' },
  ], ms);
}

/* 卡片自己的入场动画（css/overlays.css 的 .modal-card → --an-leafIn）在过渡期间让位给快照：
 * 它会在 update 回调那一帧从 opacity:0 / translateY(10px) 起跑，被新快照原样拍下来 ——
 * 结果是「遮罩淡入、卡片却定格在半透明」两段叠在一起。过渡期挂 animation-name:none，
 * 新快照拍到的就是终态；关窗那一刻再撤（元素正被隐藏，重挂动画不会被看见）。
 * 只对真走 View Transition 的路径做：off 档与降级的淡入仍是原来那条动画（本步不改它的档位政策）。 */
const cardResume = new Map();   // id → 撤销「动画让位」的函数

function resumeCard(id) {
  const fn = cardResume.get(id);
  if (!fn) return;
  cardResume.delete(id);
  try { fn(); } catch (_) {}
}

function suppressCardEntrance(id) {
  resumeCard(id);
  const card = cardOf(modalEl(id));
  if (!card) return;
  const prev = card.style.animationName;
  card.style.animationName = 'none';
  cardResume.set(id, () => { try { card.style.animationName = prev || ''; } catch (_) {} });
}

/** 收尾：撤根 opt-out、撤名字（序号过期的收尾什么都不碰） */
function endModalTransition(id, seq, release) {
  if (release) release();
  if (seqIs(id, seq)) clearNames(id);
}

/** 没有过渡时（off / 降级 / 半挂载）的统一回执，形状与 runTransition 的返回值一致 */
function instantResult(id) {
  return { modal: id, tier: '', kind: 'instant', ms: 0, mode: 'instant', finished: Promise.resolve() };
}

/**
 * 开弹窗（语义与 0.12.1 的 core.js 完全一致；只把「改 DOM 那一帧」交给过渡内核）。
 * @param {string} id MODAL_IDS 里的 id
 * @returns {{modal: string, tier: string, kind: string, ms: number, mode: string, finished: Promise<any>}}
 */
export function openModal(id) {
  ensureShell();
  const el = modalEl(id);
  if (!el) return instantResult(id);
  // 已经开着（栈里有它且没隐藏）：只提到最上层，不重跑过渡（连点同一入口不该产生第二对快照）
  const alreadyOpen = isModalOpen(id) && !el.classList.contains(HIDDEN);
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
  } finally {
    openDepth--;
  }

  const seq = nextSeq(id);
  const zDepth = String(BASE_Z + modalStack.length);
  const show = () => {
    if (!seqIs(id, seq)) return;     // 已经被后来的开 / 关切掉：这一帧不许再亮出来
    el.classList.remove(HIDDEN);
    el.setAttribute('aria-hidden', 'false');
    el.style.zIndex = zDepth;
  };

  if (alreadyOpen) {
    show();
    if (!modalTraps.has(id)) armTrap(id, el, false);   // 只补陷阱，不打断当前焦点
    setModalBackdrop(true);                            // 背景退出无障碍树（顺序见 backdrop.js 文件头）
    return instantResult(id);
  }

  const plan = planModal();
  if (!plan.willVT) {                       // off 档 / 降级：内核负责同步换（或整块淡入）
    const r = runTransition('modal', show, { scope: el });
    armTrap(id, el);                        // runTransition 的所有分支都先同步改 DOM，故此处元素已可见
    setModalBackdrop(true);                 // 焦点已在对话框里，才给背景加 inert / aria-hidden
    const done = () => endModalTransition(id, seq, null);
    if (r.mode === 'instant') done();
    else r.finished.then(done, done);
    return { modal: id, tier: r.tier, kind: r.kind, ms: r.ms, mode: r.mode, finished: r.finished };
  }

  /* 真走 View Transition 时**开窗这一侧仍然同步改 DOM**（与 0.12.1 同一时序），
   * 只在旧快照里用 opacity:0 把它挡住 —— 否则「开完立刻聚焦输入框 / 滚到某个字段 / 量尺寸」
   * 这一批调用点全会落空（实测：irConfirm 的输入框、文本导入的 #it-text、
   * 「定时主动」入口的 scrollIntoView 都依赖当帧可见）。
   * 旧态是一张全透明快照 → ::view-transition-old 淡出等于什么都不发生，新态照常淡入。 */
  show();
  armTrap(id, el);            // 焦点先进弹窗，后续调用方的 focus / scrollIntoView 仍能覆盖
  setModalBackdrop(true);     // 同上：焦点就位后再惰性化背景
  el.style.opacity = '0';
  const release = holdRootOutOfSnapshot();
  applyNames(id, plan.rich);   // 名字要在开快照之前挂上（旧态全透明 → 只有入场）
  suppressCardEntrance(id);    // 卡片入场动画让位给快照（否则新快照拍到的是它的第一帧）
  /* 只清自己挂的 opacity：序号过期（被后来的开 / 关顶掉）且弹窗仍可见时，说明有更新的那一段在管它；
   * 已经隐藏时清掉是安全的（不可见），顺便保证下一次开门不会带着 opacity:0 出来。 */
  const paint = () => { if (seqIs(id, seq) || el.classList.contains(HIDDEN)) el.style.opacity = ''; };
  const r = runTransition('modal', paint, { scope: el });
  if (plan.rich) animateCardIn(id, r.ms);
  const done = () => {
    paint();                   // 兜底：update 回调万一没跑也要把 opacity 还回去
    endModalTransition(id, seq, release);
  };
  if (r.mode === 'instant') done();
  else r.finished.then(done, done);
  return { modal: id, tier: r.tier, kind: r.kind, ms: r.ms, mode: r.mode, finished: r.finished };
}

/**
 * 关弹窗（只改显隐与层级；需要清状态 / 收 Promise 的走 dismissModal）。
 * 栈在调用当下就撤（Esc / 遮罩点击 / 焦点判定读的是同一个数组实例），
 * View Transition 时只有「DOM 隐藏那一帧」被推到 update 回调里。
 * @param {string} id
 */
export function closeModal(id) {
  const el = modalEl(id);
  const wasOpen = isModalOpen(id);
  const seq = nextSeq(id);

  const at = modalStack.indexOf(id);
  if (at >= 0) modalStack.splice(at, 1);
  restack();   // 关掉后重排剩下几层的层序，保持「后开的在上面」
  const last = !modalStack.length && !openDepth;

  const hideNow = () => {
    if (last) setModalBackdrop(false);    // 先撤背景 inert：trap 释放与 restoreFocus 要能把焦点还回背景元素
    disarmTrap(id);                       // 先拆陷阱：release 会在元素仍可见时把焦点收回原处
    resumeCard(id);                       // 撤掉「动画让位」：此刻元素正要被隐藏，重挂动画不会被看见
    if (el) el.style.opacity = '';        // 同理：清掉入场用的 opacity:0，下一次开门才不会有残留
    if (el) {
      el.classList.add(HIDDEN);
      el.setAttribute('aria-hidden', 'true');
      el.style.zIndex = '';
    }
    if (last) restoreFocus();
  };
  const hide = () => {
    if (!seqIs(id, seq)) return;   // 被后来的 openModal 顶掉：不许把它重新藏起来
    hideNow();
  };

  // 没开着的（重复关 / 互斥里已经关过）/ 开窗过程中（openDepth>0）/ 没有元素：同步收敛，不开过渡
  if (!el || !wasOpen || openDepth > 0) {
    hideNow();
    clearNames(id);
    return instantResult(id);
  }

  const plan = planModal();
  if (!plan.willVT) {          // off 档 / 降级：只收敛 DOM（见文件头「为什么降级关窗不做淡出」）
    hide();
    clearNames(id);
    return instantResult(id);
  }

  const release = holdRootOutOfSnapshot();
  applyNames(id, plan.rich);   // 旧态带着名字 → 新态元素被 display:none 移除 → ::view-transition-old 退场
  const r = runTransition('modal', hide, { scope: el });
  if (plan.rich) animateCardOut(id, r.ms);
  const done = () => endModalTransition(id, seq, release);
  if (r.mode === 'instant') done();
  else r.finished.then(done, done);
  return { modal: id, tier: r.tier, kind: r.kind, ms: r.ms, mode: r.mode, finished: r.finished };
}

/**
 * Esc / 点遮罩：按弹窗自己的关闭函数收尾（有的要清状态、有的要 resolve Promise）。
 * @param {string} id
 */
export function dismissModal(id) {
  const A = appApi;
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

/* 阶段 6：不再导出 ModalHost 兼容对象 / 不再挂 应用层注册表——
 * 应用层直接 import 上面的函数（core.js 一次取齐），外壳由组合根安装。 */
