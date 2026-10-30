/*
 * src/ui/motion.js —— 统一 motion 模块 · DOM 端（阶段 3）
 *
 * 分工：档位语义与三档行为声明在 src/core/motion.ts（纯逻辑、Node 可测）；
 * 政策变量、@keyframes、暂停规则在 css/motion.css。本文件只做 DOM 接线：
 *
 *   applyMotion(root, pref)  解析档位并写 html[data-motion]
 *   applyPaused(root, doc)   页面不可见 → html[data-paused]
 *   suspendLoops(el)         子树挂起（分支页打开 / 舞台换画时暂停底下循环），返回恢复函数
 *   holdLoops()              过渡期循环冻结（阶段 5）：暂停所有正在跑的真实 DOM 循环，返回解冻函数
 *
 * 页面不可见 → html[data-paused]：CSS 统一暂停一切循环动画（0.12.1 起的机制，原样保留）。
 * 阶段 6：应用层（src/app/core.js）与过渡内核共用这里的实现；原来的 IR 兼容导出已删。 */
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

/** 子树挂起：分支页打开 / 舞台换画时暂停底下阅读页的循环（对应旧规则 html[data-branch="open"] #screen-game） */
export function suspendLoops(el) {
  el.setAttribute('data-loops-paused', '');
  // CSS 的 animation-play-state 在 WAAPI play() 之后不一定会把已有 Animation 收回来（Chromium 实测：
  // 计算值已是 paused，getAnimations() 的 playState 仍是 running），这里显式 pause 子树里的循环；
  // 恢复时只 play() 自己暂停的那批，且仍被挂起的（data-paused / 预算排队）不动。
  const paused = [];
  try {
    for (const anim of document.getAnimations()) {
      try {
        const target = anim.effect && anim.effect.target;
        if (!target || !el.contains(target) || !isLoopAnimation(anim)) continue;
        if (!isViewTransitionAnimation(anim) && anim.playState === 'running') {
          anim.pause();
          paused.push(anim);
        }
      } catch (_) {}
    }
  } catch (_) {}
  return () => {
    el.removeAttribute('data-loops-paused');
    for (const anim of paused) {
      try {
        if (anim.playState !== 'paused') continue;
        const target = anim.effect && anim.effect.target;
        if (target && target.isConnected === false) continue;
        if (isCssSuspended(target)) continue;
        anim.play();
      } catch (_) {}
    }
  };
}

/* ---------- 过渡期循环冻结（阶段 5） ----------
 * 为什么需要：视图过渡一开，页面被新旧两张快照盖住，但 live DOM 里的循环并没有停。
 * 过渡 220ms 后撤掉快照那一下，Ken Burns / 环境光 / 流光 / 呼吸已经从「快照里的相位」
 * 自己往前跑了 220ms —— 看起来就是跳一下。而且 ::view-transition-* 伪元素
 * 匹配不到 html[data-paused] * / [data-loop="wait"] 这类选择器，暂停要单独处理。
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

// 已被 CSS 规则挂起的循环（页面不可见 / 分支页打开 / 预算排队）：不要接管。
// 为什么不能只看 playState：分支页 open 与 VT 的 update 在同一帧里改 DOM，属性刚写上时
// 样式重算还没把 playState 变成 paused，捕获阶段会把它当成「正在跑」；过渡收尾 play()
// 又会盖掉 animation-play-state: paused，结果分支页开着、底下环境光却在跑。
function isCssSuspended(target) {
  if (!target) return false;
  try {
    if (document.documentElement.dataset.paused) return true;
    let node = target.nodeType === 1 ? target : target.parentElement;
    while (node && node !== document.documentElement) {
      if (node.hasAttribute && (node.hasAttribute('data-loops-paused') || node.getAttribute('data-loop') === 'wait')) return true;
      node = node.parentElement;
    }
  } catch (_) {}
  return false;
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
      if (isCssSuspended(anim.effect && anim.effect.target)) continue;   // 见 isCssSuspended 注释
      anim.pause();
      frozenLoops.push(anim);
    } catch (_) {}
  }
}

/** 解冻：恢复自己暂停的那些（已被移除 / 已取消的跳过） */
function resumeFrozenLoops() {
  const list = frozenLoops;
  frozenLoops = [];
  for (const anim of list) {
    try {
      if (anim.playState !== 'paused') continue;
      const target = anim.effect && anim.effect.target;
      if (target && target.isConnected === false) continue;
      // 过渡期间又挂起了（分支页 open 的 data-loops-paused 等）：保持暂停，别用 play() 盖掉 CSS 的挂起
      if (isCssSuspended(target)) { try { anim.pause(); } catch (_) {} continue; }
      anim.play();
    } catch (_) {}
  }
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

export { Motion };
