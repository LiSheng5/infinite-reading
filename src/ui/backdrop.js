/*
 * src/ui/backdrop.js —— 背景「惰性化」收口
 *
 * 为什么要有这个文件：弹窗（11 个 #modal-*，外壳见 src/ui/modalHost.js）与分支页
 * （#branch-page，src/app/branch.js）都声明了 role="dialog" aria-modal="true"，
 * 但**只拦 Tab 不够**：读屏用户仍能浏览被遮罩盖住的页面，读到顶栏按钮、聊天正文。
 * aria-modal 的完整承诺 = 焦点留在对话框内（已由 src/ui/focusTrap.js 做）
 *   + 背景从无障碍树里消失（本文件做）。
 *
 * 两层来源合成（同一份 DOM 状态）：
 *   · modal  ：modalStack 非空 —— 任何弹窗打开
 *   · branch ：分支页打开（整页 dialog）
 * 规则：分支页只在「弹窗盖在它上面」时才算背景；其余（各屏 / 本对话设置 / 灯箱）任一
 * 覆盖层打开都算背景。灯箱在 #app 之外，单独收进来。
 *
 * 实现取 inert + aria-hidden 双保险：
 *   · inert 是现代浏览器（Chrome 102+/Safari 15.5+/Firefox 112+）的语义：不可聚焦、不进无障碍树；
 *   · aria-hidden 兜住没有 inert 的老浏览器（inert 属性此时只是无效属性，无副作用）。
 * 两者都不改渲染：不产生盒子、不影响布局与快照，View Transition 期间调用是安全的。
 *
 * 焦点顺序（调用方必须遵守）：
 *   打开覆盖层 → 先把焦点送进对话框，再调这里（否则 aria-hidden 落在带焦点的祖先上，
 *   Chrome 会以「Blocked aria-hidden on an element because its descendant retained focus」拒绝）；
 *   关闭覆盖层 → 先调这里撤销，再把焦点还给触发元素（inert 子树里的元素 focus 会被忽略）。
 *
 * 幂等 + 可逆：每个元素第一次被标记时记下原有的 inert / aria-hidden，撤销时原样还原；
 * 重复调用、层叠开关（弹窗盖分支页）都只做增量。
 */

const layers = { modal: false, branch: false };

/** el → { inert: 原本有没有 inert 属性, aria: 原本的 aria-hidden 值（没有则 null） } */
const marked = new Map();

function appEl() {
  return typeof document === 'undefined' ? null : document.getElementById('app');
}

/** 覆盖层之下的所有「背景」节点：不包含弹窗层自己 */
function backdropEls() {
  const app = appEl();
  if (!app) return [];
  const out = [];
  for (const el of app.children) {
    if (el.id === 'app-modals') continue;          // 弹窗层：覆盖层自己，不是背景
    if (el.tagName === 'SCRIPT' || el.tagName === 'INPUT') continue;   // 上传框由脚本 .click() 唤起，不参与
    if (el.id === 'toast') continue;               // 状态条：aria-live 要能被读到，关闭按钮也要能用
    out.push(el);
  }
  const lightbox = document.getElementById('lightbox');   // 灯箱在 #app 之外
  if (lightbox) out.push(lightbox);
  return out;
}

/** 该元素此刻是否必须从无障碍树里退出（分支页只在弹窗盖上来时退） */
function wanted(el) {
  if (el.id === 'branch-page') return layers.modal;
  return layers.modal || layers.branch;
}

function mark(el) {
  if (marked.has(el)) return;
  marked.set(el, { inert: el.hasAttribute('inert'), aria: el.getAttribute('aria-hidden') });
  el.setAttribute('inert', '');
  el.setAttribute('aria-hidden', 'true');
}

function unmark(el) {
  const prev = marked.get(el);
  if (!prev) return;
  marked.delete(el);
  if (!el.isConnected) return;                     // 已被换掉的节点：还原无意义
  try {
    if (prev.inert) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
    if (prev.aria === null) el.removeAttribute('aria-hidden');
    else el.setAttribute('aria-hidden', prev.aria);
  } catch (_) { /* 只读 / 分离节点：无需处理 */ }
}

function sync() {
  if (typeof document === 'undefined') return;
  const els = backdropEls();
  const keep = new Set();
  for (const el of els) {
    if (wanted(el)) { mark(el); keep.add(el); }
    else unmark(el);
  }
  // 不在当前背景清单里的旧标记（屏被换掉 / 结构变化）也收掉
  for (const el of Array.from(marked.keys())) {
    if (!keep.has(el)) unmark(el);
  }
}

/**
 * 弹窗层开合（src/ui/modalHost.js 调；bool 与该层是否还有弹窗等价）。
 * @param {boolean} open
 */
export function setModalBackdrop(open) {
  layers.modal = !!open;
  sync();
}

/**
 * 分支页开合（src/app/branch.js 调；调用时机见文件头「焦点顺序」）。
 * @param {boolean} open
 */
export function setBranchBackdrop(open) {
  layers.branch = !!open;
  sync();
}

/** 当前背景是否被惰性化（验收 / 排障用，不读 DOM） */
export function backdropActive() {
  return layers.modal || layers.branch;
}
