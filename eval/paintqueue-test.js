#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 作画队列单测（js/paintQueue.js，不联网、不落盘、不依赖真实定时器）
 *
 * 背景（任务书 §3.B）：时机出图 / 工具出图 / 手动 / 重画全走同一条严格串行的队列，
 * 画师构思也在队列里。队列是生图异步化（§3.A）的地基，正确性全在「串行推进 +
 * 锚点丢弃 + 计数可见」上——用可控的 promise 覆盖边界，不靠 sleep。
 *
 * 覆盖：
 *   1. 严格串行：三个异步任务按入队顺序开始 / 结束
 *   2. enqueue 同步返回，调用方不被阻塞
 *   3. 单个任务抛错不影响后面的任务，错误经返回值带出（不 reject）
 *   4. anchor.dead 在入队后、开跑前置位 → 不调用 run，skipped: true
 *   5. anchor.dead 在 run 进行中置位 → run 照常跑完，返回值带 dead: true
 *   6. has(key) / size() 的变化与 onChange 回调次数 / 数值
 *   7. 同 key 重复入队由调用方用 has 拦截（队列本身不去重的约定）
 *
 * 用法：node eval/paintqueue-test.js
 */
const path = require('path');

global.window = global;
const PQ = require(path.join(__dirname, '..', 'src', 'core', 'paintQueue.ts')).PaintQueue;
if (!PQ || typeof PQ.create !== 'function') {
  console.error('加载失败：PaintQueue 导出缺失');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}

// 可控的 promise：任务体自己决定什么时候结束，不依赖真实定时器
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise: promise, resolve: resolve, reject: reject };
}

