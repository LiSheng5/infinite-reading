/*
 * 无限阅读 · 作画串行队列（生图异步化，v0.5.1）
 *
 * 把「时机出图 / 工具出图 / 手动作画 / 工作台重画」收敛到一条严格串行的队列上，
 * 画师构思也在队列里跑——同一时刻只有一件事在构思 / 出图，不与队列外的活并发。
 *
 * 职责边界：
 *  - 纯逻辑：不碰 DOM、不碰 story、不联网；Node 里 require 就能测
 *  - 零依赖、零构建：IIFE 挂到全局 PaintQueue
 *
 * API：
 *   const q = PaintQueue.create({ onChange(size) {}, timeoutMs });
 *   q.enqueue({ key, anchor, run, timeoutMs })   // 同步返回 Promise<{ ok, value, error, skipped, dead, timeout, cancelled }>
 *   q.has(key)                        // 同 key 是否已排队 / 进行中（去重由调用方用它拦截）
 *   q.size()                          // 排队 + 进行中的任务数
 *   q.cancel(key)                     // 取消：排队中的直接摘掉（不调用 run）、进行中的 abort + 立刻收尾；
 *                                     // key 为空 = 取消进行中的那个。返回是否真的取消了
 *
 * 语义：
 *  - 严格串行（先进先出）；单个任务出错不拖垮后面的，错误经返回值带出（不 reject）
 *  - anchor && anchor.dead 时**不调用 run**，直接 skipped: true（不花额度）
 *  - run 进行中置 dead → run 照常跑完，返回值带 dead: true，供调用方写回前丢弃
 *  - run(signal)：队列给每个任务一个 AbortSignal，cancel / 超时会 abort 它——
 *    任务体把 signal 传给 fetch 就能真的掐断在途请求；任务体不用它，队列也照常推进
 *  - timeoutMs（队列默认 + 单任务覆盖，显式 0 = 该任务不设超时）：到点先 abort、再按失败收尾并放行下一个。
 *    这是「run 永不 resolve → 堵死队列 + has(key) 永真」的兜底：key 在收尾里一定被删。
 *    注意超时只放弃本地等待，云端该花的额度已经花了
 *  - 收尾幂等：超时 / 取消先收尾后，run 迟到的回包一律丢弃（不重复计数、不重复 notify）
 *  - enqueue 本身同步返回、不阻塞调用方；key 只用于 has() / cancel()，队列本身不去重
 */

