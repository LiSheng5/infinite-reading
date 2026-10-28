/*
 * src/ui/navigation.js —— 切屏的唯一入口（阶段 5 · 第 3 步）
 *
 * 为什么要有这个文件：0.12.1 起「哪块屏可见」是靠三处零散的 `classList.add/remove('hidden')`
 * 直接写 DOM 的（js/app/library.js 的 showShelf / showStart、js/app/render.js 的 enterGame），
 * 「分支页是否盖在上面」又是直接写 documentElement.dataset.branch（js/app/branch.js）。
 * 阶段 5 要给切屏接视图过渡，就必须先有**一个地方**知道「屏幕有哪几块、当前在哪块」，
 * 否则过渡内核没有稳定的收口点。
 *
 * 分工：
 *   · 本文件 = 屏幕登记表 + 显隐开关 + 分支页标记的唯一写入点（界面层只准从这里切屏）
 *   · src/ui/viewTransition.js = 过渡内核（要不要开 VT、什么时候改 DOM、降级怎么收）
 *   · src/core/motion.ts 的 TRANSITIONS.screen / stageArt = 三档 kind 与时长的唯一声明处
 *   · js/app/*.js（legacy IIFE）经 IR.Nav 调用（旧界面层与 core 模块的既定桥法）
 *
 * 公开 API：
 *   screenEl(name)            屏幕容器（home | shelf | read）
 *   screenVisible(name)       该屏当前是否可见（= 没有 .hidden）
 *   currentScreen()           当前可见的屏名（都没显示时返回 ''）
 *   showScreen(name, mutate)  切到某屏：隐藏其余、显示目标；mutate 里放这次切换要一起做的 DOM 变更
 *   stageArt(mutate)          舞台换画：共享元素 stage-art（新旧模糊副本同名），过渡期暂停 Ken Burns
 *   branchPage(open, mutate)  分支页开合：显隐 + 渲染交给 mutate；关的时候循环挂起等过渡落地再撤
 *   isTransitioning()         视图过渡是否正在跑（rich 的入场动画要等它结束）
 *   setBranchOpen(open)       分支页开合标记（html[data-branch] + data-loops-paused），循环暂停的开关
 *   isBranchOpen()            分支页是否开着
 *
 * 铁律：
 *   · 目标屏已经可见时**不跑过渡**（连点同一入口不该产生快照），mutate 照常执行。
 *   · off 档与 instant 由 viewTransition 保证同步改 DOM：焦点与滚动位置都不动（任务书「坑」）。
 *   · 屏幕名不认识时退化为「只跑 mutate」，不抛错——?ui=legacy 与半挂载状态都不至于白屏。
 *   · rich 的「淡入 + 短位移」用 WAAPI 挂在 ::view-transition-new(root) 上（见 shiftNewSnapshot）：
 *     位移不是新增 @keyframes（那要同步 motion.ts 与两个 eval 测试），只是给快照伪元素一段 transform。
 */
import { runTransition, vtActive } from './viewTransition.js';
import { suspendLoops } from './motion.js';

/** 屏幕登记表：名字 → 容器 id（切屏只认这一张表；别处不得再写 '.hidden'） */
export const SCREENS = { home: 'screen-start', shelf: 'screen-shelf', read: 'screen-game' };

/** 稳定的遍历顺序（显隐一次收敛，避免 A 隐藏 → B 显示之间出现「两屏同时可见」的中间态） */
const ORDER = ['home', 'shelf', 'read'];

const HIDDEN = 'hidden';

/** 切屏序号：每开一段真过渡自增；过渡的 update 回调靠它判断「自己是不是最新那一次」 */
let switchSeq = 0;

/** 屏幕容器（找不到就是 null：?ui=legacy / 半挂载时都可能缺） */
export function screenEl(name) {
  if (typeof document === 'undefined') return null;
  const id = SCREENS[name];
  return id ? document.getElementById(id) : null;
}

/** 该屏当前是否可见（与旧代码的 shelfVisible 同口径：不含 .hidden 即算可见） */
export function screenVisible(name) {
  const el = screenEl(name);
  return !!el && !el.classList.contains(HIDDEN);
}

