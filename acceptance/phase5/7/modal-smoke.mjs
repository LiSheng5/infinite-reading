/*
 * acceptance/phase5/7/modal-smoke.mjs —— 阶段 5 · 第 7 步 · 弹窗开合自检
 *
 * 开 dist/single/index.html（file:// 双击的真实形态），逐档验弹窗开 / 关：
 *
 *   off          即时：调用返回的那一行 DOM 就已经换好（可见 / 隐藏），0 条 ::view-transition-*、
 *                0 个 view-transition-name；焦点仍回到开窗前的按钮
 *   standard-vt  VT 交叉淡入 / 淡出：只有「遮罩层」一个名字（group / new 在开，group / old 在关），
 *                卡片不命名（standard 不许位移）、只有 opacity、≤160ms、不循环
 *   rich-vt      同上 + 卡片名 modal-confirm-card：开 = ::view-transition-new(*-card) 从
 *                translateY(6px) scale(.96) 收进来；关 = ::view-transition-old(*-card) 退到
 *                translateY(-4px) scale(.98)；时长 ≤220ms。过渡期卡片自己的入场动画让位（animation-name:none）
 *   rich-fade    ?vt=0 降级：0 快照；开 = #modal-confirm 整块淡入（≤220ms）；关 = 即时（同步隐藏）
 *   nested       rich：设置 → 确认叠两层（栈序 / z-index 31、32 / 只关最上层），全程没有 (root) 快照
 *   interrupt    rich：开 → 60ms 关 → 40ms 再开，收尾后 0 条残留快照、0 个残留名字、最终停在「开」
 *
 * 共同断言：
 *   · 过渡期间根节点被 opt-out（html 的 view-transition-name = none），快照里绝不出现 (root) ——
 *     否则根快照会把 #app 的固定层与弹窗内部滚动一起拍成一张图（任务书「坑」）
 *   · 11 个弹窗容器与 .modal-card 都在（重写过的 10 个由 Svelte 产出 .modal-card，口径一致）
 *   · 收尾后 0 条残留快照 / 0 个残留名字
 *
 * 用法：node acceptance/phase5/7/modal-smoke.mjs [--out=acceptance/phase5/7]
 * 产出：{out}/manifest.json + 中间帧（open-rich-mid.png / close-rich-mid.png / open-rich-390-mid.png）
 * 退出码：0 = 全部通过；1 = 有场景没过 / 有页面错误
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

const MODAL = 'modal-confirm';
const CARD = MODAL + '-card';

const log = (...a) => console.log('[modal-smoke]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseArgs() {
  const out = { out: 'acceptance/phase5/7' };
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] == null ? '' : m[2];
  }
  return out;
}

const SCENARIOS = [
  { id: 'off', tier: 'off', query: '', expect: 'instant' },
  { id: 'standard-vt', tier: 'standard', query: '', expect: 'vt-fade', cap: 160 },
  { id: 'rich-vt', tier: 'rich', query: '', expect: 'vt-shift', cap: 220, shot: true },
  { id: 'rich-fade', tier: 'rich', query: '?vt=0', expect: 'fallback', cap: 220 },
  { id: 'nested', tier: 'rich', query: '', expect: 'nested', cap: 220 },
  { id: 'interrupt', tier: 'rich', query: '', expect: 'interrupt', cap: 220 },
  { id: 'legacy-ui', tier: 'rich', query: '?ui=legacy', expect: 'vt-shift', cap: 220 },
  { id: 'all-modals', tier: 'rich', query: '', expect: 'all' },
];

/* 页面内：采样器（按「名字 + 伪元素 + 目标 + 属性 + 位移值」归并——伪元素样式重算后 Chromium 会
 * 给出新的 Animation 对象，按对象去重会把同一段数成两段，phase5/4 实测过）。
 * 同时逐帧记：元素上的 view-transition-name（只在过渡期挂）、根节点上的 opt-out 值。 */
