/*
 * 无限阅读 · sidecar · 极简 cron 解析与「下一次触发」计算
 *
 * 为什么自己写：本需求的「重启不丢」靠 SQLite，「到点触发」只要一个定时器，
 * 引一个 cron 库不划算（项目一贯零依赖）。
 *
 * 设计取舍：
 *   - 支持标准 5 字段 `分 时 日 月 周`，以及 @hourly/@daily/@midnight/@weekly/@monthly/@yearly 宏。
 *   - 时区交给 Intl.DateTimeFormat 处理（含夏令时），**不自造时区数据**。
 *   - 全为纯函数（可注入 from 时间），因此单测不需要真实时钟。
 *
 * 算法：先用 UTC 偏移把「墙上时间」算出来，在墙上时间里按分钟整数扫描找下一个匹配点，
 * 再用 Intl 把候选点换回真实 UTC 并校验偏移是否一致（夏令时切换时可能需要再收敛一次）。
 * 这样日常表达式几毫秒级出结果，也不会在夏令时边界上算错。
 */
const MACROS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const WEEK = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MINUTE = 60000;
const MAX_WALL_SCAN_MINUTES = 4 * 366 * 24 * 60;   // 4 年上限：防病态表达式（如 2 月 30 日）卡死

/* ---------------- 解析 ---------------- */

