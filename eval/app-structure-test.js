#!/usr/bin/env node
// eval/app-structure-test.js —— 拆分结构门禁（阶段 6 起入口 = src/main.js）
//   1. 唯一入口 src/main.js 中 src/app/*.js 的出现顺序：core.js 在所有其他 app 模块之前，
//      main.js（组合根）在最后；磁盘上的每个 src/app/*.js 都被入口引用，反之亦然。
//   2. 每个 src/app/*.js 行数 ≤ 800；main.js ≤ 600。
//   3. 各模块 A.reg({ … }) 的键名在全局范围内不重复（静态扫描）。
//   4. 除 core.js 外，任何模块的顶层解构 const { … } = A 只允许取 core.js 的导出
//      （白名单 = core.js 的 A.reg 键集合；不得解构别的 app 模块函数）。
//   5. 每个 A.xxx 引用都必须已注册（防运行时 A.xxx is not a function）。
//   6. 每个文件 node --check 语法通过。
//   7. 高频入口（renderChat / saveAll / toast）必须是 core.js 的显式命名导出：
//      调用方不再写 A.<入口>、不再从 A 解构；core.js 不许静态 import app 模块（否则成环）。
//      showScreen 例外：它在 src/ui/navigation.js 本来就是真实命名导出。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'src', 'app');
const ENTRY = 'src/main.js';
let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); fails++; }
};

const mainJs = 'app/main.js';
const diskMods = fs.readdirSync(APP_DIR).filter(f => f.endsWith('.js')).sort().map(f => 'app/' + f);

// ---------- 1. 入口引用顺序与双向一致 ----------
console.log('[1] 唯一入口（src/main.js）引用顺序与磁盘一致性');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok(html.includes('src/main.js'), 'index.html 引用了 src/main.js（唯一入口）');
ok(!html.includes('src/legacy.js'), 'index.html 不再引用 legacy 入口');
const entry = fs.readFileSync(path.join(ROOT, ENTRY), 'utf8');
const cited = [...entry.matchAll(/import '\.\/(app\/[^']+\.js)';/g)].map(m => m[1]);
const citedMods = cited.filter(p => p !== mainJs);
ok(cited.includes(mainJs), '入口引用了 app/main.js');
ok(cited[cited.length - 1] === mainJs, 'app/main.js 在所有 app 模块之后加载（组合根最后）');
const coreIdx = citedMods.indexOf('app/core.js');
ok(coreIdx === 0, 'app/core.js 是第一个加载的 app 模块');
ok(citedMods.every((p, i) => i <= coreIdx || p !== 'app/core.js'), 'core.js 不会出现在其他模块之后');
const missing = diskMods.filter(p => p !== mainJs && !citedMods.includes(p));
const extra = citedMods.filter(p => !diskMods.includes(p));
ok(!missing.length, '磁盘上的模块都被入口引用' + (missing.length ? '（缺：' + missing.join(', ') + '）' : ''));
ok(!extra.length, '入口引用的模块都在磁盘上' + (extra.length ? '（多：' + extra.join(', ') + '）' : ''));

// ---------- 2. 行数上限 ----------
console.log('[2] 行数上限（src/app/*.js ≤ 800，main.js ≤ 600）');
const lineCount = p => fs.readFileSync(path.join(ROOT, 'src', p), 'utf8').split('\n').length;
for (const p of diskMods) {
  if (p === mainJs) continue;
  ok(lineCount(p) <= 800, 'src/' + p + ' = ' + lineCount(p) + ' 行 ≤ 800');
}
ok(lineCount(mainJs) <= 600, 'src/' + mainJs + ' = ' + lineCount(mainJs) + ' 行 ≤ 600');

// ---------- 3. A.reg 键全局唯一 ----------
console.log('[3] A.reg 键名全局唯一');
const regKeys = new Map(); // name -> file
for (const p of diskMods) {
  const text = fs.readFileSync(path.join(ROOT, 'src', p), 'utf8');
  for (const m of text.matchAll(/A\.reg\(\{([\s\S]*?)\}\)/g)) {
    // 只取顶层标识符（支持 { a, b: c, d } 简写与重命名；跳过注释）
    const body = m[1].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const piece of body.split(',')) {
      const key = (piece.trim().match(/^([A-Za-z_$][\w$]*)/) || [])[1];
      if (!key) continue;
      if (regKeys.has(key)) {
        ok(false, 'A.reg 键重复：' + key + '（' + regKeys.get(key) + ' 与 ' + p + '）');
      } else regKeys.set(key, p);
    }
  }
}
ok(regKeys.size > 0, '共扫描到 ' + regKeys.size + ' 个 A.reg 键');
{
  const names = [...regKeys.keys()];
  ok(new Set(names).size === names.length, 'A.reg 键无重复');
}

// ---------- 4. 顶层解构白名单（只能取 core.js 导出） ----------
console.log('[4] 顶层解构白名单');
const coreText = fs.readFileSync(path.join(ROOT, 'src', 'app', 'core.js'), 'utf8');
const coreExports = new Set();
{
  const m = coreText.match(/A\.reg\(\{([\s\S]*?)\}\)/);
  if (m) {
    for (const piece of m[1].replace(/\/\/[^\n]*/g, '').split(',')) {
      const key = (piece.trim().match(/^([A-Za-z_$][\w$]*)/) || [])[1];
      if (key) coreExports.add(key);
    }
  }
}
ok(coreExports.size > 0, 'core.js 导出 ' + coreExports.size + ' 个名字（白名单真源）');
for (const p of diskMods.filter(p => p !== 'app/core.js')) {
  const text = fs.readFileSync(path.join(ROOT, 'src', p), 'utf8');
  // 只看顶层（缩进 2 空格）的 const { … } = A;
  for (const m of text.matchAll(/^  const \{([^}]*)\} = A;/gm)) {
    for (const piece of m[1].split(',')) {
      const name = (piece.trim().match(/^([A-Za-z_$][\w$]*)/) || [])[1];
      if (!name) continue;
      ok(coreExports.has(name), 'src/' + p + ' 顶层解构的 ' + name + ' 是 core 导出');
    }
  }
}

