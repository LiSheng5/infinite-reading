/*
 * acceptance/phase5/8/loop-freeze-smoke.mjs —— 阶段 5 · 第 8 步 · 过渡期循环冻结自检
 *
 * 验什么（任务书第 8 步「过渡期与循环预算的冲突处理：过渡中冻结循环、结束复位」）：
 *
 *   off         弹窗开合是同步换 DOM：不开视图过渡，页面循环照跑（不冻结、不干预）
 *   standard    VT 开合：新快照拍摄前循环被停在同一相位（currentTime 不再前进），
 *               过渡收尾（含被 skip / 被下一段顶掉）全部 play() 回来
 *   rich-screen 切屏（root 快照 + 位移）：同上，验最常用的那条过渡路径
 *   rich-modal  弹窗开合（容器 / 卡片两层命名、根 opt-out）：同上，开与关各一次
 *   rich-fallback ?vt=0 降级：没有快照就不冻结（淡入路径循环继续跑）
 *   rich-interrupt 开 → 60ms 关 → 40ms 再开：收尾后没有卡在 paused 的循环、没有残留快照
 *   paused-probe 本来就停着（animation-play-state: paused）的循环不许被「复位」成播放
 *   budget      过渡中途注销 / 新登记循环：hold 期间不重排预算（data-loop 不抖），解冻后统一收敛
 *
 * 手法：
 *   · 页面里插一个测速用循环元素（position:fixed 放到视口外，不动布局；animation: kenBurns 4s infinite），
 *     逐帧 document.getAnimations() 读它的 playState / currentTime，并同时记 IR.MotionDOM.loopsHeld()。
 *   · 另插一个 animation-play-state: paused 的同类元素，验「只恢复自己暂停的那些」。
 *   · 全程 file:// 打开 dist/single/index.html（双击的真实形态），不联网。
 *
 * 用法：node acceptance/phase5/8/loop-freeze-smoke.mjs [--out=acceptance/phase5/8]
 * 产出：{out}/manifest.json
 * 退出码：0 = 全部通过；1 = 有断言没过 / 有页面错误；2 = 没有构建产物
 */
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const APP_URL = pathToFileURL(path.join(ROOT, 'dist', 'single', 'index.html')).href;
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();

const PROBE = '__lp_probe';
const PAUSED_PROBE = '__lp_paused';

const log = (...a) => console.log('[loop-freeze]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseArgs() {
  const out = { out: 'acceptance/phase5/8' };
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] == null ? '' : m[2];
  }
  return out;
}

const SCENARIOS = [
  { id: 'off', tier: 'off', query: '', action: 'modal', expect: 'no-freeze' },
  { id: 'standard-vt', tier: 'standard', query: '', action: 'modal', expect: 'freeze', cap: 160 },
  { id: 'rich-vt-screen', tier: 'rich', query: '', action: 'screen', expect: 'freeze', cap: 220 },
  { id: 'rich-vt-modal', tier: 'rich', query: '', action: 'modal', expect: 'freeze', cap: 220 },
  { id: 'rich-fallback', tier: 'rich', query: '?vt=0', action: 'modal', expect: 'no-freeze', cap: 220 },
  { id: 'rich-interrupt', tier: 'rich', query: '', action: 'interrupt', expect: 'settle', cap: 220 },
  { id: 'paused-probe', tier: 'rich', query: '', action: 'modal', expect: 'keep-paused', cap: 220, probe: PAUSED_PROBE },
  { id: 'budget-hold', tier: 'rich', query: '', action: 'budget', expect: 'settle', cap: 220 },
];

/* ================= 页面内：测速循环 + 逐帧采样 ================= */

