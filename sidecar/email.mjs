/*
 * 无限阅读 · sidecar · 邮件
 *
 * 安全模型：
 *   - 收件人白名单是**后端硬校验**（前端只当提示）：不在白名单里的地址，只能先落成草稿，
 *     必须由用户在界面上确认后才真正发出；
 *   - 每日发送上限按「审计表当日成功发送数」聚合，默认 0 = 一封都不发；
 *   - 每一次发送 / 建草稿 / 被拒都写审计（只记事实，不记正文全文）；
 *   - 服务商用适配器抽象，本期实现 mock 与 resend(HTTP)。SMTP 需要额外依赖（后置）。
 *
 * 注意：邮件不是「模型自己调用的工具」——发信是高风险副作用动作，
 * 一律由用户在界面显式发起 → 确认 → 执行（见 ARCHITECTURE.md）。
 */
import { genId, dayRange, clampInt } from './util.mjs';
import { AUDIT, DRAFT, sqlIn } from './statuses.mjs';

export const EMAIL_CODES = [
  'EMAIL_DISABLED',
  'BAD_RECIPIENT',
  'NEED_CONFIRMATION',
  'DAILY_LIMIT_EXCEEDED',
  'PROVIDER_ERROR',
  'MISSING_RESEND_API_KEY',
  'DRAFT_NOT_FOUND',
  'DRAFT_ALREADY_SENT',
];

const MAX_BODY = 20000;
const MAX_SUBJECT = 300;

// 只做「像不像地址」的基本校验：真正的可达性由服务商决定
const ADDR_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
export function normalizeAddress(v) {
  const s = String(v == null ? '' : v).trim();
  return ADDR_RE.test(s) ? s.toLowerCase() : '';
}

/* ---------------- 服务商适配器（可换 SMTP / Gmail / Resend） ---------------- */

export function createProviders() {
  return {
    mock: {
      label: '模拟（只记账，不真的发信）',
      async send() { return { id: genId('mock-'), status: 'ok' }; },
    },

    resend: {
      label: 'Resend（HTTP API）',
      async send(cfg, msg) {
        const key = (cfg.email && cfg.email.resendApiKey) || '';
        if (!key) throw new Error('MISSING_RESEND_API_KEY');
        const from = (cfg.email && cfg.email.from) || 'onboarding@resend.dev';
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: from, to: [msg.to], subject: msg.subject, text: msg.body }),
        });
        if (!res.ok) {
          let detail = '';
          try { detail = (await res.text()).slice(0, 200); } catch (_) {}
          throw new Error('RESEND_HTTP_' + res.status + (detail ? ' ' + detail : ''));
        }
        let data = {};
        try { data = await res.json(); } catch (_) {}
        return { id: data.id || '', status: 'ok' };
      },
    },
  };
}

/* ---------------- 邮件服务 ---------------- */

