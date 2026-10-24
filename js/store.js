/*
 * 无限阅读 · 存档层（story schema v3 + 旧档迁移 + IndexedDB 主库）
 *
 * 职责：所有存档读写都走这里，避免散落各处。
 *  - 存储前缀统一 ir:（settings / story:<id> / story-index / current / user-profile）
 *  - story schema v3：log / world / styleCard / rollingStyle / characterCard /
 *    userProfile / painterThread / messages / mode / savepoints（设计 §2）
 *    + tree（分支树，schema v3 新增；本层只透传，建树 / 投影在 js/tree.js）
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

  // schema v3 = v2 + story.tree（分支树）；migrateStory 只透传 tree，建树 / 校验在 IR.Tree.ensure
  const SCHEMA = 3;

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
  // 没有可用 localStorage 的环境（Node 评测）：用进程内 Map 顶上，读写语义一致。
  // 要做能力检测而非真值判断——Node 25 的全局 localStorage 是个没有 getItem/setItem 的占位对象。
  function ls() {
    const g = global.localStorage;
    if (g && typeof g.getItem === 'function' && typeof g.setItem === 'function') return g;
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
    // 与 writeLSJSON 同一告警口径（审查 低危 #20）：配额满等失败不再静默吞掉
    try { if (on) ls().setItem(key, '1'); else ls().removeItem(key); }
    catch (e) { console.warn('写入失败（可能超出本地存储限额）', key, e); }
  }

  // ID 生成统一走 IR.genId（js/tree.js，审查 可维护性 #5）：不再各写时间戳+随机变体。
  // 默认前缀 's'（故事），需要别的前缀时显式传（如 genId('pf')）。
  function genId(prefix) {
    return IR.genId(prefix || 's');
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

  // 从「故事设定」文本里抽出能直接进世界卡的部分（纯本地规则，不花 API）。
  // 只认「键：值」行（世界 / 背景 / 时间 / 伏笔…），已有值的字段不覆盖——
  // 目的是让新建的剧情故事不是一张空白记忆卡，同时不替用户编造内容。
  function seedWorldFromPremise(story, text) {
    if (!story) return story;
    const w = story.world || (story.world = defaultWorld());
    const src = String(text || story.premise || '');
    const pick = re => {
      let out = '';
      src.split(/\r?\n/).forEach(line => {
        const m = String(line).match(re);
        if (!out && m && m[1]) out = m[1].trim();
      });
      return out;
    };
    const worldText = pick(/^(?:世界|世界设定|背景|舞台|setting|world)\s*[:：]\s*(.+)$/i);
    const timeText = pick(/^(?:时间|时代|time)\s*[:：]\s*(.+)$/i);
    const threadText = pick(/^(?:伏笔|线索|threads?)\s*[:：]\s*(.+)$/i);
    if (worldText && !w.scene) w.scene = worldText.slice(0, 200);
    if (worldText && !w.place) {
      const first = worldText.split(/[，,。；;、]/)[0].trim();
      if (first) w.place = first.slice(0, 24);
    }
    if (timeText && !w.time) w.time = timeText.slice(0, 40);
    if (threadText && !(w.threads || []).length) {
      w.threads = threadText.split(/[；;、]/).map(s => s.trim()).filter(Boolean).slice(0, 6);
    }

    // 关系备注：设定里的「你的角色 / AI 扮演」两行原样落到关系备注，关系区不再是空的
    const roleText = pick(/^(?:你的角色|玩家角色|我的角色|player)\s*[:：]\s*(.+)$/i);
    const aiText = pick(/^(?:AI\s*扮演|ai\s*扮演|旁白)\s*[:：]\s*(.+)$/i);
    w.relationship = w.relationship || { stage: '', bonds: [], notes: '' };
    if (!w.relationship.notes && (roleText || aiText)) {
      w.relationship.notes = [
        roleText ? '你：' + roleText : '',
        aiText ? 'AI 扮演：' + aiText : '',
      ].filter(Boolean).join('；').slice(0, 200);
    }

    // 人物：只认明确的「人物：名字｜性格｜说话方式」行（可多行 / 分号分隔），不猜
    if (!(w.characters || []).length) {
      const rows = [];
      src.split(/\r?\n/).forEach(line => {
        const m = String(line).match(/^(?:人物|出场人物|角色|characters?)\s*[:：]\s*(.+)$/i);
        if (m) rows.push(m[1]);
      });
      const list = rows.join('；').split(/[；;]/).map(s => s.trim()).filter(Boolean).slice(0, 12)
        .map(item => {
          const p = item.split(/[｜|]/).map(s => s.trim());
          if (!p[0]) return null;
          return { name: p[0].slice(0, 20), presence: '在场', personality: (p[1] || '').slice(0, 80), speech: (p[2] || '').slice(0, 80), note: '', noteLocked: false };
        })
        .filter(Boolean);
      if (list.length) w.characters = list;
    }
    return story;
  }

  function defaultRollingStyle() {
    return { style: '', scenes: '', wardrobe: '', updatedAt: 0 };
  }

  // 界面状态（随存档记住）：输入类型（做 / 说 / 导演）。
  // split / showImage / immersive 是 v0.3 的旧字段，仍原样保留在存档里（不读、不删），
  // 布局状态已统一到 settings.ui（layout / splitRatio / imageCollapsed）。
  function defaultUi() {
    return { kind: 'do', split: 0.5, showImage: true, immersive: false };
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
      // UI-3 模型库（§3.1）：可选的多套主模型；settings.chat 仍是「默认主模型」（id 视作 'default'，不进数组）
      profiles: [],
      // refMode：'off' = 纯文生图；“'prev' = 把上一张图当参考图（MiniMax subject_reference）
      image: { provider: 'openai-images', baseUrl: '', apiKey: '', model: '', aspect: '16:9', width: 1280, height: 720, extraParams: '', refMode: 'off' },
      // 生视频（MiniMax V2「minimax-video」）：异步任务。
      // 时长 / 分辨率 / 比例以面板控件为唯一来源（审查 三·2）；extraParams 只补其它键。
      video: {
        provider: 'minimax-video', baseUrl: '', apiKey: '', model: '',
        duration: 5, resolution: '768P', ratio: '16:9', extraParams: '',
      },
      userProfile: { enabled: { choice: false, chat: false, rp: false }, scope: 'global' },
      // 界面布局（P2）：auto = 宽 ≥ 900px 双栏，否则堆叠；immersive 只能由用户进入
      ui: {
        layout: 'auto',          // auto | split | stack | immersive
        splitRatio: 0.5,         // 双栏比例（每栏最小约 28%）
        imageCollapsed: false,   // 舞台收起（聊天占满）
        choices: 'tray',         // 选项显示：tray（默认收起）| always（内联）
        motion: 'auto',          // 动效强度（UI-1）：auto | off | standard | rich
        // UI-3 §3.5：扮演 / 智能体的字号 / 宽度 / 密度默认（本对话可覆盖；令牌驱动）
        fontScale: 'md',         // sm | md | lg
        width: 'standard',       // narrow | standard | wide
        density: 'standard',     // compact | standard
      },
      showReasoning: true,
      toolsEnabled: 'on',
      noTools: [],            // P5-1 护栏：显式 400 拒绝 tools 的模型（baseUrl+model）记住后不再下发
      stylePreset: 'anime',   // P4 视觉设定卡之前的兜底画风
      styleCustom: '',
      // P-1（v0.11.0）：出图时机（trigger）下线——不再写入；旧档里的值原样留在存档（不读、不删）
      // 可选本地服务（sidecar）：这里只存「怎么连它」（端口 + token）。
      // 额度 / 白名单 / 每日上限等安全项不在这里，唯一真源在侧车 config.json。
      sidecar: { port: 4319, token: '' },
      // P0 数据安全：备份时间戳（7 天没备份就提醒一次；提醒本身每天最多一次）
      lastBackupAt: 0,
      lastBackupRemindAt: 0,
    };
  }

  // UI-3 §3.1 模型库（profiles）迁移：幂等；已有数据原样保留，只保证每条有字符串 id
  function migrateProfiles(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = Object.create(null);
    for (const p of raw) {
      if (!p || typeof p !== 'object') continue;         // 坏条目直接丢
      const id = (typeof p.id === 'string' && p.id.trim()) ? p.id.trim().slice(0, 64) : genId('pf');
      if (seen[id]) continue;                            // 防重 id（保留先到的）
      seen[id] = true;
      out.push(Object.assign({}, p, { id: id }));
    }
    return out;
  }

  // 从 extraParams 里抽出 duration / resolution / ratio（历史迁移折进去的同名键）：
  // 值带回控件字段，键从 extraParams 移除——「唯一源 = 面板控件」（审查 三·2）
  function extractVideoControlParams(raw) {
    const out = { extraParams: raw, duration: null, resolution: null, ratio: null };
    const keepVal = v => (v == null || v === '' ? null : v);
    if (typeof raw === 'string') {
      const keep = [];
      raw.split(/[,，\n;；]/).forEach(pair => {
        const i = pair.indexOf('=');
        if (i <= 0) { if (pair.trim()) keep.push(pair); return; }
        const k = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (k === 'duration') out.duration = keepVal(v);
        else if (k === 'resolution') out.resolution = keepVal(v);
        else if (k === 'ratio') out.ratio = keepVal(v);
        else keep.push(pair);
      });
      out.extraParams = keep.join(', ');
    } else if (raw && typeof raw === 'object') {
      const next = Object.assign({}, raw);
      for (const k of ['duration', 'resolution', 'ratio']) {
        if (k in next) { out[k] = keepVal(next[k]); delete next[k]; }
      }
      out.extraParams = next;
    }
    return out;
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
      video: Object.assign({}, d.video, raw.video || {}),
      userProfile: Object.assign({}, d.userProfile, raw.userProfile || {}, {
        // 'all' 是合法写法（= 三个模式全开）：必须原样保留；只有对象才做深合并
        //（修：此前 Object.assign({}, 默认, 'all') 会把字符串拆成 0/1/2 索引键，刷新后三个勾全丢）
        enabled: ((raw.userProfile && raw.userProfile.enabled) === 'all')
          ? 'all'
          : Object.assign({}, d.userProfile.enabled, (raw.userProfile && raw.userProfile.enabled) || {}),
      }),
      showReasoning: ('showReasoning' in raw) ? !!raw.showReasoning : d.showReasoning,
      toolsEnabled: raw.toolsEnabled === 'off' ? 'off' : 'on',
      noTools: Array.isArray(raw.noTools)
        ? raw.noTools.filter(x => x && x.baseUrl && x.model).slice(-20).map(x => ({ baseUrl: String(x.baseUrl), model: String(x.model), at: +x.at || 0 }))
        : [],
      stylePreset: raw.stylePreset || d.stylePreset,
      styleCustom: raw.styleCustom || '',
      // P-1（v0.11.0）：trigger（出图时机）停止读写——defaultSettings 不再写它，
      // 旧值原样留在存档里（不读、不删），与 split / showImage 旧字段同一处理方式
    };
    if (raw && typeof raw === 'object' && 'trigger' in raw) out.trigger = raw.trigger;

    // 界面布局（P2，新字段一律给默认值）：非法值回落到 auto / 0.5，比例夹在 28%~72%
    const rawUi = (raw.ui && typeof raw.ui === 'object') ? raw.ui : {};
    let ratio = +rawUi.splitRatio;
    if (!Number.isFinite(ratio) || ratio <= 0) ratio = d.ui.splitRatio;
    out.ui = {
      layout: ['auto', 'split', 'stack', 'immersive'].indexOf(rawUi.layout) >= 0 ? rawUi.layout : d.ui.layout,
      splitRatio: Math.max(0.28, Math.min(0.72, ratio)),
      imageCollapsed: !!rawUi.imageCollapsed,
      choices: rawUi.choices === 'always' ? 'always' : 'tray',
      // 动效强度（UI-1）：auto | off | standard | rich，非法值当 auto（幂等）
      motion: ['auto', 'off', 'standard', 'rich'].indexOf(rawUi.motion) >= 0 ? rawUi.motion : 'auto',
      // UI-3 §3.5：字号 / 宽度 / 密度默认（令牌驱动；非法值回默认）
      fontScale: ['sm', 'md', 'lg'].indexOf(rawUi.fontScale) >= 0 ? rawUi.fontScale : d.ui.fontScale,
      width: ['narrow', 'standard', 'wide'].indexOf(rawUi.width) >= 0 ? rawUi.width : d.ui.width,
      density: ['compact', 'standard'].indexOf(rawUi.density) >= 0 ? rawUi.density : d.ui.density,
    };

    // UI-3 §3.1 模型库：幂等补 profiles；已有条目原样保留（只保证有字符串 id）
    out.profiles = migrateProfiles(raw.profiles);

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
    // 生图适配器：'mock' → OpenAI 兼容；MiniMax 原生接口的旧别名统一成 'minimax-image'。
    // 其它值原样保留（演示模式的 'demo-image' 只活在内存里，刷新后自然消失）。
    const IMAGE_PROVIDER_ALIAS = { mock: 'openai-images', minimax: 'minimax-image', 'minimax-images': 'minimax-image' };
    if (IMAGE_PROVIDER_ALIAS[out.image.provider]) out.image.provider = IMAGE_PROVIDER_ALIAS[out.image.provider];
    out.chat.thinking = (typeof out.chat.thinking === 'string' && out.chat.thinking) ? out.chat.thinking : 'default';
    out.chat.contextWindow = (+out.chat.contextWindow > 0) ? Math.floor(+out.chat.contextWindow) : 0;
    if (typeof out.chat.extraParams !== 'string' && !(out.chat.extraParams && typeof out.chat.extraParams === 'object')) out.chat.extraParams = '';
    if (typeof out.image.extraParams !== 'string' && !(out.image.extraParams && typeof out.image.extraParams === 'object')) out.image.extraParams = '';
    // 参考图开关（v0.12.1）：只认 'prev'，其余一律 'off'（旧档没有这个字段 → 关闭）
    out.image.refMode = (raw.image && raw.image.refMode === 'prev') ? 'prev' : 'off';
    // §5.7：生视频 provider 一律 'minimax-video'（'openai-videos' / 'minimax' 等旧值迁移）
    out.video.provider = 'minimax-video';
    if (typeof out.video.extraParams !== 'string' && !(out.video.extraParams && typeof out.video.extraParams === 'object')) out.video.extraParams = '';
    // 时长 / 分辨率 / 比例的唯一来源 = 面板控件（审查 三·2 双数据源）：
    // 旧迁移曾把这三项折进 extraParams（当时控件下线过一段时间），同名键会盖住下拉框——
    // 「改了没生效」。这里把 extraParams 里的同名键折回控件字段并移除（值不丢，唯一源从此只有控件；
    // providers 的 applyVideoControlParams 同口径，运行时同名键也被控件覆盖）。
    {
      const pick = extractVideoControlParams(out.video.extraParams);
      out.video.extraParams = pick.extraParams;
      if (pick.duration != null) out.video.duration = pick.duration;
      if (pick.resolution != null) out.video.resolution = pick.resolution;
      if (pick.ratio != null) out.video.ratio = pick.ratio;
      const dv = parseInt(out.video.duration, 10);
      out.video.duration = Math.max(4, Math.min(15, Number.isFinite(dv) ? dv : 5));
      out.video.resolution = String(out.video.resolution || '').toUpperCase();
      if (['480P', '768P', '1080P'].indexOf(out.video.resolution) < 0) out.video.resolution = '768P';
      out.video.ratio = String(out.video.ratio || '');
      if (['16:9', '9:16', '1:1'].indexOf(out.video.ratio) < 0) out.video.ratio = '16:9';
    }

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
    const mode = opts.mode || 'choice';         // choice | chat | rp
    // UI-2 §3.2：新建的智能体 / 扮演对话自动起标题（titleAuto），剧情新故事标题来自设定
    const titleAuto = ('titleAuto' in opts)
      ? !!opts.titleAuto
      : (mode === 'chat' || mode === 'rp');
    return {
      schema: SCHEMA,
      id: opts.id || genId(),
      title: opts.title || (titleAuto ? '新对话' : '未命名故事'),
      titleAuto: titleAuto,                   // true = 标题可被自动覆盖（UI-2 §3.2）
      titleGen: +opts.titleGen || 0,          // 已自动生成次数（0 / 1 / 2，§3.3 触发点）
      premise: opts.premise || '',
      mode: mode,
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
      pendingVideos: [],                       // 已提交、未出结果的生视频任务（§5⑤）
    };
  }

  // v1 / 任意旧档 → v2（幂等）
  function migrateStory(raw) {
    if (!raw || typeof raw !== 'object') return null;
    // 先深拷贝再组装：loadStory 拿到的是 MEM 里的「已保存」对象，tree / messages / savepoints 等
    // 若原样透传引用，现场改动会把已保存快照带脏（normVideoFields 还会就地归一）。拷贝一次，两侧解耦。
    raw = JSON.parse(JSON.stringify(raw));
    const out = newStory({ id: raw.id, title: raw.title, premise: raw.premise, mode: raw.mode });
    // UI-2 §3.2：旧存档一律 titleAuto=false（保留现有标题）；只有存档里显式记了才沿用
    out.titleAuto = ('titleAuto' in raw) ? !!raw.titleAuto : false;
    out.titleGen = +raw.titleGen || 0;
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
    out.scenes = Array.isArray(raw.scenes) ? raw.scenes.map(normVideoFields) : [];
    out.lastBg = raw.lastBg || null;
    out.lastSceneSummary = raw.lastSceneSummary || '';
    // §5⑤：已提交未出结果的生视频任务（重启 / 切档后恢复轮询用），原样保留
    out.pendingVideos = Array.isArray(raw.pendingVideos)
      ? raw.pendingVideos.filter(x => x && x.taskId)
      : [];
    if (!out.world.scene && out.lastSceneSummary) out.world.scene = out.lastSceneSummary;
    // 分支树原样透传（schema v3）：这里不校验、不依赖 IR.Tree——合法性与降级重建由 IR.Tree.ensure 负责
    // 视频字段归一同样扫一遍树里的 scenes / entries（§5③：漏了会留下两种字段名并存）
    if (raw.tree) {
      out.tree = raw.tree;
      const tn = out.tree.nodes;
      if (tn && typeof tn === 'object') {
        Object.keys(tn).forEach(id => {
          const n = tn[id];
          if (!n) return;
          (Array.isArray(n.scenes) ? n.scenes : []).forEach(normVideoFields);
          (Array.isArray(n.entries) ? n.entries : []).forEach(normVideoFields);
        });
      }
    }
    // UI-3 §3.2 本对话偏好：透传并清洗（sanitizePrefs 丢未知键、剥凭证）；无 prefs 的旧档不报错
    if (raw.prefs && typeof raw.prefs === 'object') {
      out.prefs = sanitizePrefsSafe(raw.prefs);
    }
    return out;
  }

  // prefs 清洗统一入口：IR.Prefs 缺位时的兜底（只放行白名单键，安全上只会更严）
  function sanitizePrefsSafe(raw) {
    const P = (global.IR && global.IR.Prefs) || null;
    if (P && typeof P.sanitizePrefs === 'function') return P.sanitizePrefs(raw);
    const out = {};
    if (typeof raw.profileId === 'string' && raw.profileId) out.profileId = raw.profileId.trim().slice(0, 64);
    if (typeof raw.profileLabel === 'string' && raw.profileLabel) out.profileLabel = raw.profileLabel.trim().slice(0, 120);
    return out;
  }

  // 视频条目字段归一（§5）：旧档的 poster / videoUrl 就是现在的 thumb / remoteUrl
  function normVideoFields(o) {
    if (!o || typeof o !== 'object') return o;
    if (o.poster && !o.thumb) o.thumb = o.poster;
    if (o.videoUrl && !o.remoteUrl) o.remoteUrl = o.videoUrl;
    return o;
  }

  function migrateLogEntry(e) {
    if (!e || typeof e !== 'object') return e;
    normVideoFields(e);
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

  /* ---------------- 关键依赖自检（审查 可维护性 #9） ----------------
   * 加载顺序错了要「启动即报错」，不能表现为功能悄悄降级：
   *   - IR.Tree    裁剪窗口 / 树遍历（serializeStory / imageIdsOf 的真源），缺了存档口径就错；
   *   - IR.Prefs   凭证清洗真源（stripSecrets）：缺位时导出备份可能带出密钥，不是可降级项；
   *   - IR.Storage 存储后端——浏览器里必须在（缺了会静默退回 localStorage）；Node 评测按设计无它（进程内内存）。
   * IR.Search 是设计内的可选依赖（缺位只跳过搜索索引），不在此列。
   * app.js 对 IR_DEP_MISSING 重新抛出（启动失败），其它 boot 错误照旧降级 localStorage。 */
  function assertDeps() {
    const R = global.IR || {};
    const missing = [];
    if (!R.Tree || !R.Tree.LOG_WINDOW || typeof R.Tree.imageIdsOf !== 'function') missing.push('IR.Tree（tree.js）');
    if (!R.Prefs || typeof R.Prefs.stripSecrets !== 'function') missing.push('IR.Prefs（prefs.js）');
    if (typeof document !== 'undefined' && (!R.Storage || typeof R.Storage.get !== 'function')) {
      missing.push('IR.Storage（storage.js）');
    }
    if (missing.length) {
      const e = new Error('store.js 关键依赖未就绪：' + missing.join('、') + '——请按 ARCHITECTURE.md 的加载顺序先引入');
      e.code = 'IR_DEP_MISSING';
      throw e;
    }
  }

  async function boot() {
    assertDeps();
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
    // 视频用封面（thumb）参与书架缩略图（旧档 poster 作兜底）
    const imgs = (story.log || []).filter(e => (e.type === 'image' && e.thumb) || (e.type === 'video' && (e.thumb || e.poster)));
    if (imgs.length) { const last = imgs[imgs.length - 1]; return safeThumb(last.thumb || last.poster); }
    const sc = (story.scenes || []).filter(s => s && (s.thumb || s.poster));
    if (!sc.length) return null;
    const last = sc[sc.length - 1];
    return safeThumb(last.thumb || last.poster);
  }
  // 缩略图白名单（审查 中危 #12）：导入档案是不可信输入，thumb 只放行 data:/blob: 前缀，
  // 其余（外链、javascript:、带引号的 CSS 注入串）一律丢弃；拼 CSS url() 的一侧还要 JSON.stringify 转义。
  function safeThumb(src) {
    const s = String(src == null ? '' : src);
    return (/^(data|blob):/i.test(s)) ? s : null;
  }
  // 文本进档案；原图不进这里 —— 原图是 Blob，走 images store（见 putImage）
  function serializeStory(story) {
    // 裁剪窗口的唯一口径在 IR.Tree（tree.js 必须先于 store.js 加载；缺了直接报错，不静默用错窗口）
    const T = global.IR && global.IR.Tree;
    if (!T || !T.LOG_WINDOW) throw new Error('IR.Tree 未加载：tree.js 必须先于 store.js（见 ARCHITECTURE 加载顺序）');
    const out = Object.assign({}, story, {
      log: (story.log || []).slice(-T.LOG_WINDOW).map(e => (e.type === 'image' ? Object.assign({}, e, { src: undefined }) : e)),
      // scene 字段是白名单（§5①）：新字段不加会在这里被丢掉
      scenes: (story.scenes || []).slice(-T.SCENE_WINDOW).map(s => ({
        id: s.id, alt: s.alt, prompt: s.prompt, promptRaw: s.promptRaw || '',
        kind: s.kind || undefined,                 // 'video' = 视频场景（其余按图片处理）
        aspect: s.aspect || '', width: s.width || 0, height: s.height || 0,
        styleCardId: s.styleCardId || undefined,   // 每张图记录锚定版本（P4）
        supersededBy: s.supersededBy || undefined,
        thumb: s.thumb || s.poster || null,        // 图片缩略图 / 视频封面（JPEG dataURL）
        imageId: s.imageId || undefined,           // 原图在 IndexedDB images 里的键
        // —— 视频场景（kind:'video'）字段（§5）——
        videoId: s.videoId || undefined,           // 视频 Blob 键（vid:<sceneId>）
        sourceSceneId: s.sourceSceneId || undefined, // 图生才有：首帧来自哪张图
        mode: s.mode || undefined,                 // 'i2v' | 't2v'
        taskId: s.taskId || undefined,             // 云端任务 id（续查用）
        remoteUrl: s.remoteUrl || s.videoUrl || undefined, // 仅降级用（限时链接）
        duration: s.duration || undefined, resolution: s.resolution || undefined,
        ratio: s.ratio || undefined, model: s.model || undefined,
        ts: s.ts,
      })),
      savepoints: (story.savepoints || []).slice(-T.SAVEPOINT_KEEP),   // 存档点最多保留 5 个
    });
    // UI-3 §3.2/§3.4：落盘也走清洗——凭证永远不进故事存档（会被导出 / 分享 / 备份）
    if (story.prefs && typeof story.prefs === 'object') out.prefs = sanitizePrefsSafe(story.prefs);
    else delete out.prefs;
    // 落盘快照一律深拷贝（与 IR.Tree 的「深拷贝存入」同口径）：out 若与在用 story 共享
    // world / tree / messages 引用，mergeWorld 等就地改写会污染「已保存」内存快照，
    // 异步 put 的结构化克隆时机不定还会把未 save 的现场写进库里
    return JSON.parse(JSON.stringify(out));
  }

  /* ---------------- 导出包（UI-3 §3.4：剥凭证 + 附 profileLabel） ----------------
   * 纯函数：images 由调用方（library.js）从 IndexedDB 取回后传入。
   * 安全红线：prefs 只带 profileId（不透明 id）与 profileLabel（仅显示）；
   * 整包再过一遍 stripSecrets，任何层级的 apiKey / key / token / baseUrl 一律剥掉。 */
  function buildStoryPack(st, kind, images, settings) {
    const P = (global.IR && global.IR.Prefs) || null;
    const pack = {
      format: 'ir-story', schema: 2, kind: kind, app: '无限阅读 v0.12.0',
      title: st.title, premise: st.premise, mode: st.mode, styleTone: st.styleTone || '',
      world: st.world, styleCard: st.styleCard || null, rollingStyle: st.rollingStyle || null,
      characterCard: st.characterCard || null,
      createdAt: st.createdAt, updatedAt: st.updatedAt,
      images: images || [],
    };
    if (kind === 'full') {
      // §0/§10：视频条目只留封面 + 说明（videoOmitted），本体与限时链接都不进导出包
      pack.log = (st.log || []).map(e => (e && e.type === 'video')
        ? {
          type: 'video', id: e.id, alt: e.alt || '', thumb: e.thumb || e.poster || null,
          prompt: e.prompt || '', promptRaw: e.promptRaw || '', mode: e.mode || undefined,
          model: e.model || undefined, duration: e.duration || undefined,
          resolution: e.resolution || undefined, ts: e.ts, videoOmitted: true,
        }
        : e);
      pack.messages = st.messages || [];
      pack.summaries = st.summaries || [];
      pack.painterThread = st.painterThread || [];
      pack.userProfile = st.userProfile || [];
      pack.turn = st.turn || 0;
      pack.lastSceneSummary = st.lastSceneSummary || '';
      pack.tree = st.tree || null;   // 分支树（§5⑧）：full 包带整棵树，导入后 ensure 复原分支
    }
    const prefs = P && typeof P.exportPrefs === 'function'
      ? P.exportPrefs(st, settings)
      : (st.prefs && typeof st.prefs.profileId === 'string' && st.prefs.profileId
        ? { profileId: st.prefs.profileId, profileLabel: st.prefs.profileLabel || '' }
        : null);
    if (prefs) pack.prefs = prefs;
    // 兜底剥凭证：整棵树（含 log / tree / world）任意层级的凭证形键名一律去掉
    return P && typeof P.stripSecrets === 'function' ? P.stripSecrets(pack) : pack;
  }
  function saveStory(story) {
    if (!story || !story.id) return false;
    story.updatedAt = Date.now();
    const ok = writeStoryRaw(story.id, serializeStory(story));
    if (!ok) return false;   // 写入失败（超限额）：不更新索引，避免索引与存档不一致
    const idx = listIndex().filter(x => x.id !== story.id);
    idx.push({
      id: story.id,
      title: story.title,
      updatedAt: story.updatedAt,
      thumb: storyThumb(story),
      // UI-2 §3.1：索引条目扩充——书架只读索引，不再对每个故事 loadStory
      mode: story.mode || 'choice',
      turn: +story.turn || 0,
      titleAuto: story.titleAuto === true,
      snippet: storySnippet(story),   // 每次重算（切兄弟 / 重试后会变，不缓存）
    });
    writeKV(KEYS.index, idx);
    // 搜索索引增量重建（防抖约 800ms；js/search.js 已加载才做，纯逻辑层互不依赖）
    if (global.IR && global.IR.Search && typeof global.IR.Search.notifySave === 'function') {
      global.IR.Search.notifySave(story);
    }
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
    // UI-2 §3.1：同步清理搜索文档
    if (global.IR && global.IR.Search && typeof global.IR.Search.drop === 'function') {
      global.IR.Search.drop(id);
    }
  }

  /* ---------------- 索引条目：snippet 与旧索引迁移（UI-2 §3.1） ---------------- */

  // 助手回复纯文本：唯一实现在 IR.plainReply（tree.js，审查 可维护性 三·4），
  // 与 search.js 索引共用同一口径——「JSON 旁白提取」不再有第二份实现
  const plainReplyText = (global.IR && global.IR.plainReply) || function () {
    throw new Error('IR.plainReply 未加载：tree.js 必须先于 store.js（见 ARCHITECTURE 加载顺序）');
  };

  // 最近一条消息摘要（≤60 字，码点）：当前路径末条旁白 / 回复的纯文本，剥掉 JSON 与标记
  function storySnippet(story) {
    if (!story) return '';
    let text = '';
    const tree = story.tree;
    const nodes = tree && tree.nodes;
    const n = (nodes && tree.head) ? nodes[tree.head] : null;
    if (n) {
      const entries = Array.isArray(n.entries) ? n.entries : [];
      for (let i = entries.length - 1; i >= 0 && !text; i--) {
        const e = entries[i];
        if (e && e.type === 'narration' && e.text) text = String(e.text);
      }
      if (!text && n.assistantMsg && n.assistantMsg.content != null) text = plainReplyText(n.assistantMsg.content);
      if (!text && n.action && n.action.text) text = String(n.action.text);
    }
    if (!text) {
      const log = Array.isArray(story.log) ? story.log : [];
      for (let i = log.length - 1; i >= 0 && !text; i--) {
        const e = log[i];
        if (e && e.type === 'narration' && e.text) text = String(e.text);
      }
    }
    text = String(text)
      .replace(/^\[设定\][\s\S]*?\n\n/, '')
      .replace(/^\[玩家行动\]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const a = Array.from(text);
    return a.length > 60 ? a.slice(0, 60).join('') : text;
  }

  // 旧索引条目（缺 mode / turn / titleAuto / snippet）按需 loadStory 补齐并整体回写一次。
  // 幂等：补完后不再触发。坏条目（无 id）与「故事已不存在」的条目剔除并计入 anomalies。
  function ensureIndexComplete() {
    const idx = listIndex();
    let changed = false;
    let patched = 0;
    const anomalies = [];
    const out = [];
    for (const it of idx) {
      if (!it || typeof it !== 'object' || !it.id) {
        changed = true;
        anomalies.push({ id: (it && it.id) || '', reason: 'bad-entry' });
        continue;
      }
      const complete = it.mode != null && it.turn != null
        && typeof it.titleAuto === 'boolean' && it.snippet != null;
      if (complete) { out.push(it); continue; }
      const st = loadStory(it.id);
      if (!st) {
        changed = true;
        anomalies.push({ id: it.id, reason: 'missing-story' });
        continue;
      }
      changed = true;
      patched += 1;
      out.push(Object.assign({}, it, {
        // 显示兜底文案不回写存档：这里只补索引里的展示字段
        title: it.title || st.title || '',
        mode: st.mode || 'choice',
        turn: +st.turn || 0,
        titleAuto: st.titleAuto === true,
        snippet: storySnippet(st),
      }));
    }
    if (changed) writeKV(KEYS.index, out);
    return { patched: patched, total: idx.length, anomalies: anomalies };
  }

  /* ---------------- 原图（Blob） ----------------
   * 大图一律以 Blob 存 IndexedDB，绝不转 base64 塞进普通文本存储。
   * 没有 IndexedDB 时返回 false，调用方退回 dataURL（行为与 v0.2 一致）。 */

  function imageIdsOf(rawStory) {
    const out = [];
    if (!rawStory || typeof rawStory !== 'object') return out;
    (rawStory.scenes || []).forEach(s => {
      if (s && s.imageId) out.push(s.imageId);
      if (s && s.videoId) out.push(s.videoId);
    });
    (rawStory.log || []).forEach(e => {
      if (e && e.type === 'image' && e.imageId) out.push(e.imageId);
      if (e && e.videoId) out.push(e.videoId);
    });
    // 分支树里引用到的图/视频也算（含非当前分支）：漏掉就会在删除故事 /「清理孤儿原图」时
    // **静默删掉别的分支的图**（任务书 §10）。tree 形状的遍历（含 videoId，§5③）只有
    // IR.Tree.imageIdsOf 一份实现，这里只负责 log / scenes——两份实现一旦漂移就是删档级事故。
    if (rawStory.tree) {
      global.IR.Tree.imageIdsOf(rawStory.tree).forEach(x => out.push(x));
    }
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

  /* ---------------- 视频（Blob，§5④） ----------------
   * 与原图共用同一个 images store（键名 vid:<sceneId>，不升 DB 版本）。
   * 不进 blobCache —— 会挤掉图片缓存、占内存；用独立的 1~2 条小缓存。
   * trim 只丢「引用」、绝不 revoke：播放中的 objectURL 不得被回收（同原图的约定）。 */

  const VIDEO_CACHE_MAX = 2;
  const videoBlobCache = new Map();               // videoId → Blob
  const videoUrlCache = new Map();                // videoId → objectURL

  function trimVideoCache(map) {
    while (map.size > VIDEO_CACHE_MAX) {
      const oldest = map.keys().next().value;
      map.delete(oldest);                          // 不 revoke：正在播的 <video> 还拿着这个 URL
    }
  }

  function putVideo(id, blob, meta) {
    if (!id || !blob) return false;
    videoBlobCache.set(id, blob);
    trimVideoCache(videoBlobCache);
    if (!useIDB) return false;
    track(Storage.put('images', id, { blob: blob, meta: meta || {}, at: Date.now() }).catch(persistFail));
    return true;
  }

  async function getVideo(id) {
    if (!id) return null;
    const hot = touch(videoBlobCache, id);
    if (hot !== undefined) return hot;
    if (!useIDB) return null;
    try {
      const rec = await Storage.get('images', id);
      const blob = (rec && rec.blob && typeof rec.blob.size === 'number') ? rec.blob : null;
      if (blob) { videoBlobCache.set(id, blob); trimVideoCache(videoBlobCache); }
      return blob;
    } catch (e) { persistFail(e); return null; }
  }

  // 同步取 objectURL（渲染直接用）：命中缓存直接给；没有就后台取，取到后回调 setImageReadyHandler
  function videoURL(id) {
    if (!id) return null;
    const hot = touch(videoUrlCache, id);
    if (hot !== undefined) return hot;
    if (!useIDB || loading.has(id)) return null;
    loading.add(id);
    getVideo(id).then(blob => {
      loading.delete(id);
      if (!blob) return;
      let url = null;
      try { url = URL.createObjectURL(blob); } catch (_) { return; }
      videoUrlCache.set(id, url);
      trimVideoCache(videoUrlCache);
      if (onImageReadyFn) { try { onImageReadyFn(id); } catch (_) {} }
    }).catch(() => { loading.delete(id); });
    return null;
  }

  function releaseVideo(id) {
    if (!id) return;
    const u = videoUrlCache.get(id);
    if (u) { try { URL.revokeObjectURL(u); } catch (_) {} videoUrlCache.delete(id); }
    videoBlobCache.delete(id);
    if (useIDB) track(Storage.del('images', id).catch(persistFail));
  }

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
      defaultWorld, defaultRollingStyle, defaultSettings, defaultUi, seedWorldFromPremise,
      migrateSettings, migrateProfiles, migrateStory, serializeStory,
      buildStoryPack, sanitizePrefsSafe,
      newStory,
      loadSettings, saveSettings,
      listStories, loadStory, saveStory, deleteStory, storyThumb, safeThumb,
      listIndex, storySnippet, ensureIndexComplete,
      loadUserProfile, saveUserProfile,
      getCurrentId, setCurrentId, loadCurrent,
      migrateLegacy, clearAll,

      // 存储后端（IndexedDB 主库 + 回退）；assertDeps = 关键依赖清单自检（boot 会先跑）
      boot, flush, storageInfo, assertDeps,
      setPersistErrorHandler(fn) { onPersistErrorFn = (typeof fn === 'function') ? fn : null; },
      setImageReadyHandler(fn) { onImageReadyFn = (typeof fn === 'function') ? fn : null; },

      // 原图（Blob）
      imageIdsOf, putImage, getImage, imageURL, releaseImage, releaseImages,
      listImageKeys, knownImageIds,
      // 视频（Blob，键名 vid:<sceneId>，§5④）
      putVideo, getVideo, videoURL, releaseVideo,
    },
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
