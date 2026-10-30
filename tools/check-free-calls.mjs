#!/usr/bin/env node
// tools/check-free-calls.mjs —— 裸调用启发式检查（尽力而为，不是证明）
//
// 扫描范围**刻意**只覆盖 src/app/main.js 与 src/app/*.js（「确认意图」）：
// 本检查抓的是「从 main.js 拆分搬家后忘改成 A.xxx(...)」，A.xxx 约定只存在于应用层；
// src/core、src/ui、src/screens 走静态 import，没有这套约定，扩进来只会攒误报。
// 若将来应用层之外也引入 A.reg 机制，再把 files 清单扩到全量。
//
// 对 src/app/main.js 与 src/app/*.js：剔除字符串 / 注释 / 正则 / 模板字面量后，
// 找出形如 name( 且前面不是 . 的「裸调用」；每个裸调用名必须是以下之一：
//   1) 本文件里声明过的名字（function / class / const / let / var / 形参 / 解构绑定 / 方法简写）；
//   2) JS 内置与浏览器全局（下方 GLOBALS 白名单）；
//   3) tools/free-calls-allow.json 里登记的名字（每条带一行理由）。
// 未解析的名字 → 失败。这能抓住「搬家后忘了改成 A.xxx(...)」的大部分情况。
//
// 已知局限（靠允许名单消化，见 free-calls-allow.json 顶部说明）：
// 正则字面量与模板字符串内的伪匹配、对象方法简写与「后跟 { 的调用」难以区分、
// 多声明符（const a = 1, b = 2）只登记第一个名字等。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'free-calls-allow.json'), 'utf8'));

