#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 提案模块单测（src/core/proposals.ts，Node 离线，不联网）
 *
 * 用手写的「假 sidecar」（记录每次调用的方法名与参数）验的 11 条，
 * 重点盯安全红线：
 *   - 提案路径绝不调用 emailSend（直发），只用 emailDraft → emailSendDraft；
 *   - paymentPurchase（额度内可能直接扣款）只出现在「用户点了确认」之后；
 *   - paymentApprove 只出现在「第二次确认」之后；拒绝走 paymentDeny；
 *   - 确认幂等（连点 / 网络慢再点只执行一次）；过期不执行；
 *   - 状态机收口：二次确认走 awaiting_confirm（受同一份 TTL）、confirm 可重入、中断的 executing
 *     收敛为 failed、旧档迁移；发信失败留住 draftId 并清理残留草稿；
 *   - create / isActionable 之外的路径对 sidecar 零调用。
 *
 * 用法：node eval/proposals-test.js
 */
const path = require('path');

global.window = global;
const P = require(path.join(__dirname, '..', 'src', 'core', 'proposals.ts')).Proposals;
if (!P) {
  console.error('加载失败：Proposals 导出缺失');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}

/* ---- 假 sidecar：记录调用（方法名 + 参数），行为可编程 ---- */
function makeSidecar(opts) {
  const o = opts || {};
  const calls = [];
  const rec = (name, ret) => (...args) => {
    calls.push({ name: name, args: args });
    if (typeof o[name] === 'function') return o[name](...args);
    return typeof ret === 'function' ? ret(...args) : Promise.resolve(ret);
  };
  return {
    calls: calls,
    countOf: name => calls.filter(c => c.name === name).length,
    names: () => calls.map(c => c.name),
    emailDraft: rec('emailDraft', () => ({ id: 'd-1' })),
    emailSendDraft: rec('emailSendDraft', () => ({ ok: true })),
    emailSend: rec('emailSend', () => ({ ok: true })),
    emailDiscardDraft: rec('emailDiscardDraft', () => ({ ok: true, discarded: true })),
    paymentPurchase: rec('paymentPurchase', () => ({ ok: true, needsApproval: false, status: 'charged', intentId: 'pi-1' })),
    paymentApprove: rec('paymentApprove', () => ({ ok: true, status: 'charged' })),
    paymentDeny: rec('paymentDeny', () => ({ ok: true, status: 'denied' })),
    paymentCharge: rec('paymentCharge', () => ({ ok: true, status: 'charged' })),
    paymentMarkPaid: rec('paymentMarkPaid', () => ({ ok: true })),
  };
}

const TTL = P.DEFAULT_TTL_MS;
const T0 = 1700000000000;
// 二次确认（额度授权）的固定返回：payment 侧车要求用户再点一次
const needsApproval = intentId => () => Promise.resolve({
  ok: true, needsApproval: true, intentId: intentId,
  summary: { remaining: { dailyCents: 10000, monthlyCents: 20000 } },
});

