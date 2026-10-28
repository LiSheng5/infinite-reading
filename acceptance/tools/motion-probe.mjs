/*
 * acceptance/tools/motion-probe.mjs —— 阶段 5 · 第 1 步 · 动效测量工具
 *
 * 干什么：按 --tier=off|standard|rich 打开 file:// 的 dist/single/index.html（双击的真实形态），
 * 播种一局最小故事（含一次真分叉、两张图），然后跑一组固定动作：
 *
 *   screen   切屏：首页 → 书架 → 首页 → 阅读页
 *   stage    舞台换画：点缩略条换图（换画交叉淡入 / 原图升级 blur-up）
 *   sibling  切兄弟：点旁白的 ‹ n/m › 换分支（旧 WAAPI animateSwap）
 *   modal    设置弹窗开 / 关
 *
 * 每个动作窗口内用 document.getAnimations() 逐帧采集（rAF 采样 + 动作收尾再补一次），
 * 记下每条动画的时长 / 迭代次数 / 动的属性 / 目标元素 / 伪元素 / 触发步，
 * 再按三档上限断言（真源 = 页面里的 IR.Motion.TIERS / LOOP_BUDGET，与 css/motion.css 收口一致）：
 *
 *   off       无位移（maxShiftMs 0）、无颜色过渡、透明度 ≤80ms、循环 0 组
 *   standard  位移 ≤160ms、透明度 ≤160ms、颜色 ≤220ms、循环 0 组
 *   rich      位移 ≤220ms、透明度 ≤420ms、颜色 ≤220ms、循环 ≤3 组（同名多实例按 1 组）
 *
 * 产出（--out 默认 acceptance/phase5/1）：
 *   {out}/{tier}/{tier}-{动作}-{序}-{pre|mid|end}.png   动作前 / 动作中 / 动作后的画面
 *   {out}/manifest.json                                三档可累积（跑一档只替换这一档）
 *
 * 用法：
 *   node acceptance/tools/motion-probe.mjs --tier=off|standard|rich
 *        [--out=acceptance/phase5/1] [--actions=screen,stage,sibling,modal]
 *        [--width=1280|390] [--strict]
 *
 * 退出码：0 = 三档动作全部跑完且 console error / pageerror 为 0
 *         1 = 有动作没跑完、或出现 console error / pageerror
 *         2 = 用法错误（缺 --tier 等）
 * --strict：额外要求「零违规」（违规 = 超出该档上限）。第 1 步默认不 strict：
 *          当前多数动作还没有过渡（属正常），测量结果里的 violations 是后续步骤的待办清单。
 *
 * 约定：
 *  - 只新增文件，不改产品代码；页面一律 file:// 打开，不联网（本地服务探测被本地路由接住）。
 *  - Chromium 走系统 Chrome（channel:'chrome'），不下载浏览器。
 *  - 档位靠 settings.ui.motion + IR.App.applyMotion() 显式落定，并校验 html[data-motion]，
 *    不依赖 auto 的系统偏好推测；上下文 reducedMotion 取 no-preference。
 *  - 截图不开 animations:'disabled'——要的就是动画进行中的中间帧。
 */
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const APP_URL = pathToFileURL(path.join(ROOT, 'dist', 'single', 'index.html')).href;

const TIERS = ['off', 'standard', 'rich'];
const ACTIONS = ['screen', 'stage', 'sibling', 'modal'];
const ACTION_NOTES = {
  screen: '切屏：首页 → 书架 → 首页 → 阅读页（当前实现只切 .hidden，无过渡属正常）',
  stage: '舞台换画：缩略条点第 1 / 第 2 张（换画交叉淡入 + 模糊底延后换）',
  sibling: '切兄弟：旁白 ‹ n/m › 上一条 / 下一条（旧 WAAPI animateSwap）',
  modal: '设置弹窗：顶栏「⋯」→ 全局设置 → 关闭（.modal-card 入场动画）',
};

