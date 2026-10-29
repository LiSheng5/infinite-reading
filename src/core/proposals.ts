/*
 * 无限阅读 · 提案（模型发起的有副作用动作，v0.6.0）
 *
 * 模型发起的邮件 / 下单**只能产生提案**，执行必须由用户在界面上点「确认」触发。
 * 本模块是纯逻辑层：不碰 DOM、不碰 story、不直接依赖 Sidecar（sidecar 以参数注入 S），
 * 时间以参数 now 注入（默认 Date.now()），方便 Node 里离线测试。
 *
 * 安全红线（任务书 §2，这里是最核心的落点）：
 *   - 提案路径禁止调用 S.emailSend（直发）——只用 emailDraft → emailSendDraft；
 *   - 提案路径禁止在没有用户点击时调用 paymentApprove / paymentCharge / paymentMarkPaid；
 *   - paymentPurchase 在额度内可能直接放行扣款（返回 charged），所以
 *     **confirm（用户点击）之前绝不能调用 paymentPurchase**；
 *   - 确认是幂等的：confirm 同步抢占状态为 executing 再 await，并发再点不会二次执行。
 *
 * 纯函数、零外部依赖（ID 生成共用 src/core/tree.ts 的 genId）；UMD 兜底，浏览器挂 应用层注册表，Node 亦可加载。
 */

/* ↑ 阶段 2 搬迁自 src/core/proposals.ts（IIFE → ES module，函数体逐字未动）。
 * 模块间现存的 global.IR 惰性互访按铁律保留（可选依赖语义，见 src/core/ir.ts 头注）；
 * 导出即真实 API。 */
