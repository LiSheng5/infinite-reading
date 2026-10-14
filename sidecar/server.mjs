#!/usr/bin/env node
/*
 * 无限阅读 · 本地旁路服务（sidecar）· 入口
 *
 * 定位：**可选**的本地伴侣进程，不是「应用必须有后端」。
 *   - 前端核心保持纯前端（零构建 / 零依赖）；侧车没启动时，前端探测 /health 失败即降级，
 *     三个功能在界面上显示「需要启动本地服务」并禁用，其余功能完全不受影响。
 *   - 只绑 127.0.0.1，不做局域网可达；除 /health 外所有接口都要 Bearer token。
 *     token 的目的是防「本机其它进程 / 网页乱调你的服务」（DNS rebinding 是 127.0.0.1 上真实存在的攻击面）。
 *
 * 本期零依赖：只用 node:http / node:fs / node:crypto（存储用 node:sqlite 在后续阶段接入）。
 *
 * 启动：  node sidecar/server.mjs            # 首次启动会打印 token
 *        node sidecar/server.mjs --show-token # 再次查看 token
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_PATH, LOCK_PATH, DEFAULT_PORT,
  ensureDataDir, loadConfig, publicConfig, applyEditablePatch,
} from './config.mjs';
import { openDb, closeDb } from './db.mjs';
import { addClient, broadcast, clientCount, closeAll } from './events.mjs';
import { createScheduler } from './scheduler.mjs';
import { createEmail } from './email.mjs';
import { createPayment } from './payment.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const START_AT = Date.now();
const VERSION = readVersion();

let scheduler = null;
let email = null;
let payment = null;

function requirePayment() {
  if (!payment) throw new Error('PAYMENT_NOT_READY');
  return payment;
}

function requireScheduler() {
  if (!scheduler) throw new Error('SCHEDULER_NOT_READY');
  return scheduler;
}

function requireEmail() {
  if (!email) throw new Error('EMAIL_NOT_READY');
  return email;
}

function readVersion() {
  try { return fs.readFileSync(path.join(HERE, '..', 'VERSION'), 'utf8').trim(); }
  catch (_) { return '0.0.0'; }
}

/* ---------------- 日志：只记必要事实，绝不记 token 与邮件正文 ---------------- */

function log(level, msg, extra) {
  const t = new Date().toISOString();
  const tail = extra ? ' ' + extra : '';
  const line = '[' + t + '] ' + level + ' ' + msg + tail;
  if (level === 'error') console.error(line);
  else console.log(line);
}

/* ---------------- 单进程：锁文件 + 端口占用双重防线 ---------------- */

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }   // 存在但无权限 → 仍算活着
}

function tryCreateLock() {
  const fd = fs.openSync(LOCK_PATH, 'wx');
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);
}

function acquireLock() {
  ensureDataDir();
  try {
    tryCreateLock();
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  // 已有锁：判断持有者是否还活着；陈旧锁（进程已死 / 干脆没写 pid）清掉重试一次
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10) || 0; } catch (_) {}
  if (pidAlive(pid)) return false;
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  try { tryCreateLock(); return true; }
  catch (_) { return false; }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
}

/* ---------------- HTTP 小工具 ---------------- */

function applyCors(req, res) {
  const origin = req.headers.origin;
  // 前端可能来自 file://（Origin 为字符串 "null"）或任意静态源；回显 Origin 即可，不用 credentials
  res.setHeader('Access-Control-Allow-Origin', origin ? origin : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit) {
  const max = limit || 128 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > max) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { reject(new Error('BAD_JSON')); }
    });
    req.on('error', reject);
  });
}

/* ---------------- 鉴权：Authorization: Bearer，或 SSE 用的 ?token=（EventSource 不能设请求头） ---------------- */

function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function tokenFrom(req, url) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  if (m) return m[1].trim();
  return (url.searchParams.get('token') || '').trim();
}

function authorized(req, url, cfg) {
  const got = tokenFrom(req, url);
  return !!got && timingEqual(got, cfg.token);
}

/* ---------------- 路由 ---------------- */

