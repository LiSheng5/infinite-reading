/*
 * src/ui/viewTransition.js —— 过渡内核（阶段 5）
 *
 * 分工：
 *   · src/core/motion.ts 的 TRANSITIONS = 每个过渡动作（切屏 / 舞台换画 / 分支切换 / 分支页开合 /
 *     弹窗开合）三档 kind 与时长的**唯一声明处**；TIERS = 三档上限。
 *   · css/motion.css 的 ::view-transition-* = 快照动画本身的时长 / 缓动收口（--m-dur-vt-*）。
 *   · 本文件只做「要不要开 VT、什么时候改 DOM、降级怎么收」这三件事。
 *
 *   runTransition(name, mutate, opts) → { name, tier, kind, ms, mode, finished }
 *     name    TRANSITIONS 里的过渡名（未登记的名字按档位默认政策兜底）
 *     mutate  真正改 DOM 的函数（同步执行；不要在它里面 await）
 *     opts    { root = documentElement, scope = #app }  root 读 data-motion，scope 是降级淡入的范围
 *     mode    'vt'（原生 View Transition）| 'fade'（降级淡入）| 'instant'（同步换、不动画）
 *
 *   supportsVT()            浏览器是否原生支持 document.startViewTransition（纯能力探测）
 *   vtDisabled()            URL 带 ?vt=0 —— 强制降级（验收 / 排障用；file:// 也认）
 *   skipActiveTransition()  收掉正在跑的过渡（连续触发前先收，避免快照残留）
 *
 * 铁律：
 *   · off 档同步执行 mutate（绝不 await 后再改 DOM：焦点与滚动位置会跳）。
 *   · 连续触发必须先 skipTransition() 收掉上一段，否则旧快照残留。
 *   · 降级（?vt=0 / 浏览器不支持）只做「整块淡入」：位移属 rich/standard 的上限，不能外溢到降级路径。
 *   · 快照会冻结循环动画：新快照拍摄前由 holdLoops() 把 live DOM 的循环停在同一相位，
 *     过渡收尾（含被 skip）再 play() 回来；::view-transition-* 匹配不到 html[data-paused] *
 *     这类普通选择器，所以暂停只能走 WAAPI（实现与边界见 src/ui/motion.js）。
 */
import { Motion } from '../core/motion.ts';
import { holdLoops } from './motion.js';

const LEVELS = ['off', 'standard', 'rich'];

function tierOf(root) {
  const v = root && root.dataset ? root.dataset.motion : '';
  return LEVELS.indexOf(v) >= 0 ? v : 'rich';   // 没写 data-motion 时与 :root 默认一致（rich）
}

/** 浏览器是否原生支持 View Transition（纯能力探测；?vt=0 的强制降级见 vtDisabled） */
export function supportsVT() {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function';
}

/** ?vt=0：强制降级到「淡入」路径（验收 / 排障开关；file:// 下 location.search 同样有效） */
export function vtDisabled() {
  try {
    return new URLSearchParams(window.location.search).get('vt') === '0';
  } catch (_) {
    return false;
  }
}

/** 视图过渡是否正在跑（阶段 5：rich 的分支页入场动画要等它结束再开） */
export function vtActive() {
  return !!activeVT;
}

/** 某个过渡动作在某档下的声明：{ kind, ms }；未登记的名字按档位默认政策兜底 */
export function transitionSpec(name, tier) {
  const lv = LEVELS.indexOf(tier) >= 0 ? tier : 'rich';
  const spec = Motion.TRANSITIONS && Motion.TRANSITIONS[name];
  if (spec && spec[lv]) return spec[lv];
  if (lv === 'off') return { kind: 'instant', ms: 0 };
  const cap = lv === 'standard' ? Motion.TIERS[lv].maxOpacityMs : Motion.TIERS[lv].maxShiftMs;
  return { kind: lv === 'standard' ? 'fade' : 'shift', ms: cap };
}

/* 正在跑的过渡：VT 实例 / 降级淡入动画。连续触发时先收掉，避免快照残留与叠帧。 */
let activeVT = null;
let activeFade = null;

function cancelFade() {
  if (!activeFade) return;
  try { activeFade.cancel(); } catch (_) {}
  activeFade = null;
}

/** 收掉正在跑的过渡（连续触发前调用；VT 走 skipTransition，降级淡入走 cancel） */
export function skipActiveTransition() {
  if (activeVT) {
    try { if (typeof activeVT.skipTransition === 'function') activeVT.skipTransition(); } catch (_) {}
    activeVT = null;
  }
  cancelFade();
}