function installSampler() {
  const IGNORE = new Set(['offset', 'computedOffset', 'easing', 'composite']);
  window.__mkSample = async (ms) => {
    const seen = new Map();
    const names = new Set();
    let rootName = '';
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      let list = [];
      try { list = document.getAnimations(); } catch (_) {}
      for (const a of list) {
        const eff = a.effect;
        let timing = {};
        try { timing = eff.getTiming(); } catch (_) {}
        const properties = [];
        const transforms = [];
        try {
          for (const k of eff.getKeyframes()) {
            for (const p of Object.keys(k)) {
              if (IGNORE.has(p)) continue;
              if (properties.indexOf(p) < 0) properties.push(p);
              if (p === 'transform' && k[p] != null) transforms.push(String(k[p]));
            }
          }
        } catch (_) {}
        const key = (a.animationName || '') + '|' + ((eff && eff.pseudoElement) || '') + '|'
          + ((eff && eff.target && eff.target.id) || '') + '|' + properties.slice().sort().join('+')
          + '|' + transforms.join(';');
        const prev = seen.get(key);
        if (prev) { prev.playStates.push(a.playState); continue; }
        seen.set(key, {
          key,
          name: a.animationName || '',
          pseudo: (eff && eff.pseudoElement) || '',
          target: (eff && eff.target && eff.target.id) ? '#' + eff.target.id : '',
          duration: typeof timing.duration === 'number' ? Math.round(timing.duration * 1000) / 1000 : null,
          iterations: Number.isFinite(timing.iterations) ? timing.iterations : 'infinite',
          properties,
          transforms,
          playStates: [a.playState],
        });
      }
      try {
        const named = document.querySelectorAll('[style*="view-transition-name"]');
        for (const el of named) {
          const v = el.style.viewTransitionName;
          if (v) names.add((el.id || el.className || el.tagName) + '=' + v);
        }
      } catch (_) {}
      try {
        const rn = document.documentElement.style.viewTransitionName;
        if (rn) rootName = rn;
      } catch (_) {}
      await new Promise(r => requestAnimationFrame(r));
    }
    return { samples: Array.from(seen.values()), names: Array.from(names), rootName };
  };

  // 状态快照：显隐 / 栈 / 层级 / 名字 / 残留快照 / 焦点 / 卡片入场动画是否让位
  window.__mkState = (ids) => {
    const A = window.IR.App;
    const stack = (A.modalStack || []).slice();
    const out = { stack, modals: {}, active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '' };
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) { out.modals[id] = null; continue; }
      const card = el.querySelector('.modal-card');
      out.modals[id] = {
        visible: !el.classList.contains('hidden'),
        aria: el.getAttribute('aria-hidden'),
        z: el.style.zIndex || '',
        opacity: el.style.opacity || '',
        name: el.style.viewTransitionName || '',
        cardName: card ? (card.style.viewTransitionName || '') : '',
        cardAnim: card ? getComputedStyle(card).animationName : '',
      };
    }
    const vt = [];
    try {
      for (const a of document.getAnimations()) {
        const p = (a.effect && a.effect.pseudoElement) || '';
        if (p.indexOf('view-transition') >= 0) vt.push(p);
      }
    } catch (_) {}
    const names = [];
    try {
      for (const el of document.querySelectorAll('[style*="view-transition-name"]')) {
        const v = el.style.viewTransitionName;
        if (v) names.push((el.id || el.className || el.tagName) + '=' + v);
      }
    } catch (_) {}
    out.vtCount = vt.length;
    out.vtPseudos = Array.from(new Set(vt));
    out.names = names;
    out.rootName = document.documentElement.style.viewTransitionName || '';
    return out;
  };
}

async function openApp(page, query) {
  await page.goto(APP_URL + (query || ''), { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.IR && IR.App && IR.Store && IR.ModalHost), null, { timeout: 20000 });
  await page.waitForFunction(() => !!(IR.App.state && IR.App.state.settings), null, { timeout: 20000 });
  await sleep(400);
}

async function forceTier(page, tier) {
  const got = await page.evaluate((t) => {
    const A = window.IR.App;
    A.state.settings.ui = A.state.settings.ui || {};
    A.state.settings.ui.motion = t;
    if (A.applyMotion) A.applyMotion();
    return document.documentElement.dataset.motion || '';
  }, tier);
  if (got !== tier) throw new Error('档位没能落定：期望 ' + tier + '，实为 ' + (got || '(空)'));
  return got;
}

async function settle(page) {
  await page.evaluate(async () => {
    const isLoop = (a) => {
      try {
        const t = a.effect.getTiming();
        return !Number.isFinite(t.iterations) || t.iterations > 1;
      } catch (_) { return false; }
    };
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) {
      const running = document.getAnimations().filter(a => a.playState === 'running' && !isLoop(a));
      if (!running.length) return;
      await new Promise(r => requestAnimationFrame(r));
    }
  });
  await sleep(80);
}

/* ------------------------------- 场景动作 ------------------------------- */

/** 开窗：焦点先落在首页「书架」按钮上（关窗后要回到这里），再走真实入口 openModal */
async function openConfirm(page) {
  return page.evaluate(async () => {
    const btn = document.getElementById('btn-start-shelf');
    if (btn) btn.focus();
    const before = document.activeElement ? document.activeElement.id : '';
    const A = window.IR.App;
    A.openModal('modal-confirm');
    const el = document.getElementById('modal-confirm');
    const immediate = {
      visible: !el.classList.contains('hidden'),
      aria: el.getAttribute('aria-hidden'),
      stack: A.modalStack.slice(),
      z: el.style.zIndex || '',
    };
    const sampled = await window.__mkSample(460);
    return Object.assign({ before, immediate }, sampled);
  });
}