const log = (...a) => console.log('[motion-probe]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseArgs() {
  const out = { tier: '', out: 'acceptance/phase5/1', actions: ACTIONS.join(','), width: '1280', strict: false };
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[1] === 'strict') out.strict = true;
    else out[m[1]] = m[2] == null ? '' : m[2];
  }
  return out;
}

function usage(msg) {
  console.error('[motion-probe] ' + msg);
  console.error('用法：node acceptance/tools/motion-probe.mjs --tier=off|standard|rich [--out=acceptance/phase5/1] [--actions=screen,stage,sibling,modal] [--width=1280|390] [--strict]');
  process.exit(2);
}

/* ================= 页面内：采集器（rAF 逐帧 + 动作收尾补采） ================= */

// 注入到页面里执行（不要引用 Node 侧变量）
function installRecorder() {
  const IGNORE = new Set(['offset', 'computedOffset', 'easing', 'composite']);
  const state = { records: null, seen: null, step: 'idle', steps: [], raf: 0 };

  const describeTarget = (el) => {
    if (!el) return '(none)';
    const tag = (el.tagName || '').toLowerCase();
    const id = el.id ? '#' + el.id : '';
    let cls = '';
    if (typeof el.className === 'string' && el.className.trim()) {
      cls = '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
    }
    return tag + id + cls;
  };

  const timingOf = (anim) => {
    let t = {};
    try { t = anim.effect.getTiming(); } catch (_) {}
    let duration = t.duration;
    if (typeof duration !== 'number') {
      try {
        const cs = getComputedStyle(anim.effect.target, anim.effect.pseudoElement || null);
        duration = parseFloat(cs.animationDuration) || 0;
      } catch (_) { duration = 0; }
    }
    let iterations = t.iterations;
    if (iterations == null) iterations = 1;
    return {
      duration: Math.round(duration * 1000) / 1000,
      iterations: Number.isFinite(iterations) ? iterations : 'infinite',
      easing: String(t.easing || ''),
    };
  };

  const propsOf = (anim) => {
    const out = [];
    try {
      for (const k of anim.effect.getKeyframes()) {
        for (const key of Object.keys(k)) if (!IGNORE.has(key) && out.indexOf(key) < 0) out.push(key);
      }
    } catch (_) {}
    return out;
  };

  const record = (anim) => {
    const seen = state.seen.get(anim);
    if (seen) { seen.frames += 1; return; }
    const timing = timingOf(anim);
    const rec = {
      kind: (anim.constructor && anim.constructor.name) || 'Animation',
      name: anim.animationName || anim.transitionProperty || '',
      step: state.step,
      target: describeTarget(anim.effect && anim.effect.target),
      pseudo: (anim.effect && anim.effect.pseudoElement) || '',
      duration: timing.duration,
      iterations: timing.iterations,
      easing: timing.easing,
      properties: propsOf(anim),
      playState: anim.playState,
      frames: 1,
    };
    state.seen.set(anim, rec);
    state.records.push(rec);
  };

  const sample = () => {
    try { for (const a of document.getAnimations()) record(a); } catch (_) {}
  };

  const loop = () => { sample(); state.raf = requestAnimationFrame(loop); };

  window.__motionProbe = {
    start() {
      state.records = [];
      state.seen = new WeakMap();
      state.step = 'idle';
      state.steps = [];
      sample();
      state.raf = requestAnimationFrame(loop);
    },
    step(label) {
      sample();                 // 换步前先采一次，避免上一段最后一帧漏记
      state.step = String(label || '');
      state.steps.push(state.step);
    },
    stop() {
      sample();
      if (state.raf) cancelAnimationFrame(state.raf);
      state.raf = 0;
      const out = { records: state.records.slice(), steps: state.steps.slice() };
      state.records = null;
      return out;
    },
  };
}

/* ================= 页面稳定化 ================= */

