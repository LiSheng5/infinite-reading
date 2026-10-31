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
const { check, run, loadEsm, localMs } = require('./_harness.js');
const fs = require('fs');
const path = require('path');

async function main() {
  const { evaluatePolicy, PAYMENT_CODES } = await loadEsm('payment-policy.mjs');
  const { createPayment, createPaymentProviders } = await loadEsm('payment.mjs');
  const { openDbAt } = await loadEsm('db.mjs');

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
    return v.remaining && v.remaining.dailyCents === 500 && v.remaining.monthlyCents === 4600;
  })());

  /* ---------------- 网关：台账 / 确认 / 扣款 ---------------- */

  function fresh(cfgOverrides, providers) {
    const db = openDbAt(':memory:');
    const cfg = { payment: policyCfg(cfgOverrides) };
    return { db: db, cfg: cfg, pay: createPayment({ db: db, getConfig: () => cfg, now: () => VNOW, providers: providers }) };
  }

  // 统一造一份长期授权（三层授权第一层，起 mandate 强制）；
  // totalLimitCents=0 = 不限总额，由单笔 / 日 / 月限额管
  function mkMandate(pay, over) {
    return pay.createMandate(Object.assign({
      agent: 'a', totalLimitCents: 0, currency: 'CNY', categories: [], periodStart: 0, periodEnd: 0,
    }, over || {}));
  }

  {
    const { pay } = fresh({ perTx: 0 });
    const md = mkMandate(pay);
    const r = await pay.purchase({ amountCents: 100, merchant: 'M', category: 'C', mandateId: md.id });
    check('网关：额度 0 → 拒绝并落台账',
      r.ok === false && r.code === 'AMOUNT_EXCEEDS_LIMIT' && pay.listTransactions().length === 1
      && pay.listTransactions()[0].status === 'denied', JSON.stringify(r));
  }

  {
    const { pay } = fresh({ perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 0 });
    const md = mkMandate(pay);
    const r = await pay.purchase({ amountCents: 3000, merchant: '书店', category: '图书', mandateId: md.id, items: [{ name: '书', qty: 1 }] });
    check('网关：超免确认阈值 → 待人工确认',
      r.ok === true && r.status === 'pending' && r.needsApproval === true, JSON.stringify(r).slice(0, 200));
    check('网关：待确认的单据带商品/金额/商户（给弹窗展示）',
      r.cart && r.cart.merchant === '书店' && r.cart.amountCents === 3000 && r.cart.items.length === 1);
    check('网关：待确认单据不算「已占用额度」', pay.summary('a').spent.dailyCents === 0, JSON.stringify(pay.summary('a').spent));

    const denied = pay.deny(r.intentId, { actor: 'user' });
    check('网关：用户拒绝 → USER_REJECTED',
      denied.ok === true && denied.code === 'USER_REJECTED', JSON.stringify(denied).slice(0, 160));
  }

  {
    const { pay } = fresh({ perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 0 });
    const md = mkMandate(pay);
    const r = await pay.purchase({ amountCents: 3000, merchant: '书店', category: '图书', mandateId: md.id });
    const ap = pay.approve(r.intentId, { actor: 'user' });
    check('网关：用户确认 → approved', ap.ok === true && ap.status === 'approved', JSON.stringify(ap).slice(0, 160));
    const ch = await pay.charge(r.intentId);
    check('网关：扣款成功（mock）→ charged', ch.ok === true && ch.status === 'charged', JSON.stringify(ch).slice(0, 160));
    check('网关：确认后额度被占用', pay.summary('a').spent.dailyCents === 3000, JSON.stringify(pay.summary('a').spent));
    check('网关：重复确认 → INTENT_ALREADY_RESOLVED',
      pay.approve(r.intentId, { actor: 'user' }).code === 'INTENT_ALREADY_RESOLVED');
    const again = await pay.charge(r.intentId);
    check('网关：已扣款的单据再 charge → 幂等返回（不再扣）', again.ok === true && again.reused === true, JSON.stringify(again).slice(0, 120));
  }

  {
    const { pay } = fresh({ perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 500 });
    const md = mkMandate(pay);
    const r = await pay.purchase({ amountCents: 300, merchant: 'M', category: 'C', mandateId: md.id, intentId: 'idem-1' });
    check('网关：小额免确认 → 自动扣款', r.ok === true && r.status === 'charged' && !r.needsApproval, JSON.stringify(r).slice(0, 200));
    const r2 = await pay.purchase({ amountCents: 300, merchant: 'M', category: 'C', mandateId: md.id, intentId: 'idem-1' });
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
    const md = mkMandate(pay);
    const r = await pay.purchase({ amountCents: 1000, merchant: 'M', category: 'C', mandateId: md.id });
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
    const md = mkMandate(pay);
    const r = await pay.purchase({ amountCents: 8888, merchant: '小店', category: '生活', mandateId: md.id });
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
    const md = mkMandate(pay);
    const first = await pay.purchase({ amountCents: 600, merchant: 'M', category: 'C', mandateId: md.id });
    const second = await pay.purchase({ amountCents: 600, merchant: 'M', category: 'C', mandateId: md.id });
    check('网关：每日上限计入已扣款额度', first.ok === true && second.ok === false && second.code === 'DAILY_LIMIT_EXCEEDED',
      JSON.stringify(second).slice(0, 160));
    check('网关：剩余额度正确', pay.summary('a').remaining.dailyCents === 400, JSON.stringify(pay.summary('a').remaining));

    VNOW = localMs(2026, 1, 6, 12, 0);
    const third = await pay.purchase({ amountCents: 600, merchant: 'M', category: 'C', mandateId: md.id });
    check('网关：跨天额度重置', third.ok === true, JSON.stringify(third).slice(0, 160));
  }

  /* 连环 pending 放大消费：建单时各自“刚好不超限”，扣款前必须按最新额度复核 */
  {
    VNOW = localMs(2026, 1, 5, 12, 0);
    const { pay } = fresh({ perTx: 1000, daily: 1500, monthly: 100000, autoApprove: 0, cooldownMin: 0 });
    const md = mkMandate(pay);
    const a = await pay.purchase({ amountCents: 1000, merchant: 'M', category: 'C', mandateId: md.id });
    const b = await pay.purchase({ amountCents: 1000, merchant: 'M', category: 'C', mandateId: md.id });
    check('放大防御：两笔 pending 建单时各自不超限', a.ok === true && b.ok === true, JSON.stringify([a.code, b.code]));
    pay.approve(a.intentId, { actor: 'user' });
    const ca = await pay.charge(a.intentId);
    check('放大防御：第一笔照常扣款', ca.ok === true && ca.status === 'charged', JSON.stringify(ca).slice(0, 160));
    pay.approve(b.intentId, { actor: 'user' });
    const cb = await pay.charge(b.intentId);
    check('放大防御：第二笔扣款前复核额度 → 拒绝并落台账',
      cb.ok === false && cb.code === 'DAILY_LIMIT_EXCEEDED' && pay.getTx(b.intentId).status === 'denied', JSON.stringify(cb).slice(0, 200));
    check('放大防御：被拒单不计入已用额度', pay.summary('a').spent.dailyCents === 1000, JSON.stringify(pay.summary('a').spent));
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

  /* 三层授权第一层不可省略 + agent/币种服务端定 */
  {
    const { pay } = fresh({ perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 10000 });
    const miss = await pay.purchase({ amountCents: 100, merchant: 'M', category: 'C', agent: 'a' });
    check('三层授权：缺 mandate 不放行（MANDATE_REQUIRED）',
      miss.ok === false && miss.code === 'MANDATE_REQUIRED', JSON.stringify(miss).slice(0, 160));
    check('三层授权：拒绝也落台账', pay.getTx(miss.intentId).status === 'denied', JSON.stringify(pay.getTx(miss.intentId)));

    const md = pay.createMandate({ agent: 'a', totalLimitCents: 0, currency: 'CNY', categories: [] });
    const forged = await pay.purchase({ amountCents: 100, merchant: 'M', category: 'C', agent: 'evil', mandateId: md.id });
    check('agent 由服务端按 mandate 映射（请求体自报无效）',
      forged.ok === true && forged.transaction.agent === 'a' && pay.listTransactions({ agent: 'evil' }).length === 0,
      JSON.stringify(forged.transaction).slice(0, 200));

    const fx = await pay.purchase({ amountCents: 100, merchant: 'M', category: 'C', mandateId: md.id, currency: 'USD' });
    check('currency 强制等于配置币种（自报 USD → CURRENCY_MISMATCH）',
      fx.ok === false && fx.code === 'CURRENCY_MISMATCH', JSON.stringify(fx).slice(0, 160));
    const native = await pay.purchase({ amountCents: 100, merchant: 'M', category: 'C', mandateId: md.id, currency: 'CNY' });
    check('currency 与配置一致时放行，台账币种 = 配置币种',
      native.ok === true && native.transaction.currency === 'CNY', JSON.stringify(native).slice(0, 160));

    // 业务失败返回 fail(code)、不 throw
    const bad = pay.createMandate({ totalLimitCents: 100 });
    check('授权范围：缺 agent 拒绝创建（AGENT_REQUIRED）',
      !!bad && bad.ok === false && bad.code === 'AGENT_REQUIRED', JSON.stringify(bad));
  }

  /* mandateSpent 按授权关联：两份授权不串额度 */
  {
    const { pay } = fresh({ perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 10000 });
    const md1 = pay.createMandate({ agent: 'a', totalLimitCents: 5000, currency: 'CNY', categories: [] });
    const md2 = pay.createMandate({ agent: 'a', totalLimitCents: 5000, currency: 'CNY', categories: [] });
    const a = await pay.purchase({ amountCents: 5000, merchant: 'M', category: 'C', mandateId: md1.id });
    const b = await pay.purchase({ amountCents: 100, merchant: 'M', category: 'C', mandateId: md1.id });
    check('授权额度按 mandate 关联累计：同一授权第二笔超总额 → MANDATE_EXCEEDED',
      a.ok === true && b.ok === false && b.code === 'MANDATE_EXCEEDED', JSON.stringify([a.code, b.code]));
    const c = await pay.purchase({ amountCents: 5000, merchant: 'M', category: 'C', mandateId: md2.id });
    check('授权额度不串池：另一份授权额度独立', c.ok === true, JSON.stringify(c).slice(0, 160));
  }

  {
    const { pay } = fresh({ perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 10000 });
    const md = mkMandate(pay, { agent: 'scribe' });
    const r = await pay.purchase({ amountCents: 1999, merchant: '书店', category: '图书', mandateId: md.id, items: [{ name: '书' }] });
    const rec = pay.receipt(r.intentId);
    check('收据：导出结构化数据 + 可读文本', !!rec && rec.transaction.intentId === r.intentId && /交易收据/.test(rec.text), rec && rec.text && rec.text.split('\n')[0]);
    check('收据：文本含金额与商户', /19\.99/.test(rec.text) && /书店/.test(rec.text));
    check('收据：找不到的单据返回 null', pay.receipt('nope') === null);
    check('台账：记录了 agent / 金额 / 商户 / 时间 / 状态',
      (() => { const t = pay.listTransactions()[0]; return t.agent === 'scribe' && t.amountCents === 1999 && t.merchant === '书店' && t.createdAt > 0 && t.status === 'charged'; })(),
      JSON.stringify(pay.listTransactions()[0]).slice(0, 200));
    check('台账：可按 agent 过滤', pay.listTransactions({ agent: 'scribe' }).length === 1 && pay.listTransactions({ agent: 'other' }).length === 0);
  }

  /* 金额入口校验：缺 / 非法金额必须在落库前挡掉。
   * 旧行为：策略层判 BAD_AMOUNT，但 deny 分支仍 insertTx 写 NaN → INTEGER NOT NULL
   * 绑定/约束异常 → 500 INTERNAL（本应 400）。 */
  {
    const { pay } = fresh({ perTx: 10000, daily: 10000, monthly: 10000, autoApprove: 10000 });
    const md = mkMandate(pay);
    let threw = null;
    let miss = null;
    try {
      miss = await pay.purchase({ merchant: 'M', category: 'C', mandateId: md.id });
      await pay.purchase({ amountCents: 'abc', merchant: 'M', category: 'C', mandateId: md.id });
      await pay.purchase({ amountCents: -100, merchant: 'M', category: 'C', mandateId: md.id });
      await pay.purchase({ amountCents: 1e30, merchant: 'M', category: 'C', mandateId: md.id });
    } catch (e) { threw = e; }
    check('D21：缺 / 非法金额 → BAD_AMOUNT 且不抛异常（HTTP 层能拿到 400）',
      !threw && !!miss && miss.ok === false && miss.code === 'BAD_AMOUNT', threw ? String(threw) : JSON.stringify(miss));
    check('D21：非法金额不落台账（坏值不进 INTEGER 列）',
      pay.listTransactions().length === 0, JSON.stringify(pay.listTransactions()));
  }

  /* 授权按有效期（periodStart / periodEnd）判定——不是终身累计。
   * 界面每月签一份（额度=设置里的每月上限、有效期=本月），到期由策略拒绝、
   * 下个月的第一次购买前续签新的一份；没签窗口（period 全 0）保持旧档的终身口径。 */
  {
    const ps = localMs(2026, 1, 1, 0, 0), pe = localMs(2026, 2, 1, 0, 0);
    const mdWin = { totalLimitCents: 9999, spent: 0, categories: [], periodStart: ps, periodEnd: pe };

    VNOW = localMs(2026, 1, 5, 12, 0);
    check('D26 策略：有效期覆盖当前 → 正常裁决（不因有效期拒绝）',
      evalWith(policyCfg(), { amountCents: 100 }, { mandate: mdWin }).decision !== 'deny');
    VNOW = localMs(2026, 2, 5, 12, 0);
    check('D26 策略：授权已过期 → MANDATE_EXPIRED（旧实现忽略窗口、照常往下裁）',
      evalWith(policyCfg(), { amountCents: 100 }, { mandate: mdWin }).code === 'MANDATE_EXPIRED');
    check('D26 策略：授权未开始 → MANDATE_EXPIRED',
      evalWith(policyCfg(), { amountCents: 100 }, { mandate: Object.assign({}, mdWin, { periodStart: localMs(2026, 3, 1, 0, 0), periodEnd: localMs(2026, 4, 1, 0, 0) }) }).code === 'MANDATE_EXPIRED');
    check('D26 策略：没签有效期（period 全 0，旧档口径）→ 不做有效期判定',
      evalWith(policyCfg(), { amountCents: 100 }, { mandate: { totalLimitCents: 9999, spent: 0, categories: [] } }).decision !== 'deny');
    check('D26：错误码表里有 MANDATE_EXPIRED', PAYMENT_CODES.indexOf('MANDATE_EXPIRED') >= 0);
  }

  {
    // 网关：一月的授权一月内花满 → 窗口内累计超限照旧拒绝；过了有效期再用同一授权 →
    // MANDATE_EXPIRED；按月续签一份新授权（二月窗口）→ 同样的购买放行，一月的花费不占新额度
    VNOW = localMs(2026, 1, 5, 12, 0);
    const { pay } = fresh({ perTx: 10000, daily: 10000, monthly: 100000, autoApprove: 10000 });
    const jan = pay.createMandate({ agent: 'a', totalLimitCents: 5000, currency: 'CNY', categories: [], periodStart: localMs(2026, 1, 1, 0, 0), periodEnd: localMs(2026, 2, 1, 0, 0) });
    const r1 = await pay.purchase({ amountCents: 5000, merchant: 'M', category: 'C', mandateId: jan.id });
    check('D26 网关：窗口内花满授权额度（窗口内累计口径不变）', r1.ok === true, JSON.stringify(r1).slice(0, 160));
    const r2 = await pay.purchase({ amountCents: 100, merchant: 'M', category: 'C', mandateId: jan.id });
    check('D26 网关：窗口内累计超总额 → MANDATE_EXCEEDED', r2.ok === false && r2.code === 'MANDATE_EXCEEDED', JSON.stringify(r2).slice(0, 160));
    VNOW = localMs(2026, 2, 5, 12, 0);
    const r3 = await pay.purchase({ amountCents: 100, merchant: 'M', category: 'C', mandateId: jan.id });
    check('D26 网关：过了有效期的授权 → MANDATE_EXPIRED（旧实现是终身累计的 MANDATE_EXCEEDED）',
      r3.ok === false && r3.code === 'MANDATE_EXPIRED', JSON.stringify(r3).slice(0, 160));
    const feb = pay.createMandate({ agent: 'a', totalLimitCents: 5000, currency: 'CNY', categories: [], periodStart: localMs(2026, 2, 1, 0, 0), periodEnd: localMs(2026, 3, 1, 0, 0) });
    const r4 = await pay.purchase({ amountCents: 5000, merchant: 'M', category: 'C', mandateId: feb.id });
    check('D26 网关：续签新授权（二月窗口）→ 一月的花费不占新额度，放行', r4.ok === true, JSON.stringify(r4).slice(0, 160));
    check('D26 网关：台账挂在各自的 mandate 上（一月四笔、续签单带新授权 id）',
      pay.getTx(r4.intentId).mandateId === feb.id && pay.listTransactions({ agent: 'a' }).length === 4);
  }

  {
    // 窗口外的旧账不计入这份授权的额度（mandateSpent 按 period 过滤）：
    // 手动造一笔窗口开始之前的已扣款台账，窗口内的购买不该被它占掉额度
    VNOW = localMs(2026, 2, 5, 12, 0);
    const { db, pay } = fresh({ perTx: 10000, daily: 10000, monthly: 100000, autoApprove: 10000 });
    const md = pay.createMandate({ agent: 'a', totalLimitCents: 5000, currency: 'CNY', categories: [], periodStart: localMs(2026, 1, 1, 0, 0), periodEnd: localMs(2026, 3, 1, 0, 0) });
    db.prepare(
      'INSERT INTO payment_transactions (id, intent_id, agent, amount_cents, currency, merchant, category, items, status, code, provider_ref, mandate_id, created_at, approved_at, charged_at) '
      + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run('tx-old', 'pi-old', 'a', 5000, 'CNY', 'M', 'C', '[]', 'charged', '', '', md.id, localMs(2025, 12, 15, 12, 0), null, null);
    const r = await pay.purchase({ amountCents: 5000, merchant: 'M', category: 'C', mandateId: md.id });
    check('D26 网关：窗口外的旧账不计入授权额度（按 period 过滤统计，旧实现终身累计会拒）',
      r.ok === true, JSON.stringify(r).slice(0, 200));
  }

  /* 回归（前端侧，静态）：签发带本月窗口、复用前核有效期、文案说「本月额度」 */
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'features.js'), 'utf8');
    check('D26 前端：签发授权带本月窗口（periodStart / periodEnd 随单下发）',
      src.indexOf('periodStart: b0.getTime()') >= 0 && src.indexOf('periodEnd: b1.getTime()') >= 0);
    check('D26 前端：复用授权先核有效期（过期的签新的一份，不再终身复用最新一份）',
      src.indexOf('m.periodEnd > t && m.periodStart <= t') >= 0 && src.indexOf('mds[0].id') === -1);
    check('D26 前端：确认文案说「本月额度」与续签，不再把每月上限说成总额度',
      src.indexOf('本月额度') >= 0 && src.indexOf('有效期：到 ') >= 0 && src.indexOf('总额度：') === -1);
  }

}

run('支付网关单测', main);
