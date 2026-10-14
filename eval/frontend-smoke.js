#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 前端 sidecar 客户端冒烟测试（js/sidecar.js）
 *
 * 不开浏览器、不联网：用「假 fetch」模拟本地服务在 / 不在两种状态，验：
 *   - 探测失败 → 离线降级（能力位全关 + 可读原因），不影响前端其它功能；
 *   - 探测成功 → 在线，能力位按 /health 解析；
 *   - api() 自动带 Bearer token、401 抛结构化错误码；
 *   - configure() 改端口要反映到请求 URL；
 *   - Node 下没有 EventSource 时 startSSE() 不能抛错（纯前端降级友好）。
 *
 * 用法：node eval/frontend-smoke.js
 */
const path = require('path');

global.window = global;
require(path.join(__dirname, '..', 'js', 'sidecar.js'));
require(path.join(__dirname, '..', 'js', 'context.js'));
require(path.join(__dirname, '..', 'js', 'features.js'));

const S = (global.IR || {}).Sidecar;
if (!S) {
  console.error('加载失败：IR.Sidecar 缺失（js/sidecar.js 没被 require 进来？）');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}

const calls = [];
function jsonRes(status, obj) {
  return { ok: status >= 200 && status < 300, status: status, json: () => Promise.resolve(obj) };
}
function makeFetch(handler) {
  return (url, init) => {
    const req = {
      url: String(url),
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {},
      body: init && init.body,
    };
    calls.push(req);
    return Promise.resolve().then(() => handler(req));
  };
}