// 等到「非循环」动画全部收干净（循环动画永远在跑，单独按预算判定，不能等）
async function settle(page) {
  await page.evaluate(async () => {
    const isLoop = (a) => {
      try {
        const t = a.effect.getTiming();
        return !Number.isFinite(t.iterations) || t.iterations > 1;
      } catch (_) { return false; }
    };
    const t0 = performance.now();
    while (performance.now() - t0 < 2500) {
      const running = document.getAnimations().filter(a => a.playState === 'running' && !isLoop(a));
      if (!running.length) return;
      await new Promise(r => requestAnimationFrame(r));
    }
  });
  await sleep(80);
}

async function openApp(page) {
  await page.goto(APP_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.IR && IR.App && IR.Store), null, { timeout: 20000 });
  await page.waitForFunction(() => !!(IR.App.state && IR.App.state.settings), null, { timeout: 20000 });
  await sleep(500);
}

async function forceTier(page, tier) {
  const got = await page.evaluate((t) => {
    const A = window.IR.App;
    A.state.settings.ui = A.state.settings.ui || {};
    A.state.settings.ui.motion = t;
    if (A.applyMotion) A.applyMotion();
    return document.documentElement.dataset.motion || '';
  }, tier);
  if (got !== tier) throw new Error('档位没能落定：期望 html[data-motion]=' + tier + '，实为 ' + (got || '(空)'));
  return got;
}

async function ensureGame(page) {
  const inGame = await page.evaluate(() => {
    const el = document.getElementById('screen-game');
    return !!el && !el.classList.contains('hidden');
  });
  if (inGame) return;
  await page.evaluate(() => window.IR.App.enterGame(true, { deferOpening: true }));
  await page.waitForSelector('#screen-game:not(.hidden)', { timeout: 8000 });
  await sleep(400);
}

/* ================= 播种：最小故事（3 回合 + 一次真分叉 + 两张图） ================= */

