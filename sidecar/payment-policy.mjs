/*
 * 无限阅读 · sidecar · 支付策略引擎（纯函数，便于边界单测）
 *
 * 核心原则：模型永远拿不到任何支付凭证，只能提交「购买意图」；策略在代码层强制。
 * 但必须诚实说明：这是**防误操作 + 可审计**，不是「防你自己」——
 * 用户拥有本机文件，理论上可以改配置或代码绕过（见 SECURITY.md）。
 *
 * 裁决顺序（安全优先）：
 *   金额合法 → 总开关 → 商户黑名单 → 商户白名单 → 品类白名单 → 品类黑名单 →
 *   单笔上限 → 每日上限 → 每月上限 → agent 预算隔离 → 长期授权范围(mandate) →
 *   冷静期 → 免确认小额阈值（≤ 阈值直接放行）→ 否则需要人工批准
 *
 * 注：计划里把「免确认阈值」排在冷静期 / 预算之前。这里**有意调到后面**——
 * 否则小额免确认可以绕过每日 / 每月上限与预算隔离（重复小额下单就能刷爆），
 * 那是真实的口子，不是优化。此偏离在阶段说明中已标注。
 */

export const PAYMENT_CODES = [
  'GATEWAY_DISABLED',
  'BAD_AMOUNT',
  'MERCHANT_NOT_ALLOWED',
  'CATEGORY_BLOCKED',
  'AMOUNT_EXCEEDS_LIMIT',
  'DAILY_LIMIT_EXCEEDED',
  'MONTHLY_LIMIT_EXCEEDED',
  'BUDGET_EXCEEDED',
  'MANDATE_NOT_FOUND',
  'MANDATE_EXCEEDED',
  'COOLDOWN_ACTIVE',
  'USER_REJECTED',
  'PROVIDER_ERROR',
  'INTENT_NOT_FOUND',
  'INTENT_ALREADY_RESOLVED',
];

function deny(code, message, extra) {
  return Object.assign({ decision: 'deny', code: code, message: message }, extra || {});
}
function approval(message, extra) {
  return Object.assign({ decision: 'approval', code: 'NEEDS_APPROVAL', message: message }, extra || {});
}
function allow(message, extra) {
  return Object.assign({ decision: 'allow', code: '', message: message }, extra || {});
}

