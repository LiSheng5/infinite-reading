#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 注释自解释门禁
 *
 * 不开浏览器、不联网。守的是一条写作约定：**注释里不出现仓库外的编号**。
 *
 * 为什么：早期注释大量写外部任务书的章节号、审查报告的条目号、阶段编号——这些文档
 * 不在仓库里，半年后没人能追溯，编号就成了唯一解释。约定是：
 *   1. 结论就地写清「为什么」，不要只留一个编号；
 *   2. 真要引用，只引用仓内文件（ARCHITECTURE.md §4.2 这类），并且让读者点得开。
 *
 * 检查分三组：
 *   1. 外部编号：任务书 / 审查 / 屏号 / 阶段号 / 条目号 / 轮次号一律拦下；
 *      § 只允许紧跟在仓内文档名之后（本文件自身的注释就是规则说明与反例，整份豁免）；
 *   2. 断句残留：删编号时常见的手滑——空括号、连续标点、注释以标点开头；
 *   3. 提取器自检：确认「注释提取」本身没失效（否则整份门禁会假绿）。
 *
 * 扫描面 = 仓库会带走的源码（src / sidecar / eval / tools / css + 根目录入口文件）。
 * docs/ 不扫：说明文档引用自己的章节号（§4.2）是正常的。
 *
 * 用法：node eval/comments-test.js（任一不过 → 退出码 1）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed += 1; }
}
function eq(a, b, msg) {
  ok(a === b, msg + (a === b ? '' : '（实际 ' + JSON.stringify(a) + ' ≠ 期望 ' + JSON.stringify(b) + '）'));
}

/* ---------------- 扫描面 ---------------- */
const EXT = new Set(['.js', '.mjs', '.ts', '.svelte', '.css', '.html']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const FILES = [];
for (const d of ['src', 'sidecar', 'eval', 'tools', 'css']) {
  const abs = path.join(ROOT, d);
  if (fs.existsSync(abs)) FILES.push(...walk(abs));
}
for (const f of ['sw.js', 'index.html', 'vite.config.mjs']) {
  const abs = path.join(ROOT, f);
  if (fs.existsSync(abs)) FILES.push(abs);
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

/* ---------------- 注释提取 ---------------- */
// 行内注释起点：跳过引号内内容，避免把 'http://…' 当注释
function commentStart(line) {
  let quote = null;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && line[i + 1] === '/') return i;
    if (ch === '/' && line[i + 1] === '*') return i;
    if (ch === '<' && line.slice(i, i + 4) === '<!--') return i;
  }
  return -1;
}

// 返回 [{ line, text }]：text 只含注释那部分（块注释的后续行整行都算）
function commentsOf(text) {
  const out = [];
  let inBlock = false;
  text.split(/\r?\n/).forEach((line, i) => {
    const wasInBlock = inBlock;
    if (!inBlock && line.includes('/*')) inBlock = true;
    if (inBlock && line.includes('*/')) inBlock = false;
    const at = wasInBlock ? 0 : commentStart(line);
    if (at < 0) return;
    out.push({ line: i + 1, text: line.slice(at) });
  });
  return out;
}

/* ---------------- 1. 外部编号 ---------------- */
const DOC_NAMES = /(ARCHITECTURE(?:\.md)?|README(?:\.en)?\.md|CONTRIBUTING\.md|RELEASE_NOTES\.md|sidecar\/README\.md)\s*$/;