async function seedStory(page) {
  return page.evaluate(async () => {
    try {
      const { Store, Tree, Context, App, genId } = window.IR;
      const S = App.state;

      const makeThumb = (i) => {
        const c = document.createElement('canvas');
        c.width = 160; c.height = 100;
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, 160, 100);
        grad.addColorStop(0, i ? '#2b2140' : '#1d2a44');
        grad.addColorStop(1, i ? '#8a6a3f' : '#3c5a80');
        g.fillStyle = grad;
        g.fillRect(0, 0, 160, 100);
        g.fillStyle = '#f5ecd7';
        g.fillRect(20 + i * 18, 28, 54, 40);
        g.fillStyle = i ? '#c0392b' : '#d9822b';
        g.fillRect(96, 58, 42, 14);
        return { thumb: c.toDataURL('image/jpeg', 0.75), png: c.toDataURL('image/png') };
      };

      const playTurn = (st, t, opening) => {
        const ts = Date.now();
        const mark = Tree.begin(st);
        const raw = String(t.text || '');
        const sent = opening ? t.text : '（' + (t.kind === 'say' ? '说' : '做') + '）' + raw;
        if (!opening) st.log.push({ type: 'player', text: raw, kind: t.kind || 'do', ts });
        const userMsg = { role: 'user', content: Context.playerContent(st.premise, sent, opening ? { includePremise: true } : undefined) };
        const rr = {
          narration: t.narration, choices: t.choices || [],
          scene_change: !!t.scene_change, scene_summary: t.scene_summary || '',
        };
        if (t.world) Context.mergeWorld(st.world, t.world);
        const asst = Context.assistantEntry(rr, '');
        st.log.push(Context.narrationEntry(rr.narration, '', ts));
        st.messages.push(userMsg, asst);
        st.turn += 1;
        st.lastSceneSummary = rr.scene_summary || st.lastSceneSummary;
        Context.compressStory(st, { summarize: Context.localSummarize });
        const node = Tree.commit(st, {
          action: opening
            ? { type: 'opening', text: t.text, kind: null, sent: t.text }
            : { type: 'player', text: raw, kind: t.kind || 'do', sent },
          userMsg, assistantMsg: asst, logMark: mark.logMark,
          meta: { model: 'motion-probe' },
        });
        Tree.seal(st, node.id);
        return node;
      };

      const paint = async (st, node, i) => {
        const ts = Date.now();
        const { thumb, png } = makeThumb(i);
        const blob = await fetch(png).then(r => r.blob());
        const scene = {
          id: genId('sc'), imageId: 'img:' + genId('sc'),
          prompt: 'cinematic still, motion probe scene ' + i,
          promptRaw: 'motion probe prompt #' + i,
          alt: '探针场景图 ' + (i + 1),
          thumb, width: 160, height: 100, aspect: '16:10',
          model: 'motion-probe-image', ts,
        };
        Store.putImage(scene.imageId, blob, { model: scene.model, size: '160x100', width: 160, height: 100, prompt: scene.prompt });
        const entry = {
          type: 'image', id: scene.id, prompt: scene.prompt, promptRaw: scene.promptRaw, alt: scene.alt,
          thumb: scene.thumb, imageId: scene.imageId, model: scene.model, size: '160x100',
          aspect: scene.aspect, width: 160, height: 100, ts,
        };
        Tree.pushLate(st, node.id, scene);
        Tree.pushLate(st, node.id, entry);
        st.lastBg = entry.id;
        return entry;
      };

      const st = Store.newStory({
        title: '动效探针',
        premise: '标题：动效探针\n世界：一间有回声的旧放映室。\n你的角色：放映员。\nAI 扮演：旁白。\n风格：克制。',
        mode: 'choice',
      });
      st.titleAuto = false;
      st.world.place = '旧放映室';

      const nodes = [];
      nodes.push(playTurn(st, {
        text: '（故事开场。请描写第一幕。）',
        narration: '放映机的光柱穿过浮尘，落在幕布上。第一幕还没有画面，只有一圈慢慢转动的白。',
        choices: ['拉开窗帘', '检查放映机'],
        scene_change: true,
        scene_summary: '旧放映室，放映机光柱穿过浮尘',
      }, true));
      nodes.push(playTurn(st, {
        text: '检查放映机。', kind: 'do',
        narration: '机身还是温的。片盘上缠着一段没有标记的胶片，边缘有一道被剪过又接上的痕。',
        choices: ['把胶片装上', '先去拉开窗帘'],
        scene_summary: '放映机特写，片盘上缠着无标记的胶片',
      }, false));
      nodes.push(playTurn(st, {
        text: '把胶片装上。', kind: 'do',
        narration: '齿轮咬合的一瞬，幕布上闪过一帧：也是这间放映室，但座椅都是空的。',
        choices: ['倒回去看那一帧', '继续放着'],
        scene_change: true,
        scene_summary: '幕布上闪过的一帧：空座椅的放映室',
      }, false));

      // 真分叉：回到第 2 回合，另走一条（分支树上就有一处兄弟）
      Tree.switchTo(st, nodes[1].id);
      const forked = playTurn(st, {
        text: '先去拉开窗帘。', kind: 'do',
        narration: '窗帘后不是窗，是一堵刷成深蓝的墙。墙上用铅笔写着：第二幕，请勿入场。',
        choices: ['摸一摸那行字', '回头叫住自己'],
        scene_change: true,
        scene_summary: '深蓝色的墙，铅笔字：第二幕，请勿入场',
      }, false);

      await paint(st, nodes[1], 0);
      await paint(st, forked, 1);

      S.story = st;
      Store.saveStory(st);
      Store.setCurrentId(st.id);
      await Store.flush();

      // 当前舞台停在最后画的第二张图（paint 里写了 lastBg）；换画动作再从第一张开始点
      App.enterGame(true, { deferOpening: true });
      return {
        ok: true,
        head: st.tree.head,
        scenes: (st.scenes || []).filter(s => s.type !== 'video').map(s => ({ id: s.id, alt: s.alt })),
      };
    } catch (e) {
      return { ok: false, error: String((e && e.stack) || e) };
    }
  });
}

