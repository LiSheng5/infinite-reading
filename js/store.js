/*
 * 无限阅读 · 存档层（story schema v2 + 旧档迁移 + IndexedDB 主库）
 *
 * 职责：所有存档读写都走这里，避免散落各处。
 *  - 存储前缀统一 ir:（settings / story:<id> / story-index / current / user-profile）
 *  - story schema v2：log / world / styleCard / rollingStyle / characterCard /
 *    userProfile / painterThread / messages / mode / savepoints（设计 §2）
 *  - 主库 = IndexedDB（见 js/storage.js）：解除 localStorage 约 5MB 的天花板，
 *    原图以 Blob 存 images store，不再转成 base64 塞进文本
 *  - v0.1 旧档（infinite-reading-v1:*）自动迁移，不覆盖旧数据（可回退）
 *
 * 【内存优先】为什么这么写：
 *   localStorage 是同步的，IndexedDB 是异步的。若把 API 改成 async，app.js 里几十处
 *   同步调用（saveAll / renderChat 前拿档）全都要改，风险极高。
 *   所以 boot() 时一次性把数据读进内存，之后所有 API **保持同步签名**：
 *   读 = 读内存；写 = 改内存 + 后台异步落盘（失败走 onPersistError 回调提示）。
 *
 * 【迁移】localStorage → IndexedDB 是一次性的、幂等的：
 *   读源 → 写入 → 读回校验 → 全通过才写标记 ir:migrated-v3。
 *   任何一步失败都不写标记、不改动 localStorage，并让本次会话退回 localStorage 模式运行。
 *   成功后 localStorage 里的旧数据**原样保留**（作为回退快照，只增不减），所以不会丢档。
 *
 * 纯逻辑、零依赖；IIFE 挂 window.IR，Node 亦可加载（评测/迁移自测用：
 * 没有 indexedDB 与 localStorage 时自动走进程内内存，行为与 v0.2 一致）。
 */
