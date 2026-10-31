#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 平台适配门禁（浏览器能力的两处边界）
 *
 * 1. `src/core/storage.ts` 的开库状态机
 *    「另一个标签页正在使用 / 升级本地库」会让 indexedDB.open 触发 blocked。它是**瞬时状态**，
 *    旧实现把它和「真的打不开」混成同一个 broken 标记，于是整个会话被永久锁进 localStorage，
 *    连 boot 的第二次重试都直接短路。这里用假 indexedDB 精确驱动 onblocked / onerror / onsuccess，
 *    验四件事：blocked 可识别、下一次调用会重新 open、占用解除后能正常读写、真错误仍然只试一次。
 *
 * 2. `sw.js` 的 activate 清理
 *    站点常放在 `LiSheng5.github.io/infinite-reading/` 这类共享域名下，同源还有别人的项目。
 *    activate 只许删带 `ir-v` 前缀的旧版本缓存，别的一概不碰（旧实现无前缀过滤，一次激活全删）。
 *
 * 全离线、不开浏览器：service worker 用 node:vm 提供 self / caches 替身跑真实源码。
 *
 * 跑法：node eval/platform-test.js（任一不过 → 退出码 1）
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const { check, run } = require('./_harness.js');

const ROOT = path.join(__dirname, '..');

/* ---------------- 1. IndexedDB 开库状态机 ---------------- */

function makeIdb() {
  return {
    calls: [],
    open() {
      const req = {
        result: null, error: null,
        onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null,
      };
      this.calls.push(req);
      return req;
    },
  };
}

// 够 Storage.get 用的最小连接：transaction → objectStore → get
function makeDb(data) {
  return {
    closed: false,
    close() { this.closed = true; },
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() {
      const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
      tx.objectStore = () => ({
        get(key) {
          const req = { result: data.has(key) ? data.get(key) : undefined, error: null, onsuccess: null, onerror: null };
          // 与真 IDB 一样：回调在本轮同步代码之后才来（storage.ts 先 run() 再挂 handler）
          queueMicrotask(() => {
            if (req.onsuccess) req.onsuccess();
            if (tx.oncomplete) tx.oncomplete();
          });
          return req;
        },
      });
      return tx;
    },
  };
}

const settle = p => p.then(v => ({ ok: true, value: v }), e => ({ ok: false, error: e }));

