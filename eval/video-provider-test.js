#!/usr/bin/env node
'use strict';
/*
 * eval/video-provider-test.js —— 生视频适配器单测（src/core/providers.ts 的 VideoProviders['minimax-video']）
 *
 * 不开浏览器、不联网：用「假 fetch」验 MiniMax V2 的请求形状与状态机：
 *   - t2v / i2v 的 body 组装：ratio 规则（文生必填非 adaptive；图生一律 adaptive）、
 *     first_frame 角色、duration 以整数下发；时长 / 分辨率 / 比例以面板控件为唯一源，
 *     extraParams 只补其它键、同名这三键被控件覆盖；
 *   - generate：queued → running → succeeded；hooks.onTaskId / onStatus；
 *   - failed / cancelled / expired 直接抛（带 task.error 原文）；
 *   - 超时（VIDEO_TOTAL_TIMEOUT_MS）；提交阶段 TypeError（CORS 提示、不重试）；
 *   - 轮询连续 3 次网络错误才判失败（单次容忍）；
 *   - ：单次请求的 fetchWithTimeout（挂死 → TimeoutError、外部取消 → AbortError）与
 *     「本地取消能切断在途轮询」；提交 / 轮询都带 signal；
 *   - test()：只读列任务探测，绝不提交生成任务。
 *
 * 用法：node eval/video-provider-test.js
 */
const path = require('path');

global.window = global;
const P = require(path.join(__dirname, '..', 'src', 'core', 'providers.ts'));
const V = P.VideoProviders;
const fetchWithTimeout = P.fetchWithTimeout;
const mm = V && V['minimax-video'];
if (!mm) {
  console.error('加载失败：VideoProviders["minimax-video"] 缺失');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}

function jsonRes(status, obj) {
  return {
    ok: status >= 200 && status < 300, status: status, statusText: 'S' + status,
    json: () => Promise.resolve(obj),
    text: () => Promise.resolve(JSON.stringify(obj)),
  };
}

const calls = [];
function installFetch(handler) {
  calls.length = 0;
  global.fetch = (url, init) => {
    const req = {
      url: String(url),
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {},
      body: init && init.body ? JSON.parse(init.body) : null,
      signal: (init && init.signal) || null,
    };
    calls.push(req);
    return Promise.resolve(handler(req));
  };
}

// 假 fetch 的「被 abort」：按浏览器口径 reject 一个 name=AbortError 的错误
function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

// 用例守卫：真挂住（不该挂的 await 没返回）就直接失败，别让整轮静默退出码 0
function guard(p, ms) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('用例超时：' + ms + 'ms 内没有返回')), ms)),
  ]);
}

const cfg = {
  provider: 'minimax-video',
  baseUrl: 'https://api.minimax.io/',
  apiKey: 'sk-test',
  model: 'MiniMax-H3',
};

