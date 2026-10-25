#!/usr/bin/env node
// eval/app-structure-test.js —— 拆分结构门禁（任务书 §7）
//   1. legacy 入口（src/legacy.js，阶段 1 起 index.html 只引这一个模块）中 js/app/*.js 的
//      出现顺序：core.js 在所有其他 app 模块之前，js/app.js 在最后；
//      磁盘上的每个 js/app/*.js 都被 legacy 入口引用，反之亦然。
//   2. 每个 js/app/*.js 行数 ≤ 800；js/app.js ≤ 600。
//   3. 各模块 A.reg({ … }) 的键名在全局范围内不重复（静态扫描）。
//   4. 除 core.js 外，任何模块的顶层解构 const { … } = A 只允许取 core.js 的导出
//      （白名单 = core.js 的 A.reg 键集合；不得解构别的 app 模块函数）。
//   5. 每个文件 node --check 语法通过。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'js', 'app');
let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); fails++; }
};

const appJs = 'js/app.js';
const diskMods = fs.readdirSync(APP_DIR).filter(f => f.endsWith('.js')).sort().map(f => 'js/app/' + f);

// ---------- 1. legacy 入口引用顺序与双向一致 ----------
console.log('[1] legacy 入口（src/legacy.js）引用顺序与磁盘一致性');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok(html.includes('src/legacy.js'), 'index.html 引用了 src/legacy.js（legacy 入口唯一）');
const legacy = fs.readFileSync(path.join(ROOT, 'src', 'legacy.js'), 'utf8');
const cited = [...legacy.matchAll(/import '\.\.\/(js\/app(?:\/[^']+)?\.js)';/g)].map(m => m[1]);
const citedMods = cited.filter(p => p !== appJs);
ok(cited.includes(appJs), 'legacy 入口引用了 js/app.js');
ok(cited[cited.length - 1] === appJs, 'js/app.js 在所有 js/app/*.js 之后加载（组合根最后）');
const coreIdx = citedMods.indexOf('js/app/core.js');
ok(coreIdx === 0, 'js/app/core.js 是第一个加载的 app 模块');
ok(citedMods.every((p, i) => i <= coreIdx || p !== 'js/app/core.js'), 'core.js 不会出现在其他模块之后');
const missing = diskMods.filter(p => !citedMods.includes(p));
const extra = citedMods.filter(p => !diskMods.includes(p));
ok(!missing.length, '磁盘上的模块都被 legacy 入口引用' + (missing.length ? '（缺：' + missing.join(', ') + '）' : ''));
ok(!extra.length, 'legacy 入口引用的模块都在磁盘上' + (extra.length ? '（多：' + extra.join(', ') + '）' : ''));

// ---------- 2. 行数上限 ----------
console.log('[2] 行数上限（js/app/*.js ≤ 800，js/app.js ≤ 600）');
const lineCount = p => fs.readFileSync(path.join(ROOT, p), 'utf8').split('\n').length;
for (const p of diskMods) ok(lineCount(p) <= 800, p + ' = ' + lineCount(p) + ' 行 ≤ 800');
ok(lineCount(appJs) <= 600, appJs + ' = ' + lineCount(appJs) + ' 行 ≤ 600');

// ---------- 3. A.reg 键全局唯一 ----------
console.log('[3] A.reg 键名全局唯一');
const regKeys = new Map(); // name -> file
for (const p of diskMods.concat([appJs])) {
  const text = fs.readFileSync(path.join(ROOT, p), 'utf8');
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
const coreText = fs.readFileSync(path.join(ROOT, 'js/app/core.js'), 'utf8');
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
for (const p of diskMods.filter(p => p !== 'js/app/core.js').concat([appJs])) {
  const text = fs.readFileSync(path.join(ROOT, p), 'utf8');
  // 只看顶层（缩进 2 空格）的 const { … } = A;
  for (const m of text.matchAll(/^  const \{([^}]*)\} = A;/gm)) {
    for (const piece of m[1].split(',')) {
      const name = (piece.trim().match(/^([A-Za-z_$][\w$]*)/) || [])[1];
      if (!name) continue;
      ok(coreExports.has(name), p + ' 顶层解构的 ' + name + ' 是 core 导出');
    }
  }
}

// ---------- 5. A.xxx 引用必须已注册（防运行时 A.xxx is not a function） ----------
console.log('[5] A.xxx 引用闭合性');
{
  const infra = new Set(['state', 'reg']);
  for (const p of diskMods.concat([appJs])) {
    const text = fs.readFileSync(path.join(ROOT, p), 'utf8')
      .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
    for (const m of text.matchAll(/(^|[^.\w$])A\.([A-Za-z_$][\w$]*)/g)) {
      const name = m[2];
      ok(regKeys.has(name) || infra.has(name), p + ' 的 A.' + name + ' 已注册');
    }
  }
}

// ---------- 6. node --check ----------
console.log('[6] node --check 语法');
for (const p of diskMods.concat([appJs])) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, p)], { stdio: 'pipe' });
    ok(true, p + ' 语法通过');
  } catch (e) {
    ok(false, p + ' 语法失败：' + String(e.stderr || e.message).slice(0, 300));
  }
}

if (fails) {
  console.error('app-structure-test：' + fails + ' 项未通过');
  process.exit(1);
}
console.log('app-structure-test：全部通过');