function installFixtures(ids) {
  const host = document.getElementById('app') || document.body;

  const make = (id, paused) => {
    if (document.getElementById(id)) return;
    const el = document.createElement('div');
    el.id = id;
    el.style.cssText = [
      'position:fixed', 'left:-3000px', 'top:0', 'width:2px', 'height:2px', 'pointer-events:none',
      'animation-name:kenBurns', 'animation-duration:4000ms', 'animation-timing-function:linear',
      'animation-iteration-count:infinite', 'animation-direction:alternate',
      paused ? 'animation-play-state:paused' : '',
    ].filter(Boolean).join(';');
    host.appendChild(el);
  };
  make(ids.probe, false);
  make(ids.paused, true);

  const animOf = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    try {
      return document.getAnimations().find(a => a.effect && a.effect.target === el) || null;
    } catch (_) { return null; }
  };

  const held = () => {
    try { return !!(window.IR && IR.MotionDOM && IR.MotionDOM.loopsHeld()); } catch (_) { return false; }
  };

  window.__lpApi = {
    state(id) {
      const a = animOf(id);
      return {
        found: !!a,
        playState: a ? a.playState : '(none)',
        currentTime: a && typeof a.currentTime === 'number' ? Math.round(a.currentTime * 10) / 10 : null,
      };
    },
    /* 逐帧采样：act() 触发动作，之后 rAF 采 ms 毫秒；每帧同时记 hold 状态与是否出现快照动画 */
    async sample(id, ms, act) {
      const out = [];
      const t0 = performance.now();
      if (typeof act === 'function') act();
      while (performance.now() - t0 <= ms) {
        let list = [];
        try { list = document.getAnimations(); } catch (_) {}
        let vt = false;
        for (const a of list) {
          const p = (a.effect && a.effect.pseudoElement) || '';
          if (p.indexOf('view-transition') >= 0) { vt = true; break; }
        }
        const a = animOf(id);
        out.push({
          t: Math.round((performance.now() - t0) * 10) / 10,
          playState: a ? a.playState : '(none)',
          currentTime: a && typeof a.currentTime === 'number' ? Math.round(a.currentTime * 10) / 10 : null,
          held: held(),
          vt,
        });
        await new Promise(r => requestAnimationFrame(r));
      }
      return out;
    },
    /* 当前文档里所有循环（排除 ::view-transition-* 自己）的播放态 */
    loops() {
      const out = [];
      try {
        for (const a of document.getAnimations()) {
          const eff = a.effect || null;
          const pseudo = (eff && eff.pseudoElement) || '';
          if (pseudo.indexOf('::view-transition') === 0) continue;
          let timing = {};
          try { timing = eff.getTiming(); } catch (_) {}
          const loop = !Number.isFinite(timing.iterations) || timing.iterations > 1;
          if (!loop) continue;
          const el = eff && eff.target;
          out.push({
            id: (el && el.id) || '',
            playState: a.playState,
            currentTime: typeof a.currentTime === 'number' ? Math.round(a.currentTime * 10) / 10 : null,
          });
        }
      } catch (_) {}
      return out;
    },
    vtPseudos() {
      const out = [];
      try {
        for (const a of document.getAnimations()) {
          const p = (a.effect && a.effect.pseudoElement) || '';
          if (p.indexOf('view-transition') >= 0) out.push(p);
        }
      } catch (_) {}
      return Array.from(new Set(out));
    },
    held,
    make,
    attrs(ids) {
      return ids.map((id) => {
        const el = document.getElementById(id);
        return { id, dataLoop: el ? (el.getAttribute('data-loop') || '') : '(missing)' };
      });
    },
  };
}

/* ================= 动作 ================= */

