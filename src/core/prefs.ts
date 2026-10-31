/*
 * src/core/prefs.ts —— 本对话偏好（设置分层）· 纯逻辑层
 *
 * 职责：
 *   - story.prefs 的清洗（sanitizePrefs）：丢未知键、剥凭证形字段、校验取值；
 *   - 「本对话覆盖 → 全局默认」的解析（effective / effectiveInfo）；
 *   - 主模型配置解析（resolveChatCfg）：profileId 只是引用，绝不携带 apiKey / baseUrl；
 *   - 各模式下「本对话设置」应显示哪些控件（visibleFor）。
 *
 * 硬约束：不碰 DOM、不碰存储、无依赖；Node 里 require 后挂到 global.Prefs。
 */

/* ↑ 阶段 2 搬迁自 src/core/prefs.ts（IIFE → ES module，函数体逐字未动）。
 * 阶段 6：模块间依赖改为静态 import（全局 IR 兼容层已删除）。 */

  /* ---------------- 白名单（规则表 = 唯一真源） ---------------- */

  // story.prefs 的顶层键与页面布局键各有一张规则表，清洗（sanitizePrefs / sanitizeUi）、
  // 全局默认（globalValue）、本对话覆盖（storyOverride）、合并（effectiveInfo）全部从表里取。
  // 加一个键 = 往表里加一行，四处判定自动跟上——不再维护「键名数组 + 四个 switch 清单」两套东西。
  // trigger（出图时机）已下线——旧档 / 旧包里残留的 trigger 按未知键丢弃、不报错。
  // 工具开关键（仅智能体用；true = 跟随全局可用性，false = 本对话关掉）
  const TOOL_KEYS = ['image', 'memory', 'schedule', 'email', 'payment'];

  const CHOICES_VALUES = ['tray', 'always'];
  const LAYOUT_VALUES = ['auto', 'split', 'stack', 'immersive'];
  const FONT_VALUES = ['sm', 'md', 'lg'];
  const WIDTH_VALUES = ['narrow', 'standard', 'wide'];
  const DENSITY_VALUES = ['compact', 'standard'];

  // 凭证形字段名（大小写不敏感，任意嵌套层级一律剥掉）：安全红线
  const SECRET_KEY_RE = /^(api[-_]?key|key|token|base[-_]?url|password|secret|authorization|access[-_]?token|refresh[-_]?token)$/i;

  /* ---------------- 取值判定（规则表用的小工具） ---------------- */

  // 取值器约定：合法 → 收窄后的值；非法 / 缺失 → undefined（调用方据此丢弃或回退默认）
  function oneOf(values) {
    return (v) => (values.indexOf(v) >= 0 ? v : undefined);
  }
  function boolOf(v) {
    return typeof v === 'boolean' ? v : undefined;
  }
  function ratioOf(v) {
    const r = +v;
    return (Number.isFinite(r) && r > 0) ? Math.max(0.28, Math.min(0.72, r)) : undefined;
  }

  /* 页面布局键（story.prefs.ui 与 settings.ui 共用）：
   *   take     —— 校验 + 收窄；undefined = 非法值丢弃（不猜、不兜底）
   *   fallback —— 「跟随全局」时的值（settings.ui 缺这个键时用） */
  const UI_RULES = {
    layout: { take: oneOf(LAYOUT_VALUES), fallback: () => 'auto' },
    splitRatio: { take: ratioOf, fallback: () => 0.5 },
    imageCollapsed: { take: boolOf, fallback: () => false },
    fontScale: { take: oneOf(FONT_VALUES), fallback: () => 'md' },
    width: { take: oneOf(WIDTH_VALUES), fallback: () => 'standard' },
    density: { take: oneOf(DENSITY_VALUES), fallback: () => 'standard' },
  };
  const UI_KEYS = Object.keys(UI_RULES);

  /* story.prefs 顶层键：只留不透明 id / 显示用标签 / 本对话开关 / 嵌套的 tools 与 ui */
  const PREF_RULES = {
    profileId: { take: (v) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 64) : undefined },
    profileLabel: { take: (v) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 120) : undefined },   // 仅作显示，不含密钥
    choices: { take: oneOf(CHOICES_VALUES) },
    showReasoning: { take: boolOf },
    tools: { take: (v) => sanitizeTools(v) },
    ui: { take: (v) => sanitizeUi(v) },
  };

  /* ---------------- 工具分类（prefs.tools 的五个开关 ↔ 工具名） ---------------- */

  function toolCategory(name) {
    const n = String(name || '');
    if (n === 'request_image') return 'image';
    if (n.indexOf('recall_') === 0 || n === 'update_memory') return 'memory';
    if (n.indexOf('schedule_') === 0) return 'schedule';
    if (n === 'email_propose') return 'email';
    if (n === 'payment_propose') return 'payment';
    return 'memory';   // 未知工具归入记忆类（保守：默认可被 prefs.tools.memory 关掉）
  }

  /* ---------------- 清洗（迁移 / 导入共用） ---------------- */

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function stripSecrets(value, depth?) {
    if (value == null || typeof value !== 'object') return value;
    if (depth == null) depth = 0;
    if (depth > 12) return Array.isArray(value) ? [] : {};   // 防环 / 防爆深
    if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1));
    const out = {};
    for (const k of Object.keys(value)) {
      if (SECRET_KEY_RE.test(k)) continue;
      out[k] = stripSecrets(value[k], depth + 1);
    }
    return out;
  }

  function sanitizeTools(raw) {
    const out = {};
    if (!isPlainObject(raw)) return out;
    for (const k of TOOL_KEYS) {
      if (typeof raw[k] === 'boolean') out[k] = raw[k];
    }
    return out;
  }

  function sanitizeUi(raw) {
    const out: any = {};
    if (!isPlainObject(raw)) return out;
    for (const k of UI_KEYS) {
      const v = UI_RULES[k].take(raw[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  // 迁移 / 导入时清洗本对话偏好：
  // ① 按 PREF_RULES 逐键收窄（未知键丢弃，嵌套的 tools / ui 各自再收一遍）；
  // ② 任何形似凭证的字段（任意嵌套）先剥掉；③ 收窄后为空的 tools / ui 不落地。
  function sanitizePrefs(raw) {
    if (!isPlainObject(raw)) return {};
    const src = stripSecrets(raw);          // 先剥凭证，再按白名单收窄
    const out: any = {};
    for (const k of Object.keys(PREF_RULES)) {
      const v = PREF_RULES[k].take(src[k]);
      if (v === undefined) continue;
      if (v && typeof v === 'object' && !Object.keys(v).length) continue;   // 空的 tools / ui
      out[k] = v;
    }
    return out;
  }

  /* ---------------- 解析：本对话覆盖 → 全局默认 ---------------- */

  function globalValue(settings, key) {
    const s = settings || {};
    const ui = (s.ui && isPlainObject(s.ui)) ? s.ui : {};
    if (key.indexOf('ui.') === 0) {
      const rule = UI_RULES[key.slice(3)];
      if (!rule) return undefined;
      const v = rule.take(ui[key.slice(3)]);
      return v !== undefined ? v : rule.fallback();
    }
    switch (key) {
      case 'choices': return s.ui && s.ui.choices === 'always' ? 'always' : 'tray';
      case 'showReasoning': return s.showReasoning !== false;
      case 'tools': {
        const out = {};
        TOOL_KEYS.forEach((k) => { out[k] = true; });   // 跟随全局可用性（sidecar / feature 由运行时求交）
        return out;
      }
      default: return undefined;
    }
  }

  function storyOverride(story, key) {
    const p = (story && isPlainObject(story.prefs)) ? story.prefs : {};
    if (key.indexOf('ui.') === 0) {
      const rule = UI_RULES[key.slice(3)];
      return rule ? rule.take(p.ui && p.ui[key.slice(3)]) : undefined;
    }
    switch (key) {
      case 'profileId': return (typeof p.profileId === 'string' && p.profileId) ? p.profileId : undefined;
      case 'choices': return CHOICES_VALUES.indexOf(p.choices) >= 0 ? p.choices : undefined;
      case 'showReasoning': return typeof p.showReasoning === 'boolean' ? p.showReasoning : undefined;
      case 'tools': {
        const t = sanitizeTools(p.tools);
        return Object.keys(t).length ? t : undefined;
      }
      case 'ui': {
        const u = sanitizeUi(p.ui);
        return Object.keys(u).length ? u : undefined;
      }
      default: return undefined;
    }
  }

  function findProfile(settings, id) {
    const list = (settings && Array.isArray(settings.profiles)) ? settings.profiles : [];
    for (const p of list) {
      if (p && typeof p.id === 'string' && p.id === id) return p;
    }
    return null;
  }

  // 解析单键的有效值：story.prefs 覆盖 → 全局 settings；缺省 = 跟随全局。
  // profileId 找不到对应 profile 时回退默认（'default'），并由 effectiveInfo 给出 missing 标记。
  function effectiveInfo(settings, story, key) {
    if (key === 'profileId') {
      const pid = storyOverride(story, 'profileId');
      if (!pid) return { value: 'default', source: 'default', missing: false };
      if (findProfile(settings, pid)) return { value: pid, source: 'story', missing: false };
      return { value: 'default', source: 'default', missing: true };   // 找不到 → 回退默认 + 标记
    }
    if (key === 'tools') {
      const over = storyOverride(story, 'tools') || {};
      const out = globalValue(settings, 'tools');
      TOOL_KEYS.forEach((k) => {
        if (typeof over[k] === 'boolean') out[k] = over[k];
      });
      return { value: out, source: Object.keys(over).length ? 'story' : 'default', missing: false };
    }
    if (key === 'ui') {
      const over = storyOverride(story, 'ui') || {};
      const out: any = {};
      for (const k of UI_KEYS) out[k] = globalValue(settings, 'ui.' + k);
      Object.assign(out, over);
      return { value: out, source: Object.keys(over).length ? 'story' : 'default', missing: false };
    }
    const over = storyOverride(story, key);
    if (over !== undefined) return { value: over, source: 'story', missing: false };
    return { value: globalValue(settings, key), source: 'default', missing: false };
  }

  function effective(settings, story, key) {
    return effectiveInfo(settings, story, key).value;
  }

  /* ---------------- 主模型配置 ---------------- */

  // 一条主模型配置的字段形状（profile 与 settings.chat 共用）：
  // provider / baseUrl / apiKey / model / temperature / contextWindow / extraParams。
  // 厂商独有的形参（思考档位等）不进这个形状——它们写在 extraParams 里，原样并入请求体。
  function chatShape(src, base, id, name) {
    src = isPlainObject(src) ? src : {};
    base = isPlainObject(base) ? base : {};
    const pick = (k) => {
      const v = src[k];
      if (v == null) return base[k];
      if (typeof v === 'string') return v.trim() ? v : (base[k] != null ? base[k] : v);
      return v;
    };
    return {
      id: id || 'default',
      name: name != null ? name : (id === 'default' ? '默认主模型' : (src.name || '')),
      provider: pick('provider') || 'openai-compatible',
      baseUrl: pick('baseUrl') || '',
      apiKey: pick('apiKey') || '',
      model: pick('model') || '',
      temperature: Number.isFinite(+src.temperature) ? +src.temperature : (Number.isFinite(+base.temperature) ? +base.temperature : 0.9),
      contextWindow: (+src.contextWindow > 0) ? Math.floor(+src.contextWindow) : ((+base.contextWindow > 0) ? Math.floor(+base.contextWindow) : 0),
      extraParams: (src.extraParams != null && src.extraParams !== '') ? src.extraParams : (base.extraParams || ''),
    };
  }

  // 主模型配置解析：story.prefs.profileId → 模型库；找不到 / 未设置 → 默认主模型（settings.chat）。
  // → { cfg, source: 'story'|'default', missing: bool }
  // cfg 里的 id/name 用于 meta.model 与导出显示；绝不写回故事存档（导出走 sanitize）。
  function resolveChatCfg(settings, story) {
    const info = effectiveInfo(settings, story, 'profileId');
    const base = (settings && settings.chat) || {};
    if (info.missing || info.value === 'default') {
      return { cfg: chatShape(base, base, 'default', '默认主模型'), source: 'default', missing: info.missing };
    }
    const p = findProfile(settings, info.value);
    if (!p) return { cfg: chatShape(base, base, 'default', '默认主模型'), source: 'default', missing: true };
    return {
      cfg: chatShape(p, base, p.id, p.name || p.model || p.id),
      source: 'story',
      missing: false,
    };
  }

  // 显示用标签：「名称 · 模型名」（导出附带，仅显示；不含任何密钥 / URL）
  function profileLabel(settings, profileId) {
    if (!profileId || profileId === 'default') {
      const c = (settings && settings.chat) || {};
      return c.model ? ('默认主模型 · ' + c.model) : '默认主模型';
    }
    const p = findProfile(settings, profileId);
    if (!p) return '';
    return (p.name || p.model || p.id) + (p.model ? ' · ' + p.model : '');
  }

  /* ---------------- 本对话设置：各模式可见控件 ---------------- */

  // 控件 id 集合（面板按集合渲染）：
  //   model         模型（下拉：跟随默认 + 模型库）
  //   style         画风入口（仅剧情：跳到全局画风 / 视觉设定卡）
  //   mode          推进模式（仅剧情，只读展示入口）
  //   choices       选项显示（仅剧情）
  //   showReasoning 显示思考过程
  //   tools         工具开关组（仅智能体：生图 / 记忆 / 定时 / 邮件 / 下单）
  //   schedule      定时主动开关（仅扮演：单开关，不是工具组）
  //   characterCard 角色卡入口（仅扮演）
  //   layout        页面布局（剧情：四布局 + 比例 + 舞台收起；扮演 / 智能体：字号 / 宽度 / 密度）
  // v0.11.0：trigger（出图时机）控件已下线，剧情模式作画只剩按钮触发
  const VISIBLE_FOR = {
    choice: ['model', 'style', 'mode', 'choices', 'showReasoning', 'layout'],
    rp: ['model', 'characterCard', 'showReasoning', 'schedule', 'layout'],
    chat: ['model', 'tools', 'showReasoning', 'layout'],
  };

  function visibleFor(mode) {
    const list = VISIBLE_FOR[mode] || VISIBLE_FOR.choice;
    return new Set(list);
  }

  /* ---------------- 导出安全 ---------------- */

  // 导出包里允许出现的 prefs 形状：只有不透明 id 与显示用标签，绝不带凭证。
  function exportPrefs(story, settings) {
    const p = (story && isPlainObject(story.prefs)) ? story.prefs : {};
    if (typeof p.profileId !== 'string' || !p.profileId) return null;
    const label = (typeof p.profileLabel === 'string' && p.profileLabel)
      ? p.profileLabel
      : profileLabel(settings, p.profileId);
    const out: any = { profileId: p.profileId };
    if (label) out.profileLabel = label;
    return out;
  }

  const Prefs = {
    TOOL_KEYS,
    SECRET_KEY_RE,
    toolCategory,
    stripSecrets,
    sanitizePrefs,
    effective, effectiveInfo,
    resolveChatCfg, profileLabel,
    visibleFor,
    exportPrefs,
  };
  export { Prefs };