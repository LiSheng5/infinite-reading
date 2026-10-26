/*
 * acceptance/tools/shoot.mjs —— 「无限阅读」迁移基线截图（阶段 0 / 0.12.1）
 *
 * 产出：
 *   acceptance/0.12.1/shots/{序号}-{状态}-{屏幕}-{宽度}.png
 *   acceptance/0.12.1/shots/manifest.json（每张图的元信息 + 未能截图项及原因 + console error / pageerror）
 *
 * 用法：node acceptance/tools/shoot.mjs [--state=empty|seeded] [--width=390|1280]
 *                                [--out=acceptance/…/shots] [--only=<PLAN.key>]
 *       --out：产出目录（相对仓库根；默认 acceptance/0.12.1/shots 基线）；
 *       --only：只落这个 key 的图（其余步骤照走，只是不截图）——阶段 4 逐屏前后截图用。
 *
 * 约定：
 *  - 只新增文件，不改任何现有源码；页面一律 file:// 打开（双击 index.html 的真实形态），不联网。
 *  - Chromium 走系统 Chrome（channel:'chrome'），不下载浏览器。
 *  - empty  = 干净浏览器上下文（无存档）；seeded = ?demo=1 离线演示玩过一局之后。
 *  - 动效锁到 off（html[data-motion]=off）：reducedMotion:reduce + 显式把 ui.motion 置 off，
 *    截图前把鼠标移到中性点（阅读页特意悬停舞台，让舞台按钮完整显示）并等动效稳定。
 *  - 只截 viewport（fullPage:false），deviceScaleFactor=1。
 */
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
// 产出目录默认是 0.12.1 基线；--out=<相对 ROOT 的目录> 可改写（阶段 4 逐屏前后截图用）
let OUT = path.join(ROOT, 'acceptance', '0.12.1', 'shots');
let ONLY = null;   // --only=<PLAN.key>：只拍这个 key 的图（其余步骤照走，只是不落图）
// 「双击 index.html 的真实形态」阶段 1 起 = 构建出的单文件产物（源码入口是 ES module，
// file:// 会被浏览器拦）。先 npm run build:single，再跑本脚本。
const APP_URL = pathToFileURL(path.join(ROOT, 'dist', 'single', 'index.html')).href;

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

