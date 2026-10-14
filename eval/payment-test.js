#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 支付网关单测（sidecar/payment-policy.mjs + sidecar/payment.mjs）
 *
 * 重点在「策略边界」——这类代码错一分钱就是真金白银：
 *   - 恰好等于上限（放行） vs 超一分（拒绝）；
 *   - 每日 / 每月 / agent 预算的剩余额度计算与跨天重置；
 *   - 黑名单优先于白名单；
 *   - 免确认阈值**不能**绕过每日 / 每月上限与预算隔离（这是最容易写错的安全口子）；
 *   - 幂等键去重、防重复扣款（并发两次 charge 只扣一次）；
 *   - 结构化错误码齐全，且每笔都落台账、可导出收据。
 *
 * 不联网、不落盘（内存 SQLite；支付渠道用 mock / 计数桩）。
 * 用法：node eval/payment-test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}
function localMs(y, mo, d, h, mi) { return new Date(y, mo - 1, d, h, mi, 0, 0).getTime(); }

async function main() {
  const mod = f => pathToFileURL(path.join(__dirname, '..', 'sidecar', f)).href;
  const { evaluatePolicy, PAYMENT_CODES } = await import(mod('payment-policy.mjs'));
  const { createPayment, createPaymentProviders } = await import(mod('payment.mjs'));
  const { openDbAt } = await import(mod('db.mjs'));

  let VNOW = localMs(2026, 1, 5, 12, 0);

  function policyCfg(overrides) {
    return Object.assign({
      enabled: true, provider: 'mock', currency: 'CNY',
      perTx: 10000, daily: 100000, monthly: 1000000, autoApprove: 0, cooldownMin: 0,
      merchantAllowlist: [], merchantBlocklist: [], categoryAllowlist: [], categoryBlocklist: [], budgets: {},
    }, overrides || {});
  }
  const evalWith = (cfg, input, ctx) => evaluatePolicy(input, Object.assign({
    config: cfg, spentDaily: 0, spentMonthly: 0, spentAgent: 0, lastChargeAt: 0, now: VNOW, mandate: null,
  }, ctx || {}));

  /* ---------------- 策略引擎 ---------------- */

  check('未开启：GATEWAY_DISABLED',
    evalWith(policyCfg({ enabled: false }), { amountCents: 100 }).code === 'GATEWAY_DISABLED');
  check('金额为 0：BAD_AMOUNT', evalWith(policyCfg(), { amountCents: 0 }).code === 'BAD_AMOUNT');
  check('金额为负：BAD_AMOUNT', evalWith(policyCfg(), { amountCents: -5 }).code === 'BAD_AMOUNT');
  check('金额非数字：BAD_AMOUNT', evalWith(policyCfg(), { amountCents: 'abc' }).code === 'BAD_AMOUNT');

  check('商户黑名单：拒绝',
    evalWith(policyCfg({ merchantBlocklist: ['黄牛网'] }), { amountCents: 100, merchant: '黄牛网' }).code === 'MERCHANT_NOT_ALLOWED');
  check('黑名单优先于白名单（同时在两表 → 仍拒绝）',
    evalWith(policyCfg({ merchantBlocklist: ['X'], merchantAllowlist: ['X'] }), { amountCents: 100, merchant: 'X' }).code === 'MERCHANT_NOT_ALLOWED');
  check('白名单非空且不含：拒绝',
    evalWith(policyCfg({ merchantAllowlist: ['京东'] }), { amountCents: 100, merchant: '某宝' }).code === 'MERCHANT_NOT_ALLOWED');
  check('白名单命中：放行到下一步',
    evalWith(policyCfg({ merchantAllowlist: ['京东'] }), { amountCents: 100, merchant: '京东' }).decision !== 'deny');
  check('品类黑名单：拒绝',
    evalWith(policyCfg({ categoryBlocklist: ['虚拟币'] }), { amountCents: 100, category: '虚拟币' }).code === 'CATEGORY_BLOCKED');
  check('品类白名单非空且不含：拒绝',
    evalWith(policyCfg({ categoryAllowlist: ['图书'] }), { amountCents: 100, category: '数码' }).code === 'CATEGORY_BLOCKED');

  check('单笔上限为 0：一律拒绝（保守默认）',
    evalWith(policyCfg({ perTx: 0 }), { amountCents: 100 }).code === 'AMOUNT_EXCEEDS_LIMIT');
  check('恰好等于单笔上限：放行（≤ 而非 <）',
    evalWith(policyCfg({ perTx: 1000, daily: 1000, monthly: 1000 }), { amountCents: 1000 }).decision !== 'deny');
  check('超单笔上限一分：拒绝',
    evalWith(policyCfg({ perTx: 1000, daily: 10000, monthly: 10000 }), { amountCents: 1001 }).code === 'AMOUNT_EXCEEDS_LIMIT');

  check('每日上限为 0：拒绝',
    evalWith(policyCfg({ daily: 0 }), { amountCents: 100 }).code === 'DAILY_LIMIT_EXCEEDED');
  check('每日额度恰好用尽：放行（spent+amount == daily）',
    evalWith(policyCfg({ daily: 1000 }), { amountCents: 600 }, { spentDaily: 400 }).decision !== 'deny');
  check('每日额度超一分：拒绝',
    evalWith(policyCfg({ daily: 1000 }), { amountCents: 601 }, { spentDaily: 400 }).code === 'DAILY_LIMIT_EXCEEDED');
  check('每月额度恰好用尽：放行',
    evalWith(policyCfg({ monthly: 5000 }), { amountCents: 2000 }, { spentMonthly: 3000 }).decision !== 'deny');
  check('每月额度超一分：拒绝',
    evalWith(policyCfg({ monthly: 5000 }), { amountCents: 2001 }, { spentMonthly: 3000 }).code === 'MONTHLY_LIMIT_EXCEEDED');

  check('配了 budgets 但该 agent 未列：拒绝（预算隔离）',
    evalWith(policyCfg({ budgets: { writer: 5000 } }), { amountCents: 100, agent: 'shopper' }).code === 'BUDGET_EXCEEDED');
  check('agent 预算恰好用尽：放行',
    evalWith(policyCfg({ budgets: { writer: 5000 } }), { amountCents: 1000, agent: 'writer' }, { spentAgent: 4000 }).decision !== 'deny');
  check('agent 预算超一分：拒绝',
    evalWith(policyCfg({ budgets: { writer: 5000 } }), { amountCents: 1001, agent: 'writer' }, { spentAgent: 4000 }).code === 'BUDGET_EXCEEDED');

  check('冷静期内：拒绝',
    evalWith(policyCfg({ cooldownMin: 30 }), { amountCents: 100 }, { lastChargeAt: VNOW - 5 * 60000 }).code === 'COOLDOWN_ACTIVE');
  check('冷静期已过：放行到下一步',
    evalWith(policyCfg({ cooldownMin: 30 }), { amountCents: 100 }, { lastChargeAt: VNOW - 31 * 60000 }).decision !== 'deny');

  check('未设免确认阈值（0）：需要人工批准',
    evalWith(policyCfg({ autoApprove: 0 }), { amountCents: 100 }).decision === 'approval');
  check('免确认阈值边界：恰好等于 → 自动放行',
    evalWith(policyCfg({ autoApprove: 500 }), { amountCents: 500 }).decision === 'allow');
  check('免确认阈值边界：超一分 → 需要人工批准',
    evalWith(policyCfg({ autoApprove: 500 }), { amountCents: 501 }).decision === 'approval');
  check('安全：小额免确认不能绕过每日上限',
    evalWith(policyCfg({ autoApprove: 500, daily: 600 }), { amountCents: 500 }, { spentDaily: 600 }).code === 'DAILY_LIMIT_EXCEEDED');
  check('安全：小额免确认不能绕过每月上限',
    evalWith(policyCfg({ autoApprove: 500, monthly: 600 }), { amountCents: 500 }, { spentMonthly: 600 }).code === 'MONTHLY_LIMIT_EXCEEDED');
  check('安全：小额免确认不能绕过预算隔离',
    evalWith(policyCfg({ autoApprove: 500, budgets: { w: 100 } }), { amountCents: 500, agent: 'w' }).code === 'BUDGET_EXCEEDED');
  check('安全：小额免确认不能绕过冷静期',
    evalWith(policyCfg({ autoApprove: 500, cooldownMin: 10 }), { amountCents: 100 }, { lastChargeAt: VNOW - 60000 }).code === 'COOLDOWN_ACTIVE');

  check('授权范围：超出总额度 → MANDATE_EXCEEDED',
    evalWith(policyCfg(), { amountCents: 1000 }, { mandate: { totalLimitCents: 1500, spent: 800, categories: [] } }).code === 'MANDATE_EXCEEDED');
  check('授权范围：品类不在范围内 → CATEGORY_BLOCKED',
    evalWith(policyCfg(), { amountCents: 100, category: '数码' }, { mandate: { totalLimitCents: 9999, spent: 0, categories: ['图书'] } }).code === 'CATEGORY_BLOCKED');
  check('授权范围：额度与品类都满足 → 放行',
    evalWith(policyCfg(), { amountCents: 100, category: '图书' }, { mandate: { totalLimitCents: 9999, spent: 0, categories: ['图书'] } }).decision !== 'deny');

  check('错误码表齐全（10 项）', PAYMENT_CODES.length >= 10, PAYMENT_CODES.join(','));
  check('剩余额度随金额递减（给确认弹窗用）', (() => {
    const v = evalWith(policyCfg({ daily: 1000, monthly: 5000 }), { amountCents: 400 }, { spentDaily: 100 });
    return v.remaining && v.remaining.daily === 500 && v.remaining.monthly === 4600;
  })());

  /* ---------------- 网关：台账 / 确认 / 扣款 ---------------- */

  function fresh(cfgOverrides, providers) {
    const db = openDbAt(':memory:');
    const cfg = { payment: policyCfg(cfgOverrides) };
    return { db: db, cfg: cfg, pay: createPayment({ db: db, getConfig: () => cfg, now: () => VNOW, providers: providers }) };
  }

  {
    const { pay } = fresh({ perTx: 0 });
    const r = await pay.purchase({ amountCents: 100, merchant: 'M', category: 'C', agent: 'a' });
    check('网关：额度 0 → 拒绝并落台账',
      r.ok === false && r.code === 'AMOUNT_EXCEEDS_LIMIT' && pay.listTransactions().length === 1
      && pay.listTransactions()[0].status === 'denied', JSON.stringify(r));
  }

  {
    const { pay } = fresh({ perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 0 });
    const r = await pay.purchase({ amountCents: 3000, merchant: '书店', category: '图书', agent: 'a', items: [{ name: '书', qty: 1 }] });
    check('网关：超免确认阈值 → 待人工确认',
      r.ok === true && r.status === 'pending' && r.needsApproval === true, JSON.stringify(r).slice(0, 200));
    check('网关：待确认的单据带商品/金额/商户（给弹窗展示）',
      r.cart && r.cart.merchant === '书店' && r.cart.amountCents === 3000 && r.cart.items.length === 1);
    check('网关：待确认单据不算「已占用额度」', pay.summary('a').spent.daily === 0, JSON.stringify(pay.summary('a').spent));

    const denied = pay.deny(r.intentId, { actor: 'user' });
    check('网关：用户拒绝 → USER_REJECTED',
      denied.ok === true && denied.code === 'USER_REJECTED', JSON.stringify(denied).slice(0, 160));
  }

  {
    const { pay } = fresh({ perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 0 });
    const r = await pay.purchase({ amountCents: 3000, merchant: '书店', category: '图书', agent: 'a' });
    const ap = pay.approve(r.intentId, { actor: 'user' });
    check('网关：用户确认 → approved', ap.ok === true && ap.status === 'approved', JSON.stringify(ap).slice(0, 160));
    const ch = await pay.charge(r.intentId);
    check('网关：扣款成功（mock）→ charged', ch.ok === true && ch.status === 'charged', JSON.stringify(ch).slice(0, 160));
    check('网关：确认后额度被占用', pay.summary('a').spent.daily === 3000, JSON.stringify(pay.summary('a').spent));
    check('网关：重复确认 → INTENT_ALREADY_RESOLVED',
      pay.approve(r.intentId, { actor: 'user' }).code === 'INTENT_ALREADY_RESOLVED');
    const again = await pay.charge(r.intentId);
    check('网关：已扣款的单据再 charge → 幂等返回（不再扣）', again.ok === true && again.reused === true, JSON.stringify(again).slice(0, 120));
  }

  {
    const { pay } = fresh({ perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 500 });
    const r = await pay.purchase({ amountCents: 300, merchant: 'M', category: 'C', agent: 'a', intentId: 'idem-1' });
    check('网关：小额免确认 → 自动扣款', r.ok === true && r.status === 'charged' && !r.needsApproval, JSON.stringify(r).slice(0, 200));
    const r2 = await pay.purchase({ amountCents: 300, merchant: 'M', category: 'C', agent: 'a', intentId: 'idem-1' });
    check('网关：幂等键重复提交 → 复用同一单据，不重复扣款',
      r2.reused === true && pay.listTransactions().length === 1, JSON.stringify(r2).slice(0, 160));
  }

  {
    // 防重复扣款：并发两次 charge，只应真正调用渠道一次
    let calls = 0;
    const providers = {
      counting: {
        label: '计数桩',
        async charge() { calls += 1; await new Promise(r => setTimeout(r, 25)); return { ok: true, ref: 'ref-1', status: 'charged' }; },
      },
      mock: createPaymentProviders().mock,
      'manual-order': createPaymentProviders()['manual-order'],
    };
    const { pay } = fresh({ provider: 'counting', perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 0 }, providers);
    const r = await pay.purchase({ amountCents: 1000, merchant: 'M', category: 'C', agent: 'a' });
    pay.approve(r.intentId, { actor: 'user' });
    const both = await Promise.all([pay.charge(r.intentId), pay.charge(r.intentId)]);
    check('网关：并发 charge 只真正扣款一次', calls === 1, 'calls=' + calls);
    check('网关：并发中只有一方成功', both.filter(x => x.status === 'charged').length === 1, JSON.stringify(both.map(x => x.status)));
  }

  {
    const providers = {
      'manual-order': createPaymentProviders()['manual-order'],
      mock: createPaymentProviders().mock,
    };
    const { pay } = fresh({ provider: 'manual-order', perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 0 }, providers);
    const r = await pay.purchase({ amountCents: 8888, merchant: '小店', category: '生活', agent: 'a' });
    pay.approve(r.intentId, { actor: 'user' });
    const ch = await pay.charge(r.intentId);
    check('手动付款：生成订单并进入 awaiting_payment', ch.ok === true && ch.status === 'awaiting_payment', JSON.stringify(ch).slice(0, 200));
    check('手动付款：给出可读付款指引（不自动操作任何 App）', !!(ch.order && /手动付款/.test(ch.order.payHint)), ch.order && ch.order.payHint);
    check('手动付款：订单号只记在本地', pay.getTx(r.intentId).providerRef.indexOf('order-') === 0, pay.getTx(r.intentId).providerRef);

    const paid = pay.markPaid(r.intentId, { actor: 'user' });
    check('手动付款：用户回来说「我已支付」→ charged', paid.ok === true && paid.status === 'charged');
    check('手动付款：重复标记 → INTENT_ALREADY_RESOLVED', pay.markPaid(r.intentId).code === 'INTENT_ALREADY_RESOLVED');
  }

  {
    VNOW = localMs(2026, 1, 5, 12, 0);
    const { pay } = fresh({ perTx: 1000, daily: 1000, monthly: 100000, autoApprove: 1000 });
    const first = await pay.purchase({ amountCents: 600, merchant: 'M', category: 'C', agent: 'a' });
    const second = await pay.purchase({ amountCents: 600, merchant: 'M', category: 'C', agent: 'a' });
    check('网关：每日上限计入已扣款额度', first.ok === true && second.ok === false && second.code === 'DAILY_LIMIT_EXCEEDED',
      JSON.stringify(second).slice(0, 160));
    check('网关：剩余额度正确', pay.summary('a').remaining.daily === 400, JSON.stringify(pay.summary('a').remaining));

    VNOW = localMs(2026, 1, 6, 12, 0);
    const third = await pay.purchase({ amountCents: 600, merchant: 'M', category: 'C', agent: 'a' });
    check('网关：跨天额度重置', third.ok === true, JSON.stringify(third).slice(0, 160));
  }

  {
    const { pay } = fresh({ perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 10000 });
    const md = pay.createMandate({ agent: 'a', totalLimitCents: 5000, currency: 'CNY', categories: ['图书'], periodStart: 0, periodEnd: 0 });
    check('授权范围：创建成功', !!md.id && pay.listMandates().length === 1);
    const ok = await pay.purchase({ amountCents: 3000, merchant: 'M', category: '图书', agent: 'a', mandateId: md.id });
    check('授权范围：范围内放行', ok.ok === true, JSON.stringify(ok).slice(0, 160));
    const over = await pay.purchase({ amountCents: 3000, merchant: 'M', category: '图书', agent: 'a', mandateId: md.id });
    check('授权范围：累计超总额度 → MANDATE_EXCEEDED', over.ok === false && over.code === 'MANDATE_EXCEEDED', JSON.stringify(over).slice(0, 160));
    const wrongCat = await pay.purchase({ amountCents: 100, merchant: 'M', category: '数码', agent: 'a', mandateId: md.id });
    check('授权范围：品类越界 → CATEGORY_BLOCKED', wrongCat.ok === false && wrongCat.code === 'CATEGORY_BLOCKED');
    const noSuch = await pay.purchase({ amountCents: 100, merchant: 'M', category: '图书', agent: 'a', mandateId: 'nope' });
    check('授权范围：不存在 → MANDATE_NOT_FOUND', noSuch.ok === false && noSuch.code === 'MANDATE_NOT_FOUND');
  }

  {
    const { pay } = fresh({ perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 10000 });
    const r = await pay.purchase({ amountCents: 1999, merchant: '书店', category: '图书', agent: 'scribe', items: [{ name: '书' }] });
    const rec = pay.receipt(r.intentId);
    check('收据：导出结构化数据 + 可读文本', !!rec && rec.transaction.intentId === r.intentId && /交易收据/.test(rec.text), rec && rec.text && rec.text.split('\n')[0]);
    check('收据：文本含金额与商户', /19\.99/.test(rec.text) && /书店/.test(rec.text));
    check('收据：找不到的单据返回 null', pay.receipt('nope') === null);
    check('台账：记录了 agent / 金额 / 商户 / 时间 / 状态',
      (() => { const t = pay.listTransactions()[0]; return t.agent === 'scribe' && t.amountCents === 1999 && t.merchant === '书店' && t.createdAt > 0 && t.status === 'charged'; })(),
      JSON.stringify(pay.listTransactions()[0]).slice(0, 200));
    check('台账：可按 agent 过滤', pay.listTransactions({ agent: 'scribe' }).length === 1 && pay.listTransactions({ agent: 'other' }).length === 0);
  }

  const pass = results.filter(r => r.hit).length;
  for (const r of results) {
    console.log((r.hit ? '  ✔ ' : '  ✘ ') + r.name + (r.hit || !r.detail ? '' : '   → ' + r.detail));
  }
  console.log('\n支付网关单测：' + pass + '/' + results.length + ' 通过');
  if (pass !== results.length) process.exitCode = 1;
}

main().catch(e => {
  console.error('测试异常：', e);
  process.exitCode = 1;
});
