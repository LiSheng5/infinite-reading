/*
 * src/ui/canvasStage.js —— canvas 逐帧组件的挂载脚手架 + 首页主视觉的令牌色带
 *
 * 三个 canvas 组件（首页 InfinityStage / GridStage、阅读页 PaintInk）原各抄了一份
 * 「MutationObserver(data-paused) + visibilitychange + reduced-motion + ResizeObserver + rAF + 清理」，
 * 暂停口径还不一致（只认 html[data-paused]，漏掉分支页写入的 data-loops-paused）。
 * 现在收口到这里的 mountCanvas：
 *
 *   · 暂停判定 = src/ui/motion.js 的 isSuspended——与 CSS 循环同一套
 *     （页面不可见 / html[data-paused] / 自身或祖先 data-loops-paused / data-loop="wait"），
 *     分支页打开时 canvas 与 CSS 循环一起停，不再各停一半；
 *   · 播放状态变化 → onMotion()（组件重置累加器 / 节拍基准）；
 *   · 只有播放中才调 step(deltaMs)，返回 true 表示「这一帧有新内容」→ 调 draw()；
 *   · 挂载即建尺寸观察 + rAF，返回的清理函数供 onMount 里 return。
 *
 * readInkRamp / rampAt —— 首页两颗主视觉共用的 --inf-light / --accent / --inf-deep 色带：
 * 一边读令牌、一边写死 RGB 会漂色，改令牌时两颗一起变。
 */
import { isSuspended } from './motion.js';

// 三档色标的位次（与 tokens.css 的 --inf-* 三色一致）
export const INK_STOPS = [0, 0.55, 1];

// 解析失败时的退路：值与 tokens.css 的 --inf-light / --accent / --inf-deep 一致
export const INK_RAMP_FALLBACK = [
  [96, 165, 250],
  [37, 99, 235],
  [30, 58, 138],
];

// CSS 颜色（#rgb / #rrggbb / rgb() / rgba()）→ [r, g, b]；认不出就用退路
export function parseCssColor(raw, fallback) {
  const value = String(raw == null ? '' : raw).trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1].length === 3
      ? hex[1][0] + hex[1][0] + hex[1][1] + hex[1][1] + hex[1][2] + hex[1][2]
      : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(value);
  return rgb ? [+rgb[1], +rgb[2], +rgb[3]] : fallback;
}

/** 从 :root 读首页主视觉色带（窗口尺寸变化时重读一次即可跟上主题切换） */
export function readInkRamp() {
  const fallback = INK_RAMP_FALLBACK;
  if (typeof window === 'undefined' || !window.getComputedStyle) return fallback;
  const styles = window.getComputedStyle(document.documentElement);
  return [
    parseCssColor(styles.getPropertyValue('--inf-light'), fallback[0]),
    parseCssColor(styles.getPropertyValue('--accent'), fallback[1]),
    parseCssColor(styles.getPropertyValue('--inf-deep'), fallback[2]),
  ];
}

/** 色带取色：value ∈ [0,1] 落在 stops 上线性插值 */
export function rampAt(value, ramp, stops) {
  const marks = stops || INK_STOPS;
  const v = value < 0 ? 0 : value > 1 ? 1 : value;
  for (let i = 1; i < marks.length; i += 1) {
    if (v <= marks[i]) {
      const left = ramp[i - 1];
      const right = ramp[i];
      const span = marks[i] - marks[i - 1];
      const t = span === 0 ? 0 : (v - marks[i - 1]) / span;
      return [
        Math.round(left[0] + (right[0] - left[0]) * t),
        Math.round(left[1] + (right[1] - left[1]) * t),
        Math.round(left[2] + (right[2] - left[2]) * t),
      ];
    }
  }
  return ramp[ramp.length - 1];
}

/**
 * canvas 逐帧组件的挂载脚手架。
 * @param {object} o
 * @param {Element} o.target            尺寸观察目标（容器）
 * @param {() => void} o.resize         重算画布尺寸 / 网格（内部可不标脏，脚手架会）
 * @param {() => void} o.draw           同步画一帧
 * @param {(deltaMs: number) => boolean} o.step  播放中每帧调用；返回 true = 需要重画
 * @param {() => void} [o.onMotion]     播放状态变化时调用（重置累加器）
 * @param {boolean} [o.staticFrame]     挂载时先同步画一帧（后台标签页 rAF 被暂停也有画面）
 * @returns {() => void} 清理函数（onMount 直接 return 它）
 */
export function mountCanvas(o) {
  const html = document.documentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let playing = false;
  let dirty = true;
  let rafId = 0;
  let lastFrame = 0;

  /* 播放状态变化：重置节拍基准（恢复时不要按陈旧的时间差补一大段相位） */
  function syncMotion() {
    const next = !reducedMotion.matches && !isSuspended(o.target);
    if (next !== playing) {
      playing = next;
      lastFrame = 0;
      if (typeof o.onMotion === 'function') o.onMotion();
    }
    dirty = true;
  }

  function onResize() {
    o.resize();
    dirty = true;
  }

  // 暂停口径来自属性：data-paused（页面不可见）/ data-loops-paused（子树挂起）/ data-loop="wait"
  const motionObserver = new MutationObserver(syncMotion);
  motionObserver.observe(html, {
    attributes: true,
    subtree: true,
    attributeFilter: ['data-paused', 'data-loops-paused', 'data-loop'],
  });
  document.addEventListener('visibilitychange', syncMotion);
  reducedMotion.addEventListener('change', syncMotion);

  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(onResize)
    : null;
  if (resizeObserver) resizeObserver.observe(o.target);
  else window.addEventListener('resize', onResize);

  function tick(now) {
    rafId = window.requestAnimationFrame(tick);
    if (!lastFrame) lastFrame = now;
    const delta = Math.min(now - lastFrame, 200);   // 切回前台 / 长任务后不补一大段
    lastFrame = now;
    if (playing && o.step(delta)) dirty = true;
    if (dirty) {
      o.draw();
      dirty = false;
    }
  }

  o.resize();
  syncMotion();
  if (o.staticFrame) {
    o.draw();
    dirty = false;
  }
  rafId = window.requestAnimationFrame(tick);

  return function stopCanvas() {
    window.cancelAnimationFrame(rafId);
    motionObserver.disconnect();
    document.removeEventListener('visibilitychange', syncMotion);
    reducedMotion.removeEventListener('change', syncMotion);
    if (resizeObserver) resizeObserver.disconnect();
    else window.removeEventListener('resize', onResize);
  };
}