/* ================= 截图清单（序号 = 下标 + 1，两个宽度共用） ================= */
const PLAN = [
  // —— empty：无存档 ——
  { key: 'start', state: 'empty', screen: 'start', expect: '#screen-start:not(.hidden)', note: '首页（无「继续上次」）：ASCII 无限符号 + 三张模式卡 + 底部文字入口' },
  { key: 'shelf', state: 'empty', screen: 'shelf', expect: '#screen-shelf:not(.hidden)', note: '书架空态' },
  { key: 'settings-nav', state: 'empty', screen: 'settings-nav', widths: [390], expect: '#set-nav', note: '设置弹窗 · 分组列表（仅窄屏 ≤720px 是「列表→下钻」态）' },
  { key: 'settings-models', state: 'empty', screen: 'settings-models', expect: '#modal-settings:not(.hidden)', note: '设置 · 模型（剧情对话模型 / 模型库）' },
  { key: 'settings-subs', state: 'empty', screen: 'settings-subs', expect: '#modal-settings:not(.hidden)', note: '设置 · 辅助模型（画师子代理 / 书记员 / 起草模型）' },
  { key: 'settings-image', state: 'empty', screen: 'settings-image', expect: '#modal-settings:not(.hidden)', note: '设置 · 生图与画风' },
  { key: 'settings-tools', state: 'empty', screen: 'settings-tools', expect: '#modal-settings:not(.hidden)', note: '设置 · 工具与服务（生成过程 / 本地服务 / 邮件 / 定时主动 / 购物支付）' },
  { key: 'settings-data', state: 'empty', screen: 'settings-data', expect: '#modal-settings:not(.hidden)', note: '设置 · 数据（用户画像 / 本地存储）' },
  { key: 'settings-look', state: 'empty', screen: 'settings-look', expect: '#modal-settings:not(.hidden)', note: '设置 · 外观（界面）' },
  // 序号 10 的最终处置（阶段 4 屏 2）：原「设置 · 当前故事」随「当前故事」组迁出全局设置而退役，
  // 空位原地复用为「本对话设置 · 世界状态卡二级视图」（PLAN 序号 = 文件名前缀，不重排）。
  { key: 'story-world-edit', state: 'seeded', screen: 'story-world-edit', expect: '#prefs-world', note: '本对话设置 · 世界状态卡二级视图（面板内下钻：人物行卡 + sticky 保存栏）' },
  { key: 'modal-new', state: 'empty', screen: 'modal-new', expect: '#modal-new:not(.hidden)', note: '新故事弹窗（三张模式卡）' },
  { key: 'modal-wizard', state: 'empty', screen: 'modal-wizard', expect: '#modal-wizard:not(.hidden)', note: '开局设定向导（剧情模式）' },
  { key: 'modal-import-text', state: 'empty', screen: 'modal-import-text', expect: '#modal-import-text:not(.hidden)', note: '粘贴剧情文本导入弹窗（第 1 步）' },
  { key: 'modal-confirm', state: 'empty', screen: 'modal-confirm', expect: '#modal-confirm:not(.hidden)', note: '确认弹窗（设置→数据→清空本地存档与设置 触发，无输入框）' },
  // —— seeded：离线演示玩过一局 ——
  { key: 'start', state: 'seeded', screen: 'start', expect: '#btn-continue:not(.hidden)', note: '首页（有「继续上次」，带最近故事名）' },
  { key: 'shelf', state: 'seeded', screen: 'shelf', expect: '#screen-shelf:not(.hidden)', note: '书架（有故事卡片）' },
  { key: 'game', state: 'seeded', screen: 'game', expect: '#screen-game:not(.hidden)', note: '阅读页：聊天记录 / 舞台占位图 / 缩略图条 / 选项托盘展开；鼠标悬停舞台以完整显示舞台按钮' },
  { key: 'hud-more', state: 'seeded', screen: 'hud-more', expect: '#hud-more-menu:not(.hidden)', note: '阅读页顶栏「⋯」更多菜单（存档点 / 分支 / 作画 / 本对话设置 / 全局设置）' },
  { key: 'branch', state: 'seeded', screen: 'branch', expect: '#branch-page:not(.hidden)', note: '分支页：SVG 分支树（含一次分叉）+ 右侧节点详情面板' },
  { key: 'painter', state: 'seeded', screen: 'painter', expect: '#modal-painter:not(.hidden)', note: '画师工作台（看 / 改这张图的提示词）' },
  { key: 'anchor', state: 'seeded', screen: 'anchor', expect: '#modal-anchor:not(.hidden)', note: '画风锚定：4 张候选试画（本地占位图）' },
  { key: 'card', state: 'seeded', screen: 'card', expect: '#modal-card:not(.hidden)', note: '角色卡编辑弹窗' },
  { key: 'story-prefs', state: 'seeded', screen: 'story-prefs', expect: '#story-prefs:not(.hidden)', note: '本对话设置面板（覆盖行 + 故事数据：推进模式/存档点/世界状态卡，阶段 4 屏 2 迁入）' },
  { key: 'modal-confirm', state: 'seeded', screen: 'modal-confirm', expect: '#modal-confirm:not(.hidden)', note: '确认弹窗（打一个存档点，带名字输入框）' },
  { key: 'toast', state: 'seeded', screen: 'toast', expect: '#toast:not(.hidden)', note: '提示条（打完存档点的「已打存档点」）' },
  { key: 'modal-export', state: 'seeded', screen: 'modal-export', expect: '#modal-export:not(.hidden)', note: '导出弹窗（书架行「⋯」→ 导出）' },
  { key: 'modal-email', state: 'seeded', screen: 'modal-email', expect: '#modal-email:not(.hidden)', note: '写邮件弹窗（入口仅智能体/扮演模式：先在「本对话设置→推进模式」切到智能体）' },
  { key: 'modal-payment', state: 'seeded', screen: 'modal-payment', expect: '#modal-payment:not(.hidden)', note: '代下单弹窗（同上，智能体模式）' },
  { key: 'settings-schedule', state: 'seeded', screen: 'settings-schedule', expect: '#fs-schedule', note: '定时主动（「＋」→ 定时主动：设置·工具与服务，滚动到「定时主动」分区）' },
  { key: 'lightbox', state: 'seeded', screen: 'lightbox', expect: '#lightbox:not(.hidden)', note: '图片灯箱（智能体模式内联图气泡点开的大图）' },
  // —— 阶段 4 屏 2 补拍：本对话设置面板的新交互 ——
  { key: 'story-savepoints', state: 'seeded', screen: 'story-savepoints', expect: '#sp-list', note: '本对话设置 · 存档点列表（n 个 + 摘要行）' },
  { key: 'story-world-empty', state: 'seeded', screen: 'story-world-empty', expect: '#prefs-world', note: '本对话设置 · 世界状态卡二级视图（新故事：空世界，表单全空）' },
];