function parseField(text, min, max) {
  const set = new Set();
  for (const part of String(text).split(',')) {
    const p = part.trim();
    if (!p) throw new Error('CRON_EMPTY_FIELD');

    let step = 1;
    let range = p;
    const slash = p.indexOf('/');
    if (slash >= 0) {
      range = p.slice(0, slash);
      step = parseInt(p.slice(slash + 1), 10);
      if (!Number.isInteger(step) || step <= 0) throw new Error('CRON_BAD_STEP');
    }

    let lo;
    let hi;
    if (range === '*') {
      lo = min; hi = max;
    } else if (range.indexOf('-') >= 0) {
      const seg = range.split('-');
      lo = parseInt(seg[0], 10);
      hi = parseInt(seg[1], 10);
    } else {
      lo = parseInt(range, 10);
      hi = (slash >= 0) ? max : lo;   // "5/10" = 从 5 起每 10 步到最大
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error('CRON_BAD_NUMBER');
    if (lo < min || hi > max || lo > hi) throw new Error('CRON_OUT_OF_RANGE:' + p);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  if (!set.size) throw new Error('CRON_EMPTY_FIELD');
  return set;
}

export function parseCron(expr) {
  const raw = String(expr == null ? '' : expr).trim();
  if (!raw) throw new Error('CRON_EMPTY');
  const s = MACROS[raw.toLowerCase()] || raw;
  const f = s.split(/\s+/);
  if (f.length !== 5) throw new Error('CRON_NEEDS_5_FIELDS');

  const dowRaw = parseField(f[4], 0, 7);
  const dow = new Set();
  for (const v of dowRaw) dow.add(v === 7 ? 0 : v);   // 兼容 7=周日

  return {
    minute: parseField(f[0], 0, 59),
    hour: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31),
    month: parseField(f[3], 1, 12),
    dow,
    domRestricted: f[2].trim() !== '*',
    dowRestricted: f[4].trim() !== '*',
  };
}

/* ---------------- 时区（Intl，含夏令时） ---------------- */

const fmtCache = new Map();

function fmtFor(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz) {
  if (!tz) return false;
  try { fmtFor(tz).format(new Date(0)); return true; } catch (_) { return false; }
}

export function zonedFields(tz, ms) {
  const parts = fmtFor(tz).formatToParts(new Date(ms));
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = p.value;
  return {
    year: +o.year, month: +o.month, day: +o.day,
    hour: +o.hour, minute: +o.minute, second: +o.second,
    dow: WEEK[o.weekday] != null ? WEEK[o.weekday] : 0,
  };
}

// 该时刻的「本地墙上时间 − UTC」偏移（毫秒）
function offsetMs(tz, ms) {
  const f = zonedFields(tz, ms);
  const asUTC = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

/* ---------------- 匹配 ---------------- */

export function matchesCron(cron, f) {
  if (!cron.month.has(f.month)) return false;
  if (!cron.hour.has(f.hour)) return false;
  if (!cron.minute.has(f.minute)) return false;
  const domOk = cron.dom.has(f.day);
  const dowOk = cron.dow.has(f.dow);
  // Vixie cron 语义：日与周都受限时取「或」
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  if (cron.domRestricted) return domOk;
  if (cron.dowRestricted) return dowOk;
  return true;
}

/* 在「墙上时间」（伪 UTC 时间戳）里按分钟找下一个匹配点；纯整数运算，不碰时区 */
function scanWall(cron, wallStart) {
  const start = Math.floor(wallStart / MINUTE) * MINUTE;
  const limit = start + MAX_WALL_SCAN_MINUTES * MINUTE;
  const d = new Date(start);
  for (let t = start; t <= limit; t += MINUTE) {
    d.setTime(t);
    const month = d.getUTCMonth() + 1;
    if (!cron.month.has(month)) {
      d.setUTCFullYear(d.getUTCFullYear(), month, 1);   // month = 下一个月的 0 基下标
      d.setUTCHours(0, 0, 0, 0);
      t = d.getTime() - MINUTE;
      continue;
    }
    const day = d.getUTCDate();
    const dow = d.getUTCDay();
    const domOk = cron.dom.has(day);
    const dowOk = cron.dow.has(dow);
    const dayOk = (cron.domRestricted && cron.dowRestricted) ? (domOk || dowOk)
      : cron.domRestricted ? domOk
        : cron.dowRestricted ? dowOk
          : true;
    if (!dayOk) {
      d.setUTCHours(0, 0, 0, 0);
      t = d.getTime() + 24 * 60 * MINUTE - MINUTE;
      continue;
    }
    if (!cron.hour.has(d.getUTCHours())) {
      d.setUTCMinutes(0, 0, 0);
      t = d.getTime() + 60 * MINUTE - MINUTE;
      continue;
    }
    if (!cron.minute.has(d.getUTCMinutes())) continue;   // 交给循环 +1 分钟
    return t;
  }
  return null;
}

/*
 * 把一个「墙上时间」换回真实 UTC 时刻。
 * 夏令时里会有两种特殊情形，必须显式处理，否则会算错或死循环：
 *   - 春季跳变：该墙上时间根本不存在（如纽约 3 月某天的 02:30）→ 返回 null，由调用方跳过；
 *   - 秋季回拨：该墙上时间出现两次 → 取较早的那一次。
 * 做法：在「最近一次已知偏移」附近试几个候选偏移，只有自洽（换回去仍是同一偏移）的才算数。
 */
function utcForWall(zone, wall, guessOffset) {
  const HOUR = 3600000;
  const cands = [guessOffset, guessOffset + HOUR, guessOffset - HOUR, guessOffset + 2 * HOUR, guessOffset - 2 * HOUR];
  const found = [];
  for (const off of cands) {
    const utc = wall - off;
    if (offsetMs(zone, utc) === off) found.push(utc);
  }
  if (!found.length) return null;
  return Math.min.apply(null, found);
}

/*
 * 下一次触发时间（epoch ms）；找不到（如不可能成立的表达式）返回 null。
 * @param {string|object} cronInput 表达式或 parseCron 结果
 * @param {string} tz IANA 时区；非法则按 UTC
 * @param {number} fromMs 起点（不含），结果严格大于它
 */
export function nextRun(cronInput, tz, fromMs) {
  const cron = (typeof cronInput === 'string') ? parseCron(cronInput) : cronInput;
  const zone = (typeof tz === 'string' && isValidTimezone(tz)) ? tz : 'UTC';
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : Date.now();

  const base = offsetMs(zone, from);
  let wallStart = from + base;

  for (let i = 0; i < 1000; i++) {
    const wall = scanWall(cron, wallStart);
    if (wall == null) return null;
    const guess = offsetMs(zone, wall - base);
    const utc = utcForWall(zone, wall, guess);
    if (utc == null || utc <= from) {          // 时刻不存在，或还没超过起点
      wallStart = wall + MINUTE;
      continue;
    }
    return utc;
  }
  return null;
}
