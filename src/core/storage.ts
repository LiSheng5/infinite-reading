/*
 * 无限阅读 · 存储适配器（IndexedDB 主库 / 回退）
 *
 * 为什么要有这一层：localStorage 每站点约 5MB，是本项目最大的硬伤（ARCHITECTURE §11）。
 * 这里把「大容量存储」抽成独立适配器，让 store.ts 只面对一套接口：
 *
 *   ir-db（IndexedDB，版本 1）
 *   ├── kv       小数据：settings / story-index / current / user-profile / 迁移标记
 *   ├── stories  故事档案（一个故事一条，键 = story id）
 *   └── images   原图 Blob（键 = imageId，值 = { blob, meta, at }）
 *
 * 三条不变量：
 *   ① 这个文件不碰 localStorage，也不懂 story schema —— 迁移策略全部由 store.ts 决定
 *   ② 任何一步用不了 IndexedDB（Node / 无痕 / 老浏览器 / 打开失败），
 *      available 就是 false，store.ts 立刻退回 v0.2 的 localStorage 路径，功能不降级只降容量
 *   ③ 只做「开库 + 增删改查」，不做业务判断；写失败一律 reject，由调用方决定怎么办
 *
 * 零依赖；Node 下加载也不会报错（available = false）。
 */

/* ↑ 阶段 2 搬迁自 src/core/storage.ts（IIFE → ES module，函数体逐字未动）。
 * 阶段 6：模块间依赖改为静态 import（全局 IR 兼容层已删除）。 */
const global = globalThis as any;

  const DB_NAME = 'ir-db';
  const DB_VERSION = 1;
  const KV = 'kv';
  const STORIES = 'stories';
  const IMAGES = 'images';
  const STORE_NAMES = [KV, STORIES, IMAGES];

  const available = (function () {
    try { return typeof global.indexedDB !== 'undefined' && !!global.indexedDB; }
    catch (_) { return false; }
  })();

  let dbPromise = null;
  let broken = false;                     // 真的打不开（不可用 / open 抛错）：本会话不再反复试
  let blocked = false;                    // 上一次失败只是「被别的标签页挡住」——瞬时状态，可重试

  const BLOCKED_MSG = '另一个标签页正在使用（或升级）本地库，暂时打不开；关掉其它标签页后刷新即可';

  function open() {
    if (!available || broken) return Promise.reject(new Error('IndexedDB 不可用'));
    if (dbPromise) return dbPromise;

    const p = new Promise<any>((resolve, reject) => {
      let settled = false;
      let req;

      // 失败只拒绝这一次尝试：blocked 是「另一个标签页正在升级」这种瞬时状态，
      // 不能像真错误那样把整个会话锁进 localStorage（下次 open 必须能再试一遍）。
      const fail = (err, hard) => {
        if (settled) return;
        settled = true;
        if (hard) broken = true;
        reject(err);
      };

      try { req = global.indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { fail(e, true); return; }

      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORE_NAMES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // 挡住之后迟到的成功：已经按失败交回去了，这里把连接关掉，别留着占住对方的升级
        if (settled) { try { db.close(); } catch (_) {} return; }
        settled = true;
        blocked = false;
        // 别的标签页要升级版本时，主动让路，避免卡住对方（本项目暂不升级，但先把口子留好）
        db.onversionchange = () => { try { db.close(); } catch (_) {} dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { fail(req.error || new Error('打开 IndexedDB 失败'), true); };
      req.onblocked = () => {
        blocked = true;
        const e: any = new Error(BLOCKED_MSG);
        e.code = 'IDB_BLOCKED';         // 调用方据此区分「等一下再试」与「这台机器用不了」
        e.blocked = true;
        fail(e, false);
      };
    });

    dbPromise = p;
    // 失败的尝试不进缓存（blocked 之后必须能重新 open）；成功的连接继续复用。
    p.catch(() => { if (dbPromise === p) dbPromise = null; });
    return p;
  }

  function store(name, mode, run) {
    return open().then(db => new Promise((resolve, reject) => {
      let t;
      try { t = db.transaction(name, mode); }
      catch (e) { reject(e); return; }

      let req;
      try { req = run(t.objectStore(name)); }
      catch (e) { reject(e); return; }

      let value;
      req.onsuccess = () => { value = req.result; };
      req.onerror = () => reject(req.error || new Error('IndexedDB 操作失败'));
      t.oncomplete = () => resolve(value === undefined ? null : value);
      t.onerror = () => reject(t.error || new Error('IndexedDB 事务失败'));
      t.onabort = () => reject(t.error || new Error('IndexedDB 事务被中断'));
    }));
  }

  const Storage = {
    DB_NAME, DB_VERSION, KV, STORIES, IMAGES,
    available,

    get isBroken() { return broken; },        // 真的打不开（本会话不再试）
    get isBlocked() { return blocked; },      // 只是被别的标签页挡住（关掉它就能重试）

    get(name, key) {
      return store(name, 'readonly', os => os.get(key));
    },

    put(name, key, value) {
      return store(name, 'readwrite', os => os.put(value, key)).then(() => true);
    },

    del(name, key) {
      return store(name, 'readwrite', os => os.delete(key)).then(() => true);
    },

    keys(name) {
      return store(name, 'readonly', os => os.getAllKeys()).then(r => r || []);
    },

    // 一次读回整个 store，返回 [[key, value], ...]（boot 时装载内存用）。
    // 注意：游标的 onsuccess 会触发很多次，不能用上面那个「取 req.result」的通用壳，
    // 必须在游标走完（result 为 null）时自己 resolve。
    entries(name) {
      return open().then(db => new Promise((resolve, reject) => {
        let t;
        try { t = db.transaction(name, 'readonly'); }
        catch (e) { reject(e); return; }

        const out = [];
        const req = t.objectStore(name).openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) { resolve(out); return; }
          out.push([cur.key, cur.value]);
          cur.continue();
        };
        req.onerror = () => reject(req.error || new Error('IndexedDB 游标读取失败'));
        t.onerror = () => reject(t.error || new Error('IndexedDB 事务失败'));
        t.onabort = () => reject(t.error || new Error('IndexedDB 事务被中断'));
      }));
    },

    // 估算可用空间（Chromium / Firefox 支持；Safari 较旧版本可能没有）
    async estimate() {
      try {
        if (global.navigator && navigator.storage && navigator.storage.estimate) {
          return await navigator.storage.estimate();
        }
      } catch (_) {}
      return null;
    },
  };

export { Storage };