function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function listHas(arr, v) {
  const t = norm(v);
  return (Array.isArray(arr) ? arr : []).some(x => norm(x) === t);
}
function num(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function remainder(limit, spent) { return Math.max(0, limit - spent); }

/*
 * @param {object} input { amountCents, merchant, category, agent }
 * @param {object} ctx {
 *   config,            // payment 配置段
 *   spentDaily, spentMonthly, spentAgent,
 *   lastChargeAt,      // 最近一次成功扣款时间（冷静期用）
 *   now,               // 当前时间
 *   mandate,           // 可选：长期授权范围 { totalLimitCents, categories, spent }
 * }
 */
export function evaluatePolicy(input, ctx) {
  const in_ = input || {};
  const c = ctx || {};
  const p = c.config || {};
  const now = Number(c.now) || 0;

  const amount = Math.floor(Number(in_.amountCents));
  if (!Number.isFinite(amount) || amount <= 0) {
    return deny('BAD_AMOUNT', '金额必须大于 0（单位：分）。');
  }

  if (!p.enabled) return deny('GATEWAY_DISABLED', '购物支付功能未开启（默认关闭，需在设置里手动打开）。');

  // ---- 商户 ----
  if (listHas(p.merchantBlocklist, in_.merchant)) {
    return deny('MERCHANT_NOT_ALLOWED', '商户「' + in_.merchant + '」在黑名单里。');
  }
  const merchantAllow = Array.isArray(p.merchantAllowlist) ? p.merchantAllowlist : [];
  if (merchantAllow.length && !listHas(merchantAllow, in_.merchant)) {
    return deny('MERCHANT_NOT_ALLOWED', '商户「' + in_.merchant + '」不在白名单里。');
  }

  // ---- 品类 ----
  if (listHas(p.categoryBlocklist, in_.category)) {
    return deny('CATEGORY_BLOCKED', '品类「' + in_.category + '」在黑名单里。');
  }
  const categoryAllow = Array.isArray(p.categoryAllowlist) ? p.categoryAllowlist : [];
  if (categoryAllow.length && !listHas(categoryAllow, in_.category)) {
    return deny('CATEGORY_BLOCKED', '品类「' + in_.category + '」不在白名单里。');
  }

  // ---- 单笔 ----
  const perTx = num(p.perTx);
  if (perTx <= 0) {
    return deny('AMOUNT_EXCEEDS_LIMIT', '单笔上限为 0（默认保守值），请先在设置里调大。');
  }
  if (amount > perTx) {
    return deny('AMOUNT_EXCEEDS_LIMIT', '单笔 ' + amount + ' 分超过单笔上限 ' + perTx + ' 分。');
  }

  // ---- 每日 ----
  const daily = num(p.daily);
  const spentDaily = num(c.spentDaily);
  if (daily <= 0) return deny('DAILY_LIMIT_EXCEEDED', '每日上限为 0（默认保守值）。');
  if (spentDaily + amount > daily) {
    return deny('DAILY_LIMIT_EXCEEDED',
      '今日已用 ' + spentDaily + ' 分，这笔 ' + amount + ' 分会超过每日上限 ' + daily + ' 分（剩余 ' + remainder(daily, spentDaily) + ' 分）。');
  }

  // ---- 每月 ----
  const monthly = num(p.monthly);
  const spentMonthly = num(c.spentMonthly);
  if (monthly <= 0) return deny('MONTHLY_LIMIT_EXCEEDED', '每月上限为 0（默认保守值）。');
  if (spentMonthly + amount > monthly) {
    return deny('MONTHLY_LIMIT_EXCEEDED',
      '本月已用 ' + spentMonthly + ' 分，这笔 ' + amount + ' 分会超过每月上限 ' + monthly + ' 分（剩余 ' + remainder(monthly, spentMonthly) + ' 分）。');
  }

  // ---- 不同 agent 的预算隔离（配了 budgets 就必须按 agent 记账） ----
  const budgets = (p.budgets && typeof p.budgets === 'object') ? p.budgets : {};
  const budgetKeys = Object.keys(budgets);
  if (budgetKeys.length) {
    const agent = String(in_.agent || '').trim();
    if (!agent || !Object.prototype.hasOwnProperty.call(budgets, agent)) {
      return deny('BUDGET_EXCEEDED', '发起方「' + (agent || '未指定') + '」没有独立预算，不能下单。');
    }
    const cap = num(budgets[agent]);
    const spentAgent = num(c.spentAgent);
    if (cap <= 0) return deny('BUDGET_EXCEEDED', '发起方「' + agent + '」的预算为 0。');
    if (spentAgent + amount > cap) {
      return deny('BUDGET_EXCEEDED',
        '发起方「' + agent + '」已用 ' + spentAgent + ' 分，这笔会超过它的预算 ' + cap + ' 分（剩余 ' + remainder(cap, spentAgent) + ' 分）。');
    }
  }

  // ---- 长期授权范围（总量 / 品类） ----
  if (c.mandate) {
    const m = c.mandate;
    if (m.totalLimitCents > 0) {
      const spent = num(m.spent);
      if (spent + amount > m.totalLimitCents) {
        return deny('MANDATE_EXCEEDED',
          '授权范围总额度 ' + m.totalLimitCents + ' 分已用 ' + spent + ' 分，这笔会超出（剩余 ' + remainder(m.totalLimitCents, spent) + ' 分）。');
      }
    }
    const mCat = Array.isArray(m.categories) ? m.categories : [];
    if (mCat.length && !listHas(mCat, in_.category)) {
      return deny('CATEGORY_BLOCKED', '品类「' + in_.category + '」不在这次授权范围里。');
    }
  }

  // ---- 冷静期（连续下单的刹车，必须早于免确认） ----
  const cooldownMin = num(p.cooldownMin);
  const last = Number(c.lastChargeAt) || 0;
  if (cooldownMin > 0 && last > 0 && now - last < cooldownMin * 60000) {
    const waitMin = Math.ceil((cooldownMin * 60000 - (now - last)) / 60000);
    return deny('COOLDOWN_ACTIVE', '刚下过一单，冷静期内还需等 ' + waitMin + ' 分钟。');
  }

  // ---- 免确认小额阈值 ----
  const autoApprove = num(p.autoApprove);
  if (autoApprove > 0 && amount <= autoApprove) {
    return allow('金额 ' + amount + ' 分在免确认阈值 ' + autoApprove + ' 分内，自动放行。', {
      remaining: { perTx: remainder(perTx, amount), daily: remainder(daily, spentDaily + amount), monthly: remainder(monthly, spentMonthly + amount) },
    });
  }

  return approval('需要人工确认：金额 ' + amount + ' 分' + (autoApprove > 0 ? ' 超过免确认阈值 ' + autoApprove + ' 分' : '（未设置免确认阈值）') + '。', {
    remaining: { perTx: remainder(perTx, amount), daily: remainder(daily, spentDaily + amount), monthly: remainder(monthly, spentMonthly + amount) },
  });
}