function runNow(mutate) {
  return typeof mutate === 'function' ? mutate() : undefined;
}

function readEase(scope) {
  try {
    const v = getComputedStyle(scope).getPropertyValue('--ease-out').trim();
    if (v) return v;
  } catch (_) {}
  return 'ease-out';
}

// 降级：先换 DOM，再对范围做一次整块淡入（时长按声明与档位上限取小；off 的 ms 为 0 → 直接返回）
function downgrade(ctx, mutate, opts) {
  const { name, tier, kind, ms } = ctx;
  const scope = (opts && opts.scope) || (typeof document !== 'undefined' ? document.getElementById('app') : null);
  const value = runNow(mutate);
  const dur = Math.min(ms, Motion.TIERS[tier].maxOpacityMs);
  if (!scope || typeof scope.animate !== 'function' || !(dur > 0)) {
    return { name, tier, kind: 'instant', ms: 0, mode: 'instant', finished: Promise.resolve(value) };
  }
  cancelFade();
  let anim;
  try {
    anim = scope.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur, easing: readEase(scope), fill: 'none' });
  } catch (_) {
    return { name, tier, kind: 'instant', ms: 0, mode: 'instant', finished: Promise.resolve(value) };
  }
  activeFade = anim;
  const finished = anim.finished.then(
    () => { if (activeFade === anim) activeFade = null; },
    () => { if (activeFade === anim) activeFade = null; },   // 被打断（cancel）属正常
  );
  return { name, tier, kind, ms: dur, mode: 'fade', finished };
}

/**
 * 跑一段过渡：先按当前档位决定形态，再改 DOM。
 * @param {string} name TRANSITIONS 里的名字（screen / stageArt / sibling / branchPage / modal）
 * @param {() => void} mutate 同步改 DOM 的函数
 * @param {{root?: HTMLElement, scope?: HTMLElement}} [opts] root 读 data-motion；scope 是降级淡入范围
 * @returns {{name: string, tier: string, kind: string, ms: number, mode: 'vt'|'fade'|'instant', finished: Promise<any>}}
 */
export function runTransition(name, mutate, opts) {
  const root = (opts && opts.root) || (typeof document !== 'undefined' ? document.documentElement : null);
  const tier = tierOf(root);
  const spec = transitionSpec(name, tier);
  const ctx = { name, tier, kind: spec.kind, ms: spec.ms };

  // off 档 / 声明为即时：同步换 DOM（焦点与滚动位置都不动）
  if (tier === 'off' || spec.kind === 'instant' || !(spec.ms > 0)) {
    const value = runNow(mutate);
    return { name, tier, kind: 'instant', ms: 0, mode: 'instant', finished: Promise.resolve(value) };
  }

  // 原生 View Transition：动画本身由 css/motion.css 的 ::view-transition-* 规则提供
  if (!vtDisabled() && supportsVT()) {
    skipActiveTransition();
    let releaseLoops = null;
    let settled = false;
    /* 循环冻结放在 update 回调里、mutate 之后：新快照拍的就是暂停相位，撤快照时 live DOM
     * 从同一相位继续，不会跳。上一段被 skip 时它的解冻只减计数（见 holdLoops 的计数式释放）。 */
    const freezeLoops = () => {
      if (settled || releaseLoops) return;
      releaseLoops = holdLoops();
    };
    let vt;
    try {
      vt = document.startViewTransition(() => {
        runNow(mutate);
        freezeLoops();
      });
    } catch (_) {
      settled = true;
      if (releaseLoops) { try { releaseLoops(); } catch (__) {} }
      return downgrade(ctx, mutate, opts);   // 文档不可见 / 上一段还没收干净 → 降级
    }
    activeVT = vt;
    const finish = () => {
      settled = true;
      if (releaseLoops) {
        try { releaseLoops(); } catch (_) {}
        releaseLoops = null;
      }
      if (activeVT === vt) activeVT = null;
    };
    /* ready 也必须接住：skipTransition()（连点被后一段顶掉 / 的快速切屏）会让它以
     * AbortError 拒绝，没人处理就是一条 unhandledrejection（Chromium 记为 pageerror）。
     * 接真实切屏时实测到，补这一行；finished 那条下面已经有拒绝分支。 */
    try { vt.ready.then(() => {}, () => {}); } catch (_) {}
    const finished = vt.finished.then(finish, finish);   // skip / 被后一段顶掉属正常，也要解冻
    return { name, tier, kind: spec.kind, ms: spec.ms, mode: 'vt', finished };
  }

  // ?vt=0 / 浏览器不支持：淡入降级
  return downgrade(ctx, mutate, opts);
}