/* ================= 四个动作 ================= */

const ACTION_RUNNERS = {
  async screen({ page, step, shot }) {
    await page.evaluate(() => window.IR.App.showStart());
    await sleep(300);

    await step('start→shelf');
    await page.click('#btn-start-shelf');
    await shot('1-mid');
    await sleep(300);

    await step('shelf→start');
    await page.click('#btn-shelf-home');
    await shot('2-mid');
    await sleep(300);

    await step('start→game');
    await page.click('#btn-continue');
    await shot('3-mid');
    await sleep(460);
    if (!(await page.locator('#screen-game:not(.hidden)').count())) throw new Error('「继续上次」没进阅读页');
  },

  async stage({ page, step, shot }) {
    await ensureGame(page);
    const scenes = await page.evaluate(() => ((IR.App.state.story && IR.App.state.story.scenes) || [])
      .filter(s => s.type !== 'video' && s.kind !== 'video')
      .map(s => s.id));
    if (scenes.length < 2) throw new Error('场景不足 2 张，换画测不了');
    // 先把舞台停在第二张，下面点第一张才是真换图
    await page.evaluate((id) => {
      const A = window.IR.App;
      A.state.story.lastBg = id;
      A.renderStage();
      A.renderThumbs();
    }, scenes[1]);
    await sleep(360);

    const thumbs = page.locator('#thumb-strip .thumb');
    if ((await thumbs.count()) < 2) throw new Error('缩略条不足 2 张');

    await step('thumb→1');
    await thumbs.nth(0).click();
    await shot('1-mid');
    await sleep(360);

    await step('thumb→2');
    await thumbs.nth(1).click();
    await shot('2-mid');
    await sleep(360);
  },

  async sibling({ page, step, shot }) {
    await ensureGame(page);
    const nav = page.locator('#chat-scroll .version-nav').first();
    if (!(await nav.count())) throw new Error('聊天流里没有分支导航（‹ n/m ›），切兄弟测不了');
    const btns = nav.locator('.mini-btn');
    if ((await btns.count()) < 2) throw new Error('分支导航按钮不足 2 个');

    await step('sibling-next');
    await btns.nth(1).click();
    await shot('1-mid');
    await sleep(380);

    const nav2 = page.locator('#chat-scroll .version-nav').first();
    if (await nav2.count()) {
      await step('sibling-prev');
      await nav2.locator('.mini-btn').nth(0).click();
      await shot('2-mid');
      await sleep(380);
    }
  },

  async modal({ page, step, shot }) {
    await ensureGame(page);

    await step('open-settings');
    await page.evaluate(() => { const b = document.getElementById('btn-hud-more'); if (b) b.click(); });
    await sleep(160);
    await page.evaluate(() => { const b = document.getElementById('btn-settings'); if (b) b.click(); });
    await shot('1-mid');
    await page.waitForSelector('#modal-settings:not(.hidden)', { timeout: 8000 });
    await sleep(420);

    await step('close-settings');
    await page.click('#btn-close-settings');
    await shot('2-mid');
    await sleep(360);
    if (await page.locator('#modal-settings:not(.hidden)').count()) throw new Error('设置弹窗没关掉');
  },
};

/* ================= 断言（Node 侧：按页面真源的三档政策算） ================= */

const PROP_KIND = {
  opacity: 'opacity',
  transform: 'shift', translate: 'shift', rotate: 'shift', scale: 'shift',
  filter: 'opacity',                       // 滤镜类只在 rich 出现；按透明度上限收（blur-up 420ms）
  color: 'color', 'background-color': 'color', 'border-color': 'color',
  background: 'color', fill: 'color', stroke: 'color',
  'stroke-dashoffset': 'shift', 'stroke-dasharray': 'shift',
};
// getKeyframes() 给的是驼峰（borderBottomColor）；统一转 kebab 再查分类表
const toKebab = (p) => String(p).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