async function handle(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const cfg = loadConfig();

  // /health 免鉴权：前端只靠它判断「本地服务在不在」，且只回布尔，不含任何敏感信息
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJSON(res, 200, {
      ok: true,
      app: 'infinite-reading-sidecar',
      version: VERSION,
      uptimeMs: Date.now() - START_AT,
      features: {
        email: !!cfg.email.enabled,
        schedule: !!cfg.schedule.enabled,
        payment: !!cfg.payment.enabled,
      },
    });
  }

  if (!authorized(req, url, cfg)) {
    return sendJSON(res, 401, {
      ok: false, code: 'UNAUTHORIZED',
      message: '缺少或错误的 token。请带上 Authorization: Bearer <token>（token 见 sidecar/data/config.json）。',
    });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return sendJSON(res, 200, { ok: true, config: publicConfig(cfg) });
    }
    if (req.method === 'PUT' && url.pathname === '/api/config') {
      const body = await readBody(req);
      const next = applyEditablePatch(body);
      return sendJSON(res, 200, { ok: true, config: publicConfig(next), note: '已写入 sidecar/data/config.json（即时生效，无需重启）' });
    }

    /* ---- SSE：到点触发 / 待确认变化的推送通道 ---- */
    if (req.method === 'GET' && url.pathname === '/api/events') {
      addClient(req, res);
      return;   // 长连接：不结束响应
    }

    /* ---- 调度：触发器 ---- */
    if (req.method === 'GET' && url.pathname === '/api/triggers') {
      const sched = requireScheduler();
      return sendJSON(res, 200, { ok: true, triggers: sched.listTriggers(), stats: sched.stats() });
    }
    if (req.method === 'POST' && url.pathname === '/api/triggers') {
      const body = await readBody(req);
      const trigger = requireScheduler().upsertTrigger(body);
      return sendJSON(res, 200, { ok: true, trigger });
    }

    let m = /^\/api\/triggers\/([^/]+)\/confirm$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const trigger = requireScheduler().confirmTrigger(decodeURIComponent(m[1]));
      return sendJSON(res, 200, { ok: true, trigger });
    }
    m = /^\/api\/triggers\/([^/]+)\/cancel$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const done = requireScheduler().cancelTrigger(decodeURIComponent(m[1]));
      return sendJSON(res, 200, { ok: true, cancelled: done });
    }

    /* ---- 调度：一键暂停 / 待处理队列 ---- */
    if (req.method === 'POST' && url.pathname === '/api/schedule/pause') {
      const body = await readBody(req);
      const paused = body && body.paused !== undefined ? !!body.paused : true;
      const next = applyEditablePatch({ schedule: { paused } });
      broadcast('feature.changed', { feature: 'schedule', paused });
      requireScheduler().refresh();
      return sendJSON(res, 200, { ok: true, paused: next.schedule.paused });
    }
    if (req.method === 'GET' && url.pathname === '/api/pending') {
      return sendJSON(res, 200, { ok: true, pending: requireScheduler().listPending() });
    }
    m = /^\/api\/pending\/([^/]+)\/ack$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const done = requireScheduler().ackPending(decodeURIComponent(m[1]));
      return sendJSON(res, 200, { ok: true, acked: done });
    }

    /* ---- 邮件（一律用户显式发起；白名单与上限都在这里硬校验） ---- */
    if (req.method === 'POST' && url.pathname === '/api/email/send') {
      const body = await readBody(req);
      const r = await requireEmail().send(Object.assign({ actor: 'user' }, body));
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && url.pathname === '/api/email/draft') {
      const body = await readBody(req);
      return sendJSON(res, 200, { ok: true, draft: requireEmail().createDraft(body) });
    }
    if (req.method === 'GET' && url.pathname === '/api/email/drafts') {
      return sendJSON(res, 200, { ok: true, drafts: requireEmail().listDrafts() });
    }
    m = /^\/api\/email\/drafts\/([^/]+)\/send$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const r = await requireEmail().sendDraft(decodeURIComponent(m[1]), { actor: 'user' });
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    m = /^\/api\/email\/drafts\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && m) {
      return sendJSON(res, 200, { ok: true, discarded: requireEmail().discardDraft(decodeURIComponent(m[1])) });
    }
    if (req.method === 'GET' && url.pathname === '/api/email/inbox') {
      const r = await requireEmail().inbox({ limit: url.searchParams.get('limit') });
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'GET' && url.pathname === '/api/email/audit') {
      const mails = requireEmail();
      return sendJSON(res, 200, {
        ok: true,
        audit: mails.listAudit({ limit: url.searchParams.get('limit') }),
        stats: mails.stats(),
      });
    }

    /* ---- 购物支付（模型拿不到凭证；策略在这里强制执行） ---- */
    if (req.method === 'POST' && url.pathname === '/api/payment/intents') {
      const body = await readBody(req);
      const r = await requirePayment().purchase(body);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    m = /^\/api\/payment\/intents\/([^/]+)\/approve$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const pay = requirePayment();
      const id = decodeURIComponent(m[1]);
      const ok = pay.approve(id, { actor: 'user' });
      if (!ok.ok) return sendJSON(res, 400, ok);
      const charged = await pay.charge(id);           // 用户确认即放行 → 直接扣款
      return sendJSON(res, charged.ok ? 200 : 400, charged);
    }
    m = /^\/api\/payment\/intents\/([^/]+)\/deny$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const r = requirePayment().deny(decodeURIComponent(m[1]), { actor: 'user' });
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    m = /^\/api\/payment\/intents\/([^/]+)\/charge$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const r = await requirePayment().charge(decodeURIComponent(m[1]));
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    m = /^\/api\/payment\/intents\/([^/]+)\/paid$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const r = requirePayment().markPaid(decodeURIComponent(m[1]), { actor: 'user' });
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'GET' && url.pathname === '/api/payment/transactions') {
      return sendJSON(res, 200, {
        ok: true,
        transactions: requirePayment().listTransactions({ agent: url.searchParams.get('agent') || '', limit: url.searchParams.get('limit') }),
        stats: requirePayment().stats(),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/payment/summary') {
      const body = await readBody(req);
      return sendJSON(res, 200, { ok: true, summary: requirePayment().summary(body && body.agent) });
    }
    m = /^\/api\/payment\/receipt\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const r = requirePayment().receipt(decodeURIComponent(m[1]));
      if (!r) return sendJSON(res, 404, { ok: false, code: 'INTENT_NOT_FOUND', message: '找不到这笔交易。' });
      return sendJSON(res, 200, { ok: true, receipt: r });
    }
    if (req.method === 'GET' && url.pathname === '/api/payment/mandates') {
      return sendJSON(res, 200, { ok: true, mandates: requirePayment().listMandates() });
    }
    if (req.method === 'POST' && url.pathname === '/api/payment/mandates') {
      const body = await readBody(req);
      return sendJSON(res, 200, { ok: true, mandate: requirePayment().createMandate(body) });
    }
  } catch (e) {
    const code = String((e && e.message) || e);
    return sendJSON(res, 400, { ok: false, code: code, message: '请求无效：' + code });
  }

  return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', message: '没有这个接口：' + req.method + ' ' + url.pathname });
}

