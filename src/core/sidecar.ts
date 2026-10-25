/*
 * 无限阅读 · 本地服务（sidecar）客户端
 *
 * 前端核心保持纯前端：**没有本地服务也能用**。这一层只做四件事：
 *   1. 探测 http://127.0.0.1:<port>/health，探测不到就进入「离线」态（三功能在 UI 上禁用并提示）；
 *   2. 保存连接信息（端口 + token，存在 settings.sidecar，仅用于连本机服务）；
 *   3. 提供带 token 的 api() 客户端；
 *   4. 用 EventSource 订阅 SSE（到点触发 / 待确认变化），断线指数退避 + 重探。
 *
 * 注意：安全项（额度 / 白名单 / 每日上限 / 免打扰时段）**不在**这里，它们唯一真源在侧车的
 * config.json，本文件只经 API 读写，不落地到前端本地。
 *
 * 零依赖，纯浏览器原生；在 Node 下也能加载（看不到 EventSource 就跳过订阅），便于单测。
 */
import { IR, registerIR } from './ir.ts';

/* ↑ 阶段 2 搬迁自 js/sidecar.js（IIFE → ES module，函数体逐字未动）。
 * 模块间现存的 global.IR 惰性互访按铁律保留（可选依赖语义，见 src/core/ir.ts 头注）；
 * 导出即真实 API，IR 只是给未迁移界面层的镜像。 */
