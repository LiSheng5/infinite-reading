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
import { evaluatePolicy, PAYMENT_CODES } from './payment-policy.mjs';
import { genId, safeJSON, dayRange, monthRange, num, clampInt, fail } from './util.mjs';
import { TX, COMMITTED_TX, sqlIn } from './statuses.mjs';

export function createPaymentProviders() {
  return {
    mock: {
      label: '模拟支付（不真实扣款，只记账）',
      async charge() { return { ok: true, ref: genId('mockpay-'), status: TX.CHARGED }; },
    },

    'manual-order': {
      label: '仅生成订单（由你在微信 / 支付宝里手动付款）',
      async charge(cfg, order) {
        const amount = (Number(order.amountCents) / 100).toFixed(2);
        return {
          ok: true,
          ref: genId('order-'),
          status: TX.AWAITING_PAYMENT,
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

  // 已「占用额度」的状态组唯一口径在 statuses.mjs（COMMITTED_TX）：待确认的不算，避免空占额度
  const COMMITTED = sqlIn(COMMITTED_TX);

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
      mandateId: r.mandate_id || '',
      createdAt: Number(r.created_at),
      approvedAt: r.approved_at == null ? null : Number(r.approved_at),
      chargedAt: r.charged_at == null ? null : Number(r.charged_at),
    };
  }

  function getTx(intentId) {
    return toTx(db.prepare('SELECT * FROM payment_transactions WHERE intent_id = ?').get(String(intentId || '')));
  }

  function insertTx(row) {
    // 金额归一：amount_cents 是 INTEGER NOT NULL，NaN / Infinity / 超 int64
    // 会变成绑定或约束异常 → 500 INTERNAL。台账宁可记 0，也不让拒绝路径把服务打崩。
    const raw = Math.floor(Number(row.amountCents));
    const amountCents = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
    db.prepare(
      'INSERT INTO payment_transactions (id, intent_id, agent, amount_cents, currency, merchant, category, items, status, code, provider_ref, mandate_id, created_at, approved_at, charged_at) '
      + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      genId('tx'), row.intentId, row.agent, amountCents, row.currency, row.merchant, row.category,
      JSON.stringify(row.items || []), row.status, row.code || '', row.providerRef || '', row.mandateId || '',
      row.createdAt, row.approvedAt == null ? null : row.approvedAt, row.chargedAt == null ? null : row.chargedAt
    );
  }

  // 已「占用额度」的金额（待确认的不算，避免空占额度；已确认 / 待人工付款 / 已扣款都算）。
  // 金额字段一律 *Cents 后缀：单位就是「分」，别让人当元接。
  // SQL 按时间范围 + SUM 聚合，不再全表 SELECT 后 JS 过滤。
  function sums(agent, t0) {
    const [d0, d1] = dayRange(t0);
    const [m0, m1] = monthRange(t0);
    const sumIn = (a, b) => {
      const r = db.prepare(
        'SELECT COALESCE(SUM(amount_cents),0) AS s FROM payment_transactions WHERE status IN ' + COMMITTED + ' AND created_at >= ? AND created_at < ?'
      ).get(a, b);
      return Number(r && r.s) || 0;
    };
    const dailyCents = sumIn(d0, d1);
    const monthlyCents = sumIn(m0, m1);
    let agentCents = 0;
    if (agent) {
      const r = db.prepare(
        'SELECT COALESCE(SUM(amount_cents),0) AS s FROM payment_transactions WHERE status IN ' + COMMITTED + ' AND agent = ?'
      ).get(String(agent));
      agentCents = Number(r && r.s) || 0;
    }
    return { dailyCents: dailyCents, monthlyCents: monthlyCents, agentCents: agentCents };
  }

  function lastChargeAt() {
    const r = db.prepare(
      'SELECT MAX(COALESCE(charged_at, created_at)) AS t FROM payment_transactions WHERE status IN ' + sqlIn([TX.AWAITING_PAYMENT, TX.CHARGED])
    ).get();
    return (r && r.t) ? Number(r.t) : 0;
  }

  /* ---------------- 长期授权范围（mandate） ---------------- */

  function createMandate(input) {
    const src = input || {};
    const agent = String(src.agent || '').trim();
    // 发起方是授权范围的核心身份（agent 由 mandate 映射到每笔交易）：不允许空名
    // 业务失败走结构化返回，不 throw
    if (!agent) return fail('AGENT_REQUIRED');
    const m = {
      id: genId('md'),
      agent: agent,
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

  // 授权范围内已用额度：按 mandate_id 关联统计（此前按 agent+周期近似，
  // 同一 agent 开两份授权会互相串额度，改名还能换池）。
  // 额度窗口与策略层的有效期判据同一口径：签了窗口的授权（periodStart / periodEnd
  // 都 > 0）只统计窗口内的已扣款，到期后由策略按 MANDATE_EXPIRED 拒绝、界面按月续签
  // 新的一份——额度不做终身累计；没签窗口（两个字段全 0，旧档 / 手动签发）保持终身累计。
  function mandateSpent(mandate) {
    const windowed = mandate && mandate.periodStart > 0 && mandate.periodEnd > 0;
    const sql = 'SELECT amount_cents FROM payment_transactions WHERE status IN ' + COMMITTED + ' AND mandate_id = ?'
      + (windowed ? ' AND created_at >= ? AND created_at < ?' : '');
    const rows = windowed
      ? db.prepare(sql).all(String(mandate.id), mandate.periodStart, mandate.periodEnd)
      : db.prepare(sql).all(String(mandate.id));
    let sumCents = 0;
    for (const r of rows) sumCents += Number(r.amount_cents);
    return sumCents;
  }

  /* ---------------- 额度概览（给确认弹窗展示「剩余额度」） ---------------- */

  function summary(agent) {
    const cfg = getConfig();
    const p = cfg.payment || {};
    const t0 = now();
    const s = sums(String(agent || '').trim(), t0);
    // 配置键（config.json）保持 perTx / daily / monthly / autoApprove 不动（用户面文件格式），
    // 但 summary 的输出值一律 *Cents 后缀——单位就是「分」
    const perTxCents = num(p.perTx);
    const dailyCents = num(p.daily);
    const monthlyCents = num(p.monthly);
    const budgets = (p.budgets && typeof p.budgets === 'object') ? p.budgets : {};
    const agentCapCents = agent && Object.prototype.hasOwnProperty.call(budgets, agent) ? num(budgets[agent]) : 0;
    return {
      enabled: !!p.enabled,
      provider: p.provider || 'mock',
      currency: p.currency || 'CNY',
      perTxCents: perTxCents,
      dailyCents: dailyCents,
      monthlyCents: monthlyCents,
      autoApproveCents: num(p.autoApprove),
      cooldownMin: num(p.cooldownMin),
      merchantAllowlist: (p.merchantAllowlist || []).slice(),
      categoryBlocklist: (p.categoryBlocklist || []).slice(),
      spent: { dailyCents: s.dailyCents, monthlyCents: s.monthlyCents, agentCents: s.agentCents },
      remaining: {
        dailyCents: Math.max(0, dailyCents - s.dailyCents),
        monthlyCents: Math.max(0, monthlyCents - s.monthlyCents),
        agentCents: agentCapCents ? Math.max(0, agentCapCents - s.agentCents) : 0,
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
          ok: existing.status !== TX.DENIED, reused: true, intentId: existing.intentId,
          status: existing.status, code: existing.code, transaction: existing,
        };
      }
    }

    const t0 = now();
    // 金额入口校验：NaN / 非安全整数 / ≤0 必须在落库前挡掉。
    // 策略层虽然也判 BAD_AMOUNT，但走到那里时 deny 分支仍会 insertTx 写一个坏金额。
    const amountNum = Math.floor(Number(src.amountCents));
    if (!Number.isSafeInteger(amountNum) || amountNum <= 0) {
      return { ok: false, code: 'BAD_AMOUNT', intentId: key || '', message: '金额必须大于 0（单位：分）。' };
    }
    const amountCents = amountNum;
    const merchant = String(src.merchant || '').slice(0, 200);
    const category = String(src.category || '').slice(0, 100);
    const items = Array.isArray(src.items) ? src.items.slice(0, 50) : [];
    // 币种强制等于配置币种：金额单位就是配置币种的「分」，请求体自报的币种不接受
    const currency = (cfg.payment && cfg.payment.currency) || 'CNY';
    if (src.currency && String(src.currency).trim().toUpperCase() !== currency) {
      return { ok: false, code: 'CURRENCY_MISMATCH', message: '币种必须与本地配置一致（' + currency + '）。' };
    }
    // 三层授权第一层（长期授权范围）：agent 身份由 mandate 映射（服务端定，不采信请求体自报）
    const mandateId = String(src.mandateId || '').trim();
    const mandate = mandateId ? getMandate(mandateId) : null;
    const agent = mandate ? mandate.agent : '';
    const intentId = key || genId('pi');

    // 先查额度再落库：中间没有 await，天然是「原子」的（单进程 Node）
    const s = sums(agent, t0);
    const ctx = {
      config: cfg.payment || {},
      spentDaily: s.dailyCents,
      spentMonthly: s.monthlyCents,
      spentAgent: s.agentCents,
      lastChargeAt: lastChargeAt(),
      now: t0,
      mandate: mandate ? Object.assign({}, mandate, { spent: mandateSpent(mandate) }) : null,
    };
    const verdict = evaluatePolicy({ amountCents: amountCents, merchant: merchant, category: category, agent: agent }, ctx);

    const base = {
      intentId: intentId, agent: agent, amountCents: amountCents, currency: currency,
      merchant: merchant, category: category, items: items, mandateId: mandate ? mandate.id : '', createdAt: t0,
    };

    if (verdict.decision === 'deny') {
      insertTx(Object.assign({}, base, { status: TX.DENIED, code: verdict.code }));
      return {
        ok: false, code: verdict.code, message: verdict.message, intentId: intentId,
        transaction: getTx(intentId),
        summary: summary(agent),
      };
    }

    // 授权范围缺失：策略过了也不放行——「三层授权」的第一层不可省略
    if (!mandate) {
      const code = mandateId ? 'MANDATE_NOT_FOUND' : 'MANDATE_REQUIRED';
      insertTx(Object.assign({}, base, { status: TX.DENIED, code: code }));
      return {
        ok: false, code: code, intentId: intentId,
        message: code === 'MANDATE_REQUIRED'
          ? '下单必须挂在长期授权范围（mandate）上：请先签发授权。'
          : '找不到这个授权范围。',
        transaction: getTx(intentId),
        summary: summary(agent),
      };
    }

    if (verdict.decision === 'approval') {
      insertTx(Object.assign({}, base, { status: TX.PENDING, code: '' }));
      return {
        ok: true, status: TX.PENDING, needsApproval: true, intentId: intentId,
        message: verdict.message,
        cart: { merchant: merchant, category: category, amountCents: amountCents, currency: currency, items: items },
        remaining: verdict.remaining || null,
        summary: summary(agent),
      };
    }

    // allow：直接放行并扣款
    insertTx(Object.assign({}, base, { status: TX.APPROVED, approvedAt: t0 }));
    const charged = await charge(intentId);
    return Object.assign({ needsApproval: false, summary: summary(agent) }, charged);
  }

  function approve(intentId, opts) {
    const id = String(intentId || '');
    if (!getTx(id)) return { ok: false, code: 'INTENT_NOT_FOUND', message: '找不到这笔购买意图。' };
    const info = db.prepare('UPDATE payment_transactions SET status=?, approved_at=? WHERE intent_id=? AND status=?')
      .run(TX.APPROVED, now(), id, TX.PENDING);
    if (info.changes > 0) return { ok: true, status: TX.APPROVED, transaction: getTx(id) };
    const tx = getTx(id);
    return { ok: false, code: 'INTENT_ALREADY_RESOLVED', status: tx.status, message: '这笔已经不是待确认状态了。', transaction: tx };
  }

  function deny(intentId, opts) {
    const id = String(intentId || '');
    if (!getTx(id)) return { ok: false, code: 'INTENT_NOT_FOUND', message: '找不到这笔购买意图。' };
    const info = db.prepare('UPDATE payment_transactions SET status=?, code=? WHERE intent_id=? AND status=?')
      .run(TX.DENIED, 'USER_REJECTED', id, TX.PENDING);
    if (info.changes > 0) return { ok: true, status: TX.DENIED, code: 'USER_REJECTED', transaction: getTx(id) };
    const tx = getTx(id);
    return { ok: false, code: 'INTENT_ALREADY_RESOLVED', status: tx.status, message: '这笔已经不是待确认状态了。', transaction: tx };
  }

  async function charge(intentId) {
    const id = String(intentId || '');
    if (!getTx(id)) return { ok: false, code: 'INTENT_NOT_FOUND', message: '找不到这笔购买意图。' };

    // 同步抢占：只有把 approved 抢成 charging 的那一方才真正扣款（防重复扣款）
    const claim = db.prepare('UPDATE payment_transactions SET status=? WHERE intent_id=? AND status=?')
      .run(TX.CHARGING, id, TX.APPROVED);
    if (claim.changes === 0) {
      const tx = getTx(id);
      if (tx.status === TX.PENDING) return { ok: false, code: 'NEEDS_APPROVAL', message: '这笔还没经过确认。', transaction: tx };
      if (tx.status === TX.CHARGING) return { ok: false, code: 'INTENT_ALREADY_RESOLVED', message: '这笔正在处理中。', transaction: tx };
      if (tx.status === TX.DENIED) return { ok: false, code: tx.code || 'USER_REJECTED', message: '这笔已被拒绝。', transaction: tx };
      return { ok: true, status: tx.status, reused: true, intentId: id, transaction: tx };
    }

    const tx = getTx(id);
    const cfg = getConfig();

    // 扣款前用「当下」的额度再裁决一次（此处到 provider 调用前无 await，与上面的抢占一起是原子的）。
    // purchase() 只在建单时裁决过一次：连续建 N 笔各自“刚好不超限”的 pending 再逐个批准，
    // 就能把消费放大到 N×日/月/agent 额度——批准与扣款之间必须按最新额度复核。
    // 用户已经批准过，所以 verdict=approval 视为放行，只有 deny 才拦。
    const t0 = now();
    const s = sums(tx.agent, t0);
    const mandate = tx.mandateId ? getMandate(tx.mandateId) : null;
    const verdict = evaluatePolicy(
      { amountCents: tx.amountCents, merchant: tx.merchant, category: tx.category, agent: tx.agent },
      {
        config: cfg.payment || {},
        spentDaily: s.dailyCents,
        spentMonthly: s.monthlyCents,
        spentAgent: s.agentCents,
        lastChargeAt: lastChargeAt(),
        now: t0,
        // 授权范围同样按当下累计复核（本单是 charging 状态、不在 COMMITTED 里，不会重复计自己）
        mandate: mandate ? Object.assign({}, mandate, { spent: mandateSpent(mandate) }) : null,
      }
    );
    if (verdict.decision === 'deny') {
      db.prepare('UPDATE payment_transactions SET status=?, code=? WHERE intent_id=?').run(TX.DENIED, verdict.code, id);
      return {
        ok: false, code: verdict.code, message: verdict.message,
        intentId: id, transaction: getTx(id), summary: summary(tx.agent),
      };
    }

    try {
      const out = await providerOf(cfg).charge(cfg, tx);
      const t1 = now();
      if (out && out.status === TX.AWAITING_PAYMENT) {
        db.prepare('UPDATE payment_transactions SET status=?, provider_ref=? WHERE intent_id=?')
          .run(TX.AWAITING_PAYMENT, out.ref || '', id);
      } else {
        db.prepare('UPDATE payment_transactions SET status=?, charged_at=?, provider_ref=? WHERE intent_id=?')
          .run(TX.CHARGED, t1, (out && out.ref) || '', id);
      }
      return {
        ok: true,
        status: (out && out.status) || TX.CHARGED,
        intentId: id,
        provider: (cfg.payment && cfg.payment.provider) || 'mock',
        order: out || null,
        transaction: getTx(id),
      };
    } catch (err) {
      // 失败回滚到「已确认」，用户下一条还可以重试；不吞掉原因
      db.prepare('UPDATE payment_transactions SET status=?, code=? WHERE intent_id=?').run(TX.APPROVED, 'PROVIDER_ERROR', id);
      return { ok: false, code: 'PROVIDER_ERROR', message: String((err && err.message) || err), intentId: id, transaction: getTx(id) };
    }
  }

  // 「仅生成订单」模式下，用户手动付完款后回来点一下
  function markPaid(intentId, opts) {
    const id = String(intentId || '');
    if (!getTx(id)) return { ok: false, code: 'INTENT_NOT_FOUND', message: '找不到这笔购买意图。' };
    const info = db.prepare('UPDATE payment_transactions SET status=?, charged_at=? WHERE intent_id=? AND status=?')
      .run(TX.CHARGED, now(), id, TX.AWAITING_PAYMENT);
    if (info.changes > 0) return { ok: true, status: TX.CHARGED, transaction: getTx(id) };
    const tx = getTx(id);
    return { ok: false, code: 'INTENT_ALREADY_RESOLVED', status: tx.status, message: '这笔不是「等待付款」状态。', transaction: tx };
  }

  function listTransactions(opts) {
    const o = opts || {};
    const limit = clampInt(o.limit, 100, 500);
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
      spentTodayCents: s.dailyCents,
      spentMonthCents: s.monthlyCents,
      pendingApprovals: db.prepare('SELECT COUNT(*) AS n FROM payment_transactions WHERE status=?').get(TX.PENDING).n,
      awaitingPayment: db.prepare('SELECT COUNT(*) AS n FROM payment_transactions WHERE status=?').get(TX.AWAITING_PAYMENT).n,
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
    listMandates,
  };
}
