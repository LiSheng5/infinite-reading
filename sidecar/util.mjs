/*
 * 无限阅读 · sidecar 通用小工具（ID 生成 / 日期口径 / JSON 解析收敛）
 *
 * 此前 genId / dayKey / safeJSON 在 payment / email / scheduler 各一份拷贝、num 在
 * payment-policy / payment / config 各一份、列表条数（SQL LIMIT）在 email / payment 各夹一遍
 * ——「修口径要改多处」。这里收敛为单一实现（num / clampInt），各模块 import。
 *
 * 错误风格唯一约定：
 *   - 业务失败（输入不合法 / 策略拒绝 / 资源不存在）→ 返回 fail(code) 的 { ok:false, code, message }，不 throw；
 *   - 编程错误（DB 抛出、违反不变量）→ throw，由 server.mjs 的 catch 统一兜成 500。
 * 不要再混用 throw Error('CODE') / {ok:false} / 中文 message 三套。
 */
import crypto from 'node:crypto';

/* 业务失败的结构化返回（成功返回领域对象或 {ok:true,…}；判失败用 isFail） */
export function fail(code, message) {
  const out = { ok: false, code: String(code || 'INTERNAL') };
  if (message) out.message = String(message);
  return out;
}
export function isFail(r) { return !!(r && r.ok === false && r.code); }

// ID：前缀 + 时间戳（base36）+ 4 字节随机（hex）。前缀区分实体（tx/pi/md/f/t/a/d…）。
export function genId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// 安全 JSON 解析：解析成功且为对象 / 数组则返回，否则回落 fallback（不抛）。
// 统一为「非空对象」口径——当前所有调用点（spec / items / categories）存的都是对象或数组。
export function safeJSON(text, fallback) {
  try {
    const v = JSON.parse(text);
    return (v && typeof v === 'object') ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

// 本地日期键：YYYY-MM-DD（按天聚合的唯一口径）
export function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 本地月份键：YYYY-MM（按月聚合）
export function monthKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// 本地日/月区间 [start, end)（毫秒）。与 dayKey / monthKey 的本地口径一致，
// 供 SQL 的 `at >= ? AND at < ?` 做范围聚合（不再全表 SELECT 后 JS 过滤）。
export function dayRange(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  const e = new Date(start);
  e.setDate(e.getDate() + 1);
  return [start, e.getTime()];
}

export function monthRange(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  const start = d.getTime();
  const e = new Date(start);
  e.setMonth(e.getMonth() + 1);
  return [start, e.getTime()];
}

// 正整数夹取：非有限 / 负数 / 0 一律归 0（额度类字段的统一口径）
export function num(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 列表条数归一（SQL LIMIT 的唯一口径）：非有限 / 非正数 → dflt，正数夹到 max。
// 与 num 的区别是「有默认值 + 有上限」；dflt 只按 num 归一、不再夹 max
// （各调用点的默认值本来就按自己的上限选过）。
export function clampInt(v, dflt, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return num(dflt);
  return Math.min(n, num(max) || 1);
}
