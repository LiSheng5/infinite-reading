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
import { addClient, broadcast, closeAll, issueTicket, consumeTicket } from './events.mjs';
import { isFail } from './util.mjs';
import { createScheduler } from './scheduler.mjs';
import { createEmail, EMAIL_CODES } from './email.mjs';
import { createPayment } from './payment.mjs';
import { PAYMENT_CODES } from './payment-policy.mjs';

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

/* ---------------- 单进程：锁文件 + 端口占用双重防线 ----------------
 * 锁内容是 JSON（pid + 启动时间 + 随机数），不再只写 pid：
 *   1. `open('wx')` 与 `write` 之间被杀会留下**空锁文件**。旧实现把空内容 parseInt 成 0 →
 *      判「陈旧」→ unlink → 第二个实例照常启动，定时触发就跑两遍。
 *      现在空 / 不可解析一律按「正在启动」处理，只有超过 LOCK_GRACE_MS 还没写出内容才判陈旧。
 *   2. at / nonce 让「这行锁是谁写的、什么时候写的」在排错时可见（旧格式纯 pid 仍可读，升级不炸）。
 */

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }   // 存在但无权限 → 仍算活着
}

const LOCK_GRACE_MS = 5000;
const LOCK_NONCE = crypto.randomBytes(8).toString('hex');   // 本次启动的身份：释放锁时据此确认「这把锁是我写的」

function lockBody() {
  return JSON.stringify({
    pid: process.pid,
    at: START_AT,
    nonce: LOCK_NONCE,
  });
}

function tryCreateLock() {
  const fd = fs.openSync(LOCK_PATH, 'wx');   // 原子创建：并发下只有一个进程拿到 EEXIST 之外的路径
  try {
    fs.writeSync(fd, lockBody());            // 一次写完，避免「建了文件还没内容」的中间态
    fs.closeSync(fd);
  } catch (e) {
    // 写失败：我们并没有真正拿到锁，把自己刚建的空文件删掉，别把它留成别人的障碍
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
    throw e;
  }
}

/* 锁状态：gone（没有锁）/ busy（活着的实例）/ starting（刚建、内容还没落盘）/ stale（持有者已死） */
function readLock() {
  let raw = '';
  try { raw = fs.readFileSync(LOCK_PATH, 'utf8').trim(); }
  catch (_) { return { state: 'gone', pid: 0 }; }

  let pid = 0;
  if (raw) {
    if (raw.charAt(0) === '{') {
      try { pid = Math.floor(Number(JSON.parse(raw).pid)) || 0; } catch (_) { pid = 0; }
    } else {
      pid = parseInt(raw, 10) || 0;    // 旧版锁文件（纯 pid 数字）：过渡期照旧识别
    }
  }
  if (pid > 0) return { state: pidAlive(pid) ? 'busy' : 'stale', pid: pid };

  // 空 / 不可解析：可能是另一个实例刚 open、还没 write —— 给一个短暂宽限，别把它当成陈旧锁抢过来
  let age = 0;
  try { age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs; }
  catch (_) { return { state: 'gone', pid: 0 }; }
  return { state: age < LOCK_GRACE_MS ? 'starting' : 'stale', pid: 0 };
}

