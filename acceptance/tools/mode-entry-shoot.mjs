/*
 * acceptance/tools/mode-entry-shoot.mjs —— 「两种模式点进去」的页面重设计 · 验收截图与行为自检
 *
 * 产出：
 *   acceptance/mode-entry/shots/{序号}-{视图}-{宽度}.png
 *   acceptance/mode-entry/shots/manifest.json（截图元信息 + 行为断言结果 + console error）
 *
 * 用法：先 npm run build:single，再 node acceptance/tools/mode-entry-shoot.mjs
 *
 * 覆盖的验收点（两种宽度 390 / 1280 各跑一遍）：
 *   · 首页与「新故事」弹窗都只有两张模式卡：剧情 / 聊天（原「扮演」并入聊天）；
 *   · 聊天开局 → 空对话引导页（模式说明 + 能力芯片 + 「添加角色卡（可选）」），没有做 / 说 / 导演；
 *   · 「添加角色卡」先到「选卡」视图（导入 PNG / 自己写一张）；窄屏整屏 sheet、选卡视图无页脚；
 *   · 「自己写一张」→ 编辑视图（名字 + 开场白直给，其余折叠）；名字必填就地红字 + 聚焦；
 *   · 折叠区「有内容自动展开」：导入 / 编辑已有卡时自动打开，摘要行给已填提示；
 *   · 导入 PNG 成功 → 自动进编辑视图、内容正确、来源提示「已导入：<文件名>」；
 *   · 保存后卡挂到当前聊天（mode 仍是 chat、开场白进日志）；本对话设置里编辑已有卡直接进编辑视图，
 *     文案「保存角色卡」；
 *   · 窄屏键盘代理：视口压矮后底部主按钮仍在视口内且可点（真键盘无法在无头环境复现，用缩高代理）。
 *   · 两个开局页的文案与样式一致：标题「新故事 · 模式名」+ ≤18 字的一句话说明（同一张文案表）、
 *     折叠块同用「更多设定（可选）」一份组件、主按钮贴右下、低动效档展开与高亮直接跳变。
 *
 * 只新增文件，不改任何现有源码；页面一律 file:// 打开构建出的单文件产物，不联网。
 * Chromium 优先走系统 Chrome（channel:'chrome'），没有则退回 Playwright 自带内核。
 */
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Zip } from '../../src/core/zip.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'acceptance', 'mode-entry', 'shots');
const APP_URL = pathToFileURL(path.join(ROOT, 'dist', 'single', 'index.html')).href;

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

/* ---------------- PNG 夹具：一张内嵌 SillyTavern V2 角色卡（tEXt keyword=chara）的 1x1 PNG ---------------- */

const ST_CARD = {
  name: '周叙',
  description: '瘦高个，制服第二颗扣子总是没扣；左手腕有块旧表。',
  personality: '话里有话、克制，从不把话说满',
  scenario: '凌晨的便利店，雨声很大，店里只有你们两个人。',
  first_mes: '「这么晚还来买东西？」他把找零推过来，硬币在台面上转了半圈。',
  mes_example: '{{char}}: 「挑便宜的就走。」\n{{char}}: 「雨要下到天亮。」',
  system_prompt: '',
  creator_notes: 'acceptance fixture',
};

