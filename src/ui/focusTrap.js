/*
 * src/ui/focusTrap.js —— 对话框焦点陷阱
 *
 * aria-modal="true" 的承诺是「Tab 只在弹窗里转」：只写属性不拦 Tab，键盘用户会一路
 * Tab 到被遮罩盖住的页面上（看不见焦点，却可能误触按钮）。这里补上最小实现：
 *   · 打开时把焦点送进对话框（可指定 initial 选择器）；
 *   · Tab / Shift+Tab 在对话框内循环，尽头绕回另一端；
 *   · 关闭时若焦点还在对话框里，收回到打开前的元素。
 *
 * 只做「键盘焦点」这一件事：不改 DOM、不加 inert、不锁滚动，也不接管 Esc
 * （Esc 的唯一入口仍是 src/app/main.js 的 closeTopModal / 各弹窗自己的关闭函数）。
 * 嵌套弹窗安全：每层只监听自己的根节点，事件只会在自己这层冒泡；外层不会抢内层的焦点。
 */

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

function visible(el) {
  if (!el || el.disabled) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
  return el.tabIndex >= 0;
}

/** 对话框内可 Tab 到的元素，按 DOM 顺序 */
export function focusables(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(visible);
}

/** 把焦点送进 root（默认第一个可聚焦元素）；返回是否成功 */
export function focusFirst(root, selector) {
  if (!root) return false;
  const wanted = selector ? root.querySelector(selector) : null;
  const target = (wanted && visible(wanted)) ? wanted : focusables(root)[0];
  if (!target || typeof target.focus !== 'function') return false;
  try { target.focus({ preventScroll: true }); return true; } catch (_) {
    try { target.focus(); return true; } catch (__) { return false; }
  }
}

/**
 * 在 root 上装焦点陷阱。
 * @param {HTMLElement} root 对话框根节点（弹窗容器 / 整页分支页）
 * @param {{ initial?: string|false, restore?: boolean }} [opts]
 *   initial: 初始焦点选择器；false = 不动焦点（调用方自己会 focus）
 *   restore: 关闭时是否把焦点还回打开前的元素（默认 true）
 * @returns {() => void} 卸载函数（幂等）
 */
export function trapFocus(root, opts) {
  const o = opts || {};
  if (!root || typeof document === 'undefined') return () => {};
  const prevFocus = o.restore === false ? null : document.activeElement;

  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = focusables(root);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!root.contains(active)) {
      // 焦点被脚本放到了对话框外：下一次 Tab 先收回来
      e.preventDefault();
      try { (e.shiftKey ? last : first).focus({ preventScroll: true }); } catch (_) {}
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      try { last.focus({ preventScroll: true }); } catch (_) {}
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      try { first.focus({ preventScroll: true }); } catch (_) {}
    }
  };

  root.addEventListener('keydown', onKey);
  if (o.initial !== false) {
    const ok = focusFirst(root, typeof o.initial === 'string' ? o.initial : '');
    // 没有任何可聚焦元素：至少让根节点接住键盘（Tab 已被拦下，不会穿透到页面）
    if (!ok && typeof root.focus === 'function') {
      if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
      try { root.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    root.removeEventListener('keydown', onKey);
    if (!prevFocus || !prevFocus.isConnected) return;
    const active = document.activeElement;
    // 只在焦点仍留在本对话框里时收回：不抢脚本 / 用户新放上去的焦点
    if (active && active !== document.body && root.contains(active)) {
      try { prevFocus.focus({ preventScroll: true }); } catch (_) {}
    }
  };
}