// ---------- 5. A.xxx 引用必须已注册（防运行时 A.xxx is not a function） ----------
console.log('[5] A.xxx 引用闭合性');
{
  const infra = new Set(['state', 'reg']);
  for (const p of diskMods) {
    const text = fs.readFileSync(path.join(ROOT, 'src', p), 'utf8')
      .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
    for (const m of text.matchAll(/(^|[^.\w$])A\.([A-Za-z_$][\w$]*)/g)) {
      const name = m[2];
      ok(regKeys.has(name) || infra.has(name), 'src/' + p + ' 的 A.' + name + ' 已注册');
    }
  }
}

// ---------- 6. node --check ----------
console.log('[6] node --check 语法');
for (const p of diskMods) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'src', p)], { stdio: 'pipe' });
    ok(true, 'src/' + p + ' 语法通过');
  } catch (e) {
    ok(false, 'src/' + p + ' 语法失败：' + String(e.stderr || e.message).slice(0, 300));
  }
}

// ---------- 7. 高频入口的显式命名导出（IDE 可跳转） ----------
console.log('[7] 高频入口显式导出（renderChat / saveAll / toast）');
{
  const ENTRIES = ['renderChat', 'saveAll', 'toast'];
  const coreSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'core.js'), 'utf8');
  const coreCode = coreSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // core.js 的导出面：export { … } + export function …
  const coreOut = new Set();
  for (const m of coreCode.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const piece of m[1].split(',')) {
      const name = (piece.trim().match(/^([A-Za-z_$][\w$]*)/) || [])[1];
      if (name) coreOut.add(name);
    }
  }
  for (const m of coreCode.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) coreOut.add(m[1]);
  for (const n of ENTRIES) ok(coreOut.has(n), 'core.js 显式导出 ' + n);

  // 转接必须真的接到 A；core 不静态 import app 模块（反向 import 会成环 → TDZ）
  ok(!/from\s*'\.\/[^']+\.js'/.test(coreCode), 'core.js 不静态 import 任何 src/app 模块（避免 ESM 环）');
  ok(/return\s+A\.renderChat\s*\(\s*\)/.test(coreCode), 'core.js 的 renderChat 转接到 A.renderChat');
  ok(coreSrc.includes('src/app/render.js'), 'core.js 的转接注释写明实现文件（Ctrl+Click 后的第二跳）');

  // 实现仍在原模块：render.js 定义并注册 renderChat；toast / saveAll 在 core.js 定义
  const renderSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'render.js'), 'utf8');
  ok(/function\s+renderChat\s*\(/.test(renderSrc), 'src/app/render.js 仍是 renderChat 的定义处');
  ok(regKeys.get('renderChat') === 'app/render.js', 'renderChat 仍由 src/app/render.js 注册进 A');
  ok(/function\s+toast\s*\(/.test(coreCode) && /function\s+saveAll\s*\(/.test(coreCode), 'toast / saveAll 的定义仍在 core.js');

  // 第四个高频入口 showScreen：本来就是真实命名导出，不需要 core 再开一个死别名
  const navSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'navigation.js'), 'utf8');
  ok(/export\s+function\s+showScreen\s*\(/.test(navSrc),
    'showScreen 在 src/ui/navigation.js 是真实命名导出（Nav.showScreen 可直接跳转）');

  // 调用侧：不许再写 A.<入口> / 不许把入口放回 `= A` 解构；用它的模块必须从 core 命名 import
  const importedBy = { renderChat: new Set(), saveAll: new Set(), toast: new Set() };
  const violations = [];
  for (const p of diskMods.filter(x => x !== 'app/core.js')) {
    const text = fs.readFileSync(path.join(ROOT, 'src', p), 'utf8');
    for (const n of ENTRIES) {
      if (new RegExp('\\bA\\.' + n + '\\b').test(text)) violations.push('src/' + p + ' 仍写 A.' + n);
    }
    for (const m of text.matchAll(/^  const \{([^}]*)\} = A;/gm)) {
      for (const piece of m[1].split(',')) {
        const name = (piece.trim().match(/^([A-Za-z_$][\w$]*)/) || [])[1];
        if (ENTRIES.includes(name)) violations.push('src/' + p + ' 仍从 A 解构 ' + name);
      }
    }
    const imp = text.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/core\.js'/);
    if (imp) {
      for (const piece of imp[1].split(',')) {
        const name = (piece.trim().match(/(?:\bas\s+)?([A-Za-z_$][\w$]*)$/) || [])[1];
        if (name && ENTRIES.includes(name)) importedBy[name].add(p);
      }
    }
  }
  ok(violations.length === 0, '没有模块再写 A.<入口> 或从 A 解构它们'
    + (violations.length ? '：' + violations.join(' | ') : ''));
  // 门槛：新增条目必须被 ≥10 个 app 模块当第一跳 import，否则它不够高频，别开死别名
  for (const n of ENTRIES) {
    ok(importedBy[n].size >= 10, n + ' 被 ' + importedBy[n].size + ' 个 app 模块命名 import（≥10）');
  }
}

if (fails) {
  console.error('app-structure-test：' + fails + ' 项未通过');
  process.exit(1);
}
console.log('app-structure-test：全部通过');
