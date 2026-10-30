/*
 * src/app/features.js —— 调度工具 / 安全项读写 / 主动联系安排 / 邮件 / 购物支付 / 提案卡
 * 从 src/app/main.js 拆出（只搬家，不改行为）。
 */
import { Sidecar } from '../core/sidecar.ts';
import { Proposals } from '../core/proposals.ts';
import { A, renderChat, saveAll, toast } from './core.js';

  const S = A.state;
  const { $, irConfirm, openModal, fmtTime, errorText, reportBackgroundFailure } = A;

  // 回合锚点：request_image 在 commit 之前提交、节点还没创建——任务提交时带上它；
  // 回合 commit 成功后补 nodeId，失败 / 主动停止置 dead；任务开跑前与写回前各核一次。

  /* ================= 可选本地服务（sidecar）：调度工具与主动消息 ================= */

  // 调度工具只在「对话 / 扮演」+ 本地服务在线 + 后端已开启调度时才下发
  function scheduleToolsAvailable() {
    const SC = Sidecar;
    if (!SC || typeof SC.isOnline !== 'function' || !SC.isOnline()) return false;
    const st = SC.status();
    return !!(st.features && st.features.schedule && st.hasToken);
  }

  // 邮件 / 下单工具同样只在「本地服务在线 + 对应 feature 开启 + 有 token」时下发；
  // 另外 toolsForMode 只在 chat（智能体）模式放行（红线 7）。
  function proposalToolsAvailable() {
    const SC = Sidecar;
    if (!SC || typeof SC.isOnline !== 'function' || !SC.isOnline()) return { email: false, payment: false };
    const st = SC.status();
    const ready = !!st.hasToken;
    return {
      email: !!(ready && st.features && st.features.email),
      payment: !!(ready && st.features && st.features.payment),
    };
  }

  // 接受 ISO 8601 字符串或时间戳（秒 / 毫秒）；解析不出来返回 0
  function parseWhen(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
    const s = String(v == null ? '' : v).trim();
    if (!s) return 0;
    if (/^\d{9,}$/.test(s)) {
      const n = parseInt(s, 10);
      return n < 1e11 ? n * 1000 : n;          // 10 位当秒处理
    }
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
  }

  function describeTrigger(t) {
    const spec = (t && t.spec) || {};
    if (t.type === 'once') return '一次 · ' + fmtTime(spec.at);
    if (t.type === 'interval') return '每 ' + Math.round((spec.everyMs || 0) / 60000) + ' 分钟';
    if (t.type === 'cron') return spec.expr + ' @ ' + (spec.tz || 'UTC');
    return t.type;
  }

  // 措辞按侧车真实状态走：重报同内容会保留 active，别让模型以为「还在等确认」而反复重报
  const submitted = (t, detail) => (t && t.status === 'pending_confirm')
    ? '[已提交，待用户确认] ' + detail + '；用户确认前不会触发。'
    : '[已存在，内容未变] ' + detail + '；这个安排已经在生效，无需再次确认。';

  // 执行调度工具：一律提交给侧车、由用户确认——模型可以安排，但不能让主动行为自己生效
  async function runScheduleTool(name, args) {
    const SC = Sidecar;
    const a = args || {};
    if (!SC || !SC.isOnline()) {
      return '[调度失败] 本地服务没有在运行。请告诉用户：先在「设置 → 本地服务」里启动它，否则没法定时主动联系。';
    }
    try {
      if (name === 'schedule_once') {
        const at = parseWhen(a.at);
        if (!at) return '[调度失败] at 需要 ISO 8601 时间，例如 2026-10-11T09:00:00+08:00。';
        const t = await SC.upsertTrigger({
          name: a.name, type: 'once', spec: { at: at },
          prompt: a.prompt, reason: a.reason, channel: S.story ? S.story.id : '', source: 'model',
        });
        return submitted(t, '一次性安排「' + t.name + '」定在 ' + fmtTime(at));
      }
      if (name === 'schedule_heartbeat') {
        const mins = Math.max(1, Math.floor(Number(a.everyMinutes) || 0));
        const t = await SC.upsertTrigger({
          name: a.name, type: 'interval', spec: { everyMs: mins * 60000 },
          prompt: a.prompt, reason: a.reason, channel: S.story ? S.story.id : '', source: 'model',
        });
        return submitted(t, '每隔 ' + mins + ' 分钟的安排「' + t.name + '」');
      }
      if (name === 'schedule_cron') {
        const t = await SC.upsertTrigger({
          name: a.name, type: 'cron', spec: { expr: a.expr, tz: a.tz || '' },
          prompt: a.prompt, reason: a.reason, channel: S.story ? S.story.id : '', source: 'model',
        });
        return submitted(t, '日历安排「' + t.name + '」：' + a.expr + '（' + (a.tz || 'UTC') + '）');
      }
      if (name === 'list_triggers') {
        const list = await SC.listTriggers();
        if (!list.length) return '[现有安排] 目前没有任何主动联系安排。';
        return '[现有安排]\n' + list.map(t =>
          '- ' + t.name + '（' + t.status + ' · ' + describeTrigger(t) + '）原因：' + (t.reason || '未写')
          + (t.channel ? '［仅当前会话］' : '')).join('\n');
      }
      if (name === 'cancel_trigger') {
        const want = String(a.name || '').trim();
        const list = await SC.listTriggers();
        const hit = list.filter(t => t.name === want)[0];
        if (!hit) return '[取消失败] 没有叫「' + want + '」的安排（可以先 list_triggers 看看）。';
        await SC.cancelTrigger(hit.id);
        if (typeof renderTriggerList === 'function') { try { renderTriggerList(); } catch (_) {} }
        return '[已取消] 安排「' + hit.name + '」已删除。';
      }
      return '[调度失败] 未知的调度动作：' + name;
    } catch (e) {
      // 已确认的安排不能被模型改写：给出可执行的下一步，别让它反复重试同名
      if (e && e.code === 'TRIGGER_LOCKED') return '[调度失败] 同名安排「' + String(a.name || '') + '」已被用户确认生效，模型不能改写它。要改：换个名字重新提交（用户确认后再用），或请用户在「设置 → 本地服务」里取消旧的。';
      return '[调度失败] ' + ((e && e.message) || e);
    }
  }

  /* ---- 设置分区：安全项读写（真源在侧车 config.json，这里只是编辑界面） ---- */

  async function loadFeatureConfig() {
    if (!A.sidecarReady()) { A.renderSidecarStatus(); return; }
    try {
      const r = await Sidecar.getConfig();
      const c = (r && r.config) || {};
      const set = (sel, v) => { const el = $(sel); if (el) el.value = (v === undefined || v === null) ? '' : v; };
      const chk = (sel, v) => { const el = $(sel); if (el) el.checked = !!v; };

      chk('#s-email-enabled', c.email.enabled);
      set('#s-email-provider', c.email.provider);
      set('#s-email-dailylimit', c.email.dailyLimit);
      set('#s-email-from', c.email.from);
      set('#s-email-allowlist', (c.email.allowlist || []).join('\n'));
      const keyEl = $('#s-email-resendkey');
      if (keyEl) { keyEl.value = ''; keyEl.placeholder = c.email.hasResendApiKey ? '已保存（留空表示不改动）' : '未设置'; }

      chk('#s-sched-enabled', c.schedule.enabled);
      chk('#s-sched-paused', c.schedule.paused);
      set('#s-sched-dailycap', c.schedule.dailyCap);
      set('#s-sched-missed', c.schedule.missedPolicy);
      set('#s-sched-quiet', (c.schedule.quietHours || []).map(h => h.start + '-' + h.end).join('\n'));

      chk('#s-pay-enabled', c.payment.enabled);
      set('#s-pay-provider', c.payment.provider);
      set('#s-pay-currency', c.payment.currency);
      set('#s-pay-pertx', c.payment.perTx);
      set('#s-pay-daily', c.payment.daily);
      set('#s-pay-monthly', c.payment.monthly);
      set('#s-pay-autoapprove', c.payment.autoApprove);
      set('#s-pay-cooldown', c.payment.cooldownMin);
      set('#s-pay-merchants', (c.payment.merchantAllowlist || []).join('\n'));
      set('#s-pay-categories', (c.payment.categoryBlocklist || []).join('\n'));

      renderTriggerList();
      renderEmailAudit();
      renderPayLedger();
    } catch (e) {
      toast('读取本地服务配置失败：' + ((e && e.message) || e), true, true);
    }
  }

  async function saveFeatureConfig() {
    if (!A.sidecarReady()) return;
    const lines = sel => { const el = $(sel); return el ? el.value.split('\n').map(s => s.trim()).filter(Boolean) : []; };
    const num = sel => { const el = $(sel); return el ? (Math.max(0, Math.floor(Number(el.value) || 0))) : 0; };
    const quiet = [];
    const qel = $('#s-sched-quiet');
    if (qel) {
      for (const line of qel.value.split('\n')) {
        const m = /^\s*(\d{1,2}:\d{2})\s*(?:-|~|到|至)\s*(\d{1,2}:\d{2})\s*$/.exec(line);
        if (m) quiet.push({ start: m[1], end: m[2] });
      }
    }
    const patch = {
      email: {
        enabled: $('#s-email-enabled').checked,
        provider: $('#s-email-provider').value,
        from: $('#s-email-from').value.trim(),
        dailyLimit: num('#s-email-dailylimit'),
        allowlist: lines('#s-email-allowlist'),
      },
      schedule: {
        enabled: $('#s-sched-enabled').checked,
        paused: $('#s-sched-paused').checked,
        dailyCap: num('#s-sched-dailycap'),
        missedPolicy: $('#s-sched-missed').value,
        quietHours: quiet,
      },
      payment: {
        enabled: $('#s-pay-enabled').checked,
        provider: $('#s-pay-provider').value,
        currency: ($('#s-pay-currency').value.trim() || 'CNY'),
        perTx: num('#s-pay-pertx'),
        daily: num('#s-pay-daily'),
        monthly: num('#s-pay-monthly'),
        autoApprove: num('#s-pay-autoapprove'),
        cooldownMin: num('#s-pay-cooldown'),
        merchantAllowlist: lines('#s-pay-merchants'),
        categoryBlocklist: lines('#s-pay-categories'),
      },
    };
    const key = $('#s-email-resendkey').value.trim();
    if (key) patch.email.resendApiKey = key;
    try {
      await Sidecar.putConfig(patch);
      $('#s-email-resendkey').value = '';
      toast('功能设置已写入本地服务');
      A.renderSidecarStatus();
      renderTriggerList();
    } catch (e) {
      toast('写入本地服务失败：' + ((e && e.message) || e), true, true);
    }
  }

  /* ---- 主动联系安排 ---- */

  async function renderTriggerList() {
    const box = $('#trigger-list');
    if (!box) return;
    const sum = $('#trigger-summary');
    if (!A.sidecarReady()) {
      box.textContent = A.sidecarOffHint();
      if (sum) sum.textContent = '调度已暂停：本地服务未启动';
      return;
    }
    try {
      const r = await Sidecar.api('GET', '/api/triggers');
      const list = (r && r.triggers) || [];
      const st = (r && r.stats) || {};
      if (sum) sum.textContent = '共 ' + list.length + ' 个安排 · 生效 ' + (st.active || 0) + ' · 待处理 ' + (st.pending || 0) + ' 条';
      box.replaceChildren();
      if (!list.length) {
        const d = document.createElement('div');
        d.className = 'hint';
        d.textContent = '还没有任何安排。';
        box.appendChild(d);
        return;
      }
      for (const t of list) {
        const row = document.createElement('div');
        row.className = 'trigger-row';
        const main = document.createElement('div');
        main.className = 't-main';
        const name = document.createElement('div');
        name.className = 't-name';
        name.textContent = t.name;
        const pill = document.createElement('span');
        pill.className = 'status-pill' + (t.status === 'pending_confirm' ? ' pending' : '');
        pill.textContent = t.status === 'pending_confirm' ? '待确认' : (t.status === 'active' ? '生效中' : t.status);
        name.appendChild(pill);
        const meta = document.createElement('div');
        meta.className = 't-meta';
        meta.textContent = describeTrigger(t) + ' · 原因：' + (t.reason || '未写')
          + (t.nextAt ? ' · 下次 ' + fmtTime(t.nextAt) : '') + (t.channel ? ' · 仅该会话' : '');
        main.appendChild(name);
        main.appendChild(meta);
        row.appendChild(main);

        const acts = document.createElement('div');
        acts.className = 't-actions';
        if (t.status === 'pending_confirm') {
          const ok = document.createElement('button');
          ok.className = 'ui-btn mini';
          ok.textContent = '确认';
          ok.onclick = async () => {
            try { await Sidecar.confirmTrigger(t.id); toast('已生效'); renderTriggerList(); }
            catch (e) { toast('确认失败：' + ((e && e.message) || e), true); }
          };
          acts.appendChild(ok);
        }
        const del = document.createElement('button');
        del.className = 'ui-btn mini';
        del.textContent = '取消';
        del.onclick = async () => {
          try { await Sidecar.cancelTrigger(t.id); toast('已取消'); renderTriggerList(); }
          catch (e) { toast('取消失败：' + ((e && e.message) || e), true); }
        };
        acts.appendChild(del);
        row.appendChild(acts);
        box.appendChild(row);
      }
    } catch (e) {
      // 弹窗读取失败：正文给原因（用户可关掉重开重试），console 留完整现场
      box.textContent = '读取安排失败：' + reportBackgroundFailure('安排列表', e);
    }
  }

  /* ---- 邮件 ---- */

  async function renderEmailAudit() {
    const box = $('#email-audit');
    if (!box) return;
    if (!A.sidecarReady()) { box.textContent = '（本地服务未启动）'; return; }
    try {
      const r = await Sidecar.emailAudit(20);
      const list = (r && r.audit) || [];
      box.replaceChildren();
      if (!list.length) { box.textContent = '还没有邮件记录。'; return; }
      const KIND = { send: '发送', draft: '草稿', confirm: '确认' };
      for (const a of list) {
        const d = document.createElement('div');
        d.className = 'mono-line';
        const state = a.status === 'ok' ? '成功' : (a.status === 'pending' ? '发送中' : '拒绝');   // pending = 侧车发送占位
        d.textContent = fmtTime(a.at) + ' · ' + (KIND[a.kind] || a.kind) + ' → ' + a.to
          + (a.subject ? '（' + a.subject + '）' : '') + ' · ' + state
          + (a.code ? ' / ' + a.code : '');
        box.appendChild(d);
      }
    } catch (e) {
      // 纯后台降级：弹窗里给原因与重试方式，console 留完整现场
      box.textContent = '读取审计失败：' + reportBackgroundFailure('邮件审计', e) + '（关闭弹窗再打开可重试）';
    }
  }

  async function renderEmailDrafts() {
    const box = $('#email-drafts');
    if (!box) return;
    if (!A.sidecarReady()) { box.textContent = '（本地服务未启动）'; return; }
    try {
      const list = await Sidecar.emailSentDrafts();
      box.replaceChildren();
      if (!list.length) { box.textContent = '没有待确认的草稿。'; return; }
      for (const d of list) {
        const row = document.createElement('div');
        row.className = 'trigger-row';
        const main = document.createElement('div');
        main.className = 't-main';
        const to = document.createElement('div');
        to.className = 't-name';
        to.textContent = d.to;
        const meta = document.createElement('div');
        meta.className = 't-meta';
        meta.textContent = (d.subject || '（无主题）') + ' · ' + fmtTime(d.at);
        main.appendChild(to);
        main.appendChild(meta);
        row.appendChild(main);

        const acts = document.createElement('div');
        acts.className = 't-actions';
        const send = document.createElement('button');
        send.className = 'ui-btn mini';
        send.textContent = '确认发送';
        send.onclick = async () => {
          const ok = await irConfirm('确认真的寄出这封邮件？\n\n收件人：' + d.to + '\n主题：' + (d.subject || '（无）'), { title: '确认发送邮件', okText: '发送' });
          if (!ok) return;
          send.disabled = true;   // 双击防线之一（侧车侧还有 pending→sending 的同步抢占）
          try {
            const r = await Sidecar.emailSendDraft(d.id);
            toast(r && r.ok ? '已发送' : ('没发出：' + ((r && (r.message || r.code)) || '未知原因')), !(r && r.ok));
            renderEmailDrafts();
            renderEmailAudit();
          } catch (e) { toast('发送失败：' + ((e && e.message) || e), true); }
        };
        const del = document.createElement('button');
        del.className = 'ui-btn mini';
        del.textContent = '丢弃';
        del.onclick = async () => {
          try { await Sidecar.emailDiscardDraft(d.id); renderEmailDrafts(); }
          catch (e) { reportBackgroundFailure('丢弃草稿', e, { note: '草稿仍在，可再点一次丢弃' }); }
        };
        acts.appendChild(send);
        acts.appendChild(del);
        row.appendChild(acts);
        box.appendChild(row);
      }
    } catch (e) {
      // 纯后台降级：弹窗里给原因与重试方式，console 留完整现场
      box.textContent = '读取草稿失败：' + reportBackgroundFailure('邮件草稿', e) + '（关闭弹窗再打开可重试）';
    }
  }

  function openEmailModal() {
    // v0.6.0：「写邮件」只在智能体（chat）下可达；入口自己再挡一次，不依赖菜单是否渲染
    if (!A.featuresAllowed() || !S.story || S.story.mode !== 'chat') { toast('写邮件只在智能体模式可用：切到智能体模式再用', true); return; }
    if (!A.sidecarReady()) { toast(A.sidecarOffHint(), true, true); return; }
    const st = Sidecar.status();
    const el = $('#email-status');
    if (el) {
      el.textContent = (st.features && st.features.email)
        ? '邮件功能已开启。不在白名单里的收件人只会先存成草稿。'
        : '邮件功能还没开启：请先在「设置 → 邮件」里启用，并设置白名单与每日上限。';
    }
    openModal('modal-email');
    renderEmailDrafts();
  }

  async function doEmailSend() {
    const to = $('#em-to').value.trim();
    const subject = $('#em-subject').value.trim();
    const body = $('#em-body').value;
    if (!to) { toast('先填收件人', true); return; }
    try {
      let r = await Sidecar.emailSend({ to: to, subject: subject, body: body });
      if (r && r.code === 'NEED_CONFIRMATION') {
        const ok = await irConfirm(
          '这个收件人不在白名单里，已先存成草稿。\n\n收件人：' + to + '\n\n确认后才会真的寄出。',
          { title: '需要你确认', okText: '确认发送' }
        );
        if (!ok) { toast('已留作草稿，未发送'); renderEmailDrafts(); renderEmailAudit(); return; }
        r = await Sidecar.emailSendDraft(r.draftId);
      }
      if (r && r.ok) {
        toast('已发送');
        $('#em-subject').value = '';
        $('#em-body').value = '';
      } else {
        toast('没发出：' + ((r && (r.message || r.code)) || '未知原因'), true, true);
      }
      renderEmailDrafts();
      renderEmailAudit();
    } catch (e) {
      toast('发送失败：' + ((e && e.message) || e), true, true);
    }
  }

  /* ---- 购物支付 ---- */

  async function renderPayLedger() {
    const box = $('#pay-ledger');
    const sum = $('#pay-summary');
    if (!box) return;
    if (!A.sidecarReady()) { box.textContent = A.sidecarOffHint(); if (sum) sum.textContent = ''; return; }
    try {
      const r = await Sidecar.paymentTransactions(20);
      const list = (r && r.transactions) || [];
      const s = await Sidecar.paymentSummary('');
      if (sum && s && s.summary) {
        sum.textContent = '今日已用 ' + A.yuan(s.summary.spent.dailyCents) + ' · 本月 ' + A.yuan(s.summary.spent.monthlyCents)
          + ' · 每日剩余 ' + A.yuan(s.summary.remaining.dailyCents);
      }
      box.replaceChildren();
      if (!list.length) {
        const d = document.createElement('div');
        d.className = 'hint';
        d.textContent = '还没有交易记录。';
        box.appendChild(d);
        return;
      }
      for (const t of list) {
        const row = document.createElement('div');
        row.className = 'ledger-row';
        const main = document.createElement('div');
        main.className = 't-main';
        const head = document.createElement('div');
        head.className = 't-name';
        head.textContent = A.yuan(t.amountCents) + ' · ' + (t.merchant || '（未填商户）');
        const pill = document.createElement('span');
        pill.className = 'status-pill' + (t.status === 'denied' ? ' denied' : (t.status === 'pending' ? ' pending' : ''));
        pill.textContent = t.status + (t.code ? ' / ' + t.code : '');
        head.appendChild(pill);
        const meta = document.createElement('div');
        meta.className = 't-meta';
        meta.textContent = (t.agent || '（未指定）') + ' · ' + fmtTime(t.createdAt) + (t.providerRef ? ' · ' + t.providerRef : '');
        main.appendChild(head);
        main.appendChild(meta);
        row.appendChild(main);

        const acts = document.createElement('div');
        acts.className = 't-actions';
        const rec = document.createElement('button');
        rec.className = 'ui-btn mini';
        rec.textContent = '收据';
        rec.onclick = async () => {
          try {
            const rr = await Sidecar.paymentReceipt(t.intentId);
            if (rr && rr.receipt) A.irDownloadText('收据-' + t.intentId + '.txt', rr.receipt.text);
          } catch (e) { toast('导出失败：' + ((e && e.message) || e), true); }
        };
        acts.appendChild(rec);
        if (t.status === 'awaiting_payment') {
          const paid = document.createElement('button');
          paid.className = 'ui-btn mini';
          paid.textContent = '我已支付';
          paid.onclick = async () => {
            const ok = await irConfirm('确认你已经在微信 / 支付宝里手动付好款了？', { title: '标记已支付', okText: '已支付' });
            if (!ok) return;
            try { await Sidecar.paymentMarkPaid(t.intentId); toast('已标记为已支付'); renderPayLedger(); }
            catch (e) { toast('操作失败：' + ((e && e.message) || e), true); }
          };
          acts.appendChild(paid);
        }
        row.appendChild(acts);
        box.appendChild(row);
      }
    } catch (e) {
      // 纯后台降级：弹窗里给原因与重试方式，console 留完整现场
      box.textContent = '读取台账失败：' + reportBackgroundFailure('支付台账', e) + '（关闭弹窗再打开可重试）';
    }
  }

  function openPaymentModal() {
    // v0.6.0：「代下单」只在智能体（chat）下可达；入口自己再挡一次，不依赖菜单是否渲染
    if (!A.featuresAllowed() || !S.story || S.story.mode !== 'chat') { toast('代下单只在智能体模式可用：切到智能体模式再用', true); return; }
    if (!A.sidecarReady()) { toast(A.sidecarOffHint(), true, true); return; }
    const st = Sidecar.status();
    const el = $('#pay-status');
    if (el) {
      el.textContent = (st.features && st.features.payment)
        ? '支付功能已开启。策略由本地服务在代码层强制，AI 拿不到任何支付凭证。'
        : '支付功能还没开启：请先在「设置 → 购物支付」里启用并设置额度（默认全是 0，什么都不放行）。';
    }
    $('#pm-result').textContent = '';
    openModal('modal-payment');
  }

  // 三层授权第一层（长期授权范围）：下单必须挂在用户签发的 mandate 上，
  // agent 身份与币种由本地服务按 mandate / 配置映射，请求体自报无效。
  // 没有授权时先问用户要不要签发一份（发起方 agent、总额度=每月上限、不限品类）——不静默代签。
  async function ensurePaymentMandate() {
    try {
      const list = await Sidecar.paymentMandates();
      const mds = (list && list.mandates) || [];
      if (mds.length) return mds[0].id;
      const sum = await Sidecar.paymentSummary();
      const monthly = (sum && sum.summary && sum.summary.monthlyCents) || 0;
      const ok = await irConfirm(
        '下单要先有「长期授权范围」。现在按当前配置签发一份吗？\n\n'
        + '发起方：agent（由本地服务记账）\n总额度：' + A.yuan(monthly) + '（= 设置里的每月上限）\n品类：不限\n\n'
        + '之后每一笔仍要逐笔确认；额度与策略始终由本地服务在代码层强制。',
        { title: '签发长期授权', okText: '签发授权' }
      );
      if (!ok) return '';
      const md = await Sidecar.paymentCreateMandate({
        agent: 'agent', totalLimitCents: monthly, categories: [],
      });
      return (md && md.id) || '';
    } catch (e) {
      toast('读取授权范围失败：' + ((e && e.message) || e), true);
      return '';
    }
  }

  async function doPaymentSubmit() {
    const amountCents = Math.floor(Number($('#pm-amount').value) || 0);
    const merchant = $('#pm-merchant').value.trim();
    const category = $('#pm-category').value.trim();
    const itemsText = $('#pm-items').value.trim();
    const out = $('#pm-result');
    if (amountCents <= 0) { toast('先填金额（单位：分，例如 1999 = 19.99 元）', true); return; }
    try {
      const mandateId = await ensurePaymentMandate();
      if (!mandateId) {
        out.textContent = '没有放行：下单需要先签发长期授权范围。';
        toast('已取消：没有长期授权', true);
        return;
      }
      const r = await Sidecar.paymentPurchase({
        amountCents: amountCents, merchant: merchant, category: category,
        mandateId: mandateId, items: itemsText ? [{ name: itemsText }] : [],
      });
      if (!r || !r.ok) {
        out.textContent = '没有放行：' + ((r && (r.message || r.code)) || '未知原因');
        toast('这一笔没有放行' + (r && r.code ? '（' + r.code + '）' : ''), true, true);
        renderPayLedger();
        return;
      }
      if (r.needsApproval) {
        const rem = (r.summary && r.summary.remaining) || {};
        const lines = [
          '需要你确认这一笔：',
          '',
          '金额：' + A.yuan(amountCents),
          '商户：' + (merchant || '（未填）'),
          '品类：' + (category || '（未填）'),
        ];
        if (itemsText) lines.push('商品：' + itemsText);
        lines.push('', '每日剩余：' + A.yuan(rem.dailyCents || 0) + ' · 每月剩余：' + A.yuan(rem.monthlyCents || 0), '', '确认后才会真正扣款。');
        const ok = await irConfirm(lines.join('\n'), { title: '确认下单', okText: '确认并支付' });
        const rr = ok ? await Sidecar.paymentApprove(r.intentId) : await Sidecar.paymentDeny(r.intentId);
        out.textContent = ok
          ? ((rr && rr.ok) ? ('已放行（' + (rr.status || 'charged') + '）') : ('未完成：' + ((rr && (rr.message || rr.code)) || '')))
          : '已拒绝这一笔。';
        toast(ok ? '已确认' : '已拒绝', !ok);
      } else if (r.status === 'awaiting_payment') {
        out.textContent = (r.order && r.order.payHint) || '已生成订单，请手动付款后回来点「我已支付」。';
        toast('已生成订单：请手动付款');
      } else {
        out.textContent = '已放行（' + (r.status || 'charged') + '）。';
        toast('已放行');
      }
      renderPayLedger();
    } catch (e) {
      toast('提交失败：' + ((e && e.message) || e), true, true);
    }
  }

  // email_propose / payment_propose → 建提案（红线 1/2/3）：
  // 提案路径只走 Proposals.create（不碰任何 send / purchase / approve），失败给模型可读原因让它圆场，
  // 成功 pushLog({type:'proposal'})（回合内、commit 之前，由 logMark 切片收进节点），并回一条「待确认」提示。
  function runProposalTool(name, args) {
    const kind = name === 'email_propose' ? 'email' : 'payment';
    const res = Proposals.create(kind, args, Date.now());
    if (!res || !res.ok) {
      return '[提案失败] ' + ((res && res.error) || '参数不完整') + '。可以修正后重新提出；不要说已经完成。';
    }
    const p = res.proposal;
    A.pushLog({ type: 'proposal', proposal: p });
    if (kind === 'email') {
      return '[已提交，待用户确认] 邮件给 ' + p.args.to + '，主题「' + p.args.subject + '」；用户在界面确认前不会发送。不要说已经发出。';
    }
    return '[已提交，待用户确认] 下单 ' + A.yuan(p.args.amountCents) + '（' + (p.args.merchant || '未填商户') + '）；用户确认前不会扣款。不要说已经付款。';
  }

  /* ---- 提案卡（✉ 邮件提案 / 🛒 下单提案）：参数原值用 textContent 渲染（红线 4），未确认不可执行 ----
   * 状态文案只读 p.status（src/core/proposals.ts 的状态机是唯一真源）；
   * 旧档 / 中断的 executing 由渲染前的 Proposals.reconcile 提前收敛，这里只负责显示。 */
  function proposalStatusLabel(p, now) {
    const ST = Proposals.STATUS;
    if (p.status === ST.PENDING) {
      return (now < p.expiresAt) ? '等待确认' : '已过期';
    }
    if (p.status === ST.AWAITING) {
      return (now < p.expiresAt) ? '待二次确认（超额度，还没扣款）' : '已过期';
    }
    if (p.status === ST.EXECUTING) return '执行中';
    if (p.status === ST.DONE) return p.kind === 'email' ? '已发送' : '已下单';
    if (p.status === ST.DENIED) return '已拒绝';
    if (p.status === ST.EXPIRED) return '已过期';
    if (p.status === ST.FAILED) {
      const r = p.result || {};
      return '失败：' + (r.error || '未知原因')
        + (r.draftId && r.draftDiscarded === false ? '（残留草稿待清理）' : '');
    }
    return p.status;
  }

  /* 二次确认（红线 3）：不得自动批准；弹窗关掉 = 拒绝 → deny 清理 intent。
   * summary 从 p.result 取（它随存档落盘），所以关窗 / 刷新后从卡片「继续确认」也能原样恢复。 */
  async function askSecondConfirm(p) {
    const a = p.args;
    const summary = (p.result && p.result.summary) || null;
    const rem = (summary && summary.remaining) || {};
    const lines = [
      '需要你确认这一笔：',
      '',
      '金额：' + A.yuan(a.amountCents),
      '商户：' + (a.merchant || '（未填）'),
      '品类：' + (a.category || '（未填）'),
    ];
    const items = (a.items || []).map(i => i && i.name).filter(Boolean).join('、');
    if (items) lines.push('商品：' + items);
    lines.push('', '每日剩余：' + A.yuan(rem.dailyCents || 0) + ' · 每月剩余：' + A.yuan(rem.monthlyCents || 0), '', '确认后才会真正扣款。');
    const ok = await irConfirm(lines.join('\n'), { title: '确认下单', okText: '确认并支付' });
    if (ok) {
      try { await Proposals.approveSecond(p, Sidecar, Date.now()); }
      catch (err) { Proposals.markFailed(p, errorText(err)); }   // 用户可见的失败落在提案卡上
    } else {
      try { await Proposals.deny(p, Sidecar, Date.now()); }
      catch (err) { reportBackgroundFailure('拒绝提案', err, { note: '提案卡状态保持原样' }); }
    }
  }

  /* 确认 = 一次用户点击 → 最多一次执行（Proposals.confirm 同步抢占状态，连点不会二次执行）。
   * 待二次确认（awaiting_confirm）的提案也走这里：Proposals.confirm 对它可重入 —— 只把二次确认
   * 请求交还，不重复下单；用户真正点「确认并支付」后才 approveSecond。 */
  async function confirmProposal(entry) {
    const p = entry && entry.proposal;
    if (!p) { renderChat(); return; }
    const now = Date.now();
    Proposals.reconcile(p, now);   // 旧档迁移 / 中断的 executing / TTL 过期：一个入口收敛
    if (!Proposals.isActionable(p, now)) { saveAll(); renderChat(); return; }   // 终态 / 在途 / 过期
    if (!A.sidecarReady()) { toast(A.sidecarOffHint(), true, true); return; }
    let res = null;
    try {
      // 支付提案同样要挂长期授权：没有就先问用户签发；
      // mandateId 注入到 paymentPurchase 包装里，提案层保持纯函数、不碰授权细节。
      // 只有首次下单（pending）才需要授权；二次确认恢复时 intent 早建好了，别再问一遍。
      let svc = Sidecar;
      if (p.kind === 'payment' && p.status === Proposals.STATUS.PENDING) {
        const mandateId = await ensurePaymentMandate();
        if (!mandateId) {
          Proposals.markFailed(p, '下单需要先签发长期授权范围。');
          saveAll(); renderChat();
          return;
        }
        svc = Object.assign({}, Sidecar, {
          paymentPurchase: payload => Sidecar.paymentPurchase(Object.assign({}, payload, { mandateId: mandateId })),
        });
      }
      res = await Proposals.confirm(p, svc, Date.now());
    } catch (err) {
      // 用户可行动的失败：原因写进提案卡（卡片保留「清理草稿」等重试入口）
      res = Proposals.markFailed(p, errorText(err));
    }
    if (res && res.needsSecondConfirm) await askSecondConfirm(p);
    A.pushLog({ type: 'tool', tool: 'proposal', summary: proposalResultSummary(p) });
    saveAll();
    renderChat();
    renderPayLedger();
    toast(proposalResultSummary(p), p.status === Proposals.STATUS.FAILED);
  }

  /* 拒绝 / 清理：不执行任何发送 / 扣款。pending、awaiting_confirm 由 Proposals.deny 转 denied
   * 并清理 sidecar 里的草稿 / intent；发信失败（failed）后残留草稿的「清理草稿」也走这里。 */
  async function denyProposal(entry) {
    const p = entry && entry.proposal;
    if (!p) { renderChat(); return; }
    const before = p.status;
    let out = null;
    try { out = await Proposals.deny(p, Sidecar, Date.now()); }
    catch (err) { reportBackgroundFailure('拒绝提案', err, { note: '提案卡状态保持原样' }); }
    // 只有真的发生了状态迁移才留痕；「失败后清草稿」不改状态，别写一条误导性的日志
    if (p.status !== before) A.pushLog({ type: 'tool', tool: 'proposal', summary: proposalResultSummary(p) });
    if (out && out.status === Proposals.STATUS.FAILED && out.cleaned === false) {
      toast('清理草稿失败：本地服务可能离线，稍后再试', true);
    }
    saveAll();
    renderChat();
  }

  function proposalResultSummary(p) {
    if (!p) return '提案状态未知';
    const ST = Proposals.STATUS;
    const what = p.kind === 'email'
      ? ('邮件提案（给 ' + p.args.to + '）')
      : ('下单提案（' + A.yuan(p.args.amountCents) + ' · ' + (p.args.merchant || '未填商户') + '）');
    if (p.status === ST.DONE) return what + (p.kind === 'email' ? '：已发送' : '：已完成');
    if (p.status === ST.AWAITING) return what + '：已等你二次确认，未扣款';
    if (p.status === ST.EXECUTING) return what + '：执行中';
    if (p.status === ST.DENIED) return what + '：已拒绝，未执行';
    if (p.status === ST.EXPIRED) return what + '：已过期，未执行';
    if (p.status === ST.FAILED) {
      const r = p.result || {};
      return what + '：失败（' + (r.error || '未知原因') + '）'
        + (r.draftId && r.draftDiscarded === false ? '（残留草稿可在卡片上清理）' : '');
    }
    return what + '：' + p.status;
  }

  A.reg({ scheduleToolsAvailable, proposalToolsAvailable, runScheduleTool, loadFeatureConfig, saveFeatureConfig, renderTriggerList, openEmailModal, doEmailSend, renderPayLedger, openPaymentModal, doPaymentSubmit, runProposalTool, proposalStatusLabel, confirmProposal, denyProposal });