async function closeConfirmByApi(page) {
  return page.evaluate(async () => {
    const A = window.IR.App;
    A.closeModal('modal-confirm');
    const el = document.getElementById('modal-confirm');
    const immediate = {
      visible: !el.classList.contains('hidden'),
      aria: el.getAttribute('aria-hidden'),
      stack: A.modalStack.slice(),
    };
    const sampled = await window.__mkSample(460);
    return Object.assign({ immediate }, sampled);
  });
}

const uniq = (arr) => [...new Set(arr)];

/* Chromium 给 ::view-transition-group(*) 的默认补间是 identity（matrix(1,0,0,1,0,0)）：
 * 那是 UA 自己的「不位移」，不是我们挂的位移。判「有没有位移」时先把它滤掉。 */
const isIdentity = (t) => /^none$/.test(String(t).trim())
  || /^matrix\(\s*1,\s*0,\s*0,\s*1,\s*0,\s*0\s*\)$/.test(String(t).trim());
const moved = (s) => (s.transforms || []).filter(t => !isIdentity(t));

function vtOf(samples) {
  return (samples || []).filter(s => String(s.pseudo).includes('view-transition'));
}

function judge(sc, data) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

  add('档位已落定（html[data-motion]=' + sc.tier + '）', data.dataMotion === sc.tier, data.dataMotion);

  const open = data.open || {};
  const close = data.close || {};
  const vtOpen = vtOf(open.samples);
  const vtClose = vtOf(close.samples);
  const pseudoKey = (s) => s.pseudo;

  // —— 落点（所有场景都必须成立） ——
  add('开：弹窗可见 + aria-hidden=false + 栈顶是它',
    open.state.modals[MODAL] && open.state.modals[MODAL].visible
      && open.state.modals[MODAL].aria === 'false'
      && open.state.stack[open.state.stack.length - 1] === MODAL,
    JSON.stringify(open.state.modals[MODAL]) + ' stack=' + open.state.stack.join(','));
  add('开窗调用返回时 DOM 已换好（不把可见性推到下一帧：focus / 布局 / scrollIntoView 照旧）',
    open.immediate.visible === true, JSON.stringify(open.immediate));
  add('关：弹窗隐藏 + aria-hidden=true + 栈空 + 焦点回到开窗前的按钮',
    close.state.modals[MODAL]
      && !close.state.modals[MODAL].visible
      && close.state.modals[MODAL].aria === 'true'
      && close.state.stack.length === 0
      && close.state.active === open.before,
    JSON.stringify(close.state.modals[MODAL]) + ' stack=' + close.state.stack.join(',') + ' focus=' + close.state.active + '（期望 ' + open.before + '）');
  add('收尾后 0 条残留快照（开 / 关各一次采样）',
    open.state.vtCount === 0 && close.state.vtCount === 0,
    'open=' + open.state.vtCount + ' close=' + close.state.vtCount);
  add('收尾后 0 个残留 view-transition-name（含卡片名）',
    open.state.names.length === 0 && close.state.names.length === 0,
    open.state.names.join(',') + ' | ' + close.state.names.join(','));
  add('11 个弹窗容器与 .modal-card 都在',
    data.integrity.ok, data.integrity.detail);

  /* 快照里不许出现 (root)：根节点在过渡期被 opt-out（否则会曝光固定层与弹窗内部滚动） */
  const rootOpen = vtOpen.filter(s => pseudoKey(s).includes('(root)'));
  const rootClose = vtClose.filter(s => pseudoKey(s).includes('(root)'));
  if (sc.expect === 'instant' || sc.expect === 'fallback') {
    add('不开视图过渡（开 / 关都 0 条 ::view-transition-*）', vtOpen.length === 0 && vtClose.length === 0,
      vtOpen.map(pseudoKey).join(',') + ' | ' + vtClose.map(pseudoKey).join(','));
  } else {
    add('没有 (root) 快照（根节点已 opt-out）', rootOpen.length === 0 && rootClose.length === 0,
      uniq(rootOpen.concat(rootClose).map(pseudoKey)).join(','));
    add('过渡期间根节点被 opt-out（html style view-transition-name = none）',
      open.rootName === 'none' && close.rootName === 'none',
      'open=' + (open.rootName || '(空)') + ' close=' + (close.rootName || '(空)'));
  }

  if (sc.expect === 'instant') {
    add('off：开窗调用返回时 DOM 已可见（同步改）', open.immediate.visible === true, JSON.stringify(open.immediate));
    add('off：关窗调用返回时 DOM 已隐藏（同步改）', close.immediate.visible === false, JSON.stringify(close.immediate));
    add('off：不挂 view-transition-name（元素级 0 个）',
      open.names.length === 0 && close.names.length === 0,
      open.names.join(',') + ' | ' + close.names.join(','));
    const shifted = uniq(vtOpen.concat(vtClose).map(moved).flat());
    add('off：快照无位移（本来就没有快照）', shifted.length === 0, shifted.join(';'));
  }

  if (sc.expect === 'vt-fade') {
    for (const [label, vt] of [['开', vtOpen], ['关', vtClose]]) {
      const keys = uniq(vt.map(pseudoKey)).sort();
      add(label + '：只给遮罩层命名（modal-confirm），卡片不命名',
        keys.length > 0 && keys.every(k => k.includes('(' + MODAL + ')')),
        keys.join(' | '));
      add(label + '：名字里没有 -card（standard 不许位移）', keys.every(k => !k.includes('-card')), keys.join(' | '));
      const overs = vt.filter(s => s.duration != null && s.duration > (sc.cap || 160) + 0.5);
      add(label + '：快照动画时长 ≤ ' + (sc.cap || 160) + 'ms', overs.length === 0, overs.map(s => pseudoKey(s) + '=' + s.duration).join(' | '));
      add(label + '：快照动画不循环', vt.every(s => s.iterations === 1), vt.map(s => s.iterations).join(','));
      const shift = vt.filter(s => moved(s).length);
      add(label + '：无位移（0 条实际 transform）', shift.length === 0, shift.map(s => pseudoKey(s) + ':' + moved(s).join(';')).join(' | '));
    }
    add('开：新快照在（::view-transition-new(modal-confirm)）',
      vtOpen.some(s => pseudoKey(s).includes('-new(' + MODAL + ')')), vtOpen.map(pseudoKey).join(','));
    add('关：旧快照在（::view-transition-old(modal-confirm)）',
      vtClose.some(s => pseudoKey(s).includes('-old(' + MODAL + ')')), vtClose.map(pseudoKey).join(','));
    add('过渡期元素上的名字（开）', open.names.some(n => n.indexOf(MODAL + '=') >= 0), open.names.join(','));
  }

  if (sc.expect === 'vt-shift') {
    /* 同一段伪元素动画在采样窗口里可能被 Chromium 重算成两条（旧对象 getKeyframes() 为空），
     * 所以按「所有命中样本的 transform 全集」判，不要求每一条都带 keyframes。 */
    const newCard = vtOpen.filter(s => pseudoKey(s).includes('-new(' + CARD + ')'));
    const oldCard = vtClose.filter(s => pseudoKey(s).includes('-old(' + CARD + ')'));
    const movesIn = newCard.map(moved).reduce((a, b) => a.concat(b), []);
    const movesOut = oldCard.map(moved).reduce((a, b) => a.concat(b), []);
    add('开：卡片新快照有位移（translateY(6px) scale(.96) → none）',
      newCard.length >= 1 && movesIn.length >= 1
        && movesIn.every(t => t === 'none' || (t.indexOf('6px') >= 0 && t.indexOf('scale(0.96)') >= 0)),
      newCard.map(s => pseudoKey(s) + ':' + moved(s).join(';')).join(' | '));
    add('关：卡片旧快照反向退场（none → translateY(-4px) scale(.98)）',
      oldCard.length >= 1 && movesOut.length >= 1
        && movesOut.every(t => t === 'none' || (t.indexOf('-4px') >= 0 && t.indexOf('scale(0.98)') >= 0)),
      oldCard.map(s => pseudoKey(s) + ':' + moved(s).join(';')).join(' | '));
    add('开 / 关：遮罩层也参与（modal-confirm 各自有新 / 旧快照）',
      vtOpen.some(s => pseudoKey(s).includes('-new(' + MODAL + ')'))
        && vtClose.some(s => pseudoKey(s).includes('-old(' + MODAL + ')')),
      vtOpen.map(pseudoKey).join(',') + ' | ' + vtClose.map(pseudoKey).join(','));
    const overs = vtOpen.concat(vtClose).filter(s => s.duration != null && s.duration > (sc.cap || 220) + 0.5);
    add('快照动画时长 ≤ ' + (sc.cap || 220) + 'ms', overs.length === 0, overs.map(s => pseudoKey(s) + '=' + s.duration).join(' | '));
    add('快照动画不循环', vtOpen.concat(vtClose).every(s => s.iterations === 1), '');
    /* 开窗后（快照已落地、弹窗仍开着）卡片自己的入场动画必须还是让位状态——否则说明它被拍进了
     * 新快照的第一帧（opacity:0 / translateY(10px)），遮罩淡入时卡片是半透明的。
     * 关窗那一侧不查「让位」：隐藏与恢复在同一帧发生（元素已不可见），查的是下面那条恢复项。 */
    add('开窗后卡片入场动画仍让位（animation-name:none，没被拍进快照第一帧）',
      open.state.modals[MODAL].cardAnim === 'none',
      open.state.modals[MODAL].cardAnim);
    add('关窗后卡片入场动画已恢复（下一次开窗照旧有它）',
      close.state.modals[MODAL].cardAnim !== 'none',
      close.state.modals[MODAL].cardAnim);
  }

  if (sc.expect === 'fallback') {
    const fadeOpen = (open.samples || []).filter(s => s.target === '#' + MODAL
      && !String(s.pseudo).includes('view-transition')
      && s.properties.indexOf('opacity') >= 0);
    add('降级：开 = #modal-confirm 整块淡入（≤220ms）',
      fadeOpen.length >= 1 && fadeOpen.every(s => (s.duration || 0) <= 220.5),
      fadeOpen.map(s => s.target + '@' + s.duration).join(' | '));
    add('降级：关窗即时（调用返回后就已隐藏）', close.immediate.visible === false, JSON.stringify(close.immediate));
  }

  return { checks, vtOpen: vtOpen.length, vtClose: vtClose.length };
}