/* ↑ 阶段 2 搬迁自 src/core/paintQueue.ts（IIFE → ES module，函数体逐字未动）。
 * 阶段 6：模块间依赖改为静态 import（全局 IR 兼容层已删除）。 */

  function timeoutError(ms) {
    const e: any = new Error('任务超时：等了 ' + Math.round(ms / 1000) + ' 秒还没有结果');
    e.name = 'TimeoutError';
    e.code = 'ETIMEDOUT';
    e.timeoutMs = ms;
    return e;
  }

  function cancelledError() {
    const e: any = new Error('任务已取消');
    e.name = 'CancelledError';
    e.code = 'ECANCELLED';
    return e;
  }

  function create(opts) {
    const o = opts || {};
    const onChange = typeof o.onChange === 'function' ? o.onChange : null;

    // 毫秒归一：非法 / 非正数 → 0（0 = 不设超时）
    function msOf(v) {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    const defaultTimeout = msOf(o.timeoutMs);
    const pending = [];       // 排队中的任务（FIFO）
    const keys = new Set();   // 排队 + 进行中的 key（has 用）
    let running = false;
    let active = 0;           // 排队 + 进行中的任务数（size 用）
    let current = null;       // 正在跑的那个任务（cancel 用；同一时刻最多一个）

    function notify() {
      if (!onChange) return;
      try { onChange(active); } catch (_) { /* 显示层异常不拦队列 */ }
    }

    function size() { return active; }

    function has(key) {
      if (key == null) return false;
      return keys.has(key);
    }

    function abortItem(item) {
      if (!item.ctrl) return;
      try { item.ctrl.abort(); } catch (_) { /* 已 abort / 环境不支持：忽略 */ }
    }

    /* 收尾（幂等）：成功 / 失败 / 超时 / 取消全走这里——
     * 定时器清掉、key 一定删掉（「finally 兜底」就是这一步）、计数回落、推进下一个。 */
    function settle(item, result) {
      if (item.done) return;
      item.done = true;
      if (item.timer) { clearTimeout(item.timer); item.timer = null; }
      if (item.key != null) keys.delete(item.key);
      active -= 1;
      if (current === item) { current = null; running = false; }
      notify();
      item.resolve(result);
      pump();
    }

    function resultOf(item, ok, value, error, skipped) {
      return {
        ok: !!ok, value: value == null ? null : value, error: error || null,
        skipped: !!skipped,
        dead: !!(item.anchor && item.anchor.dead),
        timeout: false, cancelled: false,
      };
    }

    function runOne(item) {
      if (item.done) return;   // 起跑前已被 cancel 收尾
      const deadNow = () => !!(item.anchor && item.anchor.dead);
      // 开跑前核一次锚点：回合已失败 / 被停止 → 不花画师和生图额度
      if (deadNow()) {
        settle(item, resultOf(item, false, null, null, true));
        return;
      }
      // 超时兜底：到点 abort 在途请求 + 按失败收尾，让队列继续走（不等人）
      if (item.timeoutMs) {
        item.timer = setTimeout(() => {
          abortItem(item);
          const r = resultOf(item, false, null, timeoutError(item.timeoutMs), false);
          r.timeout = true;
          settle(item, r);
        }, item.timeoutMs);
      }
      Promise.resolve()
        .then(() => item.run(item.ctrl ? item.ctrl.signal : undefined))
        .then(
          value => settle(item, resultOf(item, true, value, null, false)),
          error => settle(item, resultOf(item, false, null, error, false))
        );
    }

    function pump() {
      if (running) return;
      const item = pending.shift();
      if (!item) return;
      running = true;
      current = item;   // 同步占位：微任务之前来的 cancel 也能命中
      // run 放进微任务：enqueue 同步返回后调用方立刻能往下走
      Promise.resolve().then(() => runOne(item));
    }

    function cancel(key) {
      if (key == null) {
        if (!current || current.done) return false;
        abortItem(current);
        const r = resultOf(current, false, null, cancelledError(), false);
        r.cancelled = true;
        settle(current, r);
        return true;
      }
      // 排队中：直接摘掉，run 不会被调用（不花额度）
      for (let i = 0; i < pending.length; i++) {
        if (pending[i].key !== key) continue;
        const item = pending.splice(i, 1)[0];
        const r = resultOf(item, false, null, cancelledError(), false);
        r.cancelled = true;
        settle(item, r);
        return true;
      }
      // 进行中：abort 信号 + 立刻收尾（run 迟到的回包由 done 丢弃，队列不必再等它）
      if (current && !current.done && current.key === key) {
        abortItem(current);
        const r = resultOf(current, false, null, cancelledError(), false);
        r.cancelled = true;
        settle(current, r);
        return true;
      }
      return false;
    }

    function enqueue(task) {
      task = task || {};
      const item = {
        key: task.key == null ? null : task.key,
        anchor: task.anchor || null,
        run: typeof task.run === 'function' ? task.run : function () { return null; },
        // 单任务可覆盖队列默认值（显式 0 = 这个任务不设超时）
        timeoutMs: (task.timeoutMs == null) ? defaultTimeout : msOf(task.timeoutMs),
        resolve: null,
        done: false,
        ctrl: (typeof AbortController !== 'undefined') ? new AbortController() : null,
        timer: null,
      };
      const p = new Promise(res => { item.resolve = res; });
      if (item.key != null) keys.add(item.key);
      active += 1;
      notify();
      pending.push(item);
      pump();
      return p;
    }

    return { enqueue: enqueue, has: has, size: size, cancel: cancel };
  }

  const PaintQueue = { create: create };
  export { PaintQueue };