function buildPngWithCard(card) {
  // 1x1 透明 PNG（固定字节），把 tEXt 块插到 IEND 之前
  const base = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const text = Buffer.from('chara\0' + Buffer.from(JSON.stringify(card)).toString('base64'), 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(text.length);
  const type = Buffer.from('tEXt', 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(Zip.crc32(Buffer.concat([type, text])));
  const iendAt = base.indexOf(Buffer.from('IEND', 'latin1')) - 4;
  return Buffer.concat([base.subarray(0, iendAt), len, type, text, crc, base.subarray(iendAt)]);
}

/* ---------------- 小工具 ---------------- */
const log = (...a) => console.log('[mode-entry-shoot]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function openApp(page) {
  await page.goto(APP_URL + '?ir-test=1', { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.documentElement.dataset.motion, null, { timeout: 15000 });
  await page.waitForSelector('#modal-shell-host', { state: 'attached', timeout: 15000 });
  await page.waitForFunction(() => !!window.__IR_TEST__, null, { timeout: 15000 });
  await sleep(600);
  // 首次启动（还没接入过）会自动弹「接入向导」，挡着底下所有点击：空跑验收先关掉。
  // 空表单关闭不会弹「丢弃」确认；万一弹了就顺手确认掉。
  if (await page.locator('#modal-connect:not(.hidden)').count()) {
    await page.click('#btn-close-connect');
    await sleep(400);
    if (await page.locator('#modal-confirm:not(.hidden)').count()) {
      await page.click('#cf-ok');
      await sleep(300);
    }
  }
}

// 截图前的稳定化：藏掉瞬态 toast、失焦、鼠标挪到中性点
async function settle(page, opts) {
  opts = opts || {};
  if (!opts.keepToast) {
    await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.classList.add('hidden'); });
  }
  await page.evaluate(() => { try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (_) {} });
  await page.mouse.move(2, 2);
  await sleep(opts.wait || 450);
}

/* ---------------- 主流程 ---------------- */
async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'single', 'index.html'))) {
    console.error('先跑 npm run build:single 生成 dist/single/index.html');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) {
    if (/^\d+-.*-\d+\.png$/.test(f)) fs.rmSync(path.join(OUT, f), { force: true });   // 重跑整组换新，不留旧图
  }

  const manifest = {
    project: 'infinite-reading',
    tool: 'acceptance/tools/mode-entry-shoot.mjs',
    generatedAt: new Date().toISOString(),
    entry: APP_URL,
    viewports: VIEWPORTS,
    shots: [],
    checks: [],
    console: [],
    notes: [
      '命名 {序号}-{视图}-{宽度}.png；只截 viewport（fullPage:false）。',
      '键盘弹起无法在无头环境复现：用「视口压矮到 450 高后底部主按钮仍可点」做代理断言。',
    ],
  };

  const png = buildPngWithCard(ST_CARD);

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (_) {
    log('系统 Chrome 不可用，退回 Playwright 自带 Chromium');
    browser = await chromium.launch({ headless: true });
  }
  try {
    for (const vp of VIEWPORTS) await runWidth(browser, vp, manifest, png);
  } finally {
    await browser.close();
  }

  manifest.summary = {
    shots: manifest.shots.length,
    checks: manifest.checks.length,
    checksFailed: manifest.checks.filter(c => !c.ok).length,
    consoleErrors: manifest.console.reduce((n, c) => n + c.errors.length, 0),
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  log('done →', path.join(OUT, 'manifest.json'));
  log('shots:', manifest.summary.shots, 'checks:', manifest.summary.checks, 'failed:', manifest.summary.checksFailed, 'console errors:', manifest.summary.consoleErrors);
  if (manifest.summary.checksFailed || manifest.summary.consoleErrors) process.exitCode = 1;
}

