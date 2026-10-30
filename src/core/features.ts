/*
 * 无限阅读 · 功能编排小内核（本地服务的三个功能共用）
 *
 * 只做一件事：把「侧车说该触发了」变成「走和真实用户消息完全相同的回合流程」，并且：
 *   - 去重：同一条触发（fireId）只会被送一次（SSE 与「打开页面补跑」可能同时捞到同一条）；
 *   - 排队：agent 正忙 / 没打开故事 / 当前是剧情模式 → 先攒着，条件满足再送；
 *   - 撤回：clear() 把队列与去重记忆一起清——撤掉的触达相当于没来过，下次补跑还能收；
 *   - 条件判断交给 app.js 注册的 canDeliver（只有它知道 busy 与 story.mode）。
 *
 * app.js 拥有唯一的回合链路（sendPlayerAction），所以这里不自己调模型，
 * 只负责「什么时候把消息递过去」。
 */

/* ↑ 阶段 2 搬迁自 src/core/features.ts（IIFE → ES module，函数体逐字未动）。
 * 阶段 6：模块间依赖改为静态 import（全局 IR 兼容层已删除）。 */

  const SEEN_MAX = 500;
  let hooks: any = { canDeliver: function () { return false; }, deliver: async function () {} };
  const queue = [];
  const seen = new Set();
  const seenOrder = [];
  let draining = false;

  function attach(h) {
    if (h && typeof h === 'object') hooks = Object.assign({}, hooks, h);
  }

  function remember(id) {
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > SEEN_MAX) seen.delete(seenOrder.shift());
    return true;
  }

  // 收下一条主动触达；返回是否真的入队（重复 / 空内容会返回 false）
  function accept(payload) {
    if (!payload || !String(payload.prompt || '').trim()) return false;
    if (!remember(payload.fireId)) return false;
    queue.push(payload);
    drain();
    return true;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        if (!hooks.canDeliver()) return;          // 条件不满足：留在队里，等 app.js 再叫
        const item = queue[0];
        try { await hooks.deliver(item); } catch (_) {}
        queue.shift();
      }
    } finally {
      draining = false;
    }
  }

  function size() { return queue.length; }
  function resetSeen() { seen.clear(); seenOrder.length = 0; }

  // 撤回待送：队列与去重记忆一起清——被清掉的触达等于「还没送过」，条件满足时还能再收。
  // 只清队列会把同一个 fireId 永久挡在门外：它在侧车的待送列表里仍在（没 ack），
  // 下一次「打开页面补跑」照样捞回来，然后被 seen 静默丢弃。已送成功的那些早在侧车 ack 掉了，
  // 忘掉 seen 不会让它们重放。
  function clear() {
    queue.length = 0;
    resetSeen();
  }

  const Features = {
    attach: attach,
    accept: accept,
    drain: drain,
    size: size,
    clear: clear,
    resetSeen: resetSeen,
  };
  export { Features };