async function runAction(page, sc) {
  const probe = sc.probe || PROBE;

  if (sc.action === 'modal') {
    const samples = await page.evaluate(async ({ id, probeId }) => {
      const list = await window.__lpApi.sample(probeId, 520, () => {
        window.IR.App.openModal('modal-confirm');
      });
      await new Promise(r => setTimeout(r, 380));
      window.IR.App.closeModal('modal-confirm');
      await new Promise(r => setTimeout(r, 360));
      return list;
    }, { id: PROBE, probeId: probe });
    return { samples, tail: await page.evaluate(() => ({
      held: window.__lpApi.held(),
      loops: window.__lpApi.loops(),
      vt: window.__lpApi.vtPseudos(),
      modalOpen: !document.getElementById('modal-confirm').classList.contains('hidden'),
      stack: (window.IR.App.modalStack || []).slice(),
    })) };
  }

  if (sc.action === 'screen') {
    // 先确保在首页（showScreen 对「已经在目标屏」不跑过渡）
    await page.evaluate(() => { if (window.IR.Nav.currentScreen() !== 'home') window.IR.Nav.showScreen('home'); });
    await sleep(420);
    const samples = await page.evaluate(async ({ probeId }) => {
      return window.__lpApi.sample(probeId, 520, () => { window.IR.Nav.showScreen('shelf'); });
    }, { probeId: probe });
    await page.evaluate(() => window.IR.Nav.showScreen('home'));
    await sleep(420);
    return { samples, tail: await page.evaluate(() => ({
      held: window.__lpApi.held(),
      loops: window.__lpApi.loops(),
      vt: window.__lpApi.vtPseudos(),
      screen: window.IR.Nav.currentScreen(),
    })) };
  }

  if (sc.action === 'interrupt') {
    const samples = await page.evaluate(async ({ probeId }) => {
      return window.__lpApi.sample(probeId, 900, () => {
        const A = window.IR.App;
        A.openModal('modal-confirm');
        setTimeout(() => A.closeModal('modal-confirm'), 60);
        setTimeout(() => A.openModal('modal-confirm'), 100);
      });
    }, { probeId: probe });
    // 采样窗口结束时最后一段过渡早已落地：先读「打断后」的稳定态，再收尾关窗读「关窗后」
    await sleep(320);
    const tail = await page.evaluate(() => ({
      held: window.__lpApi.held(),
      loops: window.__lpApi.loops(),
      vt: window.__lpApi.vtPseudos(),
      stack: (window.IR.App.modalStack || []).slice(),
    }));
    await page.evaluate(() => window.IR.App.closeModal('modal-confirm'));
    await sleep(360);
    return { samples, tail: Object.assign(tail, { heldAfterClose: await page.evaluate(() => window.__lpApi.held()) }) };
  }

  if (sc.action === 'budget') {
    const data = await page.evaluate(async () => {
      const api = window.__lpApi;
      const MD = window.IR.MotionDOM;
      const ids = ['__lb1', '__lb2', '__lb3', '__lb4', '__lb5'];
      for (const id of ids) api.make(id, false);
      const offs = ids.map(id => MD.registerLoop(document.getElementById(id)));
      const before = api.attrs(ids);
      const beforeSlots = before.filter(x => !x.dataLoop).length;

      window.IR.Nav.showScreen('shelf');
      await new Promise(r => setTimeout(r, 90));   // 过渡已开：update 回调已跑（循环冻结中）
      const mid = api.attrs(ids);
      const heldMid = api.held();

      // 过渡中途改登记：注销第 1 个 + 新登记两个（预算应收敛到 3，但 hold 期间不许重排）
      offs[0]();
      api.make('__lb6', false);
      api.make('__lb7', false);
      MD.registerLoop(document.getElementById('__lb6'));
      MD.registerLoop(document.getElementById('__lb7'));
      const midAfter = api.attrs(ids.concat(['__lb6', '__lb7']));
      const heldMidAfter = api.held();

      await new Promise(r => setTimeout(r, 420));
      const after = api.attrs(ids.concat(['__lb6', '__lb7']));
      // __lb1 已注销（属性应被移除），预算只看仍在登记的 6 组
      const live = ['__lb2', '__lb3', '__lb4', '__lb5', '__lb6', '__lb7'];
      const slotsAfter = after.filter(x => live.indexOf(x.id) >= 0 && !x.dataLoop).length;
      const unregisteredClean = (after.find(x => x.id === '__lb1') || {}).dataLoop === '';
      window.IR.Nav.showScreen('home');
      await new Promise(r => setTimeout(r, 420));
      return {
        before, beforeSlots, mid, midAfter, after, slotsAfter, unregisteredClean,
        heldMid, heldMidAfter, heldEnd: api.held(),
      };
    });
    return { budget: data };
  }

  throw new Error('未知动作：' + sc.action);
}

/* ================= 断言 ================= */

function analyze(samples) {
  const paused = samples.filter(s => s.playState === 'paused');
  const pausedTimes = paused.map(s => s.currentTime).filter(v => typeof v === 'number');
  const last = samples[samples.length - 1] || {};
  const first = samples[0] || {};
  return {
    frames: samples.length,
    pausedFrames: paused.length,
    firstPausedAt: paused.length ? paused[0].t : null,
    lastPausedAt: paused.length ? paused[paused.length - 1].t : null,
    frozenDelta: pausedTimes.length > 1
      ? Math.round((Math.max(...pausedTimes) - Math.min(...pausedTimes)) * 10) / 10 : 0,
    resumeAdvance: pausedTimes.length && typeof last.currentTime === 'number'
      ? Math.round((last.currentTime - Math.max(...pausedTimes)) * 10) / 10 : null,
    advance: (typeof first.currentTime === 'number' && typeof last.currentTime === 'number')
      ? Math.round((last.currentTime - first.currentTime) * 10) / 10 : null,
    heldFrames: samples.filter(s => s.held).length,
    vtFrames: samples.filter(s => s.vt).length,
    // 采样窗口最后 120ms 还在 paused 才算「没解冻」（不写死 360ms：机器忙时过渡整体会晚起）
    pausedLate: paused.filter(s => last.t != null && s.t > last.t - 120).length,
    runningAtEnd: last.playState === 'running',
    lastT: last.t == null ? null : last.t,
  };
}

