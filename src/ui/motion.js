/*
 * src/ui/motion.js —— 统一 motion 模块 · DOM 端（阶段 3，任务书 §6.2）
 *
 * 分工：档位语义与三档行为声明在 src/core/motion.ts（纯逻辑、Node 可测）；
 * 政策变量、@keyframes、暂停规则在 css/motion.css。本文件只做 DOM 接线：
 *
 *   initMotion(opts)  一站式：写 html[data-motion] + 跟随系统「减少动态效果」+ 页面不可见暂停
 *   registerLoop(el)  循环动画登记（同屏 ≤ Motion.LOOP_BUDGET 组，超出者挂 data-loop="wait" 暂停）
 *   suspendLoops(el)  子树挂起（分支页打开时暂停底下阅读页的循环），返回恢复函数
 *
 * 页面不可见 → html[data-paused]：CSS 统一暂停一切循环动画（0.12.1 起的机制，原样保留）。
 * 旧界面层（js/app/core.js 的 applyMotion / applyPaused）仍走 IR.Motion 自己接线，行为一致；
 * 新组件与阶段 4 起重写的屏幕统一从这里拿。 */
import { Motion } from '../core/motion.ts';

const REDUCED_MQ = '(prefers-reduced-motion: reduce)';

/** 当前档位：pref 为用户设置（'auto' | 'off' | 'standard' | 'rich'），显式选择优先于系统偏好 */
export function resolveLevel(pref, root) {
  const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(REDUCED_MQ) : null;
  return Motion.resolve(pref, !!(mq && mq.matches));
}

/** 把档位写进 html[data-motion]（CSS 档位规则的唯一开关），返回落定的档位 */
export function applyMotion(root, pref) {
  const level = resolveLevel(pref, root);
  root.dataset.motion = level;
  return level;
}

/** 页面不可见 → html[data-paused]（CSS 暂停一切循环动画） */
export function applyPaused(root, doc) {
  if (doc.hidden) root.dataset.paused = '1';
  else delete root.dataset.paused;
}

/* ---------- 循环动画预算（同屏 ≤ Motion.LOOP_BUDGET 组） ----------
 * 登记按先来后到占坑；超出预算的挂 data-loop="wait"（CSS 暂停它），有坑腾出再放行。
 * 一组 = 一个 DOM 元素上的循环动画；同名 keyframes 的错相多实例（首页符号波）只登记容器一次。 */
const loops = [];

function reconcileLoops() {
  const budget = Motion.LOOP_BUDGET;
  loops.forEach((el, i) => {
    if (i >= budget) el.setAttribute('data-loop', 'wait');
    else el.removeAttribute('data-loop');
  });
}

export function registerLoop(el) {
  if (loops.indexOf(el) < 0) loops.push(el);
  reconcileLoops();
  return () => {
    const i = loops.indexOf(el);
    if (i >= 0) loops.splice(i, 1);
    el.removeAttribute('data-loop');
    reconcileLoops();
  };
}

/** 子树挂起：分支页打开时暂停底下阅读页的循环（对应旧规则 html[data-branch="open"] #screen-game） */
export function suspendLoops(el) {
  el.setAttribute('data-loops-paused', '');
  return () => el.removeAttribute('data-loops-paused');
}

/** 一站式接线：档位 + 系统偏好跟随 + 页面可见性。返回 { level, setPref, destroy }。 */
export function initMotion({ getPref = () => 'auto', root = document.documentElement, doc = document } = {}) {
  let prefFn = getPref;

  const refresh = () => applyMotion(root, prefFn());
  refresh();
  applyPaused(root, doc);

  const onVisibility = () => applyPaused(root, doc);
  doc.addEventListener('visibilitychange', onVisibility);

  const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(REDUCED_MQ) : null;
  const onMQ = () => refresh();
  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', onMQ);
    else if (mq.addListener) mq.addListener(onMQ);
  }

  return {
    level: () => root.dataset.motion,
    setPref(fn) { prefFn = fn; refresh(); },
    destroy() {
      doc.removeEventListener('visibilitychange', onVisibility);
      if (mq) {
        if (mq.removeEventListener) mq.removeEventListener('change', onMQ);
        else if (mq.removeListener) mq.removeListener(onMQ);
      }
    },
  };
}

export { Motion };
