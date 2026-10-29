/*
 * src/app/turn.js —— AI1 剧情回合 / 书记员模型任务 / 工具护栏 / 重试与分支（兄弟切换）
 * 从 src/app/main.js 拆出（只搬家，不改行为）。
 */
// 阶段 5 第 5 步：切兄弟的过渡收编进过渡内核（runTransition）。本文件仍是 legacy IIFE，
// 但经 src/main.js 以 ES module 装载（src/app/main.js 同款），顶层 import 合法；
// 三档 kind / 时长的唯一声明处仍是 src/core/motion.ts 的 TRANSITIONS.sibling。
// 命名空间导入 + VT.runTransition 点名调用：tools/check-free-calls.mjs 的裸调用启发式
// （抓「搬家后忘改 A.xxx」）认得 import 绑定，跨模块调用与 A.xxx 同口径。
import * as VT from '../../src/ui/viewTransition.js';

import { Context } from '../core/context.ts';
import { ChatProviders } from '../core/providers.ts';
import { Tree } from '../core/tree.ts';
import { A } from './core.js';


  const S = A.state;
  const { $, Store, SCRIBE_SYSTEM, SCRIBE_COMPRESS_SYSTEM, SCRIBE_ROLLING_SYSTEM, isStopError, setSendButtonsBusy, motionLevel, motionMs, toast, netErrHint, saveAll, resolveSub } = A;

  function parseAIReply(raw) {
    const text = String(raw || '').trim();
    // 宽容解析（裸换行 / 截断 / 围栏都能救）：剧情模式中文键契约（v0.3）经
    // normalizeAIReply 映射回内部英文结构；坏包不直接展示给玩家
    const j = Context.normalizeAIReply(Context.tolerantJSONParse(text));
    if (j) {
      return {
        narration: String(j.narration || '').trim(),
        choices: Array.isArray(j.choices) ? j.choices.filter(Boolean).map(String).slice(0, 3) : [],
        scene_change: !!j.scene_change,
        scene_summary: String(j.scene_summary || '').trim(),
        world: (j.world && typeof j.world === 'object') ? j.world : null,
        tool_calls: Array.isArray(j.tool_calls) ? j.tool_calls : [],
      };
    }
    // chat / rp：纯文本契约（2026-10-07 定案）——正文本身就是回复，不做「像 JSON 却坏了」的判错，
    // 否则正文里出现一个「{」就会被误判成坏包（这两个模式已不再要求模型输出 JSON）
    if (S.story && (S.story.mode === 'chat' || S.story.mode === 'rp')) {
      return { narration: text, choices: [], scene_change: false, scene_summary: '', world: null, tool_calls: [], plainText: true };
    }
    // 兜底：完全不是 JSON 的（模型没按格式来）→ 原文当旁白，fail-open；
    // 看着像 JSON 却解析不了（常见于模型写到一半转去调工具）→ 交给 callAI1 当「没写正文」处理
    const looksJson = /\{/.test(text) || /^\s*```json/i.test(text);
    return { narration: text, choices: [], scene_change: false, scene_summary: '', parseFailed: true, looksJson: looksJson };
  }

  // 归档形状 / 工具吸收的唯一口径在 Context（审查 可维护性 二·10）：
  // assistant 消息内容 = Context.slimReply 的 JSON；applyToolCall 只是转接，
  // 评测（eval/run.js）走同一实现，字段不会再漂移。
  // 画像门控 = applyProfile 注入点（这里给 A.applyProfileEntries：关开关即停止收集，§4.12）。
  function applyToolCall(c) {
    Context.absorbToolCalls(S.story, [c], { applyProfile: A.applyProfileEntries });
  }

  function absorbReply(reply) {
    if (reply.world) Context.mergeWorld(S.story.world, reply.world);
    if (Array.isArray(reply.tool_calls)) for (const c of reply.tool_calls) applyToolCall(c);
    // chat / rp 纯文本没有 scene_summary：拿旁白原文当画面参考，免得「🎨 作画」越画越旧
    if (S.story && (S.story.mode === 'chat' || S.story.mode === 'rp') && !reply.scene_summary && reply.narration) {
      S.story.lastSceneSummary = String(reply.narration).replace(/\s+/g, ' ').slice(0, 120);
    }
  }

  // 书记员是否可用于「模型任务」（压缩摘要 / 滚动风格摘要）：
  // 开关开启 + 书记员已启用 + 配了模型与适配器
  function scribeUsable() {
    const sc = S.settings.scribe || {};
    if (!sc.aiTasks || !sc.enabled) return false;
    const cfg = resolveSub('scribe');
    if (!cfg.provider || !cfg.model) return false;
    return !!ChatProviders[cfg.provider];
  }

  // 书记员（C-B）：每 N 回合校对世界卡（压缩触发时由 runSmartCompress 顺带完成）；失败时用本地规则兜底
  async function runScribe() {
    let result = null;
    try {
      const cfg = resolveSub('scribe');
      if (cfg.provider && cfg.model) {
        const recent = S.story.log.filter(l => l.type === 'narration').slice(-12).map(l => '· ' + l.text).join('\n');
        const said = S.story.log.filter(l => l.type === 'player' || l.type === 'choice').slice(-12).map(l => '· ' + l.text).join('\n');
        const raw = await ChatProviders[cfg.provider].chat(cfg, [
          { role: 'system', content: SCRIBE_SYSTEM },
          {
            role: 'user',
            content: '[当前世界卡]\n' + Context.worldCardText(S.story.world)
              + '\n\n[最近剧情]\n' + (recent || '（无）')
              + '\n\n[玩家最近说过的话]\n' + (said || '（无）')   // R13：画像提取的来源
              + '\n\n' + A.scribeProfileHint(),
          },
        ]);
        result = parseScribe(raw);
      }
    } catch (_) { result = null; }
    if (!result) result = Context.localScribe(S.story.world);
    // 书记员是整卡重写（最终仲裁）：允许空数组清空
    if (result.world) Context.mergeWorld(S.story.world, result.world, { allowEmpty: true });
    if (result.profile && result.profile.length) A.applyProfileEntries(result.profile);   // R13：顺手提取的画像
    S.story.world.scribeAt = Date.now();
    S.story.log.push({ type: 'tool', tool: 'scribe', summary: (result.diff || []).join('；') || '书记员校对完成', ts: Date.now() });
  }

  function parseScribe(raw) {
    const s = String(raw || '');
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i !== -1 && j > i) {
      try {
        const o = JSON.parse(s.slice(i, j + 1));
        return {
          world: (o.world && typeof o.world === 'object') ? o.world : null,
          profile: Array.isArray(o.profile) ? o.profile : [],   // R13：顺手提取的画像条目
          diff: Array.isArray(o.diff) ? o.diff.map(String) : [],
        };
      } catch (_) {}
    }
    return null;
  }

  /* ---------------- 书记员模型任务（压缩 / 滚动风格摘要） ----------------
   * 真实模式：书记员一次调用同时「压缩 + 校对」（§4.10 C-B）、出图后顺手更新滚动风格摘要（C-F）；
   * 开关关闭、调用失败 → 一律退回本地确定性规则。 */

  // 待压缩原回合 → 书记员输入（按幕分组，越靠前越旧）
  function buildCompressInput(groups) {
    const parts = ['[当前世界状态卡]\n' + Context.worldCardText(S.story.world)];
    parts.push('[待压缩的原回合]（按幕分组，越靠前越旧）');
    let n = (S.story.summaries || []).length;
    for (const grp of groups) {
      n += 1;
      parts.push('—— 第 ' + n + ' 幕 ——');
      for (let i = 0; i < grp.length; i += 2) {
        const um = grp[i], am = grp[i + 1];
        if (um) {
          const t = String(um.content || '').replace(/^\[设定\][\s\S]*?\n\n/, '').replace(/^\[玩家行动\]\s*/, '');
          parts.push('玩家：' + t);
        }
        if (am) {
          let j = {};
          try { j = JSON.parse(am.content); } catch (_) {}
          parts.push('旁白：' + (j.narration || ''));
          if (j.scene_change) parts.push('（此处场景切换）');
        }
      }
    }
    parts.push('', A.scribeProfileHint());   // R13：压缩顺手提取画像
    return parts.join('\n');
  }

  function parseScribeCompress(raw) {
    const s = String(raw || '');
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i === -1 || j <= i) return null;
    let o = null;
    try { o = JSON.parse(s.slice(i, j + 1)); } catch (_) { return null; }
    if (!o || typeof o !== 'object') return null;
    return {
      summaries: Array.isArray(o.summaries) ? o.summaries.filter(Boolean).map(String) : [],
      world: (o.world && typeof o.world === 'object') ? o.world : null,
      profile: Array.isArray(o.profile) ? o.profile : [],   // R13
      diff: Array.isArray(o.diff) ? o.diff.map(String) : [],
    };
  }

  // 模型压缩（C-B 双职）：返回 null 表示「未触发 / 不可用 / 失败」→ 调用方走本地兜底
  async function runSmartCompress() {
    if (!S.story || !scribeUsable()) return null;
    const plan = Context.planCompression(S.story, { contextWindow: A.chatContextWindow() });
    if (!plan) return null;
    const cfg = resolveSub('scribe');
    const raw = await ChatProviders[cfg.provider].chat(cfg, [
      { role: 'system', content: SCRIBE_COMPRESS_SYSTEM },
      { role: 'user', content: buildCompressInput(plan.groups) },
    ]);
    const parsed = parseScribeCompress(raw);
    if (!parsed || !parsed.summaries.length) return null;

    S.story.summaries = (S.story.summaries || []).concat(parsed.summaries);
    S.story.messages = S.story.messages.slice(plan.candidate.length);
    Context.trimSummaries(S.story.summaries, Context.DEFAULT_MAX_SUMMARIES);
    if (parsed.world) Context.mergeWorld(S.story.world, parsed.world, { allowEmpty: true });
    if (parsed.profile && parsed.profile.length) A.applyProfileEntries(parsed.profile);   // R13
    S.story.world.scribeAt = Date.now();
    S.story.log.push({
      type: 'tool', tool: 'scribe',
      summary: '压缩 ' + parsed.summaries.length + ' 幕 + 校对：' + ((parsed.diff || []).join('；') || '无事实变更'),
      ts: Date.now(),
    });
    return { compressedTurns: parsed.summaries.length, messagesRemoved: plan.candidate.length };
  }

  function parseRollingStyle(raw) {
    const s = String(raw || '');
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i === -1 || j <= i) return null;
    let o = null;
    try { o = JSON.parse(s.slice(i, j + 1)); } catch (_) { return null; }
    if (!o || typeof o !== 'object') return null;
    const out = {};
    for (const k of ['style', 'scenes', 'wardrobe']) if (o[k]) out[k] = String(o[k]).slice(0, 240);
    return Object.keys(out).length ? out : null;
  }

  // 出图后：真实模式让书记员顺手更新滚动风格摘要（§4.10 C-F）；失败保留本地规则结果，不打断流程
  async function refreshRollingStyleByModel(scene) {
    if (!S.story || !scene || !scribeUsable()) return;
    const sid = S.story.id;
    const cfg = resolveSub('scribe');
    const cur = Context.rollingStyleText(S.story.rollingStyle);
    const card = S.story.styleCard;
    try {
      const raw = await ChatProviders[cfg.provider].chat(cfg, [
        { role: 'system', content: SCRIBE_ROLLING_SYSTEM },
        {
          role: 'user',
          content: '[现有滚动风格摘要]\n' + (cur || '（无）')
            + '\n\n[锚定视觉设定卡]\n' + ((card && card.locked !== false) ? Context.styleCardText(card) : '（未锚定）')
            + '\n\n[刚出的这张图]\nalt：' + (scene.alt || '') + '\nprompt：' + (scene.prompt || ''),
        },
      ]);
      const rs = parseRollingStyle(raw);
      if (!rs || !S.story || S.story.id !== sid) return;    // 中途换档 / 回档：丢弃结果
      const target = S.story.rollingStyle = Object.assign(Store.defaultRollingStyle(), S.story.rollingStyle || {});
      if (rs.style) target.style = rs.style;
      if (rs.scenes) target.scenes = rs.scenes;
      if (rs.wardrobe) target.wardrobe = rs.wardrobe;
      target.updatedAt = Date.now();
      saveAll();
      if (!$('#modal-settings').classList.contains('hidden') || !$('#story-prefs').classList.contains('hidden')) A.renderStoryPanels();
    } catch (_) { /* 保留本地规则结果 */ }
  }

  // 每回合收尾：压缩链（C-A/C-C）+ 书记员（C-B）
  async function postTurn() {
    if (!S.story) return;
    let comp = null;
    // 真实模式：书记员一次调用做「压缩 + 校对」（C-B 双职）
    if (scribeUsable()) {
      try { comp = await runSmartCompress(); } catch (_) { comp = null; }
    }
    if (!comp) {
      // 未触发 / 失败：本地确定性摘要器兜底（不花 API）
      try {
        comp = Context.compressStory(S.story, {
          summarize: Context.localSummarize,
          contextWindow: A.chatContextWindow(),   // T-M-1：登记表 / 手填容量 → 70% 阈值
        });
      } catch (_) { comp = null; }
      if (comp) S.story.log.push({ type: 'tool', tool: 'compress', summary: comp.compressedTurns + ' 幕压入摘要栈', ts: Date.now() });
      // 本地压缩没有重写世界卡：按每 N 回合单独校对
      const every = Math.max(1, +S.settings.scribe.every || 10);
      if (S.settings.scribe.enabled && S.story.turn > 0 && S.story.turn % every === 0) {
        await runScribe();
      }
    }
    // R13 用户画像：真实模式由书记员顺手提取（上面两条路径）；失败退回本地规则
    if (A.profileOn() && !scribeUsable()) A.collectProfileLocal();
    saveAll();
    A.renderChat();
    if (!$('#modal-settings').classList.contains('hidden') || !$('#story-prefs').classList.contains('hidden')) A.renderStoryPanels();
  }

  // 思考链入库前截断（长链只留前 4000 字，控住 localStorage 体积；渲染照常可折叠）
  // 旁白条目 / assistant 条目：唯一口径在 Context.narrationEntry / assistantEntry（二·10）
  function pushNarrationEntry(text, reasoning) {
    S.story.log.push(Context.narrationEntry(text, reasoning));
  }

  function assistantMessage(reply, reasoning) {
    return Context.assistantEntry(reply, reasoning);
  }

  // 流式清洗：从累积的 JSON 文本里抠出旁白可读部分
  function cleanStream(s) {
    return String(s)
      .replace(/^\s*```(?:json)?/i, '')
      .replace(/^\s*\{\s*"(?:旁白|narration)"\s*:\s*"/, '')
      .replace(/\\n/g, '\n').replace(/\\"/g, '"')
      .replace(/",\s*"(?:人物|地点|时间|伏笔|画面|场景切换|选项|choices|scene_change|scene_summary|world)"[\s\S]*$/, '');
  }

  /* ---------- 流式文字逐段淡入（UI-1 §4.2） ----------
   * 只对「可见文字的增量」动（cleanStream 之后），不给原始 JSON 碎片做动画：
   * 新增文字包进 span.delta（createElement + textContent）套 fadeIn；
   * 存活 span 超过 DELTA_MAX_SPANS 时把更早的合并进一个前缀文本节点；
   * 流结束（finishNarration）整体合并成单个文本节点。
   * standard 档只对整个气泡做一次淡入（见 style.css 的 .bubble-live）；off 档无。 */
  const DELTA_MAX_SPANS = 200;
  let liveDeltaSpans = [];    // 当前气泡里存活的 span.delta
  let liveDeltaMerged = null; // 已合并的前缀文本节点（更早的文字都在这里）
  let liveDeltaText = '';     // 当前已显示的可见全量文字

  function resetLiveDelta() {
    liveDeltaSpans = [];
    liveDeltaMerged = null;
    liveDeltaText = '';
  }

  // 超额的 span 合并进前缀文本节点：DOM 里始终最多约 DELTA_MAX_SPANS 个 span
  function trimLiveDeltaSpans(el, keep) {
    const n = liveDeltaSpans.length - keep;
    if (n <= 0) return;
    for (let i = 0; i < n; i++) {
      const span = liveDeltaSpans[i];
      if (!liveDeltaMerged) {
        liveDeltaMerged = document.createTextNode('');
        el.insertBefore(liveDeltaMerged, el.firstChild);
      }
      liveDeltaMerged.nodeValue += span.textContent;
      if (span.parentNode) span.parentNode.removeChild(span);
    }
    liveDeltaSpans.splice(0, n);
  }

  // 流结束：整体合并成单个文本节点
  function finishLiveDelta(el) {
    if (el && liveDeltaText) el.textContent = liveDeltaText;
    resetLiveDelta();
  }

  function appendLiveDelta(el, fullText) {
    const level = motionLevel();
    if (level !== 'rich') {
      // standard / off：不做逐段淡入（standard 由 CSS 对整个气泡做一次淡入）
      el.textContent = fullText;
      liveDeltaText = fullText;
      return;
    }
    if (el.querySelector && el.querySelector('.gen-pill')) {
      // 「生成中…」占位：清掉再从头铺增量
      el.textContent = '';
      liveDeltaSpans = [];
      liveDeltaMerged = null;
      liveDeltaText = '';
    } else if (!liveDeltaText && el.textContent) {
      liveDeltaText = el.textContent;   // renderChat 重建过气泡：先接上已显示的文字
    }
    if (liveDeltaText && fullText.indexOf(liveDeltaText) !== 0) {
      // 非前缀增长（流式清洗的边界情形，如转义跨块）：整段重建，不做动画
      el.textContent = fullText;
      liveDeltaSpans = [];
      liveDeltaMerged = null;
      liveDeltaText = fullText;
      return;
    }
    const delta = fullText.slice(liveDeltaText.length);
    liveDeltaText = fullText;
    if (!delta) return;
    const span = document.createElement('span');
    span.className = 'delta';
    span.textContent = delta;
    el.appendChild(span);
    liveDeltaSpans.push(span);
    if (liveDeltaSpans.length > DELTA_MAX_SPANS) trimLiveDeltaSpans(el, DELTA_MAX_SPANS);
  }

  // 流式思考链（方案 B）：写进固定小窗，并始终滚到最新——点开看全量也不暂停
  function updateLiveReasoning() {
    if (!S.live) return;
    const el = $('#chat-scroll').querySelector('.reason-live-text');
    if (!el) { A.renderChat(); return; }
    el.textContent = S.live.reasoning || '';
    const panel = el.parentElement;
    if (panel) panel.scrollTop = panel.scrollHeight;
    A.scrollChatBottom();
  }

  /* ---------- P5-1 工具护栏：显式 400 拒绝 tools 的模型记住后不再下发（§4.5） ---------- */

  function noToolsKey(cfg) {
    return String((cfg && cfg.baseUrl) || '').replace(/\/+$/, '') + '|' + String((cfg && cfg.model) || '');
  }
  function noToolsFor(cfg) {
    return (S.settings.noTools || []).some(x => noToolsKey(x) === noToolsKey(cfg));
  }
  function rememberNoTools(cfg) {
    if (!cfg || !cfg.model) return;
    S.settings.noTools = (S.settings.noTools || []).filter(x => noToolsKey(x) !== noToolsKey(cfg));
    S.settings.noTools.push({ baseUrl: String(cfg.baseUrl || ''), model: String(cfg.model || ''), at: Date.now() });
    if (S.settings.noTools.length > 20) S.settings.noTools = S.settings.noTools.slice(-20);
    saveAll();
    renderNoToolsHint();
  }
  function renderNoToolsHint() {
    const el = $('#s-notools-hint');
    if (!el) return;
    const list = S.settings.noTools || [];
    el.textContent = list.length
      ? ('已记住 ' + list.length + ' 个不接受 tools 的模型（只存在你这台机器）：' + list.map(x => x.model).join('、') +
        '。它们自动走无工具模式，靠常驻摘要 + 按需召回（注入记忆）兜底。')
      : '尚无模型因不接受 tools 被降级。';
  }
  // 「模型不接受 tools」判定：必须排除参数用法类 400（如 DeepSeek 思考模式不支持 tool_choice）
  function isToolsRejection(e) {
    const msg = ((e && e.message) || '').toLowerCase();
    if (!/http 400/.test(msg)) return false;
    if (/tool_choice|thinking mode/.test(msg)) return false;
    return /tool|function/.test(msg);
  }
  // 归一化成 [{ name, args }]（流式 tool_calls 与回包内嵌的同名字段都算）
  function toolList(calls) {
    const out = [];
    for (const c of (calls || [])) {
      const fn = (c && c.function) ? c.function : c;
      const name = (fn && fn.name) || '';
      if (!name) continue;
      let args = {};
      try { args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments || {}); } catch (_) { args = {}; }
      out.push({ name, args, raw: c });
    }
    return out;
  }
  // 单次请求（流式写进 live 气泡）：带 tools 被显式 400 拒绝 → 记住该 baseUrl+model 并降级重发一次
  async function streamAI1(adapter, cfg, messages, hooks) {
    let preview = '';
    let text = '';
    let streamed = false;
    try {
      text = await adapter.chat(cfg, messages, {
        onDelta(piece) {
          streamed = true;
          preview += piece;
          if (!S.live) S.live = { text: '', reasoning: '' };
          S.live.text = cleanStream(preview);
          if (!S.liveEl) S.liveEl = $('#chat-scroll').querySelector('.bubble-live');
          if (S.liveEl) appendLiveDelta(S.liveEl, S.live.text);   // UI-1 §4.2：只给可见增量做逐段淡入
          // 正文已开始流式 → 思考窗卷成一行（方案 B：不推走正文，也不骤折）
          if (S.liveReasonEl && !S.liveReasonCollapsed) {
            S.liveReasonCollapsed = true;
            S.liveReasonEl.classList.add('collapsed');
          }
          A.scrollChatBottom();
        },
        onReasoning(piece) { if (hooks && hooks.onReasoning) hooks.onReasoning(piece); },
        onToolCalls(calls) { if (hooks && hooks.onToolCalls) hooks.onToolCalls(calls); },
        onAborter(ctrl) { S.chatAbortCtrl = ctrl; },   // P0-1：「停止」按钮中断当前请求
      });
    } catch (e) {
      if (isStopError(e)) throw e;   // P0-1：用户主动停止——不再降级重试，直接上抛
      if (cfg.tools && /HTTP 400/.test((e && e.message) || '')) {
        if (isToolsRejection(e)) {
          rememberNoTools(cfg);
          toast('该模型不接受 tools 参数：已记住并降级为无工具模式（摘要 + 手动注入照常可用）', false, true);
        }
        const cfg2 = Object.assign({}, cfg);
        delete cfg2.tools;
        return streamAI1(adapter, cfg2, messages, hooks);
      }
      // 流式失败时兜底走一次非流式（思考链照常经 hooks 回传；中断能力照常接上）
      const fbHooks = (hooks && hooks.onReasoning)
        ? { onReasoning: hooks.onReasoning, onAborter(ctrl) { S.chatAbortCtrl = ctrl; } }
        : { onAborter(ctrl) { S.chatAbortCtrl = ctrl; } };
      text = await adapter.chat(cfg, messages, fbHooks);
      streamed = false;
    }
    return { text, streamed };
  }

  /* ================= 重试与分支（R1 / §4.2、§4.3） ================= */

  function lastNarration() {
    if (!S.story) return null;
    for (let i = S.story.log.length - 1; i >= 0; i--) if (S.story.log[i].type === 'narration') return S.story.log[i];
    return null;
  }
  function lastNarrationIndex() {
    if (!S.story) return -1;
    for (let i = S.story.log.length - 1; i >= 0; i--) if (S.story.log[i].type === 'narration') return i;
    return -1;
  }
  function lastActionEntry() {
    if (!S.story) return null;
    for (let i = S.story.log.length - 1; i >= 0; i--) {
      const t = S.story.log[i].type;
      if (t === 'player' || t === 'choice') return S.story.log[i];
    }
    return null;
  }
  // 选项只随 assistantMsg 存档（slimReply 的 JSON）：切分支 / 载入后从 head 的 assistantMsg 恢复（§4.3）
  function choicesFromMsg(msg) {
    if (!msg || typeof msg.content !== 'string') return [];
    try {
      const j = JSON.parse(msg.content);
      return Array.isArray(j.choices) ? j.choices.filter(Boolean).map(String).slice(0, 3) : [];
    } catch (_) { return []; }
  }
  function choicesFromHead() {
    const t = S.story && S.story.tree;
    return (t && t.nodes && t.nodes[t.head]) ? choicesFromMsg(t.nodes[t.head].assistantMsg) : [];
  }
  function treeHeadNodeId() {
    return (S.story && S.story.tree && S.story.tree.head) || null;
  }
  // 这个 log 条目属于哪个节点（§4.4 锚点）：node.entries 与 story.log 是同一批对象（project 按引用共享）
  function nodeIdOwningEntry(entry) {
    const t = S.story && S.story.tree;
    if (!t || !t.nodes || !entry) return null;
    for (const id of Object.keys(t.nodes)) {
      if ((t.nodes[id].entries || []).indexOf(entry) >= 0) return id;
    }
    return null;
  }
  // 图所属的节点：条目可能已滑出可见 log 窗口（末 120 条），按 node.scenes 里的 scene id 再找一遍
  function nodeIdOwningScene(sceneId) {
    const t = S.story && S.story.tree;
    if (!t || !t.nodes || !sceneId) return null;
    for (const id of Object.keys(t.nodes)) {
      if ((t.nodes[id].scenes || []).some(s => s && s.id === sceneId)) return id;
    }
    return null;
  }

  /* ================= 重试 = 新增兄弟（§4.2） / 兄弟切换（§4.3） ================= */

  async function retryLast() {
    if (S.busy || !S.story) return;
    const tree = S.story.tree;
    const old = tree && tree.nodes && tree.nodes[tree.head];
    // §4.2：重试是在父节点下新增兄弟；当前 head 必须是已结算的回合节点
    if (!old || old.kind !== 'turn' || !old.sealed || !old.action) { toast('还没有可以重试的回合'); return; }
    const act = old.action;
    const isRetryOpening = act.type === 'opening';
    const sent = act.sent || A.withKindMarker(act.text, act.kind);
    const userMsg = old.userMsg || { role: 'user', content: Context.playerContent(S.story.premise, sent) };

    // 世界卡 / 摘要 / 消息窗口先回到「这一回合发生之前」——对旧行为的修正（§10）：
    // 以前重试是在已被上一版改写过的世界卡上重来
    Tree.switchTo(S.story, old.parent);
    S.story.turn += 1;            // 与正常回合同口径：turn 在提交前 +1
    S.currentChoices = [];

    S.busy = true;
    S.stopRequested = false; S.chatAbortCtrl = null;   // P0-1
    setSendButtonsBusy(true);
    A.renderChat();
    const mark = Tree.begin(S.story);             // 记 logMark：必须在 pushLog 之前（§4.1）
    if (!isRetryOpening) {
      // 重新 pushLog 同一条玩家行动（§4.2）：project 到父节点后旧回合的条目已不在窗口里
      A.pushLog(act.type === 'agent'
        ? { type: 'agent', text: act.text, trigger: '', reason: '', fireId: '' }
        : { type: act.type === 'choice' ? 'choice' : 'player', text: act.text, kind: act.kind || 'do' });
    }
    try {
      // 重试后缀只出现在请求里，不进存档（§4.2）
      const res = await A.callAI1(sent + '\n（请换一种不同的发展，给出不同的走向）', isRetryOpening ? { includePremise: true } : undefined);
      const reply = res.reply;
      S.story.lastSceneSummary = reply.scene_summary || S.story.lastSceneSummary;
      const asst = assistantMessage(reply, res.reasoning);
      S.story.messages.push(userMsg, asst);          // userMsg 复用原文（不带重试后缀，§4.2）
      pushNarrationEntry(reply.narration, res.reasoning);
      await A.finishNarration(res.streamed);
      absorbReply(reply);
      S.currentChoices = reply.choices;
      A.renderChat();
      // 成功：parent = 原 head 的父节点（投影已停在那），落一个新兄弟
      const node = Tree.commit(S.story, {
        action: { type: act.type, text: act.text, kind: act.kind || null, sent: act.sent || sent },
        userMsg: userMsg, assistantMsg: asst, logMark: mark.logMark,
        meta: { model: S.turnModel || '' },   // UI-3 §3.3：重试同样记模型名
      });
      S.turnAnchor.nodeId = node.id;   // §3.A.4：锚点补 nodeId
      await postTurn();
      Tree.seal(S.story, node.id);
      A.maybeAutoTitle();   // UI-2 §3.3：重试回合 seal 后同样触发自动标题
      saveAll();
    } catch (e) {
      // 失败 / 主动停止：回原 head，旧一对完整放回（§4.2）
      S.turnAnchor.dead = true;        // §3.A.4：失败分支置位，本次重试排队中的工具出图丢弃
      Tree.switchTo(S.story, old.id);
      S.currentChoices = choicesFromHead();
      if (isStopError(e)) toast('已停止');
      else toast(netErrHint(e), true, true);
    } finally {
      S.busy = false;
      S.stopRequested = false; S.chatAbortCtrl = null;
      S.live = null; S.liveEl = null;
      setSendButtonsBusy(false);
      A.renderChat();
    }
  }

  // §4.3 兄弟切换：切到相邻兄弟，沿 active 下探到叶子（续写过的支线会回到它的末端）；不发任何请求
  function switchSiblingFromBubble(nid, dir) {
    if (!S.story || !nid) return;
    if (S.busy) { toast('正在生成中，等这一步结束再切分支'); return; }   // 沿用 showShelf 的做法（§4.1）
    // 阶段 5 第 5 步：数据切换先行、重渲染留在过渡里——快照只认 DOM，先切数据不影响新旧两帧；
    // 顺带保住 0.12.1「每点必达」（视图过渡的 update 回调晚一帧，数据不能等它）。
    // 越界 / 无兄弟：switchSibling 返回 null 且完全不动，也不播动画（旧 animateSwap 同口径）。
    const head = Tree.switchSibling(S.story, nid, dir);
    if (!head) return;
    S.currentChoices = choicesFromHead();   // §4.3：选项跟着新 head 的 assistantMsg 走
    saveAll();
    animateSwap(dir, () => {
      A.renderChat(); A.renderStage(); A.renderThumbs(); A.renderStoryPanels(); A.renderSavepoints();
    });
  }

  /* 切兄弟过渡（阶段 5 第 5 步收编进过渡内核；形态 / 时长全由 TRANSITIONS.sibling 决定）：
   *   off      即时（runTransition 同步换 DOM：焦点与滚动位置都不动）
   *   standard 交叉淡入、无横向位移（VT 的 ::view-transition-*，或降级整块淡入）
   *   rich     方向性短位移（±24px 新快照滑入 ≈220ms；降级把旧 WAAPI 的位移段叠回淡入上）
   * 名字只在过渡期间挂 #chat-scroll（同屏 view-transition-name 必须唯一，常驻会拖累每次切屏）。
   * 连点：内核先 skipTransition 收上一段（防快照残留），这里再撤上一段的名字与位移；
   * 渲染按序号只落最新一次——update 回调晚一帧，旧回调绝不能把旧分支闪回来
   * （数据已先行切走，渲染幂等读当前状态，最终态由最新一次渲染决定）。 */
  const SWAP_NAME = 'sibling';   // 与 TRANSITIONS.sibling 同名：验收按名字认这一对快照
  const SWAP_PX = 24;            // 与旧 WAAPI 同量级：聊天内容区按方向横向滑入，不是滑屏
  let swapSeq = 0;
  let swapNameEl = null;
  let swapShiftAnim = null;

  function cancelSwapShift() {
    if (!swapShiftAnim) return;
    try { swapShiftAnim.cancel(); } catch (_) {}
    swapShiftAnim = null;
  }

  function endSwapName() {
    if (!swapNameEl) return;
    try { swapNameEl.style.viewTransitionName = ''; } catch (_) {}
    swapNameEl = null;
  }

  function swapEase() {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim();
      if (v) return v;
    } catch (_) {}
    return 'cubic-bezier(.2,.8,.2,1)';   // 旧 WAAPI 的缓动，兜底同款
  }

  /* rich 的方向性位移段（WAAPI 只动 transform，不新增 @keyframes——加一条要同步
   * src/core/motion.ts 与两份 eval 测试，任务书「坑」）：VT 路径挂在新快照伪元素上
   * （与切屏 shiftNewSnapshot 同款）；降级路径直接动聊天盒（旧 WAAPI 的位移段）。 */
  function playSwapShift(dir, ms, target, pseudo) {
    if (!(ms > 0) || !target || typeof target.animate !== 'function') return;
    cancelSwapShift();
    const opts = { duration: ms, easing: swapEase() };
    if (pseudo) opts.pseudoElement = pseudo;
    else opts.fill = 'none';
    let anim;
    try {
      anim = target.animate(
        [{ transform: 'translateX(' + (dir >= 0 ? SWAP_PX : -SWAP_PX) + 'px)' }, { transform: 'none' }],
        opts
      );
    } catch (_) {
      return;   // 伪元素 WAAPI 不可用：只剩交叉淡入，不算失败
    }
    if (!pseudo) target.style.willChange = 'transform';   // 只在动画进行时临时加
    swapShiftAnim = anim;
    const done = () => {
      if (swapShiftAnim === anim) swapShiftAnim = null;
      if (!pseudo) { try { target.style.willChange = ''; } catch (_) {} }   // 结束移除
    };
    try { anim.finished.then(done, done); } catch (_) { done(); }
  }

  function animateSwap(dir, render) {
    const box = $('#chat-scroll');
    const stamp = ++swapSeq;
    let rendered = false;
    const guarded = () => {
      if (stamp !== swapSeq) return;   // 被更新的一次顶掉：旧回调不许落 DOM
      rendered = true;
      if (typeof render === 'function') render();
    };
    if (!box) { guarded(); return; }

    cancelSwapShift();
    endSwapName();   // 连切：上一段的名字先收干净，别叠第二对快照
    box.style.viewTransitionName = SWAP_NAME;
    swapNameEl = box;

    const r = VT.runTransition('sibling', guarded, { scope: box });
    if (r.kind === 'shift') {
      if (r.mode === 'vt') playSwapShift(dir, r.ms, document.documentElement, '::view-transition-new(' + SWAP_NAME + ')');
      else playSwapShift(dir, r.ms, box, '');   // 降级（?vt=0 / 不支持 VT）：旧 WAAPI 的位移段留作降级
    }
    const finish = () => {
      if (stamp !== swapSeq) return;
      endSwapName();
      if (!rendered) guarded();   // 兜底：update 回调万一被吞，收尾补一次渲染（幂等读当前状态）
    };
    r.finished.then(finish, finish);
  }

  A.reg({ parseAIReply, applyToolCall, absorbReply, refreshRollingStyleByModel, postTurn, pushNarrationEntry, assistantMessage, resetLiveDelta, finishLiveDelta, updateLiveReasoning, noToolsFor, renderNoToolsHint, toolList, streamAI1, lastNarrationIndex, lastActionEntry, choicesFromHead, treeHeadNodeId, nodeIdOwningEntry, nodeIdOwningScene, retryLast, switchSiblingFromBubble });

