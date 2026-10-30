/*
 * 无限阅读 · 自动标题（Titles，纯逻辑，Node 可测）
 *
 * 职责：给智能体 / 扮演对话自动起标题的全部纯逻辑——
 *   needsTitle    什么时候该起标题（titleAuto + 回合触发点）
 *   buildPrompt   发给小模型的 messages（只带最近几轮对话纯文本）
 *   sanitize      清洗模型输出成标题（失败给 fallback）
 *   fallback      本地兜底标题（不发请求）
 *   applyTitle    写回护栏（id 一致 + titleAuto 仍为真才写）
 *
 * 硬约束：零依赖、无 DOM、无网络；IIFE 挂 应用层注册表，Node 里 require 也能跑。
 */

/* ↑ 阶段 2 搬迁自 src/core/titles.ts（IIFE → ES module，函数体逐字未动）。
 * 阶段 6：模块间依赖改为静态 import（全局 IR 兼容层已删除）。 */

  /* ---------------- 码点安全的小工具 ---------------- */

  function cps(s) { return Array.from(String(s == null ? '' : s)); }
  function clipCp(s, n) {
    const a = cps(s);
    return a.length <= n ? String(s == null ? '' : s) : a.slice(0, n).join('');
  }

  /* ---------------- 纯文本提取（剥 JSON 与标记） ---------------- */

  // 用户话：去掉 [设定] 前缀、[玩家行动] 标记与（做/说/导演）内层标记（与 src/core/tree.ts 同口径）
  function userText(raw) {
    return String(raw == null ? '' : raw)
      .replace(/^\[设定\][\s\S]*?\n\n/, '')
      .replace(/^\[玩家行动\]\s*/, '')
      .replace(/^（(?:做|说|导演)）/, '')
      .trim();
  }

  // 助手回复：剧情模式是 JSON（narration / 旁白），chat / rp 是纯文本。
  // 解析失败就当纯文本；解析成功优先取旁白，没有旁白字段也退回原文。
  function assistantText(raw) {
    const s = String(raw == null ? '' : raw);
    const t = s.trim();
    if (t.charAt(0) === '{') {
      try {
        const o = JSON.parse(t);
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          const n = o.narration || o.旁白 || o.text || '';
          if (n) return String(n).trim();
          if (Array.isArray(o.choices) && o.choices.length) {
            return o.choices.map(function (c) { return String(c); }).join(' ');
          }
        }
      } catch (_) { /* 坏 JSON：当纯文本 */ }
    }
    return s.trim();
  }

  /* ---------------- 3.3 系统提示 ---------------- */

  var TITLE_SYSTEM = [
    '给这段对话起一个不超过 15 个字的标题。',
    '只输出标题本身，不要引号、书名号、标点、解释；语言与对话保持一致',
  ].join('\n');

  /* ---------------- needsTitle：触发点 ----------------
   * titleAuto 为真，且：
   *   turn===1 且还没生成过      → 起第一次
   *   turn===6 且还没二次生成    → 起第二次
   * 其余回合一律不触发（titleGen 记已生成次数，失败不计次）。
   */
  function needsTitle(story) {
    if (!story || story.titleAuto !== true) return false;
    var turn = +story.turn || 0;
    var gen = +story.titleGen || 0;
    if (turn === 1 && gen < 1) return true;
    if (turn === 6 && gen < 2) return true;
    return false;
  }

  /* ---------------- buildPrompt：只带最近 3 轮纯文本 ----------------
   * 不带系统提示、世界卡、角色卡全文、工具调用内容；
   * 每条截断到 600 字（码点），超出不加省略号（保证 ≤600）。
   */
  function buildPrompt(messages, mode) {
    var valid = [];
    var arr = Array.isArray(messages) ? messages : [];
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i];
      if (!m || typeof m !== 'object') continue;
      if (m.role !== 'user' && m.role !== 'assistant') continue;   // system / tool 一律不带
      valid.push({
        role: m.role,
        content: m.role === 'user' ? userText(m.content) : (assistantText as any)(m.content, mode),
      });
    }
    var slice = valid.slice(-6);   // 最近 3 轮 = 最多 6 条（用户话 + 助手回复）
    var out = [{ role: 'system', content: TITLE_SYSTEM }];
    for (var j = 0; j < slice.length; j++) {
      out.push({ role: slice[j].role, content: clipCp(slice[j].content, 600) });
    }
    return out;
  }

  /* ---------------- sanitize：清洗模型输出 ----------------
   * 去首尾引号 / 《》/ markdown 标记 / 换行 / 结尾标点；
   * 按 Unicode 码点计，超过 20 截断加「…」；
   * 空或多行（明显不是标题）→ 用 fallback。
   */
  var QUOTE_CHARS = '"\'`「」『』《》〈〉“”‘’„‟';
  var TRAIL_PUNCT = '。，、，,.!?！？；;：:…~～—-·';
  var MD_PREFIX = /^(?:#{1,6}\s*|>\s*|\*\*|__|\*|_|~~|`+)/;

  function sanitize(raw, fallback) {
    var s = String(raw == null ? '' : raw);
    // 首尾空白（含换行）先收掉；收完还有换行 = 多行解释 → fallback
    s = s.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '');
    if (s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) return fallback;
    // markdown 标记（可能多层）
    for (var i = 0; i < 8; i++) {
      var before = s;
      s = s.replace(MD_PREFIX, '').replace(/(?:\*\*|__|~~|`+)$/, '');
      s = s.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '');
      if (s === before) break;
    }
    // 首尾引号 / 书名号（逐层剥）
    for (var j = 0; j < 8; j++) {
      if (!s) break;
      var c0 = s.charAt(0), c1 = s.charAt(s.length - 1);
      var changed = false;
      if (QUOTE_CHARS.indexOf(c0) >= 0) { s = s.slice(1); changed = true; }
      if (s && QUOTE_CHARS.indexOf(s.charAt(s.length - 1)) >= 0) { s = s.slice(0, -1); changed = true; }
      if (!changed) break;
      s = s.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '');
    }
    // 结尾标点
    while (s.length && TRAIL_PUNCT.indexOf(s.charAt(s.length - 1)) >= 0) s = s.slice(0, -1);
    // 折叠中间空白（换行已在此前判定过；这里是全角空格 / 连续空格）
    s = s.replace(/[\s\u3000]+/g, ' ').replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '');
    if (!s) return fallback;
    var a = cps(s);
    if (a.length > 20) return a.slice(0, 20).join('') + '…';
    return s;
  }

  /* ---------------- fallback：本地兜底 ----------------
   * 首条用户消息的前 15 个字（码点）+「…」（超长才加）；没有则「新对话」。
   * 纯括号占位（如开局的「（故事开场。请描写第一幕…）」）不当用户话，跳过。
   */
  function fallback(story) {
    var arr = (story && Array.isArray(story.messages)) ? story.messages : [];
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i];
      if (!m || m.role !== 'user') continue;
      var t = userText(m.content);
      if (!t) continue;
      if (/^（[^（）]*）$/.test(t)) continue;   // 占位话术（开局 / 系统注入），不当标题素材
      var a = cps(t);
      return a.length > 15 ? a.slice(0, 15).join('') + '…' : t;
    }
    return '新对话';
  }

  /* ---------------- applyTitle：写回护栏 ----------------
   * 只有 story.id 与 id 一致、且 titleAuto 仍为真（用户没改过名）才写；
   * opts.force = 手动「重新生成标题」，跳过 titleAuto 检查（调用方负责收掉 titleAuto）。
   */
  function applyTitle(story, id, title, opts) {
    if (!story || !id || story.id !== id) return false;
    var force = !!(opts && opts.force);
    if (!force && story.titleAuto !== true) return false;
    var t = String(title == null ? '' : title).trim();
    if (!t) return false;
    story.title = t;
    story.titleGen = (+story.titleGen || 0) + 1;
    return true;
  }

  const Titles = {
    TITLE_SYSTEM: TITLE_SYSTEM,
    needsTitle: needsTitle,
    buildPrompt: buildPrompt,
    sanitize: sanitize,
    fallback: fallback,
    applyTitle: applyTitle,
  };
  export { Titles };