export function createEmail(deps) {
  const db = deps.db;
  const getConfig = deps.getConfig;
  const now = deps.now || (() => Date.now());
  const providers = deps.providers || createProviders();

  // 崩溃恢复：sending / pending 是「发送中」的临时态，进程被杀会留下残渣。
  //   - 草稿卡在 sending → 放回 pending，用户还能重试或丢弃；
  //   - 审计占位卡在 pending → 标成 denied（INTERRUPTED），不能把没发出去的信算进当日已发。
  db.prepare('UPDATE email_drafts SET status=? WHERE status=?').run(DRAFT.PENDING, DRAFT.SENDING);
  db.prepare('UPDATE email_audit SET status=?, code=? WHERE kind=? AND status=?')
    .run(AUDIT.DENIED, 'INTERRUPTED', 'send', AUDIT.PENDING);

  function providerOf(cfg) {
    const name = (cfg.email && cfg.email.provider) || 'mock';
    return providers[name] || providers.mock;
  }

  function audit(kind, to, subject, status, code, actor) {
    const id = genId('a');
    db.prepare(
      'INSERT INTO email_audit (id, at, kind, to_addr, subject, status, code, actor) VALUES (?,?,?,?,?,?,?,?)'
    ).run(id, now(), kind, String(to || '').slice(0, 300), String(subject || '').slice(0, MAX_SUBJECT), status, code || '', actor || 'user');
    return id;
  }

  // 当日已发数（本地日聚合审计表）。pending 是本实现新加的「发送占位」：
  // 先落库再发送，并发请求才会看到额度已被这封占用。
  function sentToday(t0) {
    const [d0, d1] = dayRange(t0);
    const r = db.prepare(
      'SELECT COUNT(*) AS n FROM email_audit WHERE kind=? AND status IN ' + sqlIn([AUDIT.OK, AUDIT.PENDING]) + ' AND at >= ? AND at < ?'
    ).get('send', d0, d1);
    return (r && r.n) || 0;
  }

  function inAllowlist(cfg, addr) {
    const list = (cfg.email && cfg.email.allowlist) || [];
    const a = addr.toLowerCase();
    return list.some(x => String(x).trim().toLowerCase() === a);
  }

  /* 建草稿。建草稿本身也是一条要留痕的事实（界面点「存草稿」的直连路由同样走这里），
   * 审计因此统一写在这一处：从「发送被拒、自动落草稿」进来的调用由 opts 带上 denied 与原因码，
   * 一次建草稿仍然只有一条记录（调用侧不再重复记账）。 */
  function createDraft(input, opts) {
    const addr = normalizeAddress(input && input.to);
    const subject = String((input && input.subject) || '').slice(0, MAX_SUBJECT);
    const id = genId('d');
    db.prepare('INSERT INTO email_drafts (id, at, to_addr, subject, body, status) VALUES (?,?,?,?,?,?)')
      .run(id, now(), addr, subject, String((input && input.body) || '').slice(0, MAX_BODY), DRAFT.PENDING);
    audit('draft', addr, subject, (opts && opts.status) || AUDIT.OK, (opts && opts.code) || '', (opts && opts.actor) || 'user');
    return getDraft(id);
  }

  function getDraft(id) {
    const r = db.prepare('SELECT * FROM email_drafts WHERE id = ?').get(String(id || ''));
    return r ? {
      id: r.id, at: Number(r.at), to: r.to_addr, subject: r.subject, body: r.body, status: r.status,
    } : null;
  }

  function listDrafts() {
    return db.prepare('SELECT * FROM email_drafts WHERE status=? ORDER BY at DESC LIMIT 100').all(DRAFT.PENDING)
      .map(r => ({ id: r.id, at: Number(r.at), to: r.to_addr, subject: r.subject, body: r.body, status: r.status }));
  }

  /*
   * 发送。opts.confirmed=true 表示「用户已在草稿确认流里确认过」，此时即便不在白名单也放行
   * （仍然受每日上限约束）。这个标志**只走内部第二参数**，绝不从请求体读——
   * 若 HTTP 层把它当普通字段收上来，白名单闸门就退化成一个可伪造的布尔。
   * 返回结构化结果，让界面 / 调用方能换方案或提示用户。
   */
  async function send(input, opts) {
    const src = input || {};
    const confirmed = !!(opts && opts.confirmed);
    const actor = String(src.actor || 'user');
    const cfg = getConfig();
    const e = cfg.email || {};

    if (!e.enabled) {
      audit('send', src.to, src.subject, AUDIT.DENIED, 'EMAIL_DISABLED', actor);
      return { ok: false, code: 'EMAIL_DISABLED', message: '邮件功能未开启（设置 → 邮件 → 启用）。' };
    }

    const addr = normalizeAddress(src.to);
    if (!addr) {
      audit('send', src.to, src.subject, AUDIT.DENIED, 'BAD_RECIPIENT', actor);
      return { ok: false, code: 'BAD_RECIPIENT', message: '收件人地址不合法。' };
    }

    const subject = String(src.subject || '').slice(0, MAX_SUBJECT);
    const body = String(src.body || '').slice(0, MAX_BODY);

    // 白名单硬校验：不在名单里且用户还没确认 → 只落草稿
    if (!inAllowlist(cfg, addr) && !confirmed) {
      const draft = createDraft({ to: addr, subject: subject, body: body },
        { status: AUDIT.DENIED, code: 'NEED_CONFIRMATION', actor: actor });
      return {
        ok: false, code: 'NEED_CONFIRMATION', draftId: draft.id,
        message: '这个收件人不在白名单里，已存为草稿：需要你确认后才会发出。',
      };
    }

    const limit = Number(e.dailyLimit) || 0;
    if (limit <= 0) {
      audit('send', addr, subject, AUDIT.DENIED, 'DAILY_LIMIT_EXCEEDED', actor);
      return { ok: false, code: 'DAILY_LIMIT_EXCEEDED', message: '每日发送上限为 0（默认保守值），请先在设置里调大。' };
    }
    // 上限检查与占位必须是同一段同步代码（中间不能有 await），否则并发请求会
    // 全部通过检查、一起把今日发信量顶到上限之外。
    const t1 = now();
    if (sentToday(t1) >= limit) {
      audit('send', addr, subject, AUDIT.DENIED, 'DAILY_LIMIT_EXCEEDED', actor);
      return { ok: false, code: 'DAILY_LIMIT_EXCEEDED', message: '今天的发送量已达上限（' + limit + ' 封）。' };
    }
    // 占位：这条 pending 审计从这一刻起就计入当日已发；发送结束再改成 ok / denied
    const ticket = audit('send', addr, subject, AUDIT.PENDING, '', actor);

    try {
      const provider = providerOf(cfg);
      const out = await provider.send(cfg, { to: addr, subject: subject, body: body });
      db.prepare('UPDATE email_audit SET status=? WHERE id=?').run(AUDIT.OK, ticket);
      return { ok: true, id: (out && out.id) || '', provider: (cfg.email && cfg.email.provider) || 'mock', to: addr };
    } catch (err) {
      const code = String((err && err.message) || err);
      const mapped = code.indexOf('MISSING_RESEND_API_KEY') >= 0 ? 'MISSING_RESEND_API_KEY' : 'PROVIDER_ERROR';
      // 发送失败：占位改成 denied（不计入当日已发），额度还回去
      db.prepare('UPDATE email_audit SET status=?, code=? WHERE id=?').run(AUDIT.DENIED, mapped, ticket);
      return { ok: false, code: mapped, message: '发送失败：' + code };
    }
  }

  // 用户确认草稿后发送
  async function sendDraft(id, opts) {
    const draft = getDraft(id);
    if (!draft) return { ok: false, code: 'DRAFT_NOT_FOUND', message: '找不到这封草稿。' };
    // 同步抢占：双击 / 两个并发确认里只有第一个能把 pending 抢成 sending，
    // 另一个 changes=0 → 直接按「已处理」返回，绝不会发第二封。
    const claim = db.prepare('UPDATE email_drafts SET status=? WHERE id=? AND status=?')
      .run(DRAFT.SENDING, draft.id, DRAFT.PENDING);
    if (claim.changes === 0) return { ok: false, code: 'DRAFT_ALREADY_SENT', message: '这封草稿已经处理过了。' };

    let res;
    try {
      res = await send({
        to: draft.to, subject: draft.subject, body: draft.body,
        actor: (opts && opts.actor) || 'user',
      }, { confirmed: true });   // 确认动作发生在这里（用户点了草稿确认），不是请求体字段
    } catch (err) {
      // 意外异常（DB 抛出等）：放回 pending，别让草稿永久卡在 sending
      db.prepare('UPDATE email_drafts SET status=? WHERE id=? AND status=?').run(DRAFT.PENDING, draft.id, DRAFT.SENDING);
      throw err;
    }
    if (res.ok) {
      db.prepare('UPDATE email_drafts SET status=? WHERE id=?').run(DRAFT.SENT, draft.id);
      audit('confirm', draft.to, draft.subject, AUDIT.OK, '', (opts && opts.actor) || 'user');
    } else {
      // 发送失败（上限 / 服务商）：退回 pending，用户可重试或丢弃
      db.prepare('UPDATE email_drafts SET status=? WHERE id=? AND status=?').run(DRAFT.PENDING, draft.id, DRAFT.SENDING);
    }
    return res;
  }

  function discardDraft(id) {
    const info = db.prepare('UPDATE email_drafts SET status=? WHERE id=? AND status=?')
      .run(DRAFT.DISCARDED, String(id || ''), DRAFT.PENDING);
    return info.changes > 0;
  }

  function listAudit(opts) {
    const limit = clampInt(opts && opts.limit, 50, 200);
    return db.prepare('SELECT * FROM email_audit ORDER BY at DESC LIMIT ?').all(limit)
      .map(r => ({
        id: r.id, at: Number(r.at), kind: r.kind, to: r.to_addr,
        subject: r.subject, status: r.status, code: r.code, actor: r.actor,
      }));
  }

  function stats() {
    const t0 = now();
    return {
      enabled: !!(getConfig().email || {}).enabled,
      provider: (getConfig().email || {}).provider || 'mock',
      sentToday: sentToday(t0),
      dailyLimit: Number((getConfig().email || {}).dailyLimit) || 0,
      pendingDrafts: db.prepare('SELECT COUNT(*) AS n FROM email_drafts WHERE status=?').get(DRAFT.PENDING).n,
    };
  }

  return {
    EMAIL_CODES,
    providers,
    send,
    sendDraft,
    createDraft,
    getDraft,
    listDrafts,
    discardDraft,
    listAudit,
    stats,
    normalizeAddress,
  };
}
