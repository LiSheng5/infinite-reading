#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 本地服务（sidecar）冒烟测试
 *
 * 自己把 sidecar 当子进程拉起来（临时数据目录 + 随机端口，不碰真实 sidecar/data），
 * 然后走真实 HTTP 验一遍：/health 免鉴权、token 鉴权、配置读写与夹取、触发器 API、
 * 到点入队、pending 队列、SSE 实时推送、一键暂停、404。
 *
 * 不联网、不依赖真实 API Key；调度用「一次性触发器 + 短延迟」触发，几秒内跑完。
 * 用法：node eval/sidecar-smoke.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const spawn = require('child_process').spawn;

const { check, run } = require('./_harness.js');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-sidecar-smoke-'));
const PORT = 4400 + Math.floor(Math.random() * 500);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let sseReq = null;

function reqOn(port, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request({ host: '127.0.0.1', port: port, path: p, method: method, headers: headers }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, json: json, raw: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function req(method, p, body, token) {
  return reqOn(PORT, method, p, body, token);
}

async function waitHealth(timeoutMs, port) {
  const p = port || PORT;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await reqOn(p, 'GET', '/health');
      if (r.status === 200 && r.json) return r.json;
    } catch (_) {}
    await sleep(150);
  }
  return null;
}

function spawnServer(dataDir, port) {
  return spawn(process.execPath, [path.join(ROOT, 'sidecar', 'server.mjs')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { IR_SIDECAR_DATA_DIR: dataDir, IR_SIDECAR_PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/* 等子进程退出；超时返回 'TIMEOUT' 并杀掉，避免测试挂死 */
async function waitExit(child, timeoutMs) {
  let timer = null;
  const exited = new Promise(resolve => {
    child.on('exit', code => resolve(code));
    child.on('error', () => resolve(-1));
  });
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs); });
  const r = await Promise.race([exited, timeout]);
  if (timer) clearTimeout(timer);
  if (r === 'TIMEOUT') { try { child.kill(); } catch (_) {} }
  return r;
}

function openSse(ticket) {
  return new Promise((resolve, reject) => {
    let done = false;
    sseReq = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/events?ticket=' + encodeURIComponent(ticket) },
      res => {
        if (res.statusCode !== 200) { reject(new Error('SSE HTTP ' + res.statusCode)); return; }
        res.on('data', c => {
          if (!done && c.toString().indexOf('event: trigger.fire') >= 0) { done = true; resolve(true); }
        });
      }
    );
    sseReq.on('error', reject);
  });
}

/* 锁文件：锁 = 单进程的唯一判据，TOCTOU 会让定时触发跑两遍，这里单独先验一遍。
 *  1. 空锁文件 + 刚创建 = 另一个实例 open 后还没 write → 必须按「正在启动」拒绝，不能当陈旧锁抢走；
 *  2. 内容里的 pid 已死 = 上次异常退出的遗留 → 允许多新实例接管。
 * 两种情况各拉一个真实子进程（独立数据目录 + 独立端口），验完即杀。 */
async function checkLockRules() {
  const dir = path.join(TMP, 'lock-probe');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');

  fs.writeFileSync(lock, '');
  const empty = spawnServer(dir, PORT + 1);
  let emptyErr = '';
  empty.stdout.on('data', () => {});
  empty.stderr.on('data', c => { emptyErr += c.toString(); });
  const emptyCode = await waitExit(empty, 10000);
  // 断言「主动拒绝」的文案：只看退出码会把启动崩溃（如未定义函数）误判成通过
  check('D23：空锁文件（刚创建，可能还没写内容）→ 拒绝启动（而非崩溃）',
    emptyCode === 1 && emptyErr.indexOf('已有另一个 sidecar 实例在运行') !== -1,
    '退出码 ' + emptyCode + ' / ' + emptyErr.replace(/\s+/g, ' ').slice(0, 160));
  check('D23：拒绝启动时不删别人的锁文件', fs.existsSync(lock), '锁文件被删了');

  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: 0, nonce: 'stale' }));
  const takeover = spawnServer(dir, PORT + 1);
  let takeoverErr = '';
  takeover.stdout.on('data', () => {});
  takeover.stderr.on('data', c => { takeoverErr += c.toString(); });
  const health = await waitHealth(12000, PORT + 1);
  check('D23：陈旧锁（pid 已死）→ 允许启动并接管', !!health,
    health ? '' : ('未能启动 ' + takeoverErr.slice(0, 300)));
  try { takeover.kill(); } catch (_) {}
  await waitExit(takeover, 5000);
  return !!health;
}