function acquireLock() {
  ensureDataDir();
  try {
    tryCreateLock();
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const held = readLock();
  if (held.state === 'busy' || held.state === 'starting') return false;
  // 陈旧锁：清掉重抢一次。unlink 与重建之间还有极窄的窗口，但走到这里的进程都已经确认原持有者已死，
  // 唯一性最终由 `wx` 的原子创建决定（输的一方拿到 EEXIST → false）。
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  try { tryCreateLock(); return true; }
  catch (_) { return false; }
}

/* 只删自己写的锁（按 nonce 认领）：手删锁文件后再起一个新实例时，旧进程退出不能把新实例的锁删掉，
 * 否则第三个实例就能同时跑起来 —— 那正是锁要防的事。旧格式（纯 pid）只能按 pid 认。 */
function releaseLock() {
  let raw = '';
  try { raw = fs.readFileSync(LOCK_PATH, 'utf8').trim(); }
  catch (_) { return; }
  let mine = false;
  try { mine = JSON.parse(raw).nonce === LOCK_NONCE; }
  catch (_) { mine = raw === String(process.pid); }
  if (!mine) return;
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
}

/* ---------------- 请求来源边界（Host / Origin） ----------------
 * 三层判据，都在路由与鉴权之前：
 *   1. **Host 必须是本机回环**。DNS rebinding 的攻击页把 attack.example 解析到 127.0.0.1，
 *      浏览器认为和自己同源（连 CORS 都不触发），只有 Host 头能把它认出来 → 403 BAD_HOST。
 *   2. **Origin 只能是本机 http(s) 来源**，别的站点一律 403 ORIGIN_NOT_ALLOWED，连 CORS 头都不给。
 *   3. `Origin: null` 单独处理：file:// 单文件产物的 Origin 就是这个字面量，但**任意站点的
 *      沙箱 iframe 也是**（实测 Chrome 两边都是 `Origin: null` + `Sec-Fetch-Site: cross-site`，
 *      浏览器没给任何可区分的信号）。所以这里不放「null 一律通过」，改成**只对带凭据的请求回显**：
 *      本项目的 file:// 前端每个业务请求都带 Bearer token，SSE 带一次性 ticket，/health 不需要
 *      凭据且只回布尔能力位。不带凭据的页面（含沙箱 iframe）拿不到 CORS 头，读不到任何响应。
 */
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// 不带 Host 的只有 HTTP/1.0 与手写客户端（浏览器一定带），不能因此把本机脚本挡住
function hostAllowed(req) {
  const host = req.headers.host;
  if (!host) return true;
  return LOCAL_HOST.test(String(host).trim());
}

/* Origin 分类：none（非浏览器 / 同源导航）/ local（本机页面）/ file（Origin: null）/ foreign（别的站点） */
function originKind(req) {
  const origin = req.headers.origin;
  if (!origin) return 'none';
  if (LOCAL_ORIGIN.test(origin)) return 'local';
  if (origin === 'null') return 'file';
  return 'foreign';
}

// file:// 那边的凭据：普通请求走 Authorization（token），SSE 走 ?ticket=（EventSource 带不了请求头）。
// 这里只要求「带上了凭据」而不是「凭据正确」：校验仍在 authorized()/ticket 那一步，
// 这样 token 填错时前端还能读到 401 的说明，而不是只看到一句「连不上」。
function fileClientCredentialed(req, url) {
  if (req.headers.authorization) return true;
  return !!url.searchParams.get('ticket');
}

function applyCors(res, origin) {
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

/* 被拒绝的来源只提示一次：恶意页面会反复重试，日志不能被它刷爆 */
const warnedSources = new Set();
function warnOnce(key, msg, extra) {
  if (warnedSources.has(key)) return;
  if (warnedSources.size > 50) warnedSources.clear();
  warnedSources.add(key);
  log('warn', msg, extra);
}

function sendJSON(res, code, obj, onSent) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body, onSent);
}

function readBody(req, limit) {
  const max = limit || 128 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];

    /* 超限：这里**不能** req.destroy() —— socket 一断，dispatch 随后写的 413/400
     * 根本发不出去，客户端只会看到 ECONNRESET，误以为是「服务挂了」而不是「body 太大」。
     * 正确顺序：先暂停读取（不再往内存里堆 chunk，TCP 窗口自然收紧让对方停写）→ reject →
     * dispatch 把 413 + Connection: close 写回去 → 响应发完再 destroy（见 handle 的 catch）。 */
    const tooLarge = () => {
      if (over) return;
      over = true;
      chunks.length = 0;
      try { req.pause(); } catch (_) {}
      reject(new Error('BODY_TOO_LARGE'));
    };

    req.on('data', c => {
      if (over) return;
      size += c.length;
      if (size > max) { tooLarge(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { reject(new Error('BAD_JSON')); }
    });
    req.on('error', e => { if (!over) reject(e); });
  });
}