import { genId as rootGenId } from './tree.ts';

  const DEFAULT_TTL_MS = 30 * 60 * 1000;   // 提案有效期（默认 30 分钟，常量可调）
  const MAX_AMOUNT_CENTS = 200000;        // 客户端金额兜底上限（2000 元）；真额度由 sidecar mandate 管
  const MAX_SUBJECT = 200;
  const MAX_BODY = 20000;
  const MAX_MERCHANT = 80;
  const MAX_CATEGORY = 40;
  const MAX_ITEMS = 5;
  const MAX_ITEM_NAME = 80;
  const MAX_REASON = 200;
  const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

  // ID 生成统一走 tree 的 genId（审查 可维护性 #5）；now 仍可注入（测试确定性）。
  function genId(now) {
    return rootGenId('pp-', now);
  }

  function fail(msg) { return { ok: false, error: String(msg || '提案无效') }; }
  function hasBreak(s) { return /[\r\n]/.test(String(s == null ? '' : s)); }
  function str(v) { return String(v == null ? '' : v); }
  function reasonOf(v) {
    const s = str(v).trim();
    return s ? s.slice(0, MAX_REASON) : '';
  }

  // 金额（元，number）→ 分（整数）：Math.round(x * 100)，浮点误差由 round 吃掉（0.1+0.2 → 30 分）
  function yuanToCents(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return NaN;
    return Math.round(n * 100);
  }

  /* ---------------- 校验 + 规范化（create） ---------------- */

  function createEmail(args, now) {
    const a = args || {};
    const to = str(a.to).trim();
    const subject = str(a.subject).trim();
    const body = str(a.body);
    if (!to) return fail('缺少收件人（to）');
    if (!EMAIL_RE.test(to)) return fail('收件人地址不合法：' + to);
    if (!subject) return fail('缺少主题（subject）');
    if (!body.trim()) return fail('缺少正文（body）');
    if (hasBreak(to)) return fail('收件人不能包含换行');
    if (hasBreak(subject)) return fail('主题不能包含换行');
    if (subject.length > MAX_SUBJECT) return fail('主题过长（最多 ' + MAX_SUBJECT + ' 字）');
    if (body.length > MAX_BODY) return fail('正文过长（最多 ' + MAX_BODY + ' 字）');
    const proposal = {
      id: genId(now),
      kind: 'email',
      args: {
        to: to,
        subject: subject.slice(0, MAX_SUBJECT),
        body: body.slice(0, MAX_BODY),
        reason: reasonOf(a.reason),
      },
      status: 'pending',
      createdAt: Number(now) || Date.now(),
      expiresAt: (Number(now) || Date.now()) + DEFAULT_TTL_MS,
      result: null,
    };
    return { ok: true, proposal: proposal };
  }

  function createPayment(args, now) {
    const a = args || {};
    if (a.amount === undefined || a.amount === null || str(a.amount).trim() === '') return fail('缺少金额（amount，单位元）');
    const amountCents = yuanToCents(a.amount);
    if (!Number.isFinite(amountCents) || amountCents <= 0) return fail('金额必须大于 0（单位：元）');
    if (amountCents > MAX_AMOUNT_CENTS) return fail('金额超过客户端上限（' + (MAX_AMOUNT_CENTS / 100) + ' 元）');
    const merchant = str(a.merchant).trim();
    const category = str(a.category).trim();
    if (merchant.length > MAX_MERCHANT) return fail('商户名过长（最多 ' + MAX_MERCHANT + ' 字）');
    if (category.length > MAX_CATEGORY) return fail('品类过长（最多 ' + MAX_CATEGORY + ' 字）');
    let items = Array.isArray(a.items) ? a.items : (a.items ? [a.items] : []);
    if (items.length > MAX_ITEMS) return fail('商品最多 ' + MAX_ITEMS + ' 项');
    const norm = [];
    for (const it of items) {
      const name = str(it && typeof it === 'object' ? it.name : it).trim();
      if (!name) continue;
      if (name.length > MAX_ITEM_NAME) return fail('商品名称过长（最多 ' + MAX_ITEM_NAME + ' 字）');
      norm.push({ name: name.slice(0, MAX_ITEM_NAME) });
    }
    const proposal = {
      id: genId(now),
      kind: 'payment',
      args: {
        amount: amountCents / 100,        // 元（展示用）
        amountCents: amountCents,         // 分（执行用）
        merchant: merchant.slice(0, MAX_MERCHANT),
        category: category.slice(0, MAX_CATEGORY),
        items: norm,
        reason: reasonOf(a.reason),
      },
      status: 'pending',
      createdAt: Number(now) || Date.now(),
      expiresAt: (Number(now) || Date.now()) + DEFAULT_TTL_MS,
      result: null,
    };
    return { ok: true, proposal: proposal };
  }

  function create(kind, args, now) {
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (kind === 'email') return createEmail(args, t);
    if (kind === 'payment') return createPayment(args, t);
    return fail('未知的提案类型：' + kind);
  }

  /* ---------------- 状态机 ---------------- */

  function isActionable(p, now) {
    if (!p || p.status !== 'pending') return false;
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return t < p.expiresAt;
  }

  function markExpired(p) {
    if (p && p.status === 'pending') p.status = 'expired';
  }

  // 同步抢占状态：必须在任何 await 之前把 pending 变掉，保证并发再点不会二次执行
  function claim(p) {
    if (!p || p.status !== 'pending') return false;
    p.status = 'executing';
    return true;
  }

  function settled(p, status) {
    return { status: status, result: (p && p.result) || null };
  }

  /**
   * 用户点击「确认」后的执行入口（幂等）。
   * email：S.emailDraft → S.emailSendDraft（绝不调用 S.emailSend）。
   * payment：S.paymentPurchase；返回 needsApproval 时不自动批准，
   *          把 { needsSecondConfirm, intentId, summary } 交还调用方（应用层再弹带额度的确认）。
   */
  async function confirm(p, S, now) {
    if (!p) return { status: 'missing' };
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (p.status !== 'pending') return settled(p, p.status);   // 幂等：非 pending 不执行任何 sidecar 调用
    if (t >= p.expiresAt) { markExpired(p); return settled(p, 'expired'); }
    if (!claim(p)) return settled(p, p.status);                // 别处刚抢走：不执行
    try {
      if (p.kind === 'email') {
        if (!S || typeof S.emailDraft !== 'function' || typeof S.emailSendDraft !== 'function') {
          throw new Error('本地服务不支持邮件草稿接口');
        }
        const draft = await S.emailDraft({ to: p.args.to, subject: p.args.subject, body: p.args.body });
        const draftId = draft && draft.id;
        if (!draftId) throw new Error('草稿创建失败（本地服务没返回草稿号）');
        const r = await S.emailSendDraft(draftId);
        if (r && r.ok === false) throw new Error(r.message || r.code || '发送失败');
        p.result = { ok: true, draftId: draftId, to: p.args.to, subject: p.args.subject };
        p.status = 'done';
        return settled(p, 'done');
      }
      // payment
      if (!S || typeof S.paymentPurchase !== 'function') throw new Error('本地服务不支持代下单');
      // agent / 币种不自报（审查 中危 #13）：服务端按 mandate / 配置映射；
      // mandateId 由应用层（features.js）注入到 paymentPurchase 包装里
      const r = await S.paymentPurchase({
        amountCents: p.args.amountCents,
        merchant: p.args.merchant,
        category: p.args.category,
        items: p.args.items,
      });
      if (!r || r.ok === false) throw new Error((r && (r.message || r.code)) || '下单失败');
      if (r.needsApproval) {
        // 不自动批准：把 intent 交还调用方，等用户第二次点击
        p.result = {
          needsSecondConfirm: true, resolved: false,
          intentId: r.intentId, summary: r.summary || null,
          amountCents: p.args.amountCents,
        };
        return { status: 'executing', needsSecondConfirm: true, intentId: r.intentId, summary: r.summary || null };
      }
      p.result = {
        ok: true,
        intentId: r.intentId,
        status: r.status || 'charged',
        payHint: (r.order && r.order.payHint) || '',
        amountCents: p.args.amountCents,
      };
      p.status = 'done';
      return settled(p, 'done');
    } catch (e) {
      p.status = 'failed';
      p.result = { ok: false, error: String((e && e.message) || e) };
      return settled(p, 'failed');
    }
  }

  /**
   * 二次确认通过（sidecar 返回 needsApproval 后，用户在带额度余量的弹窗里点了确认）。
   * 只有这时候才允许调用 paymentApprove；同步抢占 resolved，防并发重复批准。
   */
  async function approveSecond(p, S) {
    if (!p || p.status !== 'executing' || !p.result || !p.result.needsSecondConfirm || p.result.resolved) {
      return settled(p, p ? p.status : 'missing');
    }
    p.result.resolved = true;
    try {
      const r = await S.paymentApprove(p.result.intentId);
      if (!r || r.ok === false) throw new Error((r && (r.message || r.code)) || '确认失败');
      p.result.ok = true;
      p.result.status = r.status || 'charged';
      p.result.payHint = (r.order && r.order.payHint) || p.result.payHint || '';
      p.status = 'done';
      return settled(p, 'done');
    } catch (e) {
      p.status = 'failed';
      p.result.error = String((e && e.message) || e);
      return settled(p, 'failed');
    }
  }

  /**
   * 拒绝（或二次确认里点了拒绝）。
   * email：丢弃草稿（如有）；payment：若已有 intent 则 paymentDeny。
   */
  async function deny(p, S) {
    if (!p) return { status: 'missing' };
    const secondPending = p.status === 'executing' && p.result && p.result.needsSecondConfirm && !p.result.resolved;
    if (p.status !== 'pending' && !secondPending) return settled(p, p.status);
    p.status = 'denied';
    if (p.result) p.result.resolved = true;
    try {
      if (p.kind === 'email') {
        const draftId = p.result && p.result.draftId;
        if (draftId && S && typeof S.emailDiscardDraft === 'function') await S.emailDiscardDraft(draftId);
      } else if (p.kind === 'payment') {
        const intentId = p.result && p.result.intentId;
        if (intentId && S && typeof S.paymentDeny === 'function') await S.paymentDeny(intentId);
      }
    } catch (_) { /* 清理失败不改变「已拒绝」结论 */ }
    return settled(p, 'denied');
  }

  const Proposals = {
    DEFAULT_TTL_MS, MAX_AMOUNT_CENTS,
    MAX_SUBJECT, MAX_BODY, MAX_MERCHANT, MAX_CATEGORY, MAX_ITEMS, MAX_ITEM_NAME,
    yuanToCents,
    create, isActionable, markExpired, confirm, approveSecond, deny,
  };
  export { Proposals };