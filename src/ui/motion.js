/*
 * src/ui/motion.js —— 统一 motion 模块 · DOM 端（阶段 3，任务书 §6.2）
 *
 * 分工：档位语义与三档行为声明在 src/core/motion.ts（纯逻辑、Node 可测）；
 * 政策变量、@keyframes、暂停规则在 css/motion.css。本文件只做 DOM 接线：
 *
 *   initMotion(opts)  一站式：写 html[data-motion] + 跟随系统「减少动态效果」+ 页面不可见暂停
 *   registerLoop(el)  循环动画登记（同屏 ≤ Motion.LOOP_BUDGET 组，超出者挂 data-loop="wait" 暂停）
 *   suspendLoops(el)  子树挂起（分支页打开时暂停底下阅读页的循环），返回恢复函数
 *   holdLoops()       过渡期循环冻结（阶段 5）：暂停所有正在跑的真实 DOM 循环，返回解冻函数
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

/* 过渡冻结期间只记账、不重排（阶段 5 第 8 步）：过渡中途换屏 / 挂载新屏时，
 * 旧的一组刚释放、新的一组刚登记，同一帧重排会把「谁在预算里」抖动一次；
 * 解冻时统一收敛（见 resumeFrozenLoops），也正好对应任务书「过渡期间不重复计循环预算」。 */
function reconcileLoops() {
  if (holdDepth > 0) { budgetDirty = true; return; }
  const budget = Motion.LOOP_BUDGET;
  loops.forEach((el, i) => {
    if (i >= budget) el.setAttribute('data-loop', 'wait');
    else el.removeAttribute('data-loop');
  });
  budgetDirty = false;
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

/* ---------- 过渡期循环冻结（阶段 5 第 8 步） ----------
 * 为什么需要：视图过渡一开，页面被新旧两张快照盖住，但 live DOM 里的循环并没有停。
 * 过渡 220ms 后撤掉快照那一下，Ken Burns / 环境光 / 流光 / 呼吸已经从「快照里的相位」
 * 自己往前跑了 220ms —— 看起来就是跳一下。任务书「坑」也点名：::view-transition-*
 * 伪元素匹配不到 html[data-paused] * / [data-loop="wait"] 这类选择器，暂停要单独处理。
 *
 * 做法：在 VT 的 update 回调里（新快照拍摄之前）把所有**正在跑**的真实 DOM 循环暂停，
 * 过渡收尾（含 skipTransition / 被下一段顶掉）再逐个 play() —— 只恢复自己暂停的那些：
 * 本来就因 data-paused / data-loop="wait" / data-loops-paused 停着的不动。
 *
 * 三条边界：
 *   · 只认循环（iterations 无限或 >1）；一次性的入场动画不归这里管（各屏自己让位 / 等过渡结束再开）。
 *   · 跳过 ::view-transition-* 伪元素自己的动画（暂停它们等于把过渡停住）。
 *   · 计数式：过渡 A 被 B 顶掉时，A 的解冻只减计数，最后一个解冻才真正 play()，
 *     避免 A 收尾把 B 刚停下的循环又放开。
 */
let holdDepth = 0;
let frozenLoops = [];
let budgetDirty = false;

function isViewTransitionAnimation(anim) {
  try {
    const p = anim.effect && anim.effect.pseudoElement;
    return !!p && p.indexOf('::view-transition') === 0;
  } catch (_) {
    return false;
  }
}

function isLoopAnimation(anim) {
  try {
    const t = anim.effect.getTiming();
    return !Number.isFinite(t.iterations) || t.iterations > 1;
  } catch (_) {
    return false;
  }
}

function captureRunningLoops() {
  if (typeof document === 'undefined' || typeof document.getAnimations !== 'function') return;
  let list = [];
  try { list = document.getAnimations(); } catch (_) { return; }
  for (const anim of list) {
    try {
      if (anim.playState !== 'running') continue;   // 已停着的（data-paused / 预算排队）不接管
      if (isViewTransitionAnimation(anim) || !isLoopAnimation(anim)) continue;
      if (frozenLoops.indexOf(anim) >= 0) continue;
      anim.pause();
      frozenLoops.push(anim);
    } catch (_) {}
  }
}

/** 解冻：恢复自己暂停的那些（已被移除 / 已取消的跳过），再统一收敛一次循环预算 */
function resumeFrozenLoops() {
  const list = frozenLoops;
  frozenLoops = [];
  for (const anim of list) {
    try {
      if (anim.playState !== 'paused') continue;
      const target = anim.effect && anim.effect.target;
      if (target && target.isConnected === false) continue;
      anim.play();
    } catch (_) {}
  }
  if (budgetDirty) reconcileLoops();
}

/**
 * 过渡期冻结循环（src/ui/viewTransition.js 在 VT 的 update 回调里调用）。
 * @returns {() => void} 解冻函数（幂等；最后一个解冻才真正恢复播放）
 */
export function holdLoops() {
  holdDepth += 1;
  captureRunningLoops();
  let released = false;
  return function releaseLoops() {
    if (released) return;
    released = true;
    holdDepth = Math.max(0, holdDepth - 1);
    if (holdDepth === 0) resumeFrozenLoops();
  };
}

/** 过渡是否正冻结着循环（验收 / 排障用） */
export function loopsHeld() {
  return holdDepth > 0;
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

/* ---------- IR 兼容层（验收脚本 / legacy 排查用；阶段 6 随 IR 一起删） ---------- */
const g = globalThis;
g.IR = g.IR || {};
g.IR.MotionDOM = {
  applyMotion,
  applyPaused,
  initMotion,
  registerLoop,
  suspendLoops,
  holdLoops,
  loopsHeld,
};