/* 明确不截 / 只在某状态截的项与原因（进 manifest.skipped） */
const KNOWN_GAPS = [
  { item: 'modal-painter / modal-export / modal-card / lightbox / toast', state: 'empty', reason: '依赖故事数据（要有存档、图片或角色卡），empty 上游入口直接拦掉' },
  { item: 'modal-anchor（画风锚定）', state: 'empty', reason: '试画 4 张候选要生图适配器；empty 是未配置的普通模式，点了只会报「没配模型」' },
  { item: 'modal-email / modal-payment / 定时主动', state: 'empty', reason: '入口只在智能体/扮演模式出现，empty 无故事可切模式' },
  { item: 'settings-nav（设置分组列表）', state: 'seeded', reason: '与 empty 的设置弹窗同构，全局设置只在 empty 逐分组截；seeded 只补「本对话设置」与「定时主动」' },
  { item: '10 号序（原 settings-story）', state: 'empty', reason: '「当前故事」组已迁出全局设置（阶段 4 屏 2 commit 1），empty 里无故事可截；PLAN 序号原地复用为 seeded 的世界卡二级视图（story-world-edit），序号不重排' },
];

/* ================= 小工具 ================= */
const log = (...a) => console.log('[shoot]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

function parseArgs() {
  const out = { state: null, width: null, out: null, only: null };
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function openApp(page, query) {
  await page.goto(APP_URL + (query || ''), { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.IR && IR.App && IR.Store), null, { timeout: 15000 });
  await sleep(600);
}

async function waitIdle(page, timeout) {
  await page.waitForFunction(() => !(window.IR && IR.App && IR.App.state && IR.App.state.busy), null, { timeout: timeout || 120000 });
  await sleep(350);
}

// 截图前的稳定化：藏掉瞬态 toast、失焦、鼠标挪到中性点（或舞台）、等动效收干净
async function settle(page, opts) {
  opts = opts || {};
  if (!opts.keepToast) {
    await page.evaluate(() => {
      const t = document.getElementById('toast');
      if (t) t.classList.add('hidden');
    });
  }
  await page.evaluate(() => {
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (_) {}
  });
  if (opts.hoverStage) {
    const box = await page.locator('#stage-wrap').boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await page.mouse.move(2, 2);
  }
  await sleep(opts.wait || 550);
}

// 打开顶栏「⋯」菜单（用 DOM click：菜单项随后用真实点击取）
async function openHudMenu(page) {
  await page.evaluate(() => { const b = document.getElementById('btn-hud-more'); if (b) b.click(); });
  await page.waitForSelector('#hud-more-menu:not(.hidden)', { timeout: 5000 });
  await sleep(200);
}

async function pickChoice(page, idx) {
  const inline = page.locator('#chat-scroll .choices-inline .choice-btn');
  if (await inline.count()) { await inline.nth(idx).click(); return; }
  const tray = page.locator('#choice-tray .tray-btn');
  if (!(await tray.count())) {
    await page.click('#btn-inspiration');
    await page.waitForSelector('#choice-tray .tray-btn', { timeout: 8000 });
  }
  await page.locator('#choice-tray .tray-btn').nth(idx).click();
}

async function sendLine(page, text) {
  await page.fill('#player-input', text);
  await page.click('#btn-send');
  await waitIdle(page, 120000);
}

// 为当前场景作画（HUD「⋯」→ 为当前场景作画），等到缩略图条攒够 n 张。
// 失败不中断整轮：把现场诊断塞进 manifest.skipped，继续拍后面的图。
async function paint(page, n, manifest, tag) {
  await openHudMenu(page);
  await page.click('#btn-manual-gen');
  await sleep(500);
  const toastText = await page.evaluate(() => {
    const t = document.getElementById('toast');
    return (t && !t.classList.contains('hidden') && t.textContent) ? t.textContent.trim() : '';
  });
  try {
    await page.waitForFunction(
      (min) => document.querySelectorAll('#thumb-strip img.thumb').length >= min,
      n,
      { timeout: 90000 }
    );
  } catch (_) {
    const diag = await page.evaluate(() => ({
      turn: (window.IR && IR.App.state.story) ? IR.App.state.story.turn : null,
      head: (window.IR && IR.App.treeHeadNodeId) ? IR.App.treeHeadNodeId() : null,
      scenes: ((window.IR && IR.App.state.story && IR.App.state.story.scenes) || []).map(s => ({ id: s.id, thumb: !!s.thumb, imageId: !!s.imageId })),
      queue: (window.IR && IR.App.paintQ && IR.App.paintQ.size) ? IR.App.paintQ.size() : -1,
      logTail: ((window.IR && IR.App.state.story && IR.App.state.story.log) || []).slice(-8).map(x => String(x.type) + ':' + String(x.summary || x.text || '').slice(0, 60)),
    }));
    const reason = '作画没出图（' + (tag || ('第 ' + n + ' 张')) + '）：点「为当前场景作画」后提示「' + (toastText || '（无提示）') + '」，现场=' + JSON.stringify(diag);
    if (manifest) manifest.skipped.push({ item: '作画 ' + (tag || n), state: 'seeded', width: 0, reason });
    log('  PAINT MISS', reason);
    return false;
  }
  log('  paint ok #' + n + (toastText ? '（toast：' + toastText + '）' : ''));
  await sleep(500);
  return true;
}

// 分支树节点：优先点节点里的实心圆（一定在 g 的点击热区里），失败再退到 g 本体
async function clickBranchNode(page, idx) {
  const dot = page.locator('#branch-svg g[data-id]').nth(idx).locator('circle.dot');
  try {
    await dot.click({ timeout: 3000 });
  } catch (_) {
    await page.locator('#branch-svg g[data-id]').nth(idx).click({ force: true });
  }
  await sleep(400);
}

/* ================= 主流程 ================= */
async function main() {
  const args = parseArgs();
  if (args.out) OUT = path.resolve(ROOT, args.out);
  if (args.only) ONLY = args.only;
  fs.mkdirSync(OUT, { recursive: true });
  // 增量安全：只删本轮要重拍的图（按 --state / --width 过滤），别的产物原样保留——
  // 中途被打断也不会把已拍好的图全丢掉。
  const inScope = (state, width) =>
    (!args.state || state === args.state) && (!args.width || String(width) === String(args.width));
  for (const f of fs.readdirSync(OUT)) {
    const m = f.match(/^\d+-(empty|seeded)-.+-(390|1280)\.png$/);
    if (m && inScope(m[1], +m[2])) fs.rmSync(path.join(OUT, f), { force: true });
  }

  // 与上一轮 manifest 合并：本轮范围内的记录用新结果替换，范围外的（含截图与 skipped）保留
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')); } catch (_) {}
  const keepOutScope = (arr) => (prev && Array.isArray(arr))
    ? arr.filter(x => x && x.state && x.width && !inScope(x.state, x.width)) : [];

  const manifest = {
    project: 'infinite-reading',
    version: '0.12.1',
    stage: '0（迁移基线）',
    generatedAt: new Date().toISOString(),
    tool: 'acceptance/tools/shoot.mjs',
    entry: APP_URL,
    demoEntry: APP_URL + '?demo=1',
    naming: '{序号}-{状态}-{屏幕}-{宽度}.png，状态 ∈ empty|seeded，序号 = PLAN 顺序',
    viewports: VIEWPORTS.map(v => ({ width: v.width, height: v.height, deviceScaleFactor: 1 })),
    states: {
      empty: '干净浏览器上下文（无 localStorage / IndexedDB 存档），普通模式打开 index.html',
      seeded: '干净上下文 + ?demo=1 离线演示：开场 → 点选项 → 发消息 → 回到早前节点分叉再发一条 → 两幕作画 → 打存档点',
    },
    motion: null,
    notes: [
      '截图前隐藏瞬态 toast、鼠标移到 (2,2) 中性点（阅读页特意悬停舞台以完整显示舞台按钮），避免半悬停态。',
      'modal-email / modal-payment / 定时主动的入口只在智能体(chat)/扮演(rp)模式出现：seeded 尾段用「本对话设置 → 推进模式」把演示故事切到智能体后再截，其余截图都保持演示默认的剧情(choice)模式。',
      '全部截图只截 viewport（fullPage:false）。',
    ],
    shots: [],
    skipped: KNOWN_GAPS.slice(),
    console: [],
  };

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const vp of VIEWPORTS) {
      if (args.width && String(vp.width) !== String(args.width)) continue;
      for (const state of ['empty', 'seeded']) {
        if (args.state && state !== args.state) continue;
        await runPass(browser, state, vp, manifest);
      }
    }
  } finally {
    await browser.close();
  }

  // 合并范围外的旧记录（截图 / skipped / console），范围内的已被本轮新结果取代
  manifest.shots = keepOutScope(prev ? prev.shots : null).concat(manifest.shots);
  const newSkipped = manifest.skipped;
  manifest.skipped = keepOutScope(prev ? prev.skipped : null).concat(newSkipped)
    .filter((x, i, a) => a.findIndex(y => y.item === x.item && y.state === x.state && y.width === x.width) === i);
  manifest.console = keepOutScope(prev ? prev.console : null).concat(manifest.console);
  if (prev && prev.motion && !manifest.shots.some(s => inScope(s.state, s.width))) manifest.motion = prev.motion;

  manifest.shots.sort((a, b) => (a.seq - b.seq) || (a.width - b.width));
  manifest.summary = {
    shots: manifest.shots.length,
    byState: countBy(manifest.shots, s => s.state),
    byWidth: countBy(manifest.shots, s => String(s.width)),
    screens: Array.from(new Set(manifest.shots.map(s => s.state + '/' + s.screen))).length,
    consoleErrors: manifest.console.reduce((n, c) => n + c.errors.length, 0),
    skipped: manifest.skipped.length,
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  log('done →', path.join(OUT, 'manifest.json'));
  log('shots:', manifest.summary.shots, 'console errors:', manifest.summary.consoleErrors, 'skipped:', manifest.summary.skipped);
}

function countBy(arr, fn) {
  const out = {};
  for (const x of arr) { const k = fn(x); out[k] = (out[k] || 0) + 1; }
  return out;
}

async function runPass(browser, state, vp, manifest) {
  const passName = state + '-' + vp.width;
  log('== pass', passName, '==');
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  const errors = [];
  const failedRequests = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = m.location && m.location();
    errors.push({ kind: 'console', text: m.text().slice(0, 300), at: (loc && loc.url) ? loc.url.slice(0, 200) : '' });
  });
  page.on('pageerror', e => errors.push({ kind: 'pageerror', text: String(e).slice(0, 300) }));
  page.on('requestfailed', r => {
    const f = r.failure && r.failure();
    const item = { url: r.url().slice(0, 200), error: (f && f.errorText) || '' };
    if (!failedRequests.some(x => x.url === item.url)) failedRequests.push(item);
  });

  // snap(key)：按 PLAN 元数据落一张图
  const snap = async (key, opts) => {
    opts = opts || {};
    const idx = PLAN.findIndex(p => p.key === key && p.state === state);
    if (idx < 0) throw new Error('PLAN 里没有 ' + state + '/' + key);
    const item = PLAN[idx];
    if (ONLY && item.key !== ONLY) return;   // --only：这一步不落图，流程照走
    if (item.widths && item.widths.indexOf(vp.width) < 0) {
      manifest.skipped.push({
        item: state + '/' + item.screen, state, width: vp.width,
        reason: '该形态只有窄屏有：' + (opts.reason || item.note),
      });
      return;
    }
    await settle(page, opts);
    let expectNote = '';
    if (item.expect) {
      const ok = await page.locator(item.expect).count();
      if (!ok) expectNote = ' ⚠️ 截图前未见到 ' + item.expect;
    }
    const file = `${pad2(idx + 1)}-${state}-${item.screen}-${vp.width}.png`;
    await page.screenshot({ path: path.join(OUT, file), fullPage: false });
    manifest.shots.push({
      seq: idx + 1, file, state, screen: item.screen,
      width: vp.width, height: vp.height,
      url: page.url(),
      note: (opts.note || item.note) + expectNote,
    });
    log('  shot', file);
  };

  try {
    if (state === 'empty') await runEmpty(page, snap, vp, manifest);
    else await runSeeded(page, snap, vp, manifest);
  } catch (e) {
    manifest.skipped.push({ item: state + '@' + vp.width + ' 整轮', state, width: vp.width, reason: '脚本中断：' + ((e && e.message) || e) });
    log('  PASS ERROR', String(e && e.stack || e));
  }

  const motion = await page.evaluate(() => (document.documentElement.dataset.motion || '')).catch(() => '?');
  const onLine = await page.evaluate(() => (typeof navigator !== 'undefined' ? navigator.onLine : null)).catch(() => null);
  manifest.console.push({ state, width: vp.width, dataMotion: motion, navigatorOnLine: onLine, errors, failedRequests });
  if (!manifest.motion) manifest.motion = {
    level: motion,
    how: "context(reducedMotion:'reduce') + 页面里把 settings.ui.motion 置 'off' 后 applyMotion()，截图前校验 html[data-motion]",
  };
  await ctx.close();
}