/* ------------------------------- 场景主流程 ------------------------------- */

async function modalIntegrity(page) {
  return page.evaluate(() => {
    const ids = (window.IR.ModalHost && IR.ModalHost.MODAL_IDS) || [];
    const bad = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) { bad.push(id + ':缺容器'); continue; }
      if (!el.classList.contains('modal')) bad.push(id + ':不是 .modal');
      if (!el.querySelector('.modal-card')) bad.push(id + ':缺 .modal-card');
    }
    return { ok: ids.length === 11 && bad.length === 0, detail: ids.length + ' 个 / ' + (bad.join(',') || '全部完整') };
  });
}

async function runScenario(browser, sc, shotDir) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const isSidecar = (s) => /\/health\b/.test(String(s));
  page.on('console', (m) => {
    const loc = m.location && m.location() ? m.location().url : '';
    if (m.type() === 'error' && !isSidecar(m.text()) && !isSidecar(loc)) consoleErrors.push(m.text() + (loc ? ' @ ' + loc : ''));
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e && e.message || e)));

  await openApp(page, sc.query);
  await forceTier(page, sc.tier);
  await page.evaluate(installSampler);
  const integrity = await modalIntegrity(page);

  const data = { id: sc.id, tier: sc.tier, query: sc.query, expect: sc.expect, cap: sc.cap || null, integrity, consoleErrors };
  data.dataMotion = await page.evaluate(() => document.documentElement.dataset.motion || '');

  if (sc.expect === 'all') {
    const ids = await page.evaluate(() => (window.IR.ModalHost && IR.ModalHost.MODAL_IDS) || []);
    const rows = [];
    for (const id of ids) {
      const r = await page.evaluate(async (mid) => {
        const A = window.IR.App;
        A.openModal(mid);
        /* 开窗那一侧必须当帧就可见（不是等到 update 回调）：遗产代码里「开完立刻 focus / 量布局 /
         * scrollIntoView」的调用点都按同步语义写（irConfirm 的输入框、文本导入的 #it-text、
         * 「定时主动」入口滚到 #fs-schedule）。这里连 DOM 与布局一起量。 */
        const el = document.getElementById(mid);
        const card = el.querySelector('.modal-card');
        const syncOpen = !el.classList.contains('hidden');
        const syncH = card ? Math.round(card.getBoundingClientRect().height) : 0;
        await new Promise(done => setTimeout(done, 430));
        const openOk = !el.classList.contains('hidden')
          && el.getAttribute('aria-hidden') === 'false'
          && A.modalStack[A.modalStack.length - 1] === mid;
        const z = el.style.zIndex;
        const opacity = el.style.opacity;
        A.closeModal(mid);
        await new Promise(done => setTimeout(done, 430));
        const st = window.__mkState([mid]);
        return {
          id: mid,
          syncOpen,
          syncH,
          opacity,
          openOk,
          z,
          closed: !st.modals[mid].visible && st.modals[mid].aria === 'true' && st.stack.length === 0,
          vt: st.vtCount,
          names: st.names,
          root: st.rootName,
        };
      }, id);
      rows.push(r);
    }
    const bad = rows.filter(r => !r.openOk || !r.closed || r.vt !== 0 || r.names.length !== 0 || r.root !== '');
    const zOk = rows.every((r) => r.z === '31');   // 每次只开一层 → 栈深 1 → 31
    const syncBad = rows.filter(r => !r.syncOpen || !(r.syncH > 0));
    const opacityBad = rows.filter(r => r.opacity !== '');
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
    add('档位已落定（html[data-motion]=' + sc.tier + ')', data.dataMotion === sc.tier, data.dataMotion);
    add('11 个弹窗逐个开 / 关都干净（可见 → 隐藏、栈起落、0 残留快照 / 名字）',
      rows.length === 11 && bad.length === 0,
      bad.map(r => r.id + '(' + JSON.stringify(r) + ')').join(' | ') || (rows.length + ' 个全部通过'));
    add('逐个打开时都是首层（z-index 31）', zOk, rows.map(r => r.id + '=' + r.z).join(' '));
    add('开窗当帧就可见且量得到布局（卡片高度 > 0，focus / scrollIntoView 不会落空）',
      syncBad.length === 0, syncBad.map(r => r.id + '(open=' + r.syncOpen + ' h=' + r.syncH + ')').join(' | '));
    add('过渡结束后不残留 inline opacity', opacityBad.length === 0,
      opacityBad.map(r => r.id + '=' + r.opacity).join(' | '));
    data.rows = rows;
    data.open = { samples: [], names: [], rootName: '', state: await page.evaluate(() => window.__mkState([])) };
    data.close = { samples: [], names: [], rootName: '', state: await page.evaluate(() => window.__mkState([])) };
    data.checks = checks;
    data.ok = checks.every(c => c.ok) && consoleErrors.length === 0;

    for (const c of data.checks) log('    ' + (c.ok ? '✓ ' : '✗ ') + c.name + (c.ok || !c.detail ? '' : '  ← ' + c.detail));
    log('  [' + sc.id + '] console error ' + consoleErrors.length + ' → ' + (data.ok ? '通过' : '不通过'));
    await ctx.close();
    return data;
  }

  if (sc.expect === 'nested') {
    // 设置 → 确认叠两层：确认弹窗不参与功能类互斥，可以压在设置上
    const open = await page.evaluate(async () => {
      const A = window.IR.App;
      A.openModal('modal-settings');
      await new Promise(r => setTimeout(r, 420));
      const mid = { stack: A.modalStack.slice(), zSettings: (document.getElementById('modal-settings') || {}).style.zIndex };
      A.openModal('modal-confirm');
      const sampled = await window.__mkSample(460);
      return Object.assign({ mid, before: 'modal-settings' }, sampled);
    });
    const stateOpen = await page.evaluate(() => window.__mkState(['modal-settings', 'modal-confirm']));
    // 只关最上层（Esc 语义），设置必须还开着
    const closeTop = await page.evaluate(async () => {
      const A = window.IR.App;
      const handled = A.closeTopModal();
      const sampled = await window.__mkSample(460);
      return Object.assign({ handled }, sampled);
    });
    const stateTop = await page.evaluate(() => window.__mkState(['modal-settings', 'modal-confirm']));
    const closeRest = await page.evaluate(async () => {
      const A = window.IR.App;
      A.closeModal('modal-settings');
      const sampled = await window.__mkSample(460);
      return Object.assign({}, sampled);
    });
    const stateAll = await page.evaluate(() => window.__mkState(['modal-settings', 'modal-confirm']));

    const vtNested = vtOf(open.samples);
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
    add('档位已落定（html[data-motion]=' + sc.tier + '）', data.dataMotion === sc.tier, data.dataMotion);
    add('叠两层：栈 = 设置 → 确认', open.mid.stack.length === 1 && open.mid.stack[0] === 'modal-settings'
      && stateOpen.stack.length === 2 && stateOpen.stack[0] === 'modal-settings' && stateOpen.stack[1] === 'modal-confirm',
      open.mid.stack.join(',') + ' → ' + stateOpen.stack.join(','));
    add('层级：设置 31 / 确认 32',
      open.mid.zSettings === '31' && stateOpen.modals['modal-settings'].z === '31' && stateOpen.modals['modal-confirm'].z === '32',
      open.mid.zSettings + ' / ' + stateOpen.modals['modal-settings'].z + ' / ' + stateOpen.modals['modal-confirm'].z);
    add('两层都可见', stateOpen.modals['modal-settings'].visible && stateOpen.modals['modal-confirm'].visible, '');
    add('确认层入场只拍确认自己的两层名字（遮罩 + 卡片），不带设置',
      vtNested.some(s => s.pseudo.includes('(' + MODAL + ')')) && vtNested.some(s => s.pseudo.includes('(' + CARD + ')'))
        && !vtNested.some(s => s.pseudo.includes('(modal-settings')),
      uniq(vtNested.map(s => s.pseudo)).join(' | '));
    add('叠层期间没有 (root) 快照', !vtNested.some(s => s.pseudo.includes('(root)')), uniq(vtNested.map(s => s.pseudo)).join(','));
    add('Esc / closeTopModal 只关最上层（设置仍开着）',
      closeTop.handled === true && !stateTop.modals[MODAL].visible && stateTop.modals['modal-settings'].visible
        && stateTop.stack.join(',') === 'modal-settings',
      'handled=' + closeTop.handled + ' stack=' + stateTop.stack.join(','));
    add('关最上层后按栈序重排：设置回到 31', stateTop.modals['modal-settings'].z === '31', stateTop.modals['modal-settings'].z);
    add('收尾后栈空、两层都隐藏、0 残留快照 / 0 残留名字',
      stateAll.stack.length === 0 && !stateAll.modals['modal-settings'].visible && !stateAll.modals[MODAL].visible
        && stateAll.vtCount === 0 && stateAll.names.length === 0,
      'stack=' + stateAll.stack.join(',') + ' vt=' + stateAll.vtCount + ' names=' + stateAll.names.join(','));

    data.open = { samples: open.samples, names: open.names, rootName: open.rootName, state: stateOpen, before: 'modal-settings' };
    data.close = { samples: closeRest.samples, names: closeRest.names, rootName: closeRest.rootName, state: stateAll };
    data.top = { samples: closeTop.samples, state: stateTop };
    data.checks = checks;
    data.ok = checks.every(c => c.ok) && consoleErrors.length === 0;
  } else {
    const open = await openConfirm(page);
    const openState = await page.evaluate(() => window.__mkState(['modal-confirm']));
    const close = await closeConfirmByApi(page);
    const closeState = await page.evaluate(() => window.__mkState(['modal-confirm']));

    data.open = Object.assign(open, { state: openState });
    data.close = Object.assign(close, { state: closeState });

    const verdict = judge(sc, data);
    data.checks = verdict.checks;
    data.ok = data.checks.every(c => c.ok) && consoleErrors.length === 0;

    /* 真实入口（irConfirm / closeConfirm）在每一档都要照旧：
     * 开窗当帧把输入框聚焦并全选（遗产代码是 openModal 之后同步 focus 的）、关窗收掉 Promise。
     * 这条是「开窗那一侧不许把 DOM 变更推到下一帧」的回归闸——第 7 步最初把显示推迟到
     * update 回调，focus 全落空（实测 activeElement 停在触发按钮上）。 */
    const promise = await page.evaluate(async () => {
      const A = window.IR.App;
      const btn = document.getElementById('btn-start-shelf');
      if (btn) btn.focus();
      const p = A.irConfirm('开合自检：输入型确认弹窗的焦点与 Promise', { input: true, value: 'abc', title: '重命名' });
      await new Promise(r => setTimeout(r, 380));
      const inp = document.getElementById('cf-input');
      const active = document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '';
      const sel = { start: inp.selectionStart, end: inp.selectionEnd, v: inp.value };
      A.closeConfirm('好');
      const v = await p;
      await new Promise(r => setTimeout(r, 320));
      const closed = document.getElementById('modal-confirm').classList.contains('hidden');
      const back = document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '';
      return { active, sel, v, closed, back };
    });
    data.promise = promise;
    data.checks.push({
      name: 'irConfirm（输入型）：开窗当帧聚焦输入框并全选，closeConfirm 收掉 Promise 且焦点回到触发按钮',
      ok: promise.active === 'cf-input' && promise.sel.start === 0 && promise.sel.end === 3
        && promise.v === '好' && promise.closed === true && promise.back === 'btn-start-shelf',
      detail: JSON.stringify(promise),
    });
    data.ok = data.checks.every(c => c.ok) && consoleErrors.length === 0;

    if (sc.id === 'off') {
      const sync = await page.evaluate(async () => {
        const A = window.IR.App;
        const p = A.irConfirm('开合自检：确认弹窗的 Promise 收口', { okText: '好' });
        await new Promise(r => setTimeout(r, 360));
        const opened = !document.getElementById('modal-confirm').classList.contains('hidden');
        A.closeConfirm(true);
        const v = await p;
        const closed = document.getElementById('modal-confirm').classList.contains('hidden');
        return { opened, v, closed };
      });
      data.promise2 = sync;
      data.checks.push({
        name: 'irConfirm → closeConfirm 仍能收掉 Promise（开得起来、关得掉、resolve 值正确）',
        ok: sync.opened === true && sync.closed === true && sync.v === true,
        detail: JSON.stringify(sync),
      });
      data.ok = data.checks.every(c => c.ok) && consoleErrors.length === 0;
    }

    if (sc.id === 'interrupt') {
      // 打断：开 → 60ms 关 → 40ms 再开
      await page.evaluate(async () => {
        const A = window.IR.App;
        A.openModal('modal-confirm');
        await new Promise(r => setTimeout(r, 60));
        A.closeModal('modal-confirm');
        await new Promise(r => setTimeout(r, 40));
        A.openModal('modal-confirm');
      });
      await sleep(800);
      const st = await page.evaluate(() => window.__mkState(['modal-confirm']));
      data.interrupt = st;
      data.checks.push({
        name: '打断：最终停在「开」（可见 + 栈顶）',
        ok: st.modals[MODAL].visible === true && st.stack[st.stack.length - 1] === MODAL,
        detail: 'visible=' + st.modals[MODAL].visible + ' stack=' + st.stack.join(','),
      });
      data.checks.push({ name: '打断：收尾后 0 条残留快照', ok: st.vtCount === 0, detail: String(st.vtCount) });
      data.checks.push({
        name: '打断：不残留 view-transition-name',
        ok: st.names.length === 0 && st.rootName === '',
        detail: st.names.join(',') + ' root=' + (st.rootName || '(空)'),
      });
      data.checks.push({
        name: '打断：不残留入场用的 inline opacity（否则下次开门是透明的）',
        ok: st.modals[MODAL].opacity === '',
        detail: 'opacity=' + (st.modals[MODAL].opacity || '(空)'),
      });
      await page.evaluate(() => window.IR.App.closeModal('modal-confirm'));
      data.ok = data.checks.every(c => c.ok) && consoleErrors.length === 0;
    }

    // 中间帧：单独跑一次，停 70ms 后截图（采样窗口跑完时过渡已经结束，拍不到中间状态）
    if (sc.shot) {
      await page.evaluate(() => { const b = document.getElementById('btn-start-shelf'); if (b) b.focus(); });
      await page.evaluate(() => window.IR.App.openModal('modal-confirm'));
      await sleep(70);
      await page.screenshot({ path: path.join(shotDir, 'open-' + sc.id + '-mid.png'), animations: 'allow' });
      await page.evaluate(() => window.IR.App.closeModal('modal-confirm'));
      await sleep(70);
      await page.screenshot({ path: path.join(shotDir, 'close-' + sc.id + '-mid.png'), animations: 'allow' });
      // 窄屏（390）再看一眼：模态卡在手机上不能溢出
      await page.setViewportSize({ width: 390, height: 780 });
      await sleep(120);
      await page.evaluate(() => window.IR.App.openModal('modal-confirm'));
      await sleep(70);
      await page.screenshot({ path: path.join(shotDir, 'open-' + sc.id + '-390-mid.png'), animations: 'allow' });
      await sleep(400);
      const narrow = await page.evaluate(() => {
        const el = document.getElementById('modal-confirm');
        const card = el.querySelector('.modal-card');
        const r = card.getBoundingClientRect();
        return { cardW: Math.round(r.width), cardH: Math.round(r.height), vw: window.innerWidth, hidden: el.classList.contains('hidden') };
      });
      data.narrow = narrow;
      data.checks.push({
        name: '390 宽：卡片不溢出（宽 ≤ 视口、可见）',
        ok: narrow.cardW <= narrow.vw && narrow.hidden === false,
        detail: JSON.stringify(narrow),
      });
      await page.evaluate(() => window.IR.App.closeModal('modal-confirm'));
      data.ok = data.checks.every(c => c.ok) && consoleErrors.length === 0;
    }
  }

  for (const c of data.checks) log('    ' + (c.ok ? '✓ ' : '✗ ') + c.name + (c.ok || !c.detail ? '' : '  ← ' + c.detail));
  log('  [' + sc.id + '] 开 ' + (data.open ? data.open.samples.length : 0) + ' 条 / 关 ' + (data.close ? data.close.samples.length : 0)
    + ' 条动画采样，console error ' + consoleErrors.length + ' → ' + (data.ok ? '通过' : '不通过'));

  await ctx.close();
  return data;
}