function assertAction(action, tier, policy) {
  const t = policy.tiers[tier];
  const violations = [];
  const notes = [];
  const loopGroups = [];

  for (const a of action.animations) {
    const isLoop = a.iterations === 'infinite' || (typeof a.iterations === 'number' && a.iterations > 1);
    if (isLoop) {
      const g = a.name || a.target || '(未命名)';
      if (loopGroups.indexOf(g) < 0) loopGroups.push(g);
      if (!t.loops) {
        violations.push({ rule: 'no-loop', animation: a.name || a.target, detail: tier + ' 档不允许循环动画（' + g + ' × ' + a.iterations + '）' });
      }
      continue;   // 循环动画只看预算，不套单次时长上限
    }
    if (!(a.duration > 0)) continue;

    const kinds = new Set(a.properties.map(p => PROP_KIND[toKebab(p)] || 'other'));
    if (!kinds.size) kinds.add('opacity');
    for (const k of kinds) {
      if (k === 'other') {
        notes.push({ rule: 'unclassified', animation: a.name || a.target, properties: a.properties, detail: '属性不在已知分类里（' + a.properties.join(',') + '），未参与上限断言' });
        continue;
      }
      const cap = k === 'shift' ? t.maxShiftMs : k === 'color' ? t.maxColorMs : t.maxOpacityMs;
      if (a.duration > cap + 0.5) {
        violations.push({
          rule: k + '-max',
          animation: a.name || a.target,
          step: a.step,
          target: a.target,
          duration: a.duration,
          cap,
          detail: tier + ' 档 ' + k + ' 上限 ' + cap + 'ms，实测 ' + a.duration + 'ms（' + (a.name || a.target) + '）',
        });
      }
    }
  }

  if (loopGroups.length > policy.loopBudget) {
    violations.push({ rule: 'loop-budget', detail: '同屏循环 ' + loopGroups.length + ' 组 > 上限 ' + policy.loopBudget + '：' + loopGroups.join(',') });
  }

  return {
    ok: violations.length === 0,
    violations,
    notes,
    loopGroups,
    loopBudget: policy.loopBudget,
  };
}

/* ================= 单档跑一遍 ================= */

