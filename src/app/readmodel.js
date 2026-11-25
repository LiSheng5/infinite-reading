/*
 * src/app/readmodel.js —— 阅读页视图模型（ReadScreen 状态桥的弹药）
 *
 * render.js 的 renderChat / renderThumbs 在 Svelte 屏（src/screens/read）在位时取这里的
 * 纯数据模型推给组件；切分 / 分派口径与旧拼装路径（bubbleFor / renderOpeningHint /
 * renderChoices / renderThumbs）共用同一套 helper（imageSceneById / sceneSrc / safeImgSrc /
 * KIND_LABELS / Tree.siblings …），不另起一套。
 * 用户 / 模型产出的文字只以字符串进模型（组件文本插值渲染 ≡ textContent，红线）；
 * 条目附原条目引用（entry），点击动作（选场景 / 灯箱 / 工作台 / 提案确认拒绝）原样走 App。
 * 每个条目模型带稳定 key：按 log 条目对象身份发号（project 按引用共享 → 同一条目
 * 跨 renderChat / 切分支共享前缀拿到同一个号），ReadScreen 的 each 据此做 keyed 更新——
 * 旧气泡与内联图不销毁、不重新解码、入场动画不重放。
 * 输出纯数据视图模型，DOM 由 Svelte 组件按字段渲染；字段名与旧拼装保持一致，供回归对照。
 */
