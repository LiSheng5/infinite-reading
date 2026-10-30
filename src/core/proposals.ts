/*
 * 无限阅读 · 提案（模型发起的有副作用动作，v0.6.0）
 *
 * 模型发起的邮件 / 下单**只能产生提案**，执行必须由用户在界面上点「确认」触发。
 * 本模块是纯逻辑层：不碰 DOM、不碰 story、不直接依赖 Sidecar（sidecar 以参数注入 S），
 * 时间以参数 now 注入（默认 Date.now()），方便 Node 里离线测试。
 *
 * 安全红线（这里是最核心的落点）：
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

  // ID 生成统一走 tree 的 genId；now 仍可注入（测试确定性）。
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

  /* ---------------- 状态机 ----------------
   * p.status 是唯一真源（0.13.0 起不再用 result.resolved 这类旁路标记）：
   *
   *   create ─▶ pending ─confirm(用户点确认)─▶ executing ─┬─ 成功 ────────────▶ done
   *             │                                          ├─ needsApproval ─▶ awaiting_confirm
   *             │                                          │                   └─approve(用户二次确认)─▶ executing ─▶ done
   *             │                                          └─ 失败 / 抛错 ─────▶ failed
   *             ├─deny(用户点拒绝)─▶ denied
   *             └─expiresAt 到─────▶ expired
   *   awaiting_confirm ─deny─▶ denied；─expiresAt 到─▶ expired；─confirm─▶ 原样交还 needsSecondConfirm（可重入）
   *   executing（落盘后再读到）─▶ failed：上次执行随页面关闭中断，结果未知，不自动重试
   *
   * 收口约定：
   *   - 只有 pending / awaiting_confirm 是「用户还能操作」的状态，两者共用同一个 expiresAt（30 分钟），
   *     过期即 expired —— 不存在「点不动、也不过期」的卡死态；
   *   - executing 只在「同步抢占 → await 回来」之间出现，由进程内 inFlight 记住；读档后它不在集合里，
   *     说明是上次进程留下的，reconcile 收敛为 failed；
   *   - 发信失败要留住 draftId 并尽力清掉残留草稿（sidecar 会把失败草稿退回 pending，留着就是草稿箱里
   *     一封「点一下就发」的信，绕开提案卡）；failed 状态下 deny 仍可重试清理；
   *   - 界面层不许自己改 status：迁移只走 confirm / approveSecond / deny / fail / reconcile。
   */

  const STATUS = {
    PENDING: 'pending',            // 等用户首次确认
    AWAITING: 'awaiting_confirm',  // 已建 intent，等用户二次确认（额度授权）
    EXECUTING: 'executing',        // 已同步抢占，请求在途（进程内瞬时态）
    DONE: 'done',
    DENIED: 'denied',
    EXPIRED: 'expired',
    FAILED: 'failed',
  };
  // 在途提案（按对象引用记）：只活在当前进程，落盘不会带上；读档后为空 = 上次执行已中断
  const inFlight = new Set();

  function timeOf(now) {
    return Number.isFinite(Number(now)) ? Number(now) : Date.now();
  }

  /* 旧档迁移（0.13.0 之前）：二次确认等待态曾写成 executing + result.needsSecondConfirm。
   *   resolved=false → awaiting_confirm（用户还没点）；
   *   resolved=true  → failed（点过了、请求在途中进程没了：结果未知，既不能算成功也不能算待确认）。 */
  function normalize(p) {
    if (!p || !p.result || typeof p.result !== 'object') return p;
    const r = p.result;
    if (p.status === STATUS.EXECUTING && r.needsSecondConfirm) {
      if (r.resolved) {
        r.ok = false;
        r.error = r.error || '二次确认在请求途中被中断，结果未知：请到本地服务核对';
        p.status = STATUS.FAILED;
      } else {
        p.status = STATUS.AWAITING;
      }
      delete r.needsSecondConfirm;
      delete r.resolved;
    }
    return p;
  }

  // 二次确认等待态：已建 intent、等用户点「继续确认」。受同一份 TTL 约束，
  // 过期走 expired，不会像旧实现那样永远停在 executing。
  function isWaitingSecond(p) {
    return !!(p && normalize(p).status === STATUS.AWAITING);
  }

  /* 状态收敛（读档 / 渲染 / 每次操作前调用，幂等）：
   *   1) 旧档迁移；
   *   2) 不在 inFlight 里的 executing = 上次进程中断 → failed（保留 draftId / intentId 供清理）；
   *   3) pending / awaiting_confirm 过 TTL → expired。
   * 返回收敛后的状态。 */
  function reconcile(p, now) {
    if (!p) return '';
    normalize(p);
    if (p.status === STATUS.EXECUTING && !inFlight.has(p)) {
      const r = (p.result && typeof p.result === 'object') ? p.result : {};
      r.ok = false;
      r.error = '执行中断：页面在请求途中被关闭，未确认是否已生效；请到本地服务核对';
      p.result = r;
      p.status = STATUS.FAILED;
    }
    if ((p.status === STATUS.PENDING || p.status === STATUS.AWAITING) && timeOf(now) >= p.expiresAt) {
      p.status = STATUS.EXPIRED;
    }
    return p.status;
  }

  // 「用户还能对它做点什么」：pending（首次确认）或 awaiting_confirm（补完二次确认）。
  function isActionable(p, now) {
    if (!p) return false;
    const st = reconcile(p, now);
    return (st === STATUS.PENDING || st === STATUS.AWAITING) && timeOf(now) < p.expiresAt;
  }

  // 同步抢占状态：必须在任何 await 之前把 pending 变掉，保证并发再点不会二次执行
  function claim(p) {
    if (!p || p.status !== STATUS.PENDING) return false;
    p.status = STATUS.EXECUTING;
    inFlight.add(p);
    return true;
  }

  // 二次确认的同步抢占（awaiting_confirm → executing）：并发两次「确认支付」只会有一次 approve
  function claimSecond(p) {
    if (!p || p.status !== STATUS.AWAITING) return false;
    p.status = STATUS.EXECUTING;
    inFlight.add(p);
    return true;
  }

  function settled(p, status) {
    return { status: status, result: (p && p.result) || null };
  }

  // 落到等待态 / 终态：摘掉在途标记再记状态（状态迁移只走这里，别手改 p.status）
  function release(p, status) {
    if (p) { inFlight.delete(p); p.status = status; }
    return settled(p, status);
  }

  // 二次确认请求（不碰 sidecar）：confirm 在 awaiting_confirm 上可重入，原样交还这份描述
  function secondRequest(p) {
    const r = (p && p.result) || {};
    return {
      status: STATUS.AWAITING, needsSecondConfirm: true,
      intentId: r.intentId, summary: r.summary || null,
    };
  }

  /* 丢弃残留草稿。emailSendDraft 失败时 sidecar 会把草稿退回 pending，
   * 留着它就是草稿箱里一封「点一下就发」的信（绕开提案卡）。尽力清掉；清不掉就把
   * result.draftDiscarded 记成 false，界面据此给「清理草稿」重试。 */
  async function discardQuietly(p, S) {
    const r = p && p.result;
    if (!r || !r.draftId) return false;
    if (!S || typeof S.emailDiscardDraft !== 'function') { r.draftDiscarded = false; return false; }
    try {
      const out = await S.emailDiscardDraft(r.draftId);
      // sidecar 只在草稿仍是 pending 时改状态：discarded=false 说明它已经不在了（已发 / 已丢），同样算清干净
      r.draftDiscarded = !(out && out.ok === false);
      return r.draftDiscarded;
    } catch (_) {
      // 清不掉不改变提案结论：draftDiscarded = false，界面给「清理草稿」重试
      r.draftDiscarded = false;
      return false;
    }
  }

  // 清理 sidecar 侧的残留物（草稿 / intent）：拒绝、失败后重试清理都走这里。
  // 清理失败不改变提案本身的状态结论。
  async function cleanupLeftovers(p, S) {
    if (!p) return false;
    try {
      if (p.kind === 'email') return await discardQuietly(p, S);
      if (p.kind === 'payment') {
        const intentId = p.result && p.result.intentId;
        if (intentId && S && typeof S.paymentDeny === 'function') {
          await S.paymentDeny(intentId);   // 已不是待确认的单子会返回 INTENT_ALREADY_RESOLVED，无副作用
          return true;
        }
      }
    } catch (_) { /* 清理失败不改变「已拒绝 / 已失败」结论 */ }
    return false;
  }

  /**
   * 用户点击「确认」后的执行入口（幂等）。
   * email：S.emailDraft → S.emailSendDraft（绝不调用 S.emailSend）。
   * payment：S.paymentPurchase；返回 needsApproval 时不自动批准，状态转 awaiting_confirm，
   *          把 { needsSecondConfirm, intentId, summary } 交还调用方（应用层再弹带额度的确认）。
   * 对 awaiting_confirm 可重入：再点一次只是把二次确认请求原样交还，不重复下单。
   */
  async function confirm(p, S, now) {
    if (!p) return { status: 'missing' };
    const t = timeOf(now);
    const st = reconcile(p, t);
    if (st === STATUS.AWAITING) return secondRequest(p);   // 可重入：重新弹二次确认，绝不自动批准（红线 3）
    if (st !== STATUS.PENDING) return settled(p, st);      // 幂等：终态 / 在途都不执行任何 sidecar 调用
    if (!claim(p)) return settled(p, p.status);            // 别处刚抢走：不执行

    if (p.kind === 'email') {
      let draftId = '';
      try {
        if (!S || typeof S.emailDraft !== 'function' || typeof S.emailSendDraft !== 'function') {
          throw new Error('本地服务不支持邮件草稿接口');
        }
        const draft = await S.emailDraft({ to: p.args.to, subject: p.args.subject, body: p.args.body });
        draftId = (draft && draft.id) || '';
        if (!draftId) throw new Error('草稿创建失败（本地服务没返回草稿号）');
        const r = await S.emailSendDraft(draftId);
        if (r && r.ok === false) throw new Error(r.message || r.code || '发送失败');
        p.result = { ok: true, draftId: draftId, to: p.args.to, subject: p.args.subject };
        return release(p, STATUS.DONE);
      } catch (e) {
        // 失败也留住 draftId（草稿还在 sidecar 里，结果要能指认它），并尽力清掉
        p.result = { ok: false, error: String((e && e.message) || e), draftId: draftId, draftDiscarded: false };
        if (draftId) await discardQuietly(p, S);
        return release(p, STATUS.FAILED);
      }
    }

    try {
      if (!S || typeof S.paymentPurchase !== 'function') throw new Error('本地服务不支持代下单');
      // agent / 币种不自报：服务端按 mandate / 配置映射；
      // mandateId 由应用层（features.js）注入到 paymentPurchase 包装里
      const r = await S.paymentPurchase({
        amountCents: p.args.amountCents,
        merchant: p.args.merchant,
        category: p.args.category,
        items: p.args.items,
      });
      if (!r || r.ok === false) throw new Error((r && (r.message || r.code)) || '下单失败');
      if (r.needsApproval) {
        // 不自动批准：转 awaiting_confirm，把 intent 交还调用方，等用户第二次点击
        p.result = {
          intentId: r.intentId, summary: r.summary || null,
          amountCents: p.args.amountCents,
        };
        return Object.assign(release(p, STATUS.AWAITING), secondRequest(p));
      }
      p.result = {
        ok: true,
        intentId: r.intentId,
        status: r.status || 'charged',
        payHint: (r.order && r.order.payHint) || '',
        amountCents: p.args.amountCents,
      };
      return release(p, STATUS.DONE);
    } catch (e) {
      p.result = { ok: false, error: String((e && e.message) || e) };
      return release(p, STATUS.FAILED);
    }
  }

  /**
   * 二次确认通过（sidecar 返回 needsApproval 后，用户在带额度余量的弹窗里点了确认）。
   * 只有这时候才允许调用 paymentApprove；同步抢占 status，防并发重复批准。
   * 过期 / 已拒绝 / 终态的提案一律不执行（迟到的一次点击也不补扣）。
   */
  async function approveSecond(p, S, now) {
    if (!p) return { status: 'missing' };
    const st = reconcile(p, timeOf(now));
    if (st !== STATUS.AWAITING) return settled(p, st);
    if (!claimSecond(p)) return settled(p, p.status);
    try {
      const r = await S.paymentApprove(p.result.intentId);
      if (!r || r.ok === false) throw new Error((r && (r.message || r.code)) || '确认失败');
      p.result = Object.assign({}, p.result, {
        ok: true, status: r.status || 'charged',
        payHint: (r.order && r.order.payHint) || p.result.payHint || '',
      });
      return release(p, STATUS.DONE);
    } catch (e) {
      p.result = Object.assign({}, p.result, { ok: false, error: String((e && e.message) || e) });
      return release(p, STATUS.FAILED);
    }
  }

  /* 应用层在进状态机之前就决定不执行（例如没有长期授权）：也走这个出口，别在界面层手改 status。
   * 名字带 mark 前缀，避免和校验用的 fail(msg) 撞名；已发生的 draftId / intentId 原样留着。 */
  function markFailed(p, error) {
    if (!p) return { status: 'missing' };
    const keep = (p.result && typeof p.result === 'object') ? p.result : {};
    keep.ok = false;
    keep.error = String(error || '未执行');
    p.result = keep;
    return release(p, STATUS.FAILED);
  }

  /**
   * 拒绝 / 清理。
   *   pending / awaiting_confirm → denied，并清掉 sidecar 里的草稿 / intent；
   *   failed 且还留着草稿 → 只清草稿（状态保持 failed，失败原因仍可见）；
   *   其余状态（终态 / 在途）不重复动作，防二次伤害。
   */
  async function deny(p, S, now) {
    if (!p) return { status: 'missing' };
    const st = reconcile(p, timeOf(now));
    if (st === STATUS.PENDING || st === STATUS.AWAITING) {
      p.status = STATUS.DENIED;
      inFlight.delete(p);
      await cleanupLeftovers(p, S);
      return settled(p, STATUS.DENIED);
    }
    if (st === STATUS.FAILED && p.result && p.result.draftId && p.result.draftDiscarded === false) {
      const cleaned = await cleanupLeftovers(p, S);
      return { status: STATUS.FAILED, result: p.result, cleaned: cleaned };
    }
    return settled(p, st);
  }

  const Proposals = {
    DEFAULT_TTL_MS, MAX_AMOUNT_CENTS,
    MAX_SUBJECT, MAX_BODY, MAX_MERCHANT, MAX_CATEGORY, MAX_ITEMS, MAX_ITEM_NAME,
    STATUS,
    yuanToCents,
    create, isActionable, isWaitingSecond, reconcile, confirm, approveSecond, deny, markFailed,
  };
  export { Proposals };