// ---------------- 词法：剔除字符串 / 注释 / 正则 / 模板原始段（${} 内表达式保留为代码） ----------------
const REGEX_PREV_KW = ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'instanceof', 'await', 'yield', 'throw'];
function tokenize(text) {
  const toks = [];
  let prevTok = null;
  const push = (type, start, end) => {
    const t = { type, start, end, value: text.slice(start, end) };
    toks.push(t);
    if (type !== 'space' && type !== 'comment') prevTok = t;
    return t;
  };
  function run(from, to) {
    let i = from;
    const n = to;
    while (i < n) {
      const c = text[i];
      if (/\s/.test(c)) { const s = i; while (i < n && /\s/.test(text[i])) i++; push('space', s, i); continue; }
      if (c === '/' && text[i + 1] === '/') { const s = i; while (i < n && text[i] !== '\n') i++; push('comment', s, i); continue; }
      if (c === '/' && text[i + 1] === '*') { const s = i; i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++; i = Math.min(n, i + 2); push('comment', s, i); continue; }
      if (c === '"' || c === "'") { const s = i, q = c; i++; while (i < n && text[i] !== q) { if (text[i] === '\\') i++; i++; } i = Math.min(n, i + 1); push('string', s, i); continue; }
      if (c === '`') {
        const s = i; i++;
        let seg = i;
        while (i < n && text[i] !== '`') {
          if (text[i] === '\\') { i += 2; continue; }
          if (text[i] === '$' && text[i + 1] === '{') {
            if (i > seg) push('tplraw', seg, i);
            const exprStart = i + 2;
            let j = exprStart, depth = 1;
            while (j < n && depth > 0) {
              const ch = text[j];
              if (ch === '"' || ch === "'") { const q2 = ch; j++; while (j < n && text[j] !== q2) { if (text[j] === '\\') j++; j++; } j = Math.min(n, j + 1); continue; }
              if (ch === '{') depth++;
              else if (ch === '}') { depth--; if (depth === 0) break; }
              j++;
            }
            run(exprStart, j);
            i = Math.min(n, j + 1);
            seg = i;
            continue;
          }
          i++;
        }
        if (i > seg) push('tplraw', seg, i);
        i = Math.min(n, i + 1);
        push('tplend', seg, i);
        continue;
      }
      if (c === '/') {
        const p = prevTok;
        const canRegex = !p || (p.type === 'code' && (/^[([{,;:=!&|?+\-*%~^<>]$/.test(p.value) || REGEX_PREV_KW.includes(p.value)));
        if (canRegex) {
          const s = i; i++;
          while (i < n && text[i] !== '/') {
            if (text[i] === '\\') { i += 2; continue; }
            if (text[i] === '[') { i++; while (i < n && text[i] !== ']') { if (text[i] === '\\') i++; i++; } }
            i++;
          }
          i = Math.min(n, i + 1);
          while (i < n && 'gimsuy'.includes(text[i])) i++;
          push('regex', s, i);
          continue;
        }
      }
      if (/[A-Za-z_$]/.test(c)) { const s = i; while (i < n && /[\w$]/.test(text[i])) i++; push('code', s, i); continue; }
      if (/[0-9]/.test(c)) { const s = i; while (i < n && /[\w.]/.test(text[i])) i++; push('num', s, i); continue; }
      push('code', i, i + 1); i++;
    }
  }
  run(0, text.length);
  toks.sort((a, b) => a.start - b.start || a.end - b.end);
  return toks;
}

// 只留代码的视图：字符串 / 注释 / 正则 / 模板原始段抹成空格（保留换行与 ${} 内代码）
function codeOnlyView(text) {
  const toks = tokenize(text);
  const arr = text.split('');
  for (const t of toks) {
    if (t.type === 'string' || t.type === 'comment' || t.type === 'tplraw' || t.type === 'regex' || t.type === 'tplend') {
      for (let k = t.start; k < t.end; k++) if (arr[k] !== '\n') arr[k] = ' ';
    }
  }
  return arr.join('');
}

// ---------------- 本文件声明过的名字（启发式：任意作用域都算） ----------------
function declaredNames(code) {
  const out = new Set();
  const add = n => { if (n) out.add(n); };
  // 解构绑定：{ a, b: c, d = 1 } / [a, b] —— 收集括号段内「后面不跟 :」的标识符
  const destructureSpan = (start) => {
    let depth = 0, i = start;
    for (; i < code.length; i++) {
      const ch = code[i];
      if ('{[('.includes(ch)) depth++;
      else if ('}])'.includes(ch)) { depth--; if (depth === 0) break; }
    }
    return code.slice(start, i + 1);
  };
  const collectBindings = (span) => {
    const re = /([A-Za-z_$][\w$]*)\s*(?![:\w$])/g;
    let m;
    while ((m = re.exec(span))) {
      const after = span.slice(m.index + m[0].length);
      if (/^:/.test(span.slice(m.index + m[1].length).replace(/^\s*/, ''))) continue; // 属性键（a: b 的 a）
      add(m[1]);
    }
  };
  // function / class 声明与方法简写
  for (const re of [
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
  ]) { let m; while ((m = re.exec(code))) add(m[1]); }
  // const / let / var 直接绑定 + 解构 + 多声明符
  {
    const re = /\b(?:const|let|var)\b/g;
    let m;
    while ((m = re.exec(code))) {
      let i = m.index + m[0].length;
      // 一个声明语句里可能有多个声明符：const a = 1, b = 2 / const {x} = y, z = 1
      for (;;) {
        while (i < code.length && /\s/.test(code[i])) i++;
        const ch = code[i];
        if (ch === '{' || ch === '[') {
          const span = destructureSpan(i);
          collectBindings(span);
          i += span.length;
        } else if (/[A-Za-z_$]/.test(ch || '')) {
          const s = i; while (i < code.length && /[\w$]/.test(code[i])) i++;
          add(code.slice(s, i));
        } else break;
        // 跳过到下一个声明符：= 右侧表达式（可能含 , 与嵌套括号）或直接 , / ;
        let depth = 0;
        while (i < code.length) {
          const c = code[i];
          if ('([{'.includes(c)) depth++;
          else if (')]}'.includes(c)) depth--;
          else if (c === ',' && depth === 0) { i++; break; }
          else if (c === ';') break;
          else if (c === '\n' && depth === 0) {
            // 行尾没有逗号就结束整个声明（避免越界吃掉下一行）
            const rest = code.slice(i).match(/^\s*(?=[,)])/);
            if (!rest) { i = code.length; }
            break;
          }
          i++;
        }
        if (i >= code.length || code[i - 1] === ';' || (code[i - 1] === '\n')) {
          // 若停在换行且下一段不是延续，退出
          if (code[i] !== undefined && /[A-Za-z_$]/.test(code[i])) continue;
          break;
        }
      }
    }
  }
  // 形参：function (...) / (...) => / 单参箭头 e =>
  for (const re of [
    /\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g,
    /\bfunction\s*\*?\s*\(([^)]*)\)/g,
    /\(([^)]*)\)\s*=>/g,
  ]) {
    let m;
    while ((m = re.exec(code))) {
      for (const piece of splitTopCommas(m[1])) {
        const p = piece.trim();
        if (!p) continue;
        if (p[0] === '{' || p[0] === '[') collectBindings(p);
        else { const mm = p.match(/^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/); if (mm) add(mm[1]); }
      }
    }
  }
  {
    const re = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g;
    let m; while ((m = re.exec(code))) add(m[2]);
    const re2 = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g;
    while ((m = re2.exec(code))) add(m[1]);
  }
  return out;
}
function splitTopCommas(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// JS 内置与浏览器全局（阶段 6 起项目不再有全局 IR 命名空间）
const GLOBALS = new Set(`
arguments
console Math JSON Object Array String Number Boolean Symbol Promise Map Set WeakMap WeakSet Date RegExp
Error TypeError RangeError SyntaxError URIError EvalError AggregateError
Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array Float32Array Float64Array ArrayBuffer DataView
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape
setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame queueMicrotask structuredClone
fetch Headers Request Response AbortController AbortSignal Event EventTarget CustomEvent EventSource
URL URLSearchParams Blob File FileReader FormData TextEncoder TextDecoder
crypto performance navigator document window location history localStorage sessionStorage
alert confirm prompt getComputedStyle matchMedia Image HTMLElement Element Node
MutationObserver IntersectionObserver ResizeObserver DOMParser XMLHttpRequest atob btoa reportError
`.split(/\s+/).filter(Boolean));

const CONTROL_KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'do', 'else', 'try', 'await', 'async', 'yield', 'throw', 'case', 'in', 'of', 'delete', 'void', 'instanceof', 'class', 'const', 'let', 'var', 'super', 'import', 'export', 'extends', 'with', 'debugger']);