/** 当前可见的屏名（都没有时返回 ''） */
export function currentScreen() {
  for (const name of ORDER) if (screenVisible(name)) return name;
  return '';
}

/** 只切显隐（不跑过渡）：把所有屏的 .hidden 一次收敛到目标状态 */
export function applyScreen(name) {
  for (const key of ORDER) {
    const el = screenEl(key);
    if (el) el.classList.toggle(HIDDEN, key !== name);
  }
}

/**
 * 切屏：隐藏其余屏、显示目标屏，再把 mutate 里的事一起做完。
 * @param {'home'|'shelf'|'read'} name 目标屏
 * @param {() => void} [mutate] 这次切换要一并改的 DOM（先切显隐，再跑它）
 * @returns {{screen: string, tier: string, kind: string, ms: number, mode: string, finished: Promise<any>}}
 */
export function showScreen(name, mutate) {
  const runMutate = () => {
    applyScreen(name);
    if (typeof mutate === 'function') mutate();
  };

  // 不认识的名字 / 屏不在 DOM 里：退化为「只跑 mutate」，不抛错也不动画
  if (!SCREENS[name] || !screenEl(name)) {
    if (typeof mutate === 'function') mutate();
    return { screen: name, tier: '', kind: 'instant', ms: 0, mode: 'instant', finished: Promise.resolve() };
  }

  // 已经在目标屏：不跑过渡（连点同一个入口不该产生快照），mutate 照常执行
  if (currentScreen() === name && screenVisible(name)) {
    if (typeof mutate === 'function') mutate();
    return { screen: name, tier: '', kind: 'instant', ms: 0, mode: 'instant', finished: Promise.resolve() };
  }

  /* 视图过渡的 update 回调是**异步**的（下一帧才跑）：等待期间用户可能又切到别的屏。
   * 用单调递增的序号作废上一段——被顶掉的那次不再改 DOM，否则会把已经离开的屏重新亮出来
   * （实测：enterGame 的过渡还没跑 update，用户已「返回首页」，旧回调又把阅读页显示了一次，
   *  而那时 S.story 已被置空，直接抛 TypeError）。 */
  const stamp = ++switchSeq;
  const guarded = () => { if (stamp === switchSeq) runMutate(); };

  // 过渡形态 / 时长全由 TRANSITIONS.screen 决定：off → 同步换、standard → 交叉淡入、
  // rich → 交叉淡入 + 短位移。降级（?vt=0 / 不支持 VT）只对目标屏做整块淡入。
  cancelShift('screen');
  const r = runTransition('screen', guarded, { scope: screenEl(name) });
  if (r.mode === 'vt' && r.kind === 'shift') shiftNewSnapshot('screen', r.ms, SHIFT_PX);
  return { screen: name, tier: r.tier, kind: r.kind, ms: r.ms, mode: r.mode, finished: r.finished };
}

/* ---------- rich 的短位移（切屏 / 分支页开合共用）----------
 * 为什么不在 css/motion.css 里写：位移需要 @keyframes，而 @keyframes 必须同步 src/core/motion.ts
 * 的 ANIMATIONS 与两份 eval 测试（任务书「坑」）；第 3 / 6 步的改动面不含那三处。这里改用 WAAPI
 * 直接给「新快照」伪元素挂一段 transform，只动合成层属性，时长由 runTransition 返回的声明值收口。
 * 浏览器不支持伪元素 WAAPI（pseudoElement）时静默放弃：只剩 css/motion.css 那三条
 * ::view-transition-* 规则给出的交叉淡入（不算失败，验收脚本也不把位移当硬要求）。
 * 按 key 分开存：切屏与分支页开合各自一段，互不 cancel（第 6 步实测：单例全局会把两段互相收掉）。 */
const SHIFT_PX = 8;              // 与 rowIn / leafIn 的 8–10px 同一量级（短位移，不是滑屏）
const shiftAnims = new Map();    // key → Animation

function cancelShift(key) {
  const a = shiftAnims.get(key);
  if (!a) return;
  try { a.cancel(); } catch (_) {}
  shiftAnims.delete(key);
}

function easeToken() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim();
    if (v) return v;
  } catch (_) {}
  return 'ease-out';
}

