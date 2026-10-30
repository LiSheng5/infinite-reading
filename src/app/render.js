/*
 * src/app/render.js —— 聊天记录窗口 / 画面面板 / 布局状态 / 进入离开故事（含灯箱与内联图气泡）
 * 从 src/app/main.js 拆出（只搬家，不改行为）。
 */
import { Prefs } from '../core/prefs.ts';
import { Tree } from '../core/tree.ts';
import { Nav } from '../ui/navigation.js';
import { setChat, setThumbs } from '../screens/read/read.svelte.js';
import { A, saveAll, toast } from './core.js';


  const S = A.state;
  const { $, Store, MODE_LABELS, KIND_LABELS, motionLevel, fmtTime, persistSettings } = A;

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

  // 思考链的折叠标题：图标 + 文案（DOM 构造，不拼 innerHTML）
  function reasonToggleBtn(labelText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reason-toggle';
    const caret = document.createElement('span');
    caret.className = 'reason-caret';
    caret.appendChild(A.iconEl('chev'));
    const label = document.createElement('span');
    label.className = 'reason-label';
    label.textContent = labelText;
    btn.replaceChildren(caret, label);
    return btn;
  }

  // 思考窗 interior（按钮 + 面板）：旧整节点拼装与 Svelte 空壳（阶段 4 屏 4 的 fillLiveDom）共用
  function reasonLiveInto(wrap, text) {
    const btn = reasonToggleBtn('思考中…');
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
    wrap.replaceChildren(btn, panel);   // 幂等：空壳跨 renderChat 常驻，重复回填不叠加
  }

  // 阶段 4 屏 4：流式 / 打字机临时旁白挂进组件渲染的两个空壳（与旧 DOM 同位置同结构）。
  // 空壳的显隐由视图模型的 live / liveReason 决定；interior 与 class 状态照旧命令式回填，
  // S.liveEl / S.liveReasonEl 的同步语义与流式 span 追踪零改动（round.js / turn.js 不用改）。
  // 幂等：{#key} 整体重建已删，同一 live 窗口内空壳跨 renderChat 常驻——只回填空壳，
  // 在途的 span.delta / 思考窗 interior 由 appendLiveDelta / updateLiveReasoning 原地维护，
  // 不在这里覆盖（回合内的工具留痕 renderChat、设置改动 renderChat 不再打断流式）。
  function fillLiveDom() {
    if (!S.live) return;
    const shell = $('#chat-scroll').querySelector('.reason-live');
    if (shell) {
      S.liveReasonEl = shell;
      if (!shell.firstChild) reasonLiveInto(shell, S.live.reasoning);
      if (S.liveReasonOpen) shell.classList.add('open');
      if (S.liveReasonCollapsed) shell.classList.add('collapsed');
      const p = shell.querySelector('.reason-panel');
      if (p) p.scrollTop = p.scrollHeight;
    }
    const bubble = $('#chat-scroll').querySelector('.bubble-live');
    if (bubble && !bubble.firstChild) {
      if (S.live.text) {
        bubble.textContent = S.live.text;
      } else {
        const pill = document.createElement('span');
        pill.className = 'gen-pill';
        pill.textContent = '生成中…';
        bubble.replaceChildren(pill);
      }
    }
  }

  function renderChat() {
    S.liveEl = null;   // 流式空壳随 live / liveReason 标志重建，旧引用可能失效（否则工具回合后的第二次流式会写进已脱离的节点）
    S.liveReasonEl = null;
    A.resetLiveDelta();   // 同理：span 追踪只对当前气泡有效
    const box = $('#chat-scroll');
    // 聊天流 / 开场引导 / 选项 DOM 由阅读页组件管：这里只推视图模型（src/app/readmodel.js 同口径构建）。
    // 流式临时旁白的两个空壳（reason-live / bubble-live）由组件渲染，interior 仍走旧 DOM 拼装
    //（fillLiveDom：span.delta 逐段淡入与 typewrite 都是命令式动画代码，零改动）。
    if (!box) return;
    A.updateHistoryBar();   // 历史位置提示条跟着 head 走（head 有孩子就亮）
    setChat(A.readChatModel());
    if (!S.story) return;
    fillLiveDom();
    A.renderFeatureBar();
    scrollChatBottom();
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

  /* ================= 渲染：画面面板 ================= */

  // 舞台当前图：换画交叉淡入、缩略图 → 原图 blur-up、rich 档 Ken Burns
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

  // 视频场景：video 元素接管舞台；文件未到先显示封面；动效 off 不自动播放、只显示封面
  function setStageVideo(sc) {
    const v = $('#stage-video');
    if (!v) return;
    if (!sc) {
      try { v.pause(); } catch (_) {}
      v.classList.add('hidden');
      v.removeAttribute('src');
      delete v.dataset.src;
      return;
    }
    const src = A.videoSrc(sc);
    const cover = sc.thumb || sc.poster || '';
    $('#stage-img').classList.add('hidden');
    $('#stage-empty').classList.add('hidden');
    const cap = $('#stage-caption');
    if (cap) cap.textContent = sc.alt || '';
    if (!src) {
      v.classList.add('hidden');
      v.removeAttribute('src');
      delete v.dataset.src;
      if (cover) setStageImage(sc, cover);
      return;
    }
    if (cover && v.getAttribute('poster') !== cover) v.setAttribute('poster', cover);
    if (v.dataset.src !== src) {
      v.dataset.src = src;
      v.src = src;
      try {   // 动效 off：只显示封面，等用户点 controls 播放
        if (motionLevel() !== 'off') v.play().catch(() => {});
        else v.pause();
      } catch (_) {}
    }
    v.classList.remove('hidden');
    A.setStageArt(cover || '');
  }

  function renderStage() {
    const img = $('#stage-img');
    if (!img) return;
    if (!S.story) {
      setStageVideo(null);
      setStageImage(null, '');
      return;
    }
    const sc = currentScene();
    if (sc && sc.kind === 'video') {
      setStageVideo(sc);
      return;
    }
    setStageVideo(null);
    setStageImage(sc, A.sceneSrc(sc));
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
    // 缩略图条 DOM 由阅读页组件管：推视图模型（src/app/readmodel.js 同口径），
    // 点击选场景的回调在组件里等价重放（lastBg + saveAll + renderStage + renderThumbs）。
    setThumbs(A.readThumbsModel());
  }

  /* 布局状态段已拆出到 src/app/layout.js（app-structure-test 的 800 行红线；只搬家，不改行为） */

  /* ================= 进入 / 离开故事 ================= */

  function enterGame(fresh, opts) {
    opts = opts || {};
    if (!S.story) return;
    // 过渡的 update 回调要下一帧才跑（阶段 5）：先把故事抓在闭包里，
    // 免得等待期间被别的入口（返回首页 / 换故事）把 S.story 置空。
    const story = S.story;
    // 分支树：树是唯一真源——载入一律先 ensure（旧档建线性链 / 坏树降级）再 project 重建 log / messages 等
    try {
      Tree.ensure(S.story);
      Tree.project(S.story);
    } catch (e) { console.warn('Tree 初始化失败（按存档原样继续）：', e); }
    story.ui = Object.assign(Store.defaultUi(), story.ui || {});
    A.renderStoryPrefs();   // 切换对话整体重绘本对话设置面板（不残留上一个对话的值）
    // 切屏收口到 Nav（阶段 5）：原「三处 classList 写 .hidden」由 showScreen 统一改，
    // 换画 / 聊天 / 布局这些 DOM 变更全部放进 mutate —— 过渡的新快照拿到的就是渲染完的阅读页。
    Nav.showScreen('read', () => {
      $('#screen-game').classList.remove('stage-strip', 'text-hidden');
      A.closeMenus();
      S.immersiveTextHidden = false;
      $('#hud-mode').textContent = MODE_LABELS[story.mode] || '剧情';
      A.syncKindSwitch();
      S.choicesTrayOpen = false;
      A.applyLayout();
      renderChat();
      renderStage();
      renderThumbs();
      if (fresh) {
        S.currentChoices = A.choicesFromHead();
        renderChat();
        saveAll();
        // 进入故事不再自动生成第一幕（省一次调用）；空档由 renderChat 的
        // 「开始第一幕」按钮触发。试画锚定关闭后同样只回到这个按钮。
      } else {
        S.currentChoices = A.choicesFromHead();   // 选项跟着 head 的 assistantMsg 恢复（刷新后不丢）
        renderNarrationToolsAfterLoad();
        saveAll();
        // 空档（例：锚定向导还没走完就刷新了页面）同样交给「开始第一幕」按钮
      }
    });
  }

  function renderNarrationToolsAfterLoad() {
    // 重试控件由 renderChat 渲染；这里只处理输入框可用状态
    $('#btn-send').disabled = false;
  }

  // 布局类导出（effectiveLayout / renderLayoutHint / isImmersive / applyLayout / toggleStagePanel /
  // enterImmersive / exitImmersive / bindSplitter）在 src/app/layout.js 注册（本文件只搬家拆分）
  A.reg({ scrollChatBottom, imageSceneById, currentScene, renderChat, openLightbox, closeLightbox, safeImgSrc, renderStage, watchStageVisibility, renderThumbs, enterGame });