async function main() {
  const seen = [];
  S.on('state', s => seen.push(s.online));

  /* 1. 离线：本地服务没启动 */
  calls.length = 0;
  global.fetch = makeFetch(() => { throw new TypeError('fetch failed'); });
  const ok1 = await S.probe();
  const st1 = S.status();
  check('离线：probe() 返回 false', ok1 === false);
  check('离线：状态 = offline', st1.state === 'offline' && st1.online === false, st1.state);
  check('离线：能力位全关', st1.features.email === false && st1.features.schedule === false && st1.features.payment === false, JSON.stringify(st1.features));
  check('离线：给出可读原因（不是裸异常）', /连不上|超时/.test(st1.lastError), st1.lastError);
  check('离线：can() 一律为假', S.can('email') === false && S.can('schedule') === false);
  check('离线：探测打的是 /health', calls.length === 1 && calls[0].url.indexOf('/health') >= 0, calls[0] && calls[0].url);

  /* 2. 在线：/health 可达 */
  global.fetch = makeFetch(req => {
    if (req.url.indexOf('/health') >= 0) {
      return jsonRes(200, {
        ok: true, app: 'infinite-reading-sidecar', version: '0.3.0',
        features: { email: true, schedule: false, payment: true },
      });
    }
    return jsonRes(404, { ok: false, code: 'NOT_FOUND' });
  });
  const ok2 = await S.probe();
  const st2 = S.status();
  check('在线：probe() 返回 true', ok2 === true);
  check('在线：状态 = online', st2.online === true);
  check('在线：能力位按 /health 解析', st2.features.email === true && st2.features.schedule === false && st2.features.payment === true, JSON.stringify(st2.features));
  check('在线：版本号带出来', st2.version === '0.3.0', st2.version);
  check('在线：can() 反映后端开关（未开的仍为假）', S.can('email') === true && S.can('schedule') === false);
  check('状态变化事件按序触发 online=false → true', seen.length === 2 && seen[0] === false && seen[1] === true, JSON.stringify(seen));

  /* 3. api()：自动带 token */
  S.configure({ port: 4319, token: 'tok-abc123' });
  let captured = null;
  global.fetch = makeFetch(req => {
    if (req.url.indexOf('/api/config') >= 0) { captured = req.headers.Authorization; return jsonRes(200, { ok: true, config: {} }); }
    return jsonRes(404, {});
  });
  const cfgRes = await S.api('GET', '/api/config');
  check('api()：请求自动带 Bearer token', captured === 'Bearer tok-abc123', String(captured));
  check('api()：返回已解析的 JSON', cfgRes && cfgRes.ok === true);

  /* 4. api()：401 抛结构化错误 */
  global.fetch = makeFetch(() => jsonRes(401, { ok: false, code: 'UNAUTHORIZED', message: '缺少或错误的 token' }));
  let err = null;
  try { await S.api('GET', '/api/config'); } catch (e) { err = e; }
  check('api()：401 抛出错误并带 code', !!err && err.code === 'UNAUTHORIZED' && err.status === 401,
    err ? (err.code + '/' + err.status) : 'no error');
  check('api()：错误消息用后端原文', !!err && /token/.test(err.message), err && err.message);

  /* 5. configure()：端口生效 */
  S.configure({ port: 4499 });
  let lastUrl = '';
  global.fetch = makeFetch(req => { lastUrl = req.url; return jsonRes(200, { ok: true, version: 'x', features: {} }); });
  await S.probe();
  check('configure()：新端口反映到请求 URL', lastUrl.indexOf('127.0.0.1:4499/health') >= 0, lastUrl);
  check('configure()：非法端口被夹回默认 4319', S.configure({ port: 0 }).port === S.DEFAULT_PORT);

  /* 6. 无 EventSource 环境不崩溃 */
  check('无 EventSource 时 startSSE() 不抛错', (() => { try { S.startSSE(); return true; } catch (_) { return false; } })());

  // start()：连不上时立刻返回 false，并按退避节奏重探（不能等一个「在线复探周期」）
  global.fetch = makeFetch(() => { throw new TypeError('fetch failed'); });
  const startOk = await S.start({ port: 4319, token: 't' });
  check('start()：离线时返回 false 且状态为 offline', startOk === false && S.status().online === false);
  S.stop();

  S.stop();

  /* 7. 工具门控：调度工具只在对话 / 扮演 + 后端已开启调度时下发 */
  const Ctx = (global.IR || {}).Context;
  const namesOf = list => list.map(t => t.function.name);
  if (!Ctx) {
    check('IR.Context 可用', false);
  } else {
    const choiceNames = namesOf(Ctx.toolsForMode('choice', { schedule: true }));
    const chatOn = namesOf(Ctx.toolsForMode('chat', { schedule: true }));
    const chatOff = namesOf(Ctx.toolsForMode('chat', { schedule: false }));
    const rpOn = namesOf(Ctx.toolsForMode('rp', { schedule: true }));
    check('门控：剧情模式不追加调度工具', choiceNames.indexOf('schedule_once') < 0, choiceNames.join(','));
    check('门控：对话模式 + 调度开启 → 下发 5 个调度工具',
      chatOn.indexOf('schedule_once') >= 0 && chatOn.indexOf('cancel_trigger') >= 0, chatOn.join(','));
    check('门控：后端没开调度 → 不下发调度工具', chatOff.indexOf('schedule_once') < 0);
    check('门控：扮演模式同样可用', rpOn.indexOf('schedule_cron') >= 0);
    check('门控：原有工具一个不少',
      chatOn.indexOf('request_image') >= 0 && chatOn.indexOf('update_memory') >= 0
      && chatOff.length === choiceNames.length, chatOff.length + ' vs ' + choiceNames.length);
    check('isScheduleTool 判定正确',
      Ctx.isScheduleTool('schedule_once') === true && Ctx.isScheduleTool('request_image') === false);
    check('调度工具共 5 个', Ctx.TOOL_NAMES_SCHEDULE.length === 5, Ctx.TOOL_NAMES_SCHEDULE.join(','));
    check('工具总量仍受每轮上限约束（常量存在）', Ctx.MAX_TOOL_CALLS_PER_TURN === 2);
  }

  /* 8. 主动触达编排：去重 + 排队 + 逐条送出 */
  const F = (global.IR || {}).Features;
  if (!F) {
    check('IR.Features 可用', false);
  } else {
    const delivered = [];
    let allow = false;
    F.attach({ canDeliver: () => allow, deliver: async p => { delivered.push(p.fireId); } });
    F.accept({ fireId: 'f1', prompt: 'a' });
    check('编排：条件不满足时先排队', F.size() === 1 && delivered.length === 0, F.size() + '/' + delivered.length);
    allow = true;
    await F.drain();
    check('编排：条件满足后送出', delivered.length === 1 && F.size() === 0, delivered.length + '/' + F.size());
    F.accept({ fireId: 'f1', prompt: 'a' });
    check('编排：同一 fireId 去重（SSE 与补跑可能同时捞到）', F.size() === 0 && delivered.length === 1);
    F.accept({ fireId: 'f2', prompt: '   ' });
    check('编排：空 prompt 不入队', F.size() === 0);
    F.clear();
  }
}

main()
  .catch(e => { check('测试过程无异常', false, e && e.message); })
  .then(() => {
    const pass = results.filter(r => r.hit).length;
    for (const r of results) {
      console.log((r.hit ? '  ✔ ' : '  ✘ ') + r.name + (r.hit || !r.detail ? '' : '   → ' + r.detail));
    }
    console.log('\n前端 sidecar 客户端冒烟测试：' + pass + '/' + results.length + ' 通过');
    if (pass !== results.length) process.exitCode = 1;
  });