/* ---------------- 鉴权：只认 Authorization: Bearer ----------------
 * 查询参数里的 ?token= 已移除：URL 会进代理 / 访问日志 / Referer，
 * token 不能出现在 URL 里。EventSource 不能设请求头 → SSE 走短时效一次性 ticket
 * （POST /api/events/ticket 用 Bearer 换，再以 ?ticket= 连接）。
 */

function timingEqual(a, b) {
  // 定长哈希再比：直接比较原始串时，长度不等会提前返回，泄漏长度侧信道
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function tokenFrom(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : '';
}

function authorized(req, cfg) {
  const got = tokenFrom(req);
  return !!got && timingEqual(got, cfg.token);
}

/* ---------------- 错误映射：业务码白名单，其余 500 ----------------
 * catch 里不能把 e.message 原文回给客户端：SQLite 约束名、系统错误等
 * 属于内部实现细节。只有白名单里的业务码按 400/503 + 可读文案返回，其余一律
 * 500 + 通用文案，细节只进服务端日志。
 */
const BIZ_MESSAGES = {
  BAD_JSON: '请求体不是合法 JSON。',
  BODY_TOO_LARGE: '请求体太大了。',
  NAME_REQUIRED: '触发器名字不能为空。',
  TRIGGER_NOT_FOUND: '找不到这个触发器。',
  TRIGGER_LOCKED: '这个安排已经被用户确认生效，模型不能改写它：请换个名字新建，或请用户先取消旧的。',
  ONCE_NEEDS_AT: '一次性触发器需要一个触发时间。',
  INTERVAL_NEEDS_EVERYMS_MIN_1_MINUTE: '心跳间隔至少 1 分钟。',
  BAD_TIMEZONE: '时区不合法。',
  BAD_TRIGGER_TYPE: '不支持的触发器类型。',
  CRON_EMPTY: 'cron 表达式为空。',
  CRON_NEEDS_5_FIELDS: 'cron 表达式需要 5 个字段。',
  AGENT_REQUIRED: '授权范围必须指定发起方（agent）。',
};
const BIZ_CODES = new Set([
  'BAD_JSON', 'BODY_TOO_LARGE',
  'NAME_REQUIRED', 'TRIGGER_NOT_FOUND', 'TRIGGER_LOCKED',
  'ONCE_NEEDS_AT', 'INTERVAL_NEEDS_EVERYMS_MIN_1_MINUTE', 'BAD_TIMEZONE', 'BAD_TRIGGER_TYPE',
  'CRON_EMPTY', 'CRON_EMPTY_FIELD', 'CRON_BAD_STEP', 'CRON_BAD_NUMBER', 'CRON_NEEDS_5_FIELDS', 'CRON_OUT_OF_RANGE',
  'AGENT_REQUIRED',
  ...PAYMENT_CODES, ...EMAIL_CODES,
]);
const NOT_READY_CODES = new Set(['PAYMENT_NOT_READY', 'SCHEDULER_NOT_READY', 'EMAIL_NOT_READY']);

function bizMessage(code) {
  return BIZ_MESSAGES[code] || ('请求无效（' + code + '）');
}

/* ---------------- 路由表 ----------------
 * handle() 手写正则顺序路由 → [{method, re, body, run}] 路由表，
 * 鉴权 / 解码 / 错误映射收口到 dispatch 一处。新增接口只需在表里加一行，
 * 不会漏鉴权、漏解码、漏错误映射。
 *   run(ctx) → { status, body }；ctx = { req, res, url, cfg, params, body, query }
 *   body:true 时 dispatch 统一 await readBody（解码只此一处）。
 */

// 常见「业务结果 → HTTP」映射：r.ok ? 200 : 400
const okOr400 = (r) => ({ status: r.ok ? 200 : 400, body: r });

// 模块层返回 fail(code)（业务失败返回结构、不 throw）→ 400 + 可读文案
const failTo400 = (r) => ({
  status: 400,
  body: { ok: false, code: r.code, message: r.message || bizMessage(r.code) },
});

const ROUTES = [
  /* ---- 配置 ---- */
  {
    method: 'GET', re: /^\/api\/config$/, body: false,
    run: (c) => ({ status: 200, body: { ok: true, config: publicConfig(c.cfg) } }),
  },
  {
    method: 'PUT', re: /^\/api\/config$/, body: true,
    run: (c) => {
      const next = applyEditablePatch(c.body);
      return { status: 200, body: { ok: true, config: publicConfig(next), note: '已写入 sidecar/data/config.json（即时生效，无需重启）' } };
    },
  },

  /* ---- SSE ticket 发放：Bearer 换短时效一次性凭据（连接本身见 handle 入口处） ---- */
  {
    method: 'POST', re: /^\/api\/events\/ticket$/, body: false,
    run: () => ({ status: 200, body: Object.assign({ ok: true }, issueTicket()) }),
  },

  /* ---- 调度：触发器 ---- */
  {
    method: 'GET', re: /^\/api\/triggers$/, body: false,
    run: () => {
      const sched = requireScheduler();
      return { status: 200, body: { ok: true, triggers: sched.listTriggers(), stats: sched.stats() } };
    },
  },
  {
    method: 'POST', re: /^\/api\/triggers$/, body: true,
    run: (c) => {
      // body 原样交给 upsertTrigger，但 source 不在里面读：HTTP 一律按模型处理（新建待确认、
      // 改不动已确认的行），否则请求体里写 source:'user' 就等于自带一把绕过确认闸门的钥匙。
      const r = requireScheduler().upsertTrigger(c.body);
      return isFail(r) ? failTo400(r) : { status: 200, body: { ok: true, trigger: r } };
    },
  },
  {
    method: 'POST', re: /^\/api\/triggers\/([^/]+)\/confirm$/, body: false,
    run: (c) => {
      const r = requireScheduler().confirmTrigger(c.params[0]);
      return isFail(r) ? failTo400(r) : { status: 200, body: { ok: true, trigger: r } };
    },
  },
  {
    method: 'POST', re: /^\/api\/triggers\/([^/]+)\/cancel$/, body: false,
    run: (c) => ({ status: 200, body: { ok: true, cancelled: requireScheduler().cancelTrigger(c.params[0]) } }),
  },

  /* ---- 调度：一键暂停 / 待处理队列 ---- */
  {
    method: 'POST', re: /^\/api\/schedule\/pause$/, body: true,
    run: (c) => {
      const paused = c.body && c.body.paused !== undefined ? !!c.body.paused : true;
      const next = applyEditablePatch({ schedule: { paused } });
      broadcast('feature.changed', { feature: 'schedule', paused });
      requireScheduler().refresh();
      return { status: 200, body: { ok: true, paused: next.schedule.paused } };
    },
  },
  {
    method: 'GET', re: /^\/api\/pending$/, body: false,
    run: () => ({ status: 200, body: { ok: true, pending: requireScheduler().listPending() } }),
  },
  {
    method: 'POST', re: /^\/api\/pending\/([^/]+)\/ack$/, body: false,
    run: (c) => ({ status: 200, body: { ok: true, acked: requireScheduler().ackPending(c.params[0]) } }),
  },

  /* ---- 邮件（一律用户显式发起；白名单与上限都在这里硬校验） ---- */
  {
    method: 'POST', re: /^\/api\/email\/send$/, body: true,
    run: async (c) => {
      // 只收 to/subject/body。confirm / actor 由服务端掌握：
      // 「已确认」只存在于草稿确认流（/drafts/:id/send → sendDraft 内部带 confirmed），
      // 请求体里的 confirm 一律无视——否则白名单闸门退化成一个可伪造的布尔；
      // actor 恒为 user，不允许调用方冒充（审计口径）。
      const r = await requireEmail().send(
        { to: c.body.to, subject: c.body.subject, body: c.body.body, actor: 'user' },
        { confirmed: false }
      );
      return okOr400(r);
    },
  },
  {
    method: 'POST', re: /^\/api\/email\/draft$/, body: true,
    run: (c) => ({ status: 200, body: { ok: true, draft: requireEmail().createDraft(c.body) } }),
  },
  {
    method: 'GET', re: /^\/api\/email\/drafts$/, body: false,
    run: () => ({ status: 200, body: { ok: true, drafts: requireEmail().listDrafts() } }),
  },
  {
    method: 'POST', re: /^\/api\/email\/drafts\/([^/]+)\/send$/, body: false,
    run: async (c) => okOr400(await requireEmail().sendDraft(c.params[0], { actor: 'user' })),
  },
  {
    method: 'DELETE', re: /^\/api\/email\/drafts\/([^/]+)$/, body: false,
    run: (c) => ({ status: 200, body: { ok: true, discarded: requireEmail().discardDraft(c.params[0]) } }),
  },
  {
    method: 'GET', re: /^\/api\/email\/audit$/, body: false,
    run: (c) => {
      const mails = requireEmail();
      return { status: 200, body: { ok: true, audit: mails.listAudit({ limit: c.query.get('limit') }), stats: mails.stats() } };
    },
  },

  /* ---- 购物支付（模型拿不到凭证；策略在这里强制执行） ---- */
  {
    method: 'POST', re: /^\/api\/payment\/intents$/, body: true,
    run: async (c) => okOr400(await requirePayment().purchase(c.body)),
  },
  {
    method: 'POST', re: /^\/api\/payment\/intents\/([^/]+)\/approve$/, body: false,
    run: async (c) => {
      const pay = requirePayment();
      const ok = pay.approve(c.params[0], { actor: 'user' });
      if (!ok.ok) return { status: 400, body: ok };
      const charged = await pay.charge(c.params[0]);   // 用户确认即放行 → 直接扣款
      return okOr400(charged);
    },
  },
  {
    method: 'POST', re: /^\/api\/payment\/intents\/([^/]+)\/deny$/, body: false,
    run: (c) => okOr400(requirePayment().deny(c.params[0], { actor: 'user' })),
  },
  {
    method: 'POST', re: /^\/api\/payment\/intents\/([^/]+)\/charge$/, body: false,
    run: async (c) => okOr400(await requirePayment().charge(c.params[0])),
  },
  {
    method: 'POST', re: /^\/api\/payment\/intents\/([^/]+)\/paid$/, body: false,
    run: (c) => okOr400(requirePayment().markPaid(c.params[0], { actor: 'user' })),
  },
  {
    method: 'GET', re: /^\/api\/payment\/transactions$/, body: false,
    run: (c) => ({
      status: 200,
      body: {
        ok: true,
        transactions: requirePayment().listTransactions({ agent: c.query.get('agent') || '', limit: c.query.get('limit') }),
        stats: requirePayment().stats(),
      },
    }),
  },
  {
    method: 'POST', re: /^\/api\/payment\/summary$/, body: true,
    run: (c) => ({ status: 200, body: { ok: true, summary: requirePayment().summary(c.body && c.body.agent) } }),
  },
  {
    method: 'GET', re: /^\/api\/payment\/receipt\/([^/]+)$/, body: false,
    run: (c) => {
      const r = requirePayment().receipt(c.params[0]);
      if (!r) return { status: 404, body: { ok: false, code: 'INTENT_NOT_FOUND', message: '找不到这笔交易。' } };
      return { status: 200, body: { ok: true, receipt: r } };
    },
  },
  {
    method: 'GET', re: /^\/api\/payment\/mandates$/, body: false,
    run: () => ({ status: 200, body: { ok: true, mandates: requirePayment().listMandates() } }),
  },
  {
    method: 'POST', re: /^\/api\/payment\/mandates$/, body: true,
    run: (c) => {
      const r = requirePayment().createMandate(c.body);
      return isFail(r) ? failTo400(r) : { status: 200, body: { ok: true, mandate: r } };
    },
  },
];

function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (m) return { route: r, params: m.slice(1).map(decodeURIComponent) };
  }
  return null;
}