function judge(sc, data) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  const probe = sc.probe || PROBE;
  const samples = data.samples || [];
  const a = analyze(samples);
  const tail = data.tail || {};

  add('档位已落定（html[data-motion]=' + sc.tier + '）', data.dataMotion === sc.tier, data.dataMotion);
  if (samples.length) {
    add('测速循环确实在跑（采样首帧 currentTime 有值）',
      typeof (samples[0] || {}).currentTime === 'number' && (samples[0] || {}).playState !== '(none)',
      JSON.stringify(samples[0] || null));
  }

  if (sc.expect === 'no-freeze') {
    add('没有冻结：采到 0 帧 paused', a.pausedFrames === 0, 'paused=' + a.pausedFrames);
    add('没有 hold（loopsHeld 全程 false）', a.heldFrames === 0, 'held=' + a.heldFrames);
    add('循环时间正常前进（' + a.advance + 'ms / 520ms 窗口）', a.advance != null && a.advance > 200, 'advance=' + a.advance);
    add('没有出现快照动画（off / ?vt=0 不开 VT）', a.vtFrames === 0, 'vtFrames=' + a.vtFrames);
    add('收尾后 held=false、无残留快照', tail.held === false && (tail.vt || []).length === 0,
      'held=' + tail.held + ' vt=' + (tail.vt || []).join(','));
    add('收尾后弹窗已关、栈空（动作本身仍成功）',
      tail.modalOpen === false && Array.isArray(tail.stack) && tail.stack.length === 0,
      'visible=' + tail.modalOpen + ' stack=' + (tail.stack || []).join(','));
    return checks;
  }

  if (sc.expect === 'freeze') {
    add('过渡期间确实冻结：paused 帧 ≥ 2', a.pausedFrames >= 2, 'paused=' + a.pausedFrames);
    add('冻结发生在过渡开头（首帧 paused ≤ 150ms）',
      a.firstPausedAt != null && a.firstPausedAt <= 150, 'firstPausedAt=' + a.firstPausedAt);
    add('冻结期间 currentTime 不动（差 ≤ 2ms）', a.frozenDelta <= 2, 'frozenDelta=' + a.frozenDelta);
    add('冻结期间 hold 在位（held 帧 ≥ 2）', a.heldFrames >= 2, 'held=' + a.heldFrames);
    add('出现快照动画（真走 View Transition）', a.vtFrames > 0, 'vtFrames=' + a.vtFrames);
    add('过渡收尾后循环恢复播放', a.runningAtEnd, 'last=' + JSON.stringify(samples[samples.length - 1] || null));
    add('恢复后 currentTime 继续前进（解冻不是重置）',
      a.resumeAdvance != null && a.resumeAdvance > 30, 'resumeAdvance=' + a.resumeAdvance);
    add('收尾后不再有 paused 帧（' + (a.lastT || 0) + 'ms 窗口）', a.pausedLate === 0, 'pausedLate=' + a.pausedLate);
    add('收尾后 hold 已释放', tail.held === false, 'held=' + tail.held);
    add('收尾后无残留快照伪元素', (tail.vt || []).length === 0, (tail.vt || []).join(','));
    const stuck = (tail.loops || []).filter(x => x.id !== PAUSED_PROBE && x.playState !== 'running');
    add('收尾后文档里的循环全部在播（除刻意暂停的探针）',
      stuck.length === 0, stuck.map(x => x.id + '=' + x.playState).join(','));
    if (sc.action === 'modal') {
      add('收尾后弹窗已关、栈空', tail.modalOpen === false && (tail.stack || []).length === 0,
        'visible=' + tail.modalOpen + ' stack=' + (tail.stack || []).join(','));
    }
    return checks;
  }

  if (sc.expect === 'keep-paused') {
    add('刻意暂停的循环全程保持 paused（不被解冻逻辑复活）',
      a.pausedFrames === samples.length && a.advance === 0,
      'paused=' + a.pausedFrames + '/' + samples.length + ' advance=' + a.advance);
    add('过渡期间 hold 在位（说明冻结逻辑确实跑过）', a.heldFrames >= 2, 'held=' + a.heldFrames);
    add('收尾后它仍是 paused', (tail.loops || []).some(x => x.id === PAUSED_PROBE && x.playState === 'paused'),
      (tail.loops || []).filter(x => x.id === PAUSED_PROBE).map(x => x.playState).join(','));
    return checks;
  }

  if (sc.expect === 'settle' && tail && Object.keys(tail).length) {
    add('收尾后 hold=false（没有卡住的冻结计数）',
      tail.held === false && tail.heldAfterClose === false,
      'held=' + tail.held + ' afterClose=' + tail.heldAfterClose);
    add('收尾后无残留快照伪元素', (tail.vt || []).length === 0, (tail.vt || []).join(','));
    const stuck = (tail.loops || []).filter(x => x.id !== PAUSED_PROBE && x.playState !== 'running');
    add('收尾后文档里的循环全部在播（没有卡在 paused 的）',
      stuck.length === 0, stuck.map(x => x.id + '=' + x.playState).join(','));
    add('最后一次触发已落地（栈里只剩 confirm 或空）',
      Array.isArray(tail.stack) && (tail.stack.length === 0 || tail.stack[tail.stack.length - 1] === 'modal-confirm'),
      'stack=' + (tail.stack || []).join(','));
  }

  if (sc.action === 'budget') {
    const b = data.budget || {};
    const pick = (rows, ids) => (rows || []).filter(x => ids.indexOf(x.id) >= 0);
    const sameAttrs = (rows, ids) => ids.every((id) => {
      const x = (rows || []).find(r => r.id === id);
      const y = (b.before || []).find(r => r.id === id);
      return x && y && x.dataLoop === y.dataLoop;
    });
    add('登记 5 组 → 恰好 3 组在预算内（其余 data-loop="wait"）',
      b.beforeSlots === 3 && (b.before || []).filter(x => x.dataLoop === 'wait').length === 2,
      JSON.stringify(b.before));
    add('过渡开始后（hold 在位）预算没有被重排：__lb1~__lb5 的属性与登记时一致',
      b.heldMid === true && sameAttrs(b.mid, ['__lb1', '__lb2', '__lb3', '__lb4', '__lb5']),
      'held=' + b.heldMid + ' mid=' + JSON.stringify(b.mid));
    add('过渡中途注销 / 新登记也不重排：__lb2~__lb5 属性不变、新登记者不抢槽',
      b.heldMidAfter === true && sameAttrs(b.midAfter, ['__lb2', '__lb3', '__lb4', '__lb5'])
        && (b.midAfter || []).filter(x => x.id === '__lb6' || x.id === '__lb7').every(x => x.dataLoop === ''),
      'held=' + b.heldMidAfter + ' midAfter=' + JSON.stringify(b.midAfter));
    add('解冻后统一收敛：6 组登记里恰好 3 组在预算内',
      b.slotsAfter === 3, 'slotsAfter=' + b.slotsAfter + ' after=' + JSON.stringify(b.after));
    add('注销者的 data-loop 已清掉（不会带着排队标记留在 DOM 上）',
      b.unregisteredClean === true, '__lb1=' + JSON.stringify((b.after || []).find(x => x.id === '__lb1') || null));
    add('解冻后 hold 已释放', b.heldEnd === false, 'heldEnd=' + b.heldEnd);
  }

  return checks;
}

