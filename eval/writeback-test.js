#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 异步写回契约单测
 *
 * 两个方向都钉住：
 *   ① 契约纯逻辑（src/core/writeBack.ts）——换档 / 换任务后写回必须被丢弃或归位到发起时的目标，
 *      断言闸失败要留 console 警告（可归因）；切走再切回（新对象同 id）要认回当前对象。
 *   ② 静态回归——回合 / 重试 / 书记员 / 压缩 / 画师 / 导入整理的续体都过契约收口；
 *      书记员失败不再被空 catch 吞掉（console.warn + tool 留痕带 error），界面区分未启用 / 失败；
 *      画师工作台的两个重画入口共用一份实现（只有取词方式不同）。
 *
 * 用法：node eval/writeback-test.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { WriteBack } = require(path.join(ROOT, 'src', 'core', 'writeBack.ts'));

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed++; }
}
function eq(a, b, msg) {
  ok(a === b, msg + (a === b ? '' : '（实际 ' + JSON.stringify(a) + ' ≠ 期望 ' + JSON.stringify(b) + '）'));
}

/* ---------------- ① 契约纯逻辑 ---------------- */
console.log('[1] 异步写回契约（src/core/writeBack.ts）');
{
  const A = { id: 'story-a' };
  const B = { id: 'story-b' };
  const A2 = { id: 'story-a', note: '切走再切回：同 id 的新对象' };

  // —— 断言式：isSameStory / assertStory ——
  ok(WriteBack.isSameStory(A, 'story-a'), '同 id 认定为同一本');
  ok(!WriteBack.isSameStory(A, 'story-b'), '换档后 id 不同 → 不再是同一本');
  ok(!WriteBack.isSameStory(null, 'story-a'), '当前无故事 → 不算同一本');
  ok(!WriteBack.isSameStory(A, null), '快照为空 → 不算同一本');
  ok(!WriteBack.isSameStory(A, ''), '空 id 不算同一本（防两个无 id 对象误判）');

  // assertStory：通过时不打警告；失败时 console 留可归因警告（口径）
  const warns = [];
  const origWarn = console.warn;
  console.warn = (s) => { warns.push(String(s)); };
  ok(WriteBack.assertStory(A, 'story-a', '回合回包') === true, 'assertStory 同一本 → true');
  ok(warns.length === 0, 'assertStory 通过时不产生警告');
  ok(WriteBack.assertStory(B, 'story-a', '回合回包') === false, 'assertStory 换档 → false（写回放弃）');
  ok(warns.length === 1 && warns[0].indexOf('回合回包') >= 0 && warns[0].indexOf('story-a') >= 0,
    'assertStory 失败留警告：含续体名与发起 id（可归因）');
  console.warn = origWarn;

  // —— 闸门式：writeBackIfSameStory ——
  let ran = 0;
  eq(WriteBack.writeBackIfSameStory(A, 'story-a', (st) => { ran++; eq(st, A, 'apply 收到当前故事对象'); }), true, '同本 → 执行写回');
  eq(ran, 1, '同本写回执行了一次');
  eq(WriteBack.writeBackIfSameStory(B, 'story-a', () => { ran++; }), false, '换档 → 闸门拒绝');
  eq(ran, 1, '换档写回整段不执行（旧档不丢给新档、新档不被串写）');

  // —— 任务对象：isSameJob / writeBackIfSameJob（导入整理 /  画师面板）——
  const job = { busy: true };
  ok(WriteBack.isSameJob(job, job), '同一任务对象（引用）→ true');
  ok(!WriteBack.isSameJob(null, job), '任务已被置空 → false');
  ok(!WriteBack.isSameJob({ busy: true }, job), '被新任务顶掉（不同引用）→ false');
  ok(!WriteBack.isSameJob(job, null), '快照任务为空 → false');
  let jobRan = 0;
  eq(WriteBack.writeBackIfSameJob(job, job, (j) => { jobRan++; j.busy = false; }), true, 'job 未换 → 执行写回');
  eq(job.busy, false, '写回落在发起时的任务对象上');
  eq(WriteBack.writeBackIfSameJob(null, job, () => { jobRan++; }), false, 'job 被置空 → 闸门拒绝');
  eq(jobRan, 1, '置空后写回整段不执行（不再写已置空的任务）');

  // —— 归位式：resolveWriteBackStory / writeBackToStory（画师线程）——
  eq(WriteBack.resolveWriteBackStory(A2, A), A2, '切走再切回：同 id 新对象 → 认回当前对象（不被旧副本覆盖）');
  eq(WriteBack.resolveWriteBackStory(B, A), A, '换档 → 写回发起时那本（不写进别的故事）');
  eq(WriteBack.resolveWriteBackStory(null, A), A, '故事已关 → 写回发起时的对象（由调用方决定落盘）');

  let target = null;
  eq(WriteBack.writeBackToStory(B, A, (st) => { target = st; }), false, 'writeBackToStory 换档 → 返回 false（仍归位写原故事）');
  eq(target, A, '换档时写回落在原故事对象上（回包不丢）');
  target = null;
  eq(WriteBack.writeBackToStory(A2, A, (st) => { target = st; }), true, '同 id 新对象 → 返回 true（可顺手刷新界面）');
  eq(target, A2, '同 id 时写回落在当前对象上');
}