async function main() {
  await checkLockRules();

  const child = spawnServer(TMP, PORT);
  let childErr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', c => { childErr += c.toString(); });

  try {
    const health = await waitHealth(12000);
    check('服务可启动且 /health 可达', !!health, childErr.slice(0, 300));
    if (!health) return;

    check('/health 免鉴权', health.ok === true);
    check('/health 只回布尔能力位（默认全关）',
      health.features && health.features.email === false && health.features.schedule === false && health.features.payment === false,
      JSON.stringify(health.features));

    const noAuth = await req('GET', '/api/config');
    check('无 token 访问受保护接口 → 401', noAuth.status === 401, noAuth.status);

    const token = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8')).token;
    check('首启自动生成 token（≥32 字符）', typeof token === 'string' && token.length >= 32, token && token.length);

    const badAuth = await req('GET', '/api/config', null, 'wrong-token');
    check('错误 token → 401', badAuth.status === 401, badAuth.status);

    const cfg = await req('GET', '/api/config', null, token);
    check('带 token 可读配置', cfg.status === 200 && cfg.json.ok === true);
    check('配置视图不泄露 token', !('token' in (cfg.json.config || {})),
      JSON.stringify(Object.keys(cfg.json.config || {})));
    check('邮件密钥只回布尔', cfg.json.config.email.hasResendApiKey === false);

    // token 口径：手改成非十六进制口令后必须照用，不能再被静默换成新随机值（前端会永久 401）
    const cfgPath = path.join(TMP, 'config.json');
    const rawCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const myToken = 'my-own-token-0123';
    fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, rawCfg, { token: myToken }), null, 2));
    await sleep(30);
    const mineOk = await req('GET', '/api/config', null, myToken);
    const oldDenied = await req('GET', '/api/config', null, token);
    check('D25：自定义 token（非 32 位十六进制）照用，旧 token 失效',
      mineOk.status === 200 && oldDenied.status === 401, mineOk.status + ' / ' + oldDenied.status);
    const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).token;
    check('D25：自定义 token 原样留在 config.json（没被改写）', persisted === myToken, persisted);

    fs.writeFileSync(cfgPath, JSON.stringify(rawCfg, null, 2));
    await sleep(30);
    const restored = await req('GET', '/api/config', null, token);
    check('D25：改回原 token 后立即生效（配置缓存按 mtime / size 失效）', restored.status === 200, restored.status);

    const put = await req('PUT', '/api/config', { email: { enabled: true, dailyLimit: 3 } }, token);
    check('PUT 配置生效', put.status === 200 && put.json.config.email.enabled === true && put.json.config.email.dailyLimit === 3);
    check('PUT 不能改 token / port', !put.json.config.token && put.json.config.port === PORT);

    // 收件箱：inbox 是 async，路由必须 await —— 漏掉时恒 400 + {}
    const inbox = await req('GET', '/api/email/inbox?limit=5', null, token);
    check('收件箱：mock 渠道返回 200 + messages 数组',
      inbox.status === 200 && inbox.json && inbox.json.ok === true && Array.isArray(inbox.json.messages),
      inbox.status + ' ' + String(inbox.raw).slice(0, 120));

    const clamp = await req('PUT', '/api/config', { payment: { perTx: -50, monthly: 'abc' } }, token);
    check('非法额度被夹回保守值 0',
      clamp.json.config.payment.perTx === 0 && clamp.json.config.payment.monthly === 0,
      JSON.stringify(clamp.json.config.payment));

    const h2 = await req('GET', '/health');
    check('/health 反映能力开关变化', h2.json.features.email === true);

    await req('PUT', '/api/config', { schedule: { enabled: true, paused: false } }, token);

    const mdl = await req('POST', '/api/triggers',
      { name: 'model-one', type: 'interval', spec: { everyMs: 60000 }, prompt: 'p', reason: 'r' }, token);
    check('模型新建触发器 = pending_confirm（需用户确认）', mdl.json.trigger.status === 'pending_confirm', JSON.stringify(mdl.json.trigger));

    const once = await req('POST', '/api/triggers',
      { name: 'user-once', type: 'once', spec: { at: Date.now() + 900 }, source: 'user', prompt: 'p', reason: 'r' }, token);
    check('用户新建触发器 = active', once.json.trigger.status === 'active', JSON.stringify(once.json.trigger));

    // 同名覆盖：模型借同名 upsert 改写用户已确认的安排 → 400，原值不动
    const overwrite = await req('POST', '/api/triggers',
      { name: 'user-once', type: 'once', spec: { at: Date.now() + 900 }, source: 'model', prompt: '被改写的话', reason: 'r' }, token);
    check('模型同名覆盖已确认触发器 → 400 TRIGGER_LOCKED',
      overwrite.status === 400 && !!overwrite.json && overwrite.json.code === 'TRIGGER_LOCKED',
      overwrite.status + ' ' + String(overwrite.raw).slice(0, 120));

    // SSE 鉴权：token 不再走查询参数；先用 Bearer 换短时效一次性 ticket
    const noTicket = await req('GET', '/api/events');
    check('SSE：无 ticket → 401', noTicket.status === 401, noTicket.status);
    const tokAsTicket = await req('GET', '/api/events?token=' + encodeURIComponent(token));
    check('SSE：token 不再走查询参数（?token= → 401）', tokAsTicket.status === 401, tokAsTicket.status);
    const badTicket = await req('GET', '/api/events?ticket=nope');
    check('SSE：无效 ticket → 401（一次性，用掉即删）', badTicket.status === 401, badTicket.status);
    const tk = await req('POST', '/api/events/ticket', null, token);
    check('SSE：POST /api/events/ticket 换取一次性凭据', tk.status === 200 && !!tk.json.ticket, JSON.stringify(tk.json));

    const ssePromise = openSse(tk.json.ticket).catch(e => 'ERR:' + e.message);
    await sleep(250);
    const sseResult = await Promise.race([ssePromise, sleep(6000).then(() => 'TIMEOUT')]);
    check('SSE 收到 trigger.fire 实时推送', sseResult === true, String(sseResult));

    const pend = await req('GET', '/api/pending', null, token);
    check('到点进入 pending 队列', pend.json.pending.length === 1, JSON.stringify(pend.json.pending));
    check('pending 带触发原因', pend.json.pending.length === 1 && pend.json.pending[0].reason === 'due',
      JSON.stringify(pend.json.pending));

    if (pend.json.pending.length) {
      const ack = await req('POST', '/api/pending/' + pend.json.pending[0].id + '/ack', null, token);
      check('ack 待办', ack.json.acked === true);
      const pend2 = await req('GET', '/api/pending', null, token);
      check('ack 后队列清空', pend2.json.pending.length === 0);
    }

    const list = await req('GET', '/api/triggers', null, token);
    check('触发器列表可读（2 个）', list.json.triggers.length === 2, list.json.triggers.length);
    check('一次性触发器触发后自动停用',
      list.json.triggers.filter(t => t.name === 'user-once')[0].enabled === false);

    const cancel = await req('POST', '/api/triggers/' + mdl.json.trigger.id + '/cancel', null, token);
    check('取消触发器', cancel.json.cancelled === true);

    const pause = await req('POST', '/api/schedule/pause', { paused: true }, token);
    check('一键暂停', pause.json.paused === true);

    // 错误映射：业务码走白名单 400 + 结构化 code；内部细节不外泄
    const badTrigger = await req('POST', '/api/triggers', { name: 'bad-type', type: 'nope', spec: {} }, token);
    check('业务错误码按白名单映射 400（BAD_TRIGGER_TYPE）',
      badTrigger.status === 400 && badTrigger.json && badTrigger.json.code === 'BAD_TRIGGER_TYPE', JSON.stringify(badTrigger.json));
    // limit 非法值夹取：不再把 NaN 带进 SQL LIMIT 触发绑定异常
    const auditBad = await req('GET', '/api/email/audit?limit=abc', null, token);
    check('审计 ?limit=abc 被夹取（返回列表而非绑定异常）',
      auditBad.status === 200 && Array.isArray(auditBad.json.audit), auditBad.status + ' ' + auditBad.raw.slice(0, 120));

    // 金额入口校验：缺金额必须是 400 BAD_AMOUNT，而不是写坏台账后 500
    const badAmount = await req('POST', '/api/payment/intents', { merchant: 'M', category: 'C' }, token);
    check('支付：缺 amountCents → 400 BAD_AMOUNT（不是 500）',
      badAmount.status === 400 && badAmount.json && badAmount.json.code === 'BAD_AMOUNT',
      badAmount.status + ' ' + String(badAmount.raw).slice(0, 120));

    // body 上限：超限要先回 413 + 可读文案再断连接；先 destroy 的话客户端只会拿到 ECONNRESET
    const big = await req('POST', '/api/triggers',
      { name: 'big-body', type: 'interval', spec: { everyMs: 60000 }, prompt: 'x'.repeat(256 * 1024) }, token)
      .catch(e => ({ status: 0, json: null, raw: 'ERR:' + (e && e.message) }));
    check('D44：body 超限 → 413 BODY_TOO_LARGE（不是 ECONNRESET）',
      big.status === 413 && !!big.json && big.json.code === 'BODY_TOO_LARGE',
      big.status + ' ' + String(big.raw).slice(0, 120));

    const notFound = await req('GET', '/api/nope', null, token);
    check('未知接口 → 404', notFound.status === 404, notFound.status);

    // 放在最后：下面会换掉 token，后面不能再用首启 token 发请求
    fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, JSON.parse(fs.readFileSync(cfgPath, 'utf8')), { token: '' }), null, 2));
    await sleep(50);
    const afterEmpty = await req('GET', '/api/config', null, token);
    const freshToken = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).token;
    check('D25：token 置空 → 生成新值并落盘（旧 token 失效）',
      afterEmpty.status === 401 && typeof freshToken === 'string' && freshToken.length >= 32 && freshToken !== token,
      afterEmpty.status + ' / ' + (freshToken || '').length);
    check('D25：生成新 token 有日志提示（不静默改 token）',
      childErr.indexOf('已生成新 token') !== -1, childErr.replace(/\s+/g, ' ').slice(-160));

    // 释放锁只认自己的 nonce：把锁改成别人的内容，进程退出时不能顺手删掉
    try { if (sseReq) { sseReq.destroy(); sseReq = null; } } catch (_) {}
    const liveLock = path.join(TMP, '.lock');
    fs.writeFileSync(liveLock, JSON.stringify({ pid: process.pid, at: 0, nonce: 'someone-else' }));
    try { child.kill(); } catch (_) {}
    await waitExit(child, 6000);
    check('D23：退出时只删自己写的锁（外来的锁不被误删）', fs.existsSync(liveLock), '锁文件被删了');
  } finally {
    try { if (sseReq) sseReq.destroy(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
}

run('sidecar 冒烟测试', main);