/* ================= 单场景 ================= */

async function runScenario(browser, sc) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const isSidecar = (s) => /\/health\b|127\.0\.0\.1:4319/.test(String(s));
  page.on('console', (m) => {
    const loc = m.location && m.location() ? m.location().url : '';
    if (m.type() === 'error' && !isSidecar(m.text()) && !isSidecar(loc)) {
      consoleErrors.push(m.text() + (loc ? ' @ ' + loc : ''));
    }
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String((e && e.message) || e)));

  await page.goto(APP_URL + (sc.query || ''), { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.IR && IR.App && IR.Store && IR.MotionDOM), null, { timeout: 20000 });
  await page.waitForFunction(() => !!(IR.App.state && IR.App.state.settings), null, { timeout: 20000 });
  await sleep(420);

  const data = { id: sc.id, tier: sc.tier, query: sc.query || '', expect: sc.expect, cap: sc.cap || null };
  data.dataMotion = await page.evaluate((t) => {
    const A = window.IR.App;
    A.state.settings.ui = A.state.settings.ui || {};
    A.state.settings.ui.motion = t;
    if (A.applyMotion) A.applyMotion();
    return document.documentElement.dataset.motion || '';
  }, sc.tier);

  await page.evaluate(installFixtures, { probe: PROBE, paused: PAUSED_PROBE });
  const result = await runAction(page, sc);
  data.samples = result.samples || [];
  if (result.tail) data.tail = result.tail;
  if (result.budget) data.budget = result.budget;

  const checks = judge(sc, data);
  data.checks = checks;
  data.ok = checks.every(c => c.ok) && consoleErrors.length === 0;
  data.consoleErrors = consoleErrors;

  for (const c of checks) log('    ' + (c.ok ? '✓ ' : '✗ ') + c.name + (c.ok || !c.detail ? '' : '  ← ' + c.detail));
  log('  [' + sc.id + '] 采样 ' + data.samples.length + ' 帧，console error ' + consoleErrors.length
    + ' → ' + (data.ok ? '通过' : '不通过'));

  await ctx.close();
  return data;
}