(async () => {
  /* ---------- t2v body 组装 ---------- */
  installFetch(() => jsonRes(200, { task_id: 't-1' }));
  const task = await mm.submit(cfg, { prompt: 'a paper boat in rain', mode: 't2v' });
  let req = calls[0];
  check('t2v：提交到 /v2/video_generation', req.url === 'https://api.minimax.io/v2/video_generation', req.url);
  check('t2v：带 Bearer Key', req.headers.Authorization === 'Bearer sk-test', req.headers.Authorization);
  check('t2v：返回 taskId', task.taskId === 't-1', JSON.stringify(task));
  check('t2v：提示词在 content[0].text', req.body.content && req.body.content[0].type === 'text'
    && req.body.content[0].text === 'a paper boat in rain', JSON.stringify(req.body.content));
  check('t2v：默认 ratio = 16:9（必填且非 adaptive）', req.body.ratio === '16:9', req.body.ratio);
  check('t2v：默认 duration=5 / resolution=768P，duration 为整数',
    req.body.duration === 5 && typeof req.body.duration === 'number' && req.body.resolution === '768P',
    req.body.duration + '/' + typeof req.body.duration + '/' + req.body.resolution);
  check('t2v：提交请求带 signal（可超时 / 可取消）', !!req.signal, String(req.signal));

  /* ---------- extraParams 补其它键；时长 / 分辨率 / 比例以面板控件为唯一源 ---------- */
  installFetch(() => jsonRes(200, { task_id: 't-2' }));
  await mm.submit(Object.assign({}, cfg, { extraParams: 'duration=7, resolution=2K, ratio=9:16, watermark=false' }),
    { prompt: 'x', mode: 't2v' });
  req = calls[0];
  check('extraParams：同名 duration / resolution / ratio 被控件覆盖（默认 5/768P/16:9）', req.body.duration === 5
    && req.body.resolution === '768P' && req.body.ratio === '16:9',
    req.body.duration + '/' + req.body.resolution + '/' + req.body.ratio);
  check('extraParams：其它键原样并入', req.body.watermark === false, JSON.stringify(req.body.watermark));

  /* ---------- 独立控件（cfg.duration / resolution / ratio）是这三项的唯一源 ---------- */
  installFetch(() => jsonRes(200, { task_id: 't-2b' }));
  await mm.submit(Object.assign({}, cfg, { duration: 10, resolution: '1080P', ratio: '4:3' }),
    { prompt: 'x', mode: 't2v' });
  req = calls[0];
  check('独立控件：cfg.duration/resolution/ratio 进请求体', req.body.duration === 10
    && req.body.resolution === '1080P' && req.body.ratio === '4:3',
    req.body.duration + '/' + req.body.resolution + '/' + req.body.ratio);

  installFetch(() => jsonRes(200, { task_id: 't-2c' }));
  await mm.submit(Object.assign({}, cfg, { duration: 10, extraParams: 'duration=6' }),
    { prompt: 'x', mode: 't2v' });
  check('同名时以独立控件为准（改下拉框必然生效）', calls[0].body.duration === 10, calls[0].body.duration);

  installFetch(() => jsonRes(200, { task_id: 't-2d' }));
  await mm.submit(Object.assign({}, cfg, { duration: 3, ratio: '9:16' }),
    { prompt: 'x', mode: 'i2v', image: 'data:image/png;base64,AAA' });
  check('独立控件：duration 夹回 4~15；i2v 比例仍强制 adaptive',
    calls[0].body.duration === 4 && calls[0].body.ratio === 'adaptive',
    calls[0].body.duration + '/' + calls[0].body.ratio);

  installFetch(() => jsonRes(200, { task_id: 't-3' }));
  await mm.submit(Object.assign({}, cfg, { duration: '5' }), { prompt: 'x', mode: 't2v' });
  check('duration 必须以整数下发（"5" 夹取后仍是数字 5）',
    calls[0].body.duration === 5 && typeof calls[0].body.duration === 'number',
    calls[0].body.duration + '/' + typeof calls[0].body.duration);

  installFetch(() => jsonRes(200, { task_id: 't-4' }));
  await mm.submit(Object.assign({}, cfg, { ratio: 'adaptive' }), { prompt: 'x', mode: 't2v' });
  check('t2v：控件把 ratio 写成 adaptive 也强制回 16:9', calls[0].body.ratio === '16:9', calls[0].body.ratio);

  /* ---------- i2v body 组装 ---------- */
  installFetch(() => jsonRes(200, { task_id: 't-5' }));
  await mm.submit(Object.assign({}, cfg, { ratio: '9:16' }),
    { prompt: 'make it move', image: 'data:image/png;base64,AAA', mode: 'i2v' });
  req = calls[0];
  const imgItem = (req.body.content || []).find(c => c.type === 'image_url');
  check('i2v：带 first_frame 图片项', !!imgItem && imgItem.role === 'first_frame'
    && imgItem.image_url.url === 'data:image/png;base64,AAA', JSON.stringify(imgItem));
  check('i2v：一律 ratio:adaptive（忽略用户参数里的 ratio）', req.body.ratio === 'adaptive', req.body.ratio);

  /* ---------- generate：queued → running → succeeded + hooks ---------- */
  {
    const seq = [
      { task: { status: 'queued' } },
      { task: { status: 'running' } },
      { task: { status: 'succeeded', content: { url: 'https://cdn/v.mp4' } } },
    ];
    let i = 0;
    installFetch(req2 => (req2.method === 'POST'
      ? jsonRes(200, { task_id: 'tg-1' })
      : jsonRes(200, seq[Math.min(i++, seq.length - 1)])));
    const got = { taskId: '', statuses: [] };
    const r = await mm.generate(cfg, { prompt: 'x', mode: 't2v' }, {
      onTaskId: id => { got.taskId = id; },
      onStatus: s => { got.statuses.push(s); },
      pollMs: 1, totalTimeoutMs: 5000,
    });
    check('generate：成功返回 url', r.url === 'https://cdn/v.mp4', JSON.stringify(r));
    check('generate：hooks.onTaskId 提交成功立刻回调', got.taskId === 'tg-1', got.taskId);
    check('generate：onStatus 记录 queued → running', got.statuses.indexOf('queued') >= 0
      && got.statuses.indexOf('running') >= 0, got.statuses.join(','));
  }

  /* ---------- failed / cancelled / expired：直接抛，带 task.error 原文 ---------- */
  for (const [st, err] of [
    ['failed', { message: '内容敏感', code: 1026 }],
    ['cancelled', { message: '用户取消' }],
    ['expired', {}],
  ]) {
    installFetch(req2 => (req2.method === 'POST'
      ? jsonRes(200, { task_id: 'tg-2' })
      : jsonRes(200, { task: { status: st, error: err } })));
    let threw = '';
    try { await mm.generate(cfg, { prompt: 'x', mode: 't2v' }, { pollMs: 1, totalTimeoutMs: 5000 }); }
    catch (e) { threw = e.message; }
    const expectMsg = err.message || ('任务' + st);
    check(st + '：抛出并带 task.error 原文', threw.indexOf(expectMsg) >= 0, threw);
    if (err.code != null) check(st + '：错误里带 code', threw.indexOf(String(err.code)) >= 0, threw);
  }

  /* ---------- 超时 ---------- */
  {
    installFetch(req2 => (req2.method === 'POST'
      ? jsonRes(200, { task_id: 'tg-3' })
      : jsonRes(200, { task: { status: 'running' } })));
    let threw = '';
    try { await mm.generate(cfg, { prompt: 'x', mode: 't2v' }, { pollMs: 1, totalTimeoutMs: 5 }); }
    catch (e) { threw = e.message; }
    check('超时：抛出并提示 task_id', /还没出结果/.test(threw), threw);
  }

  /* ---------- 提交阶段 TypeError → CORS 提示，不重试 ---------- */
  {
    let n = 0;
    calls.length = 0;
    global.fetch = () => { n++; return Promise.reject(new TypeError('Failed to fetch')); };
    let threw = '';
    try { await mm.submit(cfg, { prompt: 'x', mode: 't2v' }); }
    catch (e) { threw = e.message; }
    check('提交 TypeError：提示 CORS / 不允许浏览器直连', /CORS|不允许浏览器直连/.test(threw), threw);
    check('提交 TypeError：不重试（只发一次）', n === 1, 'fetch 次数 ' + n);
  }

  /* ---------- 轮询连续 3 次网络错误才判失败（单次容忍） ---------- */
  {
    let n = 0;
    calls.length = 0;
    global.fetch = (url, init) => {
      if (((init && init.method) || 'GET') === 'POST') return Promise.resolve(jsonRes(200, { task_id: 'tg-4' }));
      n++;
      if (n <= 2) return Promise.reject(new TypeError('Failed to fetch'));   // 前两次网络错：容忍
      return Promise.resolve(jsonRes(200, { task: { status: 'succeeded', content: { url: 'https://cdn/ok.mp4' } } }));
    };
    const r = await mm.generate(cfg, { prompt: 'x', mode: 't2v' }, { pollMs: 1, totalTimeoutMs: 5000 });
    check('轮询单次网络错误容忍（2 次瞬断后仍成功）', r.url === 'https://cdn/ok.mp4', JSON.stringify(r));

    n = 0;
    global.fetch = (url, init) => {
      if (((init && init.method) || 'GET') === 'POST') return Promise.resolve(jsonRes(200, { task_id: 'tg-5' }));
      n++;
      return Promise.reject(new TypeError('Failed to fetch'));
    };
    let threw = '';
    try { await mm.generate(cfg, { prompt: 'x', mode: 't2v' }, { pollMs: 1, totalTimeoutMs: 5000 }); }
    catch (e) { threw = e.message; }
    check('轮询连续 3 次失败才判失败', n === 3 && !!threw, '轮询次数 ' + n + ' / ' + threw);
  }

  /* ---------- ：单次请求超时（fetchWithTimeout）与外部取消 ---------- */
  {
    // 假 fetch 永远不「自发」返回，只服从 abort（与浏览器 fetch 一致）：
    // 超时由 fetchWithTimeout 的计时器 abort 触发，再按 timedOut 转成 TimeoutError
    global.fetch = (url, init) => new Promise((_, reject) => {
      const s = init && init.signal;
      if (!s) return;                                  // 没信号就永远挂着
      if (s.aborted) { reject(abortError()); return; }
      s.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    let err = null;
    try { await guard(fetchWithTimeout('https://api.minimax.io/slow', {}, 20), 2000); } catch (e) { err = e; }
    check('超时：挂死请求按传入的 ms 抛 TimeoutError（带 timeoutMs）',
      !!err && err.name === 'TimeoutError' && err.timeoutMs === 20,
      err ? err.name + ' / ' + err.message : '没有抛错');

    // 外部取消：立刻抛 AbortError（上层据此静默收尾），不会被误判成超时
    global.fetch = (url, init) => new Promise((_, reject) => {
      const s = init && init.signal;
      if (!s) return;                                  // 没信号就永远挂着（本用例必须带信号）
      if (s.aborted) { reject(abortError()); return; }
      s.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    const ctrl = new AbortController();
    const p = fetchWithTimeout('https://api.minimax.io/cancel', { signal: ctrl.signal }, 5000);
    ctrl.abort();
    let err2 = null;
    try { await guard(p, 2000); } catch (e) { err2 = e; }
    check('取消：外部 signal abort → 抛 AbortError（不误判为超时）',
      !!err2 && err2.name === 'AbortError', err2 && err2.name);
  }

  /* ---------- ：本地取消能切断在途轮询（不必等一次往返） ---------- */
  {
    const ctrl = new AbortController();
    let polls = 0;
    global.fetch = (url, init) => {
      if (((init && init.method) || 'GET') === 'POST') return Promise.resolve(jsonRes(200, { task_id: 'tg-6' }));
      polls += 1;
      return new Promise((_, reject) => {
        const s = init && init.signal;
        if (!s) return;                                // 没信号就永远挂着：正好验证「取消能立刻收尾」
        s.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    };
    const p = mm.generate(cfg, { prompt: 'x', mode: 't2v' }, { pollMs: 1, totalTimeoutMs: 60000, signal: ctrl.signal });
    await new Promise(r => setTimeout(r, 10));
    ctrl.abort();
    let name = '', msg = '';
    try { await guard(p, 2000); } catch (e) { name = e.name; msg = e.message; }
    check('generate：本地取消切断在途轮询 → AbortError（不按网络错重试）',
      name === 'AbortError' && polls === 1, name + ' / 轮询 ' + polls + ' 次 / ' + msg);
  }

  /* ---------- test()：只读列任务，不提交生成 ---------- */
  {
    installFetch(req2 => jsonRes(200, { data: [], task_list: [] }));
    const r = await mm.test(cfg);
    check('test：走只读列任务探测', calls.length === 1
      && calls[0].method === 'GET'
      && calls[0].url.indexOf('/v2/query/video_generation?page_num=1&page_size=1') > 0, calls[0] && calls[0].url);
    check('test：不产生生成任务（没有 POST）', calls.every(c => c.method !== 'POST'));
    check('test：文案写明不花钱', /不花钱/.test(r.message), r.message);
    check('test：成功 level=ok', r.level === 'ok', r.level);

    installFetch(() => jsonRes(401, { message: 'bad key' }));
    const r2 = await mm.test(cfg);
    check('test：Key 被拒 → fail', r2.level === 'fail', r2.level + ' / ' + r2.message);

    const before3 = calls.length;
    const r3 = await mm.test(Object.assign({}, cfg, { baseUrl: '' }));
    check('test：缺地址 → fail 且不联网', r3.level === 'fail' && calls.length === before3, r3.message);
  }

  /* ---------- 配置缺失 ---------- */
  let threw = '';
  try { await mm.submit(Object.assign({}, cfg, { baseUrl: '' }), { prompt: 'x' }); }
  catch (e) { threw = e.message; }
  check('缺 Base URL：给人话错误', /生视频接口地址/.test(threw), threw);

  threw = '';
  try { await mm.submit(Object.assign({}, cfg, { apiKey: '' }), { prompt: 'x' }); }
  catch (e) { threw = e.message; }
  check('缺 Key：给人话错误', /API Key/.test(threw), threw);

  threw = '';
  try { await mm.submit(cfg, { prompt: '' }); }
  catch (e) { threw = e.message; }
  check('空提示词：直接拒绝', /提示词/.test(threw), threw);

  /* ---------- 输出 ---------- */
  let pass = 0;
  for (const r of results) {
    if (r.hit) { pass += 1; console.log('  ✔ ' + r.name); }
    else console.error('  ✘ ' + r.name + (r.detail ? '  → ' + r.detail : ''));
  }
  console.log(`\n生视频适配器单测：${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exit(1);
})().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