/* ---------------- ② 静态回归：续体收口 + 书记员错误可观测 ---------------- */
console.log('[2] 续体收口与错误留痕（静态回归，改坏即失败）');
const read = (p) => fs.readFileSync(path.join(ROOT, 'src', p), 'utf8');
{
  const round = read(path.join('app', 'round.js'));
  const turn = read(path.join('app', 'turn.js'));
  const painter = read(path.join('app', 'painter.js'));
  const importer = read(path.join('app', 'importer.js'));
  const settings = read(path.join('app', 'settings.js'));
  const shelf = read(path.join('app', 'shelf.js'));

  // 回合 / 开局 / 重试的每个 await 写回段之前都有断言闸
  ok(round.indexOf('WriteBack.assertStory(S.story, sid, ') >= 0, 'round.js 回合/开局续体过 assertStory 闸');
  ok((round.match(/WriteBack\.assertStory\(/g) || []).length >= 6, 'round.js 回包/收尾/封节点/失败回写全覆盖（≥6 处闸）');
  ok(turn.indexOf('WriteBack.assertStory(S.story, sid, ') >= 0, 'turn.js 重试/收尾续体过 assertStory 闸');
  ok((turn.match(/WriteBack\.assertStory\(/g) || []).length >= 5, 'turn.js 重试四段 + postTurn 全覆盖（≥5 处闸）');

  // 画师归位、面板任务、导入任务都过闸门式契约
  ok(painter.indexOf('WriteBack.writeBackToStory(') >= 0, 'painter.js 回包归位过 writeBackToStory');
  ok((painter.match(/WriteBack\.(writeBackIfSameJob|isSameJob)\(/g) || []).length >= 4, 'painter.js 面板写回过 job 闸（≥4 处）');

  // 两个重画入口共用一份实现：只有取词方式不同，下单 / 写回 / 收尾不许再各写一遍
  ok(painter.indexOf('async function redraw(opts)') >= 0, 'painter.js 重画只有一份实现 redraw(opts)');
  ok(/function redrawFromWorkbench\(\)\s*\{\s*return redraw\(\{ byCard: false \}\);\s*\}/.test(painter),
    '「按此重画」是 redraw({ byCard: false }) 的薄入口');
  ok(/function forceRedrawByCard\(\)\s*\{\s*return redraw\(\{ byCard: true \}\);\s*\}/.test(painter),
    '「按设定卡强制重画」是 redraw({ byCard: true }) 的薄入口');
  eq((painter.match(/await enqueuePaint\(/g) || []).length, 1, 'painter.js 只有一处 enqueuePaint 调用（两个入口不再各写一遍）');
  ok(importer.indexOf('WriteBack.writeBackIfSameJob(') >= 0, 'importer.js 整理续体最终写回过 writeBackIfSameJob');
  ok(importer.indexOf('WriteBack.isSameJob(') >= 0, 'importer.js 中途早退按 isSameJob 认任务');
  ok(importer.indexOf('cancelImportJob') >= 0 && /\.abort\(\)/.test(importer), 'importer.js 关闭任务标记 cancelled 并 abort 在途请求');

  // 书记员失败不再被吞——空 catch 清掉、统一后台出口留 warn + failureEntry 留痕带 error
  ok(turn.indexOf('catch (_) { result = null; }') < 0, 'runScribe 的空 catch 已清除');
  ok((turn.match(/reportBackgroundFailure\('scribe'/g) || []).length >= 3, '书记员失败路径有 console.warn 留痕');
  ok(turn.indexOf("failureEntry('scribe'") >= 0, '书记员 tool 留痕由 failureEntry 生成（error 可归因）');
  ok(turn.indexOf("reportBackgroundFailure('compress'") >= 0, '本地压缩失败也有 warn（绝不空 catch）');
  ok(shelf.indexOf("reportBackgroundFailure('scribe'") >= 0, '自动标题失败不再静默');
  ok(settings.indexOf('书记员未启用') >= 0 && settings.indexOf('lastScribe') >= 0,
    '世界卡面板区分「未启用 / 失败」（界面口径）');
}

console.log('\n异步写回契约单测：' + (failed ? '有 ' + failed + ' 项失败' : '全部通过'));
if (failed) process.exitCode = 1;
