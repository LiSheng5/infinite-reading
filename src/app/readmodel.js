/*
 * src/app/readmodel.js —— 阅读页视图模型（阶段 4 屏 4：ReadScreen 状态桥的弹药）
 *
 * render.js 的 renderChat / renderThumbs 在 Svelte 屏（src/screens/read）在位时取这里的
 * 纯数据模型推给组件；切分 / 分派口径与旧拼装路径（bubbleFor / renderOpeningHint /
 * renderChoices / renderThumbs）共用同一套 helper（imageSceneById / sceneSrc / safeImgSrc /
 * KIND_LABELS / Tree.siblings …），不另起一套。
 * 用户 / 模型产出的文字只以字符串进模型（组件文本插值渲染 ≡ textContent，红线 §8）；
 * 条目附原条目引用（entry），点击动作（选场景 / 灯箱 / 工作台 / 提案确认拒绝）原样走 App。
 * 视图模型口径与 0.12.1 的 DOM 拼装逐字段一致（截图逐像素对齐）。
 */
import { Tree } from '../core/tree.ts';
import { Prefs } from '../core/prefs.ts';
import { Proposals } from '../core/proposals.ts';
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
    // 分支导航（§4.3/§5⑤）：凡是有兄弟的旁白都显示 ‹ n/m ›；「↻ 重试」仍只在最后一条（§5⑤）
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

  // 场景标记行（剧情模式）/ 内联图（chat / rp，v0.6.0 无舞台）：imageBubble 的两条分支
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

  // 视频（§8）：聊天流里 56px 封面 + alt + ▶，点一下在舞台选中（同图片行）
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
  // 状态 / 剩余分钟与旧 proposalBubble 同口径；过期就地收敛也同点位（只改内存，saveAll 落盘）
  function proposalModel(e) {
    const p = e && e.proposal;
    const now = Date.now();
    if (!p) return { kind: 'proposal', empty: true };
    if (p.status === 'pending' && now >= p.expiresAt) Proposals.markExpired(p);
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
    let statusText = A.proposalStatusLabel(p, now);
    if (p.status === 'pending' && now < p.expiresAt) {
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
      actionable: p.status === 'pending' && now < p.expiresAt && !S.busy,
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

  function entryModel(e, index) {
    const build = ENTRY_MODELS[e && e.type];
    return build ? build(e) : textModel(e, index);
  }

  /* ================= renderChat 整模型（旧 renderChat 的同步语义） ================= */

  function readChatModel() {
    const m = {
      entries: [],
      openingHint: false,
      live: false,
      liveReason: false,
      choices: [],
      tray: [],
      trayVisible: false,
      trayOpen: false,
      inspiration: false,
      inspirationCount: '',
    };
    const story = S.story;
    if (!story) return m;
    const log = story.log || [];
    log.forEach((e, i) => { m.entries.push(entryModel(e, i)); });

    // 剧情模式空档：不自动跑开场，显示「开始第一幕」按钮（renderOpeningHint 同口径）
    m.openingHint = !S.busy && !S.live && story.mode === 'choice' && !log.length;

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
      // 视频场景用封面（thumb）；▶ 角标画在 .thumb-wrap 上（img 的 ::after 不渲染，§8）
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