async function runTier(browser, args, outDir) {
  const tier = args.tier;
  const width = Number(args.width) === 390 ? 390 : 1280;
  const height = width === 390 ? 844 : 800;
  const tierDir = path.join(outDir, tier);
  fs.mkdirSync(tierDir, { recursive: true });
  for (const f of fs.readdirSync(tierDir)) if (/\.png$/i.test(f)) fs.rmSync(path.join(tierDir, f), { force: true });

  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = m.location && m.location();
    consoleErrors.push({ text: m.text().slice(0, 300), at: (loc && loc.url) ? loc.url.slice(0, 200) : '' });
  });
  page.on('pageerror', e => consoleErrors.push({ text: String(e).slice(0, 300), at: 'pageerror' }));
  page.on('requestfailed', r => {
    const f = r.failure && r.failure();
    const item = { url: r.url().slice(0, 200), error: (f && f.errorText) || '' };
    if (!failedRequests.some(x => x.url === item.url)) failedRequests.push(item);
  });
  // 本地服务探测（127.0.0.1:4319）不在跑：接住，别把「连不上」记成页面错误
  await page.route('http://127.0.0.1:4319/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, version: 'motion-probe', features: { email: false, schedule: false, payment: false } }),
  }));

  const result = {
    tier,
    viewport: { width, height },
    dataMotion: '',
    how: "context(reducedMotion:'no-preference') + settings.ui.motion=tier + IR.App.applyMotion()，跑前校验 html[data-motion]",
    actions: [],
    console: { errors: consoleErrors, failedRequests },
  };

  try {
    await openApp(page);
    const seeded = await seedStory(page);
    if (!seeded.ok) throw new Error('播种失败：' + seeded.error);
    log('  播种完成：场景 ' + seeded.scenes.length + ' 张，head=' + seeded.head);

    result.dataMotion = await forceTier(page, tier);
    await page.evaluate(installRecorder);

    const policy = await page.evaluate(() => ({
      tiers: JSON.parse(JSON.stringify(IR.Motion.TIERS)),
      loopBudget: IR.Motion.LOOP_BUDGET,
    }));
    result.policy = policy;

    const wanted = String(args.actions || '').split(',').map(s => s.trim()).filter(Boolean);
    const order = ACTIONS.filter(a => wanted.indexOf(a) >= 0);

    if (order.indexOf('screen') >= 0) {
      await page.evaluate(() => window.IR.App.showStart());
      await sleep(320);
    }

    for (const name of order) {
      log('  -- ' + tier + ' / ' + name);
      const action = {
        name,
        note: ACTION_NOTES[name] || '',
        steps: [],
        screenshots: [],
        animations: [],
        error: '',
      };
      const shot = async (suffix) => {
        const file = `${tier}-${name}-${suffix}.png`;
        await page.screenshot({ path: path.join(tierDir, file), animations: 'allow', fullPage: false });
        action.screenshots.push(file);
      };
      const step = (label) => page.evaluate((l) => window.__motionProbe.step(l), label);

      try {
        await settle(page);
        await shot('0-pre');
        await page.evaluate(() => window.__motionProbe.start());
        await ACTION_RUNNERS[name]({ page, step, shot });
      } catch (e) {
        action.error = String((e && e.message) || e);
        log('    ✗ ' + action.error);
        await page.evaluate(() => { try { window.__motionProbe.stop(); } catch (_) {} }).catch(() => {});
      }
      let data = { records: [], steps: [] };
      try { data = await page.evaluate(() => window.__motionProbe.stop()); } catch (_) {}
      await sleep(80);
      await shot('9-end').catch(() => {});

      action.steps = data.steps;
      action.animations = data.records;
      const verdict = assertAction(action, tier, policy);
      Object.assign(action, verdict);
      result.actions.push(action);
      log('    ' + (action.error ? '✗' : verdict.ok ? '✓' : '⚠') + ' 动画 ' + action.animations.length +
        ' 条，违规 ' + verdict.violations.length + '，循环 ' + verdict.loopGroups.length + ' 组');
      for (const v of verdict.violations.slice(0, 6)) log('      · ' + v.rule + ' — ' + v.detail);
    }
  } catch (e) {
    result.fatal = String((e && e.stack) || e);
    log('  ✗ ' + result.fatal);
  } finally {
    await ctx.close();
  }

  const allViolations = result.actions.reduce((n, a) => n + a.violations.length, 0);
  const allAnimations = result.actions.reduce((n, a) => n + a.animations.length, 0);
  result.summary = {
    actions: result.actions.length,
    actionsFailed: result.actions.filter(a => a.error).length,
    animations: allAnimations,
    violations: allViolations,
    consoleErrors: consoleErrors.length,
    screenshots: result.actions.reduce((n, a) => n + a.screenshots.length, 0),
    ok: !result.fatal && result.actions.every(a => !a.error) && consoleErrors.length === 0,
  };
  return result;
}

/* ================= 入口 ================= */

