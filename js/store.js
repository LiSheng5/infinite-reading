/*
 * 无限阅读 · 存档层（story schema v2 + 旧档迁移）
 *
 * 职责：所有 localStorage 读写都走这里，避免散落各处。
 *  - 存储前缀统一 ir:（settings / story:<id> / story-index / current / user-profile）
 *  - story schema v2：log / world / styleCard / rollingStyle / characterCard /
 *    userProfile / painterThread / messages / mode / savepoints（设计 §2）
 *  - v0.1 旧档（infinite-reading-v1:*）自动迁移，不覆盖旧数据（可回退）
 *
 * 纯逻辑、零依赖；IIFE 挂 window.IR，Node 亦可加载（评测/迁移自测用）。
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

  // v0.1 的旧键，只读、不删（迁移失败还能退回旧版本）
  const LEGACY = {
    settings: 'infinite-reading-v1:settings',
    story: 'infinite-reading-v1:story',
  };

  /* ---------------- localStorage 小工具 ---------------- */

  function ls() { return global.localStorage; }
  function readJSON(key) {
    try { const r = ls().getItem(key); return r ? JSON.parse(r) : null; } catch (_) { return null; }
  }
  function writeJSON(key, val) {
    try { ls().setItem(key, JSON.stringify(val)); return true; }
    catch (e) { console.warn('写入失败（可能超出本地存储限额）', key, e); return false; }
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

  /* ---------------- 读写 API ---------------- */

  function loadSettings() {
    const raw = readJSON(KEYS.settings);
    return migrateSettings(raw);
  }
  function saveSettings(s) { return writeJSON(KEYS.settings, s || {}); }

  function listIndex() {
    const a = readJSON(KEYS.index);
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
  // 只存缩略图、限制 log 长度，控制体积
  function serializeStory(story) {
    return Object.assign({}, story, {
      log: (story.log || []).slice(-120).map(e => (e.type === 'image' ? Object.assign({}, e, { src: undefined }) : e)),
      scenes: (story.scenes || []).slice(-12).map(s => ({
        id: s.id, alt: s.alt, prompt: s.prompt, promptRaw: s.promptRaw || '',
        aspect: s.aspect || '', width: s.width || 0, height: s.height || 0,
        styleCardId: s.styleCardId || undefined,   // 每张图记录锚定版本（P4）
        supersededBy: s.supersededBy || undefined,
        thumb: s.thumb || null, ts: s.ts,
      })),
      savepoints: (story.savepoints || []).slice(-5),   // 存档点最多保留 5 个
    });
  }
  function saveStory(story) {
    if (!story || !story.id) return false;
    story.updatedAt = Date.now();
    const ok = writeJSON(KEYS.story(story.id), serializeStory(story));
    if (!ok) return false;   // 写入失败（超限额）：不更新索引，避免索引与存档不一致
    const idx = listIndex().filter(x => x.id !== story.id);
    idx.push({ id: story.id, title: story.title, updatedAt: story.updatedAt, thumb: storyThumb(story) });
    writeJSON(KEYS.index, idx);
    return ok;
  }
  function loadStory(id) {
    if (!id) return null;
    return migrateStory(readJSON(KEYS.story(id)));
  }
  function deleteStory(id) {
    if (!id) return;
    try { ls().removeItem(KEYS.story(id)); } catch (_) {}
    writeJSON(KEYS.index, listIndex().filter(x => x.id !== id));
    if (getCurrentId() === id) setCurrentId(null);
  }

  /* ---------------- 用户画像（R13 / §4.12） ----------------
   * scope='global' 时存全局 ir:user-profile（跨故事共享）；scope='per-story' 时存 story.userProfile。
   * 条目形如 { text, kind: 'fact'|'preference'|'taboo', updatedAt }。 */

  function loadUserProfile() {
    const a = readJSON(KEYS.userProfile);
    return Array.isArray(a) ? a.filter(x => x && x.text).map(x => ({
      text: String(x.text), kind: String(x.kind || 'fact'), updatedAt: +x.updatedAt || 0,
    })) : [];
  }
  function saveUserProfile(list) {
    return writeJSON(KEYS.userProfile, Array.isArray(list) ? list : []);
  }

  function getCurrentId() { try { return ls().getItem(KEYS.current) || null; } catch (_) { return null; } }
  function setCurrentId(id) {
    try { id ? ls().setItem(KEYS.current, id) : ls().removeItem(KEYS.current); } catch (_) {}
  }
  function loadCurrent() { return loadStory(getCurrentId()); }

  /* ---------------- v0.1 旧档迁移 ---------------- */

  function migrateLegacy() {
    if (ls().getItem(KEYS.migrated)) return null;
    const result = { storyId: null, settings: false };

    const legacyStory = readJSON(LEGACY.story);
    if (legacyStory) {
      const st = migrateStory(legacyStory);
      if (st) {
        st.id = st.id || genId();
        saveStory(st);
        setCurrentId(st.id);
        result.storyId = st.id;
      }
    }

    if (!ls().getItem(KEYS.settings)) {
      const legacySettings = readJSON(LEGACY.settings);
      if (legacySettings) { saveSettings(migrateSettings(legacySettings)); result.settings = true; }
    }

    try { ls().setItem(KEYS.migrated, '1'); } catch (_) {}
    return result;
  }

  function clearAll() {
    try {
      for (const k of [KEYS.settings, KEYS.index, KEYS.current, KEYS.userProfile, KEYS.migrated]) ls().removeItem(k);
      for (const it of listIndex()) ls().removeItem(KEYS.story(it.id));
    } catch (_) {}
  }

  global.IR = Object.assign(global.IR || {}, {
    Store: {
      SCHEMA, KEYS, LEGACY,
      genId,
      defaultWorld, defaultRollingStyle, defaultSettings, defaultUi,
      migrateSettings, migrateStory,
      newStory,
      loadSettings, saveSettings,
      listStories, loadStory, saveStory, deleteStory, storyThumb,
      loadUserProfile, saveUserProfile,
      getCurrentId, setCurrentId, loadCurrent,
      migrateLegacy, clearAll,
    },
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
