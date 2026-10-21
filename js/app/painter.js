/*
 * js/app/painter.js —— 画师子代理 + 生图 / 画师工作台
 * 从 js/app.js 拆出（只搬家，不改行为）。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, Store, STYLE_PRESETS, IMAGE_ASPECTS, toast, openModal, closeModal, netErrHint, offlineBlocked, fmtTime, saveAll, resolveSub, imageCfg } = A;


  /* ================= 画师子代理 + 生图（§3.2/§4.3，T-P3-1） =================
   * v0.5.1（§3.B）：出图全走同一条串行队列 IR.PaintQueue，画师构思也在队列里跑
   *（不与队列外的构思并发）；request_image 已异步化、不卡回合（§3.A）。
   * P-1（v0.11.0）：时机出图已删除——剧情模式只剩手动 🎨 / 工作台重画，外加 chat / rp 的工具直出。 */

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
    A.renderChat();
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

  // request_image 入队（§3.A）：立刻返回、不等图；任务带回合锚点，完成后落回「它所属的回合」。
  // P-1（§3.3）：只剩 chat / rp 的直出分支（模型自己写提示词，不经画师）——剧情模式的工具已停用，
  // 原 direct === false 的画师分支已删除；剧情的手动作画走 enqueueImage（画师构思仍在 runPaintTask 一处）。
  function submitToolPaint(args) {
    const storyId = S.story && S.story.id;
    const a = args || {};
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
        directPrompt: rawPrompt || (S.story && S.story.lastSceneSummary) || 'atmospheric scene',
        promptRaw: rawPrompt || undefined,
        sceneRef: sceneRef,
        altHint: String(a.alt || a.subject || '').trim(),
      }),
    });
  }

  // 作画任务体（§3.B）：合并原 runToolPaint / generateScene 的重复流程——
  //   构思（directPrompt 缺省时走画师；画师不可用 / 失败用场景描述兜底）→ 组 prompt → runPaint 出图写回
  // 「构思 → 出图」集中在这里一处（P-1 §2 非目标的预留点：以后要分叉工具 / 视频只改这里）。
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
      // 直出（§3.E）：提示词是模型写的，不请画师（chat / rp 的工具出图 / 工作台按提示词重画）
      promptRaw = opts.promptRaw || opts.directPrompt;
      prompt = composePrompt(opts.directPrompt, styleText);
      alt = opts.altHint || opts.sceneRef || '';
      setGenPill('AI 作画中…');
    } else {
      // —— 画师子代理：把剧情写成绘画提示词 ——（手动 🎨 / 时机出图已删）
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

  // 手动出图（P-1 §3.4：剧情 / 扮演 / 智能体唯一的自动画入口只剩用户点 🎨）：
  // 节点在任务创建时记下（§4.4），同一条队列串行；画师构思 → 出图仍集中在 runPaintTask
  function enqueueImage(sceneSummary, nodeId, key) {
    const storyId = S.story && S.story.id;   // 记住「为谁画的」：等图期间换档也不写错故事
    const nid = nodeId || A.treeHeadNodeId();   // 与 nodeId 一样在任务创建时记下（§4.4）
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
      || A.nodeIdOwningEntry(opts.supersedesEntry)
      || (opts.supersedesScene ? A.nodeIdOwningScene(opts.supersedesScene.id) : null)
      || (supersedes ? A.treeHeadNodeId() : null);
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
      A.refreshRollingStyleByModel(scene);   // 真实模式：书记员顺手刷新；失败保留本地结果
    }
    saveAll();
    A.renderChat(); A.renderStage(); A.renderThumbs();
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
    const scene = sceneId ? A.imageSceneById(sceneId) : A.currentScene();
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
    const scene = A.imageSceneById(S.pw.sceneId);
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
    const scene = A.imageSceneById(S.pw.sceneId);
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
    const scene = A.imageSceneById(S.pw.sceneId);
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

  A.reg({ paintQ, imageBrief, submitToolPaint, enqueueImage, styleSuffixText, composePrompt, openWorkbench, closeWorkbench, pwShowWh, painterThreadSend, redrawFromWorkbench, forceRedrawByCard });
})();
