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
 *   setBranchOpen(open)       分支页开合标记（html[data-branch]），循环暂停规则的开关
 *   isBranchOpen()            分支页是否开着
 *
 * 铁律：
 *   · 目标屏已经可见时**不跑过渡**（连点同一入口不该产生快照），mutate 照常执行。
 *   · off 档与 instant 由 viewTransition 保证同步改 DOM：焦点与滚动位置都不动（任务书「坑」）。
 *   · 屏幕名不认识时退化为「只跑 mutate」，不抛错——?ui=legacy 与半挂载状态都不至于白屏。
 */
import { runTransition } from './viewTransition.js';

/** 屏幕登记表：名字 → 容器 id（切屏只认这一张表；别处不得再写 '.hidden'） */
export const SCREENS = { home: 'screen-start', shelf: 'screen-shelf', read: 'screen-game' };

/** 稳定的遍历顺序（显隐一次收敛，避免 A 隐藏 → B 显示之间出现「两屏同时可见」的中间态） */
const ORDER = ['home', 'shelf', 'read'];

const HIDDEN = 'hidden';

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
    runMutate();
    return { screen: name, tier: '', kind: 'instant', ms: 0, mode: 'instant', finished: Promise.resolve() };
  }

  runMutate();
  return { screen: name, tier: '', kind: 'instant', ms: 0, mode: 'instant', finished: Promise.resolve() };
}

/* ---------- 分支页标记（html[data-branch]）----------
 * 全仓唯一写入点：css/motion.css 的旧屏循环暂停规则、阶段 6 的分支页过渡都读这一个标记。 */
export function setBranchOpen(open) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (open) root.dataset.branch = 'open';
  else delete root.dataset.branch;
}

export function isBranchOpen() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.dataset.branch === 'open';
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
  setBranchOpen,
  isBranchOpen,
};

const g = globalThis;
g.IR = g.IR || {};
g.IR.Nav = Nav;
