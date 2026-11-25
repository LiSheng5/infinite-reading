/*
 * 无限阅读 · 自动标题（Titles，纯逻辑，Node 可测）
 *
 * 职责：给聊天对话自动起标题的全部纯逻辑——
 *   needsTitle    什么时候该起标题（titleAuto + 回合触发点）
 *   buildPrompt   发给小模型的 messages（只带最近几轮对话纯文本）
 *   sanitize      清洗模型输出成标题（失败给 fallback）
 *   fallback      本地兜底标题（不发请求）
 *   applyTitle    写回护栏（id 一致 + titleAuto 仍为真才写）
 *
 * 硬约束：零依赖、无 DOM、无网络；以 ES module 导出，Node 里可直接 import。
 */

import { plainReply, stripUserAction } from './tree.ts';

  /* ---------------- 码点安全的小工具 ---------------- */

  function cps(s) { return Array.from(String(s == null ? '' : s)); }
  function clipCp(s, n) {
    const a = cps(s);
    return a.length <= n ? String(s == null ? '' : s) : a.slice(0, n).join('');
  }

  /* ---------------- 纯文本提取（剥 JSON 与标记） ---------------- */

  // 用户话：去掉 [设定] 前缀、[玩家行动] 外壳与（做/说/导演）内层标记。
  // 剥标记走 tree.ts 的 stripUserAction（唯一实现），这里只补标题提示词需要的 trim。
  function userText(raw) {
    return stripUserAction(raw).trim();
  }

  /* ---------------- 系统提示 ---------------- */

  var TITLE_SYSTEM = [
    '给这段对话起一个不超过 15 个字的标题。',
    '只输出标题本身，不要引号、书名号、标点、解释；语言与对话保持一致',
  ].join('\n');

  /* ---------------- needsTitle：触发点 ----------------
   * titleAuto 为真，且：
   *   turn>=1 且还没生成过      → 起第一次
   *   turn>=6 且还没二次生成    → 起第二次
   * 用 >= 而不是 ===：重试 / 切分支 / 导入都会让 turn 跳号，钉死 1 和 6 会让
   * 那几次恰好跳过的对话永远停在「新对话」。titleGen 记已生成次数（失败不计次），
   * 所以补跑最多各一次，同一回合不会重复触发。
   */
  function needsTitle(story) {
    if (!story || story.titleAuto !== true) return false;
    var turn = +story.turn || 0;
    var gen = +story.titleGen || 0;
    if (turn >= 1 && gen < 1) return true;
    if (turn >= 6 && gen < 2) return true;
    return false;
  }

  /* ---------------- buildPrompt：只带最近 3 轮纯文本 ----------------
   * 不带系统提示、世界卡、角色卡全文、工具调用内容；
   * 每条截断到 600 字（码点），超出不加省略号（保证 ≤600）。
   */
  function buildPrompt(messages) {
    var valid = [];
    var arr = Array.isArray(messages) ? messages : [];
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i];
      if (!m || typeof m !== 'object') continue;
      if (m.role !== 'user' && m.role !== 'assistant') continue;   // system / tool 一律不带
      // 助手回复（剧情 JSON / 聊天纯文本）走 tree.ts 的 plainReply（唯一实现）；传 trim 是因为
      // 提示词逐条拼进 messages，多余空白会白占 600 字的截断额度
      valid.push({
        role: m.role,
        content: m.role === 'user' ? userText(m.content) : plainReply(m.content, { trim: true }),
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
  var TRAIL_PUNCT = '。，、,.!?！？；;：:…~～—-·';
  var MD_PREFIX = /^(?:#{1,6}\s*|>\s*|\*\*|__|\*|_|~~|`+)/;

  function sanitize(raw, fallback) {
    var s = String(raw == null ? '' : raw);
    // 首尾空白（含全角空格 / 换行）先收掉；收完还有换行 = 多行解释 → fallback
    s = s.trim();
    if (s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) return fallback;
    // markdown 标记（可能多层）
    for (var i = 0; i < 8; i++) {
      var before = s;
      s = s.replace(MD_PREFIX, '').replace(/(?:\*\*|__|~~|`+)$/, '').trim();
      if (s === before) break;
    }
    // 首尾引号 / 书名号（逐层剥）
    for (var j = 0; j < 8; j++) {
      if (!s) break;
      var changed = false;
      if (QUOTE_CHARS.indexOf(s.charAt(0)) >= 0) { s = s.slice(1); changed = true; }
      if (s && QUOTE_CHARS.indexOf(s.charAt(s.length - 1)) >= 0) { s = s.slice(0, -1); changed = true; }
      if (!changed) break;
      s = s.trim();
    }
    // 结尾标点
    while (s.length && TRAIL_PUNCT.indexOf(s.charAt(s.length - 1)) >= 0) s = s.slice(0, -1);
    // 折叠中间空白（换行已在此前判定过；这里是全角空格 / 连续空格）
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return fallback;
    if (cps(s).length > 20) return clipCp(s, 20) + '…';
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
      return cps(t).length > 15 ? clipCp(t, 15) + '…' : t;
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
    needsTitle: needsTitle,
    buildPrompt: buildPrompt,
    sanitize: sanitize,
    fallback: fallback,
    applyTitle: applyTitle,
  };
  export { Titles };