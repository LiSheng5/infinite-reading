/*
 * acceptance/tools/prefs-smoke.mjs —— 屏 2（设置屏 + 本对话设置面板）的行为冒烟
 *
 * 跑法：先 npm run build:single，再 node acceptance/tools/prefs-smoke.mjs
 * 目标：dist/single/index.html（file:// 双击的真实形态），?demo=1 离线演示故事。
 * 两轮：默认（Svelte 新屏）与 ?ui=legacy（0.12.1 旧屏逃生口）。
 * 覆盖：设置屏挂载 / id 就位 / 保存读回 / 折叠块自动展开两条规则 / 分组切换；
 *       本对话面板下钻（滚动 / 焦点 / Esc 层级）/ 人物行卡 / sticky 保存栏 / 判变禁用；
 *       旧屏仍是 legend 归类 + 表格人物行，且不注册新屏状态桥。
 */
import { createRequire } from 'module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = pathToFileURL(path.join(ROOT, 'dist', 'single', 'index.html')).href;

const out = [];
const ok = (name, pass, detail) => out.push({ name, pass, detail: detail == null ? '' : String(detail) });

async function run(browser, label, suffix, fn) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  await page.goto(APP + '?demo=1' + suffix);
  await page.waitForTimeout(2500);
  await fn(page, (name, pass, detail) => ok(label + name, pass, detail));
  ok(label + 'no pageerror', errors.length === 0, errors.slice(0, 5).join(' | '));
  await page.close();
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });

// ============ 默认：Svelte 新屏 ============
await run(browser, 'svelte: ', '', async (page, ok) => {
  ok('settings mounted', await page.evaluate(() => !!document.querySelector('#modal-settings[data-impl="svelte"]')));
  ok('set-panels impl', await page.evaluate(() => !!document.querySelector('#set-panels[data-impl="svelte"]')));
  await page.evaluate(() => window.IR.App.openSettings());
  await page.waitForTimeout(400);
  ok('settings visible', await page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')));
  ok('6 groups', await page.evaluate(() => document.querySelectorAll('#set-panels .set-panel').length) === 6);
  ok('g-models active', await page.evaluate(() => !!document.querySelector('.set-nav-item[data-group="g-models"].active')));
  await page.fill('#s-chat-model', 'smoke-model');
  await page.fill('#s-chat-base', 'http://127.0.0.1:9');
  await page.click('#btn-save-settings');
  await page.waitForTimeout(300);
  const readBack = await page.evaluate(() => ({ model: window.IR.App.state.settings.chat.model, base: window.IR.App.state.settings.chat.baseUrl }));
  ok('save/readback', readBack.model === 'smoke-model' && readBack.base === 'http://127.0.0.1:9', JSON.stringify(readBack));

  // 折叠块自动展开：data-auto="filled"（有非空输入才开）/ data-auto="#勾选框"（勾上才开）+ 状态标签
  await page.evaluate(() => window.IR.App.openSettings());
  await page.waitForTimeout(300);
  ok('adv closed when empty', await page.evaluate(() => {
    const d = document.querySelector('#modal-settings details.adv[data-auto="filled"]');
    return d && !d.open;
  }));
  await page.evaluate(() => { document.getElementById('s-painter-model').value = 'paint-mini'; });
  await page.evaluate(() => window.IR.App.syncAdvPanels());
  await page.waitForTimeout(200);
  ok('adv auto-open filled', await page.evaluate(() => {
    const d = document.querySelector('#modal-settings details.adv[data-auto="filled"]');
    return !!d && d.open && d.querySelector('.adv-tag').textContent === '已单独配置';
  }));
  ok('adv by checkbox rule', await page.evaluate(() => {
    const box = document.getElementById('s-email-enabled');
    const d = document.querySelector('#modal-settings details.adv[data-auto="#s-email-enabled"]');
    if (!box || !d) return false;
    box.checked = false;
    window.IR.App.syncAdvPanels();
    const tag = d.querySelector('.adv-tag');
    const off = tag.textContent === '未启用' && !tag.classList.contains('on');
    box.checked = true;
    window.IR.App.syncAdvPanels();
    const on = d.open && tag.textContent === '已启用' && tag.classList.contains('on');
    return off && on;
  }));
  ok('group switch', await page.evaluate(() => {
    const b = document.querySelector('.set-nav-item[data-group="g-data"]');
    if (b) b.click();
    const sec = document.querySelector('.set-panel[data-group="g-data"]');
    return !!sec && !sec.classList.contains('hidden');
  }));
  await page.click('#btn-close-settings');

  // —— 本对话设置面板：下钻 / 判变 / Esc 层级 ——
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.IR.App.state.story = window.IR.Store.loadStory(window.IR.Store.listStories()[0].id); window.IR.Tree.project(window.IR.App.state.story); });
  await page.evaluate(() => window.IR.App.openStoryPrefs());
  await page.waitForTimeout(400);
  ok('panel mounted', await page.evaluate(() => !!document.querySelector('#story-prefs[data-impl="svelte"]')));
  ok('story-mode present', await page.evaluate(() => !!document.getElementById('s-story-mode')));
  ok('world summary row', await page.evaluate(() => ((document.getElementById('world-summary') || {}).textContent || '').includes('人物')));
  ok('savepoints summary row', await page.evaluate(() => ((document.getElementById('sp-summary') || {}).textContent || '').includes('个存档点')));
  ok('save btn disabled initial', await page.evaluate(() => document.getElementById('btn-save-world').disabled));
  await page.click('#btn-world-edit');
  await page.waitForTimeout(400);
  ok('view=world', await page.evaluate(() => document.querySelector('#story-prefs .prefs-scroll').dataset.view === 'world'));
  ok('focus on title', await page.evaluate(() => document.activeElement && document.activeElement.id === 'prefs-world-title'));
  ok('char cards', await page.evaluate(() => {
    const rows = document.querySelectorAll('#w-characters .char-row.card');
    return rows.length > 0 && document.querySelectorAll('#w-characters .char-row.card input.char-wide').length === rows.length * 3;
  }));
  ok('save bar sticky', await page.evaluate(() => {
    const bar = document.querySelector('#prefs-world .world-save-bar');
    return !!bar && getComputedStyle(bar).position === 'sticky';
  }));
  await page.fill('#w-place', '冒烟镇');
  await page.waitForTimeout(200);
  ok('dirty enables save', await page.evaluate(() => !document.getElementById('btn-save-world').disabled));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok('esc back to list', await page.evaluate(() => document.querySelector('#story-prefs .prefs-scroll').dataset.view === 'list'));
  ok('panel still open + dirty kept', await page.evaluate(() => !document.getElementById('story-prefs').classList.contains('hidden') && !document.getElementById('btn-save-world').disabled));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok('esc closes panel', await page.evaluate(() => document.getElementById('story-prefs').classList.contains('hidden')));
  await page.evaluate(() => window.IR.App.openStoryPrefs());
  await page.waitForTimeout(300);
  ok('reopen resets to list', await page.evaluate(() => document.querySelector('#story-prefs .prefs-scroll').dataset.view === 'list'));
  await page.click('#btn-world-edit');
  await page.waitForTimeout(300);
  await page.click('#btn-save-world');
  await page.waitForTimeout(400);
  ok('save resets dirty', await page.evaluate(() => document.getElementById('btn-save-world').disabled));
  ok('saved value', await page.evaluate(() => window.IR.App.state.story.world.place) === '冒烟镇');
  await page.click('#btn-w-char-add');
  await page.waitForTimeout(150);
  const rows1 = await page.evaluate(() => document.querySelectorAll('#w-characters .char-row.card').length);
  await page.click('#w-characters .char-row.card:last-child .char-del');
  await page.waitForTimeout(150);
  ok('char row add/del', await page.evaluate(() => document.querySelectorAll('#w-characters .char-row.card').length) === rows1 - 1);
});

