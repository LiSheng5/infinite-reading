'use strict';
/*
 * 无限阅读 · eval 共用脚手架（不是门禁：package.json 的 test 链里不出现它）
 *
 * 门禁的样板都收在这里：结果数组、两种断言风格、汇总与退出码、目录遍历、
 * localStorage 垫片，以及 localMs() 与动态 import 的 pathToFileURL 包装。
 * 用例、标题、进程收尾仍归各脚本自己。
 *
 *   const H = require('./_harness.js');
 *   H.check('同名覆盖 → 400', r.status === 400, r.status);   // 第三参只在该条失败时打印
 *   H.run('调度器单测', main);                                // main 抛异常也记一条失败并汇总
 *
 * 断言有两种风格，输出形态不同，同一个文件里只用一种：
 *   - check + run：结果先进数组，run() 末尾一次性打印 `✔ / ✘` 与 `<标题>：<通过>/<总数> 通过`；
 *   - ok + eq：每条当场打印 `  ok  ` / `  FAIL `，退出码由各脚本读 H.failed 自己定
 *     （按小节读输出的长脚本用这套，段标题才能和结果交错）。
 *
 * 约定：
 *   - 全通过退出码 0，缺一条 1；不主动 process.exit（调用方可能还有子进程 / 临时目录要收尾）；
 *   - 异常不算「另一类结果」：记成一条失败用例进汇总，栈单独打到 stderr，
 *     避免出现「打印了 12/12 通过但退出码 1」这种自相矛盾的输出。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const results = [];
let failed = 0;

/* 记一条断言（收货式）；detail 是失败现场，成功时不占输出 */
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}

/* 立即打印一条断言；给按小节读输出的长脚本用 */
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed += 1; }
}

/* 立即打印的严格相等断言（只适合原始值；数组 / 对象各脚本自己序列化） */
function eq(a, b, msg) {
  ok(a === b, msg + (a === b ? '' : '（实际 ' + JSON.stringify(a) + ' ≠ 期望 ' + JSON.stringify(b) + '）'));
}

/* 打印全部结果 + 汇总，返回 { pass, total, checks }（不设退出码，便于调用方先做收尾） */
function summary(title) {
  const pass = results.filter(r => r.hit).length;
  for (const r of results) {
    console.log((r.hit ? '  ✔ ' : '  ✘ ') + r.name + (r.hit || !r.detail ? '' : '   → ' + r.detail));
  }
  console.log('\n' + title + '：' + pass + '/' + results.length + ' 通过');
  return { pass: pass, total: results.length, checks: results };
}

/* 汇总 + 退出码：收货式门禁的唯一出口 */
function finish(title) {
  const s = summary(title);
  if (s.pass !== s.total) process.exitCode = 1;
  return s;
}

/* 跑一个 async main() 并收尾：异常 → 一条失败用例，栈走 stderr */
function run(title, main) {
  return Promise.resolve()
    .then(main)
    .catch(e => {
      check('测试过程无异常', false, e && e.message);
      if (e && e.stack) console.error(e.stack);
    })
    .then(() => finish(title));
}

/* 递归收文件：walkFiles(dir, ['.svelte', '.js']) → 绝对路径数组 */
function walkFiles(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, exts));
    else if (exts.some(x => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/* 进程内 localStorage 垫片：store.ts 没有 IndexedDB 时走这条回退。
 * 返回底层 Map，便于测试直接读写原始键 */
function installLocalStorage() {
  const m = new Map();
  global.localStorage = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    key: i => Array.from(m.keys())[i] || null,
    get length() { return m.size; },
  };
  return m;
}

/* 动态 import 侧车模块：loadEsm('scheduler.mjs')。
 * 必须经 file:// URL —— Windows 盘符直接拼路径会被当成 scheme 拒绝 */
function loadEsm(file) {
  return import(pathToFileURL(path.join(__dirname, '..', 'sidecar', file)).href);
}

/* 本地时区的「某年某月某日某时某分」→ 毫秒。
 * 用本地时间而非 UTC：调度 / 邮件 / 支付的日切都按用户本地日算 */
function localMs(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

module.exports = {
  check, ok, eq, summary, finish, run,
  walkFiles, installLocalStorage, loadEsm, localMs,
  /* 立即式断言失败了几条 —— 各脚本据此决定退出码 */
  get failed() { return failed; },
};