function shiftNewSnapshot(key, ms, fromY) {
  if (!(ms > 0) || typeof document === 'undefined') return;
  cancelShift(key);
  let anim;
  try {
    anim = document.documentElement.animate(
      [{ transform: 'translateY(' + fromY + 'px)' }, { transform: 'none' }],
      { duration: ms, easing: easeToken(), pseudoElement: '::view-transition-new(root)' },
    );
  } catch (_) {
    return;   // 伪元素 WAAPI 不可用：只保留交叉淡入，不算失败
  }
  shiftAnims.set(key, anim);
  // 收掉后清引用（被顶掉 / 被 skip 的 reject 属正常）
  const done = () => { if (shiftAnims.get(key) === anim) shiftAnims.delete(key); };
  try { anim.finished.then(done, done); } catch (_) { done(); }
}

/* ---------- 舞台换画（阶段 5 第 4 步）----------
 * 舞台的「图」有两层：上层 #stage-img（清晰图，换画时自己走 fade-swap / blur-up），
 * 下层 #stage-backdrop（同一张图的模糊放大副本，CSS 负责模糊与压暗）。换画的**共享元素**取下层：
 * 它是同一个元素、新旧图同名 stage-art，rich 档由 ::view-transition-group(stage-art) 补间。
 *
 * 名字只在这段过渡期间挂上去（同屏 view-transition-name 必须唯一，常驻会把每次切屏都拖进快照）。
 * Ken Burns 挂在 #stage-img.has-art 上：过渡期用 src/ui/motion.js 的 suspendLoops 暂停（快照会冻住它，
 * 不暂停的话结束后会从「快照里的旧相位」跳一下），结束后恢复——standard / off 本来就没有 Ken Burns。
 * 只在阅读页可见时开过渡：后台（书架 / 首页）的换画不该弹一段全屏快照。 */
const STAGE_ART_NAME = 'stage-art';

let artSeq = 0;
let artNameEl = null;
let artResume = null;

function endStageArt() {
  if (artNameEl) {
    try { artNameEl.style.viewTransitionName = ''; } catch (_) {}
    artNameEl = null;
  }
  if (artResume) {
    try { artResume(); } catch (_) {}
    artResume = null;
  }
}

/**
 * 舞台换画过渡：把真正改 DOM 的那一步交给它（models.js 的 setStageArt）。
 * @param {() => void} mutate 改 #stage-backdrop 的 background-image / .show 的同步函数
 */
export function stageArt(mutate) {
  const run = typeof mutate === 'function' ? mutate : () => {};
  const bd = typeof document !== 'undefined' ? document.getElementById('stage-backdrop') : null;
  const wrap = typeof document !== 'undefined' ? document.getElementById('stage-wrap') : null;
  if (!bd || currentScreen() !== 'read') {
    run();   // 没有舞台 / 不在阅读页：直接换，不开快照
    return { stage: 'stageArt', tier: '', kind: 'instant', ms: 0, mode: 'instant', finished: Promise.resolve() };
  }

  const stamp = ++artSeq;
  endStageArt();   // 连切：上一段的名字与循环暂停先收干净，别叠第二对快照
  bd.style.viewTransitionName = STAGE_ART_NAME;
  artNameEl = bd;
  if (wrap) artResume = suspendLoops(wrap);

  const r = runTransition('stageArt', run, { scope: bd });
  const finish = () => { if (stamp === artSeq) endStageArt(); };
  r.finished.then(finish, finish);
  return { stage: 'stageArt', tier: r.tier, kind: r.kind, ms: r.ms, mode: r.mode, finished: r.finished };
}

/* ---------- 分支页标记（html[data-branch] + 底下阅读页的循环挂起）----------
 * 全仓唯一写入点。两件事必须成对：标记本身（css/motion.css 的旧屏循环暂停规则、验收脚本都读它）
 * 与 data-loops-paused（src/ui/motion.js 的 suspendLoops，Svelte 阅读页重写后选择器会换，属性更稳）。
 * 只用标记不挂起的话，退出阅读页重写后 css 那条 `#screen-game *` 规则迟早要跟着改。 */
let branchSuspend = null;

