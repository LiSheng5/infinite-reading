/*
 * js/app/round.js —— 回合编排：callAI1 / 玩家行动 / 开场 / 工具执行 / 旁白收尾
 * 从 js/app.js 拆出（只搬家，不改行为）。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, KIND_LABELS, isStopError, setSendButtonsBusy, toast, netErrHint, offlineBlocked, saveAll } = A;

  async function handleToolCalls(calls) {
    const feedback = [];
    const recallScopes = [];
    for (const c of calls) {
      A.applyToolCall({ function: { name: c.name, arguments: c.raw && c.raw.function ? c.raw.function.arguments : undefined } });
      if (IR.Context.isRecallTool(c.name)) {
        recallScopes.push(IR.Context.RECALL_TOOL_SCOPE[c.name]);
      } else if (c.name === 'request_image') {
        // §3.A：不再 await——任务进作画队列立刻返回，图在后台出、完成后落回本回合
        S.turnPaintedByTool = true;   // §3.A.3：提交即置位（原来是出图完成后）
        A.submitToolPaint(c.args);
        feedback.push('[已排队生图]\n画面：' + A.imageBrief(c.args)
          + '\n（图会稍后自动出现在聊天里。正文里可以自然提一句，但不要声称图已经画好，也不要说「工具」「系统」。）');
      } else if (c.name === 'update_memory') {
        feedback.push('[记忆已更新]\n' + ((c.args && c.args.text) || '世界卡 / 关系已写入'));
      } else if (IR.Context.isScheduleTool(c.name)) {
        feedback.push(await A.runScheduleTool(c.name, c.args));
      } else if (IR.Context.isProposalTool(c.name)) {
        // 提案制（红线 1）：只产生提案卡，绝不执行发送 / 扣款；执行要等用户在界面上点「确认」
        feedback.push(A.runProposalTool(c.name, c.args));
      }
    }
    A.renderChat();
    return { recallScopes: recallScopes.filter((s, i) => recallScopes.indexOf(s) === i), feedback: feedback };
  }

  // email_propose / payment_propose → 建提案（红线 1/2/3）：
  // 提案路径只走 IR.Proposals.create（不碰任何 send / purchase / approve），失败给模型可读原因让它圆场，
  // 成功 pushLog({type:'proposal'})（回合内、commit 之前，由 logMark 切片收进节点），并回一条「待确认」提示。

  // 调 AI1；带工具时：工具调用 → 留痕 + 副作用 + 单次重发（§4.5）
  async function callAI1(playerAction, opts) {
    opts = opts || {};
    // UI-3 §3.3：主模型配置一律走 resolveChatCfg（本对话 profile → 模型库；缺省 = 默认主模型）
    const resolved = IR.Prefs.resolveChatCfg(S.settings, S.story);
    const cfg = resolved.cfg;
    S.turnModel = cfg.model || '';   // 回合提交时记入 node meta.model（只记模型名，不含密钥 / URL）
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
      A.renderInjectHint();
      pushLog({ type: 'system', text: '已注入完整记忆（世界卡 + 设定 + 视觉设定卡）：本轮先复述处境再继续' });
    }
    S.live = { text: '', reasoning: '' };
    S.liveReasonEl = null;
    S.liveReasonCollapsed = false;
    S.liveReasonOpen = false;
    A.renderChat();
    S.liveEl = $('#chat-scroll').querySelector('.bubble-live');

    // UI-3 §3.3：工具集 = 全局可用性（toolsEnabled / noTools / 侧车 feature）∩ prefs.tools（本对话可单独关）
    const prefsTools = IR.Prefs.effective(S.settings, S.story, 'tools');
    const toolAllowed = (t) => prefsTools[IR.Prefs.toolCategory(t.function.name)] !== false;
    const toolsOn = opts.tools !== false && !opts.recall
      && S.settings.toolsEnabled !== 'off' && !A.noToolsFor(cfg);
    // 调度工具只在「对话 / 扮演」+ 本地服务在线 + 后端已开启调度时追加；剧情模式工具集不变
    const schedTools = toolsOn && prefsTools.schedule !== false && A.scheduleToolsAvailable();
    // 邮件 / 下单（提案制）只在智能体（chat）+ 对应 feature 开启时追加（红线 7；toolsForMode 内部再挡一次模式）
    const propTools = toolsOn ? A.proposalToolsAvailable() : { email: false, payment: false };
    const toolOpts = {
      schedule: schedTools,
      email: propTools.email && prefsTools.email !== false,
      payment: propTools.payment && prefsTools.payment !== false,
    };
    const asmOpts = Object.assign({}, opts);
    if (toolsOn) {
      asmOpts.tools = IR.Context.toolsForMode(S.story.mode, toolOpts).filter(toolAllowed).map(t => t.function.name);
    }
    if (forceInject) asmOpts.forceInject = true;
    asmOpts.profile = A.activeProfileEntries();   // R13：画像按开关 / 范围注入（关则空数组，零成本）
    asmOpts.contextWindow = A.chatContextWindow();   // P1-3：组装窗口按 token 动态装（context.js fitWindow）
    // P1-5（2026-10-14）：组装前先查预算，超了就地用本地摘要先压再组——此前是「先组后压」
    //（postTurn 收尾才压），越过 70% 阈值的那一回合会超发一轮（严格的服务端直接拒）。
    // 本地摘要确定性、不花 API；后续 postTurn 的书记员照常处理新批次。
    try {
      const cw = asmOpts.contextWindow;
      if (cw > 0 && IR.Context.estimateContextTokens(S.story, playerAction, asmOpts) > IR.Context.compressThreshold(cw)) {
        IR.Context.compressStory(S.story, { summarize: IR.Context.localSummarize, contextWindow: cw });
      }
    } catch (_) { /* 压缩失败不拦回合：最坏按原样发 */ }
    const messages = IR.Context.assembleAI1(S.story, playerAction, asmOpts);
    const cfgTools = toolsOn
      ? Object.assign({}, cfg, { tools: IR.Context.toolsForMode(S.story.mode, toolOpts).filter(toolAllowed) })
      : cfg;

    let streamedCalls = [];
    let reasoning = '';
    const first = await A.streamAI1(adapter, cfgTools, messages, {
      onToolCalls(calls) { streamedCalls = streamedCalls.concat(A.toolList(calls)); },
      onReasoning(piece) { reasoning += piece; if (S.live) S.live.reasoning = reasoning; A.updateLiveReasoning(); },
    });
    const reply1 = A.parseAIReply(first.text);
    // 两路都算：流式 tool_calls 与回包里的 tool_calls
    let calls = streamedCalls.concat(A.toolList(reply1.tool_calls));
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
      const second = await A.streamAI1(adapter, cfg,
        IR.Context.assembleAI1(S.story, playerAction, secondOpts),
        { onReasoning(piece) { reasoning += piece; if (S.live) S.live.reasoning = reasoning; A.updateLiveReasoning(); } });
      const reply2 = A.parseAIReply(second.text);
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
    A.renderChat();

    try {
      const res = await callAI1(sentAction);
      const reply = res.reply;
      S.story.turn += 1;
      S.story.lastSceneSummary = reply.scene_summary || S.story.lastSceneSummary;
      const userMsg = { role: 'user', content: IR.Context.playerContent(S.story.premise, sentAction) };
      const asst = A.assistantMessage(reply, res.reasoning);
      S.story.messages.push(userMsg, asst);
      A.pushNarrationEntry(reply.narration, res.reasoning);
      await finishNarration(res.streamed);
      A.absorbReply(reply);
      S.currentChoices = reply.choices;
      A.renderChat();
      // §4.1 回合落节点：entries = log.slice(logMark)，head 前移；失败 / 停止不建节点
      // UI-3 §3.3：meta.model 记下本回合实际用的模型名（不含任何密钥 / URL），分支页可显示
      const node = IR.Tree.commit(S.story, {
        action: {
          type: agentMsg ? 'agent' : (isChoice ? 'choice' : 'player'),
          text: action, kind: kind || null, sent: sentAction,
        },
        userMsg: userMsg, assistantMsg: asst, logMark: mark.logMark,
        meta: { model: S.turnModel || '' },
      });
      S.turnAnchor.nodeId = node.id;                // §3.A.4：锚点补 nodeId，后台出图任务写回时落位
      A.maybeEnqueueImage(reply, false, node.id);   // nodeId 随任务走（§4.4）
      await A.postTurn();
      IR.Tree.seal(S.story, node.id);               // 必须在 postTurn 之后（§10）：收进压缩 / 书记员的 tool 条目
      A.maybeAutoTitle();                          // UI-2 §3.3：seal 后异步起标题，不占 busy、不阻塞下一次发送
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
      A.renderChat();
    } finally {
      S.busy = false;
      S.stopRequested = false; S.chatAbortCtrl = null;
      S.live = null; S.liveEl = null;
      setSendButtonsBusy(false);
      A.renderChat();
      if (IR.Features) IR.Features.drain();   // 忙完了，看看排队的主动消息能不能送
    }
  }

  // 旁白已进 log：流式就直接落定；非流式用打字机补观感
  async function finishNarration(streamed) {
    if (streamed) {
      // UI-1 §4.2：流结束把逐段淡入的 span 整体合并成单个文本节点
      A.finishLiveDelta(S.liveEl || $('#chat-scroll').querySelector('.bubble-live'));
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
      const asst = A.assistantMessage(reply, res.reasoning);
      S.story.messages.push(userMsg, asst);
      A.pushNarrationEntry(reply.narration, res.reasoning);
      await finishNarration(res.streamed);
      A.absorbReply(reply);
      S.currentChoices = reply.choices;
      A.renderChat();
      // 开局同样是节点（§4.1）：action.type = 'opening'，sent = OPENING_ACTION
      const node = IR.Tree.commit(S.story, {
        action: { type: 'opening', text: OPENING_ACTION, kind: null, sent: OPENING_ACTION },
        userMsg: userMsg, assistantMsg: asst, logMark: mark.logMark,
        meta: { model: S.turnModel || '' },   // UI-3 §3.3
      });
      S.turnAnchor.nodeId = node.id;                 // §3.A.4：锚点补 nodeId
      await A.postTurn();
      IR.Tree.seal(S.story, node.id);                // 必须在 postTurn 之后（§10）
      A.maybeAutoTitle();                           // UI-2 §3.3：开局回合同样触发自动标题
      if (S.turnPaintedByTool) S.turnPaintedByTool = false;                        // 开局这一轮工具已出图 → 不再时机出图
      else if (S.story.mode === 'chat' || S.story.mode === 'rp') { /* §3.E.3：对话 / 扮演没有时机出图 */ }
      else if (IR.Prefs.effective(S.settings, S.story, 'trigger') !== 'manual') A.enqueueImage(reply.scene_summary, node.id);
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
      A.renderChat();
    } finally {
      S.busy = false;
      S.stopRequested = false; S.chatAbortCtrl = null;
      S.live = null; S.liveEl = null;
      setSendButtonsBusy(false);
      A.renderChat();
    }
  }

  function pushLog(entry) {
    if (!S.story) return;
    entry.ts = Date.now();
    S.story.log.push(entry);
  }

  A.reg({ callAI1, withKindMarker, syncKindSwitch, sendPlayerAction, finishNarration, runOpening, pushLog });
})();
