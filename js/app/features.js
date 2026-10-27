/*
 * js/app/features.js —— 调度工具 / 安全项读写 / 主动联系安排 / 邮件 / 购物支付 / 提案卡
 * 从 js/app.js 拆出（只搬家，不改行为）。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, toast, irConfirm, openModal, fmtTime, saveAll } = A;


  // 回合锚点（§3.A.4）：request_image 在 commit 之前提交、节点还没创建——任务提交时带上它；
  // 回合 commit 成功后补 nodeId，失败 / 主动停止置 dead；任务开跑前与写回前各核一次。

  /* ================= 可选本地服务（sidecar）：调度工具与主动消息 ================= */

  // 调度工具只在「对话 / 扮演」+ 本地服务在线 + 后端已开启调度时才下发
  function scheduleToolsAvailable() {
    const SC = IR.Sidecar;
    if (!SC || typeof SC.isOnline !== 'function' || !SC.isOnline()) return false;
    const st = SC.status();
    return !!(st.features && st.features.schedule && st.hasToken);
  }

  // 邮件 / 下单工具同样只在「本地服务在线 + 对应 feature 开启 + 有 token」时下发；
  // 另外 toolsForMode 只在 chat（智能体）模式放行（红线 7）。
  function proposalToolsAvailable() {
    const SC = IR.Sidecar;
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

  // 执行调度工具：一律提交给侧车，且一律是「待确认」——模型可以安排，但不能让主动行为自己生效
  async function runScheduleTool(name, args) {
    const SC = IR.Sidecar;
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
        return '[已提交，待用户确认] 一次性安排「' + t.name + '」定在 ' + fmtTime(at) + '；用户确认前不会触发。';
      }
      if (name === 'schedule_heartbeat') {
        const mins = Math.max(1, Math.floor(Number(a.everyMinutes) || 0));
        const t = await SC.upsertTrigger({
          name: a.name, type: 'interval', spec: { everyMs: mins * 60000 },
          prompt: a.prompt, reason: a.reason, channel: S.story ? S.story.id : '', source: 'model',
        });
        return '[已提交，待用户确认] 每隔 ' + mins + ' 分钟的安排「' + t.name + '」已创建；用户确认前不会触发。';
      }
      if (name === 'schedule_cron') {
        const t = await SC.upsertTrigger({
          name: a.name, type: 'cron', spec: { expr: a.expr, tz: a.tz || '' },
          prompt: a.prompt, reason: a.reason, channel: S.story ? S.story.id : '', source: 'model',
        });
        return '[已提交，待用户确认] 日历安排「' + t.name + '」：' + a.expr + '（' + (a.tz || 'UTC') + '）。';
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
      return '[调度失败] ' + ((e && e.message) || e);
    }
  }

  /* ---- 侧车连接状态与主动消息投递 ---- */

  // 邮件 / 定时主动 / 代下单只在「对话 / 扮演」模式可用：剧情模式里既不能出现，
  // 也不能被触发（入口函数自己也再挡一次，不依赖界面是否渲染）。

  // 局内功能入口：只有「对话 / 扮演」模式才有「＋」菜单；本地服务没启动时菜单项灰显

  /* ---------- 下拉菜单（顶栏「⋯」/ 输入区「＋」） ---------- */

  // 页面打开 / 重新上线时补跑：把侧车里排队的触达捞回来（页面关着时侧车只入队，不打扰）

  /* ---- 设置分区：安全项读写（真源在侧车 config.json，这里只是编辑界面） ---- */

  async function loadFeatureConfig() {
    if (!A.sidecarReady()) { A.renderSidecarStatus(); return; }
    try {
      const r = await IR.Sidecar.getConfig();
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
      await IR.Sidecar.putConfig(patch);
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
      const r = await IR.Sidecar.api('GET', '/api/triggers');
      const list = (r && r.triggers) || [];
      const st = (r && r.stats) || {};
      if (sum) sum.textContent = '共 ' + list.length + ' 个安排 · 生效 ' + (st.active || 0) + ' · 待处理 ' + (st.pending || 0) + ' 条';
      box.innerHTML = '';
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
          ok.className = 'mini-btn';
          ok.textContent = '确认';
          ok.onclick = async () => {
            try { await IR.Sidecar.confirmTrigger(t.id); toast('已生效'); renderTriggerList(); }
            catch (e) { toast('确认失败：' + ((e && e.message) || e), true); }
          };
          acts.appendChild(ok);
        }
        const del = document.createElement('button');
        del.className = 'mini-btn';
        del.textContent = '取消';
        del.onclick = async () => {
          try { await IR.Sidecar.cancelTrigger(t.id); toast('已取消'); renderTriggerList(); }
          catch (e) { toast('取消失败：' + ((e && e.message) || e), true); }
        };
        acts.appendChild(del);
        row.appendChild(acts);
        box.appendChild(row);
      }
    } catch (e) {
      box.textContent = '读取安排失败：' + ((e && e.message) || e);
    }
  }

  /* ---- 邮件 ---- */

  async function renderEmailAudit() {
    const box = $('#email-audit');
    if (!box) return;
    if (!A.sidecarReady()) { box.textContent = '（本地服务未启动）'; return; }
    try {
      const r = await IR.Sidecar.emailAudit(20);
      const list = (r && r.audit) || [];
      box.innerHTML = '';
      if (!list.length) { box.textContent = '还没有邮件记录。'; return; }
      const KIND = { send: '发送', draft: '草稿', confirm: '确认' };
      for (const a of list) {
        const d = document.createElement('div');
        d.className = 'mono-line';
        d.textContent = fmtTime(a.at) + ' · ' + (KIND[a.kind] || a.kind) + ' → ' + a.to
          + (a.subject ? '（' + a.subject + '）' : '') + ' · ' + (a.status === 'ok' ? '成功' : '拒绝')
          + (a.code ? ' / ' + a.code : '');
        box.appendChild(d);
      }
    } catch (_) { box.textContent = '读取审计失败。'; }
  }

  async function renderEmailDrafts() {
    const box = $('#email-drafts');
    if (!box) return;
    if (!A.sidecarReady()) { box.textContent = '（本地服务未启动）'; return; }
    try {
      const list = await IR.Sidecar.emailSentDrafts();
      box.innerHTML = '';
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
        send.className = 'mini-btn';
        send.textContent = '确认发送';
        send.onclick = async () => {
          const ok = await irConfirm('确认真的寄出这封邮件？\n\n收件人：' + d.to + '\n主题：' + (d.subject || '（无）'), { title: '确认发送邮件', okText: '发送' });
          if (!ok) return;
          try {
            const r = await IR.Sidecar.emailSendDraft(d.id);
            toast(r && r.ok ? '已发送' : ('没发出：' + ((r && (r.message || r.code)) || '未知原因')), !(r && r.ok));
            renderEmailDrafts();
            renderEmailAudit();
          } catch (e) { toast('发送失败：' + ((e && e.message) || e), true); }
        };
        const del = document.createElement('button');
        del.className = 'mini-btn';
        del.textContent = '丢弃';
        del.onclick = async () => {
          try { await IR.Sidecar.emailDiscardDraft(d.id); renderEmailDrafts(); } catch (_) {}
        };
        acts.appendChild(send);
        acts.appendChild(del);
        row.appendChild(acts);
        box.appendChild(row);
      }
    } catch (_) { box.textContent = '读取草稿失败。'; }
  }

  function openEmailModal() {
    // v0.6.0：「写邮件」只在智能体（chat）下可达；入口自己再挡一次，不依赖菜单是否渲染
    if (!A.featuresAllowed() || !S.story || S.story.mode !== 'chat') { toast('写邮件只在智能体模式可用：切到智能体模式再用', true); return; }
    if (!A.sidecarReady()) { toast(A.sidecarOffHint(), true, true); return; }
    const st = IR.Sidecar.status();
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
      let r = await IR.Sidecar.emailSend({ to: to, subject: subject, body: body });
      if (r && r.code === 'NEED_CONFIRMATION') {
        const ok = await irConfirm(
          '这个收件人不在白名单里，已先存成草稿。\n\n收件人：' + to + '\n\n确认后才会真的寄出。',
          { title: '需要你确认', okText: '确认发送' }
        );
        if (!ok) { toast('已留作草稿，未发送'); renderEmailDrafts(); renderEmailAudit(); return; }
        r = await IR.Sidecar.emailSendDraft(r.draftId);
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
      const r = await IR.Sidecar.paymentTransactions(20);
      const list = (r && r.transactions) || [];
      const s = await IR.Sidecar.paymentSummary('');
      if (sum && s && s.summary) {
        sum.textContent = '今日已用 ' + A.yuan(s.summary.spent.dailyCents) + ' · 本月 ' + A.yuan(s.summary.spent.monthlyCents)
          + ' · 每日剩余 ' + A.yuan(s.summary.remaining.dailyCents);
      }
      box.innerHTML = '';
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
        rec.className = 'mini-btn';
        rec.textContent = '收据';
        rec.onclick = async () => {
          try {
            const rr = await IR.Sidecar.paymentReceipt(t.intentId);
            if (rr && rr.receipt) A.irDownloadText('收据-' + t.intentId + '.txt', rr.receipt.text);
          } catch (e) { toast('导出失败：' + ((e && e.message) || e), true); }
        };
        acts.appendChild(rec);
        if (t.status === 'awaiting_payment') {
          const paid = document.createElement('button');
          paid.className = 'mini-btn';
          paid.textContent = '我已支付';
          paid.onclick = async () => {
            const ok = await irConfirm('确认你已经在微信 / 支付宝里手动付好款了？', { title: '标记已支付', okText: '已支付' });
            if (!ok) return;
            try { await IR.Sidecar.paymentMarkPaid(t.intentId); toast('已标记为已支付'); renderPayLedger(); }
            catch (e) { toast('操作失败：' + ((e && e.message) || e), true); }
          };
          acts.appendChild(paid);
        }
        row.appendChild(acts);
        box.appendChild(row);
      }
    } catch (_) { box.textContent = '读取台账失败。'; }
  }

  function openPaymentModal() {
    // v0.6.0：「代下单」只在智能体（chat）下可达；入口自己再挡一次，不依赖菜单是否渲染
    if (!A.featuresAllowed() || !S.story || S.story.mode !== 'chat') { toast('代下单只在智能体模式可用：切到智能体模式再用', true); return; }
    if (!A.sidecarReady()) { toast(A.sidecarOffHint(), true, true); return; }
    const st = IR.Sidecar.status();
    const el = $('#pay-status');
    if (el) {
      el.textContent = (st.features && st.features.payment)
        ? '支付功能已开启。策略由本地服务在代码层强制，AI 拿不到任何支付凭证。'
        : '支付功能还没开启：请先在「设置 → 购物支付」里启用并设置额度（默认全是 0，什么都不放行）。';
    }
    $('#pm-result').textContent = '';
    openModal('modal-payment');
  }

  // 三层授权第一层（长期授权范围，审查 中危 #13）：下单必须挂在用户签发的 mandate 上，
  // agent 身份与币种由本地服务按 mandate / 配置映射，请求体自报无效。
  // 没有授权时先问用户要不要签发一份（发起方 agent、总额度=每月上限、不限品类）——不静默代签。
  async function ensurePaymentMandate() {
    try {
      const list = await IR.Sidecar.paymentMandates();
      const mds = (list && list.mandates) || [];
      if (mds.length) return mds[0].id;
      const sum = await IR.Sidecar.paymentSummary();
      const monthly = (sum && sum.summary && sum.summary.monthlyCents) || 0;
      const ok = await irConfirm(
        '下单要先有「长期授权范围」。现在按当前配置签发一份吗？\n\n'
        + '发起方：agent（由本地服务记账）\n总额度：' + A.yuan(monthly) + '（= 设置里的每月上限）\n品类：不限\n\n'
        + '之后每一笔仍要逐笔确认；额度与策略始终由本地服务在代码层强制。',
        { title: '签发长期授权', okText: '签发授权' }
      );
      if (!ok) return '';
      const md = await IR.Sidecar.paymentCreateMandate({
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
      const r = await IR.Sidecar.paymentPurchase({
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
        const rr = ok ? await IR.Sidecar.paymentApprove(r.intentId) : await IR.Sidecar.paymentDeny(r.intentId);
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
  // 提案路径只走 IR.Proposals.create（不碰任何 send / purchase / approve），失败给模型可读原因让它圆场，
  // 成功 pushLog({type:'proposal'})（回合内、commit 之前，由 logMark 切片收进节点），并回一条「待确认」提示。
  function runProposalTool(name, args) {
    const kind = name === 'email_propose' ? 'email' : 'payment';
    const res = IR.Proposals.create(kind, args, Date.now());
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

  /* ---- 提案卡（✉ 邮件提案 / 🛒 下单提案）：参数原值用 textContent 渲染（红线 4），未确认不可执行 ---- */
  function proposalStatusLabel(p, now) {
    if (p.status === 'pending') {
      return (now < p.expiresAt) ? '等待确认' : '已过期';
    }
    if (p.status === 'executing') {
      return (p.result && p.result.needsSecondConfirm && !p.result.resolved) ? '执行中（等待你再确认一次）' : '执行中';
    }
    if (p.status === 'done') return p.kind === 'email' ? '已发送' : '已下单';
    if (p.status === 'denied') return '已拒绝';
    if (p.status === 'expired') return '已过期';
    if (p.status === 'failed') return '失败：' + ((p.result && p.result.error) || '未知原因');
    return p.status;
  }

  function proposalBubble(e) {
    const p = e && e.proposal;
    const now = Date.now();
    const d = document.createElement('div');
    d.className = 'bubble proposal-card';
    if (!p) { d.textContent = '（提案数据缺失）'; return d; }
    // 过期就地收敛状态（只改内存对象，与节点共享；下次 saveAll 落盘）
    if (p.status === 'pending' && now >= p.expiresAt) IR.Proposals.markExpired(p);

    const title = document.createElement('div');
    title.className = 'proposal-title';
    title.appendChild(A.iconEl(p.kind === 'email' ? 'mail' : 'cart', 'ic-l'));
    title.appendChild(document.createTextNode((p.kind === 'email' ? '邮件提案' : '下单提案') + '（要你确认才执行）'));
    d.appendChild(title);

    const table = document.createElement('div');
    table.className = 'proposal-args';
    const row = (k, v) => {
      const r = document.createElement('div');
      r.className = 'proposal-row';
      const kk = document.createElement('span');
      kk.className = 'proposal-key';
      kk.textContent = k;
      const vv = document.createElement('span');
      vv.className = 'proposal-val';
      vv.textContent = String(v == null ? '' : v);   // 工具参数原值，不是模型转述（红线 4）
      r.appendChild(kk); r.appendChild(vv);
      table.appendChild(r);
    };
    if (p.kind === 'email') {
      row('收件人', p.args.to);
      row('主题', p.args.subject);
      row('正文', p.args.body);
    } else {
      row('金额', A.yuan(p.args.amountCents));
      row('商户', p.args.merchant || '（未填）');
      row('品类', p.args.category || '（未填）');
      row('商品', (p.args.items || []).map(i => i && i.name).filter(Boolean).join('、') || '（未填）');
    }
    if (p.args.reason) row('理由', p.args.reason);
    d.appendChild(table);

    const foot = document.createElement('div');
    foot.className = 'proposal-foot';
    const status = document.createElement('span');
    status.className = 'proposal-status';
    let statusText = proposalStatusLabel(p, now);
    if (p.status === 'pending' && now < p.expiresAt) {
      const mins = Math.max(1, Math.ceil((p.expiresAt - now) / 60000));
      statusText += ' · 有效剩 ' + mins + ' 分钟';
    }
    status.textContent = statusText;
    foot.appendChild(status);

    const actionable = p.status === 'pending' && now < p.expiresAt && !S.busy;
    if (actionable) {
      const ok = document.createElement('button');
      ok.className = 'mini-btn proposal-ok';
      ok.type = 'button';
      ok.textContent = '确认';
      ok.title = '确认后才会真正执行（一封邮件 / 一笔扣款）';
      ok.onclick = () => { confirmProposal(e); };
      const no = document.createElement('button');
      no.className = 'mini-btn';
      no.type = 'button';
      no.textContent = '拒绝';
      no.onclick = () => { denyProposal(e); };
      foot.appendChild(ok);
      foot.appendChild(no);
    }
    d.appendChild(foot);
    return d;
  }

  // 确认 = 一次用户点击 → 最多一次执行（Proposals.confirm 同步抢占状态，连点不会二次执行）
  async function confirmProposal(entry) {
    const p = entry && entry.proposal;
    if (!p) return;
    if (p.status !== 'pending') { A.renderChat(); return; }   // 幂等：重复点击不再执行
    if (!IR.Proposals.isActionable(p, Date.now())) {
      IR.Proposals.markExpired(p);
      saveAll(); A.renderChat();
      return;
    }
    if (!A.sidecarReady()) { toast(A.sidecarOffHint(), true, true); return; }
    let res = null;
    try {
      // 支付提案同样要挂长期授权（审查 中危 #13）：没有就先问用户签发；
      // mandateId 注入到 paymentPurchase 包装里，提案层保持纯函数、不碰授权细节
      let svc = IR.Sidecar;
      if (p.kind === 'payment') {
        const mandateId = await ensurePaymentMandate();
        if (!mandateId) {
          p.status = 'failed';
          p.result = { ok: false, error: '下单需要先签发长期授权范围。' };
          saveAll(); A.renderChat();
          return;
        }
        svc = Object.assign({}, IR.Sidecar, {
          paymentPurchase: payload => IR.Sidecar.paymentPurchase(Object.assign({}, payload, { mandateId: mandateId })),
        });
      }
      res = await IR.Proposals.confirm(p, svc, Date.now());
    } catch (err) {
      p.status = 'failed';
      p.result = { ok: false, error: String((err && err.message) || err) };
      res = { status: 'failed' };
    }
    if (res && res.needsSecondConfirm) {
      // 红线 3：sidecar 要求人工确认时不得自动批准——再弹一次带额度余量的确认（文案沿用 doPaymentSubmit）
      const a = p.args;
      const rem = (res.summary && res.summary.remaining) || {};
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
        try { await IR.Proposals.approveSecond(p, IR.Sidecar); } catch (err) {
          p.status = 'failed';
          if (p.result) p.result.error = String((err && err.message) || err);
        }
      } else {
        try { await IR.Proposals.deny(p, IR.Sidecar); } catch (_) {}
      }
    }
    A.pushLog({ type: 'tool', tool: 'proposal', summary: proposalResultSummary(p) });
    saveAll();
    A.renderChat();
    renderPayLedger();
    toast(proposalResultSummary(p), p.status === 'failed');
  }

  // 拒绝：不执行任何发送 / 扣款；已有 intent / 草稿时由 Proposals.deny 负责清理
  async function denyProposal(entry) {
    const p = entry && entry.proposal;
    if (!p || (p.status !== 'pending' && p.status !== 'executing')) { A.renderChat(); return; }
    try { await IR.Proposals.deny(p, IR.Sidecar); } catch (_) {}
    A.pushLog({ type: 'tool', tool: 'proposal', summary: proposalResultSummary(p) });
    saveAll();
    A.renderChat();
  }

  function proposalResultSummary(p) {
    if (!p) return '提案状态未知';
    const what = p.kind === 'email'
      ? ('邮件提案（给 ' + p.args.to + '）')
      : ('下单提案（' + A.yuan(p.args.amountCents) + ' · ' + (p.args.merchant || '未填商户') + '）');
    if (p.status === 'done') return what + (p.kind === 'email' ? '：已发送' : '：已完成');
    if (p.status === 'denied') return what + '：已拒绝，未执行';
    if (p.status === 'expired') return what + '：已过期，未执行';
    if (p.status === 'failed') return what + '：失败（' + ((p.result && p.result.error) || '未知原因') + '）';
    return what + '：' + p.status;
  }

  A.reg({ scheduleToolsAvailable, proposalToolsAvailable, runScheduleTool, loadFeatureConfig, saveFeatureConfig, renderTriggerList, openEmailModal, doEmailSend, renderPayLedger, openPaymentModal, doPaymentSubmit, runProposalTool, proposalBubble, proposalStatusLabel, confirmProposal, denyProposal });
})();
