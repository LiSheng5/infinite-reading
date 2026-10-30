/*
 * src/app/video.js —— 生视频（MiniMax V2）：独立队列 / 轮询 / 恢复 / 降级
 *
 * 与作画队列完全分开：视频动辄 1~3 分钟且整段轮询都在 run() 里，绝不能堵出图。
 *   🎬 入口（舞台小菜单 / 工作台）→ irConfirm 确认付费 → videoQ 串行执行 →
 *   画师构思动态提示词（A.painterVideoPrompt）→ 提交任务（taskId 立刻落盘 pendingVideos）→
 *   每 10 秒轮询 → 成功后下载 mp4 存 IndexedDB（键名 vid:<sceneId>）→
 *   写入 story.scenes / story.log（type='video'）→ 舞台播放。
 *
 * 切换故事 / 刷新：只停止本地等待，pendingVideos 留在原故事档里，回到该故事时用 poll 续上同一个
 * task_id（不重复提交、不丢已花的钱）。下载被 CORS 拦 / 空间不足 → 降级 remoteUrl（限时链接）。
 */
import { PaintQueue } from '../core/paintQueue.ts';
import { VideoProviders, fetchWithTimeout } from '../core/providers.ts';
import { Storage } from '../core/storage.ts';
import { Tree, genId } from '../core/tree.ts';
import { A, renderChat, saveAll, toast } from './core.js';


  const S = A.state;
  const { $, Store, offlineBlocked, irConfirm, reportBackgroundFailure } = A;

  const POLL_MS = 10000;              // 官方示例轮询间隔（恢复轮询的本地循环同速）
  const POLL_MAX_NETFAIL = 3;         // 轮询连续网络错误上限（单次容忍）
  const RESUME_TOTAL_TIMEOUT_MS = 15 * 60 * 1000;   // 与适配器 VIDEO_TOTAL_TIMEOUT_MS 同值
  /* 整段任务（构思 + 15 分钟轮询 + 下载）的兜底上限。
   * 各段自己的超时才是正常出口；这里只保证「某一段永远不返回」时队列还能前进。 */
  const VIDEO_TASK_TIMEOUT_MS = 25 * 60 * 1000;
  const VIDEO_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;   // mp4 下载（体积大，给 5 分钟）

  // 第二条串行队列：run() 内部就是整段轮询，必须与 paintQ 分开
  const videoQ = PaintQueue.create({
    onChange: function () { renderVideoPill(); },
    timeoutMs: VIDEO_TASK_TIMEOUT_MS,
  });

  let videoPillText = '';             // 构思 / 下载阶段的文案
  let activeWait = null;              // 当前等待 { taskId, storyId, abort() }（胶囊的取消入口）
  let confirmSuppressed = false;      // 「本次打开期间不再提示」
  const waits = new Set();            // 所有本地等待（含恢复轮询）：切故事时统一停

  /* ---------------- 配置 / 判定 ---------------- */

  function videoCfg() {
    return Object.assign({}, S.settings.video || {}, { provider: 'minimax-video' });
  }

  function videoAdapter() {
    return VideoProviders['minimax-video'] || VideoProviders.minimax;
  }

  function isVideoScene(sc) { return !!(sc && sc.kind === 'video'); }

  // 视频地址：IndexedDB 里的 Blob → objectURL；没有就退回降级的在线地址（remoteUrl）
  function videoSrc(sc) {
    if (!sc) return '';
    const u = sc.videoId ? Store.videoURL(sc.videoId) : null;
    return u || sc.remoteUrl || sc.videoUrl || '';
  }

  function videoParams() {
    const adapter = videoAdapter();
    const cfg = videoCfg();
    if (adapter && typeof adapter.params === 'function') return adapter.params(cfg, 't2v');
    return { model: cfg.model || '', duration: 5, resolution: '768P', ratio: '16:9' };
  }

  /* ---------------- 进度胶囊 ---------------- */

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function renderVideoPill() {
    const pill = $('#video-status');
    const btn = $('#btn-stage-video');
    const busy = !!(activeWait || videoQ.size());
    if (btn) {
      btn.classList.toggle('busy', busy);
      btn.title = busy ? '视频生成中…' : '把当前画面做成视频（MiniMax · 会按秒计费）';
    }
    const cancelBtn = $('#btn-video-cancel');
    if (cancelBtn) cancelBtn.classList.toggle('hidden', !activeWait);
    if (!pill) return;
    if (!busy && !videoPillText) { pill.classList.add('hidden'); pill.textContent = ''; return; }
    pill.textContent = videoPillText || (videoQ.size() > 1
      ? '视频排队中（前面还有 ' + (videoQ.size() - 1) + ' 条）'
      : '视频生成中…');
    pill.classList.remove('hidden');
  }

  function setVideoPill(text) {
    videoPillText = String(text || '');
    renderVideoPill();
  }

  function clearVideoPill() {
    videoPillText = '';
    activeWait = null;
    renderVideoPill();
  }

  /* ---------------- 提示词 / 首帧 ---------------- */

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

  // 首帧：优先 IndexedDB 里的原图，退回 dataURL 缩略图（缩放由适配器做）
  async function sourceImageData(scene) {
    if (!scene || isVideoScene(scene)) return '';
    if (scene.imageId) {
      const blob = await Store.getImage(scene.imageId);
      if (blob) return blobToDataURL(blob);
    }
    if (scene.src && /^data:/i.test(scene.src)) return scene.src;
    return '';
  }

  /* ---------------- 封面 ---------------- */

  // t2v：从视频第 0.1 秒抓首帧（Blob URL 同源可抓；remoteUrl 抓不了 → 占位封面）
  function makePoster(objectUrl, fallback) {
    return new Promise(resolve => {
      let video;
      try { video = document.createElement('video'); }
      catch (_) { resolve(fallback || null); return; }
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      let done = false;
      let timer = 0;
      const finish = out => {
        if (done) return;
        done = true;
        if (timer) { clearTimeout(timer); timer = 0; }   // 兜底定时器不清，finish 后 8s 还会再跑一次
        video.onloadeddata = null;
        video.onseeked = null;
        video.onerror = null;                             // 清掉回调：removeAttribute('src') + load() 会再触发 error
        try { video.removeAttribute('src'); video.load(); } catch (_) {}
        resolve(out || fallback || null);
      };
      video.onloadeddata = () => { try { video.currentTime = 0.1; } catch (_) {} };
      video.onseeked = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = video.videoWidth || 640;
          cv.height = video.videoHeight || 360;
          cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
          finish(cv.toDataURL('image/jpeg', 0.72));
        } catch (_) { finish(null); }
      };
      video.onerror = () => finish(null);
      timer = setTimeout(() => finish(null), 8000);   // 兜底：8s 内拿不到帧就放弃（成功路径由 finish 清掉）
      video.src = objectUrl;
    });
  }

  // 抓帧也失败时的兜底封面（画布画的占位：黑底 + ▶）
  function placeholderPoster() {
    try {
      const cv = document.createElement('canvas');
      cv.width = 320; cv.height = 180;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#14161B';
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.beginPath();           // 播放三角：自己画，不依赖字体（部分系统会把 ▶ 渲染成彩色 emoji）
      ctx.moveTo(143, 68); ctx.lineTo(143, 116); ctx.lineTo(187, 92);
      ctx.closePath(); ctx.fill();
      return cv.toDataURL('image/png');
    } catch (_) { return null; }
  }

  /* ---------------- 下载 / 空间 ---------------- */

  /*：下载也要有上限——裸 fetch 挂住同样会把 videoQ 堵死（队列串行）。
   * signal 传进来时（取消 / 切故事）一并中断；超时按「转存失败」降级到在线链接。 */
  async function fetchBlob(url, signal) {
    const res = await fetchWithTimeout(url, { signal: signal || undefined }, VIDEO_DOWNLOAD_TIMEOUT_MS);
    if (!res.ok) throw new Error('下载视频失败：HTTP ' + res.status);
    const blob = await res.blob();
    if (!blob || !blob.size) throw new Error('下载到的视频是空的');
    return blob;
  }

  // 保存前判余量；不足以存下就提示并走降级（remoteUrl）
  async function spaceOk(bytes) {
    try {
      const e = (Storage && typeof Storage.estimate === 'function') ? await Storage.estimate() : null;
      if (e && e.quota && e.usage != null) return (e.quota - e.usage) > bytes + 1024 * 1024;
    } catch (_) { /* 查不到占用统计：按「够」处理，写失败时 commitVideo 还会走降级 */ }
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        if (e && e.quota && e.usage != null) return (e.quota - e.usage) > bytes + 1024 * 1024;
      }
    } catch (_) { /* 浏览器不给余量：按「够」处理（同上，写失败会降级 remoteUrl） */ }
    return true;   // 查不到就当够（IndexedDB 写失败时 commitVideo 还会走降级）
  }

  /* ---------------- pendingVideos ---------------- */

  function addPending(item) {
    if (!S.story) return;
    S.story.pendingVideos = S.story.pendingVideos || [];
    S.story.pendingVideos.push(item);
    saveAll();
  }

  function removePending(taskId) {
    if (!S.story || !taskId) return;
    const list = S.story.pendingVideos || [];
    const i = list.findIndex(x => x && x.taskId === taskId);
    if (i >= 0) { list.splice(i, 1); saveAll(); }
  }

  /* ---------------- 写回故事 ---------------- */

  // 与 runPaint 同口径：节点没了丢弃；已 sealed → pushLate；否则进 log（commit 切片收进节点）
  function pushVideoEntry(nodeId, scene, entry) {
    const tree = S.story.tree;
    const node = (nodeId && tree && tree.nodes) ? tree.nodes[nodeId] : null;
    if (nodeId && !node) return false;
    if (node && node.sealed) {
      Tree.pushLate(S.story, node.id, scene);
      Tree.pushLate(S.story, node.id, entry);
    } else {
      S.story.scenes.push(scene);
      S.story.log.push(entry);
    }
    return true;
  }

  // 失败可见：toast + 往所属节点留一条 {type:'tool', tool:'video'} 留痕
  function videoFailVisible(nodeId, message) {
    toast('出视频失败：' + message, true, true);
    if (!S.story) return;
    const tree = S.story.tree;
    const node = (nodeId && tree && tree.nodes) ? tree.nodes[nodeId] : null;
    if (nodeId && !node) return;
    const entry = { type: 'tool', tool: 'video', summary: '出视频失败：' + message, ts: Date.now() };
    if (node && node.sealed) Tree.pushLate(S.story, node.id, entry);
    else S.story.log.push(entry);
    saveAll();
    renderChat();
  }

  async function commitVideo(o) {
    const id = genId('vd');
    const scene = {
      id: id, kind: 'video',
      videoId: undefined, thumb: null,
      sourceSceneId: o.sourceSceneId || undefined,
      mode: o.mode, prompt: o.prompt, promptRaw: o.promptRaw || o.prompt,
      alt: o.alt || '一段场景视频',
      model: o.model || '', duration: o.duration || 0,
      resolution: o.resolution || '', ratio: o.ratio || '',
      taskId: o.taskId || undefined,
      remoteUrl: o.blob ? undefined : (o.url || undefined),   // 仅降级用
      ts: Date.now(),
    };
    // 封面：图生用源 scene 的 thumb；文生抓视频首帧；抓不了用画布占位
    if (o.blob) {
      const objUrl = URL.createObjectURL(o.blob);
      scene.thumb = (o.mode === 'i2v' && o.sourceThumb) ? o.sourceThumb
        : (await makePoster(objUrl, null)) || placeholderPoster();
      try { URL.revokeObjectURL(objUrl); } catch (_) {}
    } else {
      scene.thumb = (o.mode === 'i2v' && o.sourceThumb) ? o.sourceThumb : placeholderPoster();
    }
    if (o.blob) {
      const vid = 'vid:' + id;
      if (Store.putVideo(vid, o.blob, { model: scene.model, duration: scene.duration, prompt: scene.prompt, taskId: scene.taskId })) {
        scene.videoId = vid;
      } else {
        scene.remoteUrl = o.url;   // IndexedDB 不可用：退回在线地址
      }
    }
    const entry = {
      type: 'video', id: id, alt: scene.alt, thumb: scene.thumb,
      videoId: scene.videoId, remoteUrl: scene.remoteUrl,
      mode: scene.mode, sourceSceneId: scene.sourceSceneId,
      prompt: scene.prompt, promptRaw: scene.promptRaw,
      model: scene.model, duration: scene.duration,
      resolution: scene.resolution, ratio: scene.ratio,
      taskId: scene.taskId, ts: scene.ts,
    };
    if (!pushVideoEntry(o.nodeId, scene, entry)) {
      toast('这段视频所属的回合已不在分支树里，已丢弃');
      if (scene.videoId) Store.releaseVideo(scene.videoId);
      return null;
    }
    // 在当前分支才动舞台 / lastBg
    const tree = S.story.tree;
    const onPath = !o.nodeId || !tree || Tree.pathOf(S.story, tree.head).indexOf(o.nodeId) >= 0;
    if (onPath) {
      S.story.lastBg = scene.id;
      if (scene.videoId) A.setStageArt(scene.thumb || '');
    }
    saveAll();
    renderChat(); A.renderStage(); A.renderThumbs();
    return scene;
  }

  /* ---------------- 提交前确认 ---------------- */

  async function confirmVideoSubmit(params, mode) {
    if (confirmSuppressed) return true;
    const ratio = mode === 'i2v' ? '随首帧（adaptive）' : params.ratio;
    const r = await irConfirm(
      '将提交一个付费任务：\n'
      + '模型：' + (params.model || '（未填）') + '\n'
      + '时长：' + params.duration + ' 秒 · 分辨率：' + params.resolution + ' · 比例：' + ratio
      + '\n\n视频按秒计费，提交后云端开始排队；本地取消不保证能取消云端计费。',
      { title: '提交生视频任务', okText: '提交', checkbox: '本次打开期间不再提示' }
    );
    if (!r) return false;
    if (typeof r === 'object' && r.checked) confirmSuppressed = true;
    return true;
  }

  /* ---------------- 主流程 ---------------- */

  // 整段任务：构思 →（确认在 enqueueVideo 做）→ 提交 + 轮询 → 下载 / 降级 → 写回
  // opts: { storyId, nodeId, mode:'i2v'|'t2v', sourceSceneId?, directPrompt?, altHint?, resume? }
  async function runVideoTask(opts) {
    if (!S.story) return null;
    if (opts.storyId && S.story.id !== opts.storyId) { toast('已切换故事，本次视频任务不再等待'); return null; }
    if (offlineBlocked('这次出视频')) return null;
    const cfg = videoCfg();
    const adapter = videoAdapter();
    const mode = opts.mode === 'i2v' ? 'i2v' : 't2v';

    // —— 构思：恢复轮询 / 直出提示词不请画师 ——
    let composed;
    if (opts.resume) {
      composed = {
        prompt: opts.resume.prompt, promptRaw: opts.resume.promptRaw || opts.resume.prompt,
        alt: opts.resume.alt || String(opts.resume.prompt || '').slice(0, 40),
        params: opts.resume.params || null,
      };
    } else if (opts.directPrompt) {
      composed = {
        prompt: mode === 't2v' ? A.composePrompt(opts.directPrompt, A.styleSuffixText()) : opts.directPrompt,
        promptRaw: opts.directPrompt,
        alt: opts.altHint || '',
        params: null,
      };
    } else {
      setVideoPill('视频构思中…');
      const src = opts.sourceSceneId ? A.imageSceneById(opts.sourceSceneId) : null;
      composed = await A.painterVideoPrompt({
        videoKind: mode,
        sceneRef: (src && (src.alt || src.promptRaw)) || '',
        imageAlt: (src && src.alt) || '',
        imagePrompt: (src && src.promptRaw) || '',
        altHint: opts.altHint || '',
      });
      composed.params = null;
    }

    // —— 首帧（i2v）——
    let image = '';
    let sourceThumb = null;
    if (mode === 'i2v') {
      const src = opts.sourceSceneId ? A.imageSceneById(opts.sourceSceneId) : A.currentScene();
      image = await sourceImageData(src);
      if (!image) { videoFailVisible(opts.nodeId, '图生视频没有拿到首帧原图（先作画一张，或改用文生视频）'); return null; }
      sourceThumb = (src && (src.thumb || (src.src && /^data:/.test(src.src) ? src.src : null))) || null;
    }

    const storyId = opts.storyId || (S.story && S.story.id);
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    // 队列的取消 / 超时信号接进本地 ctrl：一次 abort 同时停掉生成、轮询与下载
    if (ctrl && opts.signal) {
      if (opts.signal.aborted) { try { ctrl.abort(); } catch (_) {} }
      else if (typeof opts.signal.addEventListener === 'function') {
        opts.signal.addEventListener('abort', () => { try { ctrl.abort(); } catch (_) {} }, { once: true });
      }
    }
    const wait = {
      taskId: (opts.resume && opts.resume.taskId) || '',
      storyId: storyId,
      key: opts.queueKey || '',        // 取消时连同队列里的这条任务一起收尾
      abort() { if (ctrl) { try { ctrl.abort(); } catch (_) {} } },
    };
    waits.add(wait);
    activeWait = wait;
    const started = Date.now();
    let statusWord = '排队';
    const tick = setInterval(() => {
      if (!activeWait) return;
      setVideoPill('视频生成中 · ' + statusWord + ' · 已等 ' + fmtElapsed(Date.now() - started));
    }, 1000);
    setVideoPill('视频生成中 · ' + statusWord + ' · 已等 0:00');

    const onStatus = (s) => {
      statusWord = (s === 'queued') ? '排队' : '运行';
      if (S.story && storyId && S.story.id !== storyId) wait.abort();   // 切故事：停本地轮询
    };

    let result;
    try {
      if (opts.resume) {
        // 恢复轮询：用 poll 续上同一个 task_id，不重复提交
        result = await pollUntilDone(cfg, adapter, opts.resume.taskId, { onStatus: onStatus, signal: ctrl && ctrl.signal });
      } else {
        result = await adapter.generate(cfg, { prompt: composed.prompt, image: image, mode: mode }, {
          onTaskId(id) {
            wait.taskId = id;
            // 提交成功立刻落盘；完成 / 失败 / 取消后移除
            addPending({
              taskId: id, mode: mode, prompt: composed.prompt,
              sourceSceneId: opts.sourceSceneId || null, nodeId: opts.nodeId || null,
              createdAt: Date.now(),
              promptRaw: composed.promptRaw, alt: composed.alt,
            });
          },
          onStatus: onStatus,
          signal: ctrl && ctrl.signal,
        });
      }
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      if (e && e.name === 'AbortError') {
        // 本地取消 / 切故事：不写失败留痕（取消提示由取消入口负责）
        return null;
      }
      if (opts.storyId && (!S.story || S.story.id !== opts.storyId)) return null;
      removePending((opts.resume && opts.resume.taskId) || wait.taskId);
      videoFailVisible(opts.nodeId, msg);
      return null;
    } finally {
      clearInterval(tick);
      waits.delete(wait);
      if (activeWait === wait) clearVideoPill();
      else renderVideoPill();
    }

    if (!S.story || (storyId && S.story.id !== storyId)) return null;   // 等待期间换了故事：不写
    setVideoPill('视频下载中…');
    const taskId = (opts.resume && opts.resume.taskId) || wait.taskId;

    // —— 下载转存：被 CORS 拦或空间不足 → 降级 remoteUrl ——
    let blob = null;
    let degraded = false;
    try { blob = await fetchBlob(result.url, ctrl && ctrl.signal); }
    catch (e) {
      // 纯后台降级：转存失败 → 改用在线链接；下面还有一条面向用户的「无法转存」提示
      blob = null;
      reportBackgroundFailure('视频下载', e, { note: '改用在线链接播放' });
    }
    if (blob && !(await spaceOk(blob.size))) {
      toast('本地空间不足，视频存不进浏览器；改用在线链接（限时有效）', true, true);
      blob = null;
      degraded = true;
    }
    if (!blob && !degraded) {
      degraded = true;
      toast('浏览器无法转存（链接限时有效）：可点视频条目里的「新标签页打开」先看', true, true);
    }
    if (S.story && storyId && S.story.id !== storyId) return null;

    removePending(taskId);
    // 留痕用的生效参数：恢复轮询时 result.params 为空 → 用适配器按当前设置算一份
    const eff = composed.params || result.params
      || (adapter && typeof adapter.params === 'function' ? adapter.params(cfg, mode) : null) || {};
    const scene = await commitVideo({
      url: result.url, blob: blob,
      mode: mode, sourceSceneId: opts.sourceSceneId,
      sourceThumb: sourceThumb,
      prompt: composed.prompt, promptRaw: composed.promptRaw, alt: composed.alt,
      model: eff.model || cfg.model || '',
      duration: eff.duration || 0,
      resolution: eff.resolution || '',
      ratio: eff.ratio || '',
      taskId: taskId,
      nodeId: opts.nodeId || null,
    });
    if (scene) {
      toast(blob ? '视频好了：已存到本地，舞台可以直接播' : '视频好了：在线播放（链接限时有效，刷新后可能失效）');
    }
    return scene;
  }

  // 恢复轮询专用：只 poll 不 submit（「回到该故事时恢复轮询，用 poll 取新 URL」）
  async function pollUntilDone(cfg, adapter, taskId, hooks) {
    hooks = hooks || {};
    const started = Date.now();
    let netFails = 0;
    for (;;) {
      if (hooks.signal && hooks.signal.aborted) {
        const e = new Error('已停止本地等待');
        e.name = 'AbortError';
        throw e;
      }
      if (Date.now() - started > RESUME_TOTAL_TIMEOUT_MS) {
        throw new Error('恢复等待超过 15 分钟还没出结果（task_id ' + taskId + '）：可在 MiniMax 控制台查看');
      }
      let q;
      try {
        // 轮询带上取消信号——切故事 / 取消能立刻切断在途请求，不必等一次往返
        q = await adapter.poll(cfg, taskId, hooks.signal);
        netFails = 0;
      } catch (e) {
        if (hooks.signal && hooks.signal.aborted) {
          const a = new Error('已停止本地等待');
          a.name = 'AbortError';
          throw a;
        }
        netFails += 1;
        if (netFails >= POLL_MAX_NETFAIL) throw e;
        await new Promise(r => setTimeout(r, POLL_MS));
        continue;
      }
      if (hooks.onStatus) { try { hooks.onStatus(q.status, q); } catch (_) {} }
      if (q.status === 'succeeded') return { url: q.url, taskId: taskId, params: null };
      if (q.status === 'failed' || q.status === 'cancelled' || q.status === 'expired') {
        throw new Error(q.error || ('任务' + q.status));
      }
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  }

  /* ---------------- 入口（菜单 / 工作台） ---------------- */

  // 去重 key：video:<sceneId>:i2v / video:<headNodeId>:t2v
  function enqueueVideo(opts) {
    opts = opts || {};
    if (!S.story) { toast('先打开一个故事'); return; }
    if (S.story.mode !== 'choice') { toast('视频生成只在剧情模式可用（那边才有画面区）', true, true); return; }
    if (offlineBlocked('这次出视频')) return;

    const cfg = videoCfg();
    if (!String(cfg.baseUrl || '').trim()) { toast('先到「设置 → 生图与画风 → 生视频模型」填接口地址与 Key', true, true); return; }
    if (!String(cfg.apiKey || '').trim()) { toast('生视频还没填 API Key', true, true); return; }
    if (!String(cfg.model || '').trim()) { toast('生视频还没填模型名（如 MiniMax-H3）', true, true); return; }

    const mode = opts.mode === 'i2v' ? 'i2v' : 't2v';
    const storyId = S.story.id;
    const nodeId = A.treeHeadNodeId();
    const sourceSceneId = mode === 'i2v' ? (opts.sourceSceneId || (A.currentScene() && A.currentScene().id)) : null;

    if (mode === 'i2v' && !sourceSceneId) { toast('还没有当前图：先画一张，或用「按剧情文生视频」', true, true); return; }
    if (mode === 't2v' && !String(opts.directPrompt || S.story.lastSceneSummary || S.story.premise || '').trim()) {
      toast('这一幕还没有可用的剧情描述：先写几句剧情', true, true); return;
    }

    const key = mode === 'i2v'
      ? 'video:' + sourceSceneId + ':i2v'
      : 'video:' + (nodeId || 'head') + ':t2v';
    if (videoQ.has(key)) { toast('这段视频已在生成队列里'); return; }

    const params = videoParams();
    confirmVideoSubmit(params, mode).then(ok => {
      if (!ok) return;
      if (videoQ.has(key)) return;
      videoQ.enqueue({
        key: key,
        storyId: storyId,
        nodeId: nodeId,      // 任务创建时记下；视频任务不挂回合锚点
        run: (signal) => runVideoTask({
          storyId: storyId, nodeId: nodeId, mode: mode, sourceSceneId: sourceSceneId,
          directPrompt: opts.directPrompt || '', altHint: opts.altHint || '',
          queueKey: key, signal: signal,
        }),
      });
      renderVideoPill();
    });
  }

  // 舞台菜单：「以当前图生成视频」/「按剧情文生视频」
  function videoFromCurrentImage() {
    const sc = A.currentScene();
    if (!sc || isVideoScene(sc)) { toast('还没有当前图：先画一张，或用「按剧情文生视频」', true, true); return; }
    enqueueVideo({ mode: 'i2v', sourceSceneId: sc.id });
  }

  function videoFromPlot() {
    enqueueVideo({ mode: 't2v' });
  }

  // hud「更多」菜单的入口：有图默认图生，没图文生
  function generateVideo() {
    const sc = A.currentScene();
    if (sc && !isVideoScene(sc) && (sc.imageId || sc.thumb)) videoFromCurrentImage();
    else videoFromPlot();
  }

  /* ---------------- 恢复 / 取消 ---------------- */

  // 回到故事（openStory / 刷新后）恢复轮询：同一个 task_id 续上，不重复提交
  function resumePendingVideos() {
    if (!S.story) return;
    const list = (S.story.pendingVideos || []).slice();
    for (const p of list) {
      if (!p || !p.taskId) continue;
      const key = 'video:resume:' + p.taskId;
      if (videoQ.has(key)) continue;
      const storyId = S.story.id;
      videoQ.enqueue({
        key: key,
        storyId: storyId,
        nodeId: p.nodeId || null,
        run: (signal) => runVideoTask({
          storyId: storyId, nodeId: p.nodeId || null,
          mode: p.mode === 'i2v' ? 'i2v' : 't2v',
          sourceSceneId: p.sourceSceneId || null,
          resume: p, queueKey: key, signal: signal,
        }),
      });
    }
    renderVideoPill();
  }

  // 切换故事：停止本地轮询（pendingVideos 留在原故事档里）
  function stopVideoWaiting() {
    for (const w of Array.from(waits)) { try { w.abort(); } catch (_) {} }
    waits.clear();
    clearVideoPill();
  }

  // 取消：只停止本地等待并移出 pendingVideos；云端任务可能已计费
  // 同时把队列里那条任务收尾（q.cancel）——万一它卡在没有超时的缝里，队列也不必再等
  function cancelActiveVideo() {
    const w = activeWait;
    if (!w) return;
    try { w.abort(); } catch (_) {}
    if (w.key) { try { videoQ.cancel(w.key); } catch (_) {} }
    if (w.taskId) removePending(w.taskId);
    toast('已停止等待。云端任务可能已计费，不保证取消', true, true);
    clearVideoPill();
  }

  /* ---------------- 画师工作台「视频」区 ---------------- */

  function renderWorkbenchVideo() {
    const box = $('#pw-video-list');
    if (!box || !S.pw || !S.story) return;
    box.replaceChildren();
    const list = (S.story.scenes || []).filter(s => s && s.kind === 'video' && s.sourceSceneId === S.pw.sceneId);
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'pw-empty';
      d.textContent = '这张图还没有生成过视频。留空下面的框 = 交画师构思动态提示词；有内容 = 直接用它生成。';
      box.appendChild(d);
      return;
    }
    for (const v of list) {
      const row = document.createElement('div');
      row.className = 'pw-video-row';
      const img = document.createElement('img');
      img.className = 'pw-video-thumb';
      img.src = v.thumb || A.videoSrc(v) || '';
      img.alt = v.alt || '视频封面';
      img.title = '在舞台播放这段视频';
      img.onclick = () => {
        S.story.lastBg = v.id;
        saveAll();
        A.renderStage(); A.renderThumbs();
      };
      row.appendChild(img);
      const cap = document.createElement('span');
      cap.className = 'pw-line';
      cap.appendChild(A.iconEl('play', 'ic-l'));
      cap.appendChild(document.createTextNode((v.alt || '场景视频') + (v.duration ? ' · ' + v.duration + 's' : '')));
      row.appendChild(cap);
      box.appendChild(row);
    }
  }

  // 「🎬 以此图生视频」：#pw-video-prompt 留空 = 交画师构思；有内容 = 直出
  function pwVideoGenerate() {
    if (!S.story || !S.pw) return;
    const promptText = ($('#pw-video-prompt') && $('#pw-video-prompt').value.trim()) || '';
    enqueueVideo({
      mode: 'i2v', sourceSceneId: S.pw.sceneId,
      directPrompt: promptText, altHint: S.pw.alt || '',
    });
  }

  A.reg({
    videoQ, videoSrc, isVideoScene, generateVideo,
    enqueueVideo, videoFromCurrentImage, videoFromPlot,
    resumePendingVideos, stopVideoWaiting, cancelActiveVideo,
    renderWorkbenchVideo, pwVideoGenerate,
  });

