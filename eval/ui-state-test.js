#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 界面状态门禁
 *
 * 不开浏览器、不联网：
 *   1. 确认弹窗排队（src/core/confirmQueue.ts）——并发 irConfirm 不丢 Promise：
 *      只有队头显示、收掉队头后下一条就地接上、队列空了才算关窗；
 *   2. 静态回归 ：/src 里不再有「直接给 #modal-* 加 hidden」的关窗写法——
 *      绕开 closeModal 会让弹窗栈残留、aria-hidden 不设、焦点不还原；
 *   3. 静态回归 ：布局写回之后走 commitUi() 落盘（命中 story.prefs.ui 的键只
 *      persistSettings 等于没存），退出沉浸回到进入前的布局而不是一律 auto；
 *   4. 静态回归 ：覆盖层背景 inert + aria-hidden、聊天图与缩略图
 *      可键盘触发、本对话设置面板的滚动快照不反成 $effect 依赖、首帧 data-motion 先于 CSS；
 *   5. 静态回归 ：聊天流按条目 key 做 keyed 更新（不再 {#key} 整条销毁重建），
 *      每个条目模型带 readmodel 发的稳定 key，流式空壳回填幂等；
 *   6. 静态回归 ：弹窗外壳（头 / 身 / 脚 + 关闭）全站只有 ModalCard 一份，设置页复用，
 *      外壳不再是一个 Svelte 组件（modalHost 直接建 display:contents 层容器）；
 *   7. 静态回归 ：屏幕挂载外壳（取容器 → 清空 → data-impl → mount）只有
 *      src/screens/_mount.js 一份，7 个 index.js 只声明「容器 → 组件」，
 *      挂载 id 与 index.html 里的容器逐个对账；
 *   8. 静态回归 ：首页 ASCII 字符画只有 src/screens/home/art.js 一份——
 *      组件直接 import，index.html 的无 JS 兜底由构建期从同一个源注入。
 *
 * 用法：node eval/ui-state-test.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { createConfirmQueue } = require(path.join(ROOT, 'src', 'core', 'confirmQueue.ts'));

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed++; }
}
function eq(a, b, msg) {
  ok(a === b, msg + (a === b ? '' : '（实际 ' + JSON.stringify(a) + ' ≠ 期望 ' + JSON.stringify(b) + '）'));
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
// 去掉注释再扫：注释里会提到旧实现的名字（「以前是单槽 cfResolve」），不能算代码
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
// 取某个函数的源码段（function NAME( 起，到下一个顶层 function）
function bodyOf(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const j = src.indexOf('\n  function ', i + 1);
  return src.slice(i, j < 0 ? i + 2000 : j);
}

async function main() {
  /* ---------------- 1. 确认弹窗排队 ---------------- */
  console.log('[1] 确认弹窗排队（src/core/confirmQueue.ts）');
  {
    const q = createConfirmQueue();
    const shown = [];      // 界面实际显示过的内容
    const answered = [];   // 落地顺序
    const settle = { A: null, B: null, C: null };

    // 模拟 core.js：入队 → 只有队头显示；closeConfirm 收队头 → 有下一条就地接上
    function ask(msg) {
      return new Promise(resolve => {
        const pos = q.push({ message: msg, opts: {}, resolve: (v) => { answered.push(msg + '=' + JSON.stringify(v)); resolve(v); } });
        if (pos === 1) shown.push(msg);
      });
    }
    function answer(v) {
      const job = q.shift();
      const next = q.head();
      if (next) shown.push(next.message);
      if (job) job.resolve(v);
    }

    eq(q.size(), 0, '空队列 size() = 0');
    eq(q.head(), null, '空队列 head() = null');
    eq(q.shift(), null, '空队列 shift() = null');

    const pa = ask('A');
    pa.then(v => { settle.A = v; });
    const pb = ask('B');
    pb.then(v => { settle.B = v; });
    const pc = ask('C');
    pc.then(v => { settle.C = v; });

    eq(q.size(), 3, '三条并发确认都排上队（谁也不覆盖谁）');
    eq(JSON.stringify(shown), JSON.stringify(['A']), '只有队头 A 显示在弹窗里');

    answer(true);
    eq(JSON.stringify(shown), JSON.stringify(['A', 'B']), '收掉 A 之后 B 就地接上（弹窗不关）');
    eq(q.size(), 2, '队列剩 B / C');
    await Promise.resolve();
    eq(settle.A, true, 'A 的 Promise 落地（旧实现会被 B 覆盖，永不 resolve）');
    eq(settle.B, null, 'B 还没轮到自己作答前保持挂起（不是被丢弃）');

    answer(null);   // 用户取消 B
    eq(JSON.stringify(shown), JSON.stringify(['A', 'B', 'C']), '取消 B 之后 C 接着显示');
    await Promise.resolve();
    eq(settle.B, null, 'B 拿到 null（取消 / 关闭一律 null）');
    eq(answered[1], 'B=null', 'B 的落地值是 null');

    answer('手打的值');
    await Promise.resolve();
    eq(settle.C, '手打的值', 'C 拿到输入框里的字符串');
    eq(q.size(), 0, '三条都收完，队列清空');
    eq(q.head(), null, '清空后 head() = null（下一次调用重新成为队头）');

    // 静态回归：core.js 必须用这套队列，不能再回到单槽 resolve
    const core = read('src/app/core.js');
    const coreCode = stripComments(core);
    ok(/createConfirmQueue\s*\(/.test(coreCode), 'core.js 用排队实现（不是单槽 resolve）');
    ok(!/\bcfResolve\b/.test(coreCode), 'core.js 里不再有单槽 cfResolve');
    ok(/cfQueue\.push\(/.test(bodyOf(core, 'irConfirm')), 'irConfirm 每次调用都入队');
    const closeBody = bodyOf(core, 'closeConfirm');
    ok(closeBody.indexOf('cfQueue.shift()') >= 0 && closeBody.indexOf('cfQueue.head()') >= 0,
      'closeConfirm 只收队头并接上下一条');
  }

  /* ---------------- 2. 弹窗关窗收口 ---------------- */
  console.log('[2] 弹窗只经 closeModal 关');
  {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(js|ts|svelte)$/.test(e.name)) continue;
        const text = fs.readFileSync(p, 'utf8');
        text.split('\n').forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;   // 注释不算
          if (/modal-[a-z-]+/.test(line) && /classList\.(add|toggle|remove)\(\s*['"]hidden['"]\s*\)/.test(line)) {
            hits.push(path.relative(ROOT, p) + ':' + (i + 1) + '  ' + t);
          }
        });
      }
    };
    walk(path.join(ROOT, 'src'));
    ok(hits.length === 0, '没有直接给 #modal-* 加 hidden 的关窗写法' + (hits.length ? '：' + hits.join(' | ') : ''));
    const main = read('src/app/main.js');
    ok(main.indexOf("$('#modal-wizard').classList") < 0 && main.indexOf("$('#modal-export').classList") < 0,
      'main.js 不再抢向导 / 导出弹窗的关闭按钮（交给组件里的 closeModal）');
  }

  /* ---------------- 3. 布局落盘与退出沉浸 ---------------- */
  console.log('[3] 布局写回落盘 / 退出沉浸还原');
  {
    const layout = read('src/app/layout.js');
    ok(/(?:A\.)?saveAll\(\)/.test(bodyOf(layout, 'commitUi')), 'commitUi() 有故事时走 saveAll（故事 prefs 也落盘）');
    ok(/persistSettings\(\)/.test(bodyOf(layout, 'commitUi')), 'commitUi() 无故事时仍有全局设置可存');
    ok(/commitUi\(\)/.test(bodyOf(layout, 'setLayout')), 'setLayout 改布局后落盘');
    ok(/commitUi\(\)/.test(bodyOf(layout, 'toggleStagePanel')), '收起 / 展开舞台后落盘');
    ok(/lastUiLayout/.test(bodyOf(layout, 'exitImmersive')), '退出沉浸回到进入前的布局（不是一律 auto）');
    ok(!/persistSettings\(\)/.test(bodyOf(layout, 'setLayout')), 'setLayout 不再只存全局设置');
    const stopAt = layout.indexOf('const stop = () =>');
    ok(stopAt >= 0 && /commitUi\(\)/.test(layout.slice(stopAt, stopAt + 400)),
      '拖动分隔条松手后落盘（splitRatio 可能写进故事）');
  }

  /* ---------------- 4. 覆盖层背景 / 键盘可达 / 首帧动效 ---------------- */
  console.log('[4] 背景惰性化 / 键盘可达 / 首帧动效');
  {
    /* ：背景 inert + aria-hidden，且调用点在焦点进对话框之后 / 撤在还焦点之前 */
    const backdrop = stripComments(read('src/ui/backdrop.js'));
    ok(/setAttribute\(\s*'inert'/.test(backdrop), 'backdrop.js 给背景加 inert');
    ok(/aria-hidden/.test(backdrop) && /setAttribute\(\s*'aria-hidden'/.test(backdrop),
      'backdrop.js 同时设 aria-hidden（老浏览器没有 inert 时的兜底）');
    ok(/backdropEls/.test(backdrop) && /'app-modals'/.test(backdrop), '弹窗层自己不算背景');

    const host = stripComments(read('src/ui/modalHost.js'));
    ok(/setModalBackdrop\(true\)/.test(host), 'openModal 惰性化背景');
    ok(/setModalBackdrop\(false\)/.test(host), '关掉最后一层时撤销');
    // 顺序：焦点先进行（armTrap），再加 aria-hidden；关闭时先撤 inert，再 disarmTrap / restoreFocus
    const openBody = host.slice(host.indexOf('export function openModal('), host.indexOf('export function closeModal('));
    const armAt = openBody.indexOf('armTrap(id');
    ok(armAt >= 0 && openBody.indexOf('setModalBackdrop(true)') > armAt,
      'openModal 先移焦点、再惰性化背景（否则 Chrome 会拒绝 aria-hidden）');
    const closeBody = host.slice(host.indexOf('export function closeModal('), host.indexOf('export function dismissModal('));
    const clearAt = closeBody.indexOf('setModalBackdrop(false)');
    ok(clearAt >= 0 && clearAt < closeBody.indexOf('disarmTrap(id)'),
      'closeModal 先撤 inert、再释放焦点陷阱（inert 子树不可聚焦）');

    const branch = stripComments(read('src/app/branch.js'));
    const openBranchBody = branch.slice(branch.indexOf('function openBranch('), branch.indexOf('function closeBranch('));
    ok(openBranchBody.indexOf('setBranchBackdrop(true)') > openBranchBody.indexOf('svg.focus'),
      'openBranch 在焦点进分支页之后惰性化阅读页');
    const closeBranchAt = branch.indexOf('function closeBranch(');
    const closeBranchBody = branch.slice(closeBranchAt, branch.indexOf('\n  }', closeBranchAt));
    ok(closeBranchBody.indexOf('setBranchBackdrop(false)') >= 0 &&
       closeBranchBody.indexOf('setBranchBackdrop(false)') < closeBranchBody.indexOf('branchTrapRelease()'),
      'closeBranch 先撤 inert、再还焦点');

    /* ：聊天图 / 缩略图带 onclick 的同时必须可聚焦、可键盘触发 */
    const imgs = [];
    for (const rel of ['src/screens/read/ChatBubble.svelte', 'src/screens/read/ReadScreen.svelte']) {
      // 到自闭合的 /> 为止（属性值里有 => 箭头，不能用 [^>]* 截断）
      for (const m of read(rel).matchAll(/<img\b[\s\S]*?\/>/g)) {
        if (!/\bonclick=/.test(m[0])) continue;
        const tag = m[0];
        const bad = !/role="button"/.test(tag) || !/tabindex="0"/.test(tag) || !/onkeydown=/.test(tag);
        if (bad) imgs.push(rel + ' → ' + tag.slice(0, 80));
      }
    }
    ok(imgs.length === 0, '聊天图 / 缩略图：role + tabindex + onkeydown 齐全' + (imgs.length ? '：' + imgs.join(' | ') : ''));
    const a11y = stripComments(read('src/ui/a11y.js'));
    ok(/Enter/.test(a11y) && /' '/.test(a11y) && /preventDefault\(\)/.test(a11y),
      'a11y.js 的 onActivate 认 Enter / Space 并拦掉 Space 的滚动');

    /* ：滚动快照是普通变量，$effect 不再把它读成依赖 */
    const panelJs = stripComments(read('src/screens/storyPrefs/panel.svelte.js'));
    ok(/let listScroll = 0;/.test(panelJs) && !/\$state\(\{[^}]*listScroll/.test(panelJs),
      '滚动位置是普通模块变量（不是 $state）');
    ok(/export function listScrollTop\(\)/.test(panelJs), '通过函数读取，调用方不建立依赖');
    const panelSvelte = stripComments(read('src/screens/storyPrefs/StoryPrefsPanel.svelte'));
    ok(panelSvelte.indexOf('panel.listScroll') < 0 && /listScrollTop\(\)/.test(panelSvelte),
      '$effect 读 listScrollTop()，不再读 panel.listScroll');

    /* ：head 内联脚本在样式生效前写 data-motion，档位有 localStorage 镜像 */
    const html = read('index.html');
    const head = html.slice(0, html.indexOf('</head>'));
    const bootAt = head.indexOf("setAttribute('data-motion'");
    ok(bootAt >= 0, 'index.html 的 <head> 有内联脚本写 html[data-motion]');
    ok(bootAt >= 0 && bootAt < head.indexOf('css/tokens.css'), '内联脚本在样式表之前（首帧就是对的）');
    ok(/prefers-reduced-motion/.test(head) && /ir:motion/.test(head),
      '内联脚本认系统偏好，并读 store 落盘的 ir:motion 镜像');
    const storeSrc = stripComments(read('src/core/store.ts'));
    ok(/MOTION_MIRROR/.test(storeSrc) && /setItem\(MOTION_MIRROR/.test(storeSrc),
      'store 在读写设置时同步 ir:motion 镜像');
    ok(/mirrorMotion\(s\)/.test(bodyOf(storeSrc, 'loadSettings')) &&
       /mirrorMotion\(s\)/.test(bodyOf(storeSrc, 'saveSettings')),
      'loadSettings / saveSettings 都刷新镜像');
  }

  /* ---------------- 5. 聊天流 keyed 更新 ---------------- */
  console.log('[5] 聊天流 keyed 更新，不整条重建');
  {
    const readScreen = stripComments(read('src/screens/read/ReadScreen.svelte'));
    ok(!/\{#key/.test(readScreen), 'ReadScreen 不再用 {#key} 整体重建消息流');
    ok(/\{#each read\.chat\.entries as \w+ \(\w+\.key\)\}/.test(readScreen),
      '消息流 each 按条目 key 做 keyed 更新');
    const readJs = stripComments(read('src/screens/read/read.svelte.js'));
    ok(readJs.indexOf('chatSeq') < 0, 'setChat 不再维护整条重建计数（chatSeq 已删）');
    const model = stripComments(read('src/app/readmodel.js'));
    ok(/const entryKeys = new WeakMap\(\)/.test(model) && /function entryKey\(/.test(model),
      'readmodel 用 WeakMap 按 log 条目对象身份发稳定 key（project 引用共享 → 跨重建不变）');
    ok(/m\.key = entryKey\(e\)/.test(model), '每个条目模型都带 key');
    const render = stripComments(read('src/app/render.js'));
    ok(/firstChild/.test(bodyOf(render, 'fillLiveDom')),
      'fillLiveDom 只回填空壳（幂等，不叠加「生成中…」/ 覆盖在途流式内容）');
    ok(/replaceChildren/.test(bodyOf(render, 'reasonLiveInto')),
      'reasonLiveInto 用 replaceChildren（幂等）');
  }

  /* ---------------- 6. 弹窗外壳只有一份 ---------------- */
  console.log('[6] 弹窗外壳只有一份');
  {
    /* 手写的 .modal-card 只准出现在 ModalCard.svelte：别处再写一次就是又长出第四份外壳 */
    const dup = [];
    const walkSvelte = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walkSvelte(p); continue; }
        if (!e.name.endsWith('.svelte')) continue;
        if (/class="modal-card"/.test(stripComments(fs.readFileSync(p, 'utf8')))) {
          dup.push(path.relative(ROOT, p).split(path.sep).join('/'));
        }
      }
    };
    walkSvelte(path.join(ROOT, 'src'));
    eq(dup.join(' '), 'src/ui/ModalCard.svelte', '手写 .modal-card 的组件只剩 ModalCard 一份');

    const card = stripComments(read('src/ui/ModalCard.svelte'));
    ok(/<h2 id=\{titleId\}>/.test(card) && /class="modal-body"/.test(card) && /class="modal-foot"/.test(card),
      'ModalCard 出齐头 / 身 / 脚三块');
    ok(/class="modal-card" class:narrow/.test(card) && /IconButton/.test(card) && /closeId/.test(card),
      'ModalCard 带窄版开关 / 关闭钮 / 调用方传进来的 id');

    const modalDir = path.join(ROOT, 'src', 'screens', 'modal');
    // 弹窗清单以挂载表为真源（该目录下还有 CharRows / Textarea 这类内容片段，不算外壳使用者）
    const modalComps = [...read('src/screens/modal/index.js').matchAll(/from '\.\/(\w+Modal)\.svelte'/g)].map((m) => m[1]);
    eq(modalComps.length, 10, '10 个弹窗组件都在挂载表里');
    const notUsing = modalComps.filter((n) => read('src/screens/modal/' + n + '.svelte').indexOf("from '../../ui/ModalCard.svelte'") < 0);
    ok(notUsing.length === 0, '10 个弹窗都用同一份 ModalCard' + (notUsing.length ? '：' + notUsing.join('、') : ''));
    ok(!fs.existsSync(path.join(modalDir, 'Card.svelte')), '旧骨架 src/screens/modal/Card.svelte 已删');

    const settings = stripComments(read('src/screens/settings/SettingsScreen.svelte'));
    ok(/<ModalCard\b/.test(settings) && settings.indexOf('class="modal-head"') < 0,
      '设置页复用 ModalCard，不再手写第三份头 / 壳');
    ok(settings.indexOf('btn-close-settings') >= 0 && settings.indexOf('btn-save-settings') >= 0,
      '设置页的关闭 / 保存 id 仍在源码里（界面层按 id 绑定）');

    ok(!fs.existsSync(path.join(ROOT, 'src', 'ui', 'Modal.svelte')),
      'src/ui/Modal.svelte 已删（非 shell 分支 + 第二份卡片 CSS）');
    const hostJs = stripComments(read('src/ui/modalHost.js'));
    ok(/createElement\('div'\)/.test(hostJs) && hostJs.indexOf("from 'svelte'") < 0,
      'modalHost 直接建壳层 div，不再 mount 组件');
  }

  /* ---------------- 7. 屏幕挂载外壳只有一份 ---------------- */
  console.log('[7] 屏幕挂载外壳只有一份');
  {
    const shell = stripComments(read('src/screens/_mount.js'));
    ok(/export function mountScreen\(id, Component\)/.test(shell), '_mount.js 导出 mountScreen(id, Component)');
    ok(/document\.getElementById\(id\)/.test(shell), '取容器的写法收在 _mount.js');
    ok(/if \(!host\) return null;/.test(shell), '容器不存在时静默跳过（不整页在 import 期抛错）');
    ok(/host\.dataset\.impl = 'svelte'/.test(shell), '容器打 data-impl="svelte"（验收脚本的观测面）');
    const clearAt = shell.indexOf('host.replaceChildren()');
    const mountAt = shell.indexOf('mount(Component, { target: host })');
    ok(clearAt >= 0 && mountAt > clearAt, '先清空容器再 mount（旧 DOM 不残留）');

    // 每个屏幕目录的 index.js 都必须走这一份外壳：自己 mount / 自己清空 = 又长出一份
    const screensDir = path.join(ROOT, 'src', 'screens');
    const dirs = fs.readdirSync(screensDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(screensDir, e.name, 'index.js')))
      .map((e) => e.name).sort();
    eq(dirs.join(' '), 'branch home modal read settings shelf storyPrefs', '7 个屏幕都有 index.js 挂载壳');

    const ids = [];
    for (const d of dirs) {
      const rel = 'src/screens/' + d + '/index.js';
      const code = stripComments(read(rel));
      ok(/import \{ mountScreen \} from '\.\.\/_mount\.js';/.test(code), rel + ' 用共用外壳');
      ok(code.indexOf('mountScreen(') >= 0, rel + ' 调用了 mountScreen');
      ok(code.indexOf("from 'svelte'") < 0, rel + ' 不再直接 import svelte 的 mount');
      ok(!/\.replaceChildren\(|dataset\.impl|getElementById\(/.test(code), rel + ' 不再自己写挂载三步');
      for (const m of code.matchAll(/mountScreen\('([\w-]+)'/g)) ids.push(m[1]);
      for (const m of code.matchAll(/^\s*\['([\w-]+)', /gm)) ids.push(m[1]);   // 弹窗挂载表
    }
    eq(ids.length, 16, '挂载点共 16 个（6 屏 + 10 个弹窗）');
    eq(new Set(ids).size, ids.length, '挂载点没有重复 id');
    const html = read('index.html');
    const missing = ids.filter((id) => html.indexOf('id="' + id + '"') < 0);
    ok(missing.length === 0, '每个挂载点都在 index.html 里' + (missing.length ? '：' + missing.join('、') : ''));
  }

  /* ---------------- 8. 首页字符画只有一份 ---------------- */
  console.log('[8] 首页字符画只有一份（组件与无 JS 兜底同源）');
  {
    const NEEDLE = '.-~~~~-.';
    const artFile = 'src/screens/home/art.js';
    ok(read(artFile).indexOf(NEEDLE) >= 0, '字符画真源是 src/screens/home/art.js');

    // 全仓只准这一份：index.html 兜底 / 组件常量 / 构建脚本里再抄一次就是第二真源
    const owners = [];
    const walkArt = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walkArt(p); continue; }
        if (!/\.(js|ts|svelte|html|mjs)$/.test(e.name)) continue;
        if (fs.readFileSync(p, 'utf8').indexOf(NEEDLE) >= 0) owners.push(path.relative(ROOT, p).split(path.sep).join('/'));
      }
    };
    walkArt(path.join(ROOT, 'src'));
    for (const f of ['index.html', 'vite.config.mjs']) {
      if (read(f).indexOf(NEEDLE) >= 0) owners.push(f);
    }
    eq(owners.join(' '), artFile, '字符画只在 art.js 里写一次');

    const home = read('src/screens/home/HomeScreen.svelte');
    ok(home.indexOf("from './art.js'") >= 0 && /HOME_ART\.map\(/.test(home),
      '首页组件从 art.js 取字符画（不再自带 ART 常量）');

    ok(read('index.html').indexOf('<!--IR_HOME_ART-->') >= 0, 'index.html 的无 JS 兜底只留占位');

    const vite = stripComments(read('vite.config.mjs'));
    ok(/import \{ HOME_ART \} from '\.\/src\/screens\/home\/art\.js';/.test(vite),
      '构建配置从同一个源取字符画');
    ok(/replaceAll\('<!--IR_HOME_ART-->'/.test(vite), 'transformIndexHtml 把占位换成字符画');
    eq((vite.match(/includes\('<!--IR_HOME_ART-->'\)/g) || []).length, 2,
      '两种产物都有「占位没被替换就报错」的自检');
  }

  if (failed) {
    console.error('ui-state-test：' + failed + ' 项未通过');
    process.exit(1);
  }
  console.log('ui-state-test：全部通过');
}

main().catch((e) => {
  console.error('ui-state-test：异常 ' + (e && e.stack || e));
  process.exit(1);
});
