/*
 * acceptance/phase5/8/pwa-offline.mjs —— 阶段 5 · 第 8 步 · 产物形态验收（file:// 双击 + PWA 断网）
 *
 * 两个场景：
 *
 *   file://   双击 dist/single/index.html（单文件产物）：应用正常启动、屏幕齐全、档位落定、
 *             service worker 不注册（file:// 本来就不支持），console error 0
 *   pwa       起一个本地静态服务器指向 dist/site（多文件产物 / GitHub Pages 形态）：
 *             等 Service Worker 装好并接管 → 断网 → reload：
 *             导航请求网络优先失败 → 回退预缓存 index.html，应用仍能启动、还能切屏；
 *             同源 JS/CSS/图标全部走缓存；console error 0
 *
 * 用法：node acceptance/phase5/8/pwa-offline.mjs [--out=acceptance/phase5/8]
 * 产出：{out}/pwa-offline.json
 * 退出码：0 = 两个场景全过；1 = 有断言没过；2 = 没有构建产物
 */
import { createRequire } from 'module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SITE = path.join(ROOT, 'dist', 'site');
const SINGLE = path.join(ROOT, 'dist', 'single', 'index.html');
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();

const log = (...a) => console.log('[pwa-offline]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseArgs() {
  const out = { out: 'acceptance/phase5/8' };
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] == null ? '' : m[2];
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function startServer(root) {
  return new Promise((resolve, reject) => {
    const base = path.resolve(root);
    const server = http.createServer((req, res) => {
      let pathname = '/';
      try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch (_) {}
      if (pathname.endsWith('/')) pathname += 'index.html';
      const file = path.resolve(base, '.' + pathname);
      if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-cache',
        });
        res.end(buf);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const isSidecar = (s) => /\/health\b|127\.0\.0\.1:4319/.test(String(s));

function collectErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    const loc = m.location && m.location() ? m.location().url : '';
    if (m.type() === 'error' && !isSidecar(m.text()) && !isSidecar(loc)) errors.push(m.text() + (loc ? ' @ ' + loc : ''));
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String((e && e.message) || e)));
  return errors;
}

function checker() {
  const checks = [];
  return {
    checks,
    add(name, ok, detail) { checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) }); },
  };
}

/* ================= file:// 双击 ================= */

async function runFile(browser) {
  const { add, checks } = checker();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const url = pathToFileURL(SINGLE).href;
  let boot = {};

  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.IR && IR.App && IR.Store), null, { timeout: 20000 });
    await page.waitForFunction(() => !!(IR.App.state && IR.App.state.settings), null, { timeout: 20000 });
    await sleep(500);
    boot = await page.evaluate(() => ({
      title: document.title,
      motion: document.documentElement.dataset.motion || '',
      screens: ['screen-start', 'screen-shelf', 'screen-game', 'branch-page'].filter(id => !!document.getElementById(id)),
      startVisible: !!document.querySelector('#screen-start:not(.hidden)'),
      version: (window.IR && IR.App && IR.App.VERSION) || '',
      controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      inlineScripts: document.querySelectorAll('script[src]').length,
      inlineLinks: document.querySelectorAll('link[rel="stylesheet"][href^="http"], link[rel="stylesheet"][href^="./"], link[rel="stylesheet"][href^="assets"]').length,
      protocol: location.protocol,
    }));
    // 真的切一次屏：file:// 下也能跑过渡内核（off / rich 都走同一条链路）
    await page.evaluate(() => window.IR.Nav.showScreen('shelf'));
    await sleep(420);
    boot.shelfVisible = await page.evaluate(() => !!document.querySelector('#screen-shelf:not(.hidden)'));
    await page.evaluate(() => window.IR.App.applyMotion && null);
  } catch (e) {
    boot.error = String((e && e.stack) || e);
  }

  add('file://：单文件产物能启动（IR.App / IR.Store / 设置就绪）', !boot.error, boot.error || 'ok');
  add('file://：四块屏都在 DOM 里', (boot.screens || []).length === 4, (boot.screens || []).join(','));
  add('file://：首页可见（初始态正确）', boot.startVisible === true, String(boot.startVisible));
  add('file://：动效档位已落定（html[data-motion] 非空）', !!boot.motion, boot.motion || '(空)');
  add('file://：切屏可用（书架可见）', boot.shelfVisible === true, String(boot.shelfVisible));
  add('file://：不注册 Service Worker（浏览器在 file:// 下本就不支持）', boot.controller === false, String(boot.controller));
  add('file://：产物零外链（无 script[src] / 无外链样式）', boot.inlineScripts === 0 && boot.inlineLinks === 0,
    'script=' + boot.inlineScripts + ' link=' + boot.inlineLinks);
  add('file://：console error 0', errors.length === 0, errors.join(' | '));

  await ctx.close();
  for (const c of checks) log('    ' + (c.ok ? '✓ ' : '✗ ') + c.name + (c.ok || !c.detail ? '' : '  ← ' + c.detail));
  return { id: 'file', url, terminal: boot, checks, consoleErrors: errors, ok: checks.every(c => c.ok) };
}