async function main() {
  const args = parseArgs();
  const outDir = path.resolve(ROOT, args.out);
  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(path.join(ROOT, 'dist', 'single', 'index.html'))) {
    console.error('[modal-smoke] 没有 dist/single/index.html：先 npm run build');
    process.exit(2);
  }

  const browser = await chromium.launch({ channel: 'chrome' });
  const result = {
    project: 'infinite-reading',
    version: VERSION,
    stage: '阶段 5 · 第 7 步 · 弹窗开合（过渡内核接线）',
    generatedAt: new Date().toISOString(),
    tool: 'acceptance/phase5/7/modal-smoke.mjs',
    entry: APP_URL,
    how: {
      capture: '动作窗口内 requestAnimationFrame 逐帧 document.getAnimations() + 逐帧元素级 view-transition-name / 根 opt-out 值',
      tiers: '档位靠 settings.ui.motion + IR.App.applyMotion() 显式落定，跑前校验 html[data-motion]',
      degrade: '?vt=0 强制降级（不走 View Transition：开窗整块淡入、关窗同步隐藏）',
      assert: 'off 同步生效无快照；standard 只有遮罩层名字、只有 opacity、≤160ms；rich 加卡片名与 translateY/scale、≤220ms；'
        + '所有 VT 场景都没有 (root) 快照（根节点 opt-out）',
    },
    scenarios: [],
  };

  let fatal = '';
  try {
    for (const sc of SCENARIOS) {
      log('== ' + sc.id + ' ==');
      result.scenarios.push(await runScenario(browser, sc, outDir));
    }
  } catch (e) {
    fatal = String((e && e.stack) || e);
    log('致命失败：' + fatal);
  }

  await browser.close();

  const all = result.scenarios.reduce((n, s) => n + s.checks.length, 0);
  const failed = result.scenarios.reduce((n, s) => n + s.checks.filter(c => !c.ok).length, 0);
  result.summary = {
    scenarios: result.scenarios.length,
    checks: all,
    failed,
    consoleErrors: result.scenarios.reduce((n, s) => n + s.consoleErrors.length, 0),
    fatal,
    ok: !fatal && failed === 0 && result.scenarios.every(s => s.ok),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(result, null, 2), 'utf8');
  log('场景 ' + result.summary.scenarios + '，断言 ' + all + '，失败 ' + failed + ' → ' + (result.summary.ok ? '全绿' : '有失败'));
  process.exit(result.summary.ok ? 0 : 1);
}

main();
