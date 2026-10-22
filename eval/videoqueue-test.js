#!/usr/bin/env node
'use strict';
/*
 * eval/videoqueue-test.js —— 视频队列与作画队列互不干扰（任务书 v0.12.0 §7/§12）
 *
 * 视频是独立的异步队列（IR.PaintQueue 的第二个实例，run() 内部就是整段轮询），
 * 严格串行且绝不能堵出图。这里用两具真实队列实例模拟 paintQ / videoQ（Node、不联网）：
 *   1. videoQ 跑长任务时，paintQ 照常出图（两队列互不阻塞）；
 *   2. videoQ 自身严格串行（前一条没跑完，后一条不开始）；
 *   3. 同 key 去重：video:<sceneId>:i2v / video:<headNodeId>:t2v 已在队列里就不再入队（q.has）；
 *   4. 单条出错不拖垮后面的（错误经返回值带出）。
 *
 * 用法：node eval/videoqueue-test.js
 */
const path = require('path');

global.window = global;
require(path.join(__dirname, '..', 'js', 'paintQueue.js'));

const PaintQueue = (global.IR || {}).PaintQueue;
if (!PaintQueue || !PaintQueue.create) {
  console.error('加载失败：IR.PaintQueue.create 缺失');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  /* ---------- 1. videoQ 运行中，paintQ 照常出图 ---------- */
  {
    const paintQ = PaintQueue.create({});
    const videoQ = PaintQueue.create({});
    const log = [];

    const videoTask = videoQ.enqueue({
      key: 'video:sc1:i2v',
      run: async () => {
        log.push('video-start');
        await sleep(50);          // 模拟整段轮询（1~3 分钟的任务）
        log.push('video-end');
        return 'video';
      },
    });
    await sleep(5);
    const paintTask = paintQ.enqueue({
      key: 'manual:node1',
      run: async () => {
        log.push('paint-start');
        await sleep(5);
        log.push('paint-end');
        return 'paint';
      },
    });
    const [v, p] = await Promise.all([videoTask, paintTask]);
    check('videoQ 运行中 paintQ 照常出图', p.ok && p.value === 'paint', JSON.stringify(p));
    check('paint 出图先于视频结束（互不阻塞）',
      log.indexOf('paint-end') >= 0 && log.indexOf('paint-end') < log.indexOf('video-end'), log.join(' → '));
    check('videoQ 任务照常完成', v.ok && v.value === 'video', JSON.stringify(v));
  }

  /* ---------- 2. videoQ 严格串行 ---------- */
  {
    const videoQ = PaintQueue.create({});
    const log = [];
    const mk = (name, ms) => videoQ.enqueue({
      key: 'video:' + name,
      run: async () => {
        log.push(name + ':start');
        await sleep(ms);
        log.push(name + ':end');
        return name;
      },
    });
    const p1 = mk('a', 30);
    const p2 = mk('b', 5);
    const rs = await Promise.all([p1, p2]);
    check('videoQ 严格串行：后一条等前一条跑完',
      log.join(',') === 'a:start,a:end,b:start,b:end', log.join(','));
    check('两条都成功', rs.every(r => r.ok), JSON.stringify(rs));
    check('运行期间 size() 计数正确', videoQ.size() === 0, videoQ.size());
  }

  /* ---------- 3. 同 key 去重（video:<sceneId>:i2v / video:<headNodeId>:t2v） ---------- */
  {
    const videoQ = PaintQueue.create({});
    let runs = 0;
    const enqueueIfNew = key => {
      if (videoQ.has(key)) return null;   // 应用侧的去重口径（js/app/video.js 的 enqueueVideo）
      return videoQ.enqueue({ key: key, run: async () => { runs++; await sleep(10); return key; } });
    };

    const first = enqueueIfNew('video:scA:i2v');
    const dup = enqueueIfNew('video:scA:i2v');      // 同一张图重复点 🎬
    const other = enqueueIfNew('video:nodeB:t2v');  // 不同 head 的文生任务不受影响
    check('同 key 重复入队被拦截', first !== null && dup === null);
    check('不同 key 照常入队', other !== null);
    await Promise.all([first, other]);
    check('去重后同一 key 只跑一次', runs === 2, 'runs=' + runs);

    // 跑完后 key 释放，可以再生成一段
    const again = enqueueIfNew('video:scA:i2v');
    check('完成后再点可以重新入队', again !== null);
    await again;
  }

  /* ---------- 4. 单条出错不拖垮后面的 ---------- */
  {
    const videoQ = PaintQueue.create({});
    const bad = videoQ.enqueue({ key: 'video:bad:t2v', run: () => Promise.reject(new Error('内容敏感')) });
    const good = videoQ.enqueue({ key: 'video:good:t2v', run: async () => 'ok' });
    const [b, g] = await Promise.all([bad, good]);
    check('失败任务：ok=false 且带 error', !b.ok && b.error && /内容敏感/.test(b.error.message), JSON.stringify({ ok: b.ok, msg: b.error && b.error.message }));
    check('后续任务不受影响', g.ok && g.value === 'ok', JSON.stringify(g));
  }

  /* ---------- 输出 ---------- */
  let pass = 0;
  for (const r of results) {
    if (r.hit) { pass += 1; console.log('  ✔ ' + r.name); }
    else console.error('  ✘ ' + r.name + (r.detail ? '  → ' + r.detail : ''));
  }
  console.log(`\n视频队列单测：${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exit(1);
})().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