// 把微任务冲干净（队列的推进全是微任务，不用 setTimeout）
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function main() {
  /* ---------------- 1. 严格串行：按入队顺序开始 / 结束 ---------------- */
  {
    const q = PQ.create();
    const events = [];
    const d = { a: deferred(), b: deferred(), c: deferred() };
    const job = name => () => {
      events.push('start:' + name);
      return d[name].promise.then(v => { events.push('end:' + name); return v; });
    };
    const pa = q.enqueue({ run: job('a') });
    const pb = q.enqueue({ run: job('b') });
    const pc = q.enqueue({ run: job('c') });
    await flush();
    check('串行：入队三个后只有第一个开跑', events.join(',') === 'start:a', events.join(','));
    d.a.resolve('va');
    await flush();
    check('串行：第一个结束后才开跑第二个',
      events.join(',') === 'start:a,end:a,start:b', events.join(','));
    d.b.resolve('vb');
    await flush();
    check('串行：继续按入队顺序推进到第三个',
      events.join(',') === 'start:a,end:a,start:b,end:b,start:c', events.join(','));
    d.c.resolve('vc');
    await flush();
    check('串行：三个任务按入队顺序开始 / 结束',
      events.join(',') === 'start:a,end:a,start:b,end:b,start:c,end:c', events.join(','));
    const rs = await Promise.all([pa, pb, pc]);
    check('串行：返回值按入队顺序各归各的任务',
      rs.every(r => r.ok === true && r.skipped === false)
      && rs[0].value === 'va' && rs[1].value === 'vb' && rs[2].value === 'vc', JSON.stringify(rs.map(r => r.value)));
  }

  /* ---------------- 2. enqueue 同步返回，调用方不被阻塞 ---------------- */
  {
    const q = PQ.create();
    const d = deferred();
    let continued = false;
    const p = q.enqueue({ run: () => d.promise });
    continued = true;   // enqueue 没有 await：任务未结束，调用方已继续往下走
    check('enqueue 同步返回、不阻塞调用方',
      continued === true && typeof p.then === 'function' && q.size() === 1,
      'size=' + q.size());
    d.resolve('x');
    const r = await p;
    check('enqueue 返回值：任务结束后带出结果', r.ok === true && r.value === 'x', JSON.stringify(r));
  }

  /* ---------------- 3. 单个任务出错不影响后面的任务 ---------------- */
  {
    const q = PQ.create();
    const d2 = deferred();
    const p1 = q.enqueue({ run: () => Promise.reject(new Error('boom')) });
    const p2 = q.enqueue({ run: () => d2.promise });
    const r1 = await p1;
    check('出错：错误经返回值带出（不 reject 调用方）',
      r1.ok === false && !!r1.error && r1.error.message === 'boom' && r1.skipped === false,
      r1.error && r1.error.message);
    d2.resolve('ok2');
    const r2 = await p2;
    check('出错：单个任务失败不拖垮后面的任务', r2.ok === true && r2.value === 'ok2', JSON.stringify(r2));
    // 同步 throw 同样只算本任务失败
    const p3 = q.enqueue({ run: () => { throw new Error('sync-boom'); } });
    const r3 = await p3;
    check('出错：run 同步抛错同样被接住', r3.ok === false && r3.error && r3.error.message === 'sync-boom');
  }

  /* ---------------- 4. anchor.dead 入队后、开跑前置位 → skipped ---------------- */
  {
    const q = PQ.create();
    const anchor = { nodeId: null, dead: false };
    const hold = deferred();
    let ran = false;
    const p1 = q.enqueue({ run: () => hold.promise });
    const p2 = q.enqueue({ anchor: anchor, run: () => { ran = true; return 'never'; } });
    anchor.dead = true;   // 入队后、开跑前
    hold.resolve('h');
    const r2 = await p2;
    const r1 = await p1;
    check('锚点 dead：开跑前置位 → 不调用 run（不花额度）', ran === false);
    check('锚点 dead：开跑前置位 → skipped: true',
      r2.skipped === true && r2.ok === false && r2.dead === true && r2.value === null, JSON.stringify({ ok: r2.ok, skipped: r2.skipped, dead: r2.dead }));
    check('锚点 dead：被跳过不影响队列里前后任务', r1.ok === true && r1.value === 'h', JSON.stringify(r1));
  }

  /* ---------------- 5. anchor.dead 在 run 进行中置位 → 跑完并带 dead ---------------- */
  {
    const q = PQ.create();
    const anchor = { nodeId: 'n1', dead: false };
    const d = deferred();
    const p = q.enqueue({
      anchor: anchor,
      run: () => { anchor.dead = true; return d.promise; },   // 生成途中回合被停止
    });
    d.resolve('scene');
    const r = await p;
    check('锚点 dead：run 进行中置位 → run 照常跑完', r.ok === true && r.value === 'scene', JSON.stringify(r));
    check('锚点 dead：返回值带 dead: true，供调用方写回前丢弃', r.dead === true);
  }

  /* ---------------- 6. has(key) / size() 与 onChange ---------------- */
  {
    const changes = [];
    const q = PQ.create({ onChange: n => changes.push(n) });
    const da = deferred(), db = deferred();
    const pa = q.enqueue({ key: 'k1', run: () => da.promise });
    check('has/size：入队后立刻可见', q.size() === 1 && q.has('k1') === true && q.has('nope') === false, 'size=' + q.size());
    const pb = q.enqueue({ key: 'k2', run: () => db.promise });
    check('size：排队 + 进行中一起计数', q.size() === 2, 'size=' + q.size());
    da.resolve('x');
    await pa;
    check('has/size：第一个完成后（key 释放、计数回落）',
      q.has('k1') === false && q.has('k2') === true && q.size() === 1, 'size=' + q.size());
    db.resolve('y');
    await pb;
    check('has/size：队列清空后全部归零', q.size() === 0 && q.has('k2') === false);
    check('onChange：回调次数与数值正确（入队 1,2 → 完成 1,0）',
      changes.join(',') === '1,2,1,0', changes.join(','));
  }

  /* ---------------- 7. 同 key 去重是调用方的约定（队列本身不去重） ---------------- */
  {
    const q = PQ.create();
    let runs = 0;
    const da = deferred(), db = deferred();
    const pa = q.enqueue({ key: 'same', run: () => { runs += 1; return da.promise; } });
    // 约定：调用方用 has(key) 拦重复（manualGenerate / 重画按钮都这么写）
    let blocked = false;
    if (q.has('same')) blocked = true;
    else q.enqueue({ key: 'same', run: () => { runs += 1; return null; } });
    await flush();
    check('同 key：调用方用 has 拦截 → 只入队一次', blocked === true && runs === 1 && q.size() === 1, 'runs=' + runs + ' size=' + q.size());
    // 不守约定直接重复入队：队列不去重，两个都会跑
    const pb = q.enqueue({ key: 'same', run: () => { runs += 1; return db.promise; } });
    da.resolve(1);
    await pa;
    db.resolve(2);
    await pb;
    check('同 key：队列本身不去重，重复入队都会执行', runs === 2 && q.size() === 0, 'runs=' + runs);
    check('同 key：重复入队后 has 语义不变（任一未结即为真）', q.has('same') === false);
  }
}

main()
  .catch(e => { check('测试过程无异常', false, e && e.message); })
  .then(() => {
    const pass = results.filter(r => r.hit).length;
    for (const r of results) {
      console.log((r.hit ? '  ✔ ' : '  ✘ ') + r.name + (r.hit || !r.detail ? '' : '   → ' + r.detail));
    }
    console.log('\n作画队列单测：' + pass + '/' + results.length + ' 通过');
    if (pass !== results.length) process.exitCode = 1;
  });