async function runWidth(browser, vp, manifest, png) {
  log('== width', vp.width, '==');
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 300)));
  // 本地服务不在跑：把启动探测的 /health 之类接住，别把「连不上 127.0.0.1」记成页面错误
  await page.route('http://127.0.0.1:4319/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, version: 'acceptance', features: { email: true, schedule: true, payment: true } }),
  }));

  let seq = 0;
  const check = async (label, fn) => {
    // 断言函数的口径：返回 '' / true / undefined = 通过；返回非空字符串 = 失败原因
    let ok = false, detail = '';
    try {
      const r = await fn();
      if (r === true || r === undefined || r === '') ok = true;
      else detail = typeof r === 'string' ? r : JSON.stringify(r);
    } catch (e) { detail = String((e && e.message) || e); }
    manifest.checks.push({ width: vp.width, label, ok, detail });
    log(' ', ok ? 'ok  ' : 'FAIL', label, detail ? '(' + detail + ')' : '');
  };
  const snap = async (name, opts) => {
    seq += 1;
    await settle(page, opts);
    const file = String(seq).padStart(2, '0') + '-' + name + '-' + vp.width + '.png';
    await page.screenshot({ path: path.join(OUT, file), fullPage: false });
    manifest.shots.push({ seq, file, width: vp.width, height: vp.height, name, note: (opts && opts.note) || '' });
    log('  shot', file);
  };
  const text = (sel) => page.locator(sel).textContent();
  const hidden = (sel) => page.locator(sel).evaluate(el => el.classList.contains('hidden') || getComputedStyle(el).display === 'none');
  const detailOpen = (sel) => page.locator(sel).evaluate(el => el.open);
  // 两个开局页共用的口径：标题 = 「新故事 · 模式名」，说明 ≤18 字（判断句读感一致）
  const ENTRY_TITLE = {
    choice: '新故事 · 剧情',
    chat: '新故事 · 聊天',
  };
  const ENTRY_DESC = {
    choice: '先搭个舞台，故事从这里生长',
    chat: '有事直说，它替你去办',
  };
  const titleIs = async (sel, mode) => {
    const t = ((await text(sel)) || '').trim();
    return t === ENTRY_TITLE[mode] ? '' : '标题=' + t + '（期望 ' + ENTRY_TITLE[mode] + '）';
  };
  const descIs = async (sel, mode) => {
    const t = ((await text(sel)) || '').trim();
    if (t !== ENTRY_DESC[mode]) return '说明=' + t + '（期望 ' + ENTRY_DESC[mode] + '）';
    return t.length <= 18 ? '' : '说明超过 18 字：' + t.length;
  };
  // 折叠块措辞一致：标题固定「更多设定（可选）」，摘要行跟在后面（两个弹窗同一份组件）
  const foldWording = async (sel) => {
    const t = ((await text(sel + ' > summary')) || '').trim();
    return t.indexOf('更多设定（可选）') === 0 ? '' : '摘要行=' + t;
  };
  // 主按钮在右下：右边缘贴页脚内边距、且确实落在页脚行里（不是标题旁 / 内容中段）
  const primaryRightBottom = async (modalSel, btnSel) => {
    const bb = await page.locator(btnSel).boundingBox();
    const foot = await page.locator(modalSel + ' .modal-foot').boundingBox().catch(() => null);
    if (!bb) return '按钮不在布局里';
    if (!foot) return '找不到页脚';
    const dRight = Math.abs((foot.x + foot.width) - (bb.x + bb.width));
    if (dRight > 26) return '离右边缘 ' + Math.round(dRight) + 'px（应贴页脚内边距 ≈22）';
    if (bb.y < foot.y) return '按钮不在页脚行里';
    return '';
  };

  try {
    await openApp(page);

    /* —— 首页：只有两张模式卡 —— */
    await check('首页两张模式卡：剧情 / 聊天（没有「扮演」）', async () => {
      const modes = await page.locator('#start-modes .mode-card').evaluateAll(els => els.map(e => e.dataset.mode));
      return (modes.length === 2 && modes.join(',') === 'choice,chat') ? '' : '模式卡=' + modes.join(',');
    });
    await snap('start-modes', { note: '首页：两张模式卡（剧情 / 聊天），原「扮演」已并入聊天' });

    /* —— 聊天开局：空对话的引导页 —— */
    await page.click('#screen-start .mode-card[data-mode="chat"]');
    await page.waitForSelector('#screen-game:not(.hidden)', { timeout: 8000 });
    await page.waitForSelector('.agent-intro', { timeout: 8000 }).catch(() => {});
    await sleep(500);
    await check('聊天开局进阅读页、出现「能做什么」引导', async () =>
      (await page.locator('.agent-intro').count()) ? '' : '引导块没渲染');
    await check('聊天引导首行是模式说明（≤18 字）', async () => descIs('.agent-intro .entry-desc', 'chat'));
    await check('空聊天没有做 / 说 / 导演开关', async () => hidden('#kind-switch'));
    await check('新建聊天默认无卡、不预置本对话开关', async () => {
      const st = await page.evaluate(() => {
        const S = window.__IR_TEST__.App.state.story;
        return S ? { mode: S.mode, card: !!S.characterCard, tools: S.prefs && S.prefs.tools } : null;
      });
      if (!st) return '没有故事';
      if (st.mode !== 'chat') return 'mode=' + st.mode;
      if (st.card) return '默认不该带卡';
      return st.tools ? '默认不该预置 tools' : '';
    });
    await check('引导页有「添加角色卡（可选）」入口', async () =>
      (await page.locator('.agent-card-entry button').count()) ? '' : '入口没渲染');
    await snap('mode-chat-intro', { note: '聊天开局 · 空对话的「能做什么」引导（含「添加角色卡（可选）」）' });

    /* —— 添加角色卡 → 选卡视图 —— */
    await page.click('.agent-card-entry button');
    await page.waitForSelector('#modal-card:not(.hidden)', { timeout: 8000 });
    await sleep(400);
    await check('添加角色卡先进选卡视图', async () =>
      (await hidden('#rc-view-pick')) ? '选卡块被隐藏' : (await hidden('#rc-view-edit')) ? '' : '编辑块不该显示');
    await check('选卡视图没有页脚', async () =>
      (await page.locator('#modal-card .modal-foot').isVisible()) ? '页脚应整条收起' : '');
    await check('选卡视图标题「添加角色卡」', async () => {
      const t = ((await text('#card-modal-title')) || '').trim();
      return t === '添加角色卡' ? '' : '标题=' + t;
    });
    await check('选卡视图一句话说明', async () => {
      const t = ((await text('#rc-view-pick .entry-desc')) || '').trim();
      return t === 'TA 是谁、怎么说话，由这张卡定。' ? '' : '说明=' + t;
    });
    await snap('card-pick', { note: '聊天 · 添加角色卡 · 选卡视图（导入 PNG / 自己写一张）' });

    /* —— 自己写一张 → 编辑视图 —— */
    await page.click('#btn-rc-write');
    await sleep(350);
    await check('「自己写一张」进编辑视图', async () =>
      (await hidden('#rc-view-edit')) ? '编辑块没显示' : (await hidden('#rc-view-pick')) ? '' : '选卡块该隐藏');
    await check('保存钮「添加角色卡」（给当前聊天加卡）', async () => {
      const t = ((await text('#btn-rc-save')) || '').trim();
      return t === '添加角色卡' ? '' : '按钮文案=' + t;
    });
    await check('从选卡走过来的编辑视图有「← 选卡」', async () =>
      (await hidden('#btn-rc-back')) ? '返回按钮没显示' : '');
    await check('新建的来源提示是「只属于这次对话」口径', async () => {
      const t = (await text('#card-source-hint')) || '';
      return t.indexOf('只属于这次对话') >= 0 ? '' : '提示=' + t;
    });
    await check('空卡的折叠区默认收起', async () =>
      (await detailOpen('#rc-more')) ? '折叠区不该展开' : '');
    await check('折叠块措辞「更多设定（可选）」', async () => foldWording('#rc-more'));
    await check('主按钮「添加角色卡」在右下', async () =>
      primaryRightBottom('#modal-card', '#btn-rc-save'));
    await snap('card-edit-new', { note: '聊天 · 角色卡编辑视图（自己写一张：名字 + 开场白直给）' });

    /* —— 必填就地提示 —— */
    await page.click('#btn-rc-save');
    await sleep(250);
    await check('名字空着点保存 → 就地红字 + 焦点落名字', async () => {
      if (await hidden('#rc-required-hint')) return '红字没出现';
      const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
      return focused === 'rc-name' ? '' : '焦点在 #' + focused;
    });
    await page.fill('#rc-name', '周叙');
    await page.fill('#rc-opening', '「这么晚还来买东西？」他把找零推过来。');
    await sleep(200);
    await check('名字有输入后红字收起', async () =>
      (await hidden('#rc-required-hint')) ? '' : '红字该撤');

    /* —— 手动展开折叠区填一项：摘要行给已填提示 —— */
    await page.click('#rc-more summary');
    await sleep(250);
    await page.fill('#rc-personality', '话里有话、克制');
    await sleep(200);
    await check('折叠摘要显示已填提示', async () => {
      const t = (await text('#rc-more-sum')) || '';
      return t.indexOf('已填性格') >= 0 ? '' : '摘要=' + t;
    });
    await snap('card-edit-filled', { note: '聊天 · 编辑视图（展开「更多设定（可选）」）' });

    /* —— 返回选卡再「自己写一张」：自己敲的内容原样保留 —— */
    await page.click('#btn-rc-back');
    await sleep(300);
    await check('「← 选卡」回到选卡视图', async () =>
      (await hidden('#rc-view-pick')) ? '选卡块没显示' : '');
    await page.click('#btn-rc-write');
    await sleep(300);
    await check('回选卡再进来：自己敲的内容保留', async () => {
      const v = await page.locator('#rc-name').inputValue();
      return v === '周叙' ? '' : '名字=' + v;
    });

    /* —— 保存：卡挂到当前聊天，开场白进日志（不新建故事） —— */
    await page.click('#btn-rc-save');
    await sleep(700);
    await check('保存后卡加到当前聊天：mode 仍是 chat、卡与开场白入档', async () => {
      const st = await page.evaluate(() => {
        const S = window.__IR_TEST__.App.state.story;
        return {
          mode: S.mode,
          name: S.characterCard && S.characterCard.name,
          narrations: (S.log || []).filter(l => l.type === 'narration').map(l => l.text),
        };
      });
      if (st.mode !== 'chat') return 'mode=' + st.mode;
      if (st.name !== '周叙') return '卡名=' + st.name;
      return st.narrations.some(t => t.indexOf('这么晚') >= 0) ? '' : '开场白没进日志';
    });
    await check('有卡后输入框占位符收成「说点什么……」', async () => {
      const p = await page.locator('#player-input').getAttribute('placeholder');
      return p === '说点什么……' ? '' : '占位符=' + p;
    });
    await check('有卡后仍没有做 / 说 / 导演开关', async () => hidden('#kind-switch'));
    await snap('chat-with-card', { note: '聊天 · 加卡之后：开场白进日志、引导消失' });

    /* —— 本对话设置：角色卡区块 + 编辑已有卡 —— */
    await page.evaluate(() => { const b = document.getElementById('btn-hud-more'); if (b) b.click(); });
    await page.waitForSelector('#hud-more-menu:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-story-prefs');
    await page.waitForSelector('#story-prefs:not(.hidden)', { timeout: 8000 });
    await sleep(300);
    await check('聊天设置里有「角色卡」区块：编辑 / 移除在场（有卡时「添加」收起）', async () => {
      const shown = async (sel) => !(await hidden(sel));
      const add = await shown('#btn-add-card'), edit = await shown('#btn-edit-card'), rm = await shown('#btn-remove-card');
      if (add) return '有卡时不该显示「添加角色卡」';
      return (edit && rm) ? '' : '编辑／移除没显示';
    });
    await page.click('#btn-edit-card');
    await page.waitForSelector('#modal-card:not(.hidden)', { timeout: 8000 });
    await sleep(450);
    await check('编辑已有卡直接进编辑视图', async () =>
      (await hidden('#rc-view-edit')) ? '编辑块没显示' : (await hidden('#rc-view-pick')) ? '' : '选卡块该隐藏');
    await check('编辑已有卡保存钮「保存角色卡」', async () => {
      const t = ((await text('#btn-rc-save')) || '').trim();
      return t === '保存角色卡' ? '' : '按钮文案=' + t;
    });
    await check('编辑已有卡没有「← 选卡」', async () =>
      (await hidden('#btn-rc-back')) ? '' : '返回按钮不该显示');
    await check('编辑已有卡的来源提示沿用「改完即生效」', async () => {
      const t = (await text('#card-source-hint')) || '';
      return t.indexOf('改完即生效') >= 0 ? '' : '提示=' + t;
    });
    await check('编辑已有卡折叠区按内容自动展开', async () =>
      (await detailOpen('#rc-more')) ? '' : '卡里带性格，折叠区该展开');
    await snap('card-edit-existing', { note: '聊天 · 编辑已有角色卡（直接进编辑视图）' });

    /* —— 导入 PNG → 自动进编辑视图（内容正确 / 来源提示 / 折叠自动展开） —— */
    await page.setInputFiles('#file-card', { name: '周叙.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => {
      const el = document.getElementById('rc-view-edit');
      return el && !el.classList.contains('hidden');
    }, null, { timeout: 8000 });
    await sleep(400);
    await check('导入 PNG 成功后自动进编辑视图', async () =>
      (await hidden('#rc-view-edit')) ? '编辑块没显示' : '');
    await check('导入内容灌进表单', async () => {
      const name = await page.locator('#rc-name').inputValue();
      const opening = await page.locator('#rc-opening').inputValue();
      return name === '周叙' && opening.indexOf('这么晚') >= 0 ? '' : 'name=' + name + ' opening=' + opening.slice(0, 20);
    });
    await check('导入后来源提示「已导入：<文件名>」', async () => {
      const t = ((await text('#card-source-hint')) || '').trim();
      return t === '已导入：周叙.png' ? '' : '提示=' + t;
    });
    await check('有内容的折叠区自动展开', async () =>
      (await detailOpen('#rc-more')) ? '' : '折叠区该自动展开');
    await snap('card-import-edit', { note: '聊天 · 导入 PNG 后的编辑视图（内容已灌、折叠自动展开）' });

    /* —— 窄屏键盘代理：视口压矮后底部主按钮仍可点 —— */
    if (vp.width === 390) {
      await page.setViewportSize({ width: 390, height: 450 });
      await sleep(500);
      await check('窄屏压矮视口（键盘代理）后底部主按钮仍可点', async () => {
        const bb = await page.locator('#btn-rc-save').boundingBox();
        if (!bb) return '按钮不在布局里';
        if (bb.y < 0 || bb.y + bb.height > 450) return '按钮跑出视口 y=' + bb.y;
        await page.locator('#btn-rc-save').click({ trial: true });
        return '';
      });
      await snap('card-edit-kb', { note: '窄屏视口压矮（键盘代理）：底部按钮仍钉在可视区' });
      await page.setViewportSize({ width: 390, height: 844 });
      await sleep(300);
    }

    await page.click('#btn-close-card');
    await sleep(250);
    await page.click('#prefs-close');
    await sleep(250);

    /* —— 剧情开局：向导页（另一个开局页，一页不落） —— */
    await page.click('#btn-back-home');
    await page.waitForSelector('#screen-start:not(.hidden)');
    await sleep(400);
    await page.click('#screen-start .mode-card[data-mode="choice"]');
    await page.waitForSelector('#modal-wizard:not(.hidden)', { timeout: 8000 });
    await sleep(400);
    await check('向导标题「新故事 · 剧情」', async () => titleIs('#modal-wizard .modal-head h2', 'choice'));
    await check('向导一句话说明（≤18 字）', async () => descIs('#modal-wizard .entry-desc', 'choice'));
    await check('向导折叠块措辞「更多设定（可选）」', async () => foldWording('#wz-more'));
    await check('主按钮「下一步：试画（可跳过）」在右下', async () => {
      const t = ((await text('#btn-wz-start')) || '').trim();
      if (t !== '下一步：试画（可跳过）') return '按钮文案=' + t;
      return primaryRightBottom('#modal-wizard', '#btn-wz-start');
    });
    await check('低动效档：折叠展开直接跳变（动画时长压到 0）', async () => {
      // 动效只有 rich 一档：系统「减少动态效果」是唯一静默例外，靠 prefers-reduced-motion
      // 把 animation-duration / transition-duration 压到 0，动画名仍保留（fadeIn 这类淡入不撤名）
      await page.click('#wz-more summary');
      await sleep(250);
      const dur = await page.locator('#wz-more > .fold-body').evaluate(el => getComputedStyle(el).animationDuration);
      const over = dur.split(',').map(s => parseFloat(s) * (s.indexOf('ms') >= 0 ? 0.001 : 1)).filter(n => n > 0.001);
      return over.length ? 'animationDuration=' + dur : '';
    });
    await check('低动效档：起草回填高亮时长收成 0s（跳变）', async () => {
      const dur = await page.locator('#wz-world').evaluate((el) => {
        el.classList.add('wz-flashable', 'wz-flash');
        const d = getComputedStyle(el).transitionDuration;
        el.classList.remove('wz-flashable', 'wz-flash');
        return d;
      });
      // off 档过渡给 0ms；浏览器开了「减少动态效果」时无 JS 兜底把一切压成 .001s，同样是跳变
      const over = dur.split(',').map(s => parseFloat(s) * (s.indexOf('ms') >= 0 ? 0.001 : 1)).filter(n => n > 0.001);
      return over.length ? 'transitionDuration=' + dur : '';
    });
    await snap('mode-wizard', { note: '剧情开局 · 开局设定向导（折叠区已展开）' });
    await page.click('#btn-close-wizard');
    await sleep(300);

    /* —— 书架 →「新故事」弹窗：同样两张模式卡 —— */
    await page.click('#btn-start-shelf');
    await page.waitForSelector('#screen-shelf:not(.hidden)', { timeout: 8000 });
    await sleep(300);
    await page.click('#btn-new-story');
    await page.waitForSelector('#modal-new:not(.hidden)', { timeout: 8000 });
    await sleep(300);
    await check('新故事弹窗两张模式卡：剧情 / 聊天', async () => {
      const modes = await page.locator('#modal-new .mode-card').evaluateAll(els => els.map(e => e.dataset.mode));
      return (modes.length === 2 && modes.join(',') === 'choice,chat') ? '' : '模式卡=' + modes.join(',');
    });
    await snap('modal-new', { note: '新故事弹窗：两张模式卡（剧情 / 聊天）' });
    await page.click('#modal-new .mode-card[data-mode="chat"]');
    await page.waitForSelector('#screen-game:not(.hidden)', { timeout: 8000 });
    await sleep(500);
    await check('弹窗里点聊天卡 → 直接开一局空聊天', async () => {
      const st = await page.evaluate(() => {
        const S = window.__IR_TEST__.App.state.story;
        return S ? { mode: S.mode, card: !!S.characterCard, empty: !(S.log || []).length } : null;
      });
      if (!st) return '没有故事';
      if (st.mode !== 'chat') return 'mode=' + st.mode;
      if (st.card) return '新聊天不该带卡';
      return st.empty ? '' : '新聊天该是空的';
    });
  } catch (e) {
    manifest.checks.push({ width: vp.width, label: '整轮流程中断', ok: false, detail: String((e && e.stack) || e) });
    log('  PASS ERROR', String((e && e.stack) || e));
  }

  manifest.console.push({ width: vp.width, errors });
  await ctx.close();
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
