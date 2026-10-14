/*
 * 无限阅读 · sidecar · 支付网关
 *
 * 模型永远拿不到支付凭证：它只能提交「购买意图」，由这里的代码层强制策略。
 * 授权分三层（参考 AP2）：长期授权范围(mandate) → 购物车确认(intent) → 实际扣款(charge)。
 *
 * 本期只实现两种渠道：
 *   - mock：只记账、不真实扣款；
 *   - manual-order：只生成订单，由用户自己在微信 / 支付宝里手动付款，完成后再回来点「我已支付」。
 * 不实现任何对支付 App 的自动化或绕过，也不保存任何支付密码。
 */
import crypto from 'node:crypto';
import { evaluatePolicy, PAYMENT_CODES } from './payment-policy.mjs';

function genId(prefix) { return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }
function safeJSON(text, fallback) {
  try { const v = JSON.parse(text); return v == null ? fallback : v; } catch (_) { return fallback; }
}
function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function monthKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

export function createPaymentProviders() {
  return {
    mock: {
      label: '模拟支付（不真实扣款，只记账）',
      async charge() { return { ok: true, ref: genId('mockpay-'), status: 'charged' }; },
    },

    'manual-order': {
      label: '仅生成订单（由你在微信 / 支付宝里手动付款）',
      async charge(cfg, order) {
        const amount = (Number(order.amountCents) / 100).toFixed(2);
        return {
          ok: true,
          ref: genId('order-'),
          status: 'awaiting_payment',
          payHint: '请手动付款 ' + amount + ' ' + order.currency + ' 给「' + order.merchant + '」（本程序不会自动操作任何支付 App）。付款完成后，回到这里点「我已支付」。',
        };
      },
    },
  };
}