const global = globalThis as any;

  const DEFAULT_PORT = 4319;
  const PROBE_TIMEOUT_MS = 1500;
  const API_TIMEOUT_MS = 15000;
  const PROBE_OK_MS = 45000;                              // 在线时多久复探一次
  const PROBE_BACKOFF_MS = [3000, 10000, 30000, 60000];   // 离线时重探退避
  const SSE_BASE_MS = 1500;
  const SSE_MAX_MS = 30000;

  let cfg = { port: DEFAULT_PORT, token: '' };
  let state = 'offline';                 // 'offline' | 'online'
  let features = { email: false, schedule: false, payment: false };
  let health = null;                     // 最近一次 /health 原文
  let lastError = '';                    // 最近一次失败原因（给 UI 显示）
  let version = '';
  let probing = null;
  let sse = null;
  let sseRetry = 0;
  let probeTimer = null;
  let probeFailStep = 0;
  let stopped = true;
  const listeners = {};

  /* ---------------- 小工具 ---------------- */

  function base() { return 'http://127.0.0.1:' + (cfg.port || DEFAULT_PORT); }

  function on(name, fn) {
    if (typeof fn !== 'function') return function () {};
    (listeners[name] || (listeners[name] = [])).push(fn);
    return function off() { off2(name, fn); };
  }
  function off2(name, fn) {
    const arr = listeners[name];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  function emit(name, data) {
    const arr = listeners[name];
    if (!arr || !arr.length) return;
    for (const fn of arr.slice()) { try { fn(data); } catch (_) {} }
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function clampPort(p) {
    const n = Math.floor(Number(p));
    return (Number.isFinite(n) && n > 0 && n < 65536) ? n : DEFAULT_PORT;
  }

  function fetchWithTimeout(url, init, ms) {
    if (typeof AbortController === 'undefined') return fetch(url, init);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, Object.assign({}, init, { signal: ctrl.signal }))
      .finally(() => clearTimeout(timer));
  }

  /* ---------------- 状态切换 ---------------- */

  function setOffline(reason) {
    const changed = (state !== 'offline') || (lastError !== reason);
    state = 'offline';
    lastError = reason || '';
    features = { email: false, schedule: false, payment: false };
    health = null;
    stopSSE();
    if (changed) emit('state', status());
  }

  function setOnline(data) {
    const changed = (state !== 'online') || (version !== (data && data.version));
    state = 'online';
    lastError = '';
    health = data || null;
    version = (data && data.version) || '';
    const f = (data && data.features) || {};
    features = { email: !!f.email, schedule: !!f.schedule, payment: !!f.payment };
    if (changed) emit('state', status());
  }

  /* ---------------- 探测 ---------------- */

  function backoffDelay() {
    const d = PROBE_BACKOFF_MS[Math.min(probeFailStep, PROBE_BACKOFF_MS.length - 1)];
    probeFailStep += 1;
    return d;
  }

  function scheduleNextProbe(delay) {
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    if (stopped) return;
    probeTimer = setTimeout(() => {
      probe().then(ok => {
        if (ok) { probeFailStep = 0; startSSE(); }
        scheduleNextProbe(ok ? PROBE_OK_MS : backoffDelay());
      });
    }, delay);
  }

  // 探测 /health（短超时）。返回 Promise<boolean>；并发调用会复用同一次探测。
  function probe() {
    if (probing) return probing;
    probing = (async () => {
      try {
        const res = await fetchWithTimeout(base() + '/health', { method: 'GET', cache: 'no-store' }, PROBE_TIMEOUT_MS);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        setOnline(data);
        return true;
      } catch (e) {
        setOffline(netHint(e));
        return false;
      } finally {
        probing = null;
      }
    })();
    return probing;
  }

  function netHint(e) {
    const msg = (e && e.message) ? e.message : String(e || '');
    if (e && (e.name === 'AbortError' || /abort/i.test(msg))) return '连接超时';
    if (e instanceof TypeError) return '连不上（本地服务没启动？）';
    return msg || '未知错误';
  }

  /* ---------------- SSE ---------------- */

  function stopSSE() {
    if (sse) {
      try { sse.onerror = null; sse.onopen = null; sse.close(); } catch (_) {}
      sse = null;
    }
  }

  function scheduleReconnect() {
    stopSSE();
    if (stopped) return;
    const delay = Math.min(SSE_BASE_MS * Math.pow(2, sseRetry), SSE_MAX_MS);
    sseRetry = Math.min(sseRetry + 1, 6);
    setTimeout(() => {
      if (stopped) return;
      probe().then(ok => { if (ok) startSSE(); });
    }, delay);
  }

  let sseConnecting = false;

  function startSSE() {
    if (stopped || state !== 'online' || !cfg.token) return;
    if (!global.EventSource) return;
    if (sse || sseConnecting) return;
    sseConnecting = true;
    // EventSource 不能带 Authorization 头，token 也绝不进 URL（会进代理 / 日志 / Referer，审查 低危 #18）：
    // 先用 Bearer 换一张短时效一次性 ticket，再以 ?ticket= 连接
    api('POST', '/api/events/ticket').then(t => {
      sseConnecting = false;
      if (stopped || state !== 'online' || sse) return;
      const ticket = t && t.ticket;
      if (!ticket) { scheduleReconnect(); return; }
      try {
        sse = new global.EventSource(base() + '/api/events?ticket=' + encodeURIComponent(ticket));
      } catch (_) {
        sse = null;
        return;
      }
      sse.onopen = () => { sseRetry = 0; };
      sse.addEventListener('trigger.fire', ev => emit('fire', safeParse(ev.data)));
      sse.addEventListener('trigger.changed', ev => emit('changed', safeParse(ev.data)));
      sse.addEventListener('feature.changed', ev => emit('changed', safeParse(ev.data)));
      sse.onerror = () => scheduleReconnect();
    }).catch(() => {
      sseConnecting = false;
      scheduleReconnect();
    });
  }

  /* ---------------- 对外 ---------------- */

  function configure(settings) {
    const s = (settings && typeof settings === 'object') ? settings : {};
    const nextPort = clampPort(s.port === undefined ? cfg.port : s.port);
    const nextToken = (typeof s.token === 'string') ? s.token.trim() : cfg.token;
    const changed = (nextPort !== cfg.port) || (nextToken !== cfg.token);
    cfg = { port: nextPort, token: nextToken };
    if (changed) {
      stopSSE();
      sseRetry = 0;
      if (state === 'online' && cfg.token) startSSE();
    }
    return cfg;
  }

  async function api(method, path, body?) {
    const headers: any = { 'Content-Type': 'application/json' };
    if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
    const res = await fetchWithTimeout(base() + path, {
      method: method || 'GET',
      headers: headers,
      cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
    }, API_TIMEOUT_MS);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err: any = new Error((data && data.message) || ('HTTP ' + res.status));
      err.code = (data && data.code) || ('HTTP_' + res.status);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function status() {
    return {
      state: state,
      online: state === 'online',
      port: cfg.port,
      hasToken: !!cfg.token,
      features: Object.assign({}, features),
      version: version,
      lastError: lastError,
      health: health,
    };
  }

  function start(settings) {
    if (settings) configure(settings);
    stopped = false;
    probeFailStep = 0;
    return probe().then(ok => {
      // 首次就连不上 → 走退避重探（3s 起），别让用户启动服务后干等一个「在线复探周期」
      if (ok) { startSSE(); scheduleNextProbe(PROBE_OK_MS); }
      else scheduleNextProbe(backoffDelay());
      return ok;
    });
  }

  function stop() {
    stopped = true;
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    stopSSE();
  }

  // 便捷方法
  function can(feature) { return state === 'online' && !!features[feature]; }
  function config() { return { port: cfg.port, token: cfg.token }; }
  function getConfig() { return api('GET', '/api/config'); }
  // 业务失败的统一出入口（审查 可维护性 #7）：响应体带 { ok:false, code } 时抛出与 api() 400 同形的 Error
  //（err.code / err.status），调用方只用写一套 catch。成功则解包 body[key]。
  function unwrap(r, key) {
    if (r && r.ok === false) {
      const e: any = new Error(r.message || r.code || '请求失败');
      e.code = r.code || 'FAILED';
      e.status = 400;
      throw e;
    }
    return key ? (r && r[key]) : r;
  }

  function putConfig(patch) { return api('PUT', '/api/config', patch); }
  function listPending() { return api('GET', '/api/pending').then(r => (r && r.pending) || []); }
  function ackPending(id) { return api('POST', '/api/pending/' + encodeURIComponent(id) + '/ack'); }
  function listTriggers() { return api('GET', '/api/triggers').then(r => (r && r.triggers) || []); }
  function upsertTrigger(t) { return api('POST', '/api/triggers', t).then(r => unwrap(r, 'trigger')); }
  function confirmTrigger(id) { return api('POST', '/api/triggers/' + encodeURIComponent(id) + '/confirm').then(r => unwrap(r, 'trigger')); }
  function cancelTrigger(id) { return api('POST', '/api/triggers/' + encodeURIComponent(id) + '/cancel'); }
  function pauseAll(paused) { return api('POST', '/api/schedule/pause', { paused: paused !== false }); }

  // 邮件（一律用户显式发起；白名单与上限由侧车硬校验）
  function emailSend(msg) { return api('POST', '/api/email/send', msg); }
  function emailDraft(msg) { return api('POST', '/api/email/draft', msg).then(r => r && r.draft); }
  function emailSentDrafts() { return api('GET', '/api/email/drafts').then(r => (r && r.drafts) || []); }
  function emailSendDraft(id) { return api('POST', '/api/email/drafts/' + encodeURIComponent(id) + '/send'); }
  function emailDiscardDraft(id) { return api('DELETE', '/api/email/drafts/' + encodeURIComponent(id)); }
  function emailInbox(limit) { return api('GET', '/api/email/inbox' + (limit ? '?limit=' + encodeURIComponent(limit) : '')); }
  function emailAudit(limit) { return api('GET', '/api/email/audit' + (limit ? '?limit=' + encodeURIComponent(limit) : '')); }

  // 购物支付（模型拿不到凭证；策略由侧车强制）
  function paymentSummary(agent) { return api('POST', '/api/payment/summary', { agent: agent || '' }); }
  function paymentPurchase(payload) { return api('POST', '/api/payment/intents', payload); }
  function paymentApprove(id) { return api('POST', '/api/payment/intents/' + encodeURIComponent(id) + '/approve'); }
  function paymentDeny(id) { return api('POST', '/api/payment/intents/' + encodeURIComponent(id) + '/deny'); }
  function paymentCharge(id) { return api('POST', '/api/payment/intents/' + encodeURIComponent(id) + '/charge'); }
  function paymentMarkPaid(id) { return api('POST', '/api/payment/intents/' + encodeURIComponent(id) + '/paid'); }
  function paymentTransactions(limit) { return api('GET', '/api/payment/transactions' + (limit ? '?limit=' + encodeURIComponent(limit) : '')); }
  function paymentReceipt(id) { return api('GET', '/api/payment/receipt/' + encodeURIComponent(id)); }
  function paymentMandates() { return api('GET', '/api/payment/mandates'); }
  function paymentCreateMandate(m) { return api('POST', '/api/payment/mandates', m).then(r => unwrap(r, 'mandate')); }

  const __irApi = {
    Sidecar: {
      DEFAULT_PORT: DEFAULT_PORT,
      configure: configure,
      config: config,
      status: status,
      isOnline: () => state === 'online',
      can: can,
      probe: probe,
      start: start,
      stop: stop,
      api: api,
      on: on,
      off: off2,
      startSSE: startSSE,
      // 便捷封装
      getConfig: getConfig,
      putConfig: putConfig,
      listPending: listPending,
      ackPending: ackPending,
      listTriggers: listTriggers,
      upsertTrigger: upsertTrigger,
      confirmTrigger: confirmTrigger,
      cancelTrigger: cancelTrigger,
      pauseAll: pauseAll,
      // 邮件
      emailSend: emailSend,
      emailDraft: emailDraft,
      emailSentDrafts: emailSentDrafts,
      emailSendDraft: emailSendDraft,
      emailDiscardDraft: emailDiscardDraft,
      emailInbox: emailInbox,
      emailAudit: emailAudit,
      // 购物支付
      paymentSummary: paymentSummary,
      paymentPurchase: paymentPurchase,
      paymentApprove: paymentApprove,
      paymentDeny: paymentDeny,
      paymentCharge: paymentCharge,
      paymentMarkPaid: paymentMarkPaid,
      paymentTransactions: paymentTransactions,
      paymentReceipt: paymentReceipt,
      paymentMandates: paymentMandates,
      paymentCreateMandate: paymentCreateMandate,
    },
  };
  registerIR(__irApi);
  export const { Sidecar } = __irApi;