export function setBranchOpen(open) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const read = screenEl('read');
  if (open) {
    root.dataset.branch = 'open';
    if (read && !branchSuspend) branchSuspend = suspendLoops(read);
  } else {
    delete root.dataset.branch;
    if (branchSuspend) {
      try { branchSuspend(); } catch (_) {}
      branchSuspend = null;
    }
  }
}

export function isBranchOpen() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.dataset.branch === 'open';
}

/* ---------- 分支页开合（阶段 5 第 6 步）----------
 * 与 showScreen 同构：过渡形态 / 时长全由 TRANSITIONS.branchPage 决定
 *   off      → 同步切（焦点与滚动位置都不动）
 *   standard → root 交叉淡入（分支页不命名，整屏换页）
 *   rich     → 交叉淡入 + 新快照 translateY(±8px) 短位移（开 = 从下往上，关 = 往上退）
 * 降级（?vt=0 / 不支持 VT）→ 只对 scope 做整块淡入：开 = 分支页，关 = 阅读页。
 *
 * 调用约定（js/app/branch.js 侧）：
 *   mutate 里只做「显隐 + 渲染 + 焦点」这类必须与新快照同一帧的 DOM 变更；
 *   过渡结束（或被下一段顶掉）后不再回调 —— 需要收尾的（centering / 入场动画 / 焦点还原）
 *   由调用方拿 finished 自己接。
 *
 * 循环暂停的时序（任务书「坑」）：开 → 标记在 mutate 里立刻写上（新快照里底下阅读页已是暂停相位）；
 * 关 → 标记等 finished 再撤（否则新快照拍的是暂停相位、结算后 live 已推进，Ken Burns 会跳一下）。
 */
const BRANCH_SHIFT_PX = 8;

let branchSeq = 0;
let branchWanted = false;     // 最近一次请求的开合态（DOM 标记在关的时候会滞后到 finished）

export function branchPage(open, mutate) {
  const want = !!open;
  const run = typeof mutate === 'function' ? mutate : () => {};
  const instant = (mode) => ({ branch: want ? 'open' : 'close', tier: '', kind: 'instant', ms: 0, mode: mode || 'instant', finished: Promise.resolve() });
  const page = typeof document !== 'undefined' ? document.getElementById('branch-page') : null;

  // 屏不在（?ui=legacy 半挂载 / 极早期）：只跑 mutate，不抛错也不动画
  if (!page) { run(); return instant(); }

  // 连点同一个入口：不跑过渡（不出第二对快照），mutate 照常跑
  if (branchWanted === want) { run(); return instant(); }
  branchWanted = want;

  const stamp = ++branchSeq;
  cancelShift('branchPage');
  const scope = want ? page : screenEl('read');
  const r = runTransition('branchPage', () => {
    if (stamp !== branchSeq) return;
    if (want) setBranchOpen(true);   // 开：快照前就把底下阅读页的循环挂起
    run();
  }, { scope });
  if (r.mode === 'vt' && r.kind === 'shift') {
    shiftNewSnapshot('branchPage', r.ms, want ? BRANCH_SHIFT_PX : -BRANCH_SHIFT_PX);
  }

  const finish = () => {
    if (stamp !== branchSeq) return;          // 被下一段顶掉：不碰状态
    if (!want) setBranchOpen(false);          // 关：等快照落地再放开底下循环
  };
  if (r.mode === 'instant') finish();
  else r.finished.then(finish, finish);

  return { branch: want ? 'open' : 'close', tier: r.tier, kind: r.kind, ms: r.ms, mode: r.mode, finished: r.finished };
}

/** 视图过渡是否正在跑（快照期）：rich 的入场动画要等它结束再开，否则会被拍成空白页 */
export function isTransitioning() {
  return vtActive();
}

/* ---------- IR 兼容层（legacy 界面层的既定桥法；阶段 6 随 IR 一起删） ---------- */
export const Nav = {
  SCREENS,
  ORDER: ORDER.slice(),
  screenEl,
  screenVisible,
  currentScreen,
  applyScreen,
  showScreen,
  stageArt,
  branchPage,
  isTransitioning,
  setBranchOpen,
  isBranchOpen,
};

const g = globalThis;
g.IR = g.IR || {};
g.IR.Nav = Nav;
