'use strict';
/*
 * 无限阅读 · eval 共用脚手架（不是门禁：package.json 的 test 链里不出现它）
 *
 * 五个「侧车 / 前端」门禁（sidecar-smoke / frontend-smoke / payment-test /
 * scheduler-test / email-test）各自抄过同一段样板：results 数组、check()、
 * 汇总循环、exitCode，以及 localMs() 与动态 import 的 pathToFileURL 包装。
 * 这里只收敛样板，不收敛用例——用例、标题、进程收尾仍归各脚本自己。
 *
 * 用法：
 *   const H = require('./_harness.js');
 *   H.check('同名覆盖 → 400', r.status === 400, r.status);   // 第三参只在该条失败时打印
 *   H.run('调度器单测', main);                                // main 抛异常也记一条失败并汇总
 *
 * 约定（与收敛前五个脚本的行为逐字一致）：
 *   - 汇总行格式：`<标题>：<通过>/<总数> 通过`；
 *   - 全通过退出码 0，缺一条 1；不主动 process.exit（调用方可能还有子进程 / 临时目录要收尾）；
 *   - 异常不算「另一类结果」：记成一条失败用例进汇总，栈单独打到 stderr，
 *     避免出现「打印了 12/12 通过但退出码 1」这种自相矛盾的输出。
 */
const path = require('path');
const { pathToFileURL } = require('url');

const results = [];

/* 记一条断言；detail 是失败现场，成功时不占输出 */
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}

/* 打印全部结果 + 汇总，返回 { pass, total }（不设退出码，便于调用方先做收尾） */
function summary(title) {
  const pass = results.filter(r => r.hit).length;
  for (const r of results) {
    console.log((r.hit ? '  ✔ ' : '  ✘ ') + r.name + (r.hit || !r.detail ? '' : '   → ' + r.detail));
  }
  console.log('\n' + title + '：' + pass + '/' + results.length + ' 通过');
  return { pass: pass, total: results.length };
}

/* 汇总 + 退出码：门禁的唯一出口 */
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

module.exports = { check, finish, run, loadEsm, localMs };
