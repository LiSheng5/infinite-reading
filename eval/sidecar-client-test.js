#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 本地服务客户端重连链单测（src/core/sidecar.ts，Node 离线、不联网）
 *
 * frontend-smoke 已覆盖探测 / api / configure / 无 EventSource 降级；这里只盯**重连链**：
 * SSE 断线后的重连与 /health 复探必须共用同一条退避链——计时器只有 probeTimer 一个，
 * stop() 一定能清掉。旧实现是两条并行的 setTimeout：重连那个从不保存引用，stop() 清不到，
 * 重启后迟到的旧计时器还会补一刀探测；重连那次探测一旦失败也原地断链（只赌一次）。
 *
 * 覆盖（全部用假 fetch + 假 EventSource，等真实计时器走完，单跑约 20 秒）：
 *   1. 静态：重连函数不得再自己 setTimeout（全文件只许 abort 定时器 + 唯一链两处），
 *      且必须把等待交给 scheduleNextProbe
 *   2. SSE 掉线 → 按退避自动重连（合并后行为不回退）
 *   3. stop() 清掉重连计时器：重启后不再有迟到的旧探测补刀
 *   4. 重连探测失败 → 顺着探测退避继续，服务恢复后 SSE 照常重建（旧行为是断链）
 *   5. 连上（onopen）后重连步进归零：下次掉线仍然是最快的 1.5s 档
 *
 * 用法：node eval/sidecar-client-test.js
 */
const path = require('path');
const fs = require('fs');
const H = require('./_harness.js');

const ROOT = path.join(__dirname, '..');
const Sidecar = require(path.join(ROOT, 'src', 'core', 'sidecar.ts')).Sidecar;
if (!Sidecar || typeof Sidecar.start !== 'function') {
  console.error('加载失败：Sidecar 导出缺失');
  process.exit(1);
}

const PORT = 4321;   // 假 fetch 不会真发请求，端口只是让 URL 好认

/* ---------------- 替身 ---------------- */

// 假 fetch：/health 恒在线、ticket 恒发；failHealthNext 次数内让 /health 返回 500
function makeFetch() {
  const calls = [];
  let failHealthLeft = 0;
  const fn = (url) => {
    const u = String(url);
    calls.push(u.slice(u.indexOf(':', 6)) );   // 去掉 http 前缀，留 :4321/health 这样好认的路径
    const res = (obj) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj) });
    const bad = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    if (u.indexOf('/health') >= 0) {
      if (failHealthLeft > 0) { failHealthLeft -= 1; return bad(); }
      return res({ version: 'test', features: { email: true, schedule: true, payment: true } });
    }
    if (u.indexOf('/api/events/ticket') >= 0) return res({ ticket: 't' + calls.length });
    return res({});
  };
  fn.calls = calls;
  fn.failHealthNext = n => { failHealthLeft = n; };
  fn.healthCount = () => calls.filter(c => c.indexOf('/health') >= 0).length;
  fn.ticketCount = () => calls.filter(c => c.indexOf('/ticket') >= 0).length;
  return fn;
}

// 假 EventSource：模块会往实例上挂 onopen / onerror / addEventListener，测试手动驱动事件
class FakeES {
  constructor(url) { FakeES.born.push(this); this.url = url; this.closed = false; }
  addEventListener() {}
  close() { this.closed = true; }
}
FakeES.born = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

/* ---------------- 用例 ---------------- */

