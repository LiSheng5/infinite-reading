/*
 * 无限阅读 · sidecar · 调度器（模型主动行动的「到点触发」）
 *
 * 职责：
 *   - 触发器 CRUD（用 (user_id, name) upsert，避免重复创建）；
 *   - 滚动排程：只维护一个定时器，指向最近的 next_at（不是每触发器一个定时器）；
 *   - 错过触发的三种策略：SKIP / RUN_ONCE / RUN_ALL；
 *   - 到点写入 trigger_fires（pending）并广播 trigger.fire，由前端走与原用户消息相同的流程；
 *   - 落地「免打扰时段 / 每日主动消息上限 / 一键暂停」——全部读自 config（模型改不了）。
 *
 * 为什么把 now / emit / startLoop 做成可注入：单测要用虚拟时钟，不碰真实定时器。
 * 单进程：由 server.mjs 的锁文件 + 端口占用保证；本地触发只有侧车一个真源，多标签页前端不会重复触发。
 */
import { nextRun, parseCron, isValidTimezone } from './cron.mjs';
import { genId, safeJSON, dayRange, fail, isFail } from './util.mjs';
import { TRIGGER, FIRE, sqlIn } from './statuses.mjs';

const USER_ID = 'local';
const MIN_INTERVAL_MS = 60 * 1000;          // 心跳最小 1 分钟，防抖
const MAX_INTERVAL_MS = 365 * 24 * 3600 * 1000;
const MAX_CATCHUP = 50;                     // RUN_ALL 补跑上限，防雪崩
const TICK_CLAMP_MS = 60 * 1000;            // 滚动定时器最长 60s 醒一次（防系统休眠错过大跨度）
const MISFIRE_THRESHOLD_MS = 60 * 1000;     // 迟到不超过这个量级算「准点」，不算「错过」

function minutesOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

export function inQuietHours(quiet, ms) {
  if (!Array.isArray(quiet) || !quiet.length) return false;
  const cur = minutesOfDay(ms);
  for (const w of quiet) {
    const [sh, sm] = String(w.start).split(':').map(Number);
    const [eh, em] = String(w.end).split(':').map(Number);
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) continue;
    if (s < e) { if (cur >= s && cur < e) return true; }
    else if (cur >= s || cur < e) return true;      // 跨零点
  }
  return false;
}

/* ---------------- 规格归一化 ----------------
 * 业务失败一律返回 fail(code)（审查 可维护性 #7）；编程错误才 throw。 */

export function normalizeSpec(type, spec) {
  const s = (spec && typeof spec === 'object') ? spec : {};
  if (type === 'once') {
    const at = Number(s.at);
    if (!Number.isFinite(at) || at <= 0) return fail('ONCE_NEEDS_AT');
    return { at: Math.floor(at) };
  }
  if (type === 'interval') {
    const every = Math.floor(Number(s.everyMs));
    if (!Number.isFinite(every) || every < MIN_INTERVAL_MS) return fail('INTERVAL_NEEDS_EVERYMS_MIN_1_MINUTE');
    return { everyMs: Math.min(every, MAX_INTERVAL_MS) };
  }
  if (type === 'cron') {
    const expr = String(s.expr || '').trim();
    const tz = String(s.tz || '').trim();
    const parsed = parseCron(expr);                    // 非法返回 fail（CRON_*）
    if (isFail(parsed)) return parsed;
    if (tz && !isValidTimezone(tz)) return fail('BAD_TIMEZONE');
    return { expr, tz: tz || 'UTC' };
  }
  return fail('BAD_TRIGGER_TYPE');
}

// 下一次到点时间；null = 不再有下一次（一次性 / 不可能的表达式）
function computeNext(type, spec, fromMs) {
  if (type === 'once') return null;
  if (type === 'interval') return fromMs + spec.everyMs;
  if (type === 'cron') {
    try { return nextRun(spec.expr, spec.tz, fromMs); } catch (_) { return null; }
  }
  return null;
}

function initialNext(type, spec, fromMs) {
  if (type === 'once') return spec.at;
  return computeNext(type, spec, fromMs);
}

/* ---------------- 调度器 ---------------- */

