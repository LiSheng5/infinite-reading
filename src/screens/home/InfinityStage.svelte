<script>
  /* 首页主视觉：只留一颗流动的双纽线符号（canvas 逐字粒子）
   *
   * 曲线的参数式取自伯努利双纽线的近似投影：x = sin t，y = sin 2t，z = cos t，
   * 再按时间做一次很慢的偏航 / 俯仰旋转，让平面上的 ∞ 有厚度。
   * 每个采样点按「色带相位 + 深度 + 头部闪光」算能量，决定字符（. : + * #）与蓝色深浅。
   * 页面是白底，所以不叠「lighter」发光：波峰用深蓝压住纸面，波谷用淡蓝 + 低透明度融回去。
   *
   * 与项目动效纪律的接法：
   *   · 逐帧绘制在 canvas 里，不走 CSS @keyframes；系统「减少动效」、页面不可见时停在当前帧；
   *   · 没有按钮 / 滑杆 / 角标：符号就是全部内容，不拦点击，也不拦滚轮；
   *   · 画布两端色从 --inf-light / --accent / --inf-deep 读（见 css/tokens.css），
   *     画布内容色不算 UI 配色，但仍然跟着令牌走，不在脚本里另抄一份色值。
   */
  import { onMount } from 'svelte';

  let canvasEl;

  let ctx = null;
  let isPlaying = false;
  let needsRender = true;
  let clock = 0;
  let lastFrame = 0;
  let rafId = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let sampleCount = 190;
  let glyphFont = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  const TAU = Math.PI * 2;
  const LOOP_SECONDS = 8.4;
  const GLYPHS = ['.', ':', '+', '*', '#'];
  const STOP_AT = [0, 0.55, 1];

  /* 解析失败时的退路：值与 tokens.css 的 --inf-light / --accent / --inf-deep 一致 */
  let ramp = [
    [96, 165, 250],
    [37, 99, 235],
    [30, 58, 138],
  ];

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function parseColor(raw, fallback) {
    const value = String(raw).trim();
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

  function readRamp() {
    const styles = window.getComputedStyle(document.documentElement);
    ramp = [
      parseColor(styles.getPropertyValue('--inf-light'), ramp[0]),
      parseColor(styles.getPropertyValue('--accent'), ramp[1]),
      parseColor(styles.getPropertyValue('--inf-deep'), ramp[2]),
    ];
  }

  function colorAt(value) {
    const v = clamp(value, 0, 1);
    for (let i = 1; i < STOP_AT.length; i += 1) {
      if (v <= STOP_AT[i]) {
        const left = ramp[i - 1];
        const right = ramp[i];
        const t = (v - STOP_AT[i - 1]) / (STOP_AT[i] - STOP_AT[i - 1]);
        return [
          Math.round(left[0] + (right[0] - left[0]) * t),
          Math.round(left[1] + (right[1] - left[1]) * t),
          Math.round(left[2] + (right[2] - left[2]) * t),
        ];
      }
    }
    return ramp[2];
  }

  function project(t, rotation, scale, centerX, centerY) {
    const x = Math.sin(t) * 1.02;
    const y = Math.sin(2 * t) * 0.58;
    const z = Math.cos(t) * 0.335;

    const cy = Math.cos(rotation.yaw);
    const sy = Math.sin(rotation.yaw);
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;

    const cp = Math.cos(rotation.pitch);
    const sp = Math.sin(rotation.pitch);
    const y1 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;

    const perspective = 3.15 / (3.15 - z2 * 0.78);

    return {
      x: centerX + x1 * perspective * scale,
      y: centerY + y1 * perspective * scale,
      depth: z2,
      perspective,
    };
  }

  function rotationFor(time) {
    return {
      yaw: 0.18 + Math.sin(time * 0.245 - 0.5) * 0.135,
      pitch: -0.17 + Math.sin(time * 0.165 + 1.15) * 0.055,
    };
  }

  function resize() {
    if (!canvasEl || !ctx) return;
    const rect = canvasEl.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasEl.width = Math.round(width * dpr);
    canvasEl.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sampleCount = Math.round(clamp(width * 0.34, 110, 210));
    needsRender = true;

    readRamp();
    const mono = window.getComputedStyle(canvasEl).getPropertyValue('--font-mono').trim();
    glyphFont = mono || glyphFont;
  }

  function computeLayout(time) {
    const rotation = rotationFor(time);
    const probeCount = 180;
    let maxX = 0.001;
    let maxY = 0.001;

    for (let i = 0; i < probeCount; i += 1) {
      const t = (i / probeCount) * TAU;
      const p = project(t, rotation, 1, 0, 0);
      maxX = Math.max(maxX, Math.abs(p.x));
      maxY = Math.max(maxY, Math.abs(p.y));
    }

    /* 只用宽度定尺寸：横向半幅 0.29 ≈ 原来（0.435）的三分之二，
     * 高度交给投影自己的比例，容器不参与计算，符号不会被拉扁。 */
    const scale = (width * 0.29) / maxX;

    return {
      rotation,
      scale,
      centerX: width * 0.5,
      centerY: height * 0.5,
    };
  }

  function render() {
    if (!ctx || !width || !height) return;

    ctx.clearRect(0, 0, width, height);

    const layout = computeLayout(clock);
    const loopPhase = ((clock / LOOP_SECONDS) % 1 + 1) % 1;
    const baseFontSize = clamp(layout.scale * 0.073, 8, 18);
    const items = [];

    for (let i = 0; i < sampleCount; i += 1) {
      const t = (i / sampleCount) * TAU;
      const u = i / sampleCount;
      const point = project(t, layout.rotation, layout.scale, layout.centerX, layout.centerY);
      const depthNorm = clamp(0.5 + point.depth / 0.76, 0, 1);

      const wrapped = ((u - loopPhase) % 1 + 1) % 1;
      const wave = Math.pow(0.5 + 0.5 * Math.cos(TAU * wrapped), 1.27);
      const headDistance = Math.min(wrapped, 1 - wrapped);
      const headGlint = Math.exp(-Math.pow(headDistance / 0.032, 2));
      const microFlicker = 0.5 + 0.5 * Math.cos(t * 9 + clock * 0.62);

      let energy = 0.22 + wave * 0.65 + headGlint * 0.22 + microFlicker * 0.03;
      energy *= 0.75 + depthNorm * 0.25;
      energy = clamp(energy, 0.2, 1);

      const glyphIndex = Math.min(GLYPHS.length - 1, Math.floor(energy * GLYPHS.length));
      const color = colorAt(0.28 + energy * 0.72);
      const fontSize = baseFontSize * (0.68 + depthNorm * 0.31 + energy * 0.13);
      const fade = (energy - 0.2) / 0.8;
      /* 白底上没有叠加发光兜底，波谷也留 0.3 左右的不透明度，整颗 ∞ 才始终看得出形状 */
      const alpha = (0.34 + fade * 0.66) * (0.78 + depthNorm * 0.22);

      items.push({
        x: point.x,
        y: point.y,
        text: GLYPHS[glyphIndex],
        color,
        alpha: clamp(alpha, 0.26, 1),
        size: fontSize,
        energy,
        depthNorm,
      });
    }

    items.sort((a, b) => a.depthNorm * 0.6 + a.energy * 0.4 - (b.depthNorm * 0.6 + b.energy * 0.4));

    const headPoint = project(loopPhase * TAU, layout.rotation, layout.scale, layout.centerX, layout.centerY);
    const headRadius = Math.max(24, baseFontSize * 4.2);
    const glow = ctx.createRadialGradient(headPoint.x, headPoint.y, 0, headPoint.x, headPoint.y, headRadius);
    glow.addColorStop(0, 'rgba(37, 99, 235, 0.1)');
    glow.addColorStop(0.45, 'rgba(37, 99, 235, 0.04)');
    glow.addColorStop(1, 'rgba(37, 99, 235, 0)');
    ctx.save();
    ctx.fillStyle = glow;
    ctx.fillRect(headPoint.x - headRadius, headPoint.y - headRadius, headRadius * 2, headRadius * 2);
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.energy > 0.55) {
        ctx.shadowColor = 'rgba(37, 99, 235, ' + (item.energy * 0.26).toFixed(3) + ')';
        ctx.shadowBlur = item.size * (0.2 + item.energy * 0.6);
      } else {
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = item.alpha;
      ctx.fillStyle = 'rgb(' + item.color[0] + ',' + item.color[1] + ',' + item.color[2] + ')';
      ctx.font = '400 ' + item.size.toFixed(2) + 'px ' + glyphFont;
      ctx.fillText(item.text, item.x, item.y);
    }

    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pulse = 0.5 + 0.5 * Math.sin(clock * 2.4);
    const headSize = baseFontSize * 1.45;
    ctx.globalAlpha = 0.82 + pulse * 0.18;
    ctx.fillStyle = 'rgb(' + ramp[2][0] + ',' + ramp[2][1] + ',' + ramp[2][2] + ')';
    ctx.shadowColor = 'rgba(37, 99, 235, 0.55)';
    ctx.shadowBlur = headSize * 1.9;
    ctx.font = '400 ' + headSize.toFixed(2) + 'px ' + glyphFont;
    ctx.fillText('@', headPoint.x, headPoint.y);
    ctx.restore();
  }

  function tick(now) {
    rafId = window.requestAnimationFrame(tick);
    if (!lastFrame) lastFrame = now;
    const delta = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;

    if (isPlaying) {
      clock += delta;
      needsRender = true;
    }

    if (needsRender) {
      render();
      needsRender = false;
    }
  }

  onMount(() => {
    if (!canvasEl) return;
    ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    const html = document.documentElement;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    /* 页面不可见 / 系统「减少动态效果」时停在当前帧 */
    function syncMotion() {
      isPlaying = !reducedMotion.matches
        && !html.hasAttribute('data-paused')
        && !document.hidden;
      needsRender = true;
    }

    const motionObserver = new MutationObserver(syncMotion);
    motionObserver.observe(html, { attributes: true, attributeFilter: ['data-paused'] });
    document.addEventListener('visibilitychange', syncMotion);
    reducedMotion.addEventListener('change', syncMotion);

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => resize())
      : null;
    if (resizeObserver) resizeObserver.observe(canvasEl);
    else window.addEventListener('resize', resize);

    resize();
    syncMotion();
    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
      motionObserver.disconnect();
      document.removeEventListener('visibilitychange', syncMotion);
      reducedMotion.removeEventListener('change', syncMotion);
      if (resizeObserver) resizeObserver.disconnect();
      else window.removeEventListener('resize', resize);
    };
  });
</script>

<div
  class="lmn"
  role="img"
  aria-label="由 ASCII 字符构成的三维无穷大双纽线，蓝色墨水沿曲线循环流动"
>
  <canvas class="lmn-canvas" bind:this={canvasEl} aria-hidden="true"></canvas>
</div>

<style>
  /* 只留符号：没有底板、网格、角标和控件，canvas 直接坐在页面白底上 */
  .lmn {
    width: 100%;
    height: clamp(176px, 48vw, 268px);
  }

  .lmn-canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