async function main() {
  const args = parseArgs();
  if (!args.tier) usage('缺少 --tier');
  if (TIERS.indexOf(args.tier) < 0) usage('--tier 只认 off|standard|rich，实为 ' + args.tier);
  const badActions = String(args.actions || '').split(',').map(s => s.trim()).filter(s => s && ACTIONS.indexOf(s) < 0);
  if (badActions.length) usage('--actions 里有不认识的项：' + badActions.join(','));

  if (!fs.existsSync(path.join(ROOT, 'dist', 'single', 'index.html'))) {
    usage('没有 dist/single/index.html：先 npm run build:single（探针按双击的真实产物测）');
  }
  const outDir = path.resolve(ROOT, args.out || 'acceptance/phase5/1');
  fs.mkdirSync(outDir, { recursive: true });

  log('== tier=' + args.tier + '  out=' + path.relative(ROOT, outDir) + ' ==');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let run;
  try {
    run = await runTier(browser, args, outDir);
  } finally {
    await browser.close();
  }

  // 三档可累积：跑一档只替换这一档，其余档的记录原样保留
  const manifestPath = path.join(outDir, 'manifest.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}
  const tiers = Object.assign({}, (prev && prev.tiers) || {});
  tiers[args.tier] = run;

  const manifest = {
    project: 'infinite-reading',
    version: '0.12.1',
    stage: '阶段 5 · 第 1 步 · 动效测量（测量工具，不改产品代码）',
    generatedAt: new Date().toISOString(),
    tool: 'acceptance/tools/motion-probe.mjs',
    entry: APP_URL,
    usage: 'node acceptance/tools/motion-probe.mjs --tier=off|standard|rich [--out=…] [--actions=…] [--width=1280|390] [--strict]',
    naming: '{tier}/{tier}-{动作}-{序}-{pre|mid|end}.png',
    how: {
      actions: ACTION_NOTES,
      capture: '动作窗口内 requestAnimationFrame 逐帧 document.getAnimations() + 收尾补采；记时长 / 迭代次数 / 动的属性 / 目标 / 伪元素 / 触发步',
      assert: '按页面真源 IR.Motion.TIERS 与 LOOP_BUDGET 判上限：off 无位移无循环 ≤80ms 透明度；standard 位移 ≤160ms、透明度 ≤160ms、颜色 ≤220ms、无循环；rich 位移 ≤220ms、透明度 ≤420ms、颜色 ≤220ms、循环 ≤3 组（同名多实例按 1 组）',
      note: '断言只查上限，不要求动画存在。当前多数动作还没有过渡（切屏 / 弹窗关闭 / 舞台换画之外的多数路径），属正常；violations 是后续步骤的待办清单。',
      strict: '--strict 时违规也算失败；默认只把「动作没跑完 / console error」当失败。',
    },
    tiers: {},
    summary: {},
  };
  for (const t of TIERS) if (tiers[t]) manifest.tiers[t] = tiers[t];

  const runs = TIERS.map(t => tiers[t]).filter(Boolean);
  manifest.summary = {
    tiers: Object.keys(manifest.tiers),
    tiersOk: runs.filter(r => r.summary && r.summary.ok).length,
    actions: runs.reduce((n, r) => n + (r.summary ? r.summary.actions : 0), 0),
    actionsFailed: runs.reduce((n, r) => n + (r.summary ? r.summary.actionsFailed : 0), 0),
    animations: runs.reduce((n, r) => n + (r.summary ? r.summary.animations : 0), 0),
    violations: runs.reduce((n, r) => n + (r.summary ? r.summary.violations : 0), 0),
    consoleErrors: runs.reduce((n, r) => n + (r.summary ? r.summary.consoleErrors : 0), 0),
    screenshots: runs.reduce((n, r) => n + (r.summary ? r.summary.screenshots : 0), 0),
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  log('manifest →', path.relative(ROOT, manifestPath));
  log('本档：动作 ' + run.summary.actions + '，动画 ' + run.summary.animations +
    '，违规 ' + run.summary.violations + '，console error ' + run.summary.consoleErrors +
    '，截图 ' + run.summary.screenshots);
  if (!run.summary.ok) process.exitCode = 1;
  if (args.strict && run.summary.violations > 0) process.exitCode = 1;
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
