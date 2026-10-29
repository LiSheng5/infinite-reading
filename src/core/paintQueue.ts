/*
 * 无限阅读 · 作画串行队列（生图异步化，v0.5.1）
 *
 * 把「时机出图 / 工具出图 / 手动作画 / 工作台重画」收敛到一条严格串行的队列上，
 * 画师构思也在队列里跑——同一时刻只有一件事在构思 / 出图，不与队列外的活并发。
 *
 * 职责边界（任务书 §3.B）：
 *  - 纯逻辑：不碰 DOM、不碰 story、不联网；Node 里 require 就能测
 *  - 零依赖、零构建：IIFE 挂到全局 PaintQueue
 *
 * API：
 *   const q = PaintQueue.create({ onChange(size) {} });
 *   q.enqueue({ key, anchor, run })   // 同步返回 Promise<{ ok, value, error, skipped, dead }>
 *   q.has(key)                        // 同 key 是否已排队 / 进行中（去重由调用方用它拦截）
 *   q.size()                          // 排队 + 进行中的任务数
 *
 * 语义：
 *  - 严格串行（先进先出）；单个任务出错不拖垮后面的，错误经返回值带出（不 reject）
 *  - anchor && anchor.dead 时**不调用 run**，直接 skipped: true（不花额度）
 *  - run 进行中置 dead → run 照常跑完，返回值带 dead: true，供调用方写回前丢弃
 *  - enqueue 本身同步返回、不阻塞调用方；key 只用于 has()，队列本身不去重
 */

/* ↑ 阶段 2 搬迁自 src/core/paintQueue.ts（IIFE → ES module，函数体逐字未动）。
 * 阶段 6：模块间依赖改为静态 import（全局 IR 兼容层已删除）。 */

  function create(opts) {
    const onChange = opts && typeof opts.onChange === 'function' ? opts.onChange : null;
    const pending = [];       // 排队中的任务（FIFO）
    const keys = new Set();   // 排队 + 进行中的 key（has 用）
    let running = false;
    let active = 0;           // 排队 + 进行中的任务数（size 用）

    function notify() {
      if (!onChange) return;
      try { onChange(active); } catch (_) { /* 显示层异常不拦队列 */ }
    }

    function size() { return active; }

    function has(key) {
      if (key == null) return false;
      return keys.has(key);
    }

    function settle(item, result) {
      if (item.key != null) keys.delete(item.key);
      active -= 1;
      running = false;
      notify();
      item.resolve(result);
      pump();
    }

    function runOne(item) {
      const deadNow = () => !!(item.anchor && item.anchor.dead);
      // 开跑前核一次锚点（§3.A.4）：回合已失败 / 被停止 → 不花画师和生图额度
      if (deadNow()) {
        settle(item, { ok: false, value: null, error: null, skipped: true, dead: true });
        return;
      }
      Promise.resolve()
        .then(() => item.run())
        .then(
          value => settle(item, { ok: true, value: value, error: null, skipped: false, dead: deadNow() }),
          error => settle(item, { ok: false, value: null, error: error, skipped: false, dead: deadNow() })
        );
    }

    function pump() {
      if (running) return;
      const item = pending.shift();
      if (!item) return;
      running = true;
      // run 放进微任务：enqueue 同步返回后调用方立刻能往下走（§3.B）
      Promise.resolve().then(() => runOne(item));
    }

    function enqueue(task) {
      task = task || {};
      const item = {
        key: task.key == null ? null : task.key,
        anchor: task.anchor || null,
        run: typeof task.run === 'function' ? task.run : function () { return null; },
        resolve: null,
      };
      const p = new Promise(res => { item.resolve = res; });
      if (item.key != null) keys.add(item.key);
      active += 1;
      notify();
      pending.push(item);
      pump();
      return p;
    }

    return { enqueue: enqueue, has: has, size: size };
  }

  const PaintQueue = { create: create };
  export { PaintQueue };