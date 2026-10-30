#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 失败处理策略门禁
 *
 * 不开浏览器、不联网。守的是三种失败口径（说明见 ARCHITECTURE.md §2.2）：
 *   ① 用户可行动的失败 → toast 7 秒 + 调用方保留重试入口（src/app/core.js 的 reportUserFailure）；
 *   ② 纯后台降级 → console.warn 留原因，需要故事内归因时由 failureEntry 落一条 tool 留痕；
 *   ③ 清理 / 探测 / 解析兜底 → 允许吞，但必须写清为什么（注释），真实失败绝不允许静默。
 *
 * 检查分四组：
 *   1. 纯逻辑 helper（src/core/errors.ts）：原因归一、截短、留痕条目形状；
 *   2. app 侧接线：core.js 导出两个出口，关键降级点（书记员 / 画师 / 标题 / 压缩 / 视频下载）实际使用；
 *   3. 静态扫描：try 里调用了网络 / 模型 / 存储这类真实失败源的 catch，
 *      必须有上报调用或说明性注释；空着 = 静默吞错，直接失败；
 *   4. 反向自检：构造一个「静默吞掉 Sidecar 失败」的片段，确认扫描器真的会报警（防假绿）。
 *
 * 用法：node eval/error-policy-test.js（任一不过 → 退出码 1）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  errorText, shortError, failureEntry,
} = require(path.join(ROOT, 'src', 'core', 'errors.ts'));

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed += 1; }
}
function eq(a, b, msg) {
  ok(a === b, msg + (a === b ? '' : '（实际 ' + JSON.stringify(a) + ' ≠ 期望 ' + JSON.stringify(b) + '）'));
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* ---------------- 扫描面与括号配对 ---------------- */
const EXT = new Set(['.js', '.ts', '.mjs', '.svelte']);
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}
const FILES = walk(path.join(ROOT, 'src'));

// 正向扫一遍，跳过字符串 / 模板 / 注释，记下每个大括号的开闭配对
function bracePairs(text) {
  const openToClose = new Map();
  const closeToOpen = new Map();
  const opens = [];
  let i = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      i += 1;
      continue;
    }
    if (blockComment) {
      if (c === '*' && n === '/') { blockComment = false; i += 2; continue; }
      i += 1;
      continue;
    }
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i += 2; continue; }
    if (c === '/' && n === '*') { blockComment = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; i += 1; continue; }
    if (c === '{') opens.push(i);
    else if (c === '}') {
      const o = opens.pop();
      if (o != null) { openToClose.set(o, i); closeToOpen.set(i, o); }
    }
    i += 1;
  }
  return { openToClose, closeToOpen };
}

// 一个 catch 的 { 起点：从 catch 关键字跳过可选参数，找不到就返回 -1
function bodyOpenOf(text, catchAt) {
  let i = catchAt + 'catch'.length;
  while (/\s/.test(text[i])) i += 1;
  if (text[i] === '(') {
    let depth = 1;
    i += 1;
    while (i < text.length && depth) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') depth -= 1;
      i += 1;
    }
  }
  while (/\s/.test(text[i])) i += 1;
  return text[i] === '{' ? i : -1;
}

// try / catch 的紧邻判定：catch 前面必须是 try 块的收尾 }
function tryBodyOf(text, pairs, catchAt) {
  let i = catchAt - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (text[i] !== '}') return null;
  const tryOpen = pairs.closeToOpen.get(i);
  if (tryOpen == null) return null;
  let t = tryOpen - 1;
  while (t >= 0 && /\s/.test(text[t])) t -= 1;
  if (!/\btry$/.test(text.slice(Math.max(0, t - 2), t + 1))) return null;
  return { open: tryOpen, close: i, body: text.slice(tryOpen + 1, i) };
}

