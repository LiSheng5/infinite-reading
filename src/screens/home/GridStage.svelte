<script>
  /* 首页主视觉的随机变体之一：双纽线 · 逐格（canvas 逐帧，12 FPS / 96 帧一轮）
   *
   * 把双纽线的采样点落进固定字符格：每个格子按曲线走向取 - | \ /，按能量取 # * +，
   * 一个 @ 头格沿曲线跑，格线极淡地托住整块画面。
   * 版面与 InfinityStage 一致：白底、无标题 / 帧号 / 控件、约原来三分之二大小。
   *
   * 与项目动效纪律的接法：
   *   · 逐帧绘制在 canvas 里，不走 CSS @keyframes；系统「减少动效」、页面不可见时停在当前帧；
   *   · 墨色是画布内容色，按 tokens.css 的 --inf-deep / --accent / --inf-light 取同一族蓝。
   */
  import { onMount } from 'svelte';
  import {
    mountCanvas, readInkRamp, rampAt, clamp, fitCanvas, monoFontOf, fixedStep, MONO_STACK,
    INK_RAMP_FALLBACK,
  } from '../../ui/canvasStage.js';

  let gridEl;
  let canvasEl;
  let ctx = null;

  let frame = 0;

  let width = 0;
  let height = 0;
  let cols = 0;
  let rows = 0;
  let cellW = 0;
  let cellH = 0;
  let gridX = 0;
  let gridY = 0;
  let fontSize = 10;
  let glyphFont = MONO_STACK;
  let cellEnergy = new Float32Array(0);
  let cellDepth = new Float32Array(0);
  let cellGlyph = [];
  let samples = 1500;

  const TAU = Math.PI * 2;
  const LOOP_FRAMES = 96;

  /* 画布内容色（白底可读的墨蓝）：与光流版共用 src/ui/canvasStage.js 的色带读取，
   * 三色来自 :root 的 --inf-light / --accent / --inf-deep——改令牌两颗主视觉一起变，
   * 不会一边读令牌、一边写死 RGB 而漂色 */
  let ramp = INK_RAMP_FALLBACK;

  function layoutMetrics() {
    const availableWidth = Math.max(100, width - (width < 480 ? 26 : 32));
    fontSize = clamp(width / 62, 10, 16);
    const naturalCellW = fontSize * 0.62;
    cols = clamp(Math.floor(availableWidth / naturalCellW), 30, 112);
    cellW = Math.min(naturalCellW, availableWidth / cols);
    cellH = fontSize * 1.25;

    const padY = width < 480 ? 14 : 18;
    const availableHeight = Math.max(100, height - padY * 2);
    rows = clamp(Math.floor(availableHeight / cellH), 10, 30);
    gridX = Math.round((width - cols * cellW) / 2);
    gridY = Math.round(padY + Math.max(0, (availableHeight - rows * cellH) / 2));
    samples = clamp(Math.round(cols * 18), 1000, 2000);
    cellEnergy = new Float32Array(cols * rows);
    cellDepth = new Float32Array(cols * rows);
    cellGlyph = new Array(cols * rows);
  }
  function resize() {
    if (!gridEl || !canvasEl || !ctx) return;
    const box = fitCanvas(canvasEl, gridEl, ctx);
    width = box.width;
    height = box.height;
    glyphFont = monoFontOf(canvasEl);
    ramp = readInkRamp();
    layoutMetrics();
  }

  function rotationFor(phase) {
    return {
      yaw: 0.12 + Math.sin(TAU * phase - 0.55) * 0.055,
      pitch: -0.07 + Math.sin(TAU * phase + 0.8) * 0.025,
    };
  }

  function projectRaw(t, rotation) {
    const denominator = 1 + Math.sin(t) * Math.sin(t);
    const x = Math.cos(t) / denominator;
    const y = (Math.sin(t) * Math.cos(t) / denominator) * 2;
    const z = Math.cos(t) * 0.12;

    const cy = Math.cos(rotation.yaw);
    const sy = Math.sin(rotation.yaw);
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;

    const cp = Math.cos(rotation.pitch);
    const sp = Math.sin(rotation.pitch);
    const y1 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const perspective = 3.2 / (3.2 - z2 * 0.72);

    return {
      x: x1 * perspective,
      y: y1 * perspective,
      z: z2,
    };
  }

  function render() {
    if (!ctx || !width || !height || !cols || !rows) return;

    const displayFrame = ((frame % LOOP_FRAMES) + LOOP_FRAMES) % LOOP_FRAMES;
    const phase = displayFrame / LOOP_FRAMES;
    const rotation = rotationFor(phase);
    const raw = new Array(samples);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let i;

    for (i = 0; i < samples; i += 1) {
      const t = (i / samples) * TAU;
      const point = projectRaw(t, rotation);
      raw[i] = { x: point.x, y: point.y, z: point.z, u: i / samples };
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
      if (point.z < minZ) minZ = point.z;
      if (point.z > maxZ) maxZ = point.z;
    }

    const rangeX = Math.max(maxX - minX, 0.0001);
    const rangeY = Math.max(maxY - minY, 0.0001);
    const rangeZ = Math.max(maxZ - minZ, 0.0001);
    /* 符号只占网格中间约九成高度，和首页光流版同一视觉体量 */
    const spanRows = Math.max(6, Math.round((rows - 2) * 0.95));
    const spanCols = Math.min(
      Math.max(cols - 4, 1),
      Math.max(8, Math.round((1.8 * spanRows * cellH) / cellW)),
    );
    const colOffset = Math.round((cols - spanCols) / 2);
    cellEnergy.fill(0);
    cellDepth.fill(0);

    for (i = 0; i < samples; i += 1) {
      const sample = raw[i];
      const depthNorm = clamp((sample.z - minZ) / rangeZ, 0, 1);
      const wrapped = ((sample.u - phase) % 1 + 1) % 1;
      const wave = Math.pow(0.5 + 0.5 * Math.cos(TAU * wrapped), 1.38);
      const headDistance = Math.min(wrapped, 1 - wrapped);
      const glint = Math.exp(-Math.pow(headDistance / 0.032, 2));
      let energy = 0.5 + wave * 0.4 + glint * 0.07;
      energy *= 0.96 + depthNorm * 0.04;
      energy = clamp(energy, 0.48, 1);

      let col = Math.floor(((sample.x - minX) / rangeX) * spanCols) + colOffset;
      let row = Math.floor(((maxY - sample.y) / rangeY) * spanRows) + 1;
      col = clamp(col, 0, cols - 1);
      row = clamp(row, 0, rows - 1);

      const previous = raw[(i - 1 + samples) % samples];
      const next = raw[(i + 1) % samples];
      const tangentX = ((next.x - previous.x) / rangeX) * spanCols;
      const tangentY = -((next.y - previous.y) / rangeY) * spanRows;
      const absX = Math.abs(tangentX);
      const absY = Math.abs(tangentY);
      let directionGlyph;
      if (absX > absY * 2.2) {
        directionGlyph = '-';
      } else if (absY > absX * 2.2) {
        directionGlyph = '|';
      } else if (tangentX * tangentY >= 0) {
        directionGlyph = '\\';
      } else {
        directionGlyph = '/';
      }

      const index = row * cols + col;
      if (energy > cellEnergy[index]) {
        cellEnergy[index] = energy;
        cellDepth[index] = depthNorm;
        cellGlyph[index] = energy >= 0.83 ? '#' : energy >= 0.7 ? '*' : energy >= 0.57 ? '+' : directionGlyph;
      }
    }

    ctx.clearRect(0, 0, width, height);

    const headPoint = projectRaw(phase * TAU, rotation);
    const headCol = clamp(
      Math.floor(((headPoint.x - minX) / rangeX) * spanCols) + colOffset,
      0,
      cols - 1,
    );
    const headRow = clamp(
      Math.floor(((maxY - headPoint.y) / rangeY) * spanRows) + 1,
      0,
      rows - 1,
    );

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      for (let colIndex = 0; colIndex < cols; colIndex += 1) {
        const cellIndex = rowIndex * cols + colIndex;
        const energy = cellEnergy[cellIndex];
        if (energy <= 0) continue;

        const glyph = cellGlyph[cellIndex] || '.';
        /* 白底上整条色带压在深蓝一侧，最淡的一格也要看得出墨 */
        const color = rampAt(0.45 + 0.55 * ((energy - 0.48) / 0.52), ramp);
        const alpha = clamp(0.74 + cellDepth[cellIndex] * 0.1 + energy * 0.16, 0.78, 1);
        const x = gridX + colIndex * cellW + cellW / 2;
        const y = gridY + rowIndex * cellH + cellH / 2;

        ctx.globalAlpha = alpha;
        ctx.fillStyle = 'rgb(' + color[0] + ',' + color[1] + ',' + color[2] + ')';
        ctx.font = '400 ' + fontSize.toFixed(2) + 'px ' + glyphFont;
        ctx.fillText(glyph, x, y);
      }
    }

    const headCellX = gridX + headCol * cellW;
    const headCellY = gridY + headRow * cellH;
    const accentRGB = ramp[1][0] + ',' + ramp[1][1] + ',' + ramp[1][2];
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(' + accentRGB + ', 0.07)';
    ctx.fillRect(headCellX + 1, headCellY + 1, cellW - 2, cellH - 2);
    ctx.strokeStyle = 'rgba(' + accentRGB + ', 0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(headCellX) + 0.5, Math.round(headCellY) + 0.5, Math.round(cellW), Math.round(cellH));

    ctx.fillStyle = 'rgb(' + ramp[2][0] + ',' + ramp[2][1] + ',' + ramp[2][2] + ')';
    ctx.font = '500 ' + fontSize.toFixed(2) + 'px ' + glyphFont;
    ctx.fillText('@', headCellX + cellW / 2, headCellY + cellH / 2);

    ctx.restore();
  }

  onMount(() => {
    if (!gridEl || !canvasEl) return;
    ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    // 挂载脚手架统一在 src/ui/canvasStage.js（含「页面不可见 / 减少动效 / 分支页挂起」的停帧与首帧）；
    // 12 FPS 由 fixedStep 累加，与屏幕刷新率无关
    const ticker = fixedStep(12, () => { frame += 1; });
    return mountCanvas({
      target: gridEl,
      resize,
      draw: render,
      onMotion: ticker.reset,
      step: ticker.step,
    });
  });
</script>

<div class="grid" role="img" aria-label="由字符格构成的 ASCII 三维无穷大双纽线，蓝色墨迹沿曲线逐格循环" bind:this={gridEl}>
  <canvas class="grid-canvas" bind:this={canvasEl} aria-hidden="true"></canvas>
</div>

<style>
  /* 与首页光流版同一位置、同一体量：没有底板，只有一颗符号和一些极淡的格线 */
  .grid {
    width: 100%;
    height: clamp(176px, 48vw, 268px);
  }

  .grid-canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