async function checkStorage() {
  const idb = makeIdb();
  global.indexedDB = idb;                       // storage.ts 只在加载时做一次能力检测
  const Storage = require(path.join(ROOT, 'src', 'core', 'storage.ts')).Storage;
  check('Storage 判定 IndexedDB 可用（否则本段覆盖不到开库路径）', Storage.available === true);

  // ① blocked：拒绝这次尝试，但不当成「库坏了」
  const first = settle(Storage.get('kv', 'k1'));
  check('开库请求已发出', idb.calls.length === 1);
  idb.calls[0].onblocked();
  const r1 = await first;
  const e1 = r1.error;
  check('D20：blocked 的错误带 code / blocked 标记（可与真错误区分）',
    !r1.ok && e1 && e1.code === 'IDB_BLOCKED' && e1.blocked === true, e1 && String(e1.message));
  check('D20：blocked 的提示能直接照做（说清是别的标签页、关掉即可）',
    !!(e1 && /标签页/.test(e1.message)), e1 && e1.message);
  check('D20：blocked 不把整个会话判死（isBroken 仍为 false）',
    Storage.isBroken === false && Storage.isBlocked === true,
    'broken=' + Storage.isBroken + ' blocked=' + Storage.isBlocked);

  // blocked 之后迟到的成功：连接要关掉，不能悄悄占住对方的升级
  const late = makeDb(new Map());
  idb.calls[0].result = late;
  idb.calls[0].onsuccess();
  check('D20：blocked 之后迟到的成功被丢弃，并关掉那条连接（不占住对方的升级）',
    late.closed === true, 'closed=' + late.closed);

  // ② 下一次调用必须重新 open（旧实现这里被 broken 永久短路）
  const second = settle(Storage.get('kv', 'k1'));
  check('D20：blocked 之后的下一次调用会重新 open（不再永久短路）',
    idb.calls.length === 2, 'open 次数 ' + idb.calls.length);
  if (idb.calls.length < 2) {
    // 已经短路了：后面的用例没有可观察的对象，前面的红条已经说明问题
    await second;
    return;
  }
  const db = makeDb(new Map([['k1', 'v1']]));
  idb.calls[1].result = db;
  idb.calls[1].onsuccess();
  const r2 = await second;
  check('D20：占用解除后能正常开库并读出数据', r2.ok && r2.value === 'v1', JSON.stringify(r2));
  check('D20：开库成功后 isBlocked 复位', Storage.isBlocked === false);

  const again = await settle(Storage.get('kv', 'k1'));
  check('开库成功后复用连接（不重复 open）', idb.calls.length === 2 && again.ok && again.value === 'v1',
    'open 次数 ' + idb.calls.length);

  // ③ 真错误（例如库损坏）：仍然只试一次，之后安静降级（不反复抛）
  db.onversionchange();                         // 版本升级：旧连接让路，下次重新开
  const third = settle(Storage.get('kv', 'k2'));
  check('连接让路后重新 open', idb.calls.length === 3, 'open 次数 ' + idb.calls.length);
  idb.calls[2].error = new Error('库损坏');
  idb.calls[2].onerror();
  const r3 = await third;
  check('D20：真正的打开错误仍然拒绝', !r3.ok && /库损坏/.test(String(r3.error && r3.error.message)));
  check('D20：真错误之后 isBroken 为 true（说明这两类失败确实分开了）', Storage.isBroken === true);
  const fourth = await settle(Storage.get('kv', 'k3'));
  check('D20：broken 之后不再发起新的 open（不做无意义重试）',
    !fourth.ok && idb.calls.length === 3, 'open 次数 ' + idb.calls.length);
}

/* ---------------- 2. Service Worker 缓存清理 ---------------- */

async function checkServiceWorker() {
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').replace(/__IR_VERSION__/g, '9.9.9');
  const deleted = [];
  const listeners = {};
  let claimed = false;

  const sandbox = {
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: async () => {},
      clients: { claim: async () => { claimed = true; } },
      location: { origin: 'https://lisheng5.github.io' },
    },
    // 同源混着别的项目：只允许删自己的前缀
    caches: {
      keys: async () => ['ir-v0.12.1', 'ir-v9.9.9', 'other-project-v3', 'workbox-precache-v2-https://lisheng5.github.io/other/'],
      open: async () => ({ add: async () => {} }),
      delete: async k => { deleted.push(k); return true; },
      match: async () => null,
    },
    fetch: async () => ({ ok: false }),
    URL: URL,
  };
  vm.runInNewContext(src, sandbox);

  check('sw.js 注册了 install / activate / fetch 三个事件',
    !!listeners.install && !!listeners.activate && !!listeners.fetch,
    Object.keys(listeners).join(','));

  let pending = null;
  listeners.activate({ waitUntil: p => { pending = p; } });
  await pending;

  check('D12：旧版本缓存被删（版本跟着发布节奏清）', deleted.indexOf('ir-v0.12.1') >= 0,
    JSON.stringify(deleted));
  check('D12：当前版本的缓存不删', deleted.indexOf('ir-v9.9.9') === -1, JSON.stringify(deleted));
  check('D12：同源其它项目的缓存一律不碰（只清 ir-v 前缀）',
    deleted.indexOf('other-project-v3') === -1 && !deleted.some(k => k.indexOf('workbox') === 0),
    JSON.stringify(deleted));
  check('D12：本次只动了该动的那一个', deleted.length === 1, JSON.stringify(deleted));
  check('activate 结束后接管已打开的页面', claimed === true);
}

async function main() {
  await checkStorage();
  await checkServiceWorker();
}

run('平台适配门禁（IndexedDB 开库 / Service Worker 缓存清理）', main);