// try 体里出现这些名字 = 这段失败会影响数据 / 网络 / 模型结果，不能静默
const MEANINGFUL = /\b(?:ChatProviders|ImageProviders|Sidecar|Zip|Storage|Store|Cap|fetch|fetchBlob|listPending|confirmTrigger|cancelTrigger|emailDiscardDraft|paymentReceipt|paymentMarkPaid|Proposals|refImage|adapter\s*\.\s*(?:chat|generate|poll|submit|query|params|run))\b/;
// 上报形态：toast（用户）/ console（开发侧）/ 故事留痕 / 抛回调用方 / 存储失败回调 / 提案卡状态
const REPORTS = /report(?:User|Background)Failure\s*\(|console\s*\.\s*(?:warn|error)\s*\(|toast\s*\(|throw\b|\.log\s*\.\s*push\s*\(|failureEntry\s*\(|persistFail\s*\(|\bmarkFailed\s*\(/;
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/;

// 取 catch 整行尾部（} catch (…) { … } 收尾后的 // 说明也算解释）
function trailingComment(text, bodyClose) {
  const lineEnd = text.indexOf('\n', bodyClose + 1);
  return text.slice(bodyClose + 1, lineEnd < 0 ? text.length : lineEnd);
}

// 扫描一个文本里的「真实失败 catch」；返回 { reported, explained, silent, line, tryLine, snippet }
function scanSilentCatches(text) {
  const pairs = bracePairs(text);
  const results = [];
  for (const m of text.matchAll(/\bcatch\b/g)) {
    const catchAt = m.index;
    const open = bodyOpenOf(text, catchAt);
    if (open < 0) continue;
    const close = pairs.openToClose.get(open);
    if (close == null) continue;
    const t = tryBodyOf(text, pairs, catchAt);
    if (!t || !MEANINGFUL.test(t.body)) continue;
    const body = text.slice(open + 1, close);
    // 注释里提到 console.warn / toast 不算上报：先剥注释再判出口
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const explained = COMMENT.test(body) || COMMENT.test(trailingComment(text, close));
    const reported = REPORTS.test(code);
    results.push({
      reported: reported,
      explained: explained,
      // 静默 = 既没上报，也没写清为什么可以吞
      silent: !reported && !explained,
      line: text.slice(0, catchAt).split('\n').length,
      tryLine: text.slice(0, t.open).split('\n').length,
      snippet: t.body.replace(/\s+/g, ' ').trim().slice(0, 100),
    });
  }
  return results;
}

async function main() {
  /* ---------------- 1. 纯逻辑 helper ---------------- */
  console.log('[1] 失败原因归一与留痕（src/core/errors.ts）');
  {
    eq(errorText(new Error('boom')), 'boom', 'Error → message');
    eq(errorText('  boom  '), 'boom', '字符串去除首尾空白');
    eq(errorText(''), '未知错误', '空字符串不返回空原因');
    eq(errorText(null), '未知错误', 'null 有兜底文案');
    eq(errorText({ message: 'sidecar 拒绝' }), 'sidecar 拒绝', '对象 message 优先');
    eq(errorText({ code: 'TRIGGER_LOCKED' }), 'TRIGGER_LOCKED', '无 message 时用 code');
    eq(errorText({ a: 1 }), '{"a":1}', '其他对象转 JSON');
    eq(shortError(new Error('x'.repeat(100))), 'x'.repeat(60) + '…', '超长原因截短到 60 字 + 省略号');
    eq(shortError('short'), 'short', '未超长原样返回');
    eq(shortError('abcdefgh', 4), 'abcd…', '自定义截短长度');

    const e1 = failureEntry('scribe', 'boom');
    eq(e1.type, 'tool', '留痕 type = tool');
    eq(e1.tool, 'scribe', '留痕保留 tool 名');
    eq(e1.error, 'boom', '留痕 error 是完整原因（可归因）');
    ok(e1.summary.indexOf('已降级') >= 0, '默认 summary 标注已降级');
    ok(e1.summary.indexOf('boom') >= 0, '默认 summary 带原因');
    ok(Number.isFinite(e1.ts) && e1.ts > 0, '留痕带时间戳');

    const e2 = failureEntry('scribe', 'x'.repeat(100), { summary: '压缩失败（退回本地摘要）', ts: 123 });
    eq(e2.summary, '压缩失败（退回本地摘要）', 'summary 可覆盖（各任务自己的兜底说明）');
    eq(e2.error, 'x'.repeat(100), '覆盖 summary 不影响完整 error');
    eq(e2.ts, 123, 'ts 可覆盖');
  }

  /* ---------------- 2. app 侧接线 ---------------- */
  console.log('[2] 两个上报出口与关键降级点的接线');
  {
    const core = read('src/app/core.js');
    ok(core.indexOf("from '../core/errors.ts'") >= 0, 'core.js 从纯逻辑模块取原因 / 留痕实现');
    ok(/function reportUserFailure\s*\(/.test(core), 'core.js 定义 reportUserFailure（用户可行动）');
    ok(/function reportBackgroundFailure\s*\(/.test(core), 'core.js 定义 reportBackgroundFailure（后台降级）');
    ok(core.indexOf('reportUserFailure,') >= 0 && core.indexOf('reportBackgroundFailure,') >= 0,
      '两个出口都进了 A.reg（别的 app 模块可解构）');
    ok(/reportUserFailure[\s\S]*?toast\s*\(\s*msg\s*,\s*true\s*,\s*true\s*\)/.test(core),
      '用户可行动的失败走 toast（错误样式 + 7 秒）');
    ok(/reportBackgroundFailure[\s\S]*?console\s*\.\s*warn\s*\(/.test(core),
      '后台降级走 console.warn 留原因');

    // 合同：这些模块的模型 / 网络兜底必须走统一出口，而不是 console.warn 各写一份或静默
    const mustUse = [
      ['app/turn.js', '书记员校对 / 压缩失败', 3],
      ['app/painter.js', '画师构思失败', 2],
      ['app/shelf.js', '自动标题 / 手动重新生成', 2],
      ['app/round.js', '回合前压缩失败', 1],
      ['app/video.js', '视频转存降级', 1],
      ['app/sidecar.js', '主动消息拉取 / 确认失败', 2],
      ['app/features.js', '邮件 / 台账读取与提案清理', 4],
    ];
    for (const [file, what, min] of mustUse) {
      const src = read('src/' + file);
      const n = (src.match(/report(?:User|Background)Failure\s*\(/g) || []).length;
      ok(n >= min, file + ' 的' + what + '走统一出口（≥' + min + ' 处，实际 ' + n + '）');
    }
    ok(read('src/app/turn.js').indexOf("failureEntry('scribe'") >= 0,
      '书记员失败留痕由 failureEntry 生成（error 字段不丢）');
    ok(read('src/app/core.js').indexOf('errorText,') >= 0, 'errorText 进 A.reg（调用方可拼正文）');
  }

  /* ---------------- 3. 静态扫描：真实失败不许静默 ---------------- */
  console.log('[3] 真实失败不许静默吞掉（src 全量静态扫描）');
  {
    let meaningful = 0;
    const violations = [];
    for (const abs of FILES) {
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      const text = fs.readFileSync(abs, 'utf8');
      for (const r of scanSilentCatches(text)) {
        meaningful += 1;
        if (r.silent) violations.push({ rel, ...r });
      }
    }
    ok(meaningful >= 40, '扫描到 ' + meaningful + ' 处「真实失败」catch（下限 40，防解析失效假绿）');
    if (violations.length) {
      for (const v of violations) {
        console.error('  FAIL ' + v.rel + ':' + v.line + ' 静默吞错：try 里的 ' + v.snippet);
      }
    }
    eq(violations.length, 0, '没有静默吞掉网络 / 模型 / 存储失败的 catch');
  }

  /* ---------------- 4. 反向自检：扫描器能失败 ---------------- */
  console.log('[4] 反向自检（能拦住静默吞错，也能放行说明性吞错）');
  {
    const bad = [
      'async function f() {',
      '  try { await Sidecar.emailAudit(20); } catch (_) {}',
      '}',
    ].join('\n');
    const badScan = scanSilentCatches(bad);
    ok(badScan.length === 1 && badScan[0].silent, '「try Sidecar → 空 catch」被判定为静默吞错');

    const good1 = [
      'async function f() {',
      '  try { await Sidecar.emailAudit(20); } catch (_) { /* 探测失败可忽略 */ }',
      '}',
    ].join('\n');
    const s1 = scanSilentCatches(good1);
    ok(s1.length === 1 && !s1[0].silent, '带说明注释的吞错放行（清理 / 探测形态）');

    const good2 = [
      'async function f() {',
      '  try { await Sidecar.emailAudit(20); } catch (e) { reportBackgroundFailure("审计", e); }',
      '}',
    ].join('\n');
    const s2 = scanSilentCatches(good2);
    ok(s2.length === 1 && !s2[0].silent, '走上报出口的 catch 放行');

    const noise = [
      'function g() {',
      '  try { el.focus(); } catch (_) {}',
      '}',
    ].join('\n');
    eq(scanSilentCatches(noise).length, 0, '清理类 try（focus）不进「真实失败」统计');
  }

  console.log('\n失败处理策略门禁：' + (failed ? '有 ' + failed + ' 项失败' : '全部通过'));
  if (failed) process.exitCode = 1;
}

main().catch(err => {
  console.error('运行出错：', err);
  process.exitCode = 1;
});
