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
import { genId, dayRange } from './util.mjs';
import { AUDIT, DRAFT } from './statuses.mjs';

export const EMAIL_CODES = [
  'EMAIL_DISABLED',
  'BAD_RECIPIENT',
  'NEED_CONFIRMATION',
  'DAILY_LIMIT_EXCEEDED',
  'PROVIDER_ERROR',
  'MISSING_RESEND_API_KEY',
  'INBOX_NOT_SUPPORTED',
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
      async list() { return { ok: true, messages: [] }; },
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
      // Resend 只负责发信，没有收件箱接口
      async list() { return { ok: false, code: 'INBOX_NOT_SUPPORTED' }; },
    },
  };
}

/* ---------------- 邮件服务 ---------------- */

export function createEmail(deps) {
  const db = deps.db;
  const getConfig = deps.getConfig;
  const now = deps.now || (() => Date.now());
  const providers = deps.providers || createProviders();

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

  // 当日成功发送数（本地日聚合审计表）
  function sentToday(t0) {
    const [d0, d1] = dayRange(t0);
    const r = db.prepare(
      'SELECT COUNT(*) AS n FROM email_audit WHERE kind=? AND status=? AND at >= ? AND at < ?'
    ).get('send', AUDIT.OK, d0, d1);
    return (r && r.n) || 0;
  }

  function inAllowlist(cfg, addr) {
    const list = (cfg.email && cfg.email.allowlist) || [];
    const a = addr.toLowerCase();
    return list.some(x => String(x).trim().toLowerCase() === a);
  }

  function createDraft(input) {
    const addr = normalizeAddress(input && input.to);
    const id = genId('d');
    db.prepare('INSERT INTO email_drafts (id, at, to_addr, subject, body, status) VALUES (?,?,?,?,?,?)')
      .run(id, now(), addr, String((input && input.subject) || '').slice(0, MAX_SUBJECT), String((input && input.body) || '').slice(0, MAX_BODY), DRAFT.PENDING);
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
      const draft = createDraft({ to: addr, subject: subject, body: body });
      audit('draft', addr, subject, AUDIT.DENIED, 'NEED_CONFIRMATION', actor);
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
    if (sentToday(now()) >= limit) {
      audit('send', addr, subject, AUDIT.DENIED, 'DAILY_LIMIT_EXCEEDED', actor);
      return { ok: false, code: 'DAILY_LIMIT_EXCEEDED', message: '今天的发送量已达上限（' + limit + ' 封）。' };
    }

    try {
      const provider = providerOf(cfg);
      const out = await provider.send(cfg, { to: addr, subject: subject, body: body });
      audit('send', addr, subject, AUDIT.OK, '', actor);
      return { ok: true, id: (out && out.id) || '', provider: (cfg.email && cfg.email.provider) || 'mock', to: addr };
    } catch (err) {
      const code = String((err && err.message) || err);
      const mapped = code.indexOf('MISSING_RESEND_API_KEY') >= 0 ? 'MISSING_RESEND_API_KEY' : 'PROVIDER_ERROR';
      audit('send', addr, subject, AUDIT.DENIED, mapped, actor);
      return { ok: false, code: mapped, message: '发送失败：' + code };
    }
  }

  // 用户确认草稿后发送
  async function sendDraft(id, opts) {
    const draft = getDraft(id);
    if (!draft) return { ok: false, code: 'DRAFT_NOT_FOUND', message: '找不到这封草稿。' };
    if (draft.status !== DRAFT.PENDING) return { ok: false, code: 'DRAFT_ALREADY_SENT', message: '这封草稿已经处理过了。' };
    const res = await send({
      to: draft.to, subject: draft.subject, body: draft.body,
      actor: (opts && opts.actor) || 'user',
    }, { confirmed: true });   // 确认动作发生在这里（用户点了草稿确认），不是请求体字段
    if (res.ok) {
      db.prepare('UPDATE email_drafts SET status=? WHERE id=?').run(DRAFT.SENT, draft.id);
      audit('confirm', draft.to, draft.subject, AUDIT.OK, '', (opts && opts.actor) || 'user');
    }
    return res;
  }

  function discardDraft(id) {
    const info = db.prepare('UPDATE email_drafts SET status=? WHERE id=? AND status=?')
      .run(DRAFT.DISCARDED, String(id || ''), DRAFT.PENDING);
    return info.changes > 0;
  }

  // limit 归一（审查 低危 #19）：Number('abc') 是 NaN，直接进 SQL LIMIT 会触发绑定异常——
  // 非有限数 / 非正数一律回退默认值，再夹到上限内。
  function clampLimit(v, dflt, max) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
  }

  async function inbox(opts) {
    const cfg = getConfig();
    if (!(cfg.email && cfg.email.enabled)) return { ok: false, code: 'EMAIL_DISABLED', message: '邮件功能未开启。' };
    const limit = clampLimit(opts && opts.limit, 20, 50);
    try {
      const out = await providerOf(cfg).list(cfg, { folder: (opts && opts.folder) || 'inbox', limit: limit });
      if (out && out.ok === false) return out;
      return { ok: true, messages: (out && out.messages) || [] };
    } catch (err) {
      return { ok: false, code: 'PROVIDER_ERROR', message: String((err && err.message) || err) };
    }
  }

  function listAudit(opts) {
    const limit = clampLimit(opts && opts.limit, 50, 200);
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
    inbox,
    listAudit,
    stats,
    normalizeAddress,
  };
}