async function main() {
  /* 1. email 校验 */
  const emailBad = [
    ['缺 to', {}],
    ['非法地址', { to: 'not-an-email', subject: 's', body: 'b' }],
    ['to 含换行', { to: 'a@b.com\nCc: evil@x.com', subject: 's', body: 'b' }],
    ['subject 含换行', { to: 'a@b.com', subject: 's\r\nBcc: evil@x.com', body: 'b' }],
    ['正文超长', { to: 'a@b.com', subject: 's', body: 'x'.repeat(P.MAX_BODY + 1) }],
    ['缺 subject', { to: 'a@b.com', body: 'b' }],
    ['缺 body', { to: 'a@b.com', subject: 's' }],
    ['主题超长', { to: 'a@b.com', subject: 's'.repeat(P.MAX_SUBJECT + 1), body: 'b' }],
  ];
  for (const [label, args] of emailBad) {
    const r = P.create('email', args, T0);
    check('email 校验：' + label + ' → ok:false', r && r.ok === false && !!r.error, r && r.error);
  }
  const eOk = P.create('email', { to: 'me@example.com', subject: '你好', body: '正文', reason: '用户让我发' }, T0);
  check('email 校验：合法参数 → ok:true 且参数规范化保留', eOk.ok === true
    && eOk.proposal.args.to === 'me@example.com' && eOk.proposal.args.subject === '你好'
    && eOk.proposal.args.body === '正文' && eOk.proposal.args.reason === '用户让我发');

  /* 2. payment 校验 */
  for (const [label, args] of [
    ['金额缺失', { merchant: 'm' }],
    ['金额 ≤ 0', { amount: 0, merchant: 'm' }],
    ['金额为负', { amount: -3, merchant: 'm' }],
    ['超过上限', { amount: P.MAX_AMOUNT_CENTS / 100 + 0.01, merchant: 'm' }],
  ]) {
    const r = P.create('payment', args, T0);
    check('payment 校验：' + label + ' → ok:false', r && r.ok === false && !!r.error, r && r.error);
  }
  const p1234 = P.create('payment', { amount: 12.34, merchant: '书店', category: '图书', items: ['书 x1'] }, T0);
  check('payment 校验：12.34 元 → amountCents === 1234', p1234.ok === true && p1234.proposal.args.amountCents === 1234,
    p1234.proposal && p1234.proposal.args.amountCents);
  const pFloat = P.create('payment', { amount: 0.1 + 0.2 }, T0);
  check('payment 校验：0.1+0.2 元 → amountCents === 30（浮点换算正确）',
    pFloat.ok === true && pFloat.proposal.args.amountCents === 30, pFloat.proposal && pFloat.proposal.args.amountCents);
  check('payment 校验：items 规范成 {name} 结构', p1234.ok === true
    && Array.isArray(p1234.proposal.args.items) && p1234.proposal.args.items[0].name === '书 x1',
    JSON.stringify(p1234.proposal && p1234.proposal.args.items));
  const pTooMany = P.create('payment', { amount: 1, items: ['a', 'b', 'c', 'd', 'e', 'f'] }, T0);
  check('payment 校验：items 超过 5 项 → ok:false', pTooMany.ok === false);

  /* 3. create 状态机起点 + isActionable 过期切换 */
  const p3 = P.create('payment', { amount: 1, merchant: 'm' }, T0);
  const prop3 = p3.proposal;
  check('create：状态 pending、expiresAt = now + TTL',
    prop3.status === 'pending' && prop3.expiresAt === T0 + TTL,
    prop3.status + ' / ' + (prop3.expiresAt - T0));
  check('isActionable：未过期为真', P.isActionable(prop3, T0 + TTL - 1) === true);
  check('isActionable：过期后为假', P.isActionable(prop3, T0 + TTL) === false);

  /* 4. email 确认：严格 emailDraft → emailSendDraft，且 emailSend 从未被调用 */
  const S4 = makeSidecar();
  const p4 = P.create('email', { to: 'you@example.com', subject: 'hi', body: 'b' }, T0).proposal;
  const r4 = await P.confirm(p4, S4, T0);
  check('email 确认：调用顺序严格 emailDraft → emailSendDraft',
    S4.names().join('→') === 'emailDraft→emailSendDraft', S4.names().join('→'));
  check('email 确认：emailSend 从未被调用（红线 2）', S4.countOf('emailSend') === 0);
  check('email 确认：状态 done', r4.status === 'done' && p4.status === 'done', p4.status);

  /* 5. email 拒绝：不调用任何发送类方法 */
  const S5 = makeSidecar();
  const p5 = P.create('email', { to: 'you@example.com', subject: 'hi', body: 'b' }, T0).proposal;
  const r5 = await P.deny(p5, S5, T0);
  check('email 拒绝：状态 denied', r5.status === 'denied' && p5.status === 'denied');
  check('email 拒绝：不调用任何发送类方法（含 emailSend / emailSendDraft）',
    S5.countOf('emailSend') === 0 && S5.countOf('emailSendDraft') === 0 && S5.countOf('emailDraft') === 0,
    S5.names().join(','));

  /* 6. payment 确认（额度内直接放行）：purchase 只在 confirm 之后调用 1 次 */
  const S6 = makeSidecar();
  const p6 = P.create('payment', { amount: 12.34, merchant: '书店' }, T0).proposal;
  check('payment 确认：confirm 之前 paymentPurchase 调用次数为 0（红线 3）', S6.countOf('paymentPurchase') === 0);
  const r6 = await P.confirm(p6, S6, T0);
  check('payment 确认：confirm 之后 paymentPurchase 调用次数为 1', S6.countOf('paymentPurchase') === 1);
  check('payment 确认：返回 charged → 状态 done', r6.status === 'done' && p6.status === 'done', p6.status);
  check('payment 确认：直接放行路径没有调用 approve / charge / markPaid',
    S6.countOf('paymentApprove') === 0 && S6.countOf('paymentCharge') === 0 && S6.countOf('paymentMarkPaid') === 0,
    S6.names().join(','));

  /* 7. payment 返回 needsApproval：不自动批准；二次点击才 approve，拒绝走 deny */
  const S7 = makeSidecar({
    paymentPurchase: () => Promise.resolve({
      ok: true, needsApproval: true, intentId: 'pi-7', summary: { remaining: { daily: 100, monthly: 200 } },
    }),
  });
  const p7 = P.create('payment', { amount: 30, merchant: 'm' }, T0).proposal;
  const r7 = await P.confirm(p7, S7, T0);
  check('payment 二次确认：confirm 返回 needsSecondConfirm', !!(r7 && r7.needsSecondConfirm) && r7.intentId === 'pi-7',
    JSON.stringify(r7));
  check('payment 二次确认：状态转 awaiting_confirm（不是 executing）',
    p7.status === P.STATUS.AWAITING && P.STATUS.AWAITING === 'awaiting_confirm', p7.status);
  check('payment 二次确认：此时 paymentApprove 调用次数为 0（不得自动批准）', S7.countOf('paymentApprove') === 0);
  const r7b = await P.approveSecond(p7, S7, T0 + 1000);
  check('payment 二次确认：用户点了确认才调用 paymentApprove（1 次）且状态 done',
    S7.countOf('paymentApprove') === 1 && r7b.status === 'done' && p7.status === 'done',
    S7.names().join(',') + ' / ' + p7.status);

  const S7d = makeSidecar({ paymentPurchase: needsApproval('pi-7d') });
  const p7d = P.create('payment', { amount: 30, merchant: 'm' }, T0).proposal;
  await P.confirm(p7d, S7d, T0);
  const r7d = await P.deny(p7d, S7d, T0 + 1);
  check('payment 二次确认：用户拒绝 → 调用 paymentDeny、状态 denied、approve 仍为 0',
    S7d.countOf('paymentDeny') === 1 && S7d.countOf('paymentApprove') === 0
    && r7d.status === 'denied' && p7d.status === 'denied',
    S7d.names().join(',') + ' / ' + p7d.status);

  /* 7b. 状态机收口：二次确认不再借用 executing —— 关窗 / 刷新后既不卡死、也不过期失效 */
  {
    const S7b = makeSidecar({ paymentPurchase: needsApproval('pi-7b') });
    const p7b = P.create('payment', { amount: 30, merchant: 'm' }, T0).proposal;
    await P.confirm(p7b, S7b, T0);
    check('二次确认中：isWaitingSecond = true 且状态是 awaiting_confirm',
      P.isWaitingSecond(p7b) === true && p7b.status === 'awaiting_confirm', p7b.status);
    check('二次确认中：未过期时可操作（UI 可给「继续确认」）',
      P.isActionable(p7b, T0 + TTL - 1) === true);

    // 可重入：再点一次「确认」只是把二次确认请求交还，不重复下单、不自动批准
    const again = await P.confirm(p7b, S7b, T0 + 1000);
    check('二次确认中：confirm 可重入（原样返回 needsSecondConfirm，不重复下单、不自动批准）',
      !!again.needsSecondConfirm && again.intentId === 'pi-7b'
      && S7b.countOf('paymentPurchase') === 1 && S7b.countOf('paymentApprove') === 0,
      JSON.stringify(again) + ' / purchase=' + S7b.countOf('paymentPurchase'));

    check('二次确认中：过期后不可操作、收敛为 expired', P.isActionable(p7b, T0 + TTL) === false && p7b.status === 'expired',
      p7b.status);
    const before = S7b.calls.length;
    const late = await P.approveSecond(p7b, S7b, T0 + TTL + 1);
    check('二次确认中：过期后迟到的 approveSecond 不调 sidecar、返回 expired',
      S7b.calls.length === before && late.status === 'expired', late.status);

    // 用户主动拒绝仍然有效（而不是只能等过期）
    const S7c = makeSidecar({ paymentPurchase: needsApproval('pi-7c') });
    const p7c = P.create('payment', { amount: 30, merchant: 'm' }, T0).proposal;
    await P.confirm(p7c, S7c, T0);
    const r7c = await P.deny(p7c, S7c, T0 + 1);
    check('二次确认中：用户拒绝 → paymentDeny 已调用、状态 denied',
      S7c.countOf('paymentDeny') === 1 && r7c.status === 'denied' && p7c.status === 'denied',
      S7c.names().join(',') + ' / ' + p7c.status);
  }

  /* 7c. 中断的 executing（页面在请求途中被关掉，落盘后又被读到）：收敛为 failed，不自动重试 */
  {
    const S7e = makeSidecar();
    const orphan = {
      id: 'pp-orphan', kind: 'email', status: 'executing', createdAt: T0, expiresAt: T0 + TTL,
      args: { to: 'a@b.com', subject: 's', body: 'b' }, result: { ok: false, draftId: 'd-orphan', draftDiscarded: false },
    };
    const st = P.reconcile(orphan, T0 + 1000);
    check('中断：读档时的 executing 收敛为 failed（结果未知），保留 draftId',
      st === 'failed' && orphan.status === 'failed' && /中断/.test(orphan.result.error) && orphan.result.draftId === 'd-orphan',
      st + ' / ' + (orphan.result && orphan.result.error));
    const rc = await P.confirm(orphan, S7e, T0 + 2000);
    check('中断：failed 之后 confirm 不重试（不重复发信 / 不重复扣款）',
      rc.status === 'failed' && S7e.calls.length === 0, rc.status + ' / ' + S7e.names().join(','));
  }

  /* 7d. 旧档迁移：0.13.0 之前 awaiting 曾被写成 executing + result.needsSecondConfirm */
  {
    const legacyWait = {
      kind: 'payment', status: 'executing', createdAt: T0, expiresAt: T0 + TTL, args: { amountCents: 100 },
      result: { needsSecondConfirm: true, resolved: false, intentId: 'pi-old', summary: null },
    };
    check('旧档迁移：executing + resolved:false → awaiting_confirm（isWaitingSecond 为真）',
      P.isWaitingSecond(legacyWait) === true && legacyWait.status === 'awaiting_confirm', legacyWait.status);

    const legacyMid = {
      kind: 'payment', status: 'executing', createdAt: T0, expiresAt: T0 + TTL, args: { amountCents: 100 },
      result: { needsSecondConfirm: true, resolved: true, intentId: 'pi-mid' },
    };
    P.reconcile(legacyMid, T0 + 1);
    check('旧档迁移：executing + resolved:true（批准请求中途丢失）→ failed，结果未知',
      legacyMid.status === 'failed' && /中断/.test(legacyMid.result.error), legacyMid.status + ' / ' + legacyMid.result.error);
  }

  /* 7e. 发信失败：留住 draftId、清掉残留草稿；清不掉时可重试 */
  {
    const S7f = makeSidecar({
      emailSendDraft: () => Promise.resolve({ ok: false, code: 'PROVIDER_ERROR', message: 'SMTP 挂了' }),
    });
    const p7f = P.create('email', { to: 'a@b.com', subject: 's', body: 'b' }, T0).proposal;
    const r7f = await P.confirm(p7f, S7f, T0);
    check('发信失败：draftId 留在 result 里（能指认残留草稿）',
      r7f.status === 'failed' && p7f.result.draftId === 'd-1', r7f.status + ' / ' + p7f.result.draftId);
    check('发信失败：残留草稿被自动丢弃（草稿箱不留一封点到就发的信）',
      S7f.countOf('emailDiscardDraft') === 1 && p7f.result.draftDiscarded === true,
      S7f.names().join(',') + ' / ' + p7f.result.draftDiscarded);

    let offline = true;
    const S7g = makeSidecar({
      emailSendDraft: () => Promise.reject(new Error('SMTP 挂了')),
      emailDiscardDraft: () => (offline ? Promise.reject(new Error('本地服务离线')) : Promise.resolve({ ok: true, discarded: true })),
    });
    const p7g = P.create('email', { to: 'a@b.com', subject: 's', body: 'b' }, T0).proposal;
    await P.confirm(p7g, S7g, T0);
    check('发信失败：清理也失败时记 draftDiscarded:false、状态仍是 failed',
      p7g.status === 'failed' && p7g.result.draftDiscarded === false && p7g.result.draftId === 'd-1',
      p7g.status + ' / ' + p7g.result.draftDiscarded);

    offline = false;
    const r7g = await P.deny(p7g, S7g, T0 + 1);
    check('失败后 deny：只清残留草稿、不改状态',
      S7g.countOf('emailDiscardDraft') === 2 && r7g.status === 'failed'
      && p7g.status === 'failed' && p7g.result.draftDiscarded === true,
      S7g.names().join(',') + ' / ' + p7g.status);
    const nAfter = S7g.countOf('emailDiscardDraft');
    await P.deny(p7g, S7g, T0 + 2);
    check('失败后 deny：草稿已清干净后不再重复调用（幂等）',
      S7g.countOf('emailDiscardDraft') === nAfter, S7g.names().join(','));
  }

  /* 8. 幂等：连点两次确认（第二次在第一次未完成时发起）只执行一次 */
  let release = null;
  const gate = new Promise(res => { release = res; });
  const S8 = makeSidecar({
    emailSendDraft: () => gate.then(() => ({ ok: true })),
  });
  const p8 = P.create('email', { to: 'you@example.com', subject: 'hi', body: 'b' }, T0).proposal;
  const first = P.confirm(p8, S8, T0);              // 不 await：模拟第一次点击还在途中
  const second = await P.confirm(p8, S8, T0);        // 用户又点了一次
  check('幂等：第二次 confirm 立即返回当前状态、不再执行',
    second.status === 'executing', second.status);
  release();
  await first;
  check('幂等：执行类方法（emailDraft + emailSendDraft）总共只被调用一次',
    S8.countOf('emailDraft') === 1 && S8.countOf('emailSendDraft') === 1 && S8.countOf('emailSend') === 0,
    S8.names().join(','));

  /* 9. 过期：confirm 不调用任何 sidecar 方法，状态 expired */
  const S9 = makeSidecar();
  const p9 = P.create('email', { to: 'you@example.com', subject: 'hi', body: 'b' }, T0).proposal;
  const r9 = await P.confirm(p9, S9, T0 + TTL);
  check('过期：confirm 不调用任何 sidecar 方法', S9.calls.length === 0, S9.names().join(','));
  check('过期：状态 expired', r9.status === 'expired' && p9.status === 'expired', p9.status);

  /* 10. sidecar 抛异常 → failed，带可读原因，且之后再 confirm 不重试 */
  const S10 = makeSidecar({
    emailSendDraft: () => Promise.reject(new Error('SMTP 挂了')),
  });
  const p10 = P.create('email', { to: 'you@example.com', subject: 'hi', body: 'b' }, T0).proposal;
  const r10 = await P.confirm(p10, S10, T0);
  check('异常：状态 failed 且原因可读', r10.status === 'failed' && p10.status === 'failed'
    && /SMTP/.test((p10.result && p10.result.error) || ''), p10.result && p10.result.error);
  check('异常：残留草稿被顺手清掉，draftId 仍留在 result 里',
    S10.countOf('emailDiscardDraft') === 1 && p10.result.draftId === 'd-1',
    S10.names().join(',') + ' / ' + p10.result.draftId);
  const r10b = await P.confirm(p10, S10, T0 + 1);
  check('异常：之后再 confirm 不重试执行（sidecar 仍只被调用过那一次）',
    S10.countOf('emailSendDraft') === 1 && S10.countOf('emailDraft') === 1 && r10b.status === 'failed',
    S10.names().join(','));

  /* 11. create / isActionable 对 sidecar 零调用 */
  const S11 = makeSidecar();
  P.create('email', { to: 'a@b.com', subject: 's', body: 'b' }, T0);
  P.create('payment', { amount: 1 }, T0);
  P.isActionable(p3, T0);
  P.isActionable(p3, T0 + TTL);
  check('零调用：create / isActionable 不碰任何 sidecar 方法', S11.calls.length === 0, S11.names().join(','));

  /* 附：deny 对已执行完的提案不重复调用 sidecar（防二次伤害） */
  const S12 = makeSidecar();
  const p12 = P.create('email', { to: 'a@b.com', subject: 's', body: 'b' }, T0).proposal;
  await P.confirm(p12, S12, T0);
  const nBefore = S12.calls.length;
  await P.deny(p12, S12, T0);
  check('幂等：done 之后再点拒绝不触发任何 sidecar 调用', S12.calls.length === nBefore, S12.names().join(','));
}

main()
  .catch(e => { check('测试过程无异常', false, e && e.message); })
  .then(() => {
    const pass = results.filter(r => r.hit).length;
    for (const r of results) {
      console.log((r.hit ? '  ✔ ' : '  ✘ ') + r.name + (r.hit || !r.detail ? '' : '   → ' + r.detail));
    }
    console.log('\n提案模块单测：' + pass + '/' + results.length + ' 通过');
    if (pass !== results.length) process.exitCode = 1;
  });