/* ================= 入口 ================= */

async function main() {
  const args = parseArgs();
  const outDir = path.resolve(ROOT, args.out);
  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(path.join(ROOT, 'dist', 'single', 'index.html'))) {
    console.error('[loop-freeze] 没有 dist/single/index.html：先 npm run build');
    process.exit(2);
  }

  const browser = await chromium.launch({ channel: 'chrome' });
  const manifest = {
    project: 'infinite-reading',
    version: VERSION,
    stage: '阶段 5 · 第 8 步 · 过渡期循环冻结（收尾）',
    generatedAt: new Date().toISOString(),
    tool: 'acceptance/phase5/8/loop-freeze-smoke.mjs',
    entry: APP_URL,
    how: {
      probe: '页面里插入 position:fixed 放到视口外的循环元素（kenBurns 4s infinite）+ 一个 animation-play-state:paused 的对照元素；'
        + '逐帧读 document.getAnimations() 的 playState / currentTime，并同步记 IR.MotionDOM.loopsHeld()',
      freeze: 'VT 的 update 回调里（新快照拍摄前）暂停所有正在跑的真实 DOM 循环；过渡收尾（含 skip / 被顶掉）计数式解冻',
      budget: 'hold 期间 registerLoop / 注销只记账不重排（data-loop 不抖），解冻后统一收敛到 Motion.LOOP_BUDGET',
      note: 'off / ?vt=0 没有快照，不冻结也不干预；本来停着的循环（data-paused / 预算排队 / 刻意暂停）不会被解冻逻辑复活',
    },
    scenarios: [],
  };

  let fatal = '';
  try {
    for (const sc of SCENARIOS) {
      log('== ' + sc.id + ' ==');
      manifest.scenarios.push(await runScenario(browser, sc));
    }
  } catch (e) {
    fatal = String((e && e.stack) || e);
    log('致命失败：' + fatal);
  }

  await browser.close();

  const all = manifest.scenarios.reduce((n, s) => n + s.checks.length, 0);
  const failed = manifest.scenarios.reduce((n, s) => n + s.checks.filter(c => !c.ok).length, 0);
  manifest.summary = {
    scenarios: manifest.scenarios.length,
    checks: all,
    failed,
    consoleErrors: manifest.scenarios.reduce((n, s) => n + s.consoleErrors.length, 0),
    fatal,
    ok: !fatal && failed === 0 && manifest.scenarios.every(s => s.ok),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  log('场景 ' + manifest.summary.scenarios + '，断言 ' + all + '，失败 ' + failed
    + ' → ' + (manifest.summary.ok ? '全绿' : '有失败'));
  process.exit(manifest.summary.ok ? 0 : 1);
}

main();
