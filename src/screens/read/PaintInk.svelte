<script>
  /* 作画中的舞台空状态：纸墨显影（canvas 逐帧，8 FPS / 64 帧一轮）
   *
   * 画面是一张米白纸：细小的 ASCII 字符按网格聚成双纽线，浓墨沿曲线由淡显影到深，
   * 带两层错相的墨波、噪点决定的行宽与断笔、边缘回声，以及散落的「残字」。
   * 只在实际作画（队列非空且舞台上还没有图）时挂载，队列一空随舞台空状态一起卸载。
   *
   * 与项目动效纪律的接法：
   *   · 逐帧绘制在 canvas 里，不走 CSS @keyframes；系统「减少动效」、页面不可见时停在当前帧
   *     （同样是一张纸墨 ∞）；
   *   · 没有标题、角标、帧号、暂停与重排控件：状态文字仍由舞台左上角的胶囊负责；
   *   · 纸面底色 / 纸纹 / 暗角走 tokens.css 的 --ink-* 令牌，逐字墨色是画布内容色。
   */
  import { onMount } from 'svelte';
  import { mountCanvas, rampAt } from '../../ui/canvasStage.js';

  let inkEl;
  let canvasEl;
  let ctx = null;

  let accumulator = 0;
  let frame = 0;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let cols = 0;
  let rows = 0;
  let cellW = 0;
  let cellH = 0;
  let gridX = 0;
  let gridY = 0;
  let fontSize = 6;
  let glyphFont = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  let cellAlpha = new Float32Array(0);
  let cellStrength = new Float32Array(0);
  let cellGlyph = [];
  let geomSamples = 2400;

  const TAU = Math.PI * 2;
  const FRAME_MS = 1000 / 8;
  const LOOP_FRAMES = 64;
  const PHASE_OFFSET = 0.12;
  const SEED = 0;

  /* 画布内容色（纸墨的深浅），不是 UI 配色：浅到几乎融进纸面 → 近黑的浓墨。
     取色复用 src/ui/canvasStage.js 的 rampAt：钳制到 [0,1] 后按色标线性插值，末档即最深的墨。 */
  const INK_POS = [0, 0.18, 0.36, 0.52, 0.66, 0.8, 0.9, 1];
  const INK_RGB = [
    [205, 213, 216],
    [170, 183, 190],
    [124, 146, 159],
    [75, 101, 119],
    [38, 65, 84],
    [18, 42, 60],
    [10, 28, 44],
    [5, 16, 28],
  ];

  const LETTERS = 'aaeeiioouunnttrrssllccddmmpphhbbggffyywwvvkkxxjq';
  const DENSE = '#%&@$*';
  const DIGITS = '0123456789';
  const LIGHT_MARKS = ".,:;'`~-";
  const MID_MARKS = '=+*/\\|';

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  const colorAt = (value) => rampAt(value, INK_RGB, INK_POS);

  /* 固定种子的伪随机：同一帧号每次画出来一致，切档 / 暂停不会跳形 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash1(n) {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return x - Math.floor(x);
  }

  function noise1(x) {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return hash1(i) * (1 - u) + hash1(i + 1) * u;
  }

  function pickGlyph(strength, rand) {
    const roll = rand();
    if (strength > 0.66) {
      if (roll < 0.7) return LETTERS.charAt(Math.floor(rand() * LETTERS.length));
      if (roll < 0.84) return DIGITS.charAt(Math.floor(rand() * DIGITS.length));
      if (roll < 0.9) return DENSE.charAt(Math.floor(rand() * DENSE.length));
      return LIGHT_MARKS.charAt(Math.floor(rand() * LIGHT_MARKS.length));
    }
    if (strength > 0.38) {
      if (roll < 0.56) return LETTERS.charAt(Math.floor(rand() * LETTERS.length));
      if (roll < 0.68) return DIGITS.charAt(Math.floor(rand() * DIGITS.length));
      if (roll < 0.78) return MID_MARKS.charAt(Math.floor(rand() * MID_MARKS.length));
      return LIGHT_MARKS.charAt(Math.floor(rand() * LIGHT_MARKS.length));
    }
    if (roll < 0.26) return LETTERS.charAt(Math.floor(rand() * LETTERS.length));
    if (roll < 0.92) return LIGHT_MARKS.charAt(Math.floor(rand() * LIGHT_MARKS.length));
    return DIGITS.charAt(Math.floor(rand() * DIGITS.length));
  }

  function layoutMetrics() {
    const padX = width < 520 ? 10 : 18;
    const padY = width < 520 ? 14 : 20;
    const availableWidth = Math.max(120, width - padX * 2);
    const availableHeight = Math.max(100, height - padY * 2);

    fontSize = clamp(width / 128, 5.3, 6.6);
    const baseCellW = fontSize * 0.58;
    const baseCellH = fontSize * 1.04;

    cols = Math.max(36, Math.floor(availableWidth / baseCellW));
    rows = Math.max(16, Math.floor(availableHeight / baseCellH));
    cellW = availableWidth / cols;
    cellH = availableHeight / rows;
    gridX = Math.round((width - cols * cellW) / 2);
    gridY = Math.round(padY + (availableHeight - rows * cellH) / 2);

    geomSamples = clamp(Math.round(cols * 22), 1800, 5600);
    cellAlpha = new Float32Array(cols * rows);
    cellStrength = new Float32Array(cols * rows);
    cellGlyph = new Array(cols * rows);
  }

  function resize() {
    if (!inkEl || !canvasEl || !ctx) return;
    const rect = inkEl.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasEl.width = Math.round(width * dpr);
    canvasEl.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const mono = window.getComputedStyle(canvasEl).getPropertyValue('--font-mono').trim();
    glyphFont = mono || glyphFont;

    layoutMetrics();
  }

  function rotationFor(phase) {
    return {
      yaw: 0.1 + Math.sin(TAU * phase - 0.7) * 0.06,
      pitch: -0.055 + Math.sin(TAU * phase + 0.95) * 0.032,
      tilt: -0.045 + Math.sin(TAU * phase + 0.35) * 0.014,
    };
  }

  function projectRaw(t, rotation) {
    const denominator = 1 + Math.sin(t) * Math.sin(t);
    let x = Math.cos(t) / denominator;
    let y = (Math.sin(t) * Math.cos(t) / denominator) * 2;
    const z = Math.cos(t) * 0.12;

    const wobbleX = 1 + Math.sin(t + 1.15) * 0.052 + Math.sin(t * 2 + 4.1) * 0.018;
    const wobbleY = 1 + Math.sin(t + 4.6) * 0.05 + Math.sin(t * 3 - 0.7) * 0.014;
    x *= wobbleX;
    y = y * wobbleY + Math.sin(t * 2 + 0.7) * 0.022;

    const cy = Math.cos(rotation.yaw);
    const sy = Math.sin(rotation.yaw);
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;

    const cp = Math.cos(rotation.pitch);
    const sp = Math.sin(rotation.pitch);
    const y1 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const perspective = 3.2 / (3.2 - z2 * 0.72);

    const px = x1 * perspective;
    const py = y1 * perspective;

    const ct = Math.cos(rotation.tilt);
    const st = Math.sin(rotation.tilt);
    return {
      x: px * ct - py * st,
      y: px * st + py * ct,
      z: z2,
    };
  }

  /* 同一格取最浓的一笔：先落浅的、后落深的，字形不会被灰字盖掉 */
  function inkCell(col, row, glyph, alpha, strength) {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return;
    if (alpha < 0.012) return;
    const index = row * cols + col;
    if (alpha > cellAlpha[index]) {
      cellAlpha[index] = alpha;
      cellStrength[index] = strength;
      cellGlyph[index] = glyph;
    }
  }

  function depositStrays(rand) {
    const count = Math.max(6, Math.round(cols * rows * 0.0016));
    for (let i = 0; i < count; i += 1) {
      const col = Math.floor(rand() * cols);
      const row = Math.floor(rand() * rows);
      const length = 1 + Math.floor(rand() * 3);
      const alpha = 0.035 + rand() * 0.11;
      const strength = 0.1 + rand() * 0.22;
      for (let j = 0; j < length; j += 1) {
        inkCell(col + j, row, pickGlyph(strength, rand), alpha * (0.7 + rand() * 0.3), strength);
      }
    }

    const streaks = Math.max(4, Math.round(cols * 0.075));
    for (let i = 0; i < streaks; i += 1) {
      const sRow = Math.floor(rand() * rows);
      const sCol = Math.floor(rand() * Math.max(1, cols - 20));
      const sLength = 2 + Math.floor(rand() * 13);
      const sAlpha = 0.028 + rand() * 0.08;
      for (let k = 0; k < sLength; k += 1) {
        if (rand() < 0.26) continue;
        const sStrength = 0.08 + rand() * 0.16;
        inkCell(sCol + k, sRow, pickGlyph(sStrength, rand), sAlpha, sStrength);
      }
    }
  }

  function render() {
    if (!ctx || !width || !height || !cols || !rows) return;

    const displayFrame = ((frame % LOOP_FRAMES) + LOOP_FRAMES) % LOOP_FRAMES;
    const phase = displayFrame / LOOP_FRAMES + PHASE_OFFSET;
    const patternFrame = Math.floor(displayFrame / 2);
    const rand = mulberry32(((patternFrame + 1) * 2246822519 + (SEED + 3) * 3266489917) >>> 0);
    const rotation = rotationFor(phase);
    const points = new Array(geomSamples);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let i;

    for (i = 0; i < geomSamples; i += 1) {
      const u = i / geomSamples;
      const point = projectRaw(u * TAU, rotation);
      points[i] = { x: point.x, y: point.y, u };
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }

    const spanX = Math.max(maxX - minX, 0.0001);
    const spanY = Math.max(maxY - minY, 0.0001);
    const artistAspect = width < 400 ? 1.68 : width < 560 ? 1.82 : 2.0;
    const fitHeight = rows * cellH * 0.96;
    const fitWidth = cols * cellW * 0.94;
    const artHeight = Math.min(fitHeight, fitWidth / artistAspect);
    const artWidth = artHeight * artistAspect;
    const scaleX = artWidth / spanX;
    const scaleY = artHeight / spanY;
    const centerX = gridX + (cols * cellW) / 2;
    const centerY = gridY + (rows * cellH) * 0.5;
    const rawCenterX = (minX + maxX) / 2;
    const rawCenterY = (minY + maxY) / 2;

    cellAlpha.fill(0);
    cellStrength.fill(0);

    for (i = 0; i < geomSamples; i += 1) {
      const sample = points[i];
      const sampleU = sample.u;
      const mainWave = Math.pow(0.5 + 0.5 * Math.cos(TAU * (sampleU - phase)), 1.35);
      const echoWave = Math.pow(0.5 + 0.5 * Math.cos(TAU * (sampleU - phase + 0.52)), 3.4) * 0.52;
      const main = Math.max(mainWave, echoWave);
      const nA = noise1(sampleU * 4.3 + SEED * 1.7 + 2.1);
      const nB = noise1(sampleU * 9.7 - SEED * 0.9 + 5.6);
      let strength = 0.1 + 0.84 * main * (0.6 + 0.55 * nA) + 0.18 * (1 - main) * nB;
      strength = clamp(strength, 0.08, 1);

      const px = centerX + (sample.x - rawCenterX) * scaleX;
      const py = centerY + (sample.y - rawCenterY) * scaleY;
      const colF = (px - gridX) / cellW;
      const rowF = (py - gridY) / cellH;
      if (rowF < 0 || rowF >= rows) continue;

      const clump = Math.pow(noise1(sampleU * 3.1 + SEED * 1.3 + 13.7), 1.9);
      const thickness = (1.4 + 2.0 * main + 7.5 * clump * main) * (0.6 + 0.7 * nB) * (0.7 + 0.4 * strength);
      const emitChance = (0.08 + 0.16 * main) * (0.8 + 0.55 * clump);
      const tear = noise1(sampleU * 5.1 + SEED * 2.3 + 9.4);
      const torn = tear < 0.13;

      if (!torn && rand() < emitChance) {
        const lanes = 1 + (rand() < 0.78 ? 1 : 0) + (rand() < main * 0.46 ? 1 : 0) + (rand() < 0.06 + 0.18 * clump ? 1 : 0);
        for (let lane = 0; lane < lanes; lane += 1) {
          const offsetRows = (rand() * 2 - 1) * thickness * 0.55;
          const targetRow = Math.round(rowF + offsetRows);
          const falloff = 1 - Math.min(1, Math.abs(offsetRows) / (thickness * 0.7 + 0.6)) * 0.36;
          const localStrength = clamp(strength * (0.8 + 0.28 * rand()), 0.06, 1);
          const runLength = 2 + Math.floor(rand() * (2.2 + strength * 10));
          const startCol = Math.round(colF + (rand() * 6 - 3));
          let baseAlpha = (0.1 + 1.9 * Math.pow(strength, 1.9)) * falloff * (0.85 + 0.15 * rand());
          baseAlpha = Math.min(baseAlpha, 1);

          for (let run = 0; run < runLength; run += 1) {
            if (rand() < 0.12) continue;
            const glyph = pickGlyph(localStrength, rand);
            const alpha = baseAlpha * (0.72 + 0.28 * rand());
            inkCell(startCol + run, targetRow, glyph, alpha, localStrength);
          }
        }
      }

      const tracePresence = noise1(sampleU * 3.4 + SEED * 0.8 + 6.1);
      if (tracePresence > 0.16 && rand() < 0.32) {
        const traceRow = Math.round(rowF + (rand() * 2 - 1) * 1.2);
        const traceStrength = 0.24 + rand() * 0.18;
        inkCell(
          Math.round(colF + (rand() * 2 - 1)),
          traceRow,
          pickGlyph(traceStrength, rand),
          0.17 + rand() * 0.17,
          traceStrength,
        );
      }

      if (rand() < 0.055) {
        const ghostRow = Math.round(rowF + (rand() * 2 - 1) * thickness * 0.45);
        const ghostStrength = clamp(strength * 0.72, 0.06, 0.75);
        inkCell(
          Math.round(colF + (rand() * 3 - 1.5)),
          ghostRow,
          pickGlyph(ghostStrength, rand),
          0.08 + rand() * 0.12,
          ghostStrength,
        );
      }

      if (rand() < 0.05 + 0.11 * main) {
        const echoSide = rand() < 0.5 ? -1 : 1;
        const echoRow = Math.round(rowF + echoSide * (thickness * 0.72 + 1.2 + rand() * 3));
        const echoLength = 1 + Math.floor(rand() * 4);
        const echoCol = Math.round(colF + (rand() * 6 - 3));
        const echoStrength = clamp(strength * (0.6 + rand() * 0.3), 0.06, 0.82);
        const echoAlpha = (0.06 + rand() * 0.17) * (0.5 + strength * 0.8);
        for (let echo = 0; echo < echoLength; echo += 1) {
          if (rand() < 0.22) continue;
          inkCell(echoCol + echo, echoRow, pickGlyph(echoStrength, rand), echoAlpha, echoStrength);
        }
      }
    }

    depositStrays(mulberry32((((patternFrame + 1) * 1597334677) ^ (SEED * 3266489917)) >>> 0));

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let currentWeight = 0;

    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      const cellY = gridY + rowIndex * cellH + cellH * 0.52;
      for (let colIndex = 0; colIndex < cols; colIndex += 1) {
        const index = rowIndex * cols + colIndex;
        const alpha = cellAlpha[index];
        if (alpha < 0.012) continue;

        const weight = cellStrength[index] > 0.6 ? 600 : 400;
        if (weight !== currentWeight) {
          ctx.font = weight + ' ' + fontSize.toFixed(2) + 'px ' + glyphFont;
          currentWeight = weight;
        }

        const color = colorAt(cellStrength[index]);
        const cellX = gridX + colIndex * cellW + cellW * 0.5;
        const glyph = cellGlyph[index] || '.';
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.fillStyle = 'rgb(' + color[0] + ',' + color[1] + ',' + color[2] + ')';
        ctx.fillText(glyph, cellX, cellY);

        const strengthValue = cellStrength[index];
        if (strengthValue > 0.56 && alpha > 0.18) {
          const extraPasses = strengthValue > 0.86 ? 3 : strengthValue > 0.72 ? 2 : 1;
          for (let pass = 0; pass < extraPasses; pass += 1) {
            ctx.globalAlpha = Math.min(1, alpha * (0.68 - pass * 0.1));
            ctx.fillText(
              glyph,
              cellX + (pass === 0 ? 0.5 : pass === 1 ? -0.45 : 0.15),
              cellY + (pass === 0 ? 0.3 : pass === 1 ? 0.4 : -0.35),
            );
          }
        }
      }
    }

    ctx.restore();
  }

  onMount(() => {
    if (!inkEl || !canvasEl) return;
    ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    // 挂载脚手架统一在 src/ui/canvasStage.js（含「页面不可见 / 减少动效 / 分支页挂起」的停帧）；
    // staticFrame 让后台标签页（rAF 被暂停）挂载时也立刻有一张完整的纸墨 ∞
    return mountCanvas({
      target: inkEl,
      resize: resize,
      draw: render,
      staticFrame: true,
      onMotion: () => { accumulator = 0; },
      step: (deltaMs) => {
        accumulator += deltaMs;
        let advanced = false;
        while (accumulator >= FRAME_MS) {
          accumulator -= FRAME_MS;
          frame += 1;
          advanced = true;
        }
        return advanced;
      },
    });
  });
</script>

<div class="ink" bind:this={inkEl} aria-hidden="true">
  <canvas class="ink-canvas" bind:this={canvasEl}></canvas>
</div>

<style>
  /* 纸面：底色 / 纸纹 / 暗角全部走 token；画布只画墨，不画纸 */
  .ink {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: var(--ink-paper-bg);
  }

  .ink::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    background-image: var(--ink-grain);
    background-size: 3px 3px;
    opacity: 0.22;
    mix-blend-mode: multiply;
  }

  .ink::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    background: var(--ink-vignette);
  }

  .ink-canvas {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