/* ---------- empty：无存档 ---------- */
async function runEmpty(page, snap, vp, manifest) {
  await openApp(page, '');
  const stories = await page.evaluate(() => (window.IR && IR.Store && IR.Store.listStories) ? IR.Store.listStories().length : -1);
  if (stories !== 0) manifest.skipped.push({ item: 'empty 存档清零校验', state: 'empty', width: vp.width, reason: '上下文里读到 ' + stories + ' 个故事（预期 0）' });

  await snap('start');
  await page.click('#btn-start-shelf');
  await page.waitForSelector('#screen-shelf:not(.hidden)');
  await sleep(400);
  await snap('shelf');

  // —— 设置弹窗逐分组 ——
  await page.click('#btn-shelf-settings');
  await page.waitForSelector('#modal-settings:not(.hidden)');
  await sleep(500);
  await snap('settings-nav');   // 只有窄屏会截
  const groups = [
    ['settings-models', 'g-models'], ['settings-subs', 'g-subs'], ['settings-image', 'g-image'],
    ['settings-tools', 'g-tools'], ['settings-data', 'g-data'], ['settings-look', 'g-look'],
    // 阶段 4 屏 2：g-story「当前故事」组已迁入本对话设置面板（#prefs-story），
    // 全局设置没有这个分组了；PLAN 里的 settings-story 条目保留不重排（序号 = 文件名前缀）。
  ];
  for (const [key, group] of groups) {
    if (await page.locator('#set-back:not(.hidden)').count()) await page.click('#set-back');
    await page.click(`.set-nav-item[data-group="${group}"]`);
    await sleep(400);
    await snap(key);
  }
  await page.click('#btn-close-settings');
  await sleep(300);

  // —— 新建弹窗 → 开局向导 ——
  await page.click('#btn-new-story');
  await page.waitForSelector('#modal-new:not(.hidden)');
  await sleep(400);
  await snap('modal-new');
  await page.click('#modal-new .mode-card[data-mode="choice"]');
  await page.waitForSelector('#modal-wizard:not(.hidden)');
  await sleep(400);
  await snap('modal-wizard');
  await page.click('#btn-close-wizard');
  await sleep(300);

  // —— 文本导入弹窗 ——
  await page.click('#btn-import-text');
  await page.waitForSelector('#modal-import-text:not(.hidden)');
  await sleep(400);
  await snap('modal-import-text');
  await page.click('#btn-close-import-text');
  await sleep(300);

  // —— 确认弹窗（危险操作） ——
  await page.click('#btn-shelf-settings');
  await page.waitForSelector('#modal-settings:not(.hidden)');
  await sleep(400);
  if (await page.locator('#set-back:not(.hidden)').count()) await page.click('#set-back');
  await page.click('.set-nav-item[data-group="g-data"]');
  await sleep(400);
  await page.click('#btn-clear-save');
  await page.waitForSelector('#modal-confirm:not(.hidden)');
  await sleep(400);
  await snap('modal-confirm');
  await page.click('#btn-close-confirm');
  await sleep(300);
  await page.click('#btn-close-settings');
  await sleep(200);

  // 动效档位显式锁 off（截图稳定性）
  await page.evaluate(() => {
    if (window.IR && IR.App && IR.App.state && IR.App.state.settings) {
      IR.App.state.settings.ui = IR.App.state.settings.ui || {};
      IR.App.state.settings.ui.motion = 'off';
      if (IR.App.applyMotion) IR.App.applyMotion();
    }
  });
}