// ---------------- 扫描 ----------------
function matchingParen(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function checkFile(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const code = codeOnlyView(text);
  const declared = declaredNames(code);

  // 阶段 6：应用层改成 ESM 后，import 绑定就是本地声明（默认导入 / 命名导入 / 别名）
  const importRe = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"][^'"]+['"]/g;
  for (const im of text.matchAll(importRe)) {
    if (im[1]) declared.add(im[1]);
    if (im[2]) {
      for (const piece of im[2].split(',')) {
        const name = (piece.trim().match(/(?:\bas\s+)?([A-Za-z_$][\w$]*)$/) || [])[1];
        if (name) declared.add(name);
      }
    }
  }

  const problems = [];
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const name = m[2];
    const nameStart = m.index + m[1].length;
    // function NAME( —— 声明头，跳过
    const before = code.slice(Math.max(0, nameStart - 12), nameStart);
    if (/(?:^|[\s;}])function\s*\*?\s*$/.test(before)) continue;
    if (CONTROL_KW.has(name)) continue;
    if (declared.has(name)) continue;
    if (GLOBALS.has(name)) continue;
    if (ALLOW[name]) continue;
    // 方法简写启发式：name(...) 的右括号后紧跟 { 且 name 前是 { , ( —— 按方法定义放行（已知局限）
    const open = nameStart + name.length + (code.slice(nameStart + name.length).match(/^\s*/) || [''])[0].length;
    const close = matchingParen(code, open);
    if (close >= 0 && /^\s*\{/.test(code.slice(close + 1))) {
      const prev = code.slice(0, nameStart).replace(/\s+$/, '');
      const prevCh = prev[prev.length - 1];
      if (prevCh === '{' || prevCh === ',' || prevCh === '(') continue;
    }
    const line = code.slice(0, nameStart).split('\n').length;
    problems.push({ file, line, name });
  }
  return problems;
}

const files = ['src/app/main.js']
.concat(fs.readdirSync(path.join(ROOT, 'src', 'app')).filter(f => f.endsWith('.js') && f !== 'main.js').sort().map(f => 'src/app/' + f));
let all = [];
for (const f of files) all = all.concat(checkFile(f));

if (all.length) {
  console.error('check-free-calls：发现未解析的裸调用 ' + all.length + ' 处（疑似搬家后忘改 A.xxx）：');
  for (const p of all) console.error('  ' + p.file + ':' + p.line + '  ' + p.name + '(');
  process.exit(1);
}
console.log('check-free-calls 通过：' + files.length + ' 个文件，无未解析裸调用');
