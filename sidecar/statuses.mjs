/*
 * 无限阅读 · sidecar · 状态字面量唯一口径
 *
 * 此前 payment / scheduler / email 的状态字符串散落在 SQL 拼接里（'pending'、'pending_confirm'…），
 * 拼错一个字母就是「静默 0 行更新」。这里集中导出枚举 + SQL IN 片段构造，
 * 所有 SQL 拼接处一律引用本文件；DB 列的默认值注释也以这里为准。
 */

/* 支付交易状态：pending 待确认 → approved 已确认 → charging 扣款中 →
 * awaiting_payment 等待人工付款 | charged 已扣款；终态 denied 已拒绝 */
export const TX = {
  PENDING: 'pending',
  APPROVED: 'approved',
  CHARGING: 'charging',
  AWAITING_PAYMENT: 'awaiting_payment',
  CHARGED: 'charged',
  DENIED: 'denied',
};

// 已「占用额度」的状态（pending 不算，避免空占额度）：与 payment.mjs 的 sums/mandateSpent 同口径
export const COMMITTED_TX = [TX.APPROVED, TX.AWAITING_PAYMENT, TX.CHARGED];

/* 触发器状态：pending_confirm 待用户确认 → active 生效；paused 暂停 */
export const TRIGGER = {
  PENDING_CONFIRM: 'pending_confirm',
  ACTIVE: 'active',
  PAUSED: 'paused',
};

/* 触发记录（trigger_fires）状态：pending 占位待投递 → delivered 已投递到前端；skipped 放弃本次
 * （只写这三种：投递是一次性的，没有「已完成」这种第四态） */
export const FIRE = {
  PENDING: 'pending',
  DELIVERED: 'delivered',
  SKIPPED: 'skipped',
};

/* 邮件草稿状态：pending 待确认 → sending 发送中（同步抢占态，防双击发两封）→ sent
 * 发送失败会退回 pending（可重试 / 可丢弃）；进程被杀留下的 sending 在启动时复位 */
export const DRAFT = {
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  DISCARDED: 'discarded',
};

/* 邮件审计结果：pending = 已占位、发送中（计入当日已发，防并发突破上限） */
export const AUDIT = {
  OK: 'ok',
  PENDING: 'pending',
  DENIED: 'denied',
};

/* SQL `IN (...)` 片段：状态值都是本文件里的常量，这里只做引号转义防呆 */
export function sqlIn(list) {
  return '(' + (Array.isArray(list) ? list : [list])
    .map(s => "'" + String(s).replace(/'/g, "''") + "'")
    .join(',') + ')';
}
