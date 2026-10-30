#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 主动消息编排单测（src/core/features.ts，Node 离线、不联网）
 *
 * 这层把「侧车说该触发了」变成「走和真实用户消息完全相同的回合流程」，只做三件事：
 * 去重（同一 fireId 只送一次）、排队（忙 / 没开故事 / 剧情模式先攒着）、投递（交给 app 注册的 deliver）。
 * 另有一个撤回入口 clear()：撤掉的触达必须还能再收——只清队列会把它永久拉黑，
 * 而它在侧车那边并没有 ack，下一次「打开页面补跑」仍会捞回来、然后被去重静默丢弃。
 *
 * 覆盖：
 *   1. accept 的入口判据（空 payload / 空 prompt 不收，同步返回布尔）
 *   2. 去重：同 fireId 只入队一次；缺 fireId 不去重（侧车每条触发都带 id）
 *   3. 排队：canDeliver 为假时攒着、不调用 deliver；条件满足后按入队顺序一次送完
 *   4. deliver 抛错不卡队列（后面的照常送，队列最终清空）
 *   5. clear()：队列与去重记忆一起清 → 同一 fireId 可再次入队（撤回 ≠ 拉黑）
 *   6. resetSeen()：只忘去重记忆、不动待送队列
 *   7. 去重记忆有界：超过上限后最旧的 id 被挤出，不会随会话无界增长
 *
 * 用法：node eval/features-test.js
 */
const path = require('path');
const H = require('./_harness.js');

const Features = require(path.join(__dirname, '..', 'src', 'core', 'features.ts')).Features;
if (!Features || typeof Features.accept !== 'function') {
  console.error('加载失败：Features 导出缺失');
  process.exit(1);
}

