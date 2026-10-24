#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 调度器单测（虚拟时钟，不联网、不落盘、不依赖真实定时器）
 *
 * 为什么必须用虚拟时钟：调度器的正确性全在「时间推进」上 ——
 * 错过触发怎么补、免打扰怎么拦、每日上限怎么算、cron 的时区与夏令时怎么落。
 * 靠真实 sleep 去等，既慢又不稳；这里把 now() 换成可推进的变量，一次性覆盖边界。
 *
 * 覆盖：
 *   - cron：5 字段校验、宏、时区（Asia/Shanghai）、夏令时跳变（America/New_York 春季跳变 / 秋季回拨）
 *   - 触发器：interval / once / cron、(user_id,name) upsert 幂等、模型新建需确认
 *   - 错过策略：SKIP / RUN_ONCE / RUN_ALL
 *   - 安全项：免打扰时段（含跨零点）、每日主动上限、一键暂停、功能总开关
 *   - 队列：pending 列表与 ack
 *
 * 用法：node eval/scheduler-test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}

function localMs(y, mo, d, h, mi) { return new Date(y, mo - 1, d, h, mi, 0, 0).getTime(); }
function localHHMM(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
const M = 60000;

async function main() {
  const mod = f => pathToFileURL(path.join(__dirname, '..', 'sidecar', f)).href;
  const cron = await import(mod('cron.mjs'));
  const { createScheduler, inQuietHours } = await import(mod('scheduler.mjs'));
  const { openDbAt } = await import(mod('db.mjs'));

  const { parseCron, nextRun } = cron;

  /* ---------------- 1. cron 解析与匹配 ---------------- */

  // 业务失败 = 结构化返回 { ok:false, code }、不 throw（审查 可维护性 #7）；code 前缀命中即算
  const fails = (fn, code) => {
    let r = null;
    try { r = fn(); } catch (_) { return false; }   // 业务失败不该抛
    return !!(r && r.ok === false && r.code && (!code || r.code === code || r.code.indexOf(code) === 0));
  };
  check('cron：5 字段必需', fails(() => parseCron('* * * *'), 'CRON_NEEDS_5_FIELDS'), '4 字段应拒绝');
  check('cron：越界拒绝', fails(() => parseCron('99 * * * *'), 'CRON_OUT_OF_RANGE'), '99 分钟应拒绝');
  check('cron：步长非法拒绝', fails(() => parseCron('*/0 * * * *'), 'CRON_BAD_STEP'), '步长 0 应拒绝');
  check('cron：@daily 宏可用', (() => { const c = parseCron('@daily'); return c.hour.has(0) && c.minute.has(0); })());

  check('cron：UTC 09:00 → 09:00Z',
    nextRun('0 9 * * *', 'UTC', Date.UTC(2026, 0, 1, 0, 0, 0)) === Date.UTC(2026, 0, 1, 9, 0, 0));
  check('cron：Asia/Shanghai 09:00 → 01:00Z（UTC+8）',
    nextRun('0 9 * * *', 'Asia/Shanghai', Date.UTC(2026, 0, 1, 0, 0, 0)) === Date.UTC(2026, 0, 1, 1, 0, 0),
    new Date(nextRun('0 9 * * *', 'Asia/Shanghai', Date.UTC(2026, 0, 1, 0, 0, 0))).toISOString());
  check('cron：*/15 从 00:00 起 → 00:15',
    nextRun('*/15 * * * *', 'UTC', Date.UTC(2026, 0, 1, 0, 0, 0)) === Date.UTC(2026, 0, 1, 0, 15, 0));
  check('cron：工作日 09:00 跳过周末（周五 → 下周一）', (() => {
    // 2026-01-02 是周五；其 09:00Z 之后下一个工作日应为 2026-01-05（周一）09:00Z
    const n = nextRun('0 9 * * 1-5', 'UTC', Date.UTC(2026, 0, 2, 9, 0, 0));
    return n === Date.UTC(2026, 0, 5, 9, 0, 0);
  })(), new Date(nextRun('0 9 * * 1-5', 'UTC', Date.UTC(2026, 0, 2, 9, 0, 0))).toISOString());

  // 夏令时：美国 2026-03-08 春季跳变，当地 02:30 不存在 → 应落到 03-09 的 02:30 EDT（06:30Z）
  const spring = nextRun('30 2 * * *', 'America/New_York', Date.UTC(2026, 2, 8, 0, 0, 0));
  check('cron：春季跳变不存在的 02:30 被跳过',
    spring === Date.UTC(2026, 2, 9, 6, 30, 0),
    spring == null ? 'null（应为 2026-03-09T06:30Z）' : new Date(spring).toISOString());
  check('cron：秋季回拨取较早一次（EDT）',
    nextRun('30 1 * * *', 'America/New_York', Date.UTC(2026, 10, 1, 0, 0, 0)) === Date.UTC(2026, 10, 1, 5, 30, 0),
    new Date(nextRun('30 1 * * *', 'America/New_York', Date.UTC(2026, 10, 1, 0, 0, 0))).toISOString());
  check('cron：不可能的表达式返回 null',
    nextRun('0 0 30 2 *', 'UTC', Date.UTC(2026, 0, 1, 0, 0, 0)) === null);
  check('cron：非法时区退回 UTC',
    nextRun('0 0 * * *', 'Not/AZone', Date.UTC(2026, 0, 1, 0, 0, 0)) === Date.UTC(2026, 0, 2, 0, 0, 0));

  /* ---------------- 2. 免打扰时段（纯函数） ---------------- */

  check('免打扰：区间内命中', inQuietHours([{ start: '09:00', end: '17:00' }], localMs(2026, 1, 1, 10, 0)) === true);
  check('免打扰：区间外不命中', inQuietHours([{ start: '09:00', end: '17:00' }], localMs(2026, 1, 1, 18, 0)) === false);
  check('免打扰：跨零点内命中', inQuietHours([{ start: '22:00', end: '07:00' }], localMs(2026, 1, 1, 23, 30)) === true);
  check('免打扰：跨零点外不命中', inQuietHours([{ start: '22:00', end: '07:00' }], localMs(2026, 1, 1, 12, 0)) === false);

  /* ---------------- 3. 调度器（虚拟时钟） ---------------- */

  let VNOW = Date.UTC(2026, 0, 1, 0, 0, 0);

  function fresh(opts) {
    const o = opts || {};
    const db = openDbAt(':memory:');
    const cfg = {
      schedule: {
        enabled: o.enabled === undefined ? true : o.enabled,
        paused: !!o.paused,
        quietHours: o.quiet || [],
        dailyCap: o.cap || 0,
        missedPolicy: o.missedPolicy || 'SKIP',
      },
    };
    const events = [];
    const sched = createScheduler({
      db: db,
      getConfig: () => cfg,
      emit: (e, d) => events.push({ e: e, d: d }),
      now: () => VNOW,
      startLoop: false,          // 不用真实定时器
    });
    return { db: db, cfg: cfg, events: events, s: sched };
  }

  const mk = (s, name, type, spec, extra) => s.upsertTrigger(Object.assign(
    { name: name, type: type, spec: spec, source: 'user', prompt: 'p', reason: 'r' }, extra || {}
  ));

  // 3.1 interval 基本推进
  {
    VNOW = Date.UTC(2026, 0, 1, 0, 0, 0);
    const { s } = fresh({});
    const t = mk(s, 'hb', 'interval', { everyMs: M });
    check('interval：nextAt = now + everyMs', t.nextAt === VNOW + M, t.nextAt);
    check('interval：未到点不触发', s.tick().fired === 0);
    VNOW += M;
    const r = s.tick();
    check('interval：到点触发一次', r.fired === 1, JSON.stringify(r));
    check('interval：触发后推到下一轮', s.getTrigger(t.id).nextAt === VNOW + M, s.getTrigger(t.id).nextAt);
  }

  // 3.2 (user_id, name) upsert 幂等
  {
    const { s } = fresh({});
    mk(s, 'same', 'interval', { everyMs: M });
    const n1 = s.listTriggers().length;
    mk(s, 'same', 'interval', { everyMs: 5 * M });
    const list = s.listTriggers();
    check('upsert：同名不新增记录', list.length === n1, list.length + ' vs ' + n1);
    check('upsert：同名更新 spec', list[0].spec.everyMs === 5 * M, JSON.stringify(list[0].spec));
  }

  // 3.3 模型新建需确认；未确认不触发
  {
    VNOW = Date.UTC(2026, 0, 1, 0, 0, 0);
    const { s, events } = fresh({});
    const t = s.upsertTrigger({ name: 'mdl', type: 'interval', spec: { everyMs: M }, source: 'model', prompt: 'p', reason: 'r' });
    check('模型新建 = pending_confirm', t.status === 'pending_confirm', t.status);
    VNOW += M;
    s.tick();
    const firedIds = events.filter(x => x.e === 'trigger.fire').map(x => x.d.triggerId);
    check('未确认的触发器不触发', firedIds.indexOf(t.id) < 0);
    const c = s.confirmTrigger(t.id);
    check('confirm 后变 active 且有 nextAt', c.status === 'active' && c.nextAt != null);
  }

  // 3.4 错过策略：SKIP / RUN_ONCE / RUN_ALL
  {
    VNOW = Date.UTC(2026, 0, 1, 0, 0, 0);
    const a = fresh({ missedPolicy: 'SKIP' });
    mk(a.s, 'x', 'interval', { everyMs: M });
    VNOW += 5 * M;
    const ra = a.s.tick();
    check('SKIP：不补跑', ra.fired === 0, JSON.stringify(ra));
    check('SKIP：无 pending', a.s.listPending().length === 0);

    VNOW = Date.UTC(2026, 0, 1, 0, 0, 0);
    const b = fresh({ missedPolicy: 'RUN_ONCE' });
    mk(b.s, 'x', 'interval', { everyMs: M });
    VNOW += 5 * M;
    check('RUN_ONCE：只补一次', b.s.tick().fired === 1);

    VNOW = Date.UTC(2026, 0, 1, 0, 0, 0);
    const c = fresh({ missedPolicy: 'RUN_ALL' });
    mk(c.s, 'x', 'interval', { everyMs: M });
    VNOW += 5 * M;
    const rc = c.s.tick();
    check('RUN_ALL：补齐全部错过（5 次）', rc.fired === 5, JSON.stringify(rc));
  }

  // 3.5 免打扰：到点落在免打扰窗口 → 不产生 pending
  {
    VNOW = localMs(2026, 1, 1, 12, 0);
    const win = [{ start: '12:00', end: '13:00' }];
    const { s } = fresh({ quiet: win });
    mk(s, 'q', 'interval', { everyMs: M });
    VNOW += M;
    const r = s.tick();
    check('免打扰：拦截触发（无 pending）', r.fired === 0 && s.listPending().length === 0, JSON.stringify(r));
    check('免打扰：当前本地时间确在窗口内', inQuietHours(win, VNOW) === true, localHHMM(VNOW));
  }

  // 3.6 每日主动上限
  {
    VNOW = localMs(2026, 1, 1, 12, 0);
    const { s } = fresh({ cap: 1 });
    mk(s, 'd', 'interval', { everyMs: M });
    VNOW += M; const r1 = s.tick();
    VNOW += M; const r2 = s.tick();
    check('每日上限：第 1 条放行', r1.fired === 1, JSON.stringify(r1));
    check('每日上限：第 2 条被拦', r2.fired === 0, JSON.stringify(r2));
    check('每日上限：pending 只有 1 条', s.listPending().length === 1, s.listPending().length);
  }

  // 3.7 一键暂停 / 功能总开关
  {
    VNOW = localMs(2026, 1, 1, 12, 0);
    const { s, cfg } = fresh({});
    const t = mk(s, 'p', 'interval', { everyMs: M });
    const before = s.getTrigger(t.id).nextAt;
    cfg.schedule.paused = true;
    VNOW += M;
    const r = s.tick();
    check('暂停：不触发', r.fired === 0, JSON.stringify(r));
    check('暂停：nextAt 不推进（恢复后继续）', s.getTrigger(t.id).nextAt === before);

    cfg.schedule.paused = false;
    cfg.schedule.enabled = false;
    VNOW += M;
    check('总开关关闭：不触发', s.tick().fired === 0);
  }

  // 3.8 once 触发器：跑一次即停用
  {
    VNOW = localMs(2026, 1, 1, 12, 0);
    const { s } = fresh({});
    const t = s.upsertTrigger({ name: 'o', type: 'once', spec: { at: VNOW + M }, source: 'user', prompt: 'p', reason: 'r' });
    check('once：nextAt = at', t.nextAt === VNOW + M);
    VNOW += M;
    check('once：触发一次', s.tick().fired === 1);
    const after = s.getTrigger(t.id);
    check('once：触发后停用且无下次', after.enabled === false && after.nextAt === null, JSON.stringify({ e: after.enabled, n: after.nextAt }));
  }

  // 3.9 cron 触发器 + pending 队列 ack
  {
    VNOW = Date.UTC(2026, 0, 1, 0, 0, 0);
    const { s, events } = fresh({});
    const t = s.upsertTrigger({ name: 'c', type: 'cron', spec: { expr: '*/15 * * * *', tz: 'UTC' }, source: 'user', prompt: '写封信', reason: '每周问候' });
    check('cron：nextAt = 00:15Z', t.nextAt === Date.UTC(2026, 0, 1, 0, 15, 0), new Date(t.nextAt).toISOString());
    VNOW = Date.UTC(2026, 0, 1, 0, 15, 0);
    check('cron：到点触发', s.tick().fired === 1);

    const evt = events.find(x => x.e === 'trigger.fire');
    check('cron：广播 trigger.fire 且带触发原因', !!evt && evt.d.reason === '每周问候' && evt.d.prompt === '写封信');

    const pend = s.listPending();
    check('pending：队列有记录', pend.length === 1, JSON.stringify(pend));
    check('pending：ack 成功', s.ackPending(pend[0].id) === true);
    check('pending：ack 后不再排队', s.listPending().length === 0);
    check('pending：ack 幂等（重复 ack = false）', s.ackPending(pend[0].id) === false);
  }

  // 3.10 非法规格被拒（业务失败返回 fail(code)：不 throw、不落库）
  {
    const { s } = fresh({});
    check('规格：interval 小于 1 分钟被拒', fails(() => mk(s, 'bad', 'interval', { everyMs: 1000 }), 'INTERVAL_NEEDS_EVERYMS_MIN_1_MINUTE'));
    check('规格：cron 表达式非法被拒', fails(() => mk(s, 'bad2', 'cron', { expr: 'nope' }), 'CRON_'));
    check('规格：once 缺 at 被拒', fails(() => mk(s, 'bad3', 'once', {}), 'ONCE_NEEDS_AT'));
    check('规格：未知类型被拒', fails(() => mk(s, 'bad4', 'weird', {}), 'BAD_TRIGGER_TYPE'));
    check('规格：失败的 upsert 不落库', s.listTriggers().length === 0, s.listTriggers().length + ' 条');
  }

  /* ---------------- 汇总 ---------------- */

  const pass = results.filter(r => r.hit).length;
  const total = results.length;
  for (const r of results) {
    console.log((r.hit ? '  ✔ ' : '  ✘ ') + r.name + (r.hit || !r.detail ? '' : '   → ' + r.detail));
  }
  console.log('\n调度器单测：' + pass + '/' + total + ' 通过');
  if (pass !== total) process.exitCode = 1;
}

main().catch(e => {
  console.error('测试异常：', e);
  process.exitCode = 1;
});
