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

    // request_image 变体分流（任务书 §3.E）：chat / rp 直出（prompt 必填）、choice 仍是画师（subject）
    const toolOf = (list, name) => list.filter(t => t.function.name === name)[0];
    const imgOf = mode => toolOf(Ctx.toolsForMode(mode, { schedule: false }), 'request_image');
    const chImg = imgOf('chat'), rpImg = imgOf('rp'), chChoiceImg = imgOf('choice');
    const propsOf = t => ((t && t.function.parameters) || {}).properties || {};
    const reqOf = t => ((t && t.function.parameters) || {}).required || [];
    check('request_image：对话模式是直出变体（含 prompt 且必填）',
      !!chImg && !!propsOf(chImg).prompt && reqOf(chImg).indexOf('prompt') >= 0,
      JSON.stringify(Object.keys(propsOf(chImg))));
    check('request_image：扮演模式同为直出变体（含 prompt 且必填）',
      !!rpImg && !!propsOf(rpImg).prompt && reqOf(rpImg).indexOf('prompt') >= 0);
    check('request_image：剧情模式仍是画师变体（subject 必填）',
      !!chChoiceImg && !!propsOf(chChoiceImg).subject && reqOf(chChoiceImg).indexOf('subject') >= 0
      && !propsOf(chChoiceImg).prompt, JSON.stringify(Object.keys(propsOf(chChoiceImg))));
    check('工具名集合不变（chat / rp / choice 一致）',
      chatOff.join(',') === choiceNames.join(',') && namesOf(Ctx.toolsForMode('rp', { schedule: false })).join(',') === choiceNames.join(','),
      choiceNames.join(','));
  }

  /* 7b. 智能体（chat）工具集 / 系统提示 / stripKindMarker（任务书 §6 增补，v0.6.0） */
  if (!Ctx) {
    check('IR.Context 可用（7b）', false);
  } else {
    const namesOf2 = list => list.map(t => t.function.name);
    const all = { schedule: true, email: true, payment: true };
    const chatAll = namesOf2(Ctx.toolsForMode('chat', all));
    const rpAll = namesOf2(Ctx.toolsForMode('rp', all));
    const choiceAll = namesOf2(Ctx.toolsForMode('choice', all));
    const chatNone = namesOf2(Ctx.toolsForMode('chat', { schedule: false, email: false, payment: false }));
    check('门控：chat + email/payment 开启 → 含 email_propose / payment_propose',
      chatAll.indexOf('email_propose') >= 0 && chatAll.indexOf('payment_propose') >= 0, chatAll.join(','));
    check('门控：rp 即便传了 true 也不下发邮件 / 下单工具',
      rpAll.indexOf('email_propose') < 0 && rpAll.indexOf('payment_propose') < 0, rpAll.join(','));
    check('门控：choice 即便传了 true 也不下发邮件 / 下单工具',
      choiceAll.indexOf('email_propose') < 0 && choiceAll.indexOf('payment_propose') < 0, choiceAll.join(','));
    check('门控：chat 但标志为假 → 不含邮件 / 下单工具',
      chatNone.indexOf('email_propose') < 0 && chatNone.indexOf('payment_propose') < 0, chatNone.join(','));
    check('isScheduleTool(email_propose) === false / isProposalTool(email_propose) === true',
      Ctx.isScheduleTool('email_propose') === false && Ctx.isProposalTool('email_propose') === true
      && Ctx.isProposalTool('payment_propose') === true && Ctx.isProposalTool('request_image') === false);
    check('提案工具名固定为 email_propose / payment_propose',
      Ctx.TOOL_NAMES_PROPOSAL.join(',') === 'email_propose,payment_propose', Ctx.TOOL_NAMES_PROPOSAL.join(','));
    check('既有工具名断言继续通过（request_image / update_memory / 调度类）',
      chatAll.indexOf('request_image') >= 0 && chatAll.indexOf('update_memory') >= 0
      && chatAll.indexOf('schedule_once') >= 0 && Ctx.isScheduleTool('schedule_once') === true);

    const chatSys = Ctx.systemForMode('chat');
    const rpSys = Ctx.systemForMode('rp');
    const choiceSys = Ctx.systemForMode('choice');
    check('systemForMode(chat)：不含（做）标记说明', chatSys.indexOf('（做）') < 0, chatSys.slice(0, 40));
    check('systemForMode(chat)：是智能体系统提示（含「智能助手」）', /智能助手/.test(chatSys));
    check('systemForMode(rp)：仍含标记说明', rpSys.indexOf('（做）') >= 0 && rpSys.indexOf(Ctx.KIND_MARK_HINT_SHORT) >= 0);
    check('systemForMode(choice)：仍是剧情 JSON 契约（逐字未动）',
      choiceSys.indexOf('旁白') >= 0 && choiceSys.indexOf('场景切换') >= 0 && choiceSys.indexOf('（做）') >= 0
      && choiceSys === Ctx.systemForMode('choice', {}));

    const sm = Ctx.stripKindMarker;
    check('stripKindMarker：`[玩家行动] （说）你好` → `[玩家行动] 你好`',
      sm('[玩家行动] （说）你好') === '[玩家行动] 你好', sm('[玩家行动] （说）你好'));
    check('stripKindMarker：无标记原样不动', sm('[玩家行动] 你好') === '[玩家行动] 你好');
    check('stripKindMarker：只剥开头那一个',
      sm('[玩家行动] （做）（说）继续') === '[玩家行动] （说）继续', sm('[玩家行动] （做）（说）继续'));
    check('stripKindMarker：（导演）出现在正文中间不动',
      sm('[玩家行动] 走到门口（导演）推开门') === '[玩家行动] 走到门口（导演）推开门'
      && sm('（导演）开头但没有外层前缀') === '（导演）开头但没有外层前缀');
    check('stripKindMarker：外层 [玩家行动] 前缀保持不变',
      sm('[设定]\\nxx\\n\\n[玩家行动] （做）动手') === '[设定]\\nxx\\n\\n[玩家行动] 动手',
      sm('[设定]\\nxx\\n\\n[玩家行动] （做）动手'));
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