// 把微任务冲干净：drain 的推进全是微任务（accept 内部那次 drain 不返回给调用方）
async function flush(n) {
  const times = n || 20;
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// 用例隔离：默认「条件不满足」把消息攒在队里；隔离不依赖待测行为（clear 是否忘去重由第 5 节单独验）
function fresh() {
  Features.attach({ canDeliver: () => false, deliver: async () => {} });
  Features.clear();
  Features.resetSeen();
}

async function main() {
  /* ---------------- 1. 入口判据 ---------------- */
  fresh();
  H.check('accept：空 payload 不收', Features.accept(null) === false && Features.accept() === false);
  H.check('accept：prompt 空 / 全空白不收',
    Features.accept({ fireId: 'blank-1', prompt: '' }) === false
    && Features.accept({ fireId: 'blank-2', prompt: '   ' }) === false
    && Features.size() === 0, 'size=' + Features.size());
  H.check('accept：正常触发同步返回 true 并入队',
    Features.accept({ fireId: 'ok-1', prompt: '该喝水了' }) === true && Features.size() === 1,
    'size=' + Features.size());

  /* ---------------- 2. 去重（同一 fireId 只送一次） ---------------- */
  fresh();
  Features.accept({ fireId: 'dup', prompt: '第一条' });
  const second = Features.accept({ fireId: 'dup', prompt: '改写过的第二条' });
  H.check('去重：同 fireId 第二次返回 false、队列不增长', second === false && Features.size() === 1,
    'ret=' + second + ' size=' + Features.size());
  Features.accept({ fireId: 'other', prompt: '另一条' });
  H.check('去重：不同 fireId 各自入队', Features.size() === 2, 'size=' + Features.size());
  Features.accept({ prompt: '没有 id 的第一条' });
  Features.accept({ prompt: '没有 id 的第二条' });
  H.check('去重：缺 fireId 时不去重（无 id 可记，两条都收）', Features.size() === 4,
    'size=' + Features.size());

  /* ---------------- 3. 排队与投递顺序 ---------------- */
  fresh();
  const delivered = [];
  Features.attach({
    canDeliver: () => false,
    deliver: async p => { delivered.push(p.fireId); },
  });
  Features.accept({ fireId: 'q1', prompt: '一' });
  Features.accept({ fireId: 'q2', prompt: '二' });
  Features.accept({ fireId: 'q3', prompt: '三' });
  await Features.drain();
  H.check('排队：条件不满足时一条都不送（留在队里）',
    delivered.length === 0 && Features.size() === 3,
    'sent=' + delivered.length + ' size=' + Features.size());
  Features.attach({
    canDeliver: () => true,
    deliver: async p => { delivered.push(p.fireId); },
  });
  await Features.drain();
  H.check('投递：条件满足后按入队顺序一次送完，队列清空',
    delivered.join(',') === 'q1,q2,q3' && Features.size() === 0,
    'sent=' + delivered.join(',') + ' size=' + Features.size());

  /* ---------------- 4. deliver 抛错不卡队列 ---------------- */
  fresh();
  const sent = [];
  Features.attach({
    canDeliver: () => true,
    deliver: async p => {
      sent.push(p.fireId);
      if (p.fireId === 'boom') throw new Error('投递失败');
    },
  });
  Features.accept({ fireId: 'boom', prompt: '会失败的那条' });
  Features.accept({ fireId: 'after', prompt: '后面那条' });
  await flush();
  H.check('投递失败：异常被接住、队列继续推进到后面的条目',
    sent.join(',') === 'boom,after' && Features.size() === 0,
    'sent=' + sent.join(',') + ' size=' + Features.size());

  /* ---------------- 5. clear() 撤回待送：队列 + 去重记忆一起清 ---------------- */
  {
    fresh();
    Features.accept({ fireId: 'pending-1', prompt: '待送' });
    const dupBefore = Features.accept({ fireId: 'pending-1', prompt: '待送' });
    const sizeBefore = Features.size();
    Features.clear();
    const sizeAfter = Features.size();
    const again = Features.accept({ fireId: 'pending-1', prompt: '待送' });
    H.check('撤回：clear() 清空待送队列', sizeBefore === 1 && sizeAfter === 0,
      'before=' + sizeBefore + ' after=' + sizeAfter);
    H.check('撤回：同一 fireId 还能再入队（去重记忆一并忘掉）',
      dupBefore === false && again === true && Features.size() === 1,
      'dup=' + dupBefore + ' again=' + again + ' size=' + Features.size());
  }
  {
    // 已投递过的 id 同理：送成功的那条已在侧车 ack，忘掉 seen 不会真的重放
    fresh();
    Features.attach({ canDeliver: () => true, deliver: async () => {} });
    Features.accept({ fireId: 'sent-1', prompt: '已送过' });
    await flush();
    const dupBefore = Features.accept({ fireId: 'sent-1', prompt: '已送过' });
    Features.clear();
    const again = Features.accept({ fireId: 'sent-1', prompt: '已送过' });
    await flush();
    H.check('撤回：已投递过的 fireId 在 clear() 之后同样可再收',
      dupBefore === false && again === true, 'dup=' + dupBefore + ' again=' + again);
  }

  /* ---------------- 6. resetSeen() 只忘去重、不动队列 ---------------- */
  fresh();
  Features.accept({ fireId: 'r1', prompt: '一' });
  Features.resetSeen();
  const req = Features.accept({ fireId: 'r1', prompt: '一' });
  H.check('resetSeen：队列保持原样、同一 fireId 可再次入队',
    req === true && Features.size() === 2, 'ret=' + req + ' size=' + Features.size());

  /* ---------------- 7. 去重记忆有界 ---------------- */
  fresh();
  let accepted = 0;
  for (let i = 1; i <= 501; i++) if (Features.accept({ fireId: 'f' + i, prompt: '第 ' + i + ' 条' })) accepted += 1;
  H.check('去重记忆：501 条全部入队（上限只作用于记忆，不丢消息）',
    accepted === 501 && Features.size() === 501, 'accepted=' + accepted + ' size=' + Features.size());
  H.check('去重记忆有界：最早的 id 被挤出后还能再收',
    Features.accept({ fireId: 'f1', prompt: '回来的第一条' }) === true);
  H.check('去重记忆有界：最近的一条仍在记忆里（重复照常拦下）',
    Features.accept({ fireId: 'f501', prompt: '第 501 条' }) === false);
}

H.run('主动消息编排单测', main);