const RULES = [
  { re: /任务书/, why: '外部任务书编号：把结论就地写清，或改引仓内文档' },
  { re: /审查/, why: '审查报告条目号：把「为什么」写成一句话' },
  { re: /(?:中危|低危|高危|Top|可维护性|文档一致性)\s*#?\s*\d/, why: '审查条目号' },
  { re: /(?<![A-Za-z0-9_])[DMSR]\d+(?:\.\d+)?(?![\dA-Za-z])/, why: '条目号（D5 / M9 / S3 / R13 这类）' },
  { re: /(?<![A-Za-z0-9_])P-?\d+(?![\dA-Za-z])/, why: '阶段编号（P-1 / P2 / P0 这类）' },
  { re: /T-[A-Z]{1,2}-\d/, why: '任务书条目（T-M-1 / T-P5-3 这类）' },
  { re: /UI-[1-4]/, why: '任务书屏号（UI-2 §3.1 这类）' },
  { re: /第[一二三四五六七八九十0-9]+ ?轮/, why: '轮次编号（第八轮 / 第十六轮 这类）' },
];

/* ---------------- 2. 断句残留 ---------------- */
const BROKEN = [
  [/（\s*）/, '空括号'],
  [/：：|，：|（，|，）/, '连续 / 错位标点'],
  [/^\s*(?:\*|\/\/|<!--)\s*[：，、；]/, '注释以标点开头'],
];

/* ---------------- 3. 判定单条注释 ---------------- */
function violationsOf(text) {
  const out = [];
  for (const r of RULES) if (r.re.test(text)) out.push(r.why);
  const at = text.indexOf('§');
  if (at >= 0 && !DOC_NAMES.test(text.slice(0, at))) out.push('§ 只能跟在仓内文档名之后');
  for (const [re, why] of BROKEN) if (re.test(text)) out.push('断句残留：' + why);
  return out;
}

/* ---------------- 4. 提取器与判定器自检 ---------------- */
console.log('[0] 提取器 / 判定器自检');
eq(commentsOf('const a = 1; // 用户可见的说明')[0].text.trim(), '// 用户可见的说明', '能取到行尾注释');
eq(commentsOf('/* 块注释 */')[0].text.trim(), '/* 块注释 */', '能取到块注释');
eq(commentsOf('{#if x}<path d="M12 5v14"/>{/if}').length, 0, 'SVG 路径数据不算注释');
eq(commentsOf("const u = 'http://127.0.0.1';").length, 0, '字符串里的 // 不算注释');
ok(commentsOf('/*\n * 第二行\n */').length >= 3, '块注释的后续行整行算注释');
// 门禁必须「能失败」：拿几条真出现过的写法验判定器
ok(violationsOf('* 确认闸门：请求体里的 source 不能当凭据（审查 D1）').length > 0, '拦得下「审查 D1」');
ok(violationsOf('* 视频三参数以面板为准（任务书 §5.7）').length > 0, '拦得下「任务书 §5.7」');
ok(violationsOf('* 剧情模式不下发 request_image（P-1 §3.3）').length > 0, '拦得下「P-1 §3.3」');
ok(violationsOf('// 过期即 expired（§4.2）').length > 0, '拦得下裸 § 章节号');
ok(violationsOf('* 见 ARCHITECTURE.md §4.2 的分支语义').length === 0, '放行仓内文档引用（ARCHITECTURE.md §4.2）');
ok(violationsOf('// 只释放没有其它故事引用的原图：两个故事共享 imageId 时').length === 0, '放行正常注释');

/* ---------------- 扫描 ---------------- */
console.log('\n[1] 扫描面');
ok(FILES.length >= 120, '源码文件 ' + FILES.length + ' 个（>= 120）');
for (const must of ['src/core/store.ts', 'src/app/round.js', 'sidecar/server.mjs', 'css/read.css', 'eval/run.js', 'sw.js', 'index.html']) {
  ok(FILES.some((f) => rel(f) === must), '扫描面包含 ' + must);
}

const SELF = rel(path.join(__dirname, 'comments-test.js'));
let commentLines = 0;
let skippedSelf = 0;
const hits = [];
for (const abs of FILES) {
  const name = rel(abs);
  for (const c of commentsOf(fs.readFileSync(abs, 'utf8'))) {
    commentLines += 1;
    // 本文件的注释就是规则说明与反例清单（必然包含那些字样），整份豁免
    if (name === SELF) { skippedSelf += 1; continue; }
    for (const why of violationsOf(c.text)) {
      hits.push({ where: name + ':' + c.line, text: c.text.trim(), why: why });
    }
  }
}

console.log('\n[2] 注释规模（防止扫描失效后假绿）');
ok(commentLines >= 1500, '注释行 ' + commentLines + ' 行（>= 1500）');

console.log('\n[3] 外部编号 / 断句残留');
ok(hits.length === 0, '无外部编号与断句残留' + (hits.length ? '（' + hits.length + ' 处）' : ''));
ok(skippedSelf > 0, '本文件已豁免 ' + skippedSelf + ' 行（只此一份，规则说明与反例）');
for (const h of hits.slice(0, 20)) {
  console.error('     ' + h.where + '  ' + h.why + '\n       ' + h.text.slice(0, 120));
}
if (hits.length > 20) console.error('     …… 还有 ' + (hits.length - 20) + ' 处');

/* ---------------- 汇总 ---------------- */
console.log('');
if (failed) {
  console.error('注释自解释门禁：' + failed + ' 项未过');
  process.exit(1);
}
console.log('注释自解释门禁：全部通过');
