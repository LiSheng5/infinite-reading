#!/usr/bin/env node
'use strict';
/*
 * eval/videoqueue-test.js —— 视频队列专有场景：与作画队列互不干扰 + video key 去重口径
 *
 * 视频是独立的异步队列（IR.PaintQueue 的第二个实例，run() 内部就是整段轮询）。
 * PaintQueue 单实例的串行推进 / 出错隔离 / anchor.dead / has/size 语义统一在
 * eval/paintqueue-test.js 覆盖（同一个实现，不在此重复）；这里只测视频侧专有的
 * 两件事（Node、不联网）：
 *   1. videoQ 跑长任务时，paintQ 照常出图（两个队列实例互不阻塞）；
 *   2. 同 key 去重：video:<sceneId>:i2v / video:<headNodeId>:t2v 已在队列里就不再入队
 *      （q.has，src/app/video.js 的 enqueueVideo 口径）；跑完后 key 释放，可再生成一段。
 *
 * 用法：node eval/videoqueue-test.js
 */
const path = require('path');

global.window = global;
const PaintQueue = require(path.join(__dirname, '..', 'src', 'core', 'paintQueue.ts')).PaintQueue;
if (!PaintQueue || !PaintQueue.create) {
  console.error('加载失败：PaintQueue.create 缺失');
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

  /* ---------- 2. 同 key 去重（video:<sceneId>:i2v / video:<headNodeId>:t2v） ---------- */
  {
    const videoQ = PaintQueue.create({});
    let runs = 0;
    const enqueueIfNew = key => {
      if (videoQ.has(key)) return null;   // 应用侧的去重口径（src/app/video.js 的 enqueueVideo）
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
