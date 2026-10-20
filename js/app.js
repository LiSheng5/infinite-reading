/*
 * 无限阅读 · 主逻辑（v0.4）
 *
 * 结构：
 *  书架（应用入口，§7/T-P2-1）→ 新故事（选模式 → 剧情走向导 / 对话直接开聊 / 扮演暂自由扮演）
 *  → 阅读页（聊天记录 : 画面 双栏，§4.6）→ AI1 回合（上下文走 IR.Context，与评测同源）
 *  → 画师子代理 + 生图（§3.2/§4.7）→ 书记员 / 压缩（§4.1/§4.10）→ 存档点 / 导出导入（§4.11）
 * 存档：统一走 IR.Store（schema v2）；图片只存缩略图以控制体积。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, Store, Cap, DEMO, STYLE_PRESETS, MODE_LABELS, KIND_LABELS, DEFAULT_TOPIC, DEFAULT_SETUP, CHAT_PREMISE, rpPremise, SCRIBE_SYSTEM, SCRIBE_COMPRESS_SYSTEM, SCRIBE_ROLLING_SYSTEM, DRAFT_SYSTEM, IMAGE_ASPECTS, requestChatStop, isStopError, setSendButtonsBusy, motionMQ, motionLevel, applyMotion, applyPaused, motionMs, toast, hideToast, irConfirm, closeConfirm, confirmValue, MODAL_IDS, modalStack, openModal, closeModal, dismissModal, closeTopModal, netErrHint, offlineBlocked, sleep, clone, fmtTime, fmtMB, persistSettings, saveAll, resolveSub, imageCfg, miniBtn } = A;

  /* 离线演示模式（?demo=1，见 js/demo.js）：内置剧本 + 本地占位图，不联网、不需要 Key。
     只覆盖内存里的 settings，绝不写回 localStorage —— 真实配置不会被演示污染。 */

  /* ================= 默认值与提示词 ================= */

  // 做 / 说 / 导演：玩家回合的三种输入语义（旧存档缺 kind 时按「做」处理）

  // 开始页「故事设定」框的默认文字（v0.1 原样保留）
  // R13 rp：premise 与角色卡绑定（卡常驻系统提示词；开场白由卡写、直接进日志，§4.12）

  // 画师子代理（原 AI2）：把剧情写成绘画提示词。P3 会搬进画师工作台。

  // 书记员 C-B 双职（§4.10 C-B）：一次调用同时「压缩旧回合 → 场景摘要」+「重写世界状态卡」

  // 滚动风格摘要（§4.10 C-F）：书记员顺手更新（真实模式）

  /* ================= 状态 ================= */

  /* ---------- P0-1（2026-10-14 评审）：请求中断 ----------
   * providers.chat 经 hooks.onAborter 回填当前请求的 AbortController；
   * 发送按钮在 busy 期间变成「停止」，点了就 abort 当前请求并跳过所有自动重试。 */

  // 用户主动停止导致的请求失败：跳过「流式失败转非流式」「tools 400 降级」等自动重试
  // busy 期间发送按钮变身「停止」：按钮保持可点，点击即中断当前回合
  // 顶栏忙碌进度线 #busy-line 跟着同一状态显隐（UI-1 §4.3）

  /* ================= 动效基座（UI-1） ================= */

  // 当前动效强度：settings.ui.motion + 系统「减少动态效果」→ IR.Motion.resolve

  // 页面不可见 → html[data-paused]（CSS 暂停一切循环动画）

  // 动效令牌里的时长（毫秒）：JS 侧的 WAAPI 与 CSS 共用同一个真源

  /* ================= 小工具 ================= */

  // 同一时刻只保留一条提示（后来者替换前者）：文本写进 #toast-text，
  // 错误提示额外给一个关闭按钮，其余情况不吃鼠标事件（pointer-events: none）。

  /* 自建 confirm / prompt（内嵌预览是沙箱 iframe，原生弹窗被静默忽略 →
     直接返回 false / null，表现为「点了没反应」，故不使用原生 confirm / prompt）。
     irConfirm(msg, { title, okText, input, value, placeholder }) → Promise
       无输入：确定 resolve(true)，取消 / 关闭 resolve(null)
       有输入：确定 resolve(字符串)，取消 / 关闭 resolve(null) */

  /* ---------- 弹窗栈（P0-3） ----------
   * 十余个弹窗各自独立，演示图里「写邮件」和「代为下单」会叠在一起。
   * 这里做一个最小的统一入口：
   *   - openModal(id) / closeModal(id) 维护一个栈，后开的总在上面（z-index 由栈序决定）；
   *   - 功能类弹窗（邮件 / 支付 / 设置里的定时主动）互斥：开一个先关掉其它功能类；
   *   - 确认弹窗（#modal-confirm）不参与互斥，可以叠在任意弹窗上；
   *   - Esc 只关最上层（confirm 要走 closeConfirm，才能把 Promise 收掉）。
   * 现有 id 与 DOM 全部保持不变。 */

  // Esc / 点遮罩：按弹窗自己的关闭函数收尾（有的要清状态、有的要 resolve Promise）

  /* 断网守卫：离线时【不发请求、也不排队】，直接告诉用户「这次点了不算」。
   * 不排队是刻意的：出图时机有「每轮 / 选择后」的自动触发，若排队等联网后补发，
   * 用户会在毫不知情的情况下被扣一笔额度。 */

  // 体积显示：1 MB 以下按 KB 显示 —— 否则「68 KB 的备份」会显示成 0.0 MB，看着像没内容

  // 设置落盘的唯一出口：演示模式只改内存，不写盘

  // 子模型（画师/书记员/起草）配置：留空即沿用剧情模型

  // 生图配置：预填档位优先；'__custom__' 或未登记时按比例 + 宽高算 size（R8）
  // override 供画师工作台传入本图的出图参数（比例 / 宽高）

  /* ---------------- 模型能力（T-M-1 / §4.13） ---------------- */

  // 有效上下文窗口：用户手填优先，其次登记表；0 = 未知（压缩退回条数兜底）

  // 手填尺寸时显示宽/高输入（预填档位模式下由档位决定，隐藏）

  // 设置面板：按模型能力显隐参数（思考档位 / 尺寸 / 质量 / 上下文窗口提示）

  // 背景图只作用于右栏舞台：底层是当前图的模糊放大副本（CSS 负责模糊 / 压暗）。
  // 全页背景图已取消——阅读面必须是纯 --bg，图不能透到文字后面。

  /* ---------------- 原图（Blob）：存 IndexedDB，取显示地址 ---------------- */

  // 把生成的图转成 Blob：先试 fetch（dataURL / 同源 / 允许 CORS 的 URL 都能成），
  // 被 CORS 挡住时退回「画进 canvas 再导出」。都失败就返回 null（只留缩略图）。

  // 存原图；返回 imageId（没有 IndexedDB / 存不下时返回 undefined，退回只留缩略图）

  // 一张图该显示什么：优先原图（IndexedDB 里的 Blob → objectURL），没有就退回缩略图

  // 打字机（流式失败 / 非流式时的兜底观感）；返回 Promise

  /* ================= 存档点（T-P2-1 / §7） ================= */

  /* ================= 书架（T-P2-1 / §7） ================= */

  // 开始页（应用入口）：三个模式先看介绍、点一张选中，再按「开始」

  // 阅读页「＋ 新故事」：先把当前这一幕落盘，再开「新故事」选模式弹窗（三个模式共用同一入口）

  // 开始页三模式（§4.8）：三张卡即三个开局入口，点哪张就按哪种模式开局（没有单独的开始按钮）
  //   剧情 = 设定框快通道；对话 = 直接开聊；扮演 = 先建角色卡

  // 剧情模式：用设定框里的文字直接开一局（v0.1 的快通道）

  /* 离线演示（?demo=1）：内置剧本 + 本地占位图，直接开局。
     不联网、不需要 Key、配置不写盘；画风锚定 / 画师工作台 / 出图 / 存档等链路与真实模式完全一致。 */

  // 「↶ 继续上次」

  /* ================= 导入 / 导出（T-P2-4 / §4.11） ================= */

  /* ================= 本地存储与备份（P0 数据安全） =================
   * 全部数据只在浏览器 localStorage（每站点约 5MB），没有任何服务端。这里做三件事：
   *  1) 申请持久化存储 navigator.storage.persist()：磁盘压力下的 LRU 淘汰会跳过本站
   *     （Safari 的 7 天无交互清除仍会生效，只能靠交互 / 加到主屏缓解）
   *  2) 算清本应用占用量，到 70% 提前预警（原来的提示只在写入失败之后才出现，已经晚了）
   *  3) 「一键导出全部备份」(.irbackup.json，可整体还原) + 超过 7 天没备份就提醒一次
   */

  // 只统计本应用的键（ir: 前缀）：localStorage 上限是所有键共享的，这里的占用才是我们能控的

  // 真实占用：navigator.storage.estimate()（把 IndexedDB / Cache 等一起算在内，比数键位准得多）

  // 导出包：默认剥掉 API Key（备份文件常被放进网盘，带 Key 等于把钱包一起备份）

  /* 「带原图备份」= 一个 zip 里放两样东西：
   *   ir-backup.json      与普通备份完全同款（schema 2 只多一份 images 清单）
   *   images/0001.png …   原图按二进制原样存放
   * 为什么不把原图 base64 塞进 JSON：大图转 base64 体积涨约 1/3，还会在内存里堆成巨型字符串；
   * zip 装的是原始字节，体积最省，导出 / 导入都不容易把内存打爆。代价是 .zip 不能直接肉眼查看。 */

  // 超过 7 天没备份（且确实有故事）→ 启动后提醒一次；提醒本身每天最多一次，不刷屏

  // 从一个 zip 里找备份正文：优先根目录，也接受「被塞进一层文件夹」的情况

  // 带原图的全量备份（.zip）：解出 ir-backup.json 走同一套还原流程，原图另走 images/*

  /* ================= 剧情文本导入（R12 路径② / §4.11 / T-P6-1） =================
   * 粘贴任意剧情文本 → 整理向导（用「起草模型」；只有装不下才 map-reduce）→
   * premise + world 草稿 + 画风关键词 → 用户确认修改（不可跳过）→ 建新档 → 试画锚定 → 开场。
   * 调用失败退回本地规则。 */

  // 整理模型：弹窗里可选（默认跟随剧情模型；也能用单独配置的起草模型）

  // 「这次用谁整理」的一行字（显示在提示与确认页上；避免只写模型名让人误以为是硬编码的）

  // 整理模型的有效窗口：跟随剧情模型 → 用剧情模型的；起草模型 → 单独配了才查登记表

  // 粘贴框下方的一行提示：整理模型 + 窗口 + 这次会一次调用还是 map-reduce（返回 plan 供调用方复用）

  // 本地兜底整理：只截取原文开头并结构化（调用失败时用；标「本地规则」，等用户改）

  // 分段摘要合并（§4.11：分段各出摘要，再一次合并成开局材料）

  /* ================= 角色卡（R13 / §4.12 / T-P7-1） =================
   * 统一编辑器：自建 = 空白表单；导入 = SillyTavern V2/V3 PNG（只兼容格式，不复制内容）；改完即生效。
   * rp 开局 = 选（建 / 导入）一张角色卡；开场白作为首条旁白；示例对话喂给模型学口吻。 */

  // 卡 → 世界卡人物条目（personality / speech 对接，§4.12）；用户手改过的字段按 mergeWorld 规则保护

  // 开场白 = rp 首条旁白（不花一次 AI 调用；§4.12）

  /* ---------------- 用户画像（R13 / §4.12 / T-P7-2） ----------------
   * 开关默认全关、可按模式单独开或全开；范围 global（ir:user-profile）/ per-story 用户自选。
   * 收集：真实模式由书记员校对时顺手提取；失败退回本地确定性规则（只认「我…」句式）。
   * 注入：每轮只带与当前话题相关的 Top-N + 常驻一行摘要（assembleAI1 的 opts.profile，见 callAI1）。 */

  // 当前生效的画像条目（按 scope 取全局或本档）；关开关 / 没故事 → 空

  // 写入画像：关开关即停止收集；合并去重（同文只留最新），不设条数上限（§4.12 存储无上限）

  // 失败兜底：只看玩家最后说的一句（确定性规则）

  // 书记员输入里的画像指示：开没开都说清楚，省得模型乱输出

  /* ================= 开局向导（T-P2-3 / §4.8） ================= */

  /* ================= AI1：剧情回合 ================= */

  function parseAIReply(raw) {
    const text = String(raw || '').trim();
    // 宽容解析（裸换行 / 截断 / 围栏都能救）：剧情模式中文键契约（v0.3）经
    // normalizeAIReply 映射回内部英文结构；坏包不直接展示给玩家
    const j = IR.Context.normalizeAIReply(IR.Context.tolerantJSONParse(text));
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

  function slimReply(r) {
    return { narration: r.narration, choices: r.choices, scene_change: r.scene_change, scene_summary: r.scene_summary };
  }

  function applyToolCall(c) {
    const fn = (c && c.function) ? c.function : c;
    const name = (fn && fn.name) || '';
    let args = {};
    try { args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments || {}); } catch (_) { args = {}; }
    // 提案类工具的留痕是 {type:'proposal'} 提案卡本身（确认后另记一条 tool 留痕），这里不再重复记
    if (IR.Context.isProposalTool(name)) return;
    let summary = name;
    if (name === 'update_memory') {
      if (args.world && typeof args.world === 'object') IR.Context.mergeWorld(S.story.world, args.world);
      if (args.relationship) IR.Context.mergeWorld(S.story.world, { relationship: args.relationship });
      // 画像条目按开关 / 范围写入（关开关即停止收集，§4.12）
      if (Array.isArray(args.profile)) A.applyProfileEntries(args.profile);
      summary = args.text ? ('更新记忆：' + args.text) : '更新记忆';
    } else if (name === 'recall_world_state') summary = '查阅了世界状态卡';
    else if (name === 'recall_style_card') summary = '查阅了视觉设定卡';
    else if (name === 'request_image') summary = '排队生图';   // §3.A.6：chat / rp 没有画师，措辞中立
    else if (name === 'schedule_once') summary = '安排了一次主动联系（待确认）';
    else if (name === 'schedule_heartbeat') summary = '安排了定时主动联系（待确认）';
    else if (name === 'schedule_cron') summary = '安排了日历主动联系（待确认）';
    else if (name === 'list_triggers') summary = '查看了主动联系安排';
    else if (name === 'cancel_trigger') summary = '取消了主动联系安排';
    S.story.log.push({ type: 'tool', tool: name, summary, ts: Date.now() });
  }

  function absorbReply(reply) {
    if (reply.world) IR.Context.mergeWorld(S.story.world, reply.world);
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
    return !!IR.ChatProviders[cfg.provider];
  }

  // 书记员（C-B）：每 N 回合校对世界卡（压缩触发时由 runSmartCompress 顺带完成）；失败时用本地规则兜底
  async function runScribe() {
    let result = null;
    try {
      const cfg = resolveSub('scribe');
      if (cfg.provider && cfg.model) {
        const recent = S.story.log.filter(l => l.type === 'narration').slice(-12).map(l => '· ' + l.text).join('\n');
        const said = S.story.log.filter(l => l.type === 'player' || l.type === 'choice').slice(-12).map(l => '· ' + l.text).join('\n');
        const raw = await IR.ChatProviders[cfg.provider].chat(cfg, [
          { role: 'system', content: SCRIBE_SYSTEM },
          {
            role: 'user',
            content: '[当前世界卡]\n' + IR.Context.worldCardText(S.story.world)
              + '\n\n[最近剧情]\n' + (recent || '（无）')
              + '\n\n[玩家最近说过的话]\n' + (said || '（无）')   // R13：画像提取的来源
              + '\n\n' + A.scribeProfileHint(),
          },
        ]);
        result = parseScribe(raw);
      }
    } catch (_) { result = null; }
    if (!result) result = IR.Context.localScribe(S.story.world);
    // 书记员是整卡重写（最终仲裁）：允许空数组清空
    if (result.world) IR.Context.mergeWorld(S.story.world, result.world, { allowEmpty: true });
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
    const parts = ['[当前世界状态卡]\n' + IR.Context.worldCardText(S.story.world)];
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
    parts.push('', scribeProfileHint());   // R13：压缩顺手提取画像
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
    const plan = IR.Context.planCompression(S.story, { contextWindow: A.chatContextWindow() });
    if (!plan) return null;
    const cfg = resolveSub('scribe');
    const raw = await IR.ChatProviders[cfg.provider].chat(cfg, [
      { role: 'system', content: SCRIBE_COMPRESS_SYSTEM },
      { role: 'user', content: buildCompressInput(plan.groups) },
    ]);
    const parsed = parseScribeCompress(raw);
    if (!parsed || !parsed.summaries.length) return null;

    S.story.summaries = (S.story.summaries || []).concat(parsed.summaries);
    S.story.messages = S.story.messages.slice(plan.candidate.length);
    IR.Context.trimSummaries(S.story.summaries, IR.Context.DEFAULT_MAX_SUMMARIES);
    if (parsed.world) IR.Context.mergeWorld(S.story.world, parsed.world, { allowEmpty: true });
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
    const cur = IR.Context.rollingStyleText(S.story.rollingStyle);
    const card = S.story.styleCard;
    try {
      const raw = await IR.ChatProviders[cfg.provider].chat(cfg, [
        { role: 'system', content: SCRIBE_ROLLING_SYSTEM },
        {
          role: 'user',
          content: '[现有滚动风格摘要]\n' + (cur || '（无）')
            + '\n\n[锚定视觉设定卡]\n' + ((card && card.locked !== false) ? IR.Context.styleCardText(card) : '（未锚定）')
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
      if (!$('#modal-settings').classList.contains('hidden')) renderStoryPanels();
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
        comp = IR.Context.compressStory(S.story, {
          summarize: IR.Context.localSummarize,
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
    renderChat();
    if (!$('#modal-settings').classList.contains('hidden')) renderStoryPanels();
  }

  // 思考链入库前截断（长链只留前 4000 字，控住 localStorage 体积；渲染照常可折叠）
  const REASONING_MAX = 4000;
  function clipReasoning(text) {
    const s = String(text || '');
    return s.length > REASONING_MAX ? (s.slice(0, REASONING_MAX) + '\n…（思考链过长，已截断）') : s;
  }

  // 旁白条目（versions = 版本栈）；思考链随条目一起存，供折叠块渲染与以后带 tools 回传
  function pushNarrationEntry(text, reasoning) {
    const e = { type: 'narration', text, versions: [text], activeVersion: 0, ts: Date.now() };
    if (reasoning) e.reasoning = clipReasoning(reasoning);
    S.story.log.push(e);
  }

  // AI1 原始对话里的 assistant 条目：reasoning 一并存档（不进请求体，§4.5）
  function assistantMessage(reply, reasoning) {
    const m = { role: 'assistant', content: JSON.stringify(slimReply(reply)) };
    if (reasoning) m.reasoning = clipReasoning(reasoning);
    return m;
  }

  function maybeEnqueueImage(reply, isOpen, nodeId) {
    // 去重（§4.7）：本轮 AI1 已经用 request_image 出过图 → 时机出图跳过，同轮不画两张
    if (S.turnPaintedByTool) { S.turnPaintedByTool = false; return; }
    // §3.E.3：对话 / 扮演没有「时机出图」——图只来自模型调用工具或手动按钮（默认行为改动，见 CHANGELOG）
    if (S.story && (S.story.mode === 'chat' || S.story.mode === 'rp')) return;
    const mode = S.settings.trigger;
    let want = false;
    if (mode === 'every') want = true;
    else if (mode === 'choice' && (S.lastActionWasChoice || isOpen || S.story.turn === 1)) want = true;
    if (want) enqueueImage(reply.scene_summary, nodeId);
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
    if (!el) { renderChat(); return; }
    el.textContent = S.live.reasoning || '';
    const panel = el.parentElement;
    if (panel) panel.scrollTop = panel.scrollHeight;
    scrollChatBottom();
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
  function toolNamesIn(calls) { return toolList(calls).map(c => c.name); }

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
          scrollChatBottom();
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

  // 本回合是否已由工具出图（用于「工具已出图则跳过本轮时机出图」去重，§4.7）。
  // v0.5.1 起在**提交任务时**置位（原来是出图完成后），消费点（maybeEnqueueImage、开局路径）不变。

  // 回合锚点（§3.A.4）：request_image 在 commit 之前提交、节点还没创建——任务提交时带上它；
  // 回合 commit 成功后补 nodeId，失败 / 主动停止置 dead；任务开跑前与写回前各核一次。

  /* ================= 可选本地服务（sidecar）：调度工具与主动消息 ================= */

  // 调度工具只在「对话 / 扮演」+ 本地服务在线 + 后端已开启调度时才下发
  function scheduleToolsAvailable() {
    const S = IR.Sidecar;
    if (!SC || typeof SC.isOnline !== 'function' || !SC.isOnline()) return false;
    const st = SC.status();
    return !!(st.features && st.features.schedule && st.hasToken);
  }

  // 邮件 / 下单工具同样只在「本地服务在线 + 对应 feature 开启 + 有 token」时下发；
  // 另外 toolsForMode 只在 chat（智能体）模式放行（红线 7）。
  function proposalToolsAvailable() {
    const S = IR.Sidecar;
    if (!SC || typeof SC.isOnline !== 'function' || !SC.isOnline()) return { email: false, payment: false };
    const st = SC.status();
    const ready = !!st.hasToken;
    return {
      email: !!(ready && st.features && st.features.email),
      payment: !!(ready && st.features && st.features.payment),
    };
  }

  // 接受 ISO 8601 字符串或时间戳（秒 / 毫秒）；解析不出来返回 0
  function parseWhen(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
    const s = String(v == null ? '' : v).trim();
    if (!s) return 0;
    if (/^\d{9,}$/.test(s)) {
      const n = parseInt(s, 10);
      return n < 1e11 ? n * 1000 : n;          // 10 位当秒处理
    }
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
  }

  function describeTrigger(t) {
    const spec = (t && t.spec) || {};
    if (t.type === 'once') return '一次 · ' + fmtTime(spec.at);
    if (t.type === 'interval') return '每 ' + Math.round((spec.everyMs || 0) / 60000) + ' 分钟';
    if (t.type === 'cron') return spec.expr + ' @ ' + (spec.tz || 'UTC');
    return t.type;
  }

  // 执行调度工具：一律提交给侧车，且一律是「待确认」——模型可以安排，但不能让主动行为自己生效
  async function runScheduleTool(name, args) {
    const S = IR.Sidecar;
    const a = args || {};
    if (!SC || !SC.isOnline()) {
      return '[调度失败] 本地服务没有在运行。请告诉用户：先在「设置 → 本地服务」里启动它，否则没法定时主动联系。';
    }
    try {
      if (name === 'schedule_once') {
        const at = parseWhen(a.at);
        if (!at) return '[调度失败] at 需要 ISO 8601 时间，例如 2026-10-11T09:00:00+08:00。';
        const t = await SC.upsertTrigger({
          name: a.name, type: 'once', spec: { at: at },
          prompt: a.prompt, reason: a.reason, channel: S.story ? S.story.id : '', source: 'model',
        });
        return '[已提交，待用户确认] 一次性安排「' + t.name + '」定在 ' + fmtTime(at) + '；用户确认前不会触发。';
      }
      if (name === 'schedule_heartbeat') {
        const mins = Math.max(1, Math.floor(Number(a.everyMinutes) || 0));
        const t = await SC.upsertTrigger({
          name: a.name, type: 'interval', spec: { everyMs: mins * 60000 },
          prompt: a.prompt, reason: a.reason, channel: S.story ? S.story.id : '', source: 'model',
        });
        return '[已提交，待用户确认] 每隔 ' + mins + ' 分钟的安排「' + t.name + '」已创建；用户确认前不会触发。';
      }
      if (name === 'schedule_cron') {
        const t = await SC.upsertTrigger({
          name: a.name, type: 'cron', spec: { expr: a.expr, tz: a.tz || '' },
          prompt: a.prompt, reason: a.reason, channel: S.story ? S.story.id : '', source: 'model',
        });
        return '[已提交，待用户确认] 日历安排「' + t.name + '」：' + a.expr + '（' + (a.tz || 'UTC') + '）。';
      }
      if (name === 'list_triggers') {
        const list = await SC.listTriggers();
        if (!list.length) return '[现有安排] 目前没有任何主动联系安排。';
        return '[现有安排]\n' + list.map(t =>
          '- ' + t.name + '（' + t.status + ' · ' + describeTrigger(t) + '）原因：' + (t.reason || '未写')
          + (t.channel ? '［仅当前会话］' : '')).join('\n');
      }
      if (name === 'cancel_trigger') {
        const want = String(a.name || '').trim();
        const list = await SC.listTriggers();
        const hit = list.filter(t => t.name === want)[0];
        if (!hit) return '[取消失败] 没有叫「' + want + '」的安排（可以先 list_triggers 看看）。';
        await SC.cancelTrigger(hit.id);
        if (typeof renderTriggerList === 'function') { try { renderTriggerList(); } catch (_) {} }
        return '[已取消] 安排「' + hit.name + '」已删除。';
      }
      return '[调度失败] 未知的调度动作：' + name;
    } catch (e) {
      return '[调度失败] ' + ((e && e.message) || e);
    }
  }

  /* ---- 侧车连接状态与主动消息投递 ---- */

  // 邮件 / 定时主动 / 代下单只在「对话 / 扮演」模式可用：剧情模式里既不能出现，
  // 也不能被触发（入口函数自己也再挡一次，不依赖界面是否渲染）。

  // 局内功能入口：只有「对话 / 扮演」模式才有「＋」菜单；本地服务没启动时菜单项灰显

  /* ---------- 下拉菜单（顶栏「⋯」/ 输入区「＋」） ---------- */

  // 页面打开 / 重新上线时补跑：把侧车里排队的触达捞回来（页面关着时侧车只入队，不打扰）

  /* ---- 设置分区：安全项读写（真源在侧车 config.json，这里只是编辑界面） ---- */

  async function loadFeatureConfig() {
    if (!A.sidecarReady()) { renderSidecarStatus(); return; }
    try {
      const r = await IR.Sidecar.getConfig();
      const c = (r && r.config) || {};
      const set = (sel, v) => { const el = $(sel); if (el) el.value = (v === undefined || v === null) ? '' : v; };
      const chk = (sel, v) => { const el = $(sel); if (el) el.checked = !!v; };

      chk('#s-email-enabled', c.email.enabled);
      set('#s-email-provider', c.email.provider);
      set('#s-email-dailylimit', c.email.dailyLimit);
      set('#s-email-from', c.email.from);
      set('#s-email-allowlist', (c.email.allowlist || []).join('\n'));
      const keyEl = $('#s-email-resendkey');
      if (keyEl) { keyEl.value = ''; keyEl.placeholder = c.email.hasResendApiKey ? '已保存（留空表示不改动）' : '未设置'; }

      chk('#s-sched-enabled', c.schedule.enabled);
      chk('#s-sched-paused', c.schedule.paused);
      set('#s-sched-dailycap', c.schedule.dailyCap);
      set('#s-sched-missed', c.schedule.missedPolicy);
      set('#s-sched-quiet', (c.schedule.quietHours || []).map(h => h.start + '-' + h.end).join('\n'));

      chk('#s-pay-enabled', c.payment.enabled);
      set('#s-pay-provider', c.payment.provider);
      set('#s-pay-currency', c.payment.currency);
      set('#s-pay-pertx', c.payment.perTx);
      set('#s-pay-daily', c.payment.daily);
      set('#s-pay-monthly', c.payment.monthly);
      set('#s-pay-autoapprove', c.payment.autoApprove);
      set('#s-pay-cooldown', c.payment.cooldownMin);
      set('#s-pay-merchants', (c.payment.merchantAllowlist || []).join('\n'));
      set('#s-pay-categories', (c.payment.categoryBlocklist || []).join('\n'));

      renderTriggerList();
      renderEmailAudit();
      renderPayLedger();
    } catch (e) {
      toast('读取本地服务配置失败：' + ((e && e.message) || e), true, true);
    }
  }

  async function saveFeatureConfig() {
    if (!A.sidecarReady()) return;
    const lines = sel => { const el = $(sel); return el ? el.value.split('\n').map(s => s.trim()).filter(Boolean) : []; };
    const num = sel => { const el = $(sel); return el ? (Math.max(0, Math.floor(Number(el.value) || 0))) : 0; };
    const quiet = [];
    const qel = $('#s-sched-quiet');
    if (qel) {
      for (const line of qel.value.split('\n')) {
        const m = /^\s*(\d{1,2}:\d{2})\s*(?:-|~|到|至)\s*(\d{1,2}:\d{2})\s*$/.exec(line);
        if (m) quiet.push({ start: m[1], end: m[2] });
      }
    }
    const patch = {
      email: {
        enabled: $('#s-email-enabled').checked,
        provider: $('#s-email-provider').value,
        from: $('#s-email-from').value.trim(),
        dailyLimit: num('#s-email-dailylimit'),
        allowlist: lines('#s-email-allowlist'),
      },
      schedule: {
        enabled: $('#s-sched-enabled').checked,
        paused: $('#s-sched-paused').checked,
        dailyCap: num('#s-sched-dailycap'),
        missedPolicy: $('#s-sched-missed').value,
        quietHours: quiet,
      },
      payment: {
        enabled: $('#s-pay-enabled').checked,
        provider: $('#s-pay-provider').value,
        currency: ($('#s-pay-currency').value.trim() || 'CNY'),
        perTx: num('#s-pay-pertx'),
        daily: num('#s-pay-daily'),
        monthly: num('#s-pay-monthly'),
        autoApprove: num('#s-pay-autoapprove'),
        cooldownMin: num('#s-pay-cooldown'),
        merchantAllowlist: lines('#s-pay-merchants'),
        categoryBlocklist: lines('#s-pay-categories'),
      },
    };
    const key = $('#s-email-resendkey').value.trim();
    if (key) patch.email.resendApiKey = key;
    try {
      await IR.Sidecar.putConfig(patch);
      $('#s-email-resendkey').value = '';
      toast('功能设置已写入本地服务');
      A.renderSidecarStatus();
      renderTriggerList();
    } catch (e) {
      toast('写入本地服务失败：' + ((e && e.message) || e), true, true);
    }
  }

  /* ---- 主动联系安排 ---- */

  async function renderTriggerList() {
    const box = $('#trigger-list');
    if (!box) return;
    const sum = $('#trigger-summary');
    if (!A.sidecarReady()) {
      box.textContent = A.sidecarOffHint();
      if (sum) sum.textContent = '调度已暂停：本地服务未启动';
      return;
    }
    try {
      const r = await IR.Sidecar.api('GET', '/api/triggers');
      const list = (r && r.triggers) || [];
      const st = (r && r.stats) || {};
      if (sum) sum.textContent = '共 ' + list.length + ' 个安排 · 生效 ' + (st.active || 0) + ' · 待处理 ' + (st.pending || 0) + ' 条';
      box.innerHTML = '';
      if (!list.length) {
        const d = document.createElement('div');
        d.className = 'hint';
        d.textContent = '还没有任何安排。';
        box.appendChild(d);
        return;
      }
      for (const t of list) {
        const row = document.createElement('div');
        row.className = 'trigger-row';
        const main = document.createElement('div');
        main.className = 't-main';
        const name = document.createElement('div');
        name.className = 't-name';
        name.textContent = t.name;
        const pill = document.createElement('span');
        pill.className = 'status-pill' + (t.status === 'pending_confirm' ? ' pending' : '');
        pill.textContent = t.status === 'pending_confirm' ? '待确认' : (t.status === 'active' ? '生效中' : t.status);
        name.appendChild(pill);
        const meta = document.createElement('div');
        meta.className = 't-meta';
        meta.textContent = describeTrigger(t) + ' · 原因：' + (t.reason || '未写')
          + (t.nextAt ? ' · 下次 ' + fmtTime(t.nextAt) : '') + (t.channel ? ' · 仅该会话' : '');
        main.appendChild(name);
        main.appendChild(meta);
        row.appendChild(main);

        const acts = document.createElement('div');
        acts.className = 't-actions';
        if (t.status === 'pending_confirm') {
          const ok = document.createElement('button');
          ok.className = 'mini-btn';
          ok.textContent = '确认';
          ok.onclick = async () => {
            try { await IR.Sidecar.confirmTrigger(t.id); toast('已生效'); renderTriggerList(); }
            catch (e) { toast('确认失败：' + ((e && e.message) || e), true); }
          };
          acts.appendChild(ok);
        }
        const del = document.createElement('button');
        del.className = 'mini-btn';
        del.textContent = '取消';
        del.onclick = async () => {
          try { await IR.Sidecar.cancelTrigger(t.id); toast('已取消'); renderTriggerList(); }
          catch (e) { toast('取消失败：' + ((e && e.message) || e), true); }
        };
        acts.appendChild(del);
        row.appendChild(acts);
        box.appendChild(row);
      }
    } catch (e) {
      box.textContent = '读取安排失败：' + ((e && e.message) || e);
    }
  }

  /* ---- 邮件 ---- */

  async function renderEmailAudit() {
    const box = $('#email-audit');
    if (!box) return;
    if (!A.sidecarReady()) { box.textContent = '（本地服务未启动）'; return; }
    try {
      const r = await IR.Sidecar.emailAudit(20);
      const list = (r && r.audit) || [];
      box.innerHTML = '';
      if (!list.length) { box.textContent = '还没有邮件记录。'; return; }
      const KIND = { send: '发送', draft: '草稿', confirm: '确认' };
      for (const a of list) {
        const d = document.createElement('div');
        d.className = 'mono-line';
        d.textContent = fmtTime(a.at) + ' · ' + (KIND[a.kind] || a.kind) + ' → ' + a.to
          + (a.subject ? '（' + a.subject + '）' : '') + ' · ' + (a.status === 'ok' ? '成功' : '拒绝')
          + (a.code ? ' / ' + a.code : '');
        box.appendChild(d);
      }
    } catch (_) { box.textContent = '读取审计失败。'; }
  }

  async function renderEmailDrafts() {
    const box = $('#email-drafts');
    if (!box) return;
    if (!A.sidecarReady()) { box.textContent = '（本地服务未启动）'; return; }
    try {
      const list = await IR.Sidecar.emailSentDrafts();
      box.innerHTML = '';
      if (!list.length) { box.textContent = '没有待确认的草稿。'; return; }
      for (const d of list) {
        const row = document.createElement('div');
        row.className = 'trigger-row';
        const main = document.createElement('div');
        main.className = 't-main';
        const to = document.createElement('div');
        to.className = 't-name';
        to.textContent = d.to;
        const meta = document.createElement('div');
        meta.className = 't-meta';
        meta.textContent = (d.subject || '（无主题）') + ' · ' + fmtTime(d.at);
        main.appendChild(to);
        main.appendChild(meta);
        row.appendChild(main);

        const acts = document.createElement('div');
        acts.className = 't-actions';
        const send = document.createElement('button');
        send.className = 'mini-btn';
        send.textContent = '确认发送';
        send.onclick = async () => {
          const ok = await irConfirm('确认真的寄出这封邮件？\n\n收件人：' + d.to + '\n主题：' + (d.subject || '（无）'), { title: '确认发送邮件', okText: '发送' });
          if (!ok) return;
          try {
            const r = await IR.Sidecar.emailSendDraft(d.id);
            toast(r && r.ok ? '已发送' : ('没发出：' + ((r && (r.message || r.code)) || '未知原因')), !(r && r.ok));
            renderEmailDrafts();
            renderEmailAudit();
          } catch (e) { toast('发送失败：' + ((e && e.message) || e), true); }
        };
        const del = document.createElement('button');
        del.className = 'mini-btn';
        del.textContent = '丢弃';
        del.onclick = async () => {
          try { await IR.Sidecar.emailDiscardDraft(d.id); renderEmailDrafts(); } catch (_) {}
        };
        acts.appendChild(send);
        acts.appendChild(del);
        row.appendChild(acts);
        box.appendChild(row);
      }
    } catch (_) { box.textContent = '读取草稿失败。'; }
  }

  function openEmailModal() {
    // v0.6.0：「写邮件」只在智能体（chat）下可达；入口自己再挡一次，不依赖菜单是否渲染
    if (!A.featuresAllowed() || !S.story || S.story.mode !== 'chat') { toast('写邮件只在智能体模式可用：切到智能体模式再用', true); return; }
    if (!A.sidecarReady()) { toast(A.sidecarOffHint(), true, true); return; }
    const st = IR.Sidecar.status();
    const el = $('#email-status');
    if (el) {
      el.textContent = (st.features && st.features.email)
        ? '邮件功能已开启。不在白名单里的收件人只会先存成草稿。'
        : '邮件功能还没开启：请先在「设置 → 邮件」里启用，并设置白名单与每日上限。';
    }
    openModal('modal-email');
    renderEmailDrafts();
  }

  async function doEmailSend() {
    const to = $('#em-to').value.trim();
    const subject = $('#em-subject').value.trim();
    const body = $('#em-body').value;
    if (!to) { toast('先填收件人', true); return; }
    try {
      let r = await IR.Sidecar.emailSend({ to: to, subject: subject, body: body });
      if (r && r.code === 'NEED_CONFIRMATION') {
        const ok = await irConfirm(
          '这个收件人不在白名单里，已先存成草稿。\n\n收件人：' + to + '\n\n确认后才会真的寄出。',
          { title: '需要你确认', okText: '确认发送' }
        );
        if (!ok) { toast('已留作草稿，未发送'); renderEmailDrafts(); renderEmailAudit(); return; }
        r = await IR.Sidecar.emailSendDraft(r.draftId);
      }
      if (r && r.ok) {
        toast('已发送');
        $('#em-subject').value = '';
        $('#em-body').value = '';
      } else {
        toast('没发出：' + ((r && (r.message || r.code)) || '未知原因'), true, true);
      }
      renderEmailDrafts();
      renderEmailAudit();
    } catch (e) {
      toast('发送失败：' + ((e && e.message) || e), true, true);
    }
  }

  /* ---- 购物支付 ---- */

  async function renderPayLedger() {
    const box = $('#pay-ledger');
    const sum = $('#pay-summary');
    if (!box) return;
    if (!A.sidecarReady()) { box.textContent = A.sidecarOffHint(); if (sum) sum.textContent = ''; return; }
    try {
      const r = await IR.Sidecar.paymentTransactions(20);
      const list = (r && r.transactions) || [];
      const s = await IR.Sidecar.paymentSummary('');
      if (sum && s && s.summary) {
        sum.textContent = '今日已用 ' + A.yuan(s.summary.spent.daily) + ' · 本月 ' + A.yuan(s.summary.spent.monthly)
          + ' · 每日剩余 ' + A.yuan(s.summary.remaining.daily);
      }
      box.innerHTML = '';
      if (!list.length) {
        const d = document.createElement('div');
        d.className = 'hint';
        d.textContent = '还没有交易记录。';
        box.appendChild(d);
        return;
      }
      for (const t of list) {
        const row = document.createElement('div');
        row.className = 'ledger-row';
        const main = document.createElement('div');
        main.className = 't-main';
        const head = document.createElement('div');
        head.className = 't-name';
        head.textContent = A.yuan(t.amountCents) + ' · ' + (t.merchant || '（未填商户）');
        const pill = document.createElement('span');
        pill.className = 'status-pill' + (t.status === 'denied' ? ' denied' : (t.status === 'pending' ? ' pending' : ''));
        pill.textContent = t.status + (t.code ? ' / ' + t.code : '');
        head.appendChild(pill);
        const meta = document.createElement('div');
        meta.className = 't-meta';
        meta.textContent = (t.agent || '（未指定）') + ' · ' + fmtTime(t.createdAt) + (t.providerRef ? ' · ' + t.providerRef : '');
        main.appendChild(head);
        main.appendChild(meta);
        row.appendChild(main);

        const acts = document.createElement('div');
        acts.className = 't-actions';
        const rec = document.createElement('button');
        rec.className = 'mini-btn';
        rec.textContent = '收据';
        rec.onclick = async () => {
          try {
            const rr = await IR.Sidecar.paymentReceipt(t.intentId);
            if (rr && rr.receipt) A.irDownloadText('收据-' + t.intentId + '.txt', rr.receipt.text);
          } catch (e) { toast('导出失败：' + ((e && e.message) || e), true); }
        };
        acts.appendChild(rec);
        if (t.status === 'awaiting_payment') {
          const paid = document.createElement('button');
          paid.className = 'mini-btn';
          paid.textContent = '我已支付';
          paid.onclick = async () => {
            const ok = await irConfirm('确认你已经在微信 / 支付宝里手动付好款了？', { title: '标记已支付', okText: '已支付' });
            if (!ok) return;
            try { await IR.Sidecar.paymentMarkPaid(t.intentId); toast('已标记为已支付'); renderPayLedger(); }
            catch (e) { toast('操作失败：' + ((e && e.message) || e), true); }
          };
          acts.appendChild(paid);
        }
        row.appendChild(acts);
        box.appendChild(row);
      }
    } catch (_) { box.textContent = '读取台账失败。'; }
  }

  function openPaymentModal() {
    // v0.6.0：「代下单」只在智能体（chat）下可达；入口自己再挡一次，不依赖菜单是否渲染
    if (!A.featuresAllowed() || !S.story || S.story.mode !== 'chat') { toast('代下单只在智能体模式可用：切到智能体模式再用', true); return; }
    if (!A.sidecarReady()) { toast(A.sidecarOffHint(), true, true); return; }
    const st = IR.Sidecar.status();
    const el = $('#pay-status');
    if (el) {
      el.textContent = (st.features && st.features.payment)
        ? '支付功能已开启。策略由本地服务在代码层强制，AI 拿不到任何支付凭证。'
        : '支付功能还没开启：请先在「设置 → 购物支付」里启用并设置额度（默认全是 0，什么都不放行）。';
    }
    $('#pm-result').textContent = '';
    openModal('modal-payment');
  }

  async function doPaymentSubmit() {
    const amountCents = Math.floor(Number($('#pm-amount').value) || 0);
    const merchant = $('#pm-merchant').value.trim();
    const category = $('#pm-category').value.trim();
    const itemsText = $('#pm-items').value.trim();
    const out = $('#pm-result');
    if (amountCents <= 0) { toast('先填金额（单位：分，例如 1999 = 19.99 元）', true); return; }
    try {
      const r = await IR.Sidecar.paymentPurchase({
        amountCents: amountCents, merchant: merchant, category: category,
        agent: 'agent', items: itemsText ? [{ name: itemsText }] : [],
      });
      if (!r || !r.ok) {
        out.textContent = '没有放行：' + ((r && (r.message || r.code)) || '未知原因');
        toast('这一笔没有放行' + (r && r.code ? '（' + r.code + '）' : ''), true, true);
        renderPayLedger();
        return;
      }
      if (r.needsApproval) {
        const rem = (r.summary && r.summary.remaining) || {};
        const lines = [
          '需要你确认这一笔：',
          '',
          '金额：' + A.yuan(amountCents),
          '商户：' + (merchant || '（未填）'),
          '品类：' + (category || '（未填）'),
        ];
        if (itemsText) lines.push('商品：' + itemsText);
        lines.push('', '每日剩余：' + A.yuan(rem.daily || 0) + ' · 每月剩余：' + A.yuan(rem.monthly || 0), '', '确认后才会真正扣款。');
        const ok = await irConfirm(lines.join('\n'), { title: '确认下单', okText: '确认并支付' });
        const rr = ok ? await IR.Sidecar.paymentApprove(r.intentId) : await IR.Sidecar.paymentDeny(r.intentId);
        out.textContent = ok
          ? ((rr && rr.ok) ? ('已放行（' + (rr.status || 'charged') + '）') : ('未完成：' + ((rr && (rr.message || rr.code)) || '')))
          : '已拒绝这一笔。';
        toast(ok ? '已确认' : '已拒绝', !ok);
      } else if (r.status === 'awaiting_payment') {
        out.textContent = (r.order && r.order.payHint) || '已生成订单，请手动付款后回来点「我已支付」。';
        toast('已生成订单：请手动付款');
      } else {
        out.textContent = '已放行（' + (r.status || 'charged') + '）。';
        toast('已放行');
      }
      renderPayLedger();
    } catch (e) {
      toast('提交失败：' + ((e && e.message) || e), true, true);
    }
  }

  // 执行一轮里的工具调用：留痕 + 副作用（写记忆 / 出图排队）；返回给重发用的回传块
  async function handleToolCalls(calls) {
    const feedback = [];
    const recallScopes = [];
    for (const c of calls) {
      applyToolCall({ function: { name: c.name, arguments: c.raw && c.raw.function ? c.raw.function.arguments : undefined } });
      if (IR.Context.isRecallTool(c.name)) {
        recallScopes.push(IR.Context.RECALL_TOOL_SCOPE[c.name]);
      } else if (c.name === 'request_image') {
        // §3.A：不再 await——任务进作画队列立刻返回，图在后台出、完成后落回本回合
        S.turnPaintedByTool = true;   // §3.A.3：提交即置位（原来是出图完成后）
        submitToolPaint(c.args);
        feedback.push('[已排队生图]\n画面：' + imageBrief(c.args)
          + '\n（图会稍后自动出现在聊天里。正文里可以自然提一句，但不要声称图已经画好，也不要说「工具」「系统」。）');
      } else if (c.name === 'update_memory') {
        feedback.push('[记忆已更新]\n' + ((c.args && c.args.text) || '世界卡 / 关系已写入'));
      } else if (IR.Context.isScheduleTool(c.name)) {
        feedback.push(await runScheduleTool(c.name, c.args));
      } else if (IR.Context.isProposalTool(c.name)) {
        // 提案制（红线 1）：只产生提案卡，绝不执行发送 / 扣款；执行要等用户在界面上点「确认」
        feedback.push(runProposalTool(c.name, c.args));
      }
    }
    renderChat();
    return { recallScopes: recallScopes.filter((s, i) => recallScopes.indexOf(s) === i), feedback: feedback };
  }

  // email_propose / payment_propose → 建提案（红线 1/2/3）：
  // 提案路径只走 IR.Proposals.create（不碰任何 send / purchase / approve），失败给模型可读原因让它圆场，
  // 成功 pushLog({type:'proposal'})（回合内、commit 之前，由 logMark 切片收进节点），并回一条「待确认」提示。
  function runProposalTool(name, args) {
    const kind = name === 'email_propose' ? 'email' : 'payment';
    const res = IR.Proposals.create(kind, args, Date.now());
    if (!res || !res.ok) {
      return '[提案失败] ' + ((res && res.error) || '参数不完整') + '。可以修正后重新提出；不要说已经完成。';
    }
    const p = res.proposal;
    pushLog({ type: 'proposal', proposal: p });
    if (kind === 'email') {
      return '[已提交，待用户确认] 邮件给 ' + p.args.to + '，主题「' + p.args.subject + '」；用户在界面确认前不会发送。不要说已经发出。';
    }
    return '[已提交，待用户确认] 下单 ' + A.yuan(p.args.amountCents) + '（' + (p.args.merchant || '未填商户') + '）；用户确认前不会扣款。不要说已经付款。';
  }

  // 调 AI1；带工具时：工具调用 → 留痕 + 副作用 + 单次重发（§4.5）
  async function callAI1(playerAction, opts) {
    opts = opts || {};
    const cfg = S.settings.chat;
    const adapter = IR.ChatProviders[cfg.provider] || IR.ChatProviders['openai-compatible'];

    S.turnPaintedByTool = false;   // 本轮工具出图标记（§4.7 去重用）
    S.turnAnchor = { nodeId: null, dead: false };   // §3.A.4：本回合锚点，工具出图任务提交时带上
    // C-E 启发式注入（T-P5-3）：玩家输入命中世界卡 / 伏笔实体词 → 本轮自动带上对应条目（与工具召回并行）。
    // 只在「新回合」留痕（重试不重复记），条目本身由 assembleAI1 注入，用户可在留痕面板看到：静默忽略工具时也照带。
    const prevEntry = S.story.log[S.story.log.length - 1];
    if (prevEntry && (prevEntry.type === 'player' || prevEntry.type === 'choice')) {
      const hit = IR.Context.matchEntityTerms(playerAction, S.story.world);
      if (hit.terms.length) pushLog({ type: 'tool', tool: 'heuristic', summary: '自动带上相关记忆：' + hit.terms.join('、') });
    }
    // 🧠 注入记忆（§4.4 手动层）：一次性，本轮把完整记忆直接压进上下文（不用 tool_choice，第十六轮定案）
    const forceInject = S.pendingInject;
    if (forceInject) {
      S.pendingInject = false;
      renderInjectHint();
      pushLog({ type: 'system', text: '已注入完整记忆（世界卡 + 设定 + 视觉设定卡）：本轮先复述处境再继续' });
    }
    S.live = { text: '', reasoning: '' };
    S.liveReasonEl = null;
    S.liveReasonCollapsed = false;
    S.liveReasonOpen = false;
    renderChat();
    S.liveEl = $('#chat-scroll').querySelector('.bubble-live');

    const toolsOn = opts.tools !== false && !opts.recall
      && S.settings.toolsEnabled !== 'off' && !noToolsFor(cfg);
    // 调度工具只在「对话 / 扮演」+ 本地服务在线 + 后端已开启调度时追加；剧情模式工具集不变
    const schedTools = toolsOn && scheduleToolsAvailable();
    // 邮件 / 下单（提案制）只在智能体（chat）+ 对应 feature 开启时追加（红线 7；toolsForMode 内部再挡一次模式）
    const propTools = toolsOn ? proposalToolsAvailable() : { email: false, payment: false };
    const toolOpts = { schedule: schedTools, email: propTools.email, payment: propTools.payment };
    const asmOpts = Object.assign({}, opts);
    if (toolsOn) asmOpts.tools = IR.Context.toolNamesForMode(S.story.mode, toolOpts);
    if (forceInject) asmOpts.forceInject = true;
    asmOpts.profile = A.activeProfileEntries();   // R13：画像按开关 / 范围注入（关则空数组，零成本）
    asmOpts.contextWindow = A.chatContextWindow();   // P1-3：组装窗口按 token 动态装（context.js fitWindow）
    // P1-5（2026-10-14）：组装前先查预算，超了就地用本地摘要先压再组——此前是「先组后压」
    //（postTurn 收尾才压），越过 70% 阈值的那一回合会超发一轮（严格的服务端直接拒）。
    // 本地摘要确定性、不花 API；后续 postTurn 的书记员照常处理新批次。
    try {
      const cw = asmOpts.contextWindow;
      if (cw > 0 && IR.Context.estimateContextTokens(S.story, playerAction, asmOpts) > Math.floor(cw * IR.Context.COMPRESS_RATIO)) {
        IR.Context.compressStory(S.story, { summarize: IR.Context.localSummarize, contextWindow: cw });
      }
    } catch (_) { /* 压缩失败不拦回合：最坏按原样发 */ }
    const messages = IR.Context.assembleAI1(S.story, playerAction, asmOpts);
    const cfgTools = toolsOn
      ? Object.assign({}, cfg, { tools: IR.Context.toolsForMode(S.story.mode, toolOpts) })
      : cfg;

    let streamedCalls = [];
    let reasoning = '';
    const first = await streamAI1(adapter, cfgTools, messages, {
      onToolCalls(calls) { streamedCalls = streamedCalls.concat(toolList(calls)); },
      onReasoning(piece) { reasoning += piece; if (S.live) S.live.reasoning = reasoning; updateLiveReasoning(); },
    });
    const reply1 = parseAIReply(first.text);
    // 两路都算：流式 tool_calls 与回包里的 tool_calls
    let calls = streamedCalls.concat(toolList(reply1.tool_calls));
    // 同名同参去重（流式与回包可能重复上报），再按每轮上限裁剪（§4.5）
    calls = calls.filter((c, i) => calls.findIndex(x => x.name === c.name && JSON.stringify(x.args) === JSON.stringify(c.args)) === i);
    // P2-10（2026-10-14）：超出上限的调用不再静默丢弃——留痕让玩家可见，重发时也告知模型
    const droppedCalls = calls.slice(IR.Context.MAX_TOOL_CALLS_PER_TURN);
    if (droppedCalls.length) {
      pushLog({ type: 'tool', tool: 'limit', summary: '已达本轮工具上限，未执行：' + droppedCalls.map(c => c.name).join('、') });
    }
    calls = calls.slice(0, IR.Context.MAX_TOOL_CALLS_PER_TURN);
    reply1.tool_calls = [];   // 已经处理过：避免 absorbReply 再记一次留痕

    const effect = calls.length ? await handleToolCalls(calls) : { recallScopes: [], feedback: [] };

    /* P0-2（2026-10-14）：「写了正文 + 调了工具」不再是工具结果的死角。
     * 此前仅当 noProse 才重发注入——流式下 content 与 tool_calls 同包出现完全可能：
     * 模型边写旁白边调 recall_world_state 时，召回执行了但模型没看到（正文是盲写的）。
     * 按工具语义分流（§3.A.2）：
     *  - recall_*：模型需要的信息 → 调了就注入重发；
     *  - request_image：已异步化，模型写了正文就不重发（省一次调用）——「已排队」的
     *    feedback 只在 noProse 重发时随包注入；
     *  - update_memory / schedule_*：fire-and-forget 的事后动作 → 仅 noProse 时重发（原行为）。
     * 重发永不带工具（§4.5，结构上防循环）；重发不可用而第一版有正文时回退第一版。 */
    const noProse = !reply1.narration || (reply1.parseFailed && reply1.looksJson);
    const needsFeedback = effect.recallScopes.length > 0;
    if (toolsOn && calls.length && (noProse || needsFeedback)) {
      if (noProse) reasoning = '';   // 纯工具回合的思考链不对应最终旁白，丢掉
      // 重发沿用本轮组装选项（含 R13 画像），但不下发工具清单
      const injects = effect.feedback.slice();
      if (droppedCalls.length) {
        injects.push('[提示] 以下调用已达本轮上限、未执行：' + droppedCalls.map(c => c.name).join('、') + '，当作没有这回事，别在正文里提它们的结果。');
      }
      const secondOpts = Object.assign({}, asmOpts, { recall: effect.recallScopes, inject: injects });
      delete secondOpts.tools;
      const second = await streamAI1(adapter, cfg,
        IR.Context.assembleAI1(S.story, playerAction, secondOpts),
        { onReasoning(piece) { reasoning += piece; if (S.live) S.live.reasoning = reasoning; updateLiveReasoning(); } });
      const reply2 = parseAIReply(second.text);
      const ok2 = !!(reply2.narration || reply2.choices.length);
      if (!ok2 && !noProse) {
        // 重发失败但第一版正文可用：第一版没白写，别用占位提示丢给玩家
        return { reply: reply1, streamed: first.streamed, reasoning: reasoning };
      }
      if (reply2.parseFailed && reply2.looksJson) {
        return {
          reply: Object.assign({}, reply2, { narration: '（模型这轮没给出可解析的回复，点「↻ 重试」或再说一句。）' }),
          streamed: second.streamed, reasoning: reasoning,
        };
      }
      if (ok2) return { reply: reply2, streamed: second.streamed, reasoning: reasoning };
      return {
        reply: Object.assign({}, reply2, { narration: '（模型只调用了工具却没写正文，点「↻ 重试」再来一次。）' }),
        streamed: second.streamed,
        reasoning: reasoning,
      };
    }
    // 没工具可兜底但回包不可用（坏 JSON / 空正文）：别把原始 JSON 或空气泡丢给玩家
    if ((reply1.parseFailed && reply1.looksJson) || (!reply1.narration && !reply1.choices.length)) {
      return {
        reply: Object.assign({}, reply1, { narration: '（模型这轮的回包没能解析成 JSON，点「↻ 重试」或再说一句。）' }),
        streamed: first.streamed, reasoning: reasoning,
      };
    }
    return { reply: reply1, streamed: first.streamed, reasoning: reasoning };
  }

  // 输入类型（做 / 说 / 导演）：状态按故事记在 story.ui.kind，旧存档缺省 = 做
  function currentKind() {
    const k = S.story && S.story.ui && S.story.ui.kind;
    return (k === 'say' || k === 'direct') ? k : 'do';
  }
  // 外层前缀 [玩家行动] 保持不变（demo.js 靠它分派），类型标记作为内层前缀。
  // v0.6.0：chat（智能体）不做 / 说 / 导演——内层标记直接不加（组装历史时另有 stripKindMarker 兼容旧档）。
  function withKindMarker(text, kind) {
    const raw = String(text == null ? '' : text);
    if (S.story && S.story.mode === 'chat') return raw;
    const k = (kind === 'say' || kind === 'direct') ? kind : 'do';
    return '（' + KIND_LABELS[k] + '）' + raw;
  }
  function syncKindSwitch() {
    const k = currentKind();
    // chat（智能体）没有做 / 说 / 导演：整组开关隐藏（story.ui.kind 保留不清）
    const sw = $('#kind-switch');
    if (sw) sw.classList.toggle('hidden', !!(S.story && S.story.mode === 'chat'));
    document.querySelectorAll('#kind-switch .seg-btn').forEach(b => {
      const on = b.dataset.kind === k;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const inp = $('#player-input');
    if (inp) {
      inp.placeholder = (S.story && S.story.mode === 'chat') ? '说点什么，或交给我办件事……'
        : k === 'say' ? '说点什么……'
        : k === 'direct' ? '写一句导演指令（世界里的既成事实）……'
        : '做点什么，或说句话……';
    }
  }

  // meta.kind === 'agent'：这条是「模型主动找你」（来自调度触发），不是玩家输入
  async function sendPlayerAction(action, isChoice, meta) {
    if (S.busy || !S.story) return;
    action = String(action || '').trim();
    if (!action) return;
    if (offlineBlocked('这条消息')) return;
    const agentMsg = !!(meta && meta.kind === 'agent');
    // chat（智能体）：玩家条目 kind 恒为 'do'，发给模型的行动不带内层标记（withKindMarker 对 chat 直接返回原文）
    const chatMode = !!(S.story && S.story.mode === 'chat');
    const kind = isChoice ? 'do'
      : (agentMsg ? null
        : chatMode ? 'do'
        : (((meta && meta.actKind) === 'say' || (meta && meta.actKind) === 'direct') ? meta.actKind : currentKind()));
    const sentAction = kind ? withKindMarker(action, kind) : action;
    S.busy = true;
    S.stopRequested = false; S.chatAbortCtrl = null;   // P0-1：每回合复位停止标记
    S.lastActionWasChoice = !!isChoice;
    S.currentChoices = [];
    S.choicesTrayOpen = false;
    setSendButtonsBusy(true);   // P0-1：busy 期间发送按钮变身「停止」

    const mark = IR.Tree.begin(S.story);   // 记 logMark：必须在 pushLog 之前（§4.1）
    pushLog(agentMsg
      ? { type: 'agent', text: action, trigger: meta.triggerName || '', reason: meta.reason || '', fireId: meta.fireId || '' }
      : { type: isChoice ? 'choice' : 'player', text: action, kind: kind || 'do' });
    renderChat();

    try {
      const res = await callAI1(sentAction);
      const reply = res.reply;
      S.story.turn += 1;
      S.story.lastSceneSummary = reply.scene_summary || S.story.lastSceneSummary;
      const userMsg = { role: 'user', content: IR.Context.playerContent(S.story.premise, sentAction) };
      const asst = assistantMessage(reply, res.reasoning);
      S.story.messages.push(userMsg, asst);
      pushNarrationEntry(reply.narration, res.reasoning);
      await finishNarration(res.streamed);
      absorbReply(reply);
      S.currentChoices = reply.choices;
      renderChat();
      // §4.1 回合落节点：entries = log.slice(logMark)，head 前移；失败 / 停止不建节点
      const node = IR.Tree.commit(S.story, {
        action: {
          type: agentMsg ? 'agent' : (isChoice ? 'choice' : 'player'),
          text: action, kind: kind || null, sent: sentAction,
        },
        userMsg: userMsg, assistantMsg: asst, logMark: mark.logMark,
      });
      S.turnAnchor.nodeId = node.id;                // §3.A.4：锚点补 nodeId，后台出图任务写回时落位
      maybeEnqueueImage(reply, false, node.id);   // nodeId 随任务走（§4.4）
      await postTurn();
      IR.Tree.seal(S.story, node.id);               // 必须在 postTurn 之后（§10）：收进压缩 / 书记员的 tool 条目
      if (agentMsg && meta.fireId) await A.ackProactive(meta.fireId);   // 已送达：从侧车队列里销掉
    } catch (e) {
      S.live = null;
      S.turnAnchor.dead = true;   // §3.A.4：失败 / 停止——本回合排队中与在途的工具出图丢弃
      if (isStopError(e)) {   // P0-1：玩家主动停止——不算故障，不弹错误提示
        S.story.log.push({ type: 'narration', text: '（已停止。点「↻ 重试」或再试一次。）', versions: [], ts: Date.now() });
      } else {
        toast(netErrHint(e), true, true);
        S.story.log.push({ type: 'narration', text: '（AI 走神了，点「↻ 重试」或再试一次吧。）', versions: [], ts: Date.now() });
      }
      renderChat();
    } finally {
      S.busy = false;
      S.stopRequested = false; S.chatAbortCtrl = null;
      S.live = null; S.liveEl = null;
      setSendButtonsBusy(false);
      renderChat();
      if (IR.Features) IR.Features.drain();   // 忙完了，看看排队的主动消息能不能送
    }
  }

  // 旁白已进 log：流式就直接落定；非流式用打字机补观感
  async function finishNarration(streamed) {
    if (streamed) {
      // UI-1 §4.2：流结束把逐段淡入的 span 整体合并成单个文本节点
      finishLiveDelta(S.liveEl || $('#chat-scroll').querySelector('.bubble-live'));
      S.live = null;
      return;
    }
    const el = S.liveEl || $('#chat-scroll').querySelector('.bubble-live');
    // 非流式：正文来了，思考窗同样卷成一行（与流式收尾一致）
    if (S.liveReasonEl && !S.liveReasonCollapsed) {
      S.liveReasonCollapsed = true;
      S.liveReasonEl.classList.add('collapsed');
    }
    const text = (S.story.log[S.story.log.length - 1] || {}).text || '';
    if (el) await A.typewrite(el, text);
    S.live = null;
  }

  // 开局第一幕：让 AI1 主动给出开场旁白与选项（不记录为玩家行动）
  // P2-11（2026-10-14）：实际请求与存档此前是两句不同的话，retryLast 会以存档版重发、与首发不一致——统一成常量
  const OPENING_ACTION = '（故事开场。请描写第一幕，把玩家带进场景。）';

  async function runOpening() {
    if (S.busy || !S.story) return;
    S.busy = true;
    S.stopRequested = false; S.chatAbortCtrl = null;   // P0-1
    setSendButtonsBusy(true);
    const mark = IR.Tree.begin(S.story);             // 记 logMark（§4.1）
    try {
      const res = await callAI1(OPENING_ACTION, { includePremise: true });
      const reply = res.reply;
      S.story.turn += 1;
      S.story.lastSceneSummary = reply.scene_summary || '';
      const userMsg = { role: 'user', content: IR.Context.playerContent(S.story.premise, OPENING_ACTION, { includePremise: true }) };
      const asst = assistantMessage(reply, res.reasoning);
      S.story.messages.push(userMsg, asst);
      pushNarrationEntry(reply.narration, res.reasoning);
      await finishNarration(res.streamed);
      absorbReply(reply);
      S.currentChoices = reply.choices;
      renderChat();
      // 开局同样是节点（§4.1）：action.type = 'opening'，sent = OPENING_ACTION
      const node = IR.Tree.commit(S.story, {
        action: { type: 'opening', text: OPENING_ACTION, kind: null, sent: OPENING_ACTION },
        userMsg: userMsg, assistantMsg: asst, logMark: mark.logMark,
      });
      S.turnAnchor.nodeId = node.id;                 // §3.A.4：锚点补 nodeId
      await postTurn();
      IR.Tree.seal(S.story, node.id);                // 必须在 postTurn 之后（§10）
      if (S.turnPaintedByTool) S.turnPaintedByTool = false;                        // 开局这一轮工具已出图 → 不再时机出图
      else if (S.story.mode === 'chat' || S.story.mode === 'rp') { /* §3.E.3：对话 / 扮演没有时机出图 */ }
      else if (S.settings.trigger !== 'manual') enqueueImage(reply.scene_summary, node.id);
      else toast('已开局。想看画面随时点右上角「作画」。');
      saveAll();
    } catch (e) {
      S.live = null;
      S.turnAnchor.dead = true;   // §3.A.4：失败 / 停止分支同样置位
      if (isStopError(e)) {
        S.story.log.push({ type: 'narration', text: '（已停止。输入任意内容开始故事。）', versions: [], ts: Date.now() });
      } else {
        toast(netErrHint(e), true, true);
        S.story.log.push({ type: 'narration', text: '（AI 走神了，输入任意内容开始故事。）', versions: [], ts: Date.now() });
      }
      renderChat();
    } finally {
      S.busy = false;
      S.stopRequested = false; S.chatAbortCtrl = null;
      S.live = null; S.liveEl = null;
      setSendButtonsBusy(false);
      renderChat();
    }
  }

  function pushLog(entry) {
    if (!S.story) return;
    entry.ts = Date.now();
    S.story.log.push(entry);
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
    const sent = act.sent || withKindMarker(act.text, act.kind);
    const userMsg = old.userMsg || { role: 'user', content: IR.Context.playerContent(S.story.premise, sent) };

    // 世界卡 / 摘要 / 消息窗口先回到「这一回合发生之前」——对旧行为的修正（§10）：
    // 以前重试是在已被上一版改写过的世界卡上重来
    IR.Tree.switchTo(S.story, old.parent);
    S.story.turn += 1;            // 与正常回合同口径：turn 在提交前 +1
    S.currentChoices = [];

    S.busy = true;
    S.stopRequested = false; S.chatAbortCtrl = null;   // P0-1
    setSendButtonsBusy(true);
    renderChat();
    const mark = IR.Tree.begin(S.story);             // 记 logMark：必须在 pushLog 之前（§4.1）
    if (!isRetryOpening) {
      // 重新 pushLog 同一条玩家行动（§4.2）：project 到父节点后旧回合的条目已不在窗口里
      pushLog(act.type === 'agent'
        ? { type: 'agent', text: act.text, trigger: '', reason: '', fireId: '' }
        : { type: act.type === 'choice' ? 'choice' : 'player', text: act.text, kind: act.kind || 'do' });
    }
    try {
      // 重试后缀只出现在请求里，不进存档（§4.2）
      const res = await callAI1(sent + '\n（请换一种不同的发展，给出不同的走向）', isRetryOpening ? { includePremise: true } : undefined);
      const reply = res.reply;
      S.story.lastSceneSummary = reply.scene_summary || S.story.lastSceneSummary;
      const asst = assistantMessage(reply, res.reasoning);
      S.story.messages.push(userMsg, asst);          // userMsg 复用原文（不带重试后缀，§4.2）
      pushNarrationEntry(reply.narration, res.reasoning);
      await finishNarration(res.streamed);
      absorbReply(reply);
      S.currentChoices = reply.choices;
      renderChat();
      // 成功：parent = 原 head 的父节点（投影已停在那），落一个新兄弟
      const node = IR.Tree.commit(S.story, {
        action: { type: act.type, text: act.text, kind: act.kind || null, sent: act.sent || sent },
        userMsg: userMsg, assistantMsg: asst, logMark: mark.logMark,
      });
      S.turnAnchor.nodeId = node.id;   // §3.A.4：锚点补 nodeId
      await postTurn();
      IR.Tree.seal(S.story, node.id);
      saveAll();
    } catch (e) {
      // 失败 / 主动停止：回原 head，旧一对完整放回（§4.2）
      S.turnAnchor.dead = true;        // §3.A.4：失败分支置位，本次重试排队中的工具出图丢弃
      IR.Tree.switchTo(S.story, old.id);
      S.currentChoices = choicesFromHead();
      if (isStopError(e)) toast('已停止');
      else toast(netErrHint(e), true, true);
    } finally {
      S.busy = false;
      S.stopRequested = false; S.chatAbortCtrl = null;
      S.live = null; S.liveEl = null;
      setSendButtonsBusy(false);
      renderChat();
    }
  }

  // §4.3 兄弟切换：切到相邻兄弟，沿 active 下探到叶子（续写过的支线会回到它的末端）；不发任何请求
  function switchSiblingFromBubble(nid, dir) {
    if (!S.story || !nid) return;
    if (S.busy) { toast('正在生成中，等这一步结束再切分支'); return; }   // 沿用 showShelf 的做法（§4.1）
    animateSwap(dir, () => {
      const head = IR.Tree.switchSibling(S.story, nid, dir);
      if (!head) return false;
      S.currentChoices = choicesFromHead();   // §4.3：选项跟着新 head 的 assistantMsg 走
      saveAll();
      renderChat(); renderStage(); renderThumbs(); renderStoryPanels(); A.renderSavepoints();
      return true;
    });
  }

  /* 切兄弟滑动（UI-1 §4.1）：聊天内容区按方向横向滑入（±24px + 透明度，--dur-base）。
   * 顺序必须是「数据切换 + 重新渲染 → 再播入场」，不能闪出旧内容；
   * 动画未结束时再次切换要能正确打断（cancel 上一段，最终态由最新一次渲染决定）；
   * off 档（含系统减少动态）直接切换。WAAPI 只动 transform / opacity。 */
  let swapAnim = null;
  function animateSwap(dir, swap) {
    const box = $('#chat-scroll');
    const done = typeof swap === 'function' ? swap() : true;
    if (done === false || !box || typeof box.animate !== 'function') return;
    if (motionLevel() === 'off') return;
    if (swapAnim) { try { swapAnim.cancel(); } catch (_) {} swapAnim = null; }
    if (box.getAnimations) {
      box.getAnimations().forEach(a => { try { a.cancel(); } catch (_) {} });
    }
    box.style.willChange = 'transform, opacity';   // 只在动画进行时临时加
    const anim = box.animate(
      [
        { transform: 'translateX(' + (dir >= 0 ? 24 : -24) + 'px)', opacity: 0 },
        { transform: 'translateX(0)', opacity: 1 },
      ],
      { duration: motionMs('--dur-base', 220), easing: 'cubic-bezier(.2,.8,.2,1)' }
    );
    swapAnim = anim;
    const finish = () => {
      if (swapAnim === anim) swapAnim = null;
      box.style.willChange = '';   // 结束移除
    };
    anim.onfinish = finish;
    anim.oncancel = finish;
  }

  /* ================= 画师子代理 + 生图（§3.2/§4.3，T-P3-1） =================
   * v0.5.1（§3.B）：时机出图 / 工具出图 / 手动 / 工作台重画全走同一条串行队列 IR.PaintQueue，
   * 画师构思也在队列里跑（不与队列外的构思并发）；request_image 已异步化、不卡回合（§3.A）。 */

  const paintQ = IR.PaintQueue.create({ onChange: function () { renderGenPill(); } });

  // —— 作画胶囊 #gen-status（§3.B）：显示「构思中 / 作画中」并带上队列长度；队列清空才隐藏 ——
  let genPillText = '';

  function setGenPill(text) {
    genPillText = String(text || '');
    renderGenPill();
  }

  function renderGenPill() {
    const pill = $('#gen-status');
    if (!pill) return;
    const n = paintQ.size();
    if (!n) { pill.classList.add('hidden'); pill.textContent = ''; return; }
    const waiting = n > 1 ? '（队列 ' + (n - 1) + '）' : '';
    pill.textContent = (genPillText || 'AI 作画中…') + waiting;
    pill.classList.remove('hidden');
  }

  // request_image 的一句话画面说明（feedback 用）：alt 优先，退回 subject / prompt
  function imageBrief(args) {
    const a = args || {};
    const s = String(a.alt || a.subject || a.prompt || '').replace(/\s+/g, ' ').trim();
    if (!s) return '（未说明）';
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }

  // 后台作画失败要可见（§3.A.5）：toast + 往它所属的节点留一条 tool 留痕
  function paintFailVisible(error, task) {
    const msg = (error && error.message) ? error.message : String(error);
    toast('作画失败：' + msg, true, true);
    const anchor = (task && task.anchor) || null;
    if (anchor && anchor.dead) return;   // 回合已被停止：不再往不存在的节点留痕
    const nodeId = (task && task.nodeId) || (anchor && anchor.nodeId) || null;
    pushPaintFailNote(nodeId, '作画失败：' + msg);
  }

  // 留痕落位与 runPaint 同口径（§4.4）：节点没了丢弃；已 sealed 走 pushLate；否则写 story.log（由 commit 切片收进节点）
  function pushPaintFailNote(nodeId, summary) {
    if (!S.story) return;
    const tree = S.story.tree;
    const node = (nodeId && tree && tree.nodes) ? tree.nodes[nodeId] : null;
    if (nodeId && !node) return;
    const entry = { type: 'tool', tool: 'image', summary: summary, ts: Date.now() };
    if (node && node.sealed) IR.Tree.pushLate(S.story, node.id, entry);
    else S.story.log.push(entry);
    saveAll();
    renderChat();
  }

  // 统一提交：失败在这里变可见（toast + 留痕），调用方拿场景或 null，不再抛异常
  function submitPaint(task) {
    return paintQ.enqueue(task).then(r => {
      if (r.skipped) return null;          // anchor.dead：开跑前就被丢弃，没花额度
      if (!r.ok) {
        paintFailVisible(r.error, task);
        return null;
      }
      return r.value || null;
    });
  }

  // request_image 入队（§3.A）：立刻返回、不等图；任务带回合锚点，完成后落回「它所属的回合」
  function submitToolPaint(args) {
    const storyId = S.story && S.story.id;
    const mode = S.story && S.story.mode;
    const a = args || {};
    // §3.E：对话 / 扮演直出（模型自己写提示词，不经画师）；剧情模式保持画师构思
    const direct = mode === 'chat' || mode === 'rp';
    const rawPrompt = String(a.prompt || '').trim() || String(a.subject || '').trim();
    const sceneRef = rawPrompt
      || (S.story && S.story.lastSceneSummary)
      || String((S.story && S.story.premise) || '').split('\n')[0] || 'story scene';
    const anchor = S.turnAnchor;   // 记住本回合的锚点对象（下一回合 callAI1 会换新对象）
    return submitPaint({
      key: null,
      anchor: anchor,
      storyId: storyId,
      nodeId: null,   // commit 前提交：写回时才从 anchor.nodeId 取（§3.A.4）
      run: () => runPaintTask({
        storyId: storyId,
        anchor: anchor,
        directPrompt: direct ? (rawPrompt || (S.story && S.story.lastSceneSummary) || 'atmospheric scene') : '',
        promptRaw: rawPrompt || undefined,
        sceneRef: sceneRef,
        altHint: String(a.alt || a.subject || '').trim(),
      }),
    });
  }

  // 作画任务体（§3.B）：合并原 runToolPaint / generateScene 的重复流程——
  //   构思（directPrompt 缺省时走画师；画师不可用 / 失败用场景描述兜底）→ 组 prompt → runPaint 出图写回
  // opts: { storyId, nodeId, anchor, directPrompt, promptRaw, sceneRef, altHint, supersedesEntry, supersedesScene, params }
  async function runPaintTask(opts) {
    if (!S.story) return null;
    // 排队期间已换故事：直接取消，不花画师与生图额度
    if (opts.storyId && S.story.id !== opts.storyId) { toast('已切换故事，本次作画取消'); return null; }
    // 断网：连画师构思都不发（这一步也要花钱），整单作废
    if (offlineBlocked('这次作画')) return null;

    const styleText = styleSuffixText();
    let promptRaw, prompt, alt;
    if (opts.directPrompt) {
      // 直出（§3.E）：提示词是模型写的，不请画师
      promptRaw = opts.promptRaw || opts.directPrompt;
      prompt = composePrompt(opts.directPrompt, styleText);
      alt = opts.altHint || opts.sceneRef || '';
      setGenPill('AI 作画中…');
    } else {
      // —— 画师子代理：把剧情写成绘画提示词 ——（剧情模式的工具出图 / 时机出图 / 手动）
      const sceneRef = opts.sceneRef
        || S.story.lastSceneSummary || String(S.story.premise || '').split('\n')[0] || 'story scene';
      setGenPill('AI 画师构思中…');
      let a2 = null;
      try {
        a2 = await painterCompose({ sceneRef: sceneRef, styleHint: styleText });
      } catch (_) { a2 = null; }   // 画师模型缺失 / 失败：跳过导演判断，用场景描述兜底（§4.7）
      promptRaw = (a2 && a2.promptEn) || sceneRef;
      prompt = composePrompt(promptRaw, styleText);
      alt = (a2 && a2.alt) || opts.altHint || sceneRef;
      setGenPill('AI 画师作画中…');
    }
    return runPaint({
      prompt: prompt, promptRaw: promptRaw, alt: alt,
      storyId: opts.storyId, nodeId: opts.nodeId, anchor: opts.anchor,
      supersedesEntry: opts.supersedesEntry, supersedesScene: opts.supersedesScene,
      params: opts.params,
    });
  }

  // 时机出图（§4.7）：节点在任务创建时记下（§4.4），同一条队列串行
  function enqueueImage(sceneSummary, nodeId, key) {
    const storyId = S.story && S.story.id;   // 记住「为谁画的」：等图期间换档也不写错故事
    const nid = nodeId || treeHeadNodeId();   // 与 nodeId 一样在任务创建时记下（§4.4）
    return submitPaint({
      key: key || null,
      storyId: storyId,
      nodeId: nid,
      run: () => runPaintTask({
        storyId: storyId, nodeId: nid,
        sceneRef: String(sceneSummary || ''), altHint: String(sceneSummary || ''),
      }),
    });
  }

  // 提示词已就绪的出图（工作台「按此重画」/「按设定卡强制重画」）：跳过构思直接出图
  function enqueuePaint(opts) {
    opts = opts || {};
    const storyId = S.story && S.story.id;   // 同上：任务自带故事 id，写入前核对
    // 图落回「它替代的那张图」所属的节点（§4.4）。重画找不到归属就挂到当前 head——
    // 不锚定的条目下次 project 就丢了；回合内的工具出图没有 supersedes 也没 nodeId，
    // 不在这里锚定（它写回时按 anchor / logMark 切片收进当前节点）
    const supersedes = opts.supersedesEntry || opts.supersedesScene;
    const nodeId = opts.nodeId
      || nodeIdOwningEntry(opts.supersedesEntry)
      || (opts.supersedesScene ? nodeIdOwningScene(opts.supersedesScene.id) : null)
      || (supersedes ? treeHeadNodeId() : null);
    return submitPaint({
      key: opts.key || null,
      storyId: storyId,
      nodeId: nodeId,
      run: () => runPaintTask({
        storyId: storyId, nodeId: nodeId,
        directPrompt: opts.prompt, promptRaw: opts.promptRaw || opts.prompt,
        sceneRef: '', altHint: opts.alt || '',
        supersedesEntry: opts.supersedesEntry, supersedesScene: opts.supersedesScene,
        params: opts.params,
      }),
    });
  }

  // 画风兜底后缀（未锚定视觉设定卡时用 settings 画风预设）
  function styleFallbackText() {
    return S.settings.stylePreset === 'custom'
      ? String(S.settings.styleCustom || '').trim()
      : (STYLE_PRESETS[S.settings.stylePreset] || '');
  }

  // P4：出图携带的画风后缀——已锚定用视觉设定卡关键词（卡优先），未锚定回退画风预设
  function styleSuffixText() {
    const card = S.story && S.story.styleCard;
    if (card && card.locked !== false) {
      const kw = (card.styleKeywords || []).filter(Boolean);
      if (kw.length) return kw.join(', ');
    }
    return styleFallbackText();
  }

  // 滚动风格摘要（§4.10 C-F）：每次出图后自动更新——风格倾向 / 常见场景 / 服饰元素
  const WARDROBE_WORDS = ['风衣', '外套', '大衣', '衬衫', '毛衣', '制服', '围裙', '裙子', '连衣裙', '和服', '发绳', '发带', '帽子', '围巾', '手套', '眼镜', '伞', '背包', '布袋', '领带', '西服', '夹克', '卫衣', '斗篷', '长袍'];

  function tailMerge(oldText, item, max) {
    const parts = String(oldText || '').split(/[；;]/).map(s => s.trim()).filter(Boolean);
    if (parts.indexOf(item) < 0) parts.push(item);
    return parts.slice(-(max || 3)).join('；');
  }

  function updateRollingStyle(scene) {
    if (!S.story) return;
    const rs = S.story.rollingStyle = Object.assign(Store.defaultRollingStyle(), S.story.rollingStyle || {});
    const kw = (S.story.styleCard && S.story.styleCard.styleKeywords || []).filter(Boolean);
    if (kw.length) {
      rs.style = kw.join(', ');            // 有卡：风格倾向 = 卡的画风关键词
    } else {
      const sfx = styleFallbackText();
      if (sfx && (!rs.style || rs.style.indexOf(sfx) < 0)) rs.style = tailMerge(rs.style, sfx, 2);
    }
    const alt = (scene && scene.alt) || '';
    if (alt) rs.scenes = tailMerge(rs.scenes, alt, 3);
    const hits = WARDROBE_WORDS.filter(w => alt.indexOf(w) >= 0);
    if (hits.length) rs.wardrobe = tailMerge(rs.wardrobe, hits.join('、'), 3);
    rs.updatedAt = Date.now();
  }

  function composePrompt(promptEn, suffix) {
    const en = String(promptEn || '').trim();
    const sfx = String(suffix || '').trim();
    if (!sfx || en.toLowerCase().indexOf(sfx.toLowerCase()) >= 0) return en;
    return [en, sfx].filter(Boolean).join(', ');
  }

  function stripStyleSuffix(prompt) {
    const p = String(prompt || '').trim();
    const sfx = styleFallbackText();
    if (!sfx) return p;
    const i = p.lastIndexOf(sfx);
    if (i < 0) return p;
    return p.slice(0, i).replace(/[,，、]\s*$/, '').trim() || p;
  }

  function parsePainterReply(raw) {
    const s = String(raw || '');
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    let o = {};
    if (i !== -1 && j > i) { try { o = JSON.parse(s.slice(i, j + 1)); } catch (_) { o = {}; } }
    return {
      promptEn: String(o.prompt_en || '').trim(),
      alt: String(o.alt || '').trim(),
      subject: String(o.subject || '').trim(),
      reply: String(o.reply || '').trim(),
    };
  }

  // 画师子代理：隔离上下文、用完即弃（§3.2）；命中 recall_recent_plot 时带记录重发一次
  async function painterCompose(opts) {
    const cfg = resolveSub('painter');
    const adapter = IR.ChatProviders[cfg.provider] || IR.ChatProviders['openai-compatible'];
    const messages = IR.Context.assemblePainter(S.story, opts);
    let wantPlot = false;
    const hooks = {
      onToolCalls(calls) {
        for (const c of (calls || [])) {
          const name = ((c && c.function) || c || {}).name;
          if (name === 'recall_recent_plot') wantPlot = true;
        }
      },
      // §3.D：画师构思 / 生图不再写全局 chatAbortCtrl——「停止」只管聊天回合，
      // 后台作画不受它中断（超时沿用适配器自己的；本期不为作画再造取消按钮）
    };
    const useTools = !!opts.tools && S.settings.toolsEnabled !== 'off';
    const cfg2 = useTools ? Object.assign({}, cfg, { tools: [IR.Context.RECALL_RECENT_PLOT_TOOL] }) : cfg;
    let raw;
    try {
      raw = await adapter.chat(cfg2, messages, hooks);
    } catch (e) {
      if (!useTools) throw e;
      raw = await adapter.chat(cfg, messages, hooks);   // 该模型不吃 tools：这一次不带工具重发
    }
    if (wantPlot && !opts.plot) {
      const raw2 = await adapter.chat(cfg, IR.Context.assemblePainter(S.story, Object.assign({}, opts, { plot: true })));
      return parsePainterReply(raw2);
    }
    return parsePainterReply(raw);
  }

  // 出一张图：调生图适配器 → 落 scene / log（可标记被替代的旧图，§2 supersededBy）
  async function runPaint(opts) {
    if (!S.story) return null;
    if (offlineBlocked('这次作画')) return null;
    const anchor = opts.anchor || null;
    // 工具出图在 commit 之前提交：写回时才从回合锚点取 nodeId（§3.A.4）
    const nodeId = opts.nodeId || (anchor && anchor.nodeId) || null;
    const cfgImg = imageCfg(opts.params);
    const imgAdapter = IR.ImageProviders[cfgImg.provider] || IR.ImageProviders['openai-images'];
    const src = await imgAdapter.generate(cfgImg, opts.prompt);

    // 写入前核对：等图期间换了故事 → 丢弃这张图，绝不写进别的故事
    if (opts.storyId && (!S.story || S.story.id !== opts.storyId)) {
      toast('已切换故事，刚画好的图已丢弃');
      return null;
    }
    // §3.A.4 写回前再核一次回合锚点：回合失败 / 被停止 → 丢弃（不落进不存在的节点）
    if (anchor && anchor.dead) {
      toast('这一回合已停止，刚画好的图已丢弃');
      return null;
    }

    // §4.4 第二道核对：图归 nodeId 那个回合。节点没了 → 丢弃；
    // 已 sealed → 走 Tree.pushLate（在当前路径上才进投影 log，否则只写节点）；
    // 未 sealed / 还没 commit（nodeId 为空）→ 沿用现有写法写 story.log / story.scenes，
    // 由 Tree.commit 的 logMark 切片收进当前节点（commit 与 seal 都会重算 node.scenes）
    const tree = S.story.tree;
    const node = (nodeId && tree && tree.nodes) ? tree.nodes[nodeId] : null;
    if (nodeId && !node) {
      toast('这张图所属的回合已不在分支树里，刚画好的图已丢弃');
      return null;
    }
    const onPath = !node || IR.Tree.pathOf(S.story, tree.head).indexOf(node.id) >= 0;

    const scene = {
      id: 'sc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      prompt: opts.prompt, promptRaw: opts.promptRaw || '', alt: opts.alt || '',
      src, ts: Date.now(),
      model: cfgImg.model || '', size: cfgImg.size || '',
      aspect: cfgImg.aspect || '', width: cfgImg.width, height: cfgImg.height,
      styleCardId: S.story.styleCard ? (S.story.styleCard.id + '@' + (S.story.styleCard.version || 1)) : undefined,
    };
    scene.thumb = await A.thumb(src);
    // 原图以 Blob 存 IndexedDB（不再把 base64 塞进档案）；档案里只留一个引用键
    scene.imageId = await A.storeOriginal(scene.id, src, {
      model: scene.model, size: scene.size, width: scene.width, height: scene.height, prompt: scene.prompt,
    });
    if (opts.supersedesEntry) opts.supersedesEntry.supersededBy = scene.id;
    if (opts.supersedesScene) opts.supersedesScene.supersededBy = scene.id;
    const entry = {
      type: 'image', id: scene.id, prompt: scene.prompt, promptRaw: scene.promptRaw, alt: scene.alt,
      thumb: scene.thumb, imageId: scene.imageId, model: scene.model, size: scene.size,
      aspect: scene.aspect, width: scene.width, height: scene.height, styleCardId: scene.styleCardId,
      ts: scene.ts,
    };
    if (node && node.sealed) {
      // 晚到（§4.4）：先写节点；在路径上再把同一个对象插到该节点末条之后（别追加到末尾）
      IR.Tree.pushLate(S.story, node.id, scene);
      IR.Tree.pushLate(S.story, node.id, entry);
    } else {
      S.story.scenes.push(scene);
      S.story.log.push(entry);
    }
    if (onPath) {   // 不在当前分支 → 不动舞台 / 世界侧状态，也不泄漏进当前视图
      S.story.lastBg = scene.id;
      A.setStageArt(A.sceneSrc(scene) || src);
      updateRollingStyle(scene);           // §4.10 C-F：每次出图后自动更新（本地规则，不依赖模型）
      refreshRollingStyleByModel(scene);   // 真实模式：书记员顺手刷新；失败保留本地结果
    }
    saveAll();
    renderChat(); renderStage(); renderThumbs();
    return scene;
  }

  // （generateScene 已并入 runPaintTask：构思 → 组 prompt → 出图三处共用一个任务体，§3.B）

  /* ================= 画师工作台（§4.3，T-P3-1） ================= */

  function findImageEntry(id) {
    if (!S.story) return null;
    for (let i = S.story.log.length - 1; i >= 0; i--) {
      const e = S.story.log[i];
      if (e.type === 'image' && e.id === id) return e;
    }
    return null;
  }

  function openWorkbench(sceneId) {
    if (!S.story) { toast('先打开一个故事吧'); return; }
    const scene = sceneId ? imageSceneById(sceneId) : currentScene();
    if (!scene) { toast('还没有图。先点右上角「作画」。'); return; }
    const entry = findImageEntry(scene.id);
    S.pw = {
      sceneId: scene.id,
      prompt: scene.prompt || (entry && entry.prompt) || '',
      promptRaw: scene.promptRaw || (entry && entry.promptRaw) || '',
      alt: scene.alt || (entry && entry.alt) || '',
      busy: false,
    };
    pwParamsToForm();
    openModal('modal-painter');
    renderWorkbench();
  }

  function closeWorkbench() {
    closeModal('modal-painter');
    S.pw = null;
  }

  // 出图参数与「模型设置 · 生图模型」共用同一份 settings.image
  function pwParamsToForm() {
    const im = S.settings.image;
    $('#pw-aspect').value = IMAGE_ASPECTS[im.aspect] ? im.aspect : 'custom';
    $('#pw-width').value = +im.width || 1280;
    $('#pw-height').value = +im.height || 720;
    pwShowWh();
  }

  function pwShowWh() {
    const a = $('#pw-aspect').value;
    const custom = a === 'custom';
    if (!custom && IMAGE_ASPECTS[a]) {
      $('#pw-width').value = IMAGE_ASPECTS[a][0];
      $('#pw-height').value = IMAGE_ASPECTS[a][1];
    }
    $('#pw-row-wh').classList.toggle('hidden', !custom);
    $('#pw-size').value = (+$('#pw-width').value || 0) + 'x' + (+$('#pw-height').value || 0);
  }

  function pwParamsToSettings() {
    const a = $('#pw-aspect').value;
    S.settings.image.aspect = a;
    if (IMAGE_ASPECTS[a]) {
      S.settings.image.width = IMAGE_ASPECTS[a][0];
      S.settings.image.height = IMAGE_ASPECTS[a][1];
    } else {
      S.settings.image.width = Math.max(64, parseInt($('#pw-width').value, 10) || 1280);
      S.settings.image.height = Math.max(64, parseInt($('#pw-height').value, 10) || 720);
    }
    saveAll();
  }

  function renderWorkbench() {
    if (!S.pw) return;
    const scene = imageSceneById(S.pw.sceneId);
    const entry = findImageEntry(S.pw.sceneId);
    const src = A.sceneSrc(scene, entry);
    const img = $('#pw-preview');
    if (src) { img.src = src; img.classList.remove('hidden'); }
    else { img.removeAttribute('src'); img.classList.add('hidden'); }
    $('#pw-alt').value = S.pw.alt;
    $('#pw-prompt').value = S.pw.prompt;
    const meta = [];
    if (entry && entry.id === (S.story.lastBg || '')) meta.push('当前画面');
    if (scene && scene.model) meta.push(scene.model);
    if (scene && scene.size) meta.push(scene.size);
    if (scene && scene.ts) meta.push(fmtTime(scene.ts));
    if (scene && scene.supersededBy) meta.push('已重画为新版');
    $('#pw-meta').textContent = meta.join(' · ');
    // 「按设定卡强制重画」只在已锚定时可用（§4.4 图片侧手动层）
    const card = S.story && S.story.styleCard;
    const hasCard = !!(card && card.locked !== false);
    const fb = $('#btn-pw-force');
    if (fb) {
      fb.disabled = !hasCard || !!S.pw.busy;
      fb.title = hasCard ? '把视觉设定卡的画风与人物设定压进这张图重画' : '还没锚定视觉设定卡（先点「锚定画风」）';
    }
    renderPainterThread();
  }

  function renderPainterThread() {
    const box = $('#pw-thread');
    box.innerHTML = '';
    const th = (S.story && S.story.painterThread) || [];
    if (!th.length) {
      const d = document.createElement('div');
      d.className = 'pw-empty';
      d.textContent = '还没有对话。试试「灯光暖一点」「改成特写」「雾气再重些」。';
      box.appendChild(d);
      return;
    }
    for (const m of th.slice(-40)) {
      const d = document.createElement('div');
      d.className = 'pw-msg ' + (m.role === 'user' ? 'user' : 'painter');
      d.textContent = m.text || '';
      if (m.role !== 'user' && m.prompt) {
        const l = document.createElement('span');
        l.className = 'pw-line';
        l.textContent = '改后 prompt：' + m.prompt;
        d.appendChild(l);
      }
      box.appendChild(d);
    }
    box.scrollTop = box.scrollHeight;
  }

  async function painterThreadSend() {
    if (!S.story || !S.pw || S.pw.busy) return;
    if (offlineBlocked('这句给画师的话')) return;
    const text = $('#pw-input').value.trim();
    if (!text) return;
    $('#pw-input').value = '';
    S.pw.busy = true;
    $('#btn-pw-send').disabled = true;
    $('#btn-pw-redraw').disabled = true;
    $('#btn-pw-force').disabled = true;
    // 用户可能手改过 prompt：先按当下的版本跟画师谈
    const curPrompt = $('#pw-prompt').value.trim();
    const curAlt = $('#pw-alt').value.trim();
    S.pw.prompt = curPrompt;
    S.pw.alt = curAlt;
    S.story.painterThread = S.story.painterThread || [];
    S.story.painterThread.push({ role: 'user', text, ts: Date.now() });
    renderPainterThread();
    const pending = document.createElement('div');
    pending.className = 'pw-msg pending';
    pending.textContent = '画师思考中…';
    $('#pw-thread').appendChild(pending);
    $('#pw-thread').scrollTop = $('#pw-thread').scrollHeight;

    try {
      const res = await painterCompose({
        mode: 'chat', userText: text, tools: true,
        currentPrompt: curPrompt, currentAlt: curAlt,
      });
      // 面板可能在等待期间被关掉（pw 置空）：线程照样落盘，只是不再更新面板
      const fullPrompt = res.promptEn ? composePrompt(res.promptEn, styleSuffixText()) : '';
      if (S.pw && res.promptEn) {
        S.pw.promptRaw = res.promptEn;
        S.pw.prompt = fullPrompt;
        S.pw.alt = res.alt || S.pw.alt;
      }
      const reply = res.reply || (res.promptEn ? '提示词改好了。' : '（画师这次没给改动）');
      S.story.painterThread.push({
        role: 'painter', text: reply,
        prompt: fullPrompt, alt: res.alt || '', ts: Date.now(),
      });
      pending.remove();
      if (S.pw) renderWorkbench();
      if (res.promptEn) toast('画师已更新提示词，点「按此重画」看效果');
    } catch (e) {
      S.story.painterThread.push({ role: 'painter', text: '（画师这次没接上话：' + (e && e.message ? e.message : e) + '）', ts: Date.now() });
      pending.remove();
      if (S.pw) renderWorkbench();
      toast(netErrHint(e), true, true);
    } finally {
      if (S.pw) {
        S.pw.busy = false;
        $('#btn-pw-send').disabled = false;
        $('#btn-pw-redraw').disabled = false;
        $('#btn-pw-force').disabled = false;
      }
      saveAll();
    }
  }

  // 工作台「按此重画」：同 prompt 重画，旧图保留并标 supersededBy（R1/§4.2）
  async function redrawFromWorkbench() {
    if (!S.story || !S.pw || S.pw.busy) return;
    const prompt = $('#pw-prompt').value.trim();
    const alt = $('#pw-alt').value.trim();
    if (!prompt) { toast('prompt 不能为空', true); return; }
    const key = 'redraw:' + S.pw.sceneId;   // §3.C：带 key 防连点（不需要 busy 保护，它改的是已有的图）
    if (paintQ.has(key)) { toast('这张图已在作画队列里'); return; }
    S.pw.busy = true;
    $('#btn-pw-redraw').disabled = true;
    $('#btn-pw-send').disabled = true;
    $('#btn-pw-force').disabled = true;
    pwParamsToSettings();
    const scene = imageSceneById(S.pw.sceneId);
    const entry = findImageEntry(S.pw.sceneId);
    try {
      const newScene = await enqueuePaint({
        key: key,
        prompt, promptRaw: stripStyleSuffix(prompt), alt: alt || (scene && scene.alt) || '',
        supersedesEntry: entry, supersedesScene: scene,
      });
      if (newScene) {
        if (S.pw) {
          S.pw.sceneId = newScene.id;
          S.pw.prompt = newScene.prompt;
          S.pw.promptRaw = newScene.promptRaw;
          S.pw.alt = newScene.alt;
        }
        toast('已重画（旧图保留在记录里）');
      }
      if (S.pw) renderWorkbench();
    } finally {
      if (S.pw) S.pw.busy = false;   // 等图期间面板可能被关掉（pw 置空）
      $('#btn-pw-redraw').disabled = false;
      $('#btn-pw-send').disabled = false;
      $('#btn-pw-force').disabled = false;
      saveAll();
    }
  }

  // 视觉设定卡的「强制」后缀：画风 + 媒介 + 色板 +（画面里出现的人物 → 英文外貌 / 服饰 / 特征）
  function cardForceSuffix(card, context) {
    const parts = [];
    const kw = (card.styleKeywords || []).filter(Boolean);
    if (kw.length) parts.push(kw.join(', '));
    if (card.medium) parts.push(card.medium);
    if (card.palette) parts.push(card.palette);
    const ctx = String(context || '');
    for (const c of (card.characters || [])) {
      if (!c || !c.name || ctx.indexOf(c.name) < 0) continue;
      const bits = [c.appearanceEn, c.outfit, c.features].filter(Boolean);
      if (bits.length) parts.push(bits.join(', '));
    }
    return parts.join(', ');
  }

  // 「按设定卡强制重画」（§4.4 手动层 · 图片侧）：不重走画师自由发挥，直接把卡压进这张图
  async function forceRedrawByCard() {
    if (!S.story || !S.pw || S.pw.busy) return;
    const card = S.story.styleCard;
    if (!card || card.locked === false) { toast('还没锚定视觉设定卡：先点「锚定画风」走一遍', true); return; }
    const curPrompt = $('#pw-prompt').value.trim() || S.pw.prompt || '';
    const alt = $('#pw-alt').value.trim() || S.pw.alt || '';
    const suffix = cardForceSuffix(card, alt + ' ' + curPrompt);
    let raw = curPrompt;
    const i = suffix ? raw.toLowerCase().indexOf(suffix.toLowerCase()) : -1;
    if (i >= 0) raw = raw.slice(0, i).replace(/[,，、]\s*$/, '').trim() || curPrompt;
    const prompt = composePrompt(raw, suffix);
    if (!prompt) { toast('这张图还没有可用的提示词', true); return; }

    const key = 'redraw:' + S.pw.sceneId;   // §3.C：带 key 防连点
    if (paintQ.has(key)) { toast('这张图已在作画队列里'); return; }
    S.pw.busy = true;
    $('#btn-pw-force').disabled = true;
    $('#btn-pw-redraw').disabled = true;
    $('#btn-pw-send').disabled = true;
    pwParamsToSettings();
    $('#pw-prompt').value = prompt;   // 透明：用户看到真正发出去的原话
    S.pw.prompt = prompt; S.pw.promptRaw = raw;
    const scene = imageSceneById(S.pw.sceneId);
    const entry = findImageEntry(S.pw.sceneId);
    try {
      const newScene = await enqueuePaint({
        key: key,
        prompt, promptRaw: raw, alt: alt || (scene && scene.alt) || '',
        supersedesEntry: entry, supersedesScene: scene,
      });
      if (newScene) {
        if (S.pw) {
          S.pw.sceneId = newScene.id;
          S.pw.prompt = newScene.prompt;
          S.pw.promptRaw = newScene.promptRaw;
          S.pw.alt = newScene.alt;
        }
        toast('已按视觉设定卡重画（旧图保留在记录里）');
      }
      if (S.pw) renderWorkbench();
    } finally {
      if (S.pw) S.pw.busy = false;   // 等图期间面板可能被关掉（pw 置空）
      $('#btn-pw-force').disabled = false;
      $('#btn-pw-redraw').disabled = false;
      $('#btn-pw-send').disabled = false;
      saveAll();
    }
  }

  /* ================= 画风锚定（R3 / §5，T-P4-1） =================
   * 开局试画 4 张候选（按用户比例）→（可「再试一批」）→ 选定一张
   * → 画师起草视觉设定卡（可改字段 / 跟画师说着改）→ 锁定并记版本；
   * 跳过 = 无卡自由发挥（靠滚动风格摘要）；「锚定画风」按钮随时重走。 */

  function openAnchor(opts) {
    if (!S.story) { toast('先打开一个故事吧'); return; }
    opts = opts || {};
    S.anchor = {
      onDone: typeof opts.onDone === 'function' ? opts.onDone : null,
      batch: 0, tried: [], candidates: [], pickedIdx: -1, card: null,
      busy: false, doneFired: false,
    };
    const card = S.story.styleCard;
    $('#anchor-intro').textContent = (card && card.locked !== false)
      ? '当前已锚定视觉设定卡 v' + (card.version || 1) + '。重走会先按你的风格基调试画 4 张新候选，锁定后替换。'
      : '画师会按你的风格基调试画 4 张候选。点选一张进入视觉设定卡；不满意就「再试一批」，也可以跳过、自由发挥。';
    $('#anchor-step-pick').classList.remove('hidden');
    $('#anchor-step-card').classList.add('hidden');
    $('#ac-chat').value = '';
    $('#ac-status').textContent = '';
    $('#btn-anchor-use').disabled = true;
    openModal('modal-anchor');
    runAnchorBatch();
  }

  // 关闭 = 结束锚定（锁定 / 跳过 / ✕ / Esc 都走这里）；开局场景下继续开场
  function closeAnchor() {
    const a = S.anchor;
    S.anchor = null;
    closeModal('modal-anchor');
    if (a && !a.doneFired) {
      a.doneFired = true;
      if (a.onDone) a.onDone();
    }
  }

  function setAnchorBusy(on, note) {
    const b = !!on;
    $('#btn-anchor-more').disabled = b;
    $('#btn-anchor-use').disabled = b || !S.anchor || S.anchor.pickedIdx < 0;
    $('#btn-anchor-chat').disabled = b;
    $('#btn-anchor-lock').disabled = b;
    $('#btn-anchor-back').disabled = b;
    if (note != null) $('#ac-status').textContent = note;
  }

  function renderAnchorGrid(placeholder) {
    const grid = $('#anchor-grid');
    grid.innerHTML = '';
    if (!S.anchor) return;
    if (placeholder || !S.anchor.candidates.length) {
      const d = document.createElement('div');
      d.className = 'anchor-hint';
      d.textContent = placeholder || '（还没有候选）';
      grid.appendChild(d);
      return;
    }
    S.anchor.candidates.forEach((c, i) => {
      const cardEl = document.createElement('div');
      cardEl.className = 'anchor-card' + (i === S.anchor.pickedIdx ? ' sel' : '');
      if (c.src) {
        const img = document.createElement('img');
        img.src = c.src;
        img.alt = c.alt || c.promptEn || '候选画风';
        cardEl.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'anchor-ph';
        ph.textContent = c.failed ? '这张没画出来' : '试画中…';
        cardEl.appendChild(ph);
      }
      const kw = document.createElement('div');
      kw.className = 'anchor-kw';
      kw.textContent = (c.keywords || []).slice(0, 4).join(', ') || c.alt || '';
      cardEl.appendChild(kw);
      cardEl.onclick = () => {
        if (!S.anchor || !c.src) return;
        S.anchor.pickedIdx = i;
        $('#btn-anchor-use').disabled = S.anchor.busy;
        renderAnchorGrid();
      };
      grid.appendChild(cardEl);
    });
  }

  // 试画一张候选：按用户设置的比例出图；不落档、不进剧情记录
  async function paintCandidate(promptEn) {
    if (offlineBlocked('这次试画')) return null;
    const cfgImg = imageCfg();
    const adapter = IR.ImageProviders[cfgImg.provider] || IR.ImageProviders['openai-images'];
    return adapter.generate(cfgImg, promptEn);
  }

  async function runAnchorBatch() {
    if (!S.anchor || S.anchor.busy) return;
    S.anchor.busy = true;
    S.anchor.candidates = [];
    S.anchor.pickedIdx = -1;
    setAnchorBusy(true);
    renderAnchorGrid('画师正在构思 4 组画风…');
    try {
      const res = await painterAnchorCompose({
        mode: 'styles', batch: S.anchor.batch + 1, tried: S.anchor.tried.slice(-16),
      });
      if (!S.anchor) return;   // 等回包期间被「跳过 / ✕ / Esc」关掉：这条回包直接丢弃，别再碰 anchor
      const styles = (res.styles || []).slice(0, 4);
      if (!styles.length) throw new Error('画师没有给出候选画风');
      S.anchor.batch += 1;
      S.anchor.candidates = styles.map(s => ({
        keywords: s.keywords || [], promptEn: s.promptEn || '', alt: s.alt || '',
        src: '', loading: true, failed: false,
      }));
      for (const c of S.anchor.candidates) S.anchor.tried = S.anchor.tried.concat(c.keywords);
      renderAnchorGrid();
      // 4 张并发试画；回调里按住候选对象本身，批次被替换后不再更新界面
      S.anchor.candidates.forEach(cand => {
        paintCandidate(cand.promptEn).then(src => {
          cand.src = src; cand.loading = false;
          if (S.anchor && S.anchor.candidates.indexOf(cand) >= 0) renderAnchorGrid();
        }).catch(() => {
          cand.loading = false; cand.failed = true;
          if (S.anchor && S.anchor.candidates.indexOf(cand) >= 0) renderAnchorGrid();
        });
      });
    } catch (e) {
      // 已经关掉锚定弹窗时不再打扰用户（回包迟到 / 被跳过）
      if (S.anchor) {
        renderAnchorGrid('试画没成功：' + (e && e.message ? e.message : e) + '（可以点「再试一批」）');
        toast('试画失败：' + (e && e.message ? e.message : e), true, true);
      }
    } finally {
      if (S.anchor) S.anchor.busy = false;
      setAnchorBusy(false);
    }
  }

  async function anchorDraftCard() {
    if (!S.anchor || S.anchor.busy || S.anchor.pickedIdx < 0) return;
    const picked = S.anchor.candidates[S.anchor.pickedIdx];
    if (!picked || !picked.src) { toast('等这张画出来再选吧'); return; }
    S.anchor.busy = true;
    setAnchorBusy(true);
    $('#btn-anchor-use').textContent = '画师起草中…';
    try {
      const res = await painterAnchorCompose({ mode: 'card', picked });
      if (!res.card) throw new Error('画师没有给出设定卡');
      S.anchor.card = res.card;
      fillAnchorCardForm(res.card);
      $('#anchor-card-preview').src = picked.src;
      $('#ac-picked-kw').textContent = '选定画风：' + ((picked.keywords || []).slice(0, 4).join(', ') || picked.alt || '');
      $('#ac-status').textContent = res.reply || '';
      $('#anchor-step-pick').classList.add('hidden');
      $('#anchor-step-card').classList.remove('hidden');
    } catch (e) {
      toast('生成视觉设定卡失败：' + (e && e.message ? e.message : e), true, true);
    } finally {
      if (S.anchor) S.anchor.busy = false;
      $('#btn-anchor-use').textContent = '用这张定画风';
      setAnchorBusy(false);
    }
  }

  function fillAnchorCardForm(card) {
    card = card || {};
    $('#ac-keywords').value = (card.styleKeywords || []).join(', ');
    $('#ac-medium').value = card.medium || '';
    $('#ac-palette').value = card.palette || '';
    $('#ac-characters').value = (card.characters || []).map(c =>
      [c.name || '', c.appearanceEn || '', c.outfit || '', c.features || ''].join('｜')).join('\n');
    $('#ac-negative').value = card.negative || '';
    $('#ac-note').value = card.note || '';
  }

  function readAnchorCardForm() {
    return {
      styleKeywords: $('#ac-keywords').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      medium: $('#ac-medium').value.trim(),
      palette: $('#ac-palette').value.trim(),
      characters: $('#ac-characters').value.split('\n').map(line => {
        const p = line.split('｜').map(s => s.trim());
        if (!p[0]) return null;
        return { name: p[0], appearanceEn: p[1] || '', outfit: p[2] || '', features: p[3] || '' };
      }).filter(Boolean),
      negative: $('#ac-negative').value.trim(),
      note: $('#ac-note').value.trim(),
    };
  }

  async function anchorCardChat() {
    if (!S.anchor || S.anchor.busy) return;
    const text = $('#ac-chat').value.trim();
    if (!text) return;
    $('#ac-chat').value = '';
    S.anchor.busy = true;
    setAnchorBusy(true, '画师修改中…');
    try {
      const res = await painterAnchorCompose({
        mode: 'cardchat', currentCard: readAnchorCardForm(), userText: text,
      });
      if (res.card) { S.anchor.card = res.card; fillAnchorCardForm(res.card); }
      $('#ac-status').textContent = res.reply || '已更新设定卡。';
    } catch (e) {
      $('#ac-status').textContent = '';
      toast('画师这次没接上话：' + (e && e.message ? e.message : e), true, true);
    } finally {
      if (S.anchor) S.anchor.busy = false;
      setAnchorBusy(false);
    }
  }

  function anchorLock() {
    if (!S.anchor || !S.story) return;
    const form = readAnchorCardForm();
    if (!form.styleKeywords.length && !form.medium && !form.palette && !form.characters.length && !form.note) {
      toast('至少给卡填一点画风关键词或说明', true);
      return;
    }
    const old = S.story.styleCard;
    S.story.styleCard = Object.assign({
      id: (old && old.id) || ('style' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
      version: ((old && +old.version) || 0) + 1,
      locked: true,
      updatedAt: Date.now(),
    }, form);
    saveAll();
    toast('已锁定视觉设定卡（v' + S.story.styleCard.version + '）：之后每张画都带着它', false, true);
    closeAnchor();
  }

  function parsePainterAnchor(raw) {
    const s = String(raw || '');
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    let o = {};
    if (i !== -1 && j > i) { try { o = JSON.parse(s.slice(i, j + 1)); } catch (_) { o = {}; } }
    const styles = Array.isArray(o.styles) ? o.styles.filter(Boolean).map(x => ({
      keywords: Array.isArray(x.keywords) ? x.keywords.filter(Boolean).map(String).slice(0, 8) : [],
      promptEn: String(x.prompt_en || x.promptEn || '').trim(),
      alt: String(x.alt || '').trim(),
    })) : [];
    const c = (o.card && typeof o.card === 'object') ? o.card : null;
    return {
      styles: styles,
      card: c ? {
        styleKeywords: Array.isArray(c.styleKeywords) ? c.styleKeywords.filter(Boolean).map(String).slice(0, 12) : [],
        medium: String(c.medium || '').trim(),
        palette: String(c.palette || '').trim(),
        characters: Array.isArray(c.characters) ? c.characters.filter(x => x && x.name).map(x => ({
          name: String(x.name),
          appearanceEn: String(x.appearanceEn || x.appearance || '').trim(),
          outfit: String(x.outfit || '').trim(),
          features: String(x.features || '').trim(),
        })) : [],
        negative: String(c.negative || '').trim(),
        note: String(c.note || '').trim(),
      } : null,
      reply: String(o.reply || '').trim(),
    };
  }

  // 锚定调用：同样走画师子代理（隔离上下文、用完即弃）
  async function painterAnchorCompose(opts) {
    const cfg = resolveSub('painter');
    const adapter = IR.ChatProviders[cfg.provider] || IR.ChatProviders['openai-compatible'];
    const messages = IR.Context.assemblePainter(S.story, opts);
    const raw = await adapter.chat(cfg, messages);
    return parsePainterAnchor(raw);
  }

  /* ================= 渲染：聊天记录窗口（§4.6） ================= */

  function scrollChatBottom() {
    const box = $('#chat-scroll');
    box.scrollTop = box.scrollHeight;
  }

  function imageSceneById(id) {
    return (S.story.scenes || []).find(s => s.id === id) || null;
  }
  function currentScene() {
    const sc = imageSceneById(S.story.lastBg);
    if (sc) return sc;
    const all = S.story.scenes || [];
    return all.length ? all[all.length - 1] : null;
  }

  // 思考链块（R9 / §4.5）：回答上的可折叠块；点击标题展开/收起，高度带过渡
  function reasonBlock(text, open) {
    const wrap = document.createElement('div');
    wrap.className = 'reason-block';
    if (open) wrap.classList.add('open');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reason-toggle';
    btn.innerHTML = '<span class="reason-caret">▸</span><span class="reason-label">思考链</span>';
    const panel = document.createElement('div');
    panel.className = 'reason-panel';
    const body = document.createElement('div');
    body.className = 'reason-text';
    body.textContent = text || '';
    panel.appendChild(body);
    btn.onclick = () => wrap.classList.toggle('open');
    wrap.appendChild(btn);
    wrap.appendChild(panel);
    return wrap;
  }

  // 流式思考窗（方案 B）：固定上限高度的滚动小窗，思考在窗里滚动跟随；
  // 正文一开始流式就卷成一行；用户点开看全量后仍继续跟随（不暂停）。
  function reasonLiveBlock(text, open) {
    const wrap = document.createElement('div');
    wrap.className = 'reason-block reason-live';
    if (open) wrap.classList.add('open');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reason-toggle';
    btn.innerHTML = '<span class="reason-caret">▸</span><span class="reason-label">思考中…</span>';
    const panel = document.createElement('div');
    panel.className = 'reason-panel';
    const body = document.createElement('div');
    body.className = 'reason-text reason-live-text';
    body.textContent = text || '';
    panel.appendChild(body);
    btn.onclick = () => {
      wrap.classList.toggle('open');
      S.liveReasonOpen = wrap.classList.contains('open');
      panel.scrollTop = panel.scrollHeight;   // 展开后立刻跟到最新
    };
    wrap.appendChild(btn);
    wrap.appendChild(panel);
    return wrap;
  }

  function renderChat() {
    S.liveEl = null;   // DOM 重建后旧引用失效（否则工具回合后的第二次流式会写进已脱离的节点）
    S.liveReasonEl = null;
    resetLiveDelta();   // 同理：span 追踪只对当前气泡有效
    const box = $('#chat-scroll');
    box.innerHTML = '';
    if (!S.story) return;
    const log = S.story.log || [];

    log.forEach((e, i) => {
      box.appendChild(bubbleFor(e, i));
    });

    // 流式 / 打字机中的临时旁白（思考链先流、正文后到，§4.5）
    if (S.live) {
      // 没有思考内容就不渲染折叠条（空白的「思考链」看着像坏了）
      if (S.settings.showReasoning && String(S.live.reasoning || '').trim()) {
        S.liveReasonEl = reasonLiveBlock(S.live.reasoning, S.liveReasonOpen);
        if (S.liveReasonCollapsed) S.liveReasonEl.classList.add('collapsed');
        box.appendChild(S.liveReasonEl);
        const p = S.liveReasonEl.querySelector('.reason-panel');
        if (p) p.scrollTop = p.scrollHeight;
      }
      const d = document.createElement('div');
      d.className = 'bubble bubble-narration bubble-live';
      if (S.live.text) {
        d.textContent = S.live.text;
      } else {
        const pill = document.createElement('span');
        pill.className = 'gen-pill';
        pill.textContent = '生成中…';
        d.appendChild(pill);
      }
      box.appendChild(d);
    }

    // 选项：默认收在输入区上方的「💡 灵感」里；settings.ui.choices = always 时内联在旁白下
    renderChoices();

    A.renderFeatureBar();
    scrollChatBottom();
  }

  function renderChoices() {
    const tray = $('#choice-tray');
    const btn = $('#btn-inspiration');
    const badge = $('#inspiration-count');
    const canShow = !S.busy && !S.live && !!S.story && S.story.mode === 'choice'
      && Array.isArray(S.currentChoices) && S.currentChoices.length > 0;
    const inline = (S.settings.ui && S.settings.ui.choices) === 'always';

    // 内联（always）：放在聊天记录的末尾（旁白下面；后面若又出了图，也不会被插队）
    if (canShow && inline) {
      const box = $('#chat-scroll');
      const wrap = document.createElement('div');
      wrap.className = 'choices-inline';
      S.currentChoices.forEach(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'choice-btn';
        b.textContent = c;
        b.onclick = () => sendPlayerAction(c, true);
        wrap.appendChild(b);
      });
      if (box) box.appendChild(wrap);
    }

    // 托盘（默认）：按钮带数量角标，点开才显示一排选项
    if (btn) {
      const show = canShow && !inline;
      btn.classList.toggle('hidden', !show);
      btn.setAttribute('aria-expanded', show && S.choicesTrayOpen ? 'true' : 'false');
      if (badge) {
        badge.textContent = show ? String(S.currentChoices.length) : '';
        badge.classList.toggle('hidden', !show);
      }
    }
    if (!tray) return;
    tray.innerHTML = '';
    if (!canShow || inline || !S.choicesTrayOpen) {
      tray.classList.add('hidden');
      return;
    }
    S.currentChoices.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tray-btn';
      b.textContent = c;
      b.title = c;
      b.onclick = () => { S.choicesTrayOpen = false; sendPlayerAction(c, true); };
      tray.appendChild(b);
    });
    tray.classList.remove('hidden');
  }

  // 图片 src 只放行 data: / blob: / https:（chat / rp 内联图与灯箱用；javascript: 等一律拒绝）
  function safeImgSrc(src) {
    const s = String(src || '');
    return (/^(data|blob|https):/i.test(s)) ? s : '';
  }

  // 大图优先取原图（imageURL，IndexedDB），没有就用缩略图
  function imageFullSrc(sc, entry) {
    const id = (sc && sc.imageId) || (entry && entry.imageId);
    const orig = id ? Store.imageURL(id) : null;
    return safeImgSrc(orig)
      || safeImgSrc(sc && (sc.src || sc.thumb))
      || safeImgSrc(entry && (entry.src || entry.thumb))
      || '';
  }

  /* ---- 灯箱（chat / rp 的最小看图方案：固定遮罩 + 大图，点遮罩 / Esc 关闭） ---- */
  function openLightbox(entry) {
    const box = $('#lightbox');
    if (!box || !entry) return;
    const sc = imageSceneById(entry.id);
    const full = imageFullSrc(sc, entry);
    if (!full) { toast('这张图没有可用的图像数据', true); return; }
    const img = $('#lightbox-img');
    const alt = $('#lightbox-alt');
    if (img) {
      img.src = full;
      img.alt = entry.alt || '插图';
    }
    if (alt) alt.textContent = entry.alt || '';
    box.classList.remove('hidden');
  }
  function closeLightbox() {
    const box = $('#lightbox');
    if (!box || box.classList.contains('hidden')) return false;
    box.classList.add('hidden');
    const img = $('#lightbox-img');
    if (img) { img.src = ''; img.alt = ''; }
    return true;
  }

  // chat / rp 的内联图气泡（v0.6.0：舞台没了，图直接排在聊天流里）；剧情模式仍走缩略图 + 舞台
  function inlineImageBubble(e) {
    const d = document.createElement('div');
    d.className = 'bubble bubble-image bubble-image-inline';
    const sc = imageSceneById(e.id);
    const src = safeImgSrc(A.sceneSrc(sc, e));
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = e.alt || '插图';
      img.loading = 'lazy';
      img.onclick = () => openLightbox(e);
      d.appendChild(img);
    }
    const cap = document.createElement('div');
    cap.className = 'img-alt';
    cap.textContent = (e.alt || '（一幅插图）') + (e.supersededBy ? ' · 已被重画版替代' : '');
    cap.onclick = () => openLightbox(e);
    d.appendChild(cap);
    return d;
  }

  /* ---- 提案卡（✉ 邮件提案 / 🛒 下单提案）：参数原值用 textContent 渲染（红线 4），未确认不可执行 ---- */
  function proposalStatusLabel(p, now) {
    if (p.status === 'pending') {
      return (now < p.expiresAt) ? '等待确认' : '已过期';
    }
    if (p.status === 'executing') {
      return (p.result && p.result.needsSecondConfirm && !p.result.resolved) ? '执行中（等待你再确认一次）' : '执行中';
    }
    if (p.status === 'done') return p.kind === 'email' ? '已发送' : '已下单';
    if (p.status === 'denied') return '已拒绝';
    if (p.status === 'expired') return '已过期';
    if (p.status === 'failed') return '失败：' + ((p.result && p.result.error) || '未知原因');
    return p.status;
  }

  function proposalBubble(e) {
    const p = e && e.proposal;
    const now = Date.now();
    const d = document.createElement('div');
    d.className = 'bubble proposal-card';
    if (!p) { d.textContent = '（提案数据缺失）'; return d; }
    // 过期就地收敛状态（只改内存对象，与节点共享；下次 saveAll 落盘）
    if (p.status === 'pending' && now >= p.expiresAt) IR.Proposals.markExpired(p);

    const title = document.createElement('div');
    title.className = 'proposal-title';
    title.textContent = (p.kind === 'email' ? '✉ 邮件提案' : '🛒 下单提案') + '（要你确认才执行）';
    d.appendChild(title);

    const table = document.createElement('div');
    table.className = 'proposal-args';
    const row = (k, v) => {
      const r = document.createElement('div');
      r.className = 'proposal-row';
      const kk = document.createElement('span');
      kk.className = 'proposal-key';
      kk.textContent = k;
      const vv = document.createElement('span');
      vv.className = 'proposal-val';
      vv.textContent = String(v == null ? '' : v);   // 工具参数原值，不是模型转述（红线 4）
      r.appendChild(kk); r.appendChild(vv);
      table.appendChild(r);
    };
    if (p.kind === 'email') {
      row('收件人', p.args.to);
      row('主题', p.args.subject);
      row('正文', p.args.body);
    } else {
      row('金额', yuan(p.args.amountCents));
      row('商户', p.args.merchant || '（未填）');
      row('品类', p.args.category || '（未填）');
      row('商品', (p.args.items || []).map(i => i && i.name).filter(Boolean).join('、') || '（未填）');
    }
    if (p.args.reason) row('理由', p.args.reason);
    d.appendChild(table);

    const foot = document.createElement('div');
    foot.className = 'proposal-foot';
    const status = document.createElement('span');
    status.className = 'proposal-status';
    let statusText = proposalStatusLabel(p, now);
    if (p.status === 'pending' && now < p.expiresAt) {
      const mins = Math.max(1, Math.ceil((p.expiresAt - now) / 60000));
      statusText += ' · 有效剩 ' + mins + ' 分钟';
    }
    status.textContent = statusText;
    foot.appendChild(status);

    const actionable = p.status === 'pending' && now < p.expiresAt && !S.busy;
    if (actionable) {
      const ok = document.createElement('button');
      ok.className = 'mini-btn proposal-ok';
      ok.type = 'button';
      ok.textContent = '确认';
      ok.title = '确认后才会真正执行（一封邮件 / 一笔扣款）';
      ok.onclick = () => { confirmProposal(e); };
      const no = document.createElement('button');
      no.className = 'mini-btn';
      no.type = 'button';
      no.textContent = '拒绝';
      no.onclick = () => { denyProposal(e); };
      foot.appendChild(ok);
      foot.appendChild(no);
    }
    d.appendChild(foot);
    return d;
  }

  // 确认 = 一次用户点击 → 最多一次执行（Proposals.confirm 同步抢占状态，连点不会二次执行）
  async function confirmProposal(entry) {
    const p = entry && entry.proposal;
    if (!p) return;
    if (p.status !== 'pending') { renderChat(); return; }   // 幂等：重复点击不再执行
    if (!IR.Proposals.isActionable(p, Date.now())) {
      IR.Proposals.markExpired(p);
      saveAll(); renderChat();
      return;
    }
    if (!A.sidecarReady()) { toast(A.sidecarOffHint(), true, true); return; }
    let res = null;
    try {
      res = await IR.Proposals.confirm(p, IR.Sidecar, Date.now());
    } catch (err) {
      p.status = 'failed';
      p.result = { ok: false, error: String((err && err.message) || err) };
      res = { status: 'failed' };
    }
    if (res && res.needsSecondConfirm) {
      // 红线 3：sidecar 要求人工确认时不得自动批准——再弹一次带额度余量的确认（文案沿用 doPaymentSubmit）
      const a = p.args;
      const rem = (res.summary && res.summary.remaining) || {};
      const lines = [
        '需要你确认这一笔：',
        '',
        '金额：' + A.yuan(a.amountCents),
        '商户：' + (a.merchant || '（未填）'),
        '品类：' + (a.category || '（未填）'),
      ];
      const items = (a.items || []).map(i => i && i.name).filter(Boolean).join('、');
      if (items) lines.push('商品：' + items);
      lines.push('', '每日剩余：' + A.yuan(rem.daily || 0) + ' · 每月剩余：' + A.yuan(rem.monthly || 0), '', '确认后才会真正扣款。');
      const ok = await irConfirm(lines.join('\n'), { title: '确认下单', okText: '确认并支付' });
      if (ok) {
        try { await IR.Proposals.approveSecond(p, IR.Sidecar); } catch (err) {
          p.status = 'failed';
          if (p.result) p.result.error = String((err && err.message) || err);
        }
      } else {
        try { await IR.Proposals.deny(p, IR.Sidecar); } catch (_) {}
      }
    }
    pushLog({ type: 'tool', tool: 'proposal', summary: proposalResultSummary(p) });
    saveAll();
    renderChat();
    renderPayLedger();
    toast(proposalResultSummary(p), p.status === 'failed');
  }

  // 拒绝：不执行任何发送 / 扣款；已有 intent / 草稿时由 Proposals.deny 负责清理
  async function denyProposal(entry) {
    const p = entry && entry.proposal;
    if (!p || (p.status !== 'pending' && p.status !== 'executing')) { renderChat(); return; }
    try { await IR.Proposals.deny(p, IR.Sidecar); } catch (_) {}
    pushLog({ type: 'tool', tool: 'proposal', summary: proposalResultSummary(p) });
    saveAll();
    renderChat();
  }

  function proposalResultSummary(p) {
    if (!p) return '提案状态未知';
    const what = p.kind === 'email'
      ? ('邮件提案（给 ' + p.args.to + '）')
      : ('下单提案（' + A.yuan(p.args.amountCents) + ' · ' + (p.args.merchant || '未填商户') + '）');
    if (p.status === 'done') return what + (p.kind === 'email' ? '：已发送' : '：已完成');
    if (p.status === 'denied') return what + '：已拒绝，未执行';
    if (p.status === 'expired') return what + '：已过期，未执行';
    if (p.status === 'failed') return what + '：失败（' + ((p.result && p.result.error) || '未知原因') + '）';
    return what + '：' + p.status;
  }

  function bubbleFor(e, index) {
    if (e.type === 'proposal') return proposalBubble(e);
    if (e.type === 'tool') {
      const d = document.createElement('div');
      d.className = 'chat-note';
      d.textContent = e.summary || e.tool || '工具调用';
      return d;
    }
    if (e.type === 'system') {
      const d = document.createElement('div');
      d.className = 'chat-note';
      d.textContent = e.text || '';
      return d;
    }
    if (e.type === 'image') {
      // chat / rp（v0.6.0）：舞台没了 → 图直接内联在聊天流里，点开是灯箱；这两个模式不给「工作台」入口
      if (S.story && (S.story.mode === 'chat' || S.story.mode === 'rp')) return inlineImageBubble(e);
      // 场景标记行：56px 小缩略图 + 一行 alt（不再在聊天里内嵌大图）。
      // 点图 / 点文字 = 在右侧舞台选中这张；「工作台」入口悬停时才出现。
      const d = document.createElement('div');
      d.className = 'bubble bubble-image';
      const sc = imageSceneById(e.id);
      const src = A.sceneSrc(sc, e) || null;
      const selectScene = () => {
        if (!S.story) return;
        S.story.lastBg = e.id;
        saveAll();
        renderStage();
        renderThumbs();
      };
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = e.alt || '场景缩略图';
        img.title = '在右侧舞台看这张';
        img.onclick = selectScene;
        d.appendChild(img);
      }
      const row = document.createElement('div');
      row.className = 'img-alt-row';
      const cap = document.createElement('span');
      cap.className = 'img-alt';
      cap.textContent = (e.alt || '（一幅场景插图）') + (e.supersededBy ? ' · 已被重画版替代' : '');
      cap.title = '点击在右侧舞台查看';
      cap.onclick = selectScene;
      row.appendChild(cap);
      const wb = document.createElement('button');
      wb.className = 'mini-btn';
      wb.type = 'button';
      wb.textContent = '工作台';
      wb.title = '看 / 改完整 prompt、跟画师说着改、按此重画';
      wb.onclick = () => openWorkbench(e.id);
      row.appendChild(wb);
      d.appendChild(row);
      return d;
    }

    // 模型主动联系（调度触发）：样式同玩家气泡，另加一行轻量标注「谁 / 何时 / 为何找你」
    if (e.type === 'agent') {
      const d = document.createElement('div');
      d.className = 'bubble bubble-player bubble-agent';
      const tag = document.createElement('div');
      tag.className = 'agent-note';
      tag.textContent = '💠 AI 主动找你'
        + (e.trigger ? '（' + e.trigger + '）' : '')
        + (e.reason ? ' · ' + e.reason : '')
        + (e.ts ? ' · ' + fmtTime(e.ts) : '');
      d.appendChild(tag);
      const body = document.createElement('div');
      body.textContent = e.text || '';
      d.appendChild(body);
      return d;
    }

    const d = document.createElement('div');
    d.className = 'bubble ' + (e.type === 'player' ? 'bubble-player'
      : e.type === 'choice' ? 'bubble-choice'
      : 'bubble-narration');
    // 玩家发言带「做 / 说 / 导演」小标签（旧存档缺 kind 时按「做」显示）
    if (e.type === 'player' || e.type === 'choice') {
      const tag = document.createElement('span');
      tag.className = 'kind-tag';
      tag.textContent = e.type === 'choice' ? '选择' : (KIND_LABELS[e.kind] || KIND_LABELS.do);
      d.appendChild(tag);
    }
    const body = document.createElement('span');
    body.className = 'bubble-text';
    body.textContent = e.text || '';
    d.appendChild(body);
    // 思考链（R9）：旁白上方的可折叠块，showReasoning 可关；空内容不渲染
    if (e.type === 'narration' && S.settings.showReasoning && String(e.reasoning || '').trim()) {
      d.insertBefore(reasonBlock(e.reasoning, false), d.firstChild);
    }

    // 分支导航（§4.3/§5⑤）：凡是有兄弟的旁白都显示 ‹ n/m ›，点了就切到那条分支；
    // 「↻ 重试」仍只在最后一条（§5⑤）。旧版本栈已由迁移展开成兄弟（任务书 §6），不再兜底切换。
    const sibs = (e.type === 'narration' && e.nid && S.story && S.story.tree) ? IR.Tree.siblings(S.story, e.nid) : [];
    const showRetry = e.type === 'narration' && index === lastNarrationIndex() && !S.busy && lastActionEntry();
    const showSibs = e.type === 'narration' && !S.busy && sibs.length > 1;
    if (showRetry || showSibs) {
      const tools = document.createElement('div');
      tools.className = 'bubble-tools';
      if (showRetry) {
        const rb = document.createElement('button');
        rb.className = 'mini-btn';
        rb.textContent = '↻ 重试';
        rb.title = '换一种不同的发展（旧版留在分支里，可用 ‹ › 切回）';
        rb.onclick = retryLast;
        tools.appendChild(rb);
      }
      if (showSibs) {
        const nav = document.createElement('span');
        nav.className = 'version-nav';
        const prev = document.createElement('button');
        prev.className = 'mini-btn'; prev.textContent = '‹'; prev.title = '上一条分支';
        prev.onclick = () => switchSiblingFromBubble(e.nid, -1);
        const label = document.createElement('span');
        label.className = 'version-label';
        label.textContent = (sibs.indexOf(e.nid) + 1) + '/' + sibs.length;
        const next = document.createElement('button');
        next.className = 'mini-btn'; next.textContent = '›'; next.title = '下一条分支';
        next.onclick = () => switchSiblingFromBubble(e.nid, 1);
        nav.appendChild(prev); nav.appendChild(label); nav.appendChild(next);
        tools.appendChild(nav);
      }
      d.appendChild(tools);
    }
    return d;
  }

  /* ================= 渲染：画面面板 ================= */

  // 舞台当前图（UI-1 §4.4）：换画交叉淡入、缩略图 → 原图 blur-up、rich 档 Ken Burns
  let stageShownSrc = '';   // 当前显示的 src
  let stageShownId = '';    // 当前场景 id（区分「换画」与「缩略图升级原图」）
  let stageLoadToken = 0;   // 快速连点缩略条：只让最后一次生效

  function stageImageIdle(img) {
    img.classList.remove('blur-up', 'fade-swap');
    img.style.willChange = '';
  }

  function stagePlaySwap(img, src, cls) {
    stageImageIdle(img);
    img.style.willChange = cls === 'blur-up' ? 'filter' : 'opacity';   // 只在动画进行时临时加
    img.classList.add(cls);
    const onEnd = () => {
      img.removeEventListener('animationend', onEnd);
      stageImageIdle(img);
      A.setStageArt(src);   // 交叉淡入结束后才换模糊底（旧底一直垫着，不闪空白）
    };
    img.addEventListener('animationend', onEnd);
  }

  function setStageImage(sc, src) {
    const img = $('#stage-img'), empty = $('#stage-empty'), cap = $('#stage-caption');
    const sid = (sc && sc.id) || '';
    if (!src) {
      stageLoadToken += 1;
      stageShownSrc = ''; stageShownId = '';
      img.classList.add('hidden');
      img.classList.remove('has-art');
      stageImageIdle(img);
      empty.classList.remove('hidden');
      A.setStageArt('');
      if (cap) cap.textContent = '';
      return;
    }
    img.alt = (sc && sc.alt) || '当前画面';
    img.classList.remove('hidden');
    empty.classList.add('hidden');
    if (cap) cap.textContent = (sc && sc.alt) || '';
    if (src === stageShownSrc) return;   // 没换图：不动画
    const prevSrc = stageShownSrc, prevId = stageShownId;
    stageShownSrc = src; stageShownId = sid;
    const token = ++stageLoadToken;
    const level = motionLevel();
    const commit = (upgrading) => {
      if (token !== stageLoadToken) return;
      img.src = src;
      img.classList.add('has-art');   // Ken Burns（仅 rich）挂在 has-art 上
      if (level === 'off') { stageImageIdle(img); A.setStageArt(src); return; }
      // 同场景的缩略图 → 原图升级走 blur-up（filter，全站唯一一处）；换画走交叉淡入
      stagePlaySwap(img, src, upgrading ? 'blur-up' : 'fade-swap');
    };
    const pre = new Image();
    pre.onload = () => commit(!!prevSrc && !!sid && sid === prevId);
    pre.onerror = () => commit(false);
    pre.src = src;
  }

  function renderStage() {
    const img = $('#stage-img');
    if (!img) return;
    if (!S.story) {
      setStageImage(null, '');
      return;
    }
    setStageImage(currentScene(), sceneSrc(currentScene()));
  }

  // Ken Burns 离屏暂停（data-paused 由 CSS 统一管）：图片不可见时停掉循环
  let stageIO = null;
  function watchStageVisibility() {
    const img = $('#stage-img');
    if (!img || stageIO || typeof IntersectionObserver !== 'function') return;
    stageIO = new IntersectionObserver((entries) => {
      for (const en of entries) {
        en.target.classList.toggle('is-offscreen', !en.isIntersecting);
      }
    });
    stageIO.observe(img);
  }

  function renderThumbs() {
    const strip = $('#thumb-strip');
    strip.innerHTML = '';
    const scenes = (S.story && S.story.scenes) || [];
    if (!scenes.length) {
      const d = document.createElement('div');
      d.className = 'thumb-empty';
      d.textContent = '作画后，这里按时间排开每一幕';
      strip.appendChild(d);
      return;
    }
    for (const sc of scenes) {
      // 缩略条优先用小图（快）；小图缺失但原图在 IndexedDB 里时，等它异步取回来再显示
      const src = sc.thumb || A.sceneSrc(sc);
      if (!src) continue;
      const img = document.createElement('img');
      img.className = 'thumb' + (S.story.lastBg === sc.id ? ' active' : '');
      img.src = src;
      img.alt = sc.alt || '场景缩略图';
      img.title = sc.alt || '';
      img.onclick = () => { S.story.lastBg = sc.id; saveAll(); renderStage(); renderThumbs(); };
      strip.appendChild(img);
    }
  }

  /* ================= 渲染：布局状态（P2 的统一入口） =================
   * 所有排版只由 #screen-game 的 data-layout 决定：
   *   auto → 宽度 ≥ 900px 用 split，否则 stack；immersive 只能由用户进入。
   * 比例 / 收起 / 选项显示都存在 settings.ui（全局），story.ui 只记输入类型。 */

  const LAYOUTS = ['auto', 'split', 'stack', 'immersive'];

  function uiState() {
    if (!S.settings.ui || typeof S.settings.ui !== 'object') S.settings.ui = Store.defaultSettings().ui;
    return S.settings.ui;
  }

  function autoLayout() {
    return (typeof window !== 'undefined' && window.innerWidth >= 900) ? 'split' : 'stack';
  }

  function effectiveLayout() {
    // v0.6.0：chat（智能体）/ rp（扮演）是纯聊天布局（无画面区）；剧情模式的 split / stack / immersive 一行不动
    if (S.story && (S.story.mode === 'chat' || S.story.mode === 'rp')) return 'chat';
    const ui = uiState();
    if (ui.layout === 'immersive') return 'immersive';
    if (ui.layout === 'split' || ui.layout === 'stack') return ui.layout;
    return autoLayout();
  }

  // 设置里的布局项：chat / rp 下给一行灰字说明（布局选项本身不动，切回剧情模式照常生效）
  function renderLayoutHint() {
    const el = $('#ui-layout-hint');
    if (!el) return;
    const noStage = !!(S.story && (S.story.mode === 'chat' || S.story.mode === 'rp'));
    el.textContent = noStage ? '此模式没有画面区（纯聊天布局），下面的布局选项只对剧情模式生效。' : '';
  }

  function isImmersive() {
    return effectiveLayout() === 'immersive';
  }

  function setLayout(next) {
    const ui = uiState();
    ui.layout = LAYOUTS.indexOf(next) >= 0 ? next : 'auto';
    if (ui.layout !== 'immersive') S.immersiveTextHidden = false;
    applyLayout();
    persistSettings();
  }

  function applyLayout() {
    const el = $('#screen-game');
    if (!el) return;
    const ui = uiState();
    const layout = effectiveLayout();
    el.dataset.layout = layout;
    el.style.setProperty('--split-ratio', String(ui.splitRatio || 0.5));
    el.classList.toggle('no-image', !!ui.imageCollapsed && layout !== 'immersive');
    el.classList.toggle('text-hidden', !!S.immersiveTextHidden);
    if (layout !== 'stack') { el.classList.remove('stage-strip', 'kb-open'); }
    renderLayoutHint();

    const exitBtn = $('#btn-immersive-exit');
    if (exitBtn) exitBtn.classList.toggle('hidden', layout !== 'immersive');
    const toggle = $('#btn-toggle-image');
    if (toggle) toggle.title = ui.imageCollapsed ? '展开画面' : '收起画面';
    const imm = $('#btn-immersive');
    if (imm) imm.title = layout === 'immersive' ? '退出沉浸（Esc）' : '沉浸（画面铺满）';
  }

  // 画面（收起 / 展开舞台）：沉浸态下等同于退出沉浸
  function toggleStagePanel() {
    if (!S.story) return;
    const ui = uiState();
    if (isImmersive()) { setLayout('auto'); return; }
    ui.imageCollapsed = !ui.imageCollapsed;
    applyLayout();
    persistSettings();
  }

  function enterImmersive() {
    if (!S.story) return;
    setLayout('immersive');
    S.immersiveTextHidden = false;
    applyLayout();
  }

  // Esc / ✕ 退出沉浸态：回到「自动」布局
  function exitImmersive() {
    if (!isImmersive()) return false;
    S.immersiveTextHidden = false;
    setLayout('auto');
    return true;
  }

  function bindSplitter() {
    const sp = $('#splitter');
    if (!sp) return;
    let dragging = false;
    const onMove = (clientX, touch) => {
      if (!S.story || effectiveLayout() !== 'split') return;
      const rect = $('#game-layout').getBoundingClientRect();
      const p = (clientX - rect.left) / Math.max(1, rect.width);
      // 每栏最小约 28%
      uiState().splitRatio = Math.max(0.28, Math.min(0.72, p));
      applyLayout();
      if (touch && touch.preventDefault) touch.preventDefault();
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      sp.classList.remove('dragging');
      if (S.story) persistSettings();
    };
    sp.addEventListener('mousedown', e => { dragging = true; sp.classList.add('dragging'); e.preventDefault(); });
    window.addEventListener('mousemove', e => { if (dragging) onMove(e.clientX); });
    window.addEventListener('mouseup', stop);
    sp.addEventListener('touchstart', () => { dragging = true; sp.classList.add('dragging'); }, { passive: true });
    window.addEventListener('touchmove', e => {
      if (dragging && e.touches && e.touches[0]) onMove(e.touches[0].clientX, e);
    }, { passive: false });
    window.addEventListener('touchend', stop);
    // 双击分隔条恢复 1:1
    sp.addEventListener('dblclick', () => {
      uiState().splitRatio = 0.5;
      applyLayout();
      persistSettings();
    });
    // 窗口尺寸变化：auto 需要在 split / stack 之间切换
    let rzTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(applyLayout, 120);
    });
  }

  /* ================= 进入 / 离开故事 ================= */

  function enterGame(fresh, opts) {
    opts = opts || {};
    if (!S.story) return;
    // 分支树（§4.1/§3）：树是唯一真源——载入一律先 ensure（旧档建线性链 / 坏树降级）再 project 重建 log / messages 等
    try {
      IR.Tree.ensure(S.story);
      IR.Tree.project(S.story);
    } catch (e) { console.warn('IR.Tree 初始化失败（按存档原样继续）：', e); }
    S.story.ui = Object.assign(Store.defaultUi(), S.story.ui || {});
    $('#screen-start').classList.add('hidden');
    $('#screen-shelf').classList.add('hidden');
    $('#screen-game').classList.remove('hidden');
    $('#screen-game').classList.remove('stage-strip', 'text-hidden');
    A.closeMenus();
    S.immersiveTextHidden = false;
    $('#hud-title').textContent = S.story.title;
    $('#hud-mode').textContent = MODE_LABELS[S.story.mode] || '剧情';
    syncKindSwitch();
    S.choicesTrayOpen = false;
    applyLayout();
    renderChat();
    renderStage();
    renderThumbs();
    if (fresh) {
      S.currentChoices = choicesFromHead();
      renderChat();
      saveAll();
      // deferOpening：先走试画锚定（P4），锚定结束（锁定/跳过）后再开场
      if (!opts.deferOpening) runOpening();
    } else {
      S.currentChoices = choicesFromHead();   // §4.3：选项跟着 head 的 assistantMsg 恢复（刷新后不丢）
      renderNarrationToolsAfterLoad();
      saveAll();
      // 空档补开场（例：锚定向导还没走完就刷新了页面）
      if (!(S.story.log || []).length && !(S.story.messages || []).length) runOpening();
    }
  }

  function renderNarrationToolsAfterLoad() {
    // 重试控件由 renderChat 渲染；这里只处理输入框可用状态
    $('#btn-send').disabled = false;
  }

  /* ================= 设置界面 ================= */

  function syncSettingsToForm() {
    renderLayoutHint();   // 布局项在 chat / rp 下要有「此模式没有画面区」的灰字说明
    // 可选本地服务：这里只同步「怎么连它」（端口 + token）；额度 / 白名单等安全项由侧车 config.json 提供
    const sc = S.settings.sidecar || {};
    if ($('#s-sidecar-port')) $('#s-sidecar-port').value = sc.port || 4319;
    if ($('#s-sidecar-token')) $('#s-sidecar-token').value = sc.token || '';
    $('#s-chat-base').value = S.settings.chat.baseUrl;
    $('#s-chat-model').value = S.settings.chat.model;
    $('#s-chat-key').value = S.settings.chat.apiKey;
    $('#s-chat-temp').value = S.settings.chat.temperature;
    $('#s-chat-params').value = typeof S.settings.chat.extraParams === 'string' ? S.settings.chat.extraParams : '';

    $('#s-painter-base').value = S.settings.painter.baseUrl;
    $('#s-painter-model').value = S.settings.painter.model;
    $('#s-painter-key').value = S.settings.painter.apiKey;

    $('#s-scribe-enabled').checked = !!S.settings.scribe.enabled;
    $('#s-scribe-every').value = S.settings.scribe.every || 10;
    $('#s-scribe-ai').checked = S.settings.scribe.aiTasks !== false;
    $('#s-scribe-base').value = S.settings.scribe.baseUrl;
    $('#s-scribe-model').value = S.settings.scribe.model;
    $('#s-scribe-key').value = S.settings.scribe.apiKey;

    $('#s-draft-base').value = S.settings.draft.baseUrl;
    $('#s-draft-model').value = S.settings.draft.model;
    $('#s-draft-key').value = S.settings.draft.apiKey;

    $('#s-image-base').value = S.settings.image.baseUrl;
    $('#s-image-model').value = S.settings.image.model;
    $('#s-image-key').value = S.settings.image.apiKey;
    $('#s-image-params').value = typeof S.settings.image.extraParams === 'string' ? S.settings.image.extraParams : '';
    $('#s-image-aspect').value = S.settings.image.aspect || '16:9';
    $('#s-image-width').value = S.settings.image.width || 1280;
    $('#s-image-height').value = S.settings.image.height || 720;
    applyAspectToFields();

    $('#s-show-reasoning').checked = !!S.settings.showReasoning;
    $('#s-tools-enabled').checked = S.settings.toolsEnabled !== 'off';
    renderNoToolsHint();
    // R13 用户画像：默认全关，可按模式单独开或全开（'all' 与三个勾等价）
    const up = S.settings.userProfile || {};
    const enabled = up.enabled === 'all' ? { choice: true, chat: true, rp: true } : (up.enabled || {});
    $('#s-profile-choice').checked = !!enabled.choice;
    $('#s-profile-chat').checked = !!enabled.chat;
    $('#s-profile-rp').checked = !!enabled.rp;
    $('#s-profile-scope').value = up.scope === 'per-story' ? 'per-story' : 'global';
    renderProfilePanel();
    $('#s-style-preset').value = S.settings.stylePreset;
    $('#s-style-custom').value = S.settings.styleCustom;
    const sui = S.settings.ui || Store.defaultSettings().ui;
    if ($('#s-ui-layout')) $('#s-ui-layout').value = sui.layout === 'immersive' ? 'auto' : sui.layout;
    if ($('#s-ui-choices')) $('#s-ui-choices').value = sui.choices === 'always' ? 'always' : 'tray';
    if ($('#s-ui-motion')) $('#s-ui-motion').value = ['auto', 'off', 'standard', 'rich'].indexOf(sui.motion) >= 0 ? sui.motion : 'auto';
    document.querySelectorAll('input[name="s-trigger"]').forEach(r => { r.checked = r.value === S.settings.trigger; });
    A.renderCapabilityFields();
    renderStoryPanels();
    renderInjectHint();
    A.renderSavepoints();
  }

  function applyAspectToFields() {
    const a = $('#s-image-aspect').value;
    const dis = a !== 'custom';
    $('#s-image-width').disabled = dis;
    $('#s-image-height').disabled = dis;
    if (IMAGE_ASPECTS[a]) {
      $('#s-image-width').value = IMAGE_ASPECTS[a][0];
      $('#s-image-height').value = IMAGE_ASPECTS[a][1];
    }
  }

  function applyFormToSettings() {
    // 连接信息写回前端设置；安全项（额度 / 白名单）不在这里，走 saveFeatureConfig → 侧车
    S.settings.sidecar = {
      port: Number(($('#s-sidecar-port') || {}).value) || 4319,
      token: (($('#s-sidecar-token') || {}).value || '').trim(),
    };
    if (IR.Sidecar) IR.Sidecar.configure(S.settings.sidecar);
    S.settings.chat.provider = 'openai-compatible';
    S.settings.chat.baseUrl = $('#s-chat-base').value.trim();
    S.settings.chat.model = $('#s-chat-model').value.trim();
    S.settings.chat.apiKey = $('#s-chat-key').value.trim();
    S.settings.chat.temperature = parseFloat($('#s-chat-temp').value);
    if (!Number.isFinite(S.settings.chat.temperature)) S.settings.chat.temperature = 0.9;
    if (!$('#wrap-chat-thinking').classList.contains('hidden')) {
      S.settings.chat.thinking = $('#s-chat-thinking').value || 'default';
    } else {
      S.settings.chat.thinking = 'default';
    }
    S.settings.chat.contextWindow = Math.max(0, parseInt($('#s-chat-ctx').value, 10) || 0);
    // 手填参数原样并入请求体（providers.js mergeExtraParams）
    S.settings.chat.extraParams = $('#s-chat-params').value.trim();

    S.settings.painter.baseUrl = $('#s-painter-base').value.trim();
    S.settings.painter.model = $('#s-painter-model').value.trim();
    S.settings.painter.apiKey = $('#s-painter-key').value.trim();

    S.settings.scribe.enabled = $('#s-scribe-enabled').checked;
    S.settings.scribe.every = Math.max(1, parseInt($('#s-scribe-every').value, 10) || 10);
    S.settings.scribe.aiTasks = $('#s-scribe-ai').checked;
    S.settings.scribe.baseUrl = $('#s-scribe-base').value.trim();
    S.settings.scribe.model = $('#s-scribe-model').value.trim();
    S.settings.scribe.apiKey = $('#s-scribe-key').value.trim();

    S.settings.draft.baseUrl = $('#s-draft-base').value.trim();
    S.settings.draft.model = $('#s-draft-model').value.trim();
    S.settings.draft.apiKey = $('#s-draft-key').value.trim();

    S.settings.image.provider = 'openai-images';
    S.settings.image.baseUrl = $('#s-image-base').value.trim();
    S.settings.image.model = $('#s-image-model').value.trim();
    S.settings.image.apiKey = $('#s-image-key').value.trim();
    S.settings.image.aspect = $('#s-image-aspect').value;
    S.settings.image.width = parseInt($('#s-image-width').value, 10) || 1280;
    S.settings.image.height = parseInt($('#s-image-height').value, 10) || 720;
    S.settings.image.extraParams = $('#s-image-params').value.trim();
    if (!$('#wrap-image-size').classList.contains('hidden')) S.settings.image.size = $('#s-image-size').value;
    else delete S.settings.image.size;
    if (!$('#wrap-image-quality').classList.contains('hidden')) S.settings.image.quality = $('#s-image-quality').value;
    else delete S.settings.image.quality;

    // R13 用户画像：三个勾全开 = 'all'（等价写法，省得以后加模式还要改数据）
    const pChoice = $('#s-profile-choice').checked;
    const pChat = $('#s-profile-chat').checked;
    const pRp = $('#s-profile-rp').checked;
    S.settings.userProfile = {
      enabled: (pChoice && pChat && pRp) ? 'all' : { choice: pChoice, chat: pChat, rp: pRp },
      scope: $('#s-profile-scope').value === 'per-story' ? 'per-story' : 'global',
    };

    // 界面：布局 / 选项显示（P2；沉浸态不写回，保存后回到自动布局）
    if (!S.settings.ui) S.settings.ui = Store.defaultSettings().ui;
    if ($('#s-ui-layout')) {
      const lv = $('#s-ui-layout').value;
      S.settings.ui.layout = (lv === 'split' || lv === 'stack') ? lv : 'auto';
    }
    if ($('#s-ui-choices')) S.settings.ui.choices = $('#s-ui-choices').value === 'always' ? 'always' : 'tray';
    if ($('#s-ui-motion')) {
      const mv = $('#s-ui-motion').value;
      S.settings.ui.motion = ['auto', 'off', 'standard', 'rich'].indexOf(mv) >= 0 ? mv : 'auto';
      applyMotion();   // 动效强度即时生效
    }

    const prevShowReasoning = S.settings.showReasoning;
    S.settings.showReasoning = $('#s-show-reasoning').checked;
    S.settings.toolsEnabled = $('#s-tools-enabled').checked ? 'on' : 'off';
    S.settings.stylePreset = $('#s-style-preset').value;
    S.settings.styleCustom = $('#s-style-custom').value.trim();
    const t = document.querySelector('input[name="s-trigger"]:checked');
    S.settings.trigger = t ? t.value : 'choice';
    saveAll();
    if (S.story) { applyLayout(); renderChat(); }   // 布局 / 选项显示即时生效
    if (prevShowReasoning !== S.settings.showReasoning) renderChat();   // 思考链开关即时生效
  }

  /* ---- 「测试连接」：只读当前输入框的值 ----
   * 三个原则：① 不保存设置、② 不生成内容、③ 生图绝不出图（不花钱）。
   * 子模型（画师 / 书记员 / 起草）留空的项按「沿用剧情模型」代入，测的就是实际会用到的那套配置。 */
  const TEST_TARGETS = {
    chat:    { kind: 'chat',  self: ['#s-chat-base', '#s-chat-key', '#s-chat-model'] },
    painter: { kind: 'chat',  self: ['#s-painter-base', '#s-painter-key', '#s-painter-model'], inherit: ['#s-chat-base', '#s-chat-key', '#s-chat-model'] },
    scribe:  { kind: 'chat',  self: ['#s-scribe-base', '#s-scribe-key', '#s-scribe-model'], inherit: ['#s-chat-base', '#s-chat-key', '#s-chat-model'] },
    draft:   { kind: 'chat',  self: ['#s-draft-base', '#s-draft-key', '#s-draft-model'], inherit: ['#s-chat-base', '#s-chat-key', '#s-chat-model'] },
    image:   { kind: 'image', self: ['#s-image-base', '#s-image-key', '#s-image-model'] },
  };

  function readTestCfg(t) {
    const pick = sels => {
      for (const s of sels) { const el = $(s); const v = el ? String(el.value || '').trim() : ''; if (v) return v; }
      return '';
    };
    let inherited = false;
    const grab = i => {
      const own = pick([t.self[i]]);
      if (own) return own;
      if (!t.inherit) return '';
      inherited = true;
      return pick([t.inherit[i]]);
    };
    return {
      cfg: {
        provider: t.kind === 'image' ? 'openai-images' : 'openai-compatible',
        baseUrl: grab(0), apiKey: grab(1), model: grab(2),
      },
      inherited,
    };
  }

  async function testConnection(key, btn) {
    const t = TEST_TARGETS[key];
    if (!t) return;
    const el = $('#test-' + key + '-state');
    const set = (level, message) => {
      if (!el) return;
      el.className = 'hint test-state' + (level ? ' ' + level : '');
      el.textContent = message;
    };

    if (DEMO) { set('warn', '演示模式不联网：这里没有真实接口可测。去掉地址栏的 ?demo=1 重新打开就能测了。'); return; }

    const { cfg, inherited } = readTestCfg(t);
    const adapter = t.kind === 'image'
      ? (IR.ImageProviders[cfg.provider] || IR.ImageProviders['openai-images'])
      : (IR.ChatProviders[cfg.provider] || IR.ChatProviders['openai-compatible']);
    if (!adapter || typeof adapter.test !== 'function') { set('fail', '这个适配器不支持测试连接。'); return; }

    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
    set(null, '正在连接 ' + (cfg.baseUrl || '（还没填地址）') + ' …');
    try {
      const r = await adapter.test(cfg);
      set(r.level, r.message + (inherited ? '（留空项已按剧情模型代入）' : ''));
    } catch (e) {
      set('fail', '测试失败：' + ((e && e.message) ? e.message : String(e)));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  }

  // 不内置任何服务商预设：Base URL / 模型名 / 参数全部由用户手填，
  // 避免厂商与模型名每天变动、项目疲于维护（通用 OpenAI 兼容适配器已覆盖所有接口）。

  /* ================= 故事记忆面板（世界卡 / 摘要栈 / 留痕 / 模式） ================= */

  // P4「画风」区域：视觉设定卡状态 + 滚动风格摘要 + 重走锚定入口
  function renderStylePanel() {
    const has = !!S.story;
    const card = has ? S.story.styleCard : null;
    $('#btn-anchor-rerun').disabled = !has;
    if (card && card.locked !== false) {
      $('#style-card-state').textContent = '视觉设定卡 v' + (card.version || 1)
        + (card.updatedAt ? '（' + fmtTime(card.updatedAt) + ' 锁定）' : '') + '：之后每张画都带着它。';
      $('#style-card-view').classList.remove('hidden');
      $('#style-card-text').textContent = IR.Context.styleCardText(card) || '（卡是空的）';
    } else {
      $('#style-card-state').textContent = has
        ? '未锚定：画师自由发挥（上面的画风预设兜底）；也可以走一遍「锚定画风」。'
        : '进入一个故事后，这里可以查看或重走画风锚定。';
      $('#style-card-view').classList.add('hidden');
    }
    const rs = (has && S.story.rollingStyle) || {};
    const parts = [
      rs.style ? ('风格倾向：' + rs.style) : '',
      rs.scenes ? ('常见场景：' + rs.scenes) : '',
      rs.wardrobe ? ('服饰元素：' + rs.wardrobe) : '',
    ].filter(Boolean);
    $('#rolling-style-text').textContent = '滚动风格摘要（每次出图后自动更新）：'
      + (parts.length ? parts.join('；') : '（还没出过图）');
  }

  function renderStoryPanels() {
    const has = !!S.story;
    renderStylePanel();
    renderProfilePanel();
    renderCardPanel();
    $('#memory-empty').classList.toggle('hidden', has);
    $('#memory-panels').classList.toggle('hidden', !has);
    if (!has) return;
    const w = S.story.world || {};
    $('#w-place').value = w.place || '';
    $('#w-time').value = w.time || '';
    $('#w-scene').value = w.scene || '';
    $('#w-threads').value = (w.threads || []).join('\n');
    $('#w-characters').value = (w.characters || [])
      .map(c => [c.name || '', c.presence || '', c.personality || '', c.speech || '', c.note || ''].join('｜')).join('\n');
    $('#w-rel-stage').value = (w.relationship || {}).stage || '';
    $('#w-rel-bonds').value = ((w.relationship || {}).bonds || []).join('\n');
    $('#w-rel-notes').value = (w.relationship || {}).notes || '';
    $('#world-scribe-at').textContent = w.scribeAt ? ('上次书记员校对：' + new Date(w.scribeAt).toLocaleTimeString()) : '尚未校对';
    const sl = $('#summary-list'); sl.innerHTML = '';
    (S.story.summaries || []).forEach(s => { const d = document.createElement('div'); d.className = 'mono-line'; d.textContent = s; sl.appendChild(d); });
    $('#sum-count').textContent = (S.story.summaries || []).length;
    const tl = $('#tool-list'); tl.innerHTML = '';
    S.story.log.filter(e => e.type === 'tool').slice(-40).forEach(e => {
      const d = document.createElement('div'); d.className = 'mono-line';
      d.textContent = '· ' + (e.tool || '') + '：' + (e.summary || '');
      tl.appendChild(d);
    });
    $('#s-story-mode').value = S.story.mode || 'choice';
  }

  // 角色卡状态（R13）：rp 常驻；切出 rp 时卡保留在存档里只是停用（§4.8）
  function renderCardPanel() {
    const el = $('#rc-status');
    if (!el) return;
    $('#btn-edit-card').disabled = !S.story;
    const card = S.story && S.story.characterCard;
    if (!card) {
      el.textContent = '还没有角色卡：切到「扮演」会先让你建一张 / 导入一张（SillyTavern V2/V3 PNG 也可）。';
      return;
    }
    el.textContent = '角色卡：' + (card.name || '（无名）') + '（' + IR.RoleCard.sourceLabel(card) + '）'
      + (S.story.mode === 'rp' ? ' · 扮演中：每轮常驻，开场白已进场' : ' · 已保留：切到扮演模式即启用');
  }

  function saveWorldFromForm() {
    if (!S.story) return;
    const w = S.story.world || (S.story.world = Store.defaultWorld());
    w.place = $('#w-place').value.trim();
    w.time = $('#w-time').value.trim();
    w.scene = $('#w-scene').value.trim();
    w.threads = $('#w-threads').value.split('\n').map(s => s.trim()).filter(Boolean);
    const prevByName = {};
    (w.characters || []).forEach(c => { if (c && c.name) prevByName[c.name] = c; });
    w.characters = $('#w-characters').value.split('\n').map(line => {
      const p = line.split('｜').map(s => s.trim());
      if (!p[0]) return null;
      const prev = prevByName[p[0]] || {};
      return Object.assign({}, prev, {
        name: p[0], presence: p[1] || prev.presence || '', personality: p[2] || '',
        speech: p[3] || '', note: p[4] !== undefined ? p[4] : '', noteLocked: true,
      });
    }).filter(Boolean);
    w.relationship = Object.assign({ stage: '', bonds: [], notes: '' }, w.relationship || {}, {
      stage: $('#w-rel-stage').value.trim(),
      bonds: $('#w-rel-bonds').value.split('\n').map(s => s.trim()).filter(Boolean),
      notes: $('#w-rel-notes').value.trim(),
    });
    w.updatedAt = Date.now();
    saveAll();
    renderStoryPanels();
    toast('世界卡已保存，下一回合生效');
  }

  /* ---------- 🧠 注入记忆（§4.4 手动层；第十六轮定案：不用 tool_choice） ---------- */

  // 按钮在「模型设置 · 故事记忆」里：点一下排定下一回合强制注入完整世界卡 + 设定 + 视觉设定卡
  function toggleInjectMemory() {
    if (!S.story) { toast('先打开一个故事'); return; }
    S.pendingInject = !S.pendingInject;
    renderInjectHint();
    toast(S.pendingInject
      ? '已排定：下一回合带上完整记忆，并要求 AI 先复述处境再继续'
      : '已取消注入');
  }

  function renderInjectHint() {
    const el = $('#inject-state');
    const btn = $('#btn-inject-memory');
    if (!el || !btn) return;
    btn.disabled = !S.story;
    btn.textContent = S.pendingInject ? '取消注入' : '注入记忆';
    el.textContent = S.pendingInject
      ? '已排定：下一回合把完整世界卡 + 设定 + 视觉设定卡直接注入上下文，并要求先复述处境再继续。'
      : '手动层：点一下排定下一回合强制注入完整记忆（世界卡 + 设定 + 视觉设定卡），让 AI 先复述处境再继续。';
  }

  /* ---------- 用户画像面板（R13 / §4.12：面板在模型设置里，每条可删、可清空） ---------- */

  function profileStore() {
    const scope = (S.settings.userProfile || {}).scope === 'per-story' ? 'per-story' : 'global';
    if (scope === 'global') return { scope: scope, entries: Store.loadUserProfile() };
    return { scope: scope, entries: S.story ? (S.story.userProfile || []) : [] };
  }

  function writeProfile(entries) {
    const scope = (S.settings.userProfile || {}).scope === 'per-story' ? 'per-story' : 'global';
    if (scope === 'global') Store.saveUserProfile(entries);
    else if (S.story) { S.story.userProfile = entries; saveAll(); }
  }

  function renderProfilePanel() {
    const el = $('#profile-list');
    if (!el) return;
    const st = profileStore();
    const on = IR.Context.profileEnabledFor((S.settings.userProfile || {}).enabled, (S.story && S.story.mode) || 'choice');
    $('#profile-state').textContent = (st.scope === 'per-story' && !S.story)
      ? '范围 = 仅当前故事：进入一个故事后才有本档画像；也可以切成「全局」。'
      : ('范围：' + (st.scope === 'global' ? '全局（跨故事共享）' : '仅当前故事') + ' · 共 ' + st.entries.length + ' 条'
        + (on ? ' · 当前模式已开启（收集 + 按需注入）' : ' · 当前模式开关未开（停止收集，已存条目保留）'));
    el.innerHTML = '';
    st.entries.slice().reverse().forEach((e) => {
      const idx = st.entries.indexOf(e);
      const row = document.createElement('div');
      row.className = 'mono-row';
      const text = document.createElement('span');
      text.className = 'mono-line';
      text.textContent = (IR.Context.PROFILE_KIND_LABEL[e.kind] || '事实') + '｜' + e.text;
      row.appendChild(text);
      row.appendChild(miniBtn('删除', () => deleteProfileEntry(idx)));
      el.appendChild(row);
    });
    $('#btn-profile-clear').disabled = !st.entries.length;
  }

  function deleteProfileEntry(idx) {
    if (idx < 0) return;
    const st = profileStore();
    const next = st.entries.slice();
    next.splice(idx, 1);
    writeProfile(next);
    renderProfilePanel();
    toast('已删除这条画像');
  }

  async function clearProfile() {
    const st = profileStore();
    if (!st.entries.length) return;
    if (!await irConfirm('清空全部画像条目？' + (st.scope === 'global' ? '（全局，所有故事共用）' : '（仅当前故事）'), { title: '清空画像', okText: '清空' })) return;
    writeProfile([]);
    renderProfilePanel();
    toast('画像已清空（开关不受影响）');
  }

  function onModeChange(e) {
    if (!S.story) return;
    const m = e.target.value;
    const prev = S.story.mode || 'choice';
    if (m === 'rp' && !S.story.characterCard) {
      // §4.8：切到 rp 时若没有角色卡 → 弹角色卡选择 / 新建；取消则留在原模式
      S.story.mode = m;
      $('#hud-mode').textContent = MODE_LABELS[m] || '剧情';
      saveAll();
      applyLayout();
      syncKindSwitch();
      renderChat();
      A.openCardEditor({
        mode: 'edit',
        onCancel: () => {
          S.story.mode = prev;
          $('#s-story-mode').value = prev;
          $('#hud-mode').textContent = MODE_LABELS[prev] || '剧情';
          saveAll();
          applyLayout();
          syncKindSwitch();
          renderChat();
        },
      });
      return;
    }
    S.story.mode = m;
    $('#hud-mode').textContent = MODE_LABELS[m] || '剧情';
    saveAll();
    applyLayout();      // 剧情 ↔ chat/rp 来回切：舞台与图都还在（只是不显示），布局要跟着模式走
    syncKindSwitch();   // chat 隐藏做 / 说 / 导演；story.ui.kind 保留不清
    renderChat();
    renderStoryPanels();
  }

  /* ================= 事件绑定 ================= */

  function bind() {
    // —— 书架 ——
    $('#btn-new-story').onclick = () => openModal('modal-new');
    $('#btn-close-new').onclick = () => closeModal('modal-new');
    document.querySelectorAll('#modal-new .mode-card').forEach(b => {
      b.onclick = () => {
        const mode = b.dataset.mode;
        closeModal('modal-new');
        if (mode === 'choice') A.openWizard(null);
        else A.createStoryImmediate(mode);
      };
    });
    $('#btn-shelf-settings').onclick = A.openSettings;
    $('#btn-shelf-home').onclick = A.showStart;
    $('#btn-import').onclick = () => $('#file-import').click();
    $('#file-import').onchange = e => { handleImportFile(e.target.files && e.target.files[0]); e.target.value = ''; };

    // —— 剧情文本导入（R12 路径②，§4.11 / T-P6-1） ——
    $('#btn-import-text').onclick = A.openImportText;
    $('#btn-start-import').onclick = A.openImportText;
    $('#btn-close-import-text').onclick = A.closeImportText;
    $('#btn-it-cancel').onclick = A.closeImportText;
    $('#btn-it-run').onclick = A.runImportText;
    $('#it-text').addEventListener('input', A.importPlanHint);
    $('#it-model-mode').addEventListener('change', e => {
      S.importModelMode = e.target.value === 'draft' ? 'draft' : 'follow';
      A.importPlanHint();
    });
    $('#btn-it-back').onclick = () => {
      if (S.importJob && S.importJob.busy) return;
      $('#it-step-confirm').classList.add('hidden');
      $('#it-step-run').classList.add('hidden');
      $('#it-step-paste').classList.remove('hidden');
      A.importPlanHint();
    };
    $('#btn-it-start').onclick = A.startFromImport;

    // —— 开始页：三张模式卡即三个开局入口，点哪张就按哪种模式开局（无「开始」按钮）——
    document.querySelectorAll('#start-modes .mode-card').forEach(b => {
      b.onclick = () => A.startFromStart(b.dataset.mode);
    });
    $('#btn-start-shelf').onclick = A.showShelf;
    $('#btn-open-settings').onclick = A.openSettings;
    $('#btn-continue').onclick = A.continueLast;
    // 「🎬 离线演示」：带上 ?demo=1 重开一次（演示模式靠查询参数判定，刷新即回到普通模式）
    $('#btn-start-demo').onclick = () => { location.href = '?demo=1'; };

    // 拖进窗口即可导入（书架与开始页都支持）
    [$('#screen-shelf'), $('#screen-start')].forEach(scr => {
      scr.addEventListener('dragover', e => { e.preventDefault(); scr.classList.add('dragover'); });
      scr.addEventListener('dragleave', () => scr.classList.remove('dragover'));
      scr.addEventListener('drop', e => {
        e.preventDefault();
        scr.classList.remove('dragover');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        A.handleImportFile(f);
      });
    });

    // —— 阅读页 HUD ——
    // 左上「←」退出故事回首页；书架、标题与模式留在顶栏，其余收进「⋯」。
    $('#btn-back-home').onclick = A.showStart;
    $('#btn-hud-shelf').onclick = A.showShelf;
    $('#btn-hud-new').onclick = () => { closeMenus(); A.newStoryFromGame(); };
    $('#btn-settings').onclick = () => { closeMenus(); A.openSettings(); };
    $('#btn-savepoint').onclick = async () => {
      closeMenus();
      if (!S.story) return;
      const name = await irConfirm('给这个存档点起个名字', {
        title: '存档点', input: true, okText: '保存',
        value: '第 ' + (S.story.turn || 0) + ' 回合 · ' + new Date().toLocaleTimeString('zh-CN'),
      });
      if (name == null) return;
      A.addSavepoint(String(name).trim() || undefined);
      toast('已打存档点');
    };
    const manualGenerate = () => {
      closeMenus();
      if (!S.story) { toast('先打开一个故事吧'); return; }
      if (S.busy) { toast('回复生成中，这一幕写完再作画'); return; }   // §3.C：回复生成中不入队
      if (offlineBlocked('这次作画')) return;   // 离线：不排进队列，也不花额度
      const key = 'manual:' + treeHeadNodeId();   // §3.C：同一幕不重复入队
      if (paintQ.has(key)) { toast('这一幕已在作画队列里'); return; }
      // 场景描述读当前 head 的 lastSceneSummary（投影后即 story.lastSceneSummary）
      enqueueImage(S.story.lastSceneSummary, treeHeadNodeId(), key);
      toast('已加入作画队列');
    };
    $('#btn-manual-gen').onclick = manualGenerate;
    $('#btn-stage-gen').onclick = e => { if (e) e.stopPropagation(); manualGenerate(); };
    $('#btn-toggle-image').onclick = toggleStagePanel;
    $('#btn-stage-painter').onclick = e => { if (e) e.stopPropagation(); openWorkbench(null); };
    $('#btn-immersive').onclick = e => {
      if (e) e.stopPropagation();
      if (!S.story) return;
      if (isImmersive()) exitImmersive(); else enterImmersive();
    };
    $('#btn-immersive-exit').onclick = e => { if (e) e.stopPropagation(); exitImmersive(); };

    // 顶栏「⋯」/ 输入区「＋」：打开前先刷新菜单项状态
    $('#btn-hud-more').onclick = e => { e.stopPropagation(); A.toggleMenu($('#btn-hud-more'), $('#hud-more-menu')); };
    $('#btn-more-actions').onclick = e => { e.stopPropagation(); A.toggleMenu($('#btn-more-actions'), $('#feature-menu')); };
    document.addEventListener('click', e => {
      if (e.target.closest && e.target.closest('.menu-item')) { closeMenus(); return; }
      if (e.target.closest && e.target.closest('.menu, .hud-more, .menu-wrap')) return;
      A.closeMenus();
    });

    // 舞台点击：沉浸态显示 / 隐藏文字；堆叠态收起 / 展开成细条
    $('#stage-wrap').addEventListener('click', e => {
      if (e.target.closest && e.target.closest('button')) return;
      const layout = effectiveLayout();
      if (layout === 'immersive') {
        S.immersiveTextHidden = !S.immersiveTextHidden;
        $('#screen-game').classList.toggle('text-hidden', S.immersiveTextHidden);
      } else if (layout === 'stack') {
        $('#screen-game').classList.toggle('stage-strip');
      }
    });

    // —— 输入 ——
    const doSend = (opts) => {
      // P0-1：busy 期间只有点「停止」按钮才中断；Enter / 输入不触发（玩家可能只是提前打字）
      if (S.busy) { if (opts && opts.allowStop) requestChatStop(); return; }
      const v = $('#player-input').value.trim();
      if (!v) return;
      $('#player-input').value = '';
      sendPlayerAction(v, false);
    };
    $('#btn-send').onclick = () => doSend({ allowStop: true });
    $('#player-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSend(); });

    // 做 / 说 / 导演：状态按故事记住
    document.querySelectorAll('#kind-switch .seg-btn').forEach(b => {
      b.onclick = () => {
        if (!S.story) return;
        const k = b.dataset.kind;
        S.story.ui.kind = (k === 'say' || k === 'direct') ? k : 'do';
        syncKindSwitch();
        saveAll();
        $('#player-input').focus();
      };
    });

    // 💡 灵感：展开 / 收起这一轮的选项
    $('#btn-inspiration').onclick = () => {
      if (!S.currentChoices.length || S.busy || S.live) return;
      S.choicesTrayOpen = !S.choicesTrayOpen;
      renderChat();
      if (S.choicesTrayOpen) {
        const tray = $('#choice-tray');
        if (tray) tray.scrollLeft = 0;
      }
    };

    // 虚拟键盘：visualViewport 变矮（弹出键盘）时，堆叠态自动把图收成细条
    const vv = window.visualViewport;
    const onViewportChange = () => {
      const game = $('#screen-game');
      if (!game) return;
      const shrunk = !!vv && vv.height < Math.max(300, window.innerHeight * 0.72);
      game.classList.toggle('kb-open', shrunk);
    };
    if (vv) {
      vv.addEventListener('resize', onViewportChange);
      vv.addEventListener('scroll', onViewportChange);
    }
    $('#player-input').addEventListener('focus', () => setTimeout(onViewportChange, 260));
    $('#player-input').addEventListener('blur', () => setTimeout(onViewportChange, 260));

    bindSplitter();

    // —— 向导 ——
    $('#btn-close-wizard').onclick = () => $('#modal-wizard').classList.add('hidden');
    $('#btn-wz-cancel').onclick = () => $('#modal-wizard').classList.add('hidden');
    $('#btn-wz-draft').onclick = A.draftWizard;
    $('#btn-wz-start').onclick = A.startFromWizard;

    // —— 导出 / 设置 ——
    $('#btn-close-export').onclick = () => $('#modal-export').classList.add('hidden');
    $('#btn-do-export').onclick = A.doExport;
    // —— 画师工作台（T-P3-1） ——
    $('#btn-close-painter').onclick = closeWorkbench;
    $('#btn-pw-close').onclick = closeWorkbench;
    $('#modal-painter').addEventListener('click', e => {
      if (e.target === $('#modal-painter')) closeWorkbench();
    });
    $('#btn-pw-redraw').onclick = redrawFromWorkbench;
    $('#btn-pw-force').onclick = forceRedrawByCard;
    $('#btn-pw-send').onclick = painterThreadSend;
    $('#pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') painterThreadSend(); });
    $('#btn-pw-reset').onclick = () => {
      if (!S.pw) return;
      const sc = imageSceneById(S.pw.sceneId);
      const raw = (sc && sc.promptRaw) || S.pw.promptRaw || '';
      if (!raw) { toast('没有存下画师原稿'); return; }
      S.pw.prompt = composePrompt(raw, styleSuffixText());
      $('#pw-prompt').value = S.pw.prompt;
      toast('已回到画师原稿');
    };
    $('#pw-aspect').onchange = pwShowWh;
    $('#pw-width').oninput = pwShowWh;
    $('#pw-height').oninput = pwShowWh;

    // —— 画风锚定（T-P4-1） ——
    $('#btn-close-anchor').onclick = closeAnchor;
    $('#btn-anchor-more').onclick = runAnchorBatch;
    $('#btn-anchor-skip').onclick = closeAnchor;
    $('#btn-anchor-use').onclick = anchorDraftCard;
    $('#btn-anchor-back').onclick = () => {
      if (!S.anchor || S.anchor.busy) return;
      $('#anchor-step-card').classList.add('hidden');
      $('#anchor-step-pick').classList.remove('hidden');
      $('#btn-anchor-use').disabled = S.anchor.pickedIdx < 0;
    };
    $('#btn-anchor-lock').onclick = anchorLock;
    $('#btn-anchor-chat').onclick = anchorCardChat;
    $('#ac-chat').addEventListener('keydown', e => { if (e.key === 'Enter') anchorCardChat(); });
    $('#btn-anchor-rerun').onclick = () => { closeModal('modal-settings'); openAnchor({}); };
    $('#btn-pw-anchor').onclick = () => { closeWorkbench(); openAnchor({}); };

    $('#btn-close-settings').onclick = () => closeModal('modal-settings');
    $('#modal-settings').addEventListener('click', e => {
      if (e.target === $('#modal-settings')) closeModal('modal-settings');
    });
    $('#btn-add-savepoint').onclick = () => {
      if (!S.story) return;
      A.addSavepoint();
      toast('已打存档点');
    };
    $('#btn-clear-notools').onclick = () => {
      S.settings.noTools = [];
      saveAll();
      renderNoToolsHint();
      toast('已清空「不接受工具」的模型记录，下次会重新尝试下发工具');
    };
    $('#s-image-aspect').onchange = applyAspectToFields;
    $('#s-story-mode').onchange = onModeChange;
    $('#btn-save-world').onclick = saveWorldFromForm;
    $('#btn-inject-memory').onclick = toggleInjectMemory;

    // —— 角色卡（R13 / T-P7-1） ——
    $('#btn-edit-card').onclick = () => { if (!S.story) { toast('先打开一个故事'); return; } A.openCardEditor({ mode: 'edit' }); };
    $('#btn-close-card').onclick = () => A.closeCardEditor(true);
    $('#btn-rc-cancel').onclick = () => A.closeCardEditor(true);
    $('#btn-rc-save').onclick = A.saveCardFromEditor;
    $('#btn-rc-import').onclick = () => $('#file-card').click();
    $('#file-card').onchange = e => {
      importCardFile(e.target.files && e.target.files[0]);
      e.target.value = '';
    };
    $('#modal-card').addEventListener('click', e => {
      if (e.target === $('#modal-card')) A.closeCardEditor(true);
    });

    // —— 用户画像（R13 / T-P7-2） ——
    $('#btn-profile-all').onclick = () => {
      ['#s-profile-choice', '#s-profile-chat', '#s-profile-rp'].forEach(s => { $(s).checked = true; });
    };
    $('#btn-profile-none').onclick = () => {
      ['#s-profile-choice', '#s-profile-chat', '#s-profile-rp'].forEach(s => { $(s).checked = false; });
    };
    $('#btn-profile-clear').onclick = clearProfile;
    // —— 测试连接（只探测，不保存、不出图） ——
    Object.keys(TEST_TARGETS).forEach(key => {
      const btn = $('#btn-test-' + key);
      if (btn) btn.onclick = () => testConnection(key, btn);
    });
    $('#btn-save-settings').onclick = () => {
      applyFormToSettings();
      closeModal('modal-settings');
      toast('设置已保存');
      if (A.sidecarReady()) saveFeatureConfig();    // 安全项真源在侧车：单独同步一次
    };

    // —— 可选本地服务：探测 / 功能入口 / 安排与台账 ——
    const probeBtn = $('#btn-sidecar-probe');
    if (probeBtn) probeBtn.onclick = () => {
      const S = IR.Sidecar;
      if (!SC) return;
      S.settings.sidecar = {
        port: Number(($('#s-sidecar-port') || {}).value) || 4319,
        token: (($('#s-sidecar-token') || {}).value || '').trim(),
      };
      persistSettings();
      SC.configure(S.settings.sidecar);
      SC.probe().then(ok => {
        renderSidecarStatus();
        if (ok) { toast('本地服务在线'); loadFeatureConfig(); }
        else toast('还是连不上：确认已经运行 node sidecar/server.mjs，且端口、token 与配置一致', true, true);
      });
    };
    const triggerBtn = $('#btn-trigger-refresh');
    if (triggerBtn) triggerBtn.onclick = () => renderTriggerList();
    const payBtn = $('#btn-pay-refresh');
    if (payBtn) payBtn.onclick = () => renderPayLedger();

    const featEmail = $('#btn-feat-email');
    if (featEmail) featEmail.onclick = openEmailModal;
    const featPay = $('#btn-feat-payment');
    if (featPay) featPay.onclick = openPaymentModal;
    const featSched = $('#btn-feat-schedule');
    if (featSched) featSched.onclick = () => {
      if (!A.featuresAllowed()) { toast('剧情模式里没有定时主动：切到智能体 / 扮演模式再用', true); return; }
      openModal('modal-settings');
      if (A.sidecarReady()) loadFeatureConfig();
      const fs = $('#fs-schedule');
      if (fs && fs.scrollIntoView) fs.scrollIntoView({ block: 'start' });
    };
    const closeEmail = $('#btn-close-email');
    if (closeEmail) closeEmail.onclick = () => closeModal('modal-email');
    const closePay = $('#btn-close-payment');
    if (closePay) closePay.onclick = () => closeModal('modal-payment');
    const emSend = $('#btn-em-send');
    if (emSend) emSend.onclick = doEmailSend;
    const pmSubmit = $('#btn-pm-submit');
    if (pmSubmit) pmSubmit.onclick = doPaymentSubmit;
    $('#btn-backup-all').onclick = () => {
      doBackupAll().catch(e => toast('导出备份失败：' + ((e && e.message) || e), true, true));
    };
    // 清理孤儿原图：只删「没有任何故事引用」的 Blob，剧情 / 缩略图 / 提示词都不动
    $('#btn-clean-images').onclick = async () => {
      const keys = await Store.listImageKeys();
      const keep = Store.knownImageIds();
      const orphans = keys.filter(k => !keep.has(k));
      if (!orphans.length) { toast('没有可清理的原图（现存 ' + keys.length + ' 张，都有故事引用）'); return; }
      if (!await irConfirm('清理 ' + orphans.length + ' 张没有故事引用的原图？剧情、缩略图、提示词都不受影响。', { title: '清理孤儿原图', okText: '清理' })) return;
      orphans.forEach(k => Store.releaseImage(k));
      await Store.flush();
      A.renderStoragePanel();
      toast('已清理 ' + orphans.length + ' 张孤儿原图', false, true);
    };
    $('#btn-clear-save').onclick = async () => {
      if (!await irConfirm('清空本地存档与全部设置？此操作不可恢复。', { title: '危险操作', okText: '清空' })) return;
      Store.clearAll();
      S.settings = Store.defaultSettings();
      S.story = null;
      syncSettingsToForm();
      A.showStart();
      toast('已清空');
    };
    // 模型名变化 → 按能力重排参数字段（T-M-1）
    $('#s-chat-model').addEventListener('change', () => {
      const cap = Cap.find('chat', $('#s-chat-model').value.trim());
      S.settings.chat.model = $('#s-chat-model').value.trim();
      if (cap && +cap.contextWindow > 0) S.settings.chat.contextWindow = 0; // 交回登记表自动值
      if (!cap || !cap.thinking || cap.thinking.kind === 'none') S.settings.chat.thinking = 'default';
      A.renderCapabilityFields();
    });
    $('#s-image-model').addEventListener('change', () => {
      S.settings.image.model = $('#s-image-model').value.trim();
      A.renderCapabilityFields();
    });
    // 选了「自定义尺寸…」就亮出宽高输入（预填档位模式下隐藏）
    $('#s-image-size').addEventListener('change', () => {
      S.settings.image.size = $('#s-image-size').value;
      A.showImageWh(S.settings.image.size === '__custom__');
    });
    // 自建确认弹窗（irConfirm）：确定 / 取消 / 关闭 / 回车
    $('#cf-ok').onclick = () => closeConfirm(confirmValue());
    $('#cf-cancel').onclick = () => closeConfirm(null);
    $('#btn-close-confirm').onclick = () => closeConfirm(null);
    $('#modal-confirm').addEventListener('click', e => { if (e.target === $('#modal-confirm')) closeConfirm(null); });
    $('#cf-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); closeConfirm(confirmValue()); }
    });

    // 图片灯箱：点遮罩 / 点图都关（Esc 见下面的全局按键）
    const lightbox = $('#lightbox');
    if (lightbox) lightbox.onclick = () => closeLightbox();

    // Esc：只关最上层弹窗（确认弹窗要走 closeConfirm 才能收掉 Promise）；
    // 没有弹窗时才退出沉浸态（P2）。
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (closeLightbox()) return;   // 灯箱最先关（点遮罩也能关）
      if (closeTopModal()) return;
      const openMenu = document.querySelector('.menu:not(.hidden)');
      if (openMenu) { closeMenus(); return; }
      exitImmersive();
    });

    // 点弹窗遮罩关闭：只处理最上层，避免误关底下那层
    MODAL_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el || id === 'modal-confirm') return;
      el.addEventListener('click', ev => {
        if (ev.target !== el) return;
        if (modalStack[modalStack.length - 1] !== id) return;
        // 功能类弹窗（尤其设置 / 邮件 / 支付）里填了一半的内容，误点遮罩不该丢
        if (id === 'modal-settings' || id === 'modal-email' || id === 'modal-payment' || id === 'modal-wizard') return;
        dismissModal(id);
      });
    });

    // 提示条关闭按钮（只有错误提示才显示）
    const toastClose = $('#toast-close');
    if (toastClose) toastClose.onclick = hideToast;

    // 断网 / 恢复：只是提示，绝不排队、不补发（离线是「这次点了不算」）
    window.addEventListener('offline', () => toast('已断网：聊天与作画暂时用不了，已存的故事照常能看。联网后重新点一次即可（离线期间不会排队、不会事后偷偷扣额度）。', true, true));
    window.addEventListener('online', () => toast('网络回来了：可以继续聊、继续作画。', false, true));

    // 退出即自动存档；页面不可见时暂停循环动画（html[data-paused]）
    window.addEventListener('beforeunload', () => { if (S.story) saveAll(); });
    document.addEventListener('visibilitychange', () => {
      applyPaused();
      if (document.hidden && S.story) saveAll();
    });
  }

  /* ================= 启动 ================= */

  function init() {
    // 后台落盘失败（最常见：本地空间满）不再静默：10 秒节流提示一次导出备份
    Store.setPersistErrorHandler(() => {
      if (Date.now() - S.lastSaveWarnAt < 10000) return;
      S.lastSaveWarnAt = Date.now();
      toast('存档写入失败（本地空间可能已满）：请「一键导出全部备份」，或删掉不用的故事 / 原图腾出空间', true, true);
    });
    // 原图是 Blob、异步取的：取到后把画面与缩略图重画一遍
    Store.setImageReadyHandler(() => { renderStage(); renderThumbs(); });

    Store.migrateLegacy();            // v0.1 旧档 → v0.2（幂等）
    S.settings = Store.loadSettings();  // 迁移后重新读取
    if (DEMO) S.settings = IR.Demo.applyTo(S.settings);   // 只改内存：演示适配器生效，配置不落盘
    // 动效强度（UI-1）：启动写 data-motion；系统「减少动态效果」变化时跟随（显式选择优先）
    applyMotion();
    if (motionMQ) {
      if (motionMQ.addEventListener) motionMQ.addEventListener('change', applyMotion);
      else if (motionMQ.addListener) motionMQ.addListener(applyMotion);
    }
    watchStageVisibility();           // Ken Burns 离屏暂停
    bind();
    syncSettingsToForm();
    A.initFeatures();                   // 主动消息编排：去重 + 排队（投递走 sendPlayerAction）
    if (DEMO) {
      // 演示模式保持零外联：把本地服务换成一整套内存 mock，界面链路照样跑通
      if (IR.Demo && IR.Demo.installSidecarMock) IR.Demo.installSidecarMock();
    }
    A.initSidecar();                    // 探测本地服务；离线则三功能保持禁用
    if (DEMO) A.startDemo();            // 演示模式直接开演（跳过开始页与试画锚定）
    else A.showStart();                 // 入口 = 开始页（v0.1 原样）
    A.renderShelf();
    A.initStorageGuard().then(A.renderStoragePanel);   // P0：申请持久化 + 刷新存储面板
    A.remindBackupIfNeeded();                        // P0：7 天没备份就提醒一次
  }

  // 先进 boot（装载 IndexedDB / 把 localStorage 旧数据迁过来），再进界面。
  // boot 失败会自己退回 localStorage 模式：功能一样，只是容量仍是约 5MB —— 数据不会丢。
  (async () => {
    let info = null;
    try { info = await Store.boot(); } catch (e) { console.warn('存储初始化失败：', e); }
    init();
    if (info && info.error) {
      toast('本地存储升级未完成（IndexedDB 用不了），已退回原来的存储方式：数据没丢，但容量仍是约 5MB。', true, true);
    } else if (info && info.backend === 'indexeddb' && info.migrated && !info.migrated.skipped && info.migrated.stories) {
      toast('已把 ' + info.migrated.stories + ' 个故事迁移到 IndexedDB：容量不再受 5MB 限制。旧数据仍原样保留在本机，可随时回退。', false, true);
    }
  })();
  A.reg({ loadFeatureConfig, renderTriggerList, sendPlayerAction, runOpening, choicesFromHead, closeWorkbench, openAnchor, closeAnchor, scrollChatBottom, renderChat, renderStage, renderThumbs, enterGame, syncSettingsToForm, renderStoryPanels, renderProfilePanel });
})();
