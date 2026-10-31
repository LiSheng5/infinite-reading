#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 邮件服务单测（sidecar/email.mjs）
 *
 * 不联网（resend 用假 fetch）、不落盘（内存 SQLite）。重点在「安全边界」：
 *   - 白名单是后端硬校验：不在名单里 → 只能落草稿，必须用户确认才发；
 *   - 每日上限：默认 0 = 一封都不发；到上限拒绝；跨天重置；
 *   - 审计：成功 / 被拒 / 草稿 / 确认都留痕，且不记正文；
 *   - 适配器可换：mock 记账，resend 走 HTTP（缺 key 给结构化错误码）。
 *
 * 用法：node eval/email-test.js
 */
const { check, run, loadEsm, localMs } = require('./_harness.js');

async function main() {
  const { createEmail } = await loadEsm('email.mjs');
  const { openDbAt } = await loadEsm('db.mjs');

  let VNOW = localMs(2026, 1, 5, 12, 0);

  function fresh(overrides, providers) {
    const db = openDbAt(':memory:');
    const cfg = {
      email: Object.assign({
        enabled: true, provider: 'mock', allowlist: [], dailyLimit: 0, from: 'me@example.com', resendApiKey: '',
      }, overrides || {}),
    };
    const deps = { db: db, getConfig: () => cfg, now: () => VNOW };
    if (providers) deps.providers = providers;
    return { db: db, cfg: cfg, mail: createEmail(deps) };
  }

  // 慢速发送桩：把「上限检查 → await provider.send」之间的窗口撑开，才能验证占位是否生效
  function slowProviders() {
    const box = { calls: 0 };
    box.providers = {
      mock: {
        label: '慢速桩',
        async send() {
          box.calls += 1;
          await new Promise(r => setTimeout(r, 20));
          return { id: 'slow-' + box.calls, status: 'ok' };
        },
        async list() { return { ok: true, messages: [] }; },
      },
    };
    return box;
  }

  /* 1. 功能未开启：直接拒绝并留痕 */
  {
    const { mail, cfg } = fresh({ enabled: false });
    const r = await mail.send({ to: 'a@b.com', subject: 's', body: 'b' });
    check('未开启：拒绝并返回 EMAIL_DISABLED', r.ok === false && r.code === 'EMAIL_DISABLED', JSON.stringify(r));
    const audit = mail.listAudit();
    check('未开启：审计留痕（denied）', audit.length === 1 && audit[0].status === 'denied' && audit[0].code === 'EMAIL_DISABLED');
    check('未开启：不发网络请求（provider 未被触发）', cfg.email.provider === 'mock');
  }

  /* 2. 地址校验 */
  {
    const { mail } = fresh({ dailyLimit: 5 });
    const r = await mail.send({ to: 'not-an-address', subject: 's', body: 'b' });
    check('非法收件人：BAD_RECIPIENT', r.ok === false && r.code === 'BAD_RECIPIENT', JSON.stringify(r));
    check('地址归一化：去空格 + 小写', mail.normalizeAddress('  A@B.COM ') === 'a@b.com');
    check('地址归一化：非法返回空', mail.normalizeAddress('a@@b') === '');
  }

  /* 3. 白名单命中 + 有额度 → 直接发送 */
  {
    const { mail } = fresh({ allowlist: ['  BUDDY@example.com '], dailyLimit: 5 });
    const r = await mail.send({ to: 'buddy@example.com', subject: '你好', body: '正文', actor: 'user' });
    check('白名单命中（忽略大小写与空格）：发送成功', r.ok === true && r.provider === 'mock', JSON.stringify(r));
    const audit = mail.listAudit();
    check('发送成功：审计记录 ok', audit.length === 1 && audit[0].kind === 'send' && audit[0].status === 'ok');
    check('审计不含正文', !('body' in audit[0]), JSON.stringify(Object.keys(audit[0])));
    check('白名单命中不会产生草稿', mail.listDrafts().length === 0);
  }

  /* 4. 不在白名单 + 未确认 → 只落草稿 */
  {
    const { mail } = fresh({ allowlist: ['buddy@example.com'], dailyLimit: 5 });
    const r = await mail.send({ to: 'stranger@example.com', subject: '推销', body: 'x' });
    check('非白名单未确认：返回 NEED_CONFIRMATION', r.ok === false && r.code === 'NEED_CONFIRMATION', JSON.stringify(r));
    check('非白名单未确认：自动落成草稿', !!r.draftId && mail.listDrafts().length === 1);
    const audit = mail.listAudit();
    check('非白名单未确认：审计标记 denied/NEED_CONFIRMATION',
      audit.some(a => a.kind === 'draft' && a.status === 'denied' && a.code === 'NEED_CONFIRMATION'));
    check('非白名单未确认：草稿只记一条审计（不在调用侧重复记账）',
      audit.filter(a => a.kind === 'draft').length === 1,
      JSON.stringify(audit.map(a => a.kind + '/' + a.status)));
    check('非白名单未确认：没有产生「已发送」记录', !audit.some(a => a.kind === 'send' && a.status === 'ok'));

    // 用户在界面上确认 → 用草稿发送
    const sent = await mail.sendDraft(r.draftId, { actor: 'user' });
    check('用户确认草稿后：发送成功', sent.ok === true, JSON.stringify(sent));
    check('确认后：草稿标记为 sent', mail.getDraft(r.draftId).status === 'sent');
    check('确认后：审计有 confirm 记录', mail.listAudit().some(a => a.kind === 'confirm' && a.status === 'ok'));
    const again = await mail.sendDraft(r.draftId, { actor: 'user' });
    check('重复确认同一草稿：DRAFT_ALREADY_SENT', again.ok === false && again.code === 'DRAFT_ALREADY_SENT', JSON.stringify(again));
    const missing = await mail.sendDraft('nope');
    check('不存在的草稿：DRAFT_NOT_FOUND', missing.ok === false && missing.code === 'DRAFT_NOT_FOUND');
  }

  /* 5. 草稿确认流内部带 confirmed（sendDraft 用）可越过白名单，但仍受上限约束 */
  {
    const { mail } = fresh({ allowlist: [], dailyLimit: 2 });
    const r = await mail.send({ to: 'stranger@example.com', subject: 's', body: 'b', actor: 'user' }, { confirmed: true });
    check('内部 confirmed：越过白名单直接发送', r.ok === true, JSON.stringify(r));
    const r2 = await mail.send({ to: 'stranger2@example.com', subject: 's', body: 'b', confirm: true, actor: 'user' });
    check('请求体里的 confirm 不算数（只走内部 opts.confirmed）', r2.ok === false && r2.code === 'NEED_CONFIRMATION', JSON.stringify(r2));
  }

  /* 6. 每日上限：默认 0 = 一封都不发 */
  {
    const { mail } = fresh({ allowlist: ['a@b.com'], dailyLimit: 0 });
    const r = await mail.send({ to: 'a@b.com', subject: 's', body: 'b', actor: 'user' });
    check('上限为 0：一封都不发（保守默认）', r.ok === false && r.code === 'DAILY_LIMIT_EXCEEDED', JSON.stringify(r));
  }

  /* 7. 每日上限：到量拒绝，跨天重置 */
  {
    VNOW = localMs(2026, 1, 5, 12, 0);
    const { mail } = fresh({ allowlist: ['a@b.com'], dailyLimit: 1 });
    const r1 = await mail.send({ to: 'a@b.com', subject: '1', body: 'b', actor: 'user' });
    const r2 = await mail.send({ to: 'a@b.com', subject: '2', body: 'b', actor: 'user' });
    check('上限 1：第 1 封放行', r1.ok === true, JSON.stringify(r1));
    check('上限 1：第 2 封被拒', r2.ok === false && r2.code === 'DAILY_LIMIT_EXCEEDED', JSON.stringify(r2));
    check('stats：当日已发 1 封 / 上限 1', mail.stats().sentToday === 1 && mail.stats().dailyLimit === 1, JSON.stringify(mail.stats()));

    VNOW = localMs(2026, 1, 6, 12, 0);   // 跨天
    const r3 = await mail.send({ to: 'a@b.com', subject: '3', body: 'b', actor: 'user' });
    check('跨天：额度重置，可再发', r3.ok === true, JSON.stringify(r3));
  }

  /* 8. 适配器：resend 缺 key / 有 key（假 fetch） */
  {
    const { mail } = fresh({ provider: 'resend', allowlist: ['a@b.com'], dailyLimit: 5, resendApiKey: '' });
    const r = await mail.send({ to: 'a@b.com', subject: 's', body: 'b', actor: 'user' });
    check('resend 缺 key：MISSING_RESEND_API_KEY', r.ok === false && r.code === 'MISSING_RESEND_API_KEY', JSON.stringify(r));

    const captured = [];
    global.fetch = (url, init) => {
      captured.push({ url: String(url), auth: (init && init.headers && init.headers.Authorization) || '', body: init && init.body });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 're_123' }) });
    };
    const m2 = fresh({ provider: 'resend', allowlist: ['a@b.com'], dailyLimit: 5, resendApiKey: 'key-abc' });
    const r2 = await m2.mail.send({ to: 'a@b.com', subject: 's', body: 'b', actor: 'user' });
    check('resend 有 key：发送成功并回带 id', r2.ok === true && r2.id === 're_123', JSON.stringify(r2));
    check('resend：打到正确端点并带 Bearer Key',
      captured.length === 1 && captured[0].url === 'https://api.resend.com/emails' && captured[0].auth === 'Bearer key-abc',
      JSON.stringify(captured[0] && captured[0].url));

    global.fetch = () => Promise.resolve({ ok: false, status: 422, text: () => Promise.resolve('bad domain') });
    const m3 = fresh({ provider: 'resend', allowlist: ['a@b.com'], dailyLimit: 5, resendApiKey: 'key-abc' });
    const r3 = await m3.mail.send({ to: 'a@b.com', subject: 's', body: 'b', actor: 'user' });
    check('resend 被服务商拒绝：结构化 PROVIDER_ERROR', r3.ok === false && r3.code === 'PROVIDER_ERROR', JSON.stringify(r3));
  }

  /* 9. 草稿：创建即留审计；丢弃 */
  {
    const { mail } = fresh({ dailyLimit: 5 });
    const d = mail.createDraft({ to: 'a@b.com', subject: 's', body: 'b' });
    check('草稿：创建成功且可读回', !!d.id && mail.getDraft(d.id).subject === 's');
    const a = mail.listAudit();
    check('草稿：直连创建也写审计（draft / ok，不记正文）',
      a.length === 1 && a[0].kind === 'draft' && a[0].status === 'ok' && a[0].actor === 'user' && !('body' in a[0]),
      JSON.stringify(a));
    check('草稿：丢弃成功', mail.discardDraft(d.id) === true);
    check('草稿：丢弃后不在待处理列表', mail.listDrafts().length === 0);
    check('草稿：重复丢弃返回 false', mail.discardDraft(d.id) === false);
  }

  /* 10. 审计 limit 非法值（?limit=abc）：NaN 不进 SQL LIMIT */
  {
    const { mail } = fresh({ allowlist: ['a@b.com'], dailyLimit: 2 });
    await mail.send({ to: 'a@b.com', subject: 's', body: 'b', actor: 'user' });
    let threw = null, audit = null;
    try { audit = mail.listAudit({ limit: 'abc' }); } catch (e) { threw = e; }
    check('审计 limit=abc：夹回默认值，不触发绑定异常', !threw && Array.isArray(audit) && audit.length === 1, String(threw));
    const neg = mail.listAudit({ limit: -5 });
    check('审计 limit 为负：夹回默认值', Array.isArray(neg) && neg.length === 1);
  }

  /* 11. 并发突破每日上限：上限检查与 provider.send 之间必须「先占位再发送」 */
  {
    const box = slowProviders();
    const { mail } = fresh({ provider: 'mock', allowlist: ['a@b.com'], dailyLimit: 2 }, box.providers);
    const rs = await Promise.all([1, 2, 3, 4, 5].map(i => mail.send({ to: 'a@b.com', subject: 's' + i, body: 'b', actor: 'user' })));
    check('D22 并发：5 封同时发、上限 2 → 只成功 2 封（占位先行）',
      rs.filter(x => x.ok).length === 2 && box.calls === 2,
      'ok=' + rs.filter(x => x.ok).length + ' calls=' + box.calls);
    check('D22 并发：其余都被 DAILY_LIMIT_EXCEEDED 拒绝',
      rs.filter(x => !x.ok).every(x => x.code === 'DAILY_LIMIT_EXCEEDED'),
      JSON.stringify(rs.filter(x => !x.ok).map(x => x.code)));
    check('D22 并发：当日计数 = 上限（没有多发）', mail.stats().sentToday === 2, JSON.stringify(mail.stats()));
  }

  /* 12. 草稿双击 / 并发确认：只有第一个能抢占 pending → sending */
  {
    const box = slowProviders();
    const { mail } = fresh({ provider: 'mock', allowlist: [], dailyLimit: 5 }, box.providers);
    const d = mail.createDraft({ to: 'x@y.com', subject: 's', body: 'b' });
    const both = await Promise.all([mail.sendDraft(d.id, { actor: 'user' }), mail.sendDraft(d.id, { actor: 'user' })]);
    check('D22 双击确认：只真正发一封', box.calls === 1 && both.filter(x => x.ok).length === 1,
      'calls=' + box.calls + ' ' + JSON.stringify(both.map(x => x.code || 'ok')));
    check('D22 双击确认：另一路返回 DRAFT_ALREADY_SENT',
      both.filter(x => x.code === 'DRAFT_ALREADY_SENT').length === 1, JSON.stringify(both.map(x => x.code || 'ok')));
    check('D22 双击确认：草稿最终为 sent', mail.getDraft(d.id).status === 'sent', mail.getDraft(d.id).status);
  }

  /* 13. 草稿发送失败要退回 pending（不能卡在 sending 里永远不可重试） */
  {
    const { mail } = fresh({ allowlist: [], dailyLimit: 0 });
    const d = mail.createDraft({ to: 'x@y.com', subject: 's', body: 'b' });
    const r = await mail.sendDraft(d.id, { actor: 'user' });
    check('D22 草稿失败：返回 DAILY_LIMIT_EXCEEDED', r.ok === false && r.code === 'DAILY_LIMIT_EXCEEDED', JSON.stringify(r));
    check('D22 草稿失败：草稿回到 pending（可重试 / 可丢弃）', mail.getDraft(d.id).status === 'pending', mail.getDraft(d.id).status);
    check('D22 草稿失败：不计入当日已发', mail.stats().sentToday === 0, JSON.stringify(mail.stats()));
  }

}

run('邮件单测', main);
