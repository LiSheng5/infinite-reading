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

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-sidecar-smoke-'));
const PORT = 4400 + Math.floor(Math.random() * 500);

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let sseReq = null;

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method, headers: headers }, res => {
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

async function waitHealth(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await req('GET', '/health');
      if (r.status === 200 && r.json) return r.json;
    } catch (_) {}
    await sleep(150);
  }
  return null;
}

function openSse(token) {
  return new Promise((resolve, reject) => {
    let done = false;
    sseReq = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/events?token=' + encodeURIComponent(token) },
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

async function main() {
  const child = spawn(process.execPath, [path.join(ROOT, 'sidecar', 'server.mjs')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { IR_SIDECAR_DATA_DIR: TMP, IR_SIDECAR_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

    const put = await req('PUT', '/api/config', { email: { enabled: true, dailyLimit: 3 } }, token);
    check('PUT 配置生效', put.status === 200 && put.json.config.email.enabled === true && put.json.config.email.dailyLimit === 3);
    check('PUT 不能改 token / port', !put.json.config.token && put.json.config.port === PORT);

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

    const ssePromise = openSse(token).catch(e => 'ERR:' + e.message);
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

    const notFound = await req('GET', '/api/nope', null, token);
    check('未知接口 → 404', notFound.status === 404, notFound.status);
  } finally {
    try { if (sseReq) sseReq.destroy(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
}

main()
  .catch(e => { check('测试过程无异常', false, e && e.message); })
  .then(() => {
    const pass = results.filter(r => r.hit).length;
    for (const r of results) {
      console.log((r.hit ? '  ✔ ' : '  ✘ ') + r.name + (r.hit || !r.detail ? '' : '   → ' + r.detail));
    }
    console.log('\nsidecar 冒烟测试：' + pass + '/' + results.length + ' 通过');
    if (pass !== results.length) process.exitCode = 1;
  });