export function createScheduler(deps) {
  const db = deps.db;
  const getConfig = deps.getConfig || (() => ({}));
  const emit = deps.emit || (() => 0);
  const now = deps.now || (() => Date.now());
  const startLoop = deps.startLoop !== false;

  let timer = null;
  let stopped = false;

  const toTrigger = row => row ? ({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    type: row.type,
    spec: safeJSON(row.spec, {}),
    channel: row.channel,
    prompt: row.prompt,
    reason: row.reason,
    enabled: !!row.enabled,
    status: row.status,
    nextAt: row.next_at == null ? null : Number(row.next_at),
    lastAt: row.last_at == null ? null : Number(row.last_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }) : null;

  function findByName(name) {
    return db.prepare('SELECT * FROM triggers WHERE user_id = ? AND name = ?').get(USER_ID, name);
  }

  function insertFire(triggerId, dueAt, status, reason, at) {
    const id = genId('f');
    db.prepare(
      'INSERT INTO trigger_fires (id, trigger_id, due_at, status, reason, claimed_at, delivered_at) VALUES (?,?,?,?,?,?,?)'
    ).run(id, triggerId, dueAt, status, reason || '', status === FIRE.PENDING ? null : at, null);
    return { id, dueAt, status };
  }

  function deliveredToday(t0) {
    const [d0, d1] = dayRange(t0);
    const r = db.prepare(
      'SELECT COUNT(*) AS n FROM trigger_fires WHERE status IN ' + sqlIn([FIRE.PENDING, FIRE.DELIVERED, FIRE.DONE]) + ' AND due_at >= ? AND due_at < ?'
    ).get(d0, d1);
    return (r && r.n) || 0;
  }

  // 从 dueAt 起、到 t0 为止「本该跑」的时刻（含 dueAt），最多 MAX_CATCHUP 个
  function missedTimes(trigger, dueAt, t0) {
    const out = [];
    const spec = trigger.spec;
    if (trigger.type === 'once') return dueAt <= t0 ? [dueAt] : [];
    if (trigger.type === 'interval') {
      const every = spec.everyMs;
      for (let t = dueAt; t <= t0 && out.length < MAX_CATCHUP; t += every) out.push(t);
      return out;
    }
    if (trigger.type === 'cron') {
      let t = dueAt;
      while (t != null && t <= t0 && out.length < MAX_CATCHUP) {
        out.push(t);
        try { t = nextRun(spec.expr, spec.tz, t); } catch (_) { t = null; }
      }
      return out;
    }
    return out;
  }

  function handleDue(trigger, t0, sched) {
    const policy = sched.missedPolicy || 'SKIP';
    const dueAt = trigger.nextAt;
    const quiet = sched.quietHours || [];
    const cap = Number(sched.dailyCap) || 0;

    let times = [];
    let skippedReason = '';
    if (t0 - dueAt <= MISFIRE_THRESHOLD_MS) {
      times = [dueAt];                                   // 准点（或仅迟一点点）：正常跑一次
    } else {
      // 真的错过了（进程停摆 / 系统休眠）：才按 missedPolicy 处理
      const all = missedTimes(trigger, dueAt, t0);
      if (policy === 'RUN_ALL') times = all;
      else if (policy === 'RUN_ONCE') times = all.length ? [all[all.length - 1]] : [];
      else skippedReason = 'missed_skip';                // SKIP：留痕，不打扰
    }
    if (skippedReason) insertFire(trigger.id, dueAt, FIRE.SKIPPED, skippedReason, t0);

    let fired = 0;
    let today = deliveredToday(t0);

    for (const t of times) {
      if (inQuietHours(quiet, t)) { insertFire(trigger.id, t, FIRE.SKIPPED, 'quiet_hours', t0); continue; }
      if (cap > 0 && today >= cap) { insertFire(trigger.id, t, FIRE.SKIPPED, 'daily_cap', t0); continue; }
      const fire = insertFire(trigger.id, t, FIRE.PENDING, 'due', t0);
      today += 1;
      fired += 1;
      emit('trigger.fire', {
        fireId: fire.id,
        triggerId: trigger.id,
        name: trigger.name,
        prompt: trigger.prompt,
        reason: trigger.reason,
        channel: trigger.channel,
        dueAt: t,
      });
    }

    const next = computeNext(trigger.type, trigger.spec, t0);
    db.prepare('UPDATE triggers SET next_at = ?, last_at = ?, updated_at = ?, enabled = ? WHERE id = ?')
      .run(next == null ? null : next, t0, t0, (next == null ? 0 : 1), trigger.id);

    return { fired, next };
  }

  /* ---- 对外 API ---- */

  function listTriggers() {
    return db.prepare('SELECT * FROM triggers ORDER BY created_at ASC').all().map(toTrigger);
  }

  function getTrigger(id) {
    return toTrigger(db.prepare('SELECT * FROM triggers WHERE id = ?').get(String(id || '')));
  }

  /*
   * 按 (user_id, name) upsert。
   * source='model'（默认）：新建后是 pending_confirm，需用户在界面上确认才生效；
   * source='user'：用户在界面上自己建的，直接 active。
   * 业务失败返回 fail(code)（审查 可维护性 #7），成功返回触发器对象。
   */
  function upsertTrigger(input) {
    const src = (input && typeof input === 'object') ? input : {};
    const name = String(src.name || '').trim();
    if (!name) return fail('NAME_REQUIRED');
    const type = String(src.type || '').trim();
    const spec = normalizeSpec(type, src.spec);
    if (isFail(spec)) return spec;
    const t0 = now();
    const source = src.source === 'user' ? 'user' : 'model';

    const existing = findByName(name);
    const status = existing ? existing.status : (source === 'model' ? TRIGGER.PENDING_CONFIRM : TRIGGER.ACTIVE);
    const enabled = src.enabled === undefined ? 1 : (src.enabled ? 1 : 0);
    const channel = String(src.channel || '').slice(0, 200);
    const prompt = String(src.prompt || '').slice(0, 4000);
    const reason = String(src.reason || '').slice(0, 500);
    const nextAt = (status === 'active' && enabled) ? initialNext(type, spec, t0) : null;

    if (existing) {
      db.prepare(
        'UPDATE triggers SET type=?, spec=?, channel=?, prompt=?, reason=?, enabled=?, next_at=?, updated_at=? WHERE id=?'
      ).run(type, JSON.stringify(spec), channel, prompt, reason, enabled, nextAt, t0, existing.id);
    } else {
      db.prepare(
        'INSERT INTO triggers (id, user_id, name, type, spec, channel, prompt, reason, enabled, status, next_at, last_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(genId('t'), USER_ID, name, type, JSON.stringify(spec), channel, prompt, reason, enabled, status, nextAt, null, t0, t0);
    }

    const saved = getTrigger(findByName(name).id);
    emit('trigger.changed', { id: saved.id, name: saved.name, status: saved.status, action: existing ? 'updated' : 'created' });
    try { arm(); } catch (_) { /* 排程失败不影响已保存的触发器；下一次 upsert/start 再布防 */ }
    return saved;
  }

  function confirmTrigger(id) {
    const trg = getTrigger(id);
    if (!trg) return fail('TRIGGER_NOT_FOUND');
    const t0 = now();
    const next = initialNext(trg.type, trg.spec, t0);
    db.prepare('UPDATE triggers SET status=?, enabled=1, next_at=?, updated_at=? WHERE id=?')
      .run(TRIGGER.ACTIVE, next, t0, trg.id);
    const saved = getTrigger(trg.id);
    emit('trigger.changed', { id: saved.id, name: saved.name, status: saved.status, action: 'confirmed' });
    try { arm(); } catch (_) { /* 排程失败不影响已保存的触发器；下一次 upsert/start 再布防 */ }
    return saved;
  }

  function cancelTrigger(id) {
    const trg = getTrigger(id);
    if (!trg) return false;
    db.prepare('DELETE FROM triggers WHERE id = ?').run(trg.id);
    emit('trigger.changed', { id: trg.id, name: trg.name, status: 'cancelled', action: 'cancelled' });
    try { arm(); } catch (_) { /* 排程失败不影响已保存的触发器；下一次 upsert/start 再布防 */ }
    return true;
  }

  function listPending() {
    // 连上触发器一起取：前端要拿 prompt 才能合成「入站消息」，拿 name/reason 才能标注「为什么找你」
    return db.prepare(
      'SELECT f.id, f.trigger_id, f.due_at, f.status, f.reason, t.name, t.prompt, t.channel '
      + 'FROM trigger_fires f LEFT JOIN triggers t ON t.id = f.trigger_id '
      + 'WHERE f.status=? ORDER BY f.due_at ASC'
    ).all(FIRE.PENDING).map(r => ({
      id: r.id,
      triggerId: r.trigger_id,
      dueAt: Number(r.due_at),
      reason: r.reason,
      status: r.status,
      name: r.name || '',
      prompt: r.prompt || '',
      channel: r.channel || '',
    }));
  }

  function ackPending(id) {
    const t0 = now();
    const info = db.prepare('UPDATE trigger_fires SET status=?, delivered_at=? WHERE id=? AND status=?')
      .run(FIRE.DELIVERED, t0, String(id || ''), FIRE.PENDING);
    return info.changes > 0;
  }

  /* 处理所有已到点的触发器（幂等；虚拟时钟测试直接调它） */
  function tick() {
    if (stopped) return { fired: 0, due: 0 };
    const cfg = getConfig() || {};
    const sched = cfg.schedule || {};
    if (!sched.enabled || sched.paused) return { fired: 0, due: 0 };

    const t0 = now();
    const rows = db.prepare(
      'SELECT * FROM triggers WHERE status=? AND enabled=1 AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at ASC'
    ).all(TRIGGER.ACTIVE, t0);

    let fired = 0;
    for (const row of rows) fired += handleDue(toTrigger(row), t0, sched).fired;
    return { fired, due: rows.length };
  }

  /* 滚动定时器：只在「最近一个 next_at」上设一个 timer；若无触发器则不动 */
  function arm() {
    if (!startLoop || stopped) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const cfg = getConfig() || {};
    const sched = cfg.schedule || {};
    if (!sched.enabled || sched.paused) return;

    const row = db.prepare(
      'SELECT MIN(next_at) AS n FROM triggers WHERE status=? AND enabled=1 AND next_at IS NOT NULL'
    ).get(TRIGGER.ACTIVE);
    const at = (row && row.n != null) ? Number(row.n) : null;
    if (at == null) return;

    const delay = Math.max(50, Math.min(at - now(), TICK_CLAMP_MS));
    timer = setTimeout(() => {
      timer = null;
      try { tick(); } catch (_) { /* 单次失败不拖垮调度循环 */ }
      // arm() 也要在 try 里（审查 中危 #15）：这里抛出没人接，一次 DB 抖动就能让调度循环静默停摆
      try {
        arm();
      } catch (_) {
        try { timer = setTimeout(() => { timer = null; try { arm(); } catch (_) {} }, 30000); } catch (_) {}
      }
    }, delay);
  }

  function start() {
    stopped = false;
    try { tick(); } catch (_) {}     // 启动即按 missed 策略处理停摆期间错过的触发
    try { arm(); } catch (_) {}
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  return {
    start,
    stop,
    refresh: arm,
    tick,
    listTriggers,
    getTrigger,
    upsertTrigger,
    confirmTrigger,
    cancelTrigger,
    listPending,
    ackPending,
    stats() {
      const cfg = getConfig() || {};
      const sched = cfg.schedule || {};
      return {
        enabled: !!sched.enabled,
        paused: !!sched.paused,
        missedPolicy: sched.missedPolicy || 'SKIP',
        triggers: db.prepare('SELECT COUNT(*) AS n FROM triggers').get().n,
        active: db.prepare('SELECT COUNT(*) AS n FROM triggers WHERE status=? AND enabled=1').get(TRIGGER.ACTIVE).n,
        pending: db.prepare('SELECT COUNT(*) AS n FROM trigger_fires WHERE status=?').get(FIRE.PENDING).n,
        deliveredToday: deliveredToday(now()),   // 键名与函数对齐（审查 可维护性 #12：原 firedToday 实取 deliveredToday）
      };
    },
  };
}