/* ================= PWA 断网 ================= */

async function runPwa(browser, port) {
  const { add, checks } = checker();
  const base = 'http://127.0.0.1:' + port + '/';
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const data = { base, steps: {} };
  let onlineBoot = {};
  let offlineBoot = {};
  let reloadError = '';

  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.IR && IR.App && IR.Store), null, { timeout: 20000 });
    onlineBoot = await page.evaluate(() => ({
      title: document.title,
      motion: document.documentElement.dataset.motion || '',
      startVisible: !!document.querySelector('#screen-start:not(.hidden)'),
    }));

    // 等 SW 安装 + 接管（activate 里 clients.claim，通常不用 reload；超时就刷新一次）
    await page.waitForFunction(() => !!(navigator.serviceWorker && navigator.serviceWorker.ready), null, { timeout: 20000 });
    let controlled = false;
    for (let i = 0; i < 40 && !controlled; i++) {
      controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
      if (!controlled) await sleep(250);
    }
    if (!controlled) {
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => !!(window.IR && IR.App), null, { timeout: 20000 });
      controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    }

    const cacheInfo = await page.evaluate(async () => {
      const keys = await caches.keys();
      const out = { keys, entries: 0 };
      for (const k of keys) {
        const c = await caches.open(k);
        out.entries += (await c.keys()).length;
      }
      return out;
    });
    data.steps.online = { controlled, cacheInfo };

    // 断网：导航网络优先失败 → SW 回退预缓存 index.html
    await ctx.setOffline(true);
    await sleep(200);
    try {
      await page.reload({ waitUntil: 'load', timeout: 20000 });
    } catch (e) {
      reloadError = String((e && e.message) || e);
    }
    if (!reloadError) {
      await page.waitForFunction(() => !!(window.IR && IR.App && IR.Store), null, { timeout: 20000 });
      await page.waitForFunction(() => !!(IR.App.state && IR.App.state.settings), null, { timeout: 20000 });
      await sleep(400);
      offlineBoot = await page.evaluate(() => ({
        title: document.title,
        motion: document.documentElement.dataset.motion || '',
        startVisible: !!document.querySelector('#screen-start:not(.hidden)'),
        online: navigator.onLine,
        controlled: !!navigator.serviceWorker.controller,
      }));
      // 断网下再切一次屏：JS 与样式都来自缓存
      await page.evaluate(() => window.IR.Nav.showScreen('shelf'));
      await sleep(420);
      offlineBoot.shelfVisible = await page.evaluate(() => !!document.querySelector('#screen-shelf:not(.hidden)'));
    }
    data.steps.offline = { reloadError, boot: offlineBoot };
  } catch (e) {
    data.fatal = String((e && e.stack) || e);
  } finally {
    try { await ctx.setOffline(false); } catch (_) {}
  }

  add('PWA：在线打开正常（首页可见，档位落定）', onlineBoot.startVisible === true && !!onlineBoot.motion,
    JSON.stringify(onlineBoot));
  add('PWA：Service Worker 已注册并接管页面', data.steps.online && data.steps.online.controlled === true,
    JSON.stringify(data.steps.online || {}));
  add('PWA：预缓存已建立（缓存条目 > 0）',
    !!(data.steps.online && data.steps.online.cacheInfo && data.steps.online.cacheInfo.entries > 0),
    JSON.stringify((data.steps.online || {}).cacheInfo || {}));
  add('PWA：断网后 reload 成功（导航回退到预缓存 index.html）', !reloadError, reloadError || 'ok');
  add('PWA：断网下应用启动（IR 就绪、首页可见）',
    offlineBoot.startVisible === true, JSON.stringify(offlineBoot));
  add('PWA：断网下导航器报告离线（navigator.onLine=false）', offlineBoot.online === false, String(offlineBoot.online));
  add('PWA：断网下页面仍由 SW 控制', offlineBoot.controlled === true, String(offlineBoot.controlled));
  add('PWA：断网下切屏可用（书架可见）', offlineBoot.shelfVisible === true, String(offlineBoot.shelfVisible));
  add('PWA：console error 0', errors.length === 0, errors.join(' | '));
  if (data.fatal) add('PWA：流程未抛异常', false, data.fatal);

  await ctx.close();
  for (const c of checks) log('    ' + (c.ok ? '✓ ' : '✗ ') + c.name + (c.ok || !c.detail ? '' : '  ← ' + c.detail));
  return { id: 'pwa', url: base, steps: data.steps, fatal: data.fatal || '', checks, consoleErrors: errors, ok: checks.every(c => c.ok) };
}