// ============ ?ui=legacy：0.12.1 旧屏逃生口 ============
await run(browser, 'legacy: ', '&ui=legacy', async (page, ok) => {
  ok('no svelte marker', await page.evaluate(() => !document.getElementById('modal-settings').dataset.impl));
  ok('old settings DOM kept', await page.evaluate(() => !!document.querySelector('#modal-settings .modal-body fieldset')));
  await page.evaluate(() => window.IR.App.openSettings());
  await page.waitForTimeout(400);
  ok('legend regroup works', await page.evaluate(() => document.querySelectorAll('#set-panels .set-panel').length) === 6);
  ok('group switch', await page.evaluate(() => {
    const b = document.querySelector('.set-nav-item[data-group="g-look"]');
    if (b) b.click();
    const sec = document.querySelector('.set-panel[data-group="g-look"]');
    return !!sec && !sec.classList.contains('hidden');
  }));
  await page.evaluate(() => document.getElementById('modal-settings').classList.add('hidden'));
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.IR.App.state.story = window.IR.Store.loadStory(window.IR.Store.listStories()[0].id); window.IR.Tree.project(window.IR.App.state.story); });
  await page.evaluate(() => window.IR.App.openStoryPrefs());
  await page.waitForTimeout(400);
  ok('panel no marker', await page.evaluate(() => !document.getElementById('story-prefs').dataset.impl));
  ok('table char rows', await page.evaluate(() => {
    const rows = document.querySelectorAll('#w-characters .char-row');
    return rows.length > 0 && !document.querySelector('#w-characters .char-row.card') && !!document.querySelector('#w-characters .char-head');
  }));
  ok('no StoryPanel bridge', await page.evaluate(() => !window.IR.StoryPanel));
  ok('save btn not disabled-by-default', await page.evaluate(() => !document.getElementById('btn-save-world').disabled));
  ok('无新视图控件', await page.evaluate(() => !document.getElementById('btn-world-edit') && !document.getElementById('sp-summary')));
});

await browser.close();

let fail = 0;
for (const r of out) { if (!r.pass) fail++; console.log((r.pass ? 'ok  ' : 'FAIL') + ' ' + r.name + (r.detail ? ' — ' + r.detail : '')); }
console.log(fail ? ('FAILURES: ' + fail) : 'prefs-smoke：全部通过');
process.exit(fail ? 1 : 0);