import { Tree } from '../core/tree.ts';
import { Prefs } from '../core/prefs.ts';
import { Proposals } from '../core/proposals.ts';
import { describeContextUsageCached, usageMemoKey } from '../core/ctxusage.ts';
import { A } from './core.js';


  const S = A.state;

  /* ================= 单条条目：e.type → 模型（分派表同 BUBBLE_RENDERERS） ================= */

  // 通用文本气泡（player / choice / narration 及未知类型）：标签 + 正文 + 思考链 + 分支导航
  function textModel(e, index) {
    const tag = (e.type === 'player' || e.type === 'choice')
      ? (e.type === 'choice' ? '选择' : (A.KIND_LABELS[e.kind] || A.KIND_LABELS.do))
      : '';
    const reasoning = (e.type === 'narration' && showReasoning() && String(e.reasoning || '').trim())
      ? String(e.reasoning) : '';
    // 分支导航：凡是有兄弟的旁白都显示 ‹ n/m ›；「↻ 重试」仍只在最后一条
    const sibs = (e.type === 'narration' && e.nid && S.story && S.story.tree)
      ? Tree.siblings(S.story, e.nid) : [];
    const showRetry = e.type === 'narration' && index === A.lastNarrationIndex() && !S.busy && !!A.lastActionEntry();
    const nav = (e.type === 'narration' && !S.busy && sibs.length > 1)
      ? { index: sibs.indexOf(e.nid) + 1, count: sibs.length } : null;
    return {
      kind: 'text',
      cls: 'bubble ' + (e.type === 'player' ? 'bubble-player'
        : e.type === 'choice' ? 'bubble-choice' : 'bubble-narration'),
      nid: e.nid || '',
      kindTag: tag,
      text: e.text || '',
      reasoning: reasoning,
      showRetry: showRetry,
      nav: nav,
      usage: e.type === 'narration' ? usageLabel(e.usage) : null,
    };
  }

  // 每回合 token 用量：一行安静的小字；没有 usage（服务商没上报 / 旧档）就是 null，什么也不画
  function usageLabel(u) {
    if (!u || !(u.prompt >= 0) || !(u.completion >= 0)) return null;
    const fmt = (n) => Number(n).toLocaleString('en-US');
    const parts = ['输入 ' + fmt(u.prompt), '输出 ' + fmt(u.completion)];
    const detail = [];
    if (u.cached) detail.push('其中缓存命中 ' + fmt(u.cached));
    if (u.reasoning) detail.push('输出里思考 ' + fmt(u.reasoning));
    return {
      text: parts.join(' · ') + ' tokens',
      title: '本回合共 ' + fmt(u.total) + ' tokens' + (detail.length ? '（' + detail.join('，') + '）' : '')
        + '；含工具反馈后的重发',
    };
  }

  function showReasoning() {
    return Prefs.effective(S.settings, S.story, 'showReasoning');
  }

  // 工具 / 系统注记：一行纯文本
  function noteModel(e) {
    return {
      kind: 'note',
      text: e.type === 'tool' ? (e.summary || e.tool || '工具调用') : (e.text || ''),
    };
  }

  // 场景标记行（剧情模式）/ 内联图（chat / rp，无舞台）：imageBubble 的两条分支
  function imageModel(e) {
    const inline = !!(S.story && (S.story.mode === 'chat' || S.story.mode === 'rp'));
    const sc = A.imageSceneById(e.id);
    return {
      kind: 'image',
      variant: inline ? 'inline' : 'row',
      entry: e,
      // 内联图走安全白名单（data: / blob: / https:）；场景行原样（同旧 imageRowBubble 口径）
      src: inline ? A.safeImgSrc(A.sceneSrc(sc, e)) : (A.sceneSrc(sc, e) || ''),
      alt: e.alt || (inline ? '插图' : '场景缩略图'),
      cap: (e.alt || (inline ? '（一幅插图）' : '（一幅场景插图）'))
        + (e.supersededBy ? ' · 已被重画版替代' : ''),
    };
  }

  // 视频：聊天流里 56px 封面 + alt + ▶，点一下在舞台选中（同图片行）
  function videoModel(e) {
    return {
      kind: 'video',
      entry: e,
      cover: e.thumb || e.poster || '',
      alt: e.alt || '场景视频封面',
      cap: (e.alt || '场景视频') + (e.duration ? ' · ' + e.duration + 's' : '')
        + (e.videoOmitted ? ' · 视频未随备份导出' : ''),
      hasRemote: !e.videoId && !!e.remoteUrl,
    };
  }

  // 模型主动联系（调度触发）：样式同玩家气泡，另加一行轻量标注「谁 / 何时 / 为何找你」
  function agentModel(e) {
    return {
      kind: 'agent',
      text: e.text || '',
      note: 'AI 主动找你'
        + (e.trigger ? '（' + e.trigger + '）' : '')
        + (e.reason ? ' · ' + e.reason : '')
        + (e.ts ? ' · ' + A.fmtTime(e.ts) : ''),
    };
  }

  // 提案卡（✉ 邮件 / 🛒 下单）：参数原值进模型（红线 4，组件文本插值渲染），
  // 状态 / 剩余分钟由 features 的 proposalStatusLabel 统一给出；状态收敛同点位
  //（Proposals.reconcile：旧档迁移 / 中断的 executing / TTL 过期，只改内存，saveAll 落盘）
  function proposalModel(e) {
    const p = e && e.proposal;
    const now = Date.now();
    if (!p) return { kind: 'proposal', empty: true };
    Proposals.reconcile(p, now);
    const rows = [];
    const row = (k, v) => { rows.push({ k: k, v: String(v == null ? '' : v) }); };
    if (p.kind === 'email') {
      row('收件人', p.args.to);
      row('主题', p.args.subject);
      row('正文', p.args.body);
    } else {
      row('金额', A.yuan(p.args.amountCents));
      row('商户', p.args.merchant || '（未填）');
      row('品类', p.args.category || '（未填）');
      row('商品', (p.args.items || []).map(i => i && i.name).filter(Boolean).join('、') || '（未填）');
    }
    if (p.args.reason) row('理由', p.args.reason);
    const ST = Proposals.STATUS;
    const live = Proposals.isActionable(p, now);     // pending / awaiting_confirm 且没过 TTL
    let statusText = A.proposalStatusLabel(p, now);
    if ((p.status === ST.PENDING || p.status === ST.AWAITING) && now < p.expiresAt) {
      const mins = Math.max(1, Math.ceil((p.expiresAt - now) / 60000));
      statusText += ' · 有效剩 ' + mins + ' 分钟';
    }
    return {
      kind: 'proposal',
      empty: false,
      entry: e,
      icon: p.kind === 'email' ? 'mail' : 'cart',
      title: (p.kind === 'email' ? '邮件提案' : '下单提案') + '（要你确认才执行）',
      rows: rows,
      statusText: statusText,
      actionable: p.status === ST.PENDING && live && !S.busy,
      // 二次确认被中断（关弹窗 / 刷新）：卡片给「继续确认」，不必等 TTL 过完
      second: p.status === ST.AWAITING && live && !S.busy,
      // 发信失败后 sidecar 草稿没清掉：给一个「清理草稿」入口（自动清理成功时不会出现）
      cleanup: p.status === ST.FAILED && !!(p.result && p.result.draftId && p.result.draftDiscarded === false) && !S.busy,
    };
  }

  const ENTRY_MODELS = {
    proposal: proposalModel,
    tool: noteModel,
    system: noteModel,
    image: imageModel,
    video: videoModel,
    agent: agentModel,
  };

  // 条目 key：WeakMap 按 log 条目对象身份发递增号。
  // 树上同一对象被 project 原样共享（node.entries ↔ story.log 引用共享，不 clone），
  // 所以同一逻辑条目跨 renderChat / 切分支都拿到同一个 key；条目随分支切换 / 窗口滑出
  // 离开 log 后组件按 key 销毁，新条目拿新号。key 是原始 number（$state 代理不包装基本类型），
  // 不落进存档（WeakMap 不可枚举、模型本身也不序列化）。
  const entryKeys = new WeakMap();
  let entryKeySeq = 0;
  function entryKey(e) {
    if (!e || typeof e !== 'object') return 'x' + (++entryKeySeq);   // 坏档兜底：当次唯一即可
    let k = entryKeys.get(e);
    if (k === undefined) { k = ++entryKeySeq; entryKeys.set(e, k); }
    return k;
  }

  function entryModel(e, index) {
    const build = ENTRY_MODELS[e && e.type];
    const m = build ? build(e) : textModel(e, index);
    m.key = entryKey(e);
    return m;
  }

  /* ================= 智能体空对话引导（新对话「能做什么」） =================
   * 还没有任何消息时显示一块引导；发出第一条消息后永久消失（只依赖 log.length === 0，不存状态）。
   * chips 的「启用」复用工具注入判定（round.js 的 toolInjection）：启用 ⇔ 对应工具这回合会被注入，
   * 判定不写第二套；未启用项仍显示（「未启用 ›」），why 是给用户看的未启用原因。
   * 示例句是通用模板，不涉及任何模型名或厂商名。 */
  const AGENT_CHIPS = [
    { id: 'draw',   label: '帮我画一张…',   prompt: '帮我画一张……',      tool: 'request_image',   category: 'image',    fixGroup: 'g-image', word: '画图' },
    { id: 'memo',   label: '记一件事…',    prompt: '记一下……',          tool: 'update_memory',   category: 'memory',   fixGroup: 'g-tools', word: '记事' },
    { id: 'remind', label: '明天提醒我…',   prompt: '明天早上提醒我……',    tool: 'schedule_once',   category: 'schedule', fixGroup: 'g-tools', word: '定时' },
    { id: 'email',  label: '写封邮件…',    prompt: '帮我起草一封邮件……',   tool: 'email_propose',   category: 'email',    fixGroup: 'g-tools', word: '写邮件' },
    { id: 'order',  label: '帮我买点东西…',  prompt: '帮我买一点……',       tool: 'payment_propose', category: 'payment',  fixGroup: 'g-tools', word: '下单' },
  ];
  const AGENT_CONFIRM_LABEL = { email: '发邮件', order: '下单' };

  // 引导文案：「能帮你……」只列判定为可用的能力（诚实），全部未启用时改成一句指路；
  // 「先让你确认」的机制说明只在对应的提案能力可用时出现。
  function agentIntroText(chips) {
    const defs = {};
    AGENT_CHIPS.forEach(d => { defs[d.id] = d; });
    const on = chips.filter(c => c.enabled);
    if (!on.length) return ['这些能力都还没启用：点下面的「未启用」去打开。'];
    const words = on.map(c => defs[c.id].word);
    const list = words.length > 1
      ? (words.slice(0, -1).join('、') + '和' + words[words.length - 1])
      : words[0];
    const lines = ['能帮你' + list + '。'];
    const proposals = on.filter(c => AGENT_CONFIRM_LABEL[c.id]);
    if (proposals.length >= 2) lines.push('邮件与下单都会先让你确认。');
    else if (proposals.length === 1) lines.push(AGENT_CONFIRM_LABEL[proposals[0].id] + '前会让你确认。');
    return lines;
  }

  /* ================= 上下文用量指示器（只读；估算与实发同源） =================
   * 数据在 app 层算好随 chat 模型推给组件（read.svelte.js 的 chat.usage）：tokens / 阈值
   * 都来自 src/core/ctxusage.ts（estimateTokensOf(assembleAI1) 与 compressThreshold），
   * 不另写一套估算。零副作用：只走 buildAssembleOpts 的 dry 路径——不写回合字段、
   * 不消费 🧠 一次性开关、不触发会改 story 的预算压缩。
   * 流式（S.busy / S.live）期间不重算，保持上一次的值，回合结束（postTurn → renderChat）
   * 才更新；key（故事 / head / 条数 / 窗口 / 工具画像签名）没变就复用上次的模型。 */

  const fmtK = (n) => {
    const v = Math.round(+n || 0);
    if (v < 1000) return String(v);
    return (Math.round(v / 100) / 10) + 'k';   // 一位小数（12.3k），整数不带 .0（128k）
  };
  const fmtNum = (n) => Number(Math.round(+n || 0)).toLocaleString('en-US');

  let lastUsageView = null;

  function usageView() {
    const story = S.story;
    if (!story) { lastUsageView = null; return null; }
    if ((S.busy || S.live) && lastUsageView) return lastUsageView;
    let key = '';
    let u;
    try {
      const built = A.buildAssembleOpts('', { dry: true });   // playerAction 空串 = 下一轮基线
      key = usageMemoKey(story, A.treeHeadNodeId(), built.asmOpts);
      if (lastUsageView && lastUsageView.memoKey === key) return lastUsageView;
      u = describeContextUsageCached(key, story, built.asmOpts);
    } catch (e) {
      // 算不出来：界面显示「—」，原因走 reportBackgroundFailure 留 console（不弹 toast、不空 catch）
      if (lastUsageView && lastUsageView.error && lastUsageView.memoKey === key) return lastUsageView;
      A.reportBackgroundFailure('上下文用量估算', e);
      lastUsageView = {
        memoKey: key, error: true,
        text: '—', valuetext: '上下文用量估算暂不可用，原因见浏览器控制台',
      };
      return lastUsageView;
    }
    const known = u.window > 0;
    const pct = known ? Math.round(u.ratio * 100) : 0;
    const view = {
      memoKey: key,
      error: false,
      level: u.level,
      windowKnown: known,
      tokens: u.tokens,
      window: u.window,
      text: (u.level === 'warn' ? '近压缩线 · ' : u.level === 'over' ? '将自动压缩 · ' : '')
        + (known ? ('≈' + fmtK(u.tokens) + ' / ' + fmtK(u.window)) : ('≈' + fmtK(u.tokens))),
      barPct: known ? Math.min(100, Math.max(0, u.ratio * 100)) : 0,
      tickPct: known ? (u.threshold / u.window) * 100 : 0,
      valuetext: !known
        ? ('上下文容量未知，约 ' + fmtK(u.tokens) + ' token')
        : u.level === 'over'
          ? ('上下文约 ' + pct + '%，已到自动压缩线，发送前会自动压缩较早的对话')
          : ('上下文约 ' + pct + '%，距自动压缩还有约 ' + fmtK(Math.max(0, u.threshold - u.tokens))),
      detail: known
        ? ('下一轮请求约 ' + fmtNum(u.tokens) + ' token，占窗口 ' + pct + '%。超过 ' + fmtNum(u.threshold)
          + ' token 时，发送前会自动压缩较早的对话。')
        : ('下一轮请求约 ' + fmtNum(u.tokens) + ' token。当前模型的上下文容量未知（可在设置里手填），这里不显示占比与自动压缩线。'),
      lastUsage: u.lastUsage
        ? ('上一轮服务商实报 ' + fmtNum(u.lastUsage.total) + ' token（输入 ' + fmtNum(u.lastUsage.prompt)
          + ' · 输出 ' + fmtNum(u.lastUsage.completion) + '）')
        : '',
    };
    lastUsageView = view;
    return view;
  }

  /* ================= renderChat 整模型（旧 renderChat 的同步语义） ================= */

  function readChatModel() {
    const m = {
      entries: [],
      openingHint: false,
      agentIntro: false,
      agentIntroDesc: '',
      agentChips: [],
      agentIntroText: [],
      live: false,
      liveReason: false,
      choices: [],
      tray: [],
      trayVisible: false,
      trayOpen: false,
      inspiration: false,
      inspirationCount: '',
      usage: null,      // 上下文用量指示器（usageView；无故事 = 不显示）
    };
    const story = S.story;
    if (!story) return m;
    m.usage = usageView();
    const log = story.log || [];
    log.forEach((e, i) => { m.entries.push(entryModel(e, i)); });

    // 剧情模式空档：不自动跑开场，显示「开始第一幕」按钮（renderOpeningHint 同口径）
    m.openingHint = !S.busy && !S.live && story.mode === 'choice' && !log.length;

    // 智能体空对话：还没发过消息时给「能做什么」引导（发出第一条消息后 log 非空，自然消失）
    m.agentIntro = !S.busy && !S.live && story.mode === 'chat' && !log.length;
    if (m.agentIntro) {
      // 首行是模式说明（与剧情 / 扮演的开局页同一份文案表）：
      // 这一屏没有弹窗标题，「新建的这次对话是什么模式」由顶栏的模式名担着，说明印在引导块第一行。
      m.agentIntroDesc = A.MODE_ENTRY.chat.desc;
      const inj = A.toolInjection();
      const names = inj.tools.map(t => t.function.name);
      m.agentChips = AGENT_CHIPS.map(c => {
        const enabled = names.indexOf(c.tool) >= 0;
        return {
          id: c.id,
          label: c.label,
          prompt: c.prompt,
          enabled: enabled,
          why: enabled ? '' : (inj.why[c.category] || '还没启用'),
          fixGroup: c.fixGroup,
        };
      });
      m.agentIntroText = agentIntroText(m.agentChips);
    }

    // 流式 / 打字机中的临时旁白（renderChat 的 S.live 分支）：
    // 组件只渲染两个空壳（reason-live + bubble-live），interior 由 render.js 的 fillLiveDom 填
    m.live = !!S.live;
    m.liveReason = !!(S.live && showReasoning() && String(S.live.reasoning || '').trim());

    // 选项（renderChoices 同口径）：always 内联在旁白下；默认收在「灵感」托盘
    const canShow = !S.busy && !S.live && story.mode === 'choice'
      && Array.isArray(S.currentChoices) && S.currentChoices.length > 0;
    const inline = Prefs.effective(S.settings, story, 'choices') === 'always';
    if (canShow && inline) m.choices = S.currentChoices.slice();
    if (canShow && !inline) {
      m.inspiration = true;
      m.inspirationCount = String(S.currentChoices.length);
      m.trayOpen = !!S.choicesTrayOpen;
      m.trayVisible = m.trayOpen;
      if (m.trayOpen) m.tray = S.currentChoices.slice();
    }
    return m;
  }

  /* ================= renderThumbs 整模型（缩略条只读，点击即选场景） ================= */

  function readThumbsModel() {
    const story = S.story;
    const scenes = (story && story.scenes) || [];
    const items = [];
    for (const sc of scenes) {
      // 缩略条优先用小图（快）；小图缺失但原图在 IndexedDB 里时，等它异步取回来再重推一次
      // 视频场景用封面（thumb）；▶ 角标画在 .thumb-wrap 上（img 的 ::after 不渲染）
      const src = sc.kind === 'video' ? (sc.thumb || sc.poster || '') : (sc.thumb || A.sceneSrc(sc));
      if (!src) continue;
      items.push({
        id: sc.id,
        src: src,
        alt: sc.alt || '场景缩略图',
        title: sc.alt || '',
        active: story.lastBg === sc.id,
        isVideo: sc.kind === 'video',
      });
    }
    return { empty: !scenes.length, items: items };
  }

  A.reg({ readChatModel, readThumbsModel });