/* ---------------- 路由 ---------------- */

async function handle(req, res) {
  // ① Host：DNS rebinding 的唯一识别点（浏览器会把攻击者的域名原样带过来）
  if (!hostAllowed(req)) {
    const host = String(req.headers.host || '');
    warnOnce('host:' + host, 'reject host', host);
    return sendJSON(res, 403, {
      ok: false, code: 'BAD_HOST',
      message: '本服务只接受 127.0.0.1 / localhost 的请求（当前 Host：' + host + '）。',
    });
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const kind = originKind(req);

  // ② 别的站点：不给 CORS 头，直接 403（浏览器读不到，但请求也不该被执行）
  if (kind === 'foreign') {
    const origin = String(req.headers.origin || '');
    warnOnce('origin:' + origin, 'reject origin', origin);
    return sendJSON(res, 403, {
      ok: false, code: 'ORIGIN_NOT_ALLOWED',
      message: '本服务只对本机页面（localhost / 127.0.0.1）与 file:// 单文件产物开放。',
    });
  }

  // ③ Origin: null（file://）与沙箱 iframe 无法区分 → 只对带凭据的请求回显 CORS。
  //    /health 是公开接口（只回布尔能力位，前端靠它判断「服务在不在」），不需要凭据也照常回显。
  const isPreflight = req.method === 'OPTIONS';
  const isPublicHealth = req.method === 'GET' && url.pathname === '/health';
  const corsOk = kind !== 'file' || isPreflight || isPublicHealth || fileClientCredentialed(req, url);
  applyCors(res, corsOk ? (req.headers.origin || null) : null);
  if (!corsOk) {
    warnOnce('null-origin:' + url.pathname, 'reject null origin without credential', req.method + ' ' + url.pathname);
    return sendJSON(res, 403, {
      ok: false, code: 'ORIGIN_NOT_ALLOWED',
      message: 'file:// 页面需要带 Authorization（或 SSE 的 ticket）才能访问；不带凭据的页面不开放 CORS。',
    });
  }

  if (isPreflight) { res.writeHead(204); res.end(); return; }

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

  /* ---- SSE 连接：ticket 就是这张长连接的凭据（EventSource 带不了 Authorization 头），
   * 必须先于通用 Bearer 鉴权处理；ticket 本身短时效、一次性 ---- */
  if (req.method === 'GET' && url.pathname === '/api/events') {
    if (!consumeTicket(url.searchParams.get('ticket'))) {
      return sendJSON(res, 401, {
        ok: false, code: 'UNAUTHORIZED',
        message: '缺少或过期的 SSE ticket：先 POST /api/events/ticket（带 Bearer token）换一张，一次性、30 秒内有效。',
      });
    }
    if (!addClient(req, res)) {
      return sendJSON(res, 429, { ok: false, code: 'SSE_CLIENTS_FULL', message: '实时推送连接数已达上限，请稍后重连。' });
    }
    return;   // 长连接：不结束响应
  }

  if (!authorized(req, cfg)) {
    return sendJSON(res, 401, {
      ok: false, code: 'UNAUTHORIZED',
      message: '缺少或错误的 token。请带上 Authorization: Bearer <token>（token 见 sidecar/data/config.json）。',
    });
  }

  const hit = matchRoute(req.method, url.pathname);
  if (!hit) {
    return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', message: '没有这个接口：' + req.method + ' ' + url.pathname });
  }

  try {
    // 统一解码：body:true 的路由在此一次性读请求体（readBody 抛 BAD_JSON / BODY_TOO_LARGE）
    const body = hit.route.body ? await readBody(req) : undefined;
    const out = await hit.route.run({
      req: req, res: res, url: url, cfg: cfg,
      params: hit.params, body: body, query: url.searchParams,
    });
    return sendJSON(res, out.status, out.body);
  } catch (e) {
    // 统一错误映射：业务码白名单按 400/503，其余 500 + 通用文案
    const code = String((e && e.message) || e);
    /* body 超限：readBody 只暂停读取、不断连接，这里必须先把 413 完整写回去，
     * 再关连接 —— 顺序反了客户端只会看到 ECONNRESET，拿不到「请求体太大了」这句提示。 */
    if (code === 'BODY_TOO_LARGE') {
      res.setHeader('Connection', 'close');
      return sendJSON(res, 413, { ok: false, code: code, message: bizMessage(code) }, () => {
        try { req.destroy(); } catch (_) {}
      });
    }
    if (NOT_READY_CODES.has(code)) {
      return sendJSON(res, 503, { ok: false, code: code, message: '本地服务模块还没就绪，请稍后重试或重启本地服务。' });
    }
    if (BIZ_CODES.has(code) || /^CRON_OUT_OF_RANGE:/.test(code)) {
      return sendJSON(res, 400, { ok: false, code: code, message: bizMessage(code) });
    }
    // 其余（SQLite 约束名、系统错误…）：内部细节不外泄，统一 500 + 通用文案
    log('error', 'unhandled', code);
    return sendJSON(res, 500, { ok: false, code: 'INTERNAL', message: '服务内部错误' });
  }
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
    console.error('  若确认没有实例在跑（上次异常退出留下的陈旧锁），删除该文件后重试。');
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
    console.error('  （本项目要求 Node ≥ 24；node:sqlite 于 22.5 引入、≥ 23.4 无需 --experimental-sqlite）');
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

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutting down');
    try { scheduler && scheduler.stop(); } catch (_) {}
    try { closeAll(); } catch (_) {}
    // in-flight 响应要收完再退出：close 后立刻 exit 会把正在写的响应截断；
    // keep-alive 连接可能拖住 close，3 秒还没关完就强退，避免挂死
    let exited = false;
    const done = () => {
      if (exited) return;
      exited = true;
      try { closeDb(); } catch (_) {}
      releaseLock();
      process.exit(0);
    };
    const force = setTimeout(done, 3000);
    if (force.unref) force.unref();
    try { if (server.closeIdleConnections) server.closeIdleConnections(); } catch (_) {}
    try { server.close(done); } catch (_) { done(); }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', releaseLock);

  /* 兜底：未捕获异常之后，DB 连接与定时器状态都不可信——继续跑等于「触发可能跑两遍 +
   * 之后的日志都在说谎」。按不可恢复处理：记栈 → 停调度 → 关 SSE → 关库 → 放锁 → 退出（码 1），
   * 由启动脚本 / 用户决定是否重启。日志只记栈，绝不记 token 与邮件正文。 */
  const fatal = (kind, e) => {
    log('error', kind, String((e && e.stack) || e));
    try { scheduler && scheduler.stop(); } catch (_) {}
    try { closeAll(); } catch (_) {}
    try { closeDb(); } catch (_) {}
    releaseLock();
    process.exit(1);
  };
  process.on('uncaughtException', e => fatal('uncaughtException', e));
  // 未处理的 Promise 拒绝只记日志：它通常来自一个已经失败的后台任务，进程状态未必损坏；
  // 真坏到无法继续时，会在后续同步路径上以 uncaughtException 暴露出来（那时才走 fatal）。
  process.on('unhandledRejection', e => {
    log('error', 'unhandledRejection', String((e && e.message) || e));
  });
}

main();
