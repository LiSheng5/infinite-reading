/*
 * src/app/round.js —— 回合编排：callAI1 / 玩家行动 / 开场 / 工具执行 / 旁白收尾
 */
import { Context } from '../core/context.ts';
import { Proposals } from '../core/proposals.ts';
import { Prefs } from '../core/prefs.ts';
import { ChatProviders } from '../core/providers.ts';
import { Tree } from '../core/tree.ts';
import { Features } from '../core/features.ts';
import { WriteBack } from '../core/writeBack.ts';
import { A, renderChat, saveAll, toast } from './core.js';


  const S = A.state;
  const { $, KIND_LABELS, isStopError, setSendButtonsBusy, netErrHint, offlineBlocked, reportUserFailure, reportBackgroundFailure } = A;

  async function handleToolCalls(calls) {
    const feedback = [];
    const recallScopes = [];
    let toolUnavailable = false;
    // chat / rp 的 request_image 是直出变体；剧情模式没有作画工具
    const directPaint = !!(S.story && (S.story.mode === 'chat' || S.story.mode === 'rp'));
    for (const c of calls) {
      const rawCall = { function: { name: c.name, arguments: c.raw && c.raw.function ? c.raw.function.arguments : undefined } };
      if (c.name === 'request_image' && !directPaint) {
        // 剧情模式不下发 request_image；模型照旧历史调了（或不听话）按「该工具不可用」回传——
        // 不入队、不报错、不弹 toast，也不留「排队生图」的假留痕
        toolUnavailable = true;
        feedback.push('[该工具不可用] request_image 在剧情模式已停用：画面由用户点「作画」生成。当作没调用过这次调用，正文里不要说已经画好或正在画。');
        continue;
      }
      A.applyToolCall(rawCall);
      if (Context.isRecallTool(c.name)) {
        recallScopes.push(Context.RECALL_TOOL_SCOPE[c.name]);
      } else if (c.name === 'request_image') {
        // 不再 await——任务进作画队列立刻返回，图在后台出、完成后落回本回合
        A.submitToolPaint(c.args);
        feedback.push('[已排队生图]\n画面：' + A.imageBrief(c.args)
          + '\n（图会稍后自动出现在聊天里。正文里可以自然提一句，但不要声称图已经画好，也不要说「工具」「系统」。）');
      } else if (c.name === 'update_memory') {
        feedback.push('[记忆已更新]\n' + ((c.args && c.args.text) || '世界卡 / 关系已写入'));
      } else if (Context.isScheduleTool(c.name)) {
        feedback.push(await A.runScheduleTool(c.name, c.args));
      } else if (Context.isProposalTool(c.name)) {
        // 提案制（红线 1）：只产生提案卡，绝不执行发送 / 扣款；执行要等用户在界面上点「确认」
        feedback.push(A.runProposalTool(c.name, c.args));
      }
    }
    renderChat();
    return {
      recallScopes: recallScopes.filter((s, i) => recallScopes.indexOf(s) === i),
      feedback: feedback,
      toolUnavailable: toolUnavailable,
    };
  }

  // email_propose / payment_propose → 建提案（红线 1/2/3）：
  // 提案路径只走 Proposals.create（不碰任何 send / purchase / approve），失败给模型可读原因让它圆场，
  // 成功 pushLog({type:'proposal'})（回合内、commit 之前，由 logMark 切片收进节点），并回一条「待确认」提示。

  /* 工具注入判定的唯一口径：「本回合正常发一轮」会注入哪些工具、各类目为什么没注入。
   * buildAI1Request 的工具组装与智能体空对话引导（readmodel 的 agentChips）共用这一个函数：
   * 「chip 已启用」≡「对应工具这回合会被注入」，判定不写第二套、不会漂移。
   * 返回 { on, tools, why }：
   *   on    —— 全局工具门（toolsEnabled 关 / 模型不支持 tools 时 false）；
   *   tools —— 会注入的工具对象（已过 toolsForMode 的模式门控、prefs 本对话开关与各类目可用性）；
   *   why   —— 各类目（image / memory / schedule / email / payment）未启用的一句话原因（chips 的「未启用」提示）。 */

  // 生图的执行前提：按渠道看「能不能真的出一张图」（OpenAI 兼容要模型名、MiniMax 另要 Key、
  // ComfyUI 要 workflow，模型名在 workflow 里选）。缺配置时 request_image 不注入、
  // 画图 chip 显示「未启用 ›」——与工具注入同一套判定，不出「界面说能画、画时才失败」的岔子。
  function imageModelReady() {
    const im = S.settings.image || {};
    const provider = String(im.provider || 'openai-images');
    if (!String(im.baseUrl || '').trim()) return false;
    if (provider === 'comfyui') return !!String(im.workflow || '').trim();
    if (provider === 'minimax-image') {
      return !!String(im.model || '').trim() && !!String(im.apiKey || '').trim();
    }
    return !!String(im.model || '').trim();
  }

  function toolInjection() {
    const prefsTools = Prefs.effective(S.settings, S.story, 'tools');
    const resolved = Prefs.resolveChatCfg(S.settings, S.story);
    const on = S.settings.toolsEnabled !== 'off' && !A.noToolsFor(resolved.cfg);
    if (!on) {
      const reason = S.settings.toolsEnabled === 'off' ? '「向模型下发工具」已关闭' : '当前模型不支持工具调用';
      const all = {};
      Prefs.TOOL_KEYS.forEach(k => { all[k] = reason; });
      return { on: false, tools: [], why: all };
    }
    const why = {};
    Prefs.TOOL_KEYS.forEach(k => {
      if (prefsTools[k] === false) { why[k] = '本对话里已关掉它'; return; }
      if (k === 'image' && !imageModelReady()) { why[k] = '还没配置生图模型'; return; }
      if (k === 'schedule' || k === 'email' || k === 'payment') {
        const w = A.sidecarFeatureWhy(k);
        if (w) why[k] = w;
      }
    });
    // 模式门控（chat / rp 的 request_image 直出变体、邮件 / 下单只放 chat 等）在 toolsForMode 里；
    // 类目可用性（why）在结果上再收一道——chip 的「启用」与注入清单始终一致
    const tools = Context.toolsForMode(S.story ? S.story.mode : 'choice', {
      schedule: !why.schedule,
      email: !why.email,
      payment: !why.payment,
    }).filter(t => !why[Prefs.toolCategory(t.function.name)]);
    return { on: true, tools: tools, why: why };
  }

  // 调 AI1；带工具时：工具调用 → 留痕 + 副作用 + 单次重发
  // 拆两段：
  //   buildAI1Request —— 组装 tools / messages（含偏好解析、工具可用性、预算压缩）
  //   invokeAI1       —— 调用 + 工具执行 + 单次重发 + 回包兜底
  function buildAI1Request(playerAction, opts) {
    opts = opts || {};
    // 主模型配置一律走 resolveChatCfg（本对话 profile → 模型库；缺省 = 默认主模型）
    const resolved = Prefs.resolveChatCfg(S.settings, S.story);
    const cfg = resolved.cfg;
    S.turnModel = cfg.model || '';   // 回合提交时记入 node meta.model（只记模型名，不含密钥 / URL）
    S.turnUsage = null;              // 本回合 token 用量从零累加（首发 + 工具反馈重发；重试也是新的一回合）
    const adapter = ChatProviders[cfg.provider] || ChatProviders['openai-compatible'];

    S.turnAnchor = { nodeId: null, dead: false };   // 本回合锚点，工具出图任务提交时带上
    // 启发式注入：玩家输入命中世界卡 / 伏笔实体词 → 本轮自动带上对应条目（与工具召回并行）。
    // 只在「新回合」留痕（重试不重复记），条目本身由 assembleAI1 注入，用户可在留痕面板看到：静默忽略工具时也照带。
    const prevEntry = S.story.log[S.story.log.length - 1];
    if (prevEntry && (prevEntry.type === 'player' || prevEntry.type === 'choice')) {
      const hit = Context.matchEntityTerms(playerAction, S.story.world);
      if (hit.terms.length) pushLog({ type: 'tool', tool: 'heuristic', summary: '自动带上相关记忆：' + hit.terms.join('、') });
    }
    // 🧠 注入记忆（手动层）：一次性，本轮把完整记忆直接压进上下文（不用 tool_choice，定案）
    const forceInject = S.pendingInject;
    if (forceInject) {
      S.pendingInject = false;
      A.renderInjectHint();
      pushLog({ type: 'system', text: '已注入完整记忆（世界卡 + 设定 + 视觉设定卡）：本轮先复述处境再继续' });
    }

    // 工具集 = 全局可用性（toolsEnabled / noTools / 侧车 feature）∩ prefs.tools（本对话可单独关）。
    // 判定只有一份：toolInjection()（智能体空对话引导的 chips 也读它），这里只再叠本次调用的
    // 关断（opts.tools===false / recall 二跳不带工具）。
    const inj = toolInjection();
    const toolsOn = opts.tools !== false && !opts.recall && inj.on;
    const asmOpts = Object.assign({}, opts);
    if (toolsOn) {
      asmOpts.tools = inj.tools.map(t => t.function.name);
    }
    if (forceInject) asmOpts.forceInject = true;
    asmOpts.profile = A.activeProfileEntries();   // 画像按开关 / 范围注入（关则空数组，零成本）
    asmOpts.contextWindow = A.chatContextWindow();   // 组装窗口按 token 动态装（context.ts 的 fitWindow）
    // 组装时先按本次结果估 token，超预算才压一次并重组（估算直接用本次组装结果，不再另组一份）
    //（postTurn 收尾才压），越过 70% 阈值的那一回合会超发一轮（严格的服务端直接拒）。
    // 本地摘要确定性、不花 API；后续 postTurn 的书记员照常处理新批次。
    // 估算直接用本次组装结果（estimateTokensOf），不再「估一次、组一次、压缩时再估一次」；
    // 超预算才压一次并重组——常态一回合只组装一次。
    let messages = Context.assembleAI1(S.story, playerAction, asmOpts);
    try {
      const cw = asmOpts.contextWindow;
      if (cw > 0) {
        const est = Context.estimateTokensOf(messages);
        if (est > Context.compressThreshold(cw)) {
          Context.compressStory(S.story, {
            summarize: Context.localSummarize, contextWindow: cw, estimatedTokens: est,
          });
          messages = Context.assembleAI1(S.story, playerAction, asmOpts);
        }
      }
    } catch (e) {
      // 纯后台降级：压缩失败不拦回合，最坏按原样发；console 留原因便于归因
      reportBackgroundFailure('回合压缩', e, { note: '按原样发送（最坏超一轮预算）' });
    }
    const cfgTools = toolsOn
      ? Object.assign({}, cfg, { tools: inj.tools })
      : cfg;
    return { adapter: adapter, cfg: cfg, cfgTools: cfgTools, messages: messages, asmOpts: asmOpts, toolsOn: toolsOn };
  }

  // 调用 + 重发：流式首调 → 工具执行 → 按需重发（不带工具）→ 回包兜底
  async function invokeAI1(playerAction, req) {
    const adapter = req.adapter, cfg = req.cfg, cfgTools = req.cfgTools;
    const messages = req.messages, asmOpts = req.asmOpts, toolsOn = req.toolsOn;

    S.live = { text: '', reasoning: '' };
    S.liveReasonEl = null;
    S.liveReasonCollapsed = false;
    S.liveReasonOpen = false;
    renderChat();
    S.liveEl = $('#chat-scroll').querySelector('.bubble-live');

    let streamedCalls = [];
    let reasoning = '';
    const first = await A.streamAI1(adapter, cfgTools, messages, {
      onToolCalls(calls) { streamedCalls = streamedCalls.concat(A.toolList(calls)); },
      onReasoning(piece) { reasoning += piece; if (S.live) S.live.reasoning = reasoning; A.updateLiveReasoning(); },
    });
    const reply1 = A.parseAIReply(first.text);
    // 两路都算：流式 tool_calls 与回包里的 tool_calls
    let calls = streamedCalls.concat(A.toolList(reply1.tool_calls));
    // 同名同参去重（流式与回包可能重复上报），再按每轮上限裁剪
    calls = calls.filter((c, i) => calls.findIndex(x => x.name === c.name && JSON.stringify(x.args) === JSON.stringify(c.args)) === i);
    // 超出上限的调用不再静默丢弃——留痕让玩家可见，重发时也告知模型
    const droppedCalls = calls.slice(Context.MAX_TOOL_CALLS_PER_TURN);
    if (droppedCalls.length) {
      pushLog({ type: 'tool', tool: 'limit', summary: '已达本轮工具上限，未执行：' + droppedCalls.map(c => c.name).join('、') });
    }
    calls = calls.slice(0, Context.MAX_TOOL_CALLS_PER_TURN);
    reply1.tool_calls = [];   // 已经处理过：避免 absorbReply 再记一次留痕

    const effect = calls.length ? await handleToolCalls(calls) : { recallScopes: [], feedback: [], toolUnavailable: false };

    /* 「写了正文 + 调了工具」不再是工具结果的死角。
     * 此前仅当 noProse 才重发注入——流式下 content 与 tool_calls 同包出现完全可能：
     * 模型边写旁白边调 recall_world_state 时，召回执行了但模型没看到（正文是盲写的）。
     * 按工具语义分流：
     *  - recall_*：模型需要的信息 → 调了就注入重发；
     *  - request_image（chat / rp 直出）：已异步化，模型写了正文就不重发（省一次调用）——「已排队」的
     *    feedback 只在 noProse 重发时随包注入；
     *  - request_image（剧情模式）：工具已停用，「该工具不可用」是模型要收到的回传 → 调了就重发；
     *  - update_memory / schedule_*：fire-and-forget 的事后动作 → 仅 noProse 时重发（原行为）。
     * 重发永不带工具（结构上防循环）；重发不可用而第一版有正文时回退第一版。 */
    const noProse = !reply1.narration || (reply1.parseFailed && reply1.looksJson);
    const needsFeedback = effect.recallScopes.length > 0 || effect.toolUnavailable;
    if (toolsOn && calls.length && (noProse || needsFeedback)) {
      if (noProse) reasoning = '';   // 纯工具回合的思考链不对应最终旁白，丢掉
      // 重发沿用本轮组装选项（含画像），但不下发工具清单
      const injects = effect.feedback.slice();
      if (droppedCalls.length) {
        injects.push('[提示] 以下调用已达本轮上限、未执行：' + droppedCalls.map(c => c.name).join('、') + '，当作没有这回事，别在正文里提它们的结果。');
      }
      const secondOpts = Object.assign({}, asmOpts, { recall: effect.recallScopes, inject: injects });
      delete secondOpts.tools;
      const second = await A.streamAI1(adapter, cfg,
        Context.assembleAI1(S.story, playerAction, secondOpts),
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

  // 编排：组装 → 调用 + 重发（对外入口不变，仍是 callAI1）
  async function callAI1(playerAction, opts) {
    return invokeAI1(playerAction, buildAI1Request(playerAction, opts));
  }

  // 输入类型（做 / 说 / 导演）：状态按故事记在 story.ui.kind，旧存档缺省 = 做
  function currentKind() {
    const k = S.story && S.story.ui && S.story.ui.kind;
    return (k === 'say' || k === 'direct') ? k : 'do';
  }
  // 外层前缀 [玩家行动] 保持不变，类型标记作为内层前缀。
  // chat（智能体）不做 / 说 / 导演——内层标记直接不加（组装历史时另有 stripKindMarker 兼容旧档）。
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
    S.stopRequested = false; S.chatAbortCtrl = null;   // 每回合复位停止标记
    S.currentChoices = [];
    S.choicesTrayOpen = false;
    setSendButtonsBusy(true);   // busy 期间发送按钮变身「停止」

    const mark = Tree.begin(S.story);   // 记 logMark：必须在 pushLog 之前
    const sid = S.story.id;             // 异步写回契约：这次回合属于哪本故事，回包前核 id
    pushLog(agentMsg
      ? { type: 'agent', text: action, trigger: meta.triggerName || '', reason: meta.reason || '', fireId: meta.fireId || '' }
      : { type: isChoice ? 'choice' : 'player', text: action, kind: kind || 'do' });
    renderChat();

    try {
      const res = await callAI1(sentAction);
      if (!WriteBack.assertStory(S.story, sid, '回合回包')) return;
      const reply = res.reply;
      S.story.turn += 1;
      S.story.lastSceneSummary = reply.scene_summary || S.story.lastSceneSummary;
      const userMsg = { role: 'user', content: Context.playerContent(S.story.premise, sentAction) };
      const asst = A.assistantMessage(reply, res.reasoning);
      S.story.messages.push(userMsg, asst);
      A.pushNarrationEntry(reply.narration, res.reasoning);
      await finishNarration(res.streamed);
      if (!WriteBack.assertStory(S.story, sid, '回合收尾')) return;
      A.absorbReply(reply);
      S.currentChoices = reply.choices;
      renderChat();
      // 回合落节点：entries = log.slice(logMark)，head 前移；失败 / 停止不建节点
      // meta.model 记下本回合实际用的模型名（不含任何密钥 / URL），分支页可显示
      const node = Tree.commit(S.story, {
        action: {
          type: agentMsg ? 'agent' : (isChoice ? 'choice' : 'player'),
          text: action, kind: kind || null, sent: sentAction,
        },
        userMsg: userMsg, assistantMsg: asst, logMark: mark.logMark,
        meta: { model: S.turnModel || '' },
      });
      S.turnAnchor.nodeId = node.id;                // 锚点补 nodeId，后台出图任务写回时落位
      await A.postTurn();
      if (!WriteBack.assertStory(S.story, sid, '回合封节点')) return;
      Tree.seal(S.story, node.id);               // 必须在 postTurn 之后：收进压缩 / 书记员的 tool 条目
      A.maybeAutoTitle();                          // seal 后异步起标题，不占 busy、不阻塞下一次发送
      if (agentMsg && meta.fireId) await A.ackProactive(meta.fireId);   // 已送达：从侧车队列里销掉
    } catch (e) {
      S.live = null;
      S.turnAnchor.dead = true;   // 失败 / 停止——本回合排队中与在途的工具出图丢弃
      const stopped = isStopError(e);   // 玩家主动停止——不算故障，不弹错误提示
      if (!stopped) reportUserFailure('回合', e, { message: netErrHint(e) });   // 发送按钮已恢复，可再发一次
      if (!WriteBack.assertStory(S.story, sid, '回合失败回写')) return;
      S.story.log.push({
        type: 'narration',
        text: stopped ? '（已停止。点「↻ 重试」或再试一次。）' : '（AI 走神了，点「↻ 重试」或再试一次吧。）',
        versions: [], ts: Date.now(),
      });
      renderChat();
    } finally {
      S.busy = false;
      S.stopRequested = false; S.chatAbortCtrl = null;
      S.live = null; S.liveEl = null;
      setSendButtonsBusy(false);
      renderChat();
      if (Features) Features.drain();   // 忙完了，看看排队的主动消息能不能送
    }
  }

  // 旁白已进 log：流式就直接落定；非流式用打字机补观感
  async function finishNarration(streamed) {
    if (streamed) {
      // 流结束把逐段淡入的 span 整体合并成单个文本节点
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
  // 实际请求与存档此前是两句不同的话，retryLast 会以存档版重发、与首发不一致——统一成常量
  const OPENING_ACTION = '（故事开场。请描写第一幕，把玩家带进场景。）';

  async function runOpening() {
    if (S.busy || !S.story) return;
    S.busy = true;
    S.stopRequested = false; S.chatAbortCtrl = null;
    setSendButtonsBusy(true);
    const mark = Tree.begin(S.story);             // 记 logMark
    const sid = S.story.id;                       // 异步写回契约：这次开局属于哪本故事
    try {
      const res = await callAI1(OPENING_ACTION, { includePremise: true });
      if (!WriteBack.assertStory(S.story, sid, '开局回包')) return;
      const reply = res.reply;
      S.story.turn += 1;
      S.story.lastSceneSummary = reply.scene_summary || '';
      const userMsg = { role: 'user', content: Context.playerContent(S.story.premise, OPENING_ACTION, { includePremise: true }) };
      const asst = A.assistantMessage(reply, res.reasoning);
      S.story.messages.push(userMsg, asst);
      A.pushNarrationEntry(reply.narration, res.reasoning);
      await finishNarration(res.streamed);
      if (!WriteBack.assertStory(S.story, sid, '开局收尾')) return;
      A.absorbReply(reply);
      S.currentChoices = reply.choices;
      renderChat();
      // 开局同样是节点：action.type = 'opening'，sent = OPENING_ACTION
      const node = Tree.commit(S.story, {
        action: { type: 'opening', text: OPENING_ACTION, kind: null, sent: OPENING_ACTION },
        userMsg: userMsg, assistantMsg: asst, logMark: mark.logMark,
        meta: { model: S.turnModel || '' },
      });
      S.turnAnchor.nodeId = node.id;                 // 锚点补 nodeId
      await A.postTurn();
      if (!WriteBack.assertStory(S.story, sid, '开局封节点')) return;
      Tree.seal(S.story, node.id);                // 必须在 postTurn 之后
      A.maybeAutoTitle();                           // 开局回合同样触发自动标题
      // 开局不再自动出图——图只来自用户点 🎨（作画）/ 工作台重画
      toast('已开局。想看画面随时点右上角「作画」。');
      saveAll();
    } catch (e) {
      S.live = null;
      S.turnAnchor.dead = true;   // 失败 / 停止分支同样置位
      const stopped = isStopError(e);
      if (!stopped) reportUserFailure('开局', e, { message: netErrHint(e) });   // 「重新开场」入口仍在，可重试
      if (!WriteBack.assertStory(S.story, sid, '开局失败回写')) return;
      S.story.log.push({
        type: 'narration',
        text: stopped ? '（已停止。输入任意内容开始故事。）' : '（AI 走神了，输入任意内容开始故事。）',
        versions: [], ts: Date.now(),
      });
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

  // 输入框预填接口（只为 forkBefore「改我说的」用）——不触发发送。
  // 剧情 / 扮演还原「做 / 说 / 导演」选择；智能体（chat）没有这组语义，只填文本。
  function setComposerText(text, kind) {
    const inp = $('#player-input');
    if (inp) inp.value = String(text == null ? '' : text);
    if (S.story && S.story.mode !== 'chat') {
      S.story.ui = S.story.ui || {};
      S.story.ui.kind = (kind === 'say' || kind === 'direct') ? kind : 'do';
      A.syncKindSwitch();
      saveAll();
    }
    if (inp && inp.focus) inp.focus();
  }

  // 智能体引导 chip 的预填（不发送）：复用 setComposerText，光标落在尾部省略号前的「可编辑处」
  function fillPlayerInput(text) {
    const s = String(text == null ? '' : text);
    setComposerText(s);
    const inp = $('#player-input');
    if (inp && inp.setSelectionRange) {
      const caret = s.replace(/[…]+$/, '').length;
      try { inp.setSelectionRange(caret, caret); } catch (_) { /* 不支持选区的输入框保持默认光标 */ }
    }
  }

  A.reg({ callAI1, withKindMarker, syncKindSwitch, sendPlayerAction, finishNarration, runOpening, pushLog, setComposerText, toolInjection, fillPlayerInput });