/* ---------------- 启动 ---------------- */

function featureLine(cfg) {
  const on = b => (b ? '开' : '关');
  return '邮件 ' + on(cfg.email.enabled)
    + ' · 主动行动 ' + on(cfg.schedule.enabled && !cfg.schedule.paused)
    + ' · 购物支付 ' + on(cfg.payment.enabled);
}

function banner(cfg, port, firstRun) {
  const showToken = firstRun || process.argv.includes('--show-token');
  console.log('');
  console.log('  无限阅读 · 本地服务（sidecar）v' + VERSION);
  console.log('  ──────────────────────────────────────────────');
  console.log('   地址   http://127.0.0.1:' + port + '   （只绑本机回环，局域网不可达）');
  console.log('   配置   ' + CONFIG_PATH);
  if (showToken) {
    console.log('   token  ' + cfg.token);
    console.log('          ↑ 复制到应用「设置 → 本地服务」里；以后可加 --show-token 再看');
  } else {
    console.log('   token  已存在（见上面配置文件；加 --show-token 可显示）');
  }
  console.log('   功能   ' + featureLine(cfg));
  if (scheduler) {
    const st = scheduler.stats();
    console.log('   调度   触发器 ' + st.triggers + ' 个 · 生效 ' + st.active + ' · 待处理 ' + st.pending + ' 条');
  }
  console.log('  ──────────────────────────────────────────────');
  console.log('  三个功能默认关闭。先在设置里开启并填好额度 / 白名单，才会真正生效。');
  console.log('  本服务按「单进程」设计：重复启动会被拒绝，避免定时触发被跑两遍。');
  console.log('');
}

function main() {
  ensureDataDir();
  const firstRun = !fs.existsSync(CONFIG_PATH);
  const cfg = loadConfig();

  if (!acquireLock()) {
    console.error('✖ 已有另一个 sidecar 实例在运行（锁文件：' + LOCK_PATH + '）。');
    console.error('  本项目按「单进程」设计，请先关闭它再启动，避免重复触发。');
    process.exit(1);
  }

  // SQLite 与调度器：在监听之前就绪，启动即按 missed 策略处理停摆期间错过的触发
  try {
    const db = openDb();
    scheduler = createScheduler({ db, getConfig: loadConfig, emit: broadcast });
    scheduler.start();
    email = createEmail({ db, getConfig: loadConfig });
    payment = createPayment({ db, getConfig: loadConfig });
  } catch (e) {
    console.error('✖ 初始化本地库失败：' + ((e && e.message) || e));
    console.error('  （node:sqlite 需要 Node ≥ 22.5；22.5–23.3 需加 --experimental-sqlite）');
    releaseLock();
    process.exit(1);
  }

  const port = cfg.port || DEFAULT_PORT;
  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      log('error', 'unhandled', String((e && e.message) || e));
      try { sendJSON(res, 500, { ok: false, code: 'INTERNAL', message: '服务内部错误' }); } catch (_) {}
    });
  });

  server.on('error', e => {
    if (e && e.code === 'EADDRINUSE') {
      console.error('✖ 端口 ' + port + ' 已被占用：可能已有一个 sidecar 在跑（或别的程序占了这个端口）。');
    } else {
      console.error('✖ 服务启动失败：', e);
    }
    try { scheduler && scheduler.stop(); } catch (_) {}
    try { closeDb(); } catch (_) {}
    releaseLock();
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => banner(cfg, port, firstRun));

  const shutdown = () => {
    log('info', 'shutting down');
    try { scheduler && scheduler.stop(); } catch (_) {}
    try { closeAll(); } catch (_) {}
    try { server.close(); } catch (_) {}
    try { closeDb(); } catch (_) {}
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', releaseLock);
}

main();