async function main() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'sidecar.ts'), 'utf8');

  /* ---------------- 1. 静态：一条重连链 ---------------- */
  {
    const setTimeoutCount = src.split('setTimeout(').length - 1;
    H.check('静态：全文件只有两处 setTimeout（abort 定时器 + 唯一重连链）', setTimeoutCount === 2,
      '实际 ' + setTimeoutCount + ' 处（出现第三条并行链就是旧病复发）');
    const start = src.indexOf('function scheduleReconnect(');
    const body = src.slice(start, src.indexOf('\n  function ', start));
    H.check('静态：scheduleReconnect 把等待交给 scheduleNextProbe（不再自己排计时器）',
      body.indexOf('scheduleNextProbe(') >= 0, body);
    H.check('静态：scheduleReconnect 里没有裸 setTimeout',
      body.indexOf('setTimeout(') < 0);
    H.check('静态：stop() 清 probeTimer（重连链唯一计时器的收口）',
      src.indexOf('function stop()') > 0 && src.indexOf('clearTimeout(probeTimer)') > 0);
  }

  // 后面全是真计时器用例：装上替身，结束恢复
  const savedFetch = global.fetch;
  const savedES = global.EventSource;
  global.fetch = makeFetch();
  global.EventSource = FakeES;
  try {
    const fetch = global.fetch;

    /* ---------------- 2. SSE 掉线 → 自动重连 ---------------- */
    {
      FakeES.born.length = 0;
      const ok = await Sidecar.start({ port: PORT, token: 'k' });
      H.check('启动：探测在线', ok === true && Sidecar.isOnline());
      H.check('启动：拿到 SSE 连接', await waitFor(() => FakeES.born.length >= 1, 3000),
        'born=' + FakeES.born.length);
      FakeES.born[0].onerror();   // 模拟连接被掐
      H.check('重连：掉线后按退避自动重连（1.5s 档）',
        await waitFor(() => FakeES.born.length >= 2, 4000), 'born=' + FakeES.born.length);
    }

    /* ---------------- 3. stop() 清掉重连计时器 ---------------- */
    {
      Sidecar.stop();
      const base = FakeES.born.length;
      await Sidecar.start({ port: PORT, token: 'k' });
      H.check('重启：拿到 SSE 连接', await waitFor(() => FakeES.born.length >= base + 1, 3000),
        'born=' + FakeES.born.length);
      // 让重连退避处于最快档（1.5s），掉线 → 重连计时器排上 → 立刻 stop + start。
      // 旧实例的 handler 会被 stopSSE 置 null，这里必须等「最新」那个且 handler 已挂好。
      const es = FakeES.born[FakeES.born.length - 1];
      await waitFor(() => typeof es.onopen === 'function', 2000);
      es.onopen();
      es.onerror();
      const h0 = fetch.healthCount(), t0 = fetch.ticketCount(), b0 = FakeES.born.length;
      Sidecar.stop();
      await Sidecar.start({ port: PORT, token: 'k' });
      await sleep(2500);   // 旧实现：迟到的重连计时器在 ~1.5s 时补一刀 /health
      const dh = fetch.healthCount() - h0, dt = fetch.ticketCount() - t0, db = FakeES.born.length - b0;
      H.check('stop：重启后 2.5s 内只有新 start 自己的那次探测（没有旧计时器补刀）',
        dh === 1, 'health 增量=' + dh + '（期望 1；出现 2 = stop 没清掉重连计时器）');
      H.check('stop：重启后只重建一条 SSE', db === 1 && dt === 1,
        'ES 增量=' + db + ' ticket 增量=' + dt);
    }

    /* ---------------- 4. 重连探测失败 → 沿探测退避继续 ---------------- */
    {
      Sidecar.stop();
      const base = FakeES.born.length;
      await Sidecar.start({ port: PORT, token: 'k' });
      H.check('重启：拿到 SSE 连接', await waitFor(() => FakeES.born.length >= base + 1, 3000),
        'born=' + FakeES.born.length);
      const es = FakeES.born[FakeES.born.length - 1];
      await waitFor(() => typeof es.onopen === 'function', 2000);
      es.onopen();
      fetch.failHealthNext(1);    // 让下一次（也就是重连那次）探测失败：服务在 SSE 断的瞬间又挂了
      es.onerror();
      const h0 = fetch.healthCount(), b0 = FakeES.born.length;
      // 新实现：重连探测失败 → 探测退避（3s）→ 再探 → 恢复 → SSE 重建，全程 ~4.5s
      H.check('恢复：重连探测失败后沿退避继续重试（不是原地断链）',
        await waitFor(() => fetch.healthCount() - h0 >= 2, 6000),
        'health 增量=' + (fetch.healthCount() - h0));
      H.check('恢复：服务回来后 SSE 重建',
        await waitFor(() => FakeES.born.length - b0 >= 1, 5000),
        'ES 增量=' + (FakeES.born.length - b0));

      /* ---------------- 5. 连上后重连步进归零 ---------------- */
      {
        const es2 = FakeES.born[FakeES.born.length - 1];
        await waitFor(() => typeof es2.onopen === 'function', 2000);
        es2.onopen();             // 真正连上 → 步进归零
        es2.onerror();
        H.check('归零：连上过一次后，下次掉线仍走最快的 1.5s 档',
          await waitFor(() => FakeES.born.length - b0 >= 2, 2400),
          'ES 增量=' + (FakeES.born.length - b0) + '（若退避没归零，这一档是 3s，赶不上）');
      }
    }
  } finally {
    Sidecar.stop();
    global.fetch = savedFetch;
    global.EventSource = savedES;
  }
}

H.run('本地服务客户端重连链单测', main);