(function (global) {
  'use strict';

  const SCHEMA = 2;

  const KEYS = {
    settings: 'ir:settings',
    index: 'ir:story-index',
    story: id => 'ir:story:' + id,
    current: 'ir:current',
    userProfile: 'ir:user-profile',
    migrated: 'ir:migrated-v2',
  };

  const MIGRATED_V3 = 'ir:migrated-v3';           // localStorage → IndexedDB 迁移标记

  // v0.1 的旧键，只读、不删（迁移失败还能退回旧版本）
  const LEGACY = {
    settings: 'infinite-reading-v1:settings',
    story: 'infinite-reading-v1:story',
  };

  /* ---------------- 存储后端：IndexedDB 优先，失败退回 localStorage ---------------- */

  const Storage = (global.IR && global.IR.Storage) || null;
  const hasIDB = !!(Storage && Storage.available);
  let useIDB = hasIDB;                            // 迁移/读取失败会置 false，本次会话退回 localStorage

  const MEM = { kv: Object.create(null), stories: new Map() };
  const blobCache = new Map();                    // imageId → Blob
  const urlCache = new Map();                     // imageId → objectURL（渲染直接用）
  const loading = new Set();                      // 正在异步取图的 imageId（防重复请求）

  // 原图缓存上限：一个故事最多 12 张原图，翻几十个故事也不会把内存堆爆。
  // 超限只淘汰最旧的「引用」，**不 revoke** objectURL —— 页面上可能正显示着它，
  // 提前 revoke 会让画面变成裂图；这些 URL 随页面卸载一起释放。
  const IMG_CACHE_MAX = 48;
  function trimCache(map) {
    while (map.size > IMG_CACHE_MAX) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
  }
  // 命中即「变新」：淘汰先淘汰最久没用过的
  function touch(map, key) {
    const v = map.get(key);
    if (v === undefined) return undefined;
    map.delete(key); map.set(key, v);
    return v;
  }

  let pending = 0;                                // 未落盘的后台写
  let drainers = [];
  let bootError = null;                           // boot 阶段失败原因（退回 localStorage 时非空）
  let lastPersistError = null;
  let onPersistErrorFn = null;
  let onImageReadyFn = null;

  function track(promise) {
    pending++;
    const done = () => {
      pending--;
      if (!pending) { const list = drainers; drainers = []; list.forEach(fn => fn()); }
    };
    Promise.resolve(promise).then(done, done);
    return promise;
  }
  function persistFail(e) {
    lastPersistError = { at: Date.now(), message: String((e && e.message) || e) };
    if (onPersistErrorFn) { try { onPersistErrorFn(lastPersistError); } catch (_) {} }
    return lastPersistError;
  }

  /* ---------------- 同步存储（回退路径 + 旧数据迁移的读源） ---------------- */

  let memLS = null;
  // 没有 localStorage 的环境（Node 评测）：用进程内 Map 顶上，读写语义一致
  function ls() {
    if (global.localStorage) return global.localStorage;
    if (!memLS) {
      const m = new Map();
      memLS = {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: k => { m.delete(k); },
        key: i => Array.from(m.keys())[i] || null,
        get length() { return m.size; },
      };
    }
    return memLS;
  }
  function rawLS(key) { try { return ls().getItem(key) || null; } catch (_) { return null; } }
  function readLSJSON(key) {
    try { const r = ls().getItem(key); return r ? JSON.parse(r) : null; } catch (_) { return null; }
  }
  function writeLSJSON(key, val) {
    try { ls().setItem(key, JSON.stringify(val)); return true; }
    catch (e) { console.warn('写入失败（可能超出本地存储限额）', key, e); return false; }
  }
  function delLS(key) { try { ls().removeItem(key); } catch (_) {} }

  /* ---------------- 统一读写：内存优先（同步） ---------------- */

  function readKV(key) {
    if (useIDB) return (key in MEM.kv) ? MEM.kv[key] : null;
    return readLSJSON(key);
  }
  function writeKV(key, val) {
    if (useIDB) {
      MEM.kv[key] = val;
      track(Storage.put('kv', key, val).catch(persistFail));
      return true;
    }
    return writeLSJSON(key, val);
  }
  function readStoryRaw(id) {
    if (useIDB) return MEM.stories.get(id) || null;
    return readLSJSON(KEYS.story(id));
  }
  function writeStoryRaw(id, raw) {
    if (useIDB) {
      MEM.stories.set(id, raw);
      track(Storage.put('stories', id, raw).catch(persistFail));
      return true;
    }
    return writeLSJSON(KEYS.story(id), raw);
  }
  function removeStoryRaw(id) {
    if (useIDB) {
      MEM.stories.delete(id);
      track(Storage.del('stories', id).catch(persistFail));
      return;
    }
    delLS(KEYS.story(id));
  }
  function readFlag(key) {
    if (useIDB) return !!MEM.kv[key];
    return !!rawLS(key);
  }
  function writeFlag(key, on) {
    if (useIDB) {
      MEM.kv[key] = on ? 1 : null;
      track(Storage.put('kv', key, on ? 1 : null).catch(persistFail));
      return;
    }
    try { if (on) ls().setItem(key, '1'); else ls().removeItem(key); } catch (_) {}
  }

  function genId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ---------------- schema v2 默认值 ---------------- */

  function defaultWorld() {
    return {
      place: '', time: '',
      characters: [],              // [{ name, presence, personality, speech, note }]
      threads: [],                 // ['伏笔...']
      relationship: { stage: '', bonds: [], notes: '' }, // R13 关系记忆
      scene: '',                   // 画面参考一句话
      updatedAt: 0, scribeAt: 0,   // 上次书记员校对时间
    };
  }

  function defaultRollingStyle() {
    return { style: '', scenes: '', wardrobe: '', updatedAt: 0 };
  }

  // 界面状态（随存档记住）：双栏比例 / 画面面板开合 / 全屏沉浸（§4.6、§4.9）
  function defaultUi() {
    return { split: 0.5, showImage: true, immersive: false };
  }

  function defaultSubModel() {
    // provider 留空 = 沿用剧情模型（settings.chat）
    return { provider: '', baseUrl: '', apiKey: '', model: '', temperature: 0.7 };
  }

  function defaultSettings() {
    return {
      chat: {
        // 不预置任何厂商 / 模型：Base URL 与模型名全部由用户手填（避免跟着厂商变动维护）
        provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '', temperature: 0.9,
        thinking: 'default',   // T-M-1：思考档位（default = 不下发；其余值按预填表换算 / 手填）
        contextWindow: 0,      // T-M-1：上下文窗口（0 = 未填；预填表命中时自动；70% 压缩阈值按它算）
        extraParams: '',       // 任意厂商参数（"a=b, c.d=e" 或对象），原样并入请求体
      },
      painter: defaultSubModel(),                              // 画师子代理（写绘画提示词）
      scribe: Object.assign(defaultSubModel(), {
        enabled: true, every: 10,
        aiTasks: true,       // 书记员兼任「压缩摘要 + 滚动风格摘要」；调用失败自动走本地规则
      }),
      draft: defaultSubModel(),                                // 开局向导起草
      image: { provider: 'openai-images', baseUrl: '', apiKey: '', model: '', aspect: '16:9', width: 1280, height: 720, extraParams: '' },
      userProfile: { enabled: { choice: false, chat: false, rp: false }, scope: 'global' },
      showReasoning: true,
      toolsEnabled: 'on',
      noTools: [],            // P5-1 护栏：显式 400 拒绝 tools 的模型（baseUrl+model）记住后不再下发
      stylePreset: 'anime',   // P4 视觉设定卡之前的兜底画风
      styleCustom: '',
      trigger: 'choice',      // every | choice | manual（第十二轮砍掉 ai 判断）
      // 可选本地服务（sidecar）：这里只存「怎么连它」（端口 + token）。
      // 额度 / 白名单 / 每日上限等安全项不在这里，唯一真源在侧车 config.json。
      sidecar: { port: 4319, token: '' },
      // P0 数据安全：备份时间戳（7 天没备份就提醒一次；提醒本身每天最多一次）
      lastBackupAt: 0,
      lastBackupRemindAt: 0,
    };
  }

  // v0.1 / 任意旧设置 → v0.2（幂等）
  function migrateSettings(raw) {
    const d = defaultSettings();
    raw = (raw && typeof raw === 'object') ? raw : {};

    const out = {
      chat: Object.assign({}, d.chat, raw.chat || {}),
      painter: Object.assign({}, d.painter, raw.painter || {}),
      scribe: Object.assign({}, d.scribe, raw.scribe || {}),
      draft: Object.assign({}, d.draft, raw.draft || {}),
      image: Object.assign({}, d.image, raw.image || {}),
      userProfile: Object.assign({}, d.userProfile, raw.userProfile || {}, {
        enabled: Object.assign({}, d.userProfile.enabled, (raw.userProfile && raw.userProfile.enabled) || {}),
      }),
      showReasoning: ('showReasoning' in raw) ? !!raw.showReasoning : d.showReasoning,
      toolsEnabled: raw.toolsEnabled === 'off' ? 'off' : 'on',
      noTools: Array.isArray(raw.noTools)
        ? raw.noTools.filter(x => x && x.baseUrl && x.model).slice(-20).map(x => ({ baseUrl: String(x.baseUrl), model: String(x.model), at: +x.at || 0 }))
        : [],
      stylePreset: raw.stylePreset || d.stylePreset,
      styleCustom: raw.styleCustom || '',
      trigger: ['every', 'choice', 'manual'].indexOf(raw.trigger) >= 0
        ? raw.trigger
        : (raw.trigger === 'ai' ? 'every' : d.trigger), // v0.1 的 'ai' 已废 → 退回 every
    };

    out.scribe.enabled = (raw.scribe && 'enabled' in raw.scribe) ? !!raw.scribe.enabled : true;
    out.scribe.every = (raw.scribe && +raw.scribe.every) ? +raw.scribe.every : 10;
    out.scribe.aiTasks = (raw.scribe && 'aiTasks' in raw.scribe) ? !!raw.scribe.aiTasks : true;

    // 可选本地服务：只迁移连接信息（端口 + token）；安全项真源在侧车 config.json
    out.sidecar = {
      port: (raw.sidecar && +raw.sidecar.port > 0 && +raw.sidecar.port < 65536)
        ? Math.floor(+raw.sidecar.port)
        : d.sidecar.port,
      token: (raw.sidecar && typeof raw.sidecar.token === 'string')
        ? raw.sidecar.token.trim().slice(0, 200)
        : '',
    };

    // P0 数据安全：备份时间戳（幂等校验）
    out.lastBackupAt = (+raw.lastBackupAt > 0) ? +raw.lastBackupAt : 0;
    out.lastBackupRemindAt = (+raw.lastBackupRemindAt > 0) ? +raw.lastBackupRemindAt : 0;

    // T-M-1：思考档位 / 上下文窗口 / 手填参数（幂等校验）
    // 离线演示模式已删除：旧设置里的 mock 一律迁回真实接口（用户需补填 Base URL / 模型）
    out.chat.provider = 'openai-compatible';
    if (out.image.provider === 'mock') out.image.provider = 'openai-images';
    out.chat.thinking = (typeof out.chat.thinking === 'string' && out.chat.thinking) ? out.chat.thinking : 'default';
    out.chat.contextWindow = (+out.chat.contextWindow > 0) ? Math.floor(+out.chat.contextWindow) : 0;
    if (typeof out.chat.extraParams !== 'string' && !(out.chat.extraParams && typeof out.chat.extraParams === 'object')) out.chat.extraParams = '';
    if (typeof out.image.extraParams !== 'string' && !(out.image.extraParams && typeof out.image.extraParams === 'object')) out.image.extraParams = '';

    // v0.1 的 image.size 字符串 → aspect/width/height（R8）
    if (raw.image && raw.image.size && !raw.image.aspect) {
      const m = String(raw.image.size).match(/(\d+)\s*[x×]\s*(\d+)/i);
      if (m) { out.image.width = +m[1]; out.image.height = +m[2]; out.image.aspect = 'custom'; }
    }
    delete out.image.size;
    return out;
  }

  /* ---------------- story v2 ---------------- */

  function newStory(opts) {
    opts = opts || {};
    const now = Date.now();
    return {
      schema: SCHEMA,
      id: opts.id || genId(),
      title: opts.title || '未命名故事',
      premise: opts.premise || '',
      mode: opts.mode || 'choice',            // choice | chat | rp
      createdAt: opts.createdAt || now,
      updatedAt: opts.updatedAt || now,

      log: [],                                 // 聊天记录主体（append-only）
      world: Object.assign(defaultWorld(), opts.world || {}),
      styleCard: opts.styleCard || null,       // 未锚定 = null
      rollingStyle: Object.assign(defaultRollingStyle(), opts.rollingStyle || {}),
      styleTone: opts.styleTone || '',         // 向导「风格基调」栏（P2-3，P4 试画锚定的依据）
      characterCard: opts.characterCard || null,
      userProfile: opts.userProfile || [],
      painterThread: opts.painterThread || [],
      messages: opts.messages || [],           // AI1 原始对话（滑动窗口）
      summaries: opts.summaries || [],         // C-A 场景摘要栈（T-P1-4）
      savepoints: opts.savepoints || [],       // 存档点（P2-1）
      ui: Object.assign(defaultUi(), opts.ui || {}), // 界面状态随存档（§4.6/§4.9）

      // 运行时辅助字段（随档保存，方便续玩）
      turn: 0,
      scenes: [],                              // 已生成图片（含 thumb / prompt）
      lastBg: null,
      lastSceneSummary: '',
    };
  }

  // v1 / 任意旧档 → v2（幂等）
  function migrateStory(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = newStory({ id: raw.id, title: raw.title, premise: raw.premise, mode: raw.mode });
    out.createdAt = raw.createdAt || out.createdAt;
    out.updatedAt = raw.updatedAt || out.updatedAt;

    out.log = Array.isArray(raw.log) ? raw.log.map(migrateLogEntry) : [];
    out.world = Object.assign(defaultWorld(), raw.world || {});
    out.world.relationship = Object.assign(defaultWorld().relationship, (raw.world && raw.world.relationship) || {});
    out.styleCard = raw.styleCard || null;
    out.rollingStyle = Object.assign(defaultRollingStyle(), raw.rollingStyle || {});
    out.styleTone = raw.styleTone || '';
    out.characterCard = raw.characterCard || null;
    out.userProfile = Array.isArray(raw.userProfile) ? raw.userProfile : [];
    // 第八轮：ai2Thread → painterThread
    out.painterThread = Array.isArray(raw.painterThread) ? raw.painterThread
      : (Array.isArray(raw.ai2Thread) ? raw.ai2Thread : []);
    out.messages = Array.isArray(raw.messages) ? raw.messages : [];
    out.summaries = Array.isArray(raw.summaries) ? raw.summaries : [];
    out.savepoints = Array.isArray(raw.savepoints) ? raw.savepoints : [];
    out.ui = Object.assign(defaultUi(), raw.ui || {});
    out.turn = raw.turn || 0;
    out.scenes = Array.isArray(raw.scenes) ? raw.scenes : [];
    out.lastBg = raw.lastBg || null;
    out.lastSceneSummary = raw.lastSceneSummary || '';
    if (!out.world.scene && out.lastSceneSummary) out.world.scene = out.lastSceneSummary;
    return out;
  }

  function migrateLogEntry(e) {
    if (!e || typeof e !== 'object') return e;
    if (e.type === 'narration') {
      const versions = Array.isArray(e.versions) && e.versions.length ? e.versions : [e.text || ''];
      // 保留已有的 activeVersion（重复迁移/刷新后不丢当前版本）
      let active = Number.isInteger(e.activeVersion) ? e.activeVersion : versions.length - 1;
      active = Math.max(0, Math.min(versions.length - 1, active));
      return Object.assign({}, e, { versions, activeVersion: active, text: versions[active] });
    }
    return e;
  }

  /* ---------------- boot：装载内存 + localStorage → IndexedDB 一次性迁移 ---------------- */

  // 把 localStorage 里的 ir:* 存档整体搬进 IndexedDB。
  // 幂等（有标记就跳过）；先写后校验，全通过才写标记；任何失败都抛出去交给 boot() 决定。
  async function migrateLocalStorageToIDB() {
    const report = { stories: 0, settings: false, userProfile: false, skipped: false };

    if (await Storage.get('kv', MIGRATED_V3)) { report.skipped = true; return report; }

    const settings = readLSJSON(KEYS.settings);
    const profile = readLSJSON(KEYS.userProfile);
    const rawIndex = readLSJSON(KEYS.index);
    const index = Array.isArray(rawIndex) ? rawIndex : [];
    const currentId = rawLS(KEYS.current);
    const legacyFlag = !!rawLS(KEYS.migrated);

    const pairs = [];
    for (const it of index) {
      if (!it || !it.id) continue;
      const raw = readLSJSON(KEYS.story(it.id));
      if (raw) pairs.push([it.id, raw]);
    }

    // ① 写入
    if (settings) { await Storage.put('kv', KEYS.settings, settings); report.settings = true; }
    if (profile) { await Storage.put('kv', KEYS.userProfile, profile); report.userProfile = true; }
    if (index.length) await Storage.put('kv', KEYS.index, index);
    if (currentId) await Storage.put('kv', KEYS.current, currentId);
    if (legacyFlag) await Storage.put('kv', KEYS.migrated, 1);
    for (const [id, raw] of pairs) await Storage.put('stories', id, raw);
    report.stories = pairs.length;

    // ② 校验：读回来对一遍，对不上就当迁移失败（宁可不迁移，也不能丢档）
    if (settings && !(await Storage.get('kv', KEYS.settings))) throw new Error('校验失败：设置没写进 IndexedDB');
    if (index.length && (await Storage.get('kv', KEYS.index) || []).length !== index.length) {
      throw new Error('校验失败：故事索引条数与 localStorage 不一致');
    }
    for (const [id] of pairs) {
      if (!(await Storage.get('stories', id))) throw new Error('校验失败：故事 ' + id + ' 没写进 IndexedDB');
    }

    // ③ 全部通过 → 写标记（下次启动直接跳过；localStorage 原样保留当回退快照）
    await Storage.put('kv', MIGRATED_V3, { at: Date.now(), stories: report.stories });
    return report;
  }

  async function boot() {
    const out = { backend: 'localstorage', migrated: null, error: null };
    if (!hasIDB) return out;                       // Node / 老浏览器：与 v0.2 行为一致

    try {
      out.migrated = await migrateLocalStorageToIDB();
    } catch (e) {
      useIDB = false;                              // 迁移失败：退回 localStorage，数据一处不动
      out.error = String((e && e.message) || e);
      bootError = out.error;
      console.warn('IndexedDB 迁移失败，已退回 localStorage 模式（原数据未改动）：', e);
      return out;
    }

    // 读一次 IndexedDB 进内存；失败先重试一次（打开瞬断 / 版本切换都可能只是暂时的）
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const [settings, index, current, profile, flag, storyPairs] = await Promise.all([
          Storage.get('kv', KEYS.settings),
          Storage.get('kv', KEYS.index),
          Storage.get('kv', KEYS.current),
          Storage.get('kv', KEYS.userProfile),
          Storage.get('kv', KEYS.migrated),
          Storage.entries('stories'),
        ]);
        MEM.kv[KEYS.settings] = settings || null;
        MEM.kv[KEYS.index] = Array.isArray(index) ? index : [];
        MEM.kv[KEYS.current] = (typeof current === 'string' && current) ? current : null;
        MEM.kv[KEYS.userProfile] = Array.isArray(profile) ? profile : [];
        MEM.kv[KEYS.migrated] = flag ? 1 : null;
        MEM.stories.clear();
        for (const [id, raw] of storyPairs) MEM.stories.set(id, raw);
        out.backend = 'indexeddb';
        return out;
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise(r => setTimeout(r, 300));
      }
    }
    useIDB = false;
    out.backend = 'localstorage';
    out.error = String((lastErr && lastErr.message) || lastErr);
    bootError = out.error;
    console.warn('IndexedDB 读取失败，已退回 localStorage 模式：', lastErr);
    return out;
  }

  // 等后台落盘写完（导出备份前、页面卸载前调一次，避免拿到半截数据）
  function flush() {
    if (!pending) return Promise.resolve();
    return new Promise(resolve => drainers.push(resolve));
  }

  function storageInfo() {
    return {
      backend: useIDB ? 'indexeddb' : 'localstorage',
      available: hasIDB,
      pending: pending,
      bootError: bootError,
      lastError: lastPersistError,
    };
  }

  /* ---------------- 读写 API ---------------- */

  function loadSettings() {
    const raw = readKV(KEYS.settings);
    return migrateSettings(raw);
  }
  function saveSettings(s) { return writeKV(KEYS.settings, s || {}); }

  function listIndex() {
    const a = readKV(KEYS.index);
    return Array.isArray(a) ? a : [];
  }
  function listStories() {
    return listIndex().slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  function storyThumb(story) {
    const imgs = (story.log || []).filter(e => e.type === 'image' && e.thumb);
    if (imgs.length) return imgs[imgs.length - 1].thumb;
    const sc = (story.scenes || []).filter(s => s && s.thumb);
    return sc.length ? sc[sc.length - 1].thumb : null;
  }
  // 文本进档案；原图不进这里 —— 原图是 Blob，走 images store（见 putImage）
  function serializeStory(story) {
    return Object.assign({}, story, {
      log: (story.log || []).slice(-120).map(e => (e.type === 'image' ? Object.assign({}, e, { src: undefined }) : e)),
      scenes: (story.scenes || []).slice(-12).map(s => ({
        id: s.id, alt: s.alt, prompt: s.prompt, promptRaw: s.promptRaw || '',
        aspect: s.aspect || '', width: s.width || 0, height: s.height || 0,
        styleCardId: s.styleCardId || undefined,   // 每张图记录锚定版本（P4）
        supersededBy: s.supersededBy || undefined,
        thumb: s.thumb || null,
        imageId: s.imageId || undefined,           // 原图在 IndexedDB images 里的键
        ts: s.ts,
      })),
      savepoints: (story.savepoints || []).slice(-5),   // 存档点最多保留 5 个
    });
  }
  function saveStory(story) {
    if (!story || !story.id) return false;
    story.updatedAt = Date.now();
    const ok = writeStoryRaw(story.id, serializeStory(story));
    if (!ok) return false;   // 写入失败（超限额）：不更新索引，避免索引与存档不一致
    const idx = listIndex().filter(x => x.id !== story.id);
    idx.push({ id: story.id, title: story.title, updatedAt: story.updatedAt, thumb: storyThumb(story) });
    writeKV(KEYS.index, idx);
    return ok;
  }
  function loadStory(id) {
    if (!id) return null;
    return migrateStory(readStoryRaw(id));
  }
  function deleteStory(id) {
    if (!id) return;
    const raw = readStoryRaw(id);
    removeStoryRaw(id);
    writeKV(KEYS.index, listIndex().filter(x => x.id !== id));
    if (getCurrentId() === id) setCurrentId(null);
    imageIdsOf(raw).forEach(x => releaseImage(x));   // 顺手删原图，不留孤儿占空间
  }

  /* ---------------- 原图（Blob） ----------------
   * 大图一律以 Blob 存 IndexedDB，绝不转 base64 塞进普通文本存储。
   * 没有 IndexedDB 时返回 false，调用方退回 dataURL（行为与 v0.2 一致）。 */

  function imageIdsOf(rawStory) {
    const out = [];
    if (!rawStory || typeof rawStory !== 'object') return out;
    (rawStory.scenes || []).forEach(s => { if (s && s.imageId) out.push(s.imageId); });
    (rawStory.log || []).forEach(e => { if (e && e.type === 'image' && e.imageId) out.push(e.imageId); });
    return out;
  }

  function putImage(id, blob, meta) {
    if (!id || !blob) return false;
    blobCache.set(id, blob);
    trimCache(blobCache);
    if (!useIDB) return false;
    track(Storage.put('images', id, { blob: blob, meta: meta || {}, at: Date.now() }).catch(persistFail));
    return true;
  }

  async function getImage(id) {
    if (!id) return null;
    const hot = touch(blobCache, id);
    if (hot !== undefined) return hot;
    if (!useIDB) return null;
    try {
      const rec = await Storage.get('images', id);
      const blob = (rec && rec.blob && typeof rec.blob.size === 'number') ? rec.blob : null;
      if (blob) { blobCache.set(id, blob); trimCache(blobCache); }
      return blob;
    } catch (e) { persistFail(e); return null; }
  }

  // 同步取 objectURL：命中缓存直接给；没有就后台取，取到后回调 setImageReadyHandler
  function imageURL(id) {
    if (!id) return null;
    const hot = touch(urlCache, id);
    if (hot !== undefined) return hot;
    if (!useIDB || loading.has(id)) return null;
    loading.add(id);
    getImage(id).then(blob => {
      loading.delete(id);
      if (!blob) return;
      let url = null;
      try { url = URL.createObjectURL(blob); } catch (_) { return; }
      urlCache.set(id, url);
      trimCache(urlCache);
      if (onImageReadyFn) { try { onImageReadyFn(id); } catch (_) {} }
    }).catch(() => { loading.delete(id); });
    return null;
  }

  function releaseImage(id) {
    if (!id) return;
    const u = urlCache.get(id);
    if (u) { try { URL.revokeObjectURL(u); } catch (_) {} urlCache.delete(id); }
    blobCache.delete(id);
    if (useIDB) track(Storage.del('images', id).catch(persistFail));
  }

  function releaseImages(ids) { (ids || []).forEach(id => releaseImage(id)); }

  async function listImageKeys() {
    if (!useIDB) return [];
    try { return await Storage.keys('images'); } catch (e) { persistFail(e); return []; }
  }

  // 现存故事引用到的全部原图 id（清理孤儿用）
  function knownImageIds() {
    const keep = new Set();
    const raws = useIDB
      ? Array.from(MEM.stories.values())
      : listIndex().map(it => readLSJSON(KEYS.story(it.id)));
    raws.forEach(r => imageIdsOf(r).forEach(id => keep.add(id)));
    return keep;
  }

  /* ---------------- 用户画像（R13 / §4.12） ----------------
   * scope='global' 时存全局 ir:user-profile（跨故事共享）；scope='per-story' 时存 story.userProfile。
   * 条目形如 { text, kind: 'fact'|'preference'|'taboo', updatedAt }。 */

  function loadUserProfile() {
    const a = readKV(KEYS.userProfile);
    return Array.isArray(a) ? a.filter(x => x && x.text).map(x => ({
      text: String(x.text), kind: String(x.kind || 'fact'), updatedAt: +x.updatedAt || 0,
    })) : [];
  }
  function saveUserProfile(list) {
    return writeKV(KEYS.userProfile, Array.isArray(list) ? list : []);
  }

  function getCurrentId() {
    if (useIDB) { const v = MEM.kv[KEYS.current]; return (typeof v === 'string' && v) ? v : null; }
    return rawLS(KEYS.current);
  }
  function setCurrentId(id) {
    if (useIDB) {
      MEM.kv[KEYS.current] = id || null;
      track(Storage.put('kv', KEYS.current, id || null).catch(persistFail));
      return;
    }
    try { if (id) ls().setItem(KEYS.current, id); else ls().removeItem(KEYS.current); } catch (_) {}
  }
  function loadCurrent() { return loadStory(getCurrentId()); }

  /* ---------------- v0.1 旧档迁移 ---------------- */

  function migrateLegacy() {
    if (readFlag(KEYS.migrated)) return null;
    const result = { storyId: null, settings: false };

    const legacyStory = readLSJSON(LEGACY.story);   // v0.1 的旧键只在 localStorage 里
    if (legacyStory) {
      const st = migrateStory(legacyStory);
      if (st) {
        st.id = st.id || genId();
        saveStory(st);
        setCurrentId(st.id);
        result.storyId = st.id;
      }
    }

    if (!readKV(KEYS.settings)) {
      const legacySettings = readLSJSON(LEGACY.settings);
      if (legacySettings) { saveSettings(migrateSettings(legacySettings)); result.settings = true; }
    }

    writeFlag(KEYS.migrated, true);
    return result;
  }

  function clearAll() {
    try {
      const ids = listIndex().map(x => x && x.id).filter(Boolean);
      for (const k of [KEYS.settings, KEYS.index, KEYS.current, KEYS.userProfile, KEYS.migrated]) {
        if (useIDB) { delete MEM.kv[k]; track(Storage.del('kv', k).catch(() => {})); }
        else delLS(k);
      }
      ids.forEach(id => removeStoryRaw(id));
      MEM.stories.clear();
      listImageKeys().then(keys => keys.forEach(k => releaseImage(k))).catch(() => {});
    } catch (_) {}
  }

  global.IR = Object.assign(global.IR || {}, {
    Store: {
      SCHEMA, KEYS, LEGACY, MIGRATED_V3,
      genId,
      defaultWorld, defaultRollingStyle, defaultSettings, defaultUi,
      migrateSettings, migrateStory,
      newStory,
      loadSettings, saveSettings,
      listStories, loadStory, saveStory, deleteStory, storyThumb,
      loadUserProfile, saveUserProfile,
      getCurrentId, setCurrentId, loadCurrent,
      migrateLegacy, clearAll,

      // 存储后端（IndexedDB 主库 + 回退）
      boot, flush, storageInfo,
      setPersistErrorHandler(fn) { onPersistErrorFn = (typeof fn === 'function') ? fn : null; },
      setImageReadyHandler(fn) { onImageReadyFn = (typeof fn === 'function') ? fn : null; },

      // 原图（Blob）
      imageIdsOf, putImage, getImage, imageURL, releaseImage, releaseImages,
      listImageKeys, knownImageIds,
    },
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
