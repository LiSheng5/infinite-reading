/*
 * js/app/library.js —— 原图（Blob）/ 存档点 / 书架 / 导入导出
 * 从 js/app.js 拆出（只搬家，不改行为）。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, Store, MODE_LABELS, DEFAULT_SETUP, toast, irConfirm, openModal, closeModal, clone, fmtTime, saveAll, miniBtn } = A;

  let startMode = 'choice';      // 开始页选中的模式（choice | chat | rp）
  let typeTimer = null;
  let exportTargetId = null;

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
  async function fetchBlob(src) {
    if (!src) return null;
    try {
      const r = await fetch(src);
      if (r.ok) { const b = await r.blob(); if (b && b.size) return b; }
    } catch (_) { /* 继续走 canvas 兜底 */ }
    return await new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = img.naturalWidth || img.width;
          cv.height = img.naturalHeight || img.height;
          if (!cv.width || !cv.height) { resolve(null); return; }
          cv.getContext('2d').drawImage(img, 0, 0);
          cv.toBlob(b => resolve(b), 'image/png');
        } catch (_) { resolve(null); }   // 画布被跨域图片污染：拿不到像素，只能放弃原图
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  // 存原图；返回 imageId（没有 IndexedDB / 存不下时返回 undefined，退回只留缩略图）
  async function storeOriginal(sceneId, src, meta) {
    try {
      const info = Store.storageInfo();
      if (!info || !info.available || !info.backend || info.backend !== 'indexeddb') return undefined;
      const blob = await fetchBlob(src);
      if (!blob || !blob.size) return undefined;
      const imageId = 'img:' + sceneId;
      return Store.putImage(imageId, blob, meta) ? imageId : undefined;
    } catch (e) {
      console.warn('原图保存失败（只保留缩略图）：', e);
      return undefined;
    }
  }

  function blobToDataURL(blob) {
    return new Promise(resolve => {
      try {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => resolve('');
        fr.readAsDataURL(blob);
      } catch (_) { resolve(''); }
    });
  }

  // 一张图该显示什么：优先原图（IndexedDB 里的 Blob → objectURL），没有就退回缩略图
  function sceneSrc(sc, entry) {
    const id = (sc && sc.imageId) || (entry && entry.imageId);
    const url = id ? Store.imageURL(id) : null;
    return url || (sc && (sc.src || sc.thumb)) || (entry && (entry.thumb || entry.src)) || '';
  }

  /* ---------- 生图参考图（v0.12.1，subject_reference 的输入） ----------
   * 把「上一张图」变成能发给接口的 dataURL：优先 IndexedDB 里的原图，缩到长边 ≤ maxEdge 的
   * JPEG（体积可控、人物特征还够清楚）；没有原图（IndexedDB 不可用 / 只存了缩略图）就退回缩略图。
   * 拿不到图返回 ''，调用方按纯文生图继续跑，不拦这次作画。 */
  function blobToScaledJpeg(blob, maxEdge) {
    return new Promise(resolve => {
      let objUrl = '';
      const img = new Image();
      const done = v => {
        if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (_) {} }
        resolve(v);
      };
      img.onload = () => {
        try {
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          if (!w || !h) { done(''); return; }
          const scale = Math.max(w, h) > maxEdge ? maxEdge / Math.max(w, h) : 1;
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(w * scale));
          cv.height = Math.max(1, Math.round(h * scale));
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          done(cv.toDataURL('image/jpeg', 0.85) || '');
        } catch (_) { done(''); }
      };
      img.onerror = () => done('');
      try { objUrl = URL.createObjectURL(blob); img.src = objUrl; }
      catch (_) { done(''); }
    });
  }

  async function refImageDataUrl(maxEdge) {
    const limit = +maxEdge > 0 ? +maxEdge : 1024;
    if (!S.story) return '';
    const log = S.story.log || [];
    let last = null;
    for (let i = log.length - 1; i >= 0 && !last; i--) {
      if (log[i] && log[i].type === 'image') last = log[i];
    }
    if (!last) {
      const sc = (S.story.scenes || []).filter(s => s && s.kind !== 'video');
      last = sc[sc.length - 1] || null;
    }
    if (!last) return '';
    const imageId = last.imageId || '';
    if (imageId) {
      try {
        const blob = await Store.getImage(imageId);
        if (blob && blob.size) {
          const jpg = await blobToScaledJpeg(blob, limit);
          if (jpg) return jpg;
        }
      } catch (_) { /* 退回缩略图 */ }
    }
    return String(last.thumb || last.src || '');
  }

  // 打字机（流式失败 / 非流式时的兜底观感）；返回 Promise
  function typewrite(el, text) {
    return new Promise(resolve => {
      clearInterval(typeTimer);
      el.textContent = '';
      const step = Math.max(1, Math.round(text.length / 110));
      let i = 0;
      const finish = () => { clearInterval(typeTimer); typeTimer = null; el.textContent = text; resolve(); };
      typeTimer = setInterval(() => {
        i += step;
        el.textContent = text.slice(0, i);
        A.scrollChatBottom();
        if (i >= text.length) finish();
      }, 22);
      el.onclick = finish;
    });
  }

  /* ================= 存档点（T-P2-1 / §7） ================= */

  function snapshotStory(s, name) {
    return {
      id: IR.genId('sp'),
      name: name || ('存档点 ' + new Date().toLocaleString('zh-CN')),
      ts: Date.now(),
      turn: s.turn || 0,
      mode: s.mode || 'choice',
      log: clone((s.log || []).slice(-IR.Tree.LOG_WINDOW)),
      messages: clone((s.messages || []).slice(-40)),
      summaries: clone(s.summaries || []),
      world: clone(s.world || {}),
      styleCard: clone(s.styleCard || null),
      rollingStyle: clone(s.rollingStyle || {}),
      characterCard: clone(s.characterCard || null),
      userProfile: clone(s.userProfile || []),
      painterThread: clone((s.painterThread || []).slice(-20)),
      // 剥掉全尺寸 src、只留缩略图（与 serializeStory 同口径），否则 5 个存档点 ×8 张原图极易撑爆 localStorage
      scenes: clone((s.scenes || []).slice(-8).map(sc => Object.assign({}, sc, { src: undefined }))),
      lastBg: s.lastBg || null,
      lastSceneSummary: s.lastSceneSummary || '',
      // 分支树（§4.6）：nodeId 用于「回到这个存档点 = 回到树上这个节点」；
      // tree 整棵随存档点备份——老存档点回档会把树重置成直线，得先能整棵接回来
      nodeId: (s.tree && s.tree.head) || null,
      tree: clone(s.tree || null),
    };
  }

  function restoreSnapshot(s, sp) {
    s.turn = sp.turn || 0;
    s.mode = sp.mode || s.mode;
    s.log = clone(sp.log || []);
    s.messages = clone(sp.messages || []);
    s.summaries = clone(sp.summaries || []);
    s.world = clone(sp.world || Store.defaultWorld());
    s.styleCard = clone(sp.styleCard || null);
    s.rollingStyle = clone(sp.rollingStyle || Store.defaultRollingStyle());
    s.characterCard = clone(sp.characterCard || null);
    s.userProfile = clone(sp.userProfile || []);
    s.painterThread = clone(sp.painterThread || []);
    s.scenes = clone(sp.scenes || []);
    s.lastBg = sp.lastBg || null;
    s.lastSceneSummary = sp.lastSceneSummary || '';
  }

  function addSavepoint(name) {
    if (!S.story) return null;
    S.story.savepoints = S.story.savepoints || [];
    const sp = snapshotStory(S.story, name);
    S.story.savepoints.push(sp);
    if (S.story.savepoints.length > IR.Tree.SAVEPOINT_KEEP) S.story.savepoints = S.story.savepoints.slice(-IR.Tree.SAVEPOINT_KEEP);
    saveAll();
    renderSavepoints();
    return sp;
  }

  async function restoreSavepoint(id) {
    if (!S.story) return;
    if (S.busy) { toast('正在生成中，等这一步结束再回档'); return; }
    const sp = (S.story.savepoints || []).find(x => x.id === id);
    if (!sp) return;
    // §4.6 分流：存档点带着 nodeId 且节点还在（当前树或存档点自带的树里）→ 回到树上那个节点；
    // 老存档点（迁移前）没有节点可回 → 旧的整档快照，树随之重置成一条直线
    const hasNode = !!(sp.nodeId && ((S.story.tree && S.story.tree.nodes[sp.nodeId]) || (sp.tree && sp.tree.nodes && sp.tree.nodes[sp.nodeId])));
    const msg = '回到「' + sp.name + '」？当前进度会先自动存为一个新存档点。'
      + (hasNode ? '' : '\n\n这个存档点早于分支功能，回档会重置当前分支树为一条直线（回档前的分支树已整体备份进新存档点）。');
    if (!await irConfirm(msg, { title: '回档', okText: '回档' })) return;
    addSavepoint('回档前 · ' + fmtTime(Date.now()));
    if (hasNode) {
      if (!(S.story.tree && S.story.tree.nodes[sp.nodeId])) S.story.tree = clone(sp.tree);   // 树被重置过：从存档点把整棵接回来
      IR.Tree.switchTo(S.story, sp.nodeId);   // 含 project：head 落到该节点，世界卡 / 窗口跟着走
    } else {
      restoreSnapshot(S.story, sp);
      S.story.tree = null;                    // 没有分支可回：整棵树重置为线性链（§4.6）
      IR.Tree.ensure(S.story);
      IR.Tree.project(S.story);
    }
    S.currentChoices = A.choicesFromHead();
    saveAll();
    A.renderChat(); A.renderStage(); A.renderThumbs(); A.renderStoryPanels(); renderSavepoints();
    toast('已回到：' + sp.name);
  }

  function renderSavepoints() {
    const has = !!S.story;
    $('#sp-empty').classList.toggle('hidden', has);
    $('#sp-panel').classList.toggle('hidden', !has);
    if (!has) return;
    const list = $('#sp-list');
    list.innerHTML = '';
    const sps = (S.story.savepoints || []).slice().reverse();
    if (!sps.length) {
      const d = document.createElement('div');
      d.className = 'mono-line';
      d.textContent = '（还没有存档点；右上角「存档」或这里都可以打一个）';
      list.appendChild(d);
      return;
    }
    for (const sp of sps) {
      const row = document.createElement('div');
      row.className = 'mono-row';
      const txt = document.createElement('div');
      txt.className = 'mono-line';
      txt.textContent = sp.name + ' · 第 ' + (sp.turn || 0) + ' 回合 · ' + fmtTime(sp.ts);
      const btn = document.createElement('button');
      btn.className = 'mini-btn';
      btn.textContent = '回到';
      btn.onclick = () => restoreSavepoint(sp.id);
      row.appendChild(txt); row.appendChild(btn);
      list.appendChild(row);
    }
  }

  /* ================= 书架（T-P2-1 / §7） ================= */

  function showShelf() {
    if (S.busy) { toast('正在生成中，等这一步结束再离开'); return; }   // 回合进行中切走会让异步续体写空/串档
    if (S.story) saveAll();       // 退出即自动存档
    S.story = null;
    S.busy = false;
    S.live = null;
    A.closeMenus();
    A.closeStoryPrefs();   // UI-3：离开对话就收起本对话设置面板（不残留上一个对话的值）
    $('#screen-start').classList.add('hidden');
    $('#screen-game').classList.add('hidden');
    $('#screen-shelf').classList.remove('hidden');
    A.renderShelf();   // UI-2：会话列表（js/app/shelf.js）
  }

  // 开始页（应用入口）：三个模式先看介绍、点一张选中，再按「开始」
  function showStart() {
    if (S.busy) { toast('正在生成中，等这一步结束再离开'); return; }   // 同 showShelf：防异步续体写空/串档
    if (S.story) saveAll();
    S.story = null;
    S.busy = false;
    S.live = null;
    A.closeMenus();
    A.closeWorkbench();
    A.closeStoryPrefs();   // UI-3
    $('#screen-game').classList.add('hidden');
    $('#screen-shelf').classList.add('hidden');
    $('#screen-start').classList.remove('hidden');
    $('#btn-continue').classList.toggle('hidden', Store.listStories().length === 0);
    if (!$('#setup-premise').value.trim()) $('#setup-premise').value = DEFAULT_SETUP;
  }

  // 阅读页「＋ 新故事」：先把当前这一幕落盘，再开「新故事」选模式弹窗（三个模式共用同一入口）
  function newStoryFromGame() {
    if (S.busy) { toast('正在生成中，等这一步结束再离开'); return; }
    if (S.story) saveAll();             // 切走不丢：当前档先存下（仍留在书架里，可随时回去）
    openModal('modal-new');
  }

  // 开始页三模式（§4.8）：三张卡即三个开局入口，点哪张就按哪种模式开局（没有单独的开始按钮）
  //   剧情 = 设定框快通道；对话 = 直接开聊；扮演 = 先建角色卡
  function startFromStart(mode) {
    startMode = (mode === 'chat' || mode === 'rp') ? mode : 'choice';
    if (startMode === 'choice') startFromPremise();
    else A.createStoryImmediate(startMode);
  }

  // 剧情模式：用设定框里的文字直接开一局（v0.1 的快通道）
  function startFromPremise() {
    const premise = $('#setup-premise').value.trim() || DEFAULT_SETUP;
    const title = (premise.split('\n')[0] || '').replace(/^标题[:：]\s*/, '').slice(0, 40) || '未命名故事';
    S.story = Store.newStory({ premise, title, mode: 'choice' });
    Store.seedWorldFromPremise(S.story, premise);   // 设定里的「世界 / 时间 / 伏笔」直接进记忆卡，不空白
    A.enterGame(true, { deferOpening: true });
    A.openAnchor({ onDone: A.renderChat });   // §5：试画引导可跳过；关闭后回到「开始第一幕」按钮
  }

  /* 离线演示（?demo=1）：内置剧本 + 本地占位图，直接开局。
     不联网、不需要 Key、配置不写盘；画风锚定 / 画师工作台 / 出图 / 存档等链路与真实模式完全一致。 */
  function startDemo() {
    IR.Demo.reset();
    $('#setup-premise').value = IR.Demo.premise;      // 首页设定框里留一份，退出演示后能看到这个开局长什么样
    $('#demo-chip').classList.remove('hidden');
    S.story = Store.newStory({ title: IR.Demo.title + '（演示）', premise: IR.Demo.premise, mode: 'choice' });
    A.enterGame(true, { deferOpening: true });          // 演示跳过试画锚定，直接开演
    toast('离线演示：' + IR.Demo.turnCount + ' 回合内置剧本 + 本地占位图，未连接任何模型。想接真模型就去掉地址栏的 ?demo=1。', false, true);
    A.runOpening();
  }

  // 「↶ 继续上次」
  function continueLast() {
    const s = Store.loadCurrent() || (Store.listStories()[0] && Store.loadStory(Store.listStories()[0].id));
    if (!s) { toast('没有找到存档'); showShelf(); return; }
    if (S.story && S.story.id !== s.id) A.stopVideoWaiting();   // §7：切故事停本地轮询
    S.story = s;
    S.story.savepoints = S.story.savepoints || [];
    S.story.ui = Object.assign(Store.defaultUi(), S.story.ui || {});
    Store.setCurrentId(S.story.id);
    A.enterGame(false);
    A.resumePendingVideos();   // §7：刷新 / 重开后续上生视频轮询
  }

  /* 书架渲染 / 打开对话（openStory）/ 行菜单已迁至 js/app/shelf.js（UI-2）：
     renderShelf 只读索引；openStory(id, opts) 支持滚动到命中消息（§3.7）。 */

  /* ================= 导入 / 导出（T-P2-4 / §4.11） ================= */

  function openExport(id) {
    exportTargetId = id;
    const st = Store.loadStory(id);
    $('#export-story-name').textContent = '《' + ((st && st.title) || '未命名故事') + '》—— 导出为 .irstory.json 文件，别人导入即可阅读。';
    openModal('modal-export');
  }

  async function buildExportPack(st, kind, withSrc) {
    const images = [];
    for (const s of (st.scenes || []).slice(-IR.Tree.SCENE_WINDOW)) {
      // §0/§10：视频不随备份导出（体积）——只留封面，条目标 videoOmitted:true，导入后显示「视频未随备份导出」
      if (s.kind === 'video') {
        images.push({
          id: s.id, alt: s.alt || '', prompt: s.prompt || '', promptRaw: s.promptRaw || '',
          thumb: s.thumb || null, kind: 'video', videoOmitted: true,
          mode: s.mode || undefined, duration: s.duration || undefined, ts: s.ts,
        });
        continue;
      }
      // 带上 scene id：别人导入时才能把「图片」和聊天记录里的图片气泡对上号
      const im = { id: s.id, alt: s.alt || '', prompt: s.prompt || '', promptRaw: s.promptRaw || '', thumb: s.thumb || null };
      if (s.aspect) im.aspect = s.aspect;
      if (s.width) im.width = s.width;
      if (s.height) im.height = s.height;
      // 附带原图：从 IndexedDB 取回 Blob 再转 base64。
      // 只在用户明确勾选时做，且文件会明显变大（原图本身就不小，base64 还要再涨约三分之一）。
      if (withSrc && s.imageId) {
        const blob = await Store.getImage(s.imageId);
        if (blob) {
          const url = await blobToDataURL(blob);
          if (url) im.src = url;
        }
      }
      images.push(im);
    }
    // UI-3 §3.4：组装走 Store.buildStoryPack——整包剥凭证（apiKey / baseUrl 等），
    // prefs 只带 profileId（不透明 id）+ profileLabel（仅显示）；settings 永不进导出包。
    return Store.buildStoryPack(st, kind, images, S.settings);
  }

  function downloadBlob(filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function download(filename, text) {
    downloadBlob(filename, new Blob([text], { type: 'application/json' }));
  }

  async function doExport() {
    const st = Store.loadStory(exportTargetId);
    if (!st) { toast('故事不存在', true); return; }
    const kindEl = document.querySelector('input[name="export-kind"]:checked');
    const kind = kindEl ? kindEl.value : 'full';
    const withSrc = $('#export-src').checked;
    const hasSrc = (st.scenes || []).some(s => s.imageId || s.src);
    const btn = $('#btn-do-export');
    const oldText = btn ? btn.textContent : '';
    if (withSrc && btn) { btn.disabled = true; btn.textContent = '打包原图中…'; }
    let pack;
    try {
      pack = await buildExportPack(st, kind, withSrc);
    } catch (e) {
      toast('打包失败：' + ((e && e.message) ? e.message : e), true, true);
      return;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
    const safeTitle = String(st.title || 'story').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    download(safeTitle + '.irstory.json', JSON.stringify(pack, null, 1));
    A.markBackedUp();                                   // 导出单个故事也算一次备份
    closeModal('modal-export');
    toast(withSrc && !hasSrc ? '已导出（原图已不在本地，仅带缩略图 + 提示词）' : '已导出：' + safeTitle + '.irstory.json', false, true);
  }

  A.reg({ storeOriginal, sceneSrc, refImageDataUrl, typewrite, addSavepoint, renderSavepoints, showShelf, showStart, newStoryFromGame, startFromStart, startDemo, continueLast, openExport, downloadBlob, download, doExport });
})();