/* ================= 入口 ================= */

async function main() {
  const args = parseArgs();
  const outDir = path.resolve(ROOT, args.out);
  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(SINGLE)) { console.error('[pwa-offline] 没有 dist/single/index.html：先 npm run build'); process.exit(2); }
  if (!fs.existsSync(path.join(SITE, 'index.html'))) { console.error('[pwa-offline] 没有 dist/site/index.html：先 npm run build'); process.exit(2); }

  const sw = fs.existsSync(path.join(SITE, 'sw.js')) ? fs.readFileSync(path.join(SITE, 'sw.js'), 'utf8') : '';
  const precacheInjected = /const PRECACHE = \[\s*"\.\//.test(sw);

  const { server, port } = await startServer(SITE);
  const browser = await chromium.launch({ channel: 'chrome' });
  let file;
  let pwa;
  try {
    log('== file:// ==');
    file = await runFile(browser);
    log('== pwa (127.0.0.1:' + port + ') ==');
    pwa = await runPwa(browser, port);
  } finally {
    await browser.close();
    server.close();
  }

  const result = {
    project: 'infinite-reading',
    version: VERSION,
    stage: '阶段 5 · 第 8 步 · 产物形态（file:// 双击 + PWA 断网）',
    generatedAt: new Date().toISOString(),
    tool: 'acceptance/phase5/8/pwa-offline.mjs',
    dist: {
      single: path.relative(ROOT, SINGLE).split(path.sep).join('/'),
      site: path.relative(ROOT, SITE).split(path.sep).join('/'),
      swPrecacheInjected: precacheInjected,
    },
    scenarios: [file, pwa],
  };
  result.summary = {
    scenarios: 2,
    checks: file.checks.length + pwa.checks.length,
    failed: file.checks.concat(pwa.checks).filter(c => !c.ok).length,
    consoleErrors: file.consoleErrors.length + pwa.consoleErrors.length,
    ok: file.ok && pwa.ok && precacheInjected,
  };
  if (!precacheInjected) {
    result.summary.failed += 1;
    log('✗ dist/site/sw.js 的 PRECACHE 没有注入（构建期插件没跑？）');
  }
  fs.writeFileSync(path.join(outDir, 'pwa-offline.json'), JSON.stringify(result, null, 2), 'utf8');
  log('断言 ' + result.summary.checks + '，失败 ' + result.summary.failed
    + '，console error ' + result.summary.consoleErrors + ' → ' + (result.summary.ok ? '全绿' : '有失败'));
  process.exit(result.summary.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
