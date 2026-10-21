/*
 * js/app/render.js —— 聊天记录窗口 / 画面面板 / 布局状态 / 进入离开故事（含灯箱与内联图气泡）
 * 从 js/app.js 拆出（只搬家，不改行为）。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, Store, MODE_LABELS, KIND_LABELS, motionLevel, toast, fmtTime, persistSettings, saveAll } = A;

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
    A.resetLiveDelta();   // 同理：span 追踪只对当前气泡有效
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
      if (IR.Prefs.effective(S.settings, S.story, 'showReasoning') && String(S.live.reasoning || '').trim()) {
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
    const inline = IR.Prefs.effective(S.settings, S.story, 'choices') === 'always';

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
        b.onclick = () => A.sendPlayerAction(c, true);
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
      b.onclick = () => { S.choicesTrayOpen = false; A.sendPlayerAction(c, true); };
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

  // 确认 = 一次用户点击 → 最多一次执行（Proposals.confirm 同步抢占状态，连点不会二次执行）

  // 拒绝：不执行任何发送 / 扣款；已有 intent / 草稿时由 Proposals.deny 负责清理

  function bubbleFor(e, index) {
    if (e.type === 'proposal') return A.proposalBubble(e);
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
      wb.onclick = () => A.openWorkbench(e.id);
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
    // UI-2 §3.7：记下节点 id，搜索结果点进来才能滚到这条消息并高亮
    if (e.nid) d.dataset.nid = e.nid;
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
    if (e.type === 'narration' && IR.Prefs.effective(S.settings, S.story, 'showReasoning') && String(e.reasoning || '').trim()) {
      d.insertBefore(reasonBlock(e.reasoning, false), d.firstChild);
    }

    // 分支导航（§4.3/§5⑤）：凡是有兄弟的旁白都显示 ‹ n/m ›，点了就切到那条分支；
    // 「↻ 重试」仍只在最后一条（§5⑤）。旧版本栈已由迁移展开成兄弟（任务书 §6），不再兜底切换。
    const sibs = (e.type === 'narration' && e.nid && S.story && S.story.tree) ? IR.Tree.siblings(S.story, e.nid) : [];
    const showRetry = e.type === 'narration' && index === A.lastNarrationIndex() && !S.busy && A.lastActionEntry();
    const showSibs = e.type === 'narration' && !S.busy && sibs.length > 1;
    if (showRetry || showSibs) {
      const tools = document.createElement('div');
      tools.className = 'bubble-tools';
      if (showRetry) {
        const rb = document.createElement('button');
        rb.className = 'mini-btn';
        rb.textContent = '↻ 重试';
        rb.title = '换一种不同的发展（旧版留在分支里，可用 ‹ › 切回）';
        rb.onclick = A.retryLast;
        tools.appendChild(rb);
      }
      if (showSibs) {
        const nav = document.createElement('span');
        nav.className = 'version-nav';
        const prev = document.createElement('button');
        prev.className = 'mini-btn'; prev.textContent = '‹'; prev.title = '上一条分支';
        prev.onclick = () => A.switchSiblingFromBubble(e.nid, -1);
        const label = document.createElement('span');
        label.className = 'version-label';
        label.textContent = (sibs.indexOf(e.nid) + 1) + '/' + sibs.length;
        const next = document.createElement('button');
        next.className = 'mini-btn'; next.textContent = '›'; next.title = '下一条分支';
        next.onclick = () => A.switchSiblingFromBubble(e.nid, 1);
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
    setStageImage(currentScene(), A.sceneSrc(currentScene()));
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

  /* ================= 渲染：布局状态（P2 的统一入口 · UI-3 §3.5 分层） =================
   * 所有排版只由 #screen-game 的 data-layout 决定：
   *   auto → 宽度 ≥ 900px 用 split，否则 stack；immersive 只能由用户进入。
   * 有效值 = story.prefs.ui 覆盖 → settings.ui 全局默认；story.ui 只记输入类型。 */

  const LAYOUTS = ['auto', 'split', 'stack', 'immersive'];
  // 字号 / 宽度 / 密度（§3.5）：三档映射到令牌（--font-scale / --content-w / --density），不为每档写一套样式
  const FONT_SCALE = { sm: 0.92, md: 1, lg: 1.12 };
  const CONTENT_W = { narrow: '620px', standard: '760px', wide: '920px' };
  const DENSITY = { compact: 0.82, standard: 1 };

  function uiState() {
    if (!S.settings.ui || typeof S.settings.ui !== 'object') S.settings.ui = Store.defaultSettings().ui;
    return S.settings.ui;
  }

  // 有效 UI（只读合并快照）：本对话覆盖 → 全局默认（UI-3 §3.5）
  function effectiveUi() {
    return IR.Prefs.effective(S.settings, S.story, 'ui');
  }

  // 写回：本对话已覆盖的键写 story.prefs.ui，未覆盖的写全局 settings.ui
  function writeUi(patch) {
    const prefsUi = (S.story && S.story.prefs && S.story.prefs.ui) || null;
    for (const k of Object.keys(patch)) {
      if (prefsUi && Object.prototype.hasOwnProperty.call(prefsUi, k)) prefsUi[k] = patch[k];
      else uiState()[k] = patch[k];
    }
  }

  function autoLayout() {
    return (typeof window !== 'undefined' && window.innerWidth >= 900) ? 'split' : 'stack';
  }

  function effectiveLayout() {
    // v0.6.0：chat（智能体）/ rp（扮演）是纯聊天布局（无画面区）；剧情模式的 split / stack / immersive 一行不动
    if (S.story && (S.story.mode === 'chat' || S.story.mode === 'rp')) return 'chat';
    const ui = effectiveUi();
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
    const layout = LAYOUTS.indexOf(next) >= 0 ? next : 'auto';
    writeUi({ layout: layout });
    if (layout !== 'immersive') S.immersiveTextHidden = false;
    applyLayout();
    persistSettings();
  }

  function applyLayout() {
    const el = $('#screen-game');
    if (!el) return;
    const ui = effectiveUi();
    const layout = effectiveLayout();
    el.dataset.layout = layout;
    el.style.setProperty('--split-ratio', String(ui.splitRatio || 0.5));
    // UI-3 §3.5：字号 / 宽度 / 密度 → CSS 变量（令牌驱动；chat / rp 的内容区吃这三个变量）
    el.style.setProperty('--font-scale', String(FONT_SCALE[ui.fontScale] != null ? FONT_SCALE[ui.fontScale] : 1));
    el.style.setProperty('--content-w', CONTENT_W[ui.width] || CONTENT_W.standard);
    el.style.setProperty('--density', String(DENSITY[ui.density] != null ? DENSITY[ui.density] : 1));
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
    if (isImmersive()) { setLayout('auto'); return; }
    writeUi({ imageCollapsed: !effectiveUi().imageCollapsed });
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
      writeUi({ splitRatio: Math.max(0.28, Math.min(0.72, p)) });
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
      writeUi({ splitRatio: 0.5 });
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
    A.renderStoryPrefs();   // UI-3 §7：切换对话整体重绘本对话设置面板（不残留上一个对话的值）
    $('#screen-start').classList.add('hidden');
    $('#screen-shelf').classList.add('hidden');
    $('#screen-game').classList.remove('hidden');
    $('#screen-game').classList.remove('stage-strip', 'text-hidden');
    A.closeMenus();
    S.immersiveTextHidden = false;
    $('#hud-title').textContent = S.story.title;
    $('#hud-mode').textContent = MODE_LABELS[S.story.mode] || '剧情';
    A.syncKindSwitch();
    S.choicesTrayOpen = false;
    applyLayout();
    renderChat();
    renderStage();
    renderThumbs();
    if (fresh) {
      S.currentChoices = A.choicesFromHead();
      renderChat();
      saveAll();
      // deferOpening：先走试画锚定（P4），锚定结束（锁定/跳过）后再开场
      if (!opts.deferOpening) A.runOpening();
    } else {
      S.currentChoices = A.choicesFromHead();   // §4.3：选项跟着 head 的 assistantMsg 恢复（刷新后不丢）
      renderNarrationToolsAfterLoad();
      saveAll();
      // 空档补开场（例：锚定向导还没走完就刷新了页面）
      if (!(S.story.log || []).length && !(S.story.messages || []).length) A.runOpening();
    }
  }

  function renderNarrationToolsAfterLoad() {
    // 重试控件由 renderChat 渲染；这里只处理输入框可用状态
    $('#btn-send').disabled = false;
  }

  A.reg({ scrollChatBottom, imageSceneById, currentScene, renderChat, closeLightbox, renderStage, watchStageVisibility, renderThumbs, effectiveLayout, renderLayoutHint, isImmersive, applyLayout, toggleStagePanel, enterImmersive, exitImmersive, bindSplitter, enterGame });
})();