export function createPayment(deps) {
  const db = deps.db;
  const getConfig = deps.getConfig;
  const now = deps.now || (() => Date.now());
  const providers = deps.providers || createPaymentProviders();
  const providerOf = cfg => providers[(cfg.payment && cfg.payment.provider) || 'mock'] || providers.mock;

  const COMMITTED = "('approved','awaiting_payment','charged')";

  function toTx(r) {
    if (!r) return null;
    return {
      intentId: r.intent_id,
      agent: r.agent,
      amountCents: Number(r.amount_cents),
      currency: r.currency,
      merchant: r.merchant,
      category: r.category,
      items: safeJSON(r.items, []),
      status: r.status,
      code: r.code || '',
      providerRef: r.provider_ref || '',
      createdAt: Number(r.created_at),
      approvedAt: r.approved_at == null ? null : Number(r.approved_at),
      chargedAt: r.charged_at == null ? null : Number(r.charged_at),
    };
  }

  function getTx(intentId) {
    return toTx(db.prepare('SELECT * FROM payment_transactions WHERE intent_id = ?').get(String(intentId || '')));
  }

  function insertTx(row) {
    db.prepare(
      'INSERT INTO payment_transactions (id, intent_id, agent, amount_cents, currency, merchant, category, items, status, code, provider_ref, created_at, approved_at, charged_at) '
      + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      genId('tx'), row.intentId, row.agent, row.amountCents, row.currency, row.merchant, row.category,
      JSON.stringify(row.items || []), row.status, row.code || '', row.providerRef || '',
      row.createdAt, row.approvedAt == null ? null : row.approvedAt, row.chargedAt == null ? null : row.chargedAt
    );
  }

  // 已「占用额度」的金额（待确认的不算，避免空占额度；已确认 / 待人工付款 / 已扣款都算）
  function sums(agent, t0) {
    const rows = db.prepare(
      'SELECT amount_cents, agent, created_at FROM payment_transactions WHERE status IN ' + COMMITTED
    ).all();
    const dk = dayKey(t0);
    const mk = monthKey(t0);
    let daily = 0;
    let monthly = 0;
    let agentSum = 0;
    for (const r of rows) {
      const at = Number(r.created_at);
      const amt = Number(r.amount_cents);
      if (dayKey(at) === dk) daily += amt;
      if (monthKey(at) === mk) monthly += amt;
      if (agent && r.agent === agent) agentSum += amt;
    }
    return { daily: daily, monthly: monthly, agentSum: agentSum };
  }

  function lastChargeAt() {
    const r = db.prepare(
      "SELECT MAX(COALESCE(charged_at, created_at)) AS t FROM payment_transactions WHERE status IN ('awaiting_payment','charged')"
    ).get();
    return (r && r.t) ? Number(r.t) : 0;
  }

  /* ---------------- 长期授权范围（mandate） ---------------- */

  function createMandate(input) {
    const src = input || {};
    const m = {
      id: genId('md'),
      agent: String(src.agent || '').trim(),
      totalLimitCents: Math.max(0, Math.floor(Number(src.totalLimitCents) || 0)),
      currency: String(src.currency || 'CNY'),
      categories: Array.isArray(src.categories) ? src.categories.map(x => String(x)).slice(0, 50) : [],
      periodStart: Math.floor(Number(src.periodStart) || 0),
      periodEnd: Math.floor(Number(src.periodEnd) || 0),
      createdAt: now(),
    };
    db.prepare(
      'INSERT INTO payment_mandates (id, agent, total_limit_cents, currency, categories, period_start, period_end, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(m.id, m.agent, m.totalLimitCents, m.currency, JSON.stringify(m.categories), m.periodStart, m.periodEnd, m.createdAt);
    return m;
  }

  function getMandate(id) {
    const r = db.prepare('SELECT * FROM payment_mandates WHERE id = ?').get(String(id || ''));
    if (!r) return null;
    return {
      id: r.id, agent: r.agent, totalLimitCents: Number(r.total_limit_cents), currency: r.currency,
      categories: safeJSON(r.categories, []),
      periodStart: Number(r.period_start), periodEnd: Number(r.period_end), createdAt: Number(r.created_at),
    };
  }

  function listMandates() {
    return db.prepare('SELECT * FROM payment_mandates ORDER BY created_at DESC LIMIT 100').all().map(r => ({
      id: r.id, agent: r.agent, totalLimitCents: Number(r.total_limit_cents), currency: r.currency,
      categories: safeJSON(r.categories, []),
      periodStart: Number(r.period_start), periodEnd: Number(r.period_end), createdAt: Number(r.created_at),
    }));
  }

  function mandateSpent(mandate, t0) {
    const rows = db.prepare(
      'SELECT amount_cents, agent, created_at FROM payment_transactions WHERE status IN ' + COMMITTED
    ).all();
    let sum = 0;
    for (const r of rows) {
      const at = Number(r.created_at);
      if (mandate.agent && r.agent !== mandate.agent) continue;
      if (mandate.periodStart && at < mandate.periodStart) continue;
      if (mandate.periodEnd && at > mandate.periodEnd) continue;
      sum += Number(r.amount_cents);
    }
    return sum;
  }

  /* ---------------- 额度概览（给确认弹窗展示「剩余额度」） ---------------- */

  function summary(agent) {
    const cfg = getConfig();
    const p = cfg.payment || {};
    const t0 = now();
    const s = sums(String(agent || '').trim(), t0);
    const num = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
    const perTx = num(p.perTx);
    const daily = num(p.daily);
    const monthly = num(p.monthly);
    const budgets = (p.budgets && typeof p.budgets === 'object') ? p.budgets : {};
    const agentCap = agent && Object.prototype.hasOwnProperty.call(budgets, agent) ? num(budgets[agent]) : 0;
    return {
      enabled: !!p.enabled,
      provider: p.provider || 'mock',
      currency: p.currency || 'CNY',
      perTx: perTx,
      daily: daily,
      monthly: monthly,
      autoApprove: num(p.autoApprove),
      cooldownMin: num(p.cooldownMin),
      merchantAllowlist: (p.merchantAllowlist || []).slice(),
      categoryBlocklist: (p.categoryBlocklist || []).slice(),
      spent: { daily: s.daily, monthly: s.monthly, agent: s.agentSum },
      remaining: {
        daily: Math.max(0, daily - s.daily),
        monthly: Math.max(0, monthly - s.monthly),
        agent: agentCap ? Math.max(0, agentCap - s.agentSum) : 0,
      },
      lastChargeAt: lastChargeAt(),
    };
  }

  /* ---------------- 购买意图 → 确认 → 扣款 ---------------- */

  async function purchase(input) {
    const src = input || {};
    const cfg = getConfig();
    const key = String(src.intentId || src.idempotencyKey || '').trim();

    // 幂等：同一个 intentId 不重复下单
    if (key) {
      const existing = getTx(key);
      if (existing) {
        return {
          ok: existing.status !== 'denied', reused: true, intentId: existing.intentId,
          status: existing.status, code: existing.code, transaction: existing,
        };
      }
    }

    const t0 = now();
    const agent = String(src.agent || '').trim();
    const amountCents = Math.floor(Number(src.amountCents));
    const merchant = String(src.merchant || '').slice(0, 200);
    const category = String(src.category || '').slice(0, 100);
    const items = Array.isArray(src.items) ? src.items.slice(0, 50) : [];
    const currency = String(src.currency || (cfg.payment && cfg.payment.currency) || 'CNY');
    const intentId = key || genId('pi');

    // 先查额度再落库：中间没有 await，天然是「原子」的（单进程 Node）
    const s = sums(agent, t0);
    const mandate = src.mandateId ? getMandate(src.mandateId) : null;
    if (src.mandateId && !mandate) {
      return { ok: false, code: 'MANDATE_NOT_FOUND', message: '找不到这个授权范围。' };
    }
    const ctx = {
      config: cfg.payment || {},
      spentDaily: s.daily,
      spentMonthly: s.monthly,
      spentAgent: s.agentSum,
      lastChargeAt: lastChargeAt(),
      now: t0,
      mandate: mandate ? Object.assign({}, mandate, { spent: mandateSpent(mandate, t0) }) : null,
    };
    const verdict = evaluatePolicy({ amountCents: amountCents, merchant: merchant, category: category, agent: agent }, ctx);

    const base = {
      intentId: intentId, agent: agent, amountCents: amountCents, currency: currency,
      merchant: merchant, category: category, items: items, createdAt: t0,
    };

    if (verdict.decision === 'deny') {
      insertTx(Object.assign({}, base, { status: 'denied', code: verdict.code }));
      return {
        ok: false, code: verdict.code, message: verdict.message, intentId: intentId,
        transaction: getTx(intentId),
        summary: summary(agent),
      };
    }

    if (verdict.decision === 'approval') {
      insertTx(Object.assign({}, base, { status: 'pending', code: '' }));
      return {
        ok: true, status: 'pending', needsApproval: true, intentId: intentId,
        message: verdict.message,
        cart: { merchant: merchant, category: category, amountCents: amountCents, currency: currency, items: items },
        remaining: verdict.remaining || null,
        summary: summary(agent),
      };
    }

    // allow：直接放行并扣款
    insertTx(Object.assign({}, base, { status: 'approved', approvedAt: t0 }));
    const charged = await charge(intentId);
    return Object.assign({ needsApproval: false, summary: summary(agent) }, charged);
  }

  function approve(intentId, opts) {
    const id = String(intentId || '');
    if (!getTx(id)) return { ok: false, code: 'INTENT_NOT_FOUND', message: '找不到这笔购买意图。' };
    const info = db.prepare("UPDATE payment_transactions SET status='approved', approved_at=? WHERE intent_id=? AND status='pending'")
      .run(now(), id);
    if (info.changes > 0) return { ok: true, status: 'approved', transaction: getTx(id) };
    const tx = getTx(id);
    return { ok: false, code: 'INTENT_ALREADY_RESOLVED', status: tx.status, message: '这笔已经不是待确认状态了。', transaction: tx };
  }

  function deny(intentId, opts) {
    const id = String(intentId || '');
    if (!getTx(id)) return { ok: false, code: 'INTENT_NOT_FOUND', message: '找不到这笔购买意图。' };
    const info = db.prepare("UPDATE payment_transactions SET status='denied', code='USER_REJECTED' WHERE intent_id=? AND status='pending'")
      .run(id);
    if (info.changes > 0) return { ok: true, status: 'denied', code: 'USER_REJECTED', transaction: getTx(id) };
    const tx = getTx(id);
    return { ok: false, code: 'INTENT_ALREADY_RESOLVED', status: tx.status, message: '这笔已经不是待确认状态了。', transaction: tx };
  }

  async function charge(intentId) {
    const id = String(intentId || '');
    if (!getTx(id)) return { ok: false, code: 'INTENT_NOT_FOUND', message: '找不到这笔购买意图。' };

    // 同步抢占：只有把 approved 抢成 charging 的那一方才真正扣款（防重复扣款）
    const claim = db.prepare("UPDATE payment_transactions SET status='charging' WHERE intent_id=? AND status='approved'").run(id);
    if (claim.changes === 0) {
      const tx = getTx(id);
      if (tx.status === 'pending') return { ok: false, code: 'NEEDS_APPROVAL', message: '这笔还没经过确认。', transaction: tx };
      if (tx.status === 'charging') return { ok: false, code: 'INTENT_ALREADY_RESOLVED', message: '这笔正在处理中。', transaction: tx };
      if (tx.status === 'denied') return { ok: false, code: tx.code || 'USER_REJECTED', message: '这笔已被拒绝。', transaction: tx };
      return { ok: true, status: tx.status, reused: true, intentId: id, transaction: tx };
    }

    const tx = getTx(id);
    const cfg = getConfig();
    try {
      const out = await providerOf(cfg).charge(cfg, tx);
      const t1 = now();
      if (out && out.status === 'awaiting_payment') {
        db.prepare("UPDATE payment_transactions SET status='awaiting_payment', provider_ref=? WHERE intent_id=?")
          .run(out.ref || '', id);
      } else {
        db.prepare("UPDATE payment_transactions SET status='charged', charged_at=?, provider_ref=? WHERE intent_id=?")
          .run(t1, (out && out.ref) || '', id);
      }
      return {
        ok: true,
        status: (out && out.status) || 'charged',
        intentId: id,
        provider: (cfg.payment && cfg.payment.provider) || 'mock',
        order: out || null,
        transaction: getTx(id),
      };
    } catch (err) {
      // 失败回滚到「已确认」，用户下一条还可以重试；不吞掉原因
      db.prepare("UPDATE payment_transactions SET status='approved', code='PROVIDER_ERROR' WHERE intent_id=?").run(id);
      return { ok: false, code: 'PROVIDER_ERROR', message: String((err && err.message) || err), intentId: id, transaction: getTx(id) };
    }
  }

  // 「仅生成订单」模式下，用户手动付完款后回来点一下
  function markPaid(intentId, opts) {
    const id = String(intentId || '');
    if (!getTx(id)) return { ok: false, code: 'INTENT_NOT_FOUND', message: '找不到这笔购买意图。' };
    const info = db.prepare("UPDATE payment_transactions SET status='charged', charged_at=? WHERE intent_id=? AND status='awaiting_payment'")
      .run(now(), id);
    if (info.changes > 0) return { ok: true, status: 'charged', transaction: getTx(id) };
    const tx = getTx(id);
    return { ok: false, code: 'INTENT_ALREADY_RESOLVED', status: tx.status, message: '这笔不是「等待付款」状态。', transaction: tx };
  }

  function listTransactions(opts) {
    const o = opts || {};
    const limit = Math.max(1, Math.min(500, Math.floor(Number(o.limit) || 100)));
    const rows = o.agent
      ? db.prepare('SELECT * FROM payment_transactions WHERE agent = ? ORDER BY created_at DESC LIMIT ?').all(String(o.agent), limit)
      : db.prepare('SELECT * FROM payment_transactions ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map(toTx);
  }

  // 收据：结构化数据 + 一段可直接保存的文本
  function receipt(intentId) {
    const tx = getTx(intentId);
    if (!tx) return null;
    const yuan = (tx.amountCents / 100).toFixed(2);
    const lines = [
      '无限阅读 · 交易收据',
      '单号：' + tx.intentId,
      '时间：' + new Date(tx.createdAt).toLocaleString(),
      '发起方：' + (tx.agent || '（未指定）'),
      '商户：' + (tx.merchant || '（未填）'),
      '品类：' + (tx.category || '（未填）'),
      '金额：' + yuan + ' ' + tx.currency,
      '状态：' + tx.status + (tx.code ? '（' + tx.code + '）' : ''),
      '渠道：' + providerOf(getConfig()).label,
      '备注：本收据由「无限阅读」本地服务生成，不构成任何支付凭证。',
    ];
    return { transaction: tx, text: lines.join('\n') };
  }

  function stats() {
    const cfg = getConfig();
    const p = cfg.payment || {};
    const t0 = now();
    const s = sums('', t0);
    return {
      enabled: !!p.enabled,
      provider: p.provider || 'mock',
      spentTodayCents: s.daily,
      spentMonthCents: s.monthly,
      pendingApprovals: db.prepare("SELECT COUNT(*) AS n FROM payment_transactions WHERE status='pending'").get().n,
      awaitingPayment: db.prepare("SELECT COUNT(*) AS n FROM payment_transactions WHERE status='awaiting_payment'").get().n,
    };
  }

  return {
    PAYMENT_CODES,
    providers: providers,
    purchase,
    approve,
    deny,
    charge,
    markPaid,
    getTx,
    listTransactions,
    receipt,
    summary,
    stats,
    createMandate,
    getMandate,
    listMandates,
  };
}