/* ---------- seeded：离线演示玩过一局 ---------- */
async function runSeeded(page, snap, vp, manifest) {
  await openApp(page, '?demo=1');
  await waitIdle(page, 120000);   // 开场第一幕

  // 动效档位显式锁 off（演示开局后再锁一次，防启动期覆盖）
  await page.evaluate(() => {
    if (window.IR && IR.App && IR.App.state && IR.App.state.settings) {
      IR.App.state.settings.ui = IR.App.state.settings.ui || {};
      IR.App.state.settings.ui.motion = 'off';
      if (IR.App.applyMotion) IR.App.applyMotion();
    }
  });

  // —— 推进：点选项 → 发消息 ——
  await pickChoice(page, 0);
  await waitIdle(page, 120000);
  await sendLine(page, '我擦开玻璃上的一块水汽，朝外看了看。');
  await paint(page, 1, manifest, '第 1 张（第 3 回合后）');   // 第一幕作画（舞台占位图 + 缩略图条 1 张）

  // —— 分支：回到上一回合节点，从那里再走一条支线（分支树上就有真分叉） ——
  await openHudMenu(page);
  await snap('hud-more');         // 「⋯」菜单展开态
  await page.click('#btn-branch');
  await page.waitForSelector('#branch-page:not(.hidden)');
  await sleep(500);
  await clickBranchNode(page, 1);
  await page.waitForSelector('#branch-panel:not(.hidden)', { timeout: 5000 }).catch(() => {});
  await page.click('#btn-bp-resume');
  await page.waitForFunction(() => { const el = document.getElementById('branch-page'); return el && el.classList.contains('hidden'); }, null, { timeout: 8000 });
  await sleep(400);
  await sendLine(page, '我没有回答，先在那扇门上敲了三下。');   // 分叉回合
  log('  fork turn done, turn =', await page.evaluate(() => (window.IR && IR.App.state.story) ? IR.App.state.story.turn : -1),
    'head =', await page.evaluate(() => (window.IR && IR.App.treeHeadNodeId) ? IR.App.treeHeadNodeId() : ''));
  await paint(page, 2, manifest, '第 2 张（分叉回合后）');   // 第二幕作画（缩略图条 2 张）

  // —— 阅读页（聊天 / 舞台 / 缩略图条 / 选项托盘） ——
  await page.evaluate(() => { const b = document.getElementById('btn-inspiration'); if (b) b.click(); });
  await page.waitForSelector('#choice-tray:not(.hidden)', { timeout: 5000 }).catch(() => {});
  await sleep(400);
  await snap('game', { hoverStage: true });

  // —— 分支页（SVG 树 + 右侧面板） ——
  await openHudMenu(page);
  await page.click('#btn-branch');
  await page.waitForSelector('#branch-page:not(.hidden)');
  await sleep(500);
  await clickBranchNode(page, 1);
  await page.waitForSelector('#branch-panel:not(.hidden)', { timeout: 5000 }).catch(() => {});
  await snap('branch');
  await page.click('#btn-branch-back');
  await page.waitForFunction(() => { const el = document.getElementById('branch-page'); return el && el.classList.contains('hidden'); }, null, { timeout: 8000 });
  await sleep(400);

  // —— 画师工作台 → 画风锚定 ——
  await page.evaluate(() => { const b = document.getElementById('btn-stage-painter'); if (b) b.click(); });
  await page.waitForSelector('#modal-painter:not(.hidden)', { timeout: 8000 });
  await sleep(500);
  await snap('painter');
  await page.click('#btn-pw-anchor');     // 关工作台、开锚定，自动试画 4 张候选
  await page.waitForSelector('#modal-anchor:not(.hidden)', { timeout: 8000 });
  await page.waitForFunction(
    () => !!(window.IR && IR.App && IR.App.state.anchor)
      && !IR.App.state.anchor.busy
      && IR.App.state.anchor.candidates.filter(c => c && c.src).length > 0,
    null, { timeout: 90000 }
  ).catch(() => {});
  await sleep(500);
  await snap('anchor');
  await page.click('#btn-close-anchor');
  await sleep(300);

  // —— 角色卡（本对话设置 · 故事数据 → 编辑角色卡；阶段 4 屏 2 起入口在面板里，不再走全局设置） ——
  await openHudMenu(page);
  await page.click('#btn-story-prefs');
  await page.waitForSelector('#story-prefs:not(.hidden)', { timeout: 8000 });
  await sleep(400);
  await page.click('#btn-edit-card');
  await page.waitForSelector('#modal-card:not(.hidden)', { timeout: 8000 }).catch(() => {});
  await sleep(500);
  await snap('card');
  await page.click('#btn-close-card');
  await sleep(300);
  await page.click('#prefs-close');
  await sleep(300);

  // —— 本对话设置（滚到「故事数据」区：推进模式 / 存档点 / 世界状态卡，阶段 4 屏 2 迁入） ——
  await openHudMenu(page);
  await page.click('#btn-story-prefs');
  await page.waitForSelector('#story-prefs:not(.hidden)', { timeout: 8000 });
  await page.evaluate(() => {
    const el = document.getElementById('prefs-story');
    if (el) el.scrollIntoView({ block: 'start' });
  });
  await sleep(400);
  await snap('story-prefs');

  // —— 世界状态卡二级视图（面板内下钻，§3.2 方案 A）：人物行卡 + sticky 保存栏 ——
  await page.click('#btn-world-edit');
  await sleep(450);
  await snap('story-world-edit');
  await page.click('#prefs-world-back');   // 返回一级：滚动位置还原（下面再验一次列表）
  await sleep(350);

  // —— 存档点列表（打两个点：摘要行「n 个存档点 · 退出自动存档」+ 列表） ——
  await page.evaluate(() => {
    const A = window.IR.App;
    const S = A.state;
    if (S.story && !(S.story.savepoints || []).length) {
      A.addSavepoint('手动存档 · 车厢');
      A.addSavepoint('手动存档 · 月台');
      A.renderSavepoints();
    }
    const el = document.getElementById('sp-panel');
    if (el) el.scrollIntoView({ block: 'start' });
  });
  await sleep(400);
  await snap('story-savepoints');

  // —— 确认弹窗（打存档点）+ 提示条 ——
  await page.click('#prefs-close');
  await sleep(300);
  await openHudMenu(page);
  await page.click('#btn-savepoint');
  await page.waitForSelector('#modal-confirm:not(.hidden)', { timeout: 8000 });
  await sleep(400);
  await snap('modal-confirm');
  await page.click('#cf-ok');
  await sleep(250);
  await snap('toast', { keepToast: true, wait: 250 });

  // —— 书架（有卡片） + 导出弹窗 ——
  await page.click('#btn-hud-shelf');
  await page.waitForSelector('#screen-shelf:not(.hidden)');
  await sleep(500);
  await snap('shelf');
  await page.locator('.shelf-row-more').first().click();
  await page.waitForTimeout(300);
  await page.locator('.row-menu .menu-item', { hasText: '导出' }).first().click();
  await page.waitForSelector('#modal-export:not(.hidden)', { timeout: 8000 });
  await sleep(400);
  await snap('modal-export');
  await page.click('#btn-close-export');
  await sleep(300);

  // —— 首页（有「继续上次」） ——
  await page.click('#btn-shelf-home');
  await page.waitForSelector('#screen-start:not(.hidden)');
  await sleep(500);
  await snap('start');
  await page.click('#btn-continue');
  await page.waitForSelector('#screen-game:not(.hidden)');
  await sleep(600);

  // —— 智能体模式才有的入口：写邮件 / 代下单 / 定时主动（本对话设置→推进模式 切到智能体） ——
  await openHudMenu(page);
  await page.click('#btn-story-prefs');
  await page.waitForSelector('#story-prefs:not(.hidden)', { timeout: 8000 });
  await page.selectOption('#s-story-mode', 'chat').catch(e => {
    manifest.skipped.push({ item: '切换推进模式到智能体', state: 'seeded', width: vp.width, reason: '#s-story-mode 选择失败：' + e.message });
  });
  await sleep(600);
  await page.click('#prefs-close');
  await sleep(400);

  // 「＋」更多功能（renderFeatureBar 只在打开菜单时刷新显隐，先用 DOM click 打开）
  const openFeatureMenu = async () => {
    await page.evaluate(() => { const b = document.getElementById('btn-more-actions'); if (b) b.click(); });
    await page.waitForSelector('#feature-menu:not(.hidden)', { timeout: 5000 });
    await sleep(250);
    await page.mouse.move(2, 2);
    await sleep(150);
  };

  await openFeatureMenu();
  await page.click('#btn-feat-email');
  await page.waitForSelector('#modal-email:not(.hidden)', { timeout: 8000 }).catch(() => {
    manifest.skipped.push({ item: 'modal-email', state: 'seeded', width: vp.width, reason: '点了「写邮件」弹窗没开（多半是模式切换没生效 / 侧车 mock 未就绪），看 console' });
  });
  await snap('modal-email');
  await page.click('#btn-close-email');
  await sleep(300);

  await openFeatureMenu();
  await page.click('#btn-feat-payment');
  await page.waitForSelector('#modal-payment:not(.hidden)', { timeout: 8000 }).catch(() => {
    manifest.skipped.push({ item: 'modal-payment', state: 'seeded', width: vp.width, reason: '点了「代下单」弹窗没开，看 console' });
  });
  await snap('modal-payment');
  await page.click('#btn-close-payment');
  await sleep(300);

  await openFeatureMenu();
  await page.click('#btn-feat-schedule');
  await page.waitForSelector('#modal-settings:not(.hidden)', { timeout: 8000 });
  await page.waitForSelector('#fs-schedule', { timeout: 8000 }).catch(() => {});
  await sleep(500);
  await snap('settings-schedule');
  await page.click('#btn-close-settings');
  await sleep(300);

  // —— 图片灯箱（智能体模式：内联图气泡） ——
  const bubbleImg = page.locator('#chat-scroll .bubble-image-inline img').first();
  if (await bubbleImg.count()) {
    await bubbleImg.click();
    await page.waitForSelector('#lightbox:not(.hidden)', { timeout: 5000 }).catch(() => {});
    await snap('lightbox');
    await page.evaluate(() => { const b = document.getElementById('lightbox'); if (b) b.click(); });
    await sleep(200);
  } else {
    manifest.skipped.push({ item: 'lightbox', state: 'seeded', width: vp.width, reason: '聊天流里没有可点的内联图气泡（.bubble-image-inline img），灯箱入口没出现' });
  }

  // —— 世界状态卡二级视图 · 空世界（直接开一个新故事：世界卡是空表单，「保存世界卡」默认禁用） ——
  await page.evaluate(() => {
    const A = window.IR.App;
    A.closeStoryPrefs();
    A.createStoryImmediate('chat');
  });
  await sleep(800);
  await openHudMenu(page);
  await page.click('#btn-story-prefs');
  await page.waitForSelector('#story-prefs:not(.hidden)', { timeout: 8000 }).catch(() => {
    manifest.skipped.push({ item: 'story-world-empty', state: 'seeded', width: vp.width, reason: '新故事没开起来 / 面板没打开，看 console' });
  });
  await sleep(300);
  await page.click('#btn-world-edit').catch(() => {});
  await sleep(450);
  await snap('story-world-empty');
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
