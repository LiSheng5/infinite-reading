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

  const $ = s => document.querySelector(s);
  const Store = IR.Store;
  const Cap = IR.ModelCapabilities;   // 模型能力登记表（T-M-1）

  /* 离线演示模式（?demo=1，见 js/demo.js）：内置剧本 + 本地占位图，不联网、不需要 Key。
     只覆盖内存里的 settings，绝不写回 localStorage —— 真实配置不会被演示污染。 */
  const DEMO = !!(IR.Demo && IR.Demo.enabled());

  /* ================= 默认值与提示词 ================= */

  const STYLE_PRESETS = {
    anime: 'anime style, cel shading, soft glow, detailed background illustration, high quality',
    ink: 'chinese ink wash painting, minimal, elegant negative space, monochrome with subtle color',
    film: 'cinematic still, photorealistic, film grain, dramatic lighting, 35mm',
    pixel: 'pixel art, 16-bit retro game background, limited palette',
    custom: '',
  };

  const MODE_LABELS = { choice: '剧情', chat: '智能体', rp: '扮演' };
  // 做 / 说 / 导演：玩家回合的三种输入语义（旧存档缺 kind 时按「做」处理）
  const KIND_LABELS = { do: '做', say: '说', direct: '导演' };

  const DEFAULT_TOPIC = '雨夜便利店：凌晨三点的第八个货架，与一场没有说出口的告别。';

  // 开始页「故事设定」框的默认文字（v0.1 原样保留）
  const DEFAULT_SETUP = [
    '标题：雨夜便利店',
    '世界：现代都市，深夜的便利店。外面下着大雨，店里灯光昏黄，收音机放着老歌。传闻这家店在凌晨三点会出现「第八个货架」。',
    '你的角色：一位进来避雨的夜班顾客（你可以随时扮演成任何人、做任何事）。',
    'AI 扮演：旁白，以及店里的一切——店员、常客、广播里的声音……',
    '风格：克制的悬疑，日常里藏着一丝奇异。剧情随玩家的行动自由生长，不要拒绝玩家的任何尝试。',
  ].join('\n');
  const CHAT_PREMISE = '对话模式：没有剧本，随性聊天。对话的走向由你们共同决定。';
  // R13 rp：premise 与角色卡绑定（卡常驻系统提示词；开场白由卡写、直接进日志，§4.12）
  function rpPremise(card) {
    const name = (card && card.name) || '角色';
    return '角色扮演：「' + name + '」。以第一人称与玩家对话，保持性格与说话方式一致。';
  }

  // 画师子代理（原 AI2）：把剧情写成绘画提示词。P3 会搬进画师工作台。
  const AI2_SYSTEM = [
    '你是视觉小说的「AI 画师导演」。根据给出的画面参考与最近剧情，决定当前这一幕画什么：可以是纯场景、人物、或两者结合，由你根据叙事需要自行判断。',
    '',
    '只输出一个 JSON 对象（禁止多余文字）：',
    '{"prompt_en":"English image prompt, composition/light/atmosphere/medium, under 40 words","subject":"scene|character|both","alt":"中文一句话，说明这张图画了什么"}',
    '',
    '规则：prompt_en 用英文、具体、有画面感；不要出现任何文字、水印、签名的描述；alt 与 prompt 内容一致。',
  ].join('\n');

  const SCRIBE_SYSTEM = [
    '你是这部视觉小说的「书记员」。读当前世界状态卡与最近剧情，重写整张卡：修正越写越偏的人物 / 时间 / 地点，补上尚未回收的伏笔，去掉已了结的。',
    '只输出一个 JSON 对象（禁止多余文字）：',
    '{"world":{"place":"","time":"","characters":[{"name":"","presence":"","personality":"","speech":""}],"threads":["未回收伏笔"],"relationship":{"stage":"关系阶段","bonds":["关系纽带"],"notes":"关系备注"},"scene":""},"profile":[{"text":"玩家信息","kind":"fact|preference|taboo"}],"diff":["相对上一版的事实变更，一行一条"]}',
    '规则：relationship 记「你们之间发生了什么」（阶段 / 纽带 / 备注），随剧情推进维护，没有变化就原样给出；若给了「[用户画像] 请提取」段落，再顺手判断玩家有没有值得长期记住的信息（fact 事实 / preference 偏好 / taboo 忌讳），每轮最多 3 条、同类只留最新的一条，没有就省略 profile；若写明「未开启」，不要输出 profile。',
    '不要凭空编造剧情里没有的信息；人物 note 字段不确定就省略，客户端不会覆盖用户手改的备注。',
  ].join('\n');

  // 书记员 C-B 双职（§4.10 C-B）：一次调用同时「压缩旧回合 → 场景摘要」+「重写世界状态卡」
  const SCRIBE_COMPRESS_SYSTEM = [
    '你是这部视觉小说的「书记员」。一次任务做三件事：① 把给定的旧回合压成场景摘要；② 校对世界状态卡（修正越写越偏的人物 / 时间 / 地点，补上未回收的伏笔，去掉已了结的）；③ 若给了「[用户画像] 请提取」段落，顺手提取玩家值得长期记住的信息。',
    '只输出一个 JSON 对象（禁止多余文字）：',
    '{"world":{"place":"","time":"","characters":[{"name":"","presence":"","personality":"","speech":""}],"threads":["未回收伏笔"],"relationship":{"stage":"关系阶段","bonds":["关系纽带"],"notes":"关系备注"},"scene":""},"summaries":["【第N幕】地点｜时间｜在场｜发生｜伏笔：埋下/回收…"],"profile":[{"text":"玩家信息","kind":"fact|preference|taboo"}],"diff":["相对上一版的事实变更，一行一条"]}',
    '规则：summaries 按给定幕序逐幕一条，用固定槽位，伏笔显式标记「埋下 / 回收」；world 为整卡重写（未变化也原样给出），relationship 记「你们之间发生了什么」；profile 每轮最多 3 条、同类只留最新的一条，没写「请提取」就不要输出 profile；不要凭空编造剧情里没有的信息；人物 note 不确定就省略。',
  ].join('\n');

  // 滚动风格摘要（§4.10 C-F）：书记员顺手更新（真实模式）
  const SCRIBE_ROLLING_SYSTEM = [
    '你是这部视觉小说的「书记员」。根据刚出的这张图与现有摘要，更新「滚动风格摘要」（视觉设定卡未锚定时的自动画风锚）。',
    '只输出一个 JSON 对象（禁止多余文字）：',
    '{"style":"风格倾向（英文关键词为主，逗号分隔）","scenes":"常见场景（中文短语，最多 3 条，用；分隔）","wardrobe":"人物服饰元素（中文，最多 3 条，用；分隔）"}',
    '规则：保留仍然有效的旧内容，合并新信息并去重；把不可靠的内容丢掉；没把握的字段沿用旧值，不要编造。',
  ].join('\n');

  const DRAFT_SYSTEM = [
    '你是视觉小说的策划。按给定的一句话主题，起草一份开局设定。',
    '只输出一个 JSON 对象（禁止多余文字）：',
    '{"world":"世界观两三句","characters":[{"name":"角色名","personality":"性格","speech":"说话方式"}],"role":"玩家的角色，一两句","styleTone":"画面与文字的基调，一句中文（可含画风关键词）","development":"建议的初始发展，一句"}',
    'rules：角色 2~4 个；全部用中文；不要与主题无关的内容。',
  ].join('\n');

  const IMAGE_ASPECTS = {
    '16:9': [1280, 720],
    '9:16': [720, 1280],
    '1:1': [1024, 1024],
  };

  /* ================= 状态 ================= */

  let settings = Store.loadSettings();
  let story = null;              // 进行中的故事
  let startMode = 'choice';      // 开始页选中的模式（choice | chat | rp）
  let busy = false;              // AI1 回合进行中
  let lastActionWasChoice = false;
  let currentChoices = [];       // 最新一轮的选项（choice 模式：默认收在「💡 灵感」里）
  let choicesTrayOpen = false;   // 选项托盘是否展开（每轮重置）
  let live = null;               // 流式 / 打字机中的临时旁白 { text, reasoning }
  let liveEl = null;
  let liveReasonEl = null;       // 流式思考窗（方案 B：固定小窗滚动跟随）
  let liveReasonCollapsed = false;   // 正文已开始 → 思考窗卷成一行
  let liveReasonOpen = false;        // 用户点开看全量（照样自动跟随，不暂停）
  let pendingInject = false;     // 🧠 注入记忆：已排定下一回合强制注入完整记忆（§4.4 手动层）
  let typeTimer = null;
  let exportTargetId = null;
  let anchor = null;             // 画风锚定状态（P4：{ onDone, batch, tried, candidates, pickedIdx, card, busy }）

  /* ---------- P0-1（2026-10-14 评审）：请求中断 ----------
   * providers.chat 经 hooks.onAborter 回填当前请求的 AbortController；
   * 发送按钮在 busy 期间变成「停止」，点了就 abort 当前请求并跳过所有自动重试。 */
  let chatAbortCtrl = null;
  let stopRequested = false;

  function requestChatStop() {
    if (!busy || stopRequested) return;
    stopRequested = true;
    if (chatAbortCtrl) { try { chatAbortCtrl.abort(); } catch (_) {} }
    toast('正在停止……');
  }
  // 用户主动停止导致的请求失败：跳过「流式失败转非流式」「tools 400 降级」等自动重试
  function isStopError(e) {
    return stopRequested && (e && (e.name === 'AbortError' || /abort/i.test((e && e.message) || '')));
  }
  // busy 期间发送按钮变身「停止」：按钮保持可点，点击即中断当前回合
  function setSendButtonsBusy(on) {
    const btn = $('#btn-send');
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = on ? '停止' : '发送';
    btn.classList.toggle('stop', !!on);
  }

  /* ================= 小工具 ================= */

  let toastTimer = null;
  // 同一时刻只保留一条提示（后来者替换前者）：文本写进 #toast-text，
  // 错误提示额外给一个关闭按钮，其余情况不吃鼠标事件（pointer-events: none）。
  function toast(msg, isErr, long) {
    const el = $('#toast');
    const text = $('#toast-text');
    if (text) text.textContent = msg;
    else el.textContent = msg;
    el.classList.toggle('error', !!isErr);
    const close = $('#toast-close');
    if (close) close.classList.toggle('hidden', !isErr);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, long ? 7000 : 3500);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    const el = $('#toast');
    if (el) el.classList.add('hidden');
  }

  /* 自建 confirm / prompt（内嵌预览是沙箱 iframe，原生弹窗被静默忽略 →
     直接返回 false / null，表现为「点了没反应」，故不使用原生 confirm / prompt）。
     irConfirm(msg, { title, okText, input, value, placeholder }) → Promise
       无输入：确定 resolve(true)，取消 / 关闭 resolve(null)
       有输入：确定 resolve(字符串)，取消 / 关闭 resolve(null) */
  let cfResolve = null;
  function irConfirm(message, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      cfResolve = resolve;
      $('#cf-title').textContent = opts.title || '确认';
      $('#cf-message').textContent = message;
      const withInput = !!opts.input;
      $('#cf-input-wrap').classList.toggle('hidden', !withInput);
      const inp = $('#cf-input');
      inp.value = opts.value == null ? '' : String(opts.value);
      inp.placeholder = opts.placeholder || '';
      $('#cf-ok').textContent = opts.okText || '确定';
      openModal('modal-confirm');
      setTimeout(() => {
        if (withInput) { inp.focus(); inp.select(); } else $('#cf-ok').focus();
      }, 0);
    });
  }
  function closeConfirm(value) {
    closeModal('modal-confirm');
    const r = cfResolve;
    cfResolve = null;
    if (r) r(value);
  }
  function confirmValue() {
    return $('#cf-input-wrap').classList.contains('hidden') ? true : $('#cf-input').value;
  }

  /* ---------- 弹窗栈（P0-3） ----------
   * 十余个弹窗各自独立，演示图里「写邮件」和「代为下单」会叠在一起。
   * 这里做一个最小的统一入口：
   *   - openModal(id) / closeModal(id) 维护一个栈，后开的总在上面（z-index 由栈序决定）；
   *   - 功能类弹窗（邮件 / 支付 / 设置里的定时主动）互斥：开一个先关掉其它功能类；
   *   - 确认弹窗（#modal-confirm）不参与互斥，可以叠在任意弹窗上；
   *   - Esc 只关最上层（confirm 要走 closeConfirm，才能把 Promise 收掉）。
   * 现有 id 与 DOM 全部保持不变。 */
  const FEATURE_MODALS = ['modal-email', 'modal-payment', 'modal-settings'];
  const MODAL_IDS = [
    'modal-new', 'modal-wizard', 'modal-import-text', 'modal-export', 'modal-painter',
    'modal-anchor', 'modal-card', 'modal-settings', 'modal-confirm',
    'modal-email', 'modal-payment',
  ];
  const modalStack = [];

  function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (FEATURE_MODALS.indexOf(id) >= 0) {
      for (const other of modalStack.slice()) {
        if (other !== id && FEATURE_MODALS.indexOf(other) >= 0) closeModal(other);
      }
    }
    const at = modalStack.indexOf(id);
    if (at >= 0) modalStack.splice(at, 1);
    modalStack.push(id);
    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
    el.style.zIndex = String(30 + modalStack.length);
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('hidden');
      el.setAttribute('aria-hidden', 'true');
      el.style.zIndex = '';
    }
    const at = modalStack.indexOf(id);
    if (at >= 0) modalStack.splice(at, 1);
    // 关掉后重排剩下几层的层序，保持「后开的在上面」
    modalStack.forEach((mid, i) => {
      const m = document.getElementById(mid);
      if (m) m.style.zIndex = String(30 + i + 1);
    });
  }

  // Esc / 点遮罩：按弹窗自己的关闭函数收尾（有的要清状态、有的要 resolve Promise）
  function dismissModal(id) {
    if (id === 'modal-confirm') { closeConfirm(null); return; }
    if (id === 'modal-painter') { closeWorkbench(); return; }
    if (id === 'modal-anchor') { closeAnchor(); return; }
    if (id === 'modal-import-text') { closeImportText(); return; }
    if (id === 'modal-card') { closeCardEditor(true); return; }
    closeModal(id);
  }

  function closeTopModal() {
    if (!modalStack.length) return false;
    dismissModal(modalStack[modalStack.length - 1]);
    return true;
  }

  function netErrHint(e) {
    if (e instanceof TypeError) {
      return '网络请求失败：可能是 CORS 限制或地址不可达。建议用本地静态服务打开（如 `npx serve` 或 `python -m http.server`），并检查 Base URL / API Key。';
    }
    return '请求失败：' + (e && e.message ? e.message : String(e));
  }

  /* 断网守卫：离线时【不发请求、也不排队】，直接告诉用户「这次点了不算」。
   * 不排队是刻意的：出图时机有「每轮 / 选择后」的自动触发，若排队等联网后补发，
   * 用户会在毫不知情的情况下被扣一笔额度。 */
  function offlineBlocked(what) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      toast('当前离线：' + what + '没有发出，也不计入任何队列。已存的故事照常能看，联网后再点一次即可。', true, true);
      return true;
    }
    return false;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  // 体积显示：1 MB 以下按 KB 显示 —— 否则「68 KB 的备份」会显示成 0.0 MB，看着像没内容
  function fmtMB(bytes) {
    const b = +bytes || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return Math.round(b / 1024) + ' KB';
    return (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + ' MB';
  }

  let lastSaveWarnAt = 0;

  // 设置落盘的唯一出口：演示模式只改内存，不写盘
  function persistSettings() {
    if (DEMO) return;
    Store.saveSettings(settings);
  }

  function saveAll() {
    persistSettings();
    if (story) {
      const ok = Store.saveStory(story);
      Store.setCurrentId(story.id);
      // 写入失败（多为本地存储超限）不再静默：提示用户导出备份（10 秒节流防刷屏）
      if (!ok && Date.now() - lastSaveWarnAt > 10000) {
        lastSaveWarnAt = Date.now();
        toast('存档写入失败（本地存储可能已满）：请导出故事备份，或删除不用的故事腾出空间', true, true);
      }
    }
  }

  // 子模型（画师/书记员/起草）配置：留空即沿用剧情模型
  function resolveSub(name) {
    const sub = settings[name] || {};
    const c = settings.chat;
    return {
      provider: sub.provider || c.provider,
      baseUrl: sub.baseUrl || c.baseUrl,
      apiKey: sub.apiKey || c.apiKey,
      model: sub.model || c.model,
      temperature: Number.isFinite(+sub.temperature) ? +sub.temperature : 0.7,
      thinking: 'default',
    };
  }

  // 生图配置：预填档位优先；'__custom__' 或未登记时按比例 + 宽高算 size（R8）
  // override 供画师工作台传入本图的出图参数（比例 / 宽高）
  function imageCfg(override) {
    const im = Object.assign({}, settings.image, override || {});
    let w = +im.width || 1280, h = +im.height || 720, size = '', customSize = false;
    if (im.size && im.size !== '__custom__') {
      size = String(im.size);
      const m = size.match(/^(\d+)\s*[x×]\s*(\d+)$/);
      if (m) { w = +m[1]; h = +m[2]; }
    } else {
      if (im.size === '__custom__') customSize = true;
      else if (IMAGE_ASPECTS[im.aspect]) { w = IMAGE_ASPECTS[im.aspect][0]; h = IMAGE_ASPECTS[im.aspect][1]; }
      size = w + 'x' + h;
    }
    return Object.assign({}, im, { size: size, width: w, height: h, customSize: customSize });
  }

  /* ---------------- 模型能力（T-M-1 / §4.13） ---------------- */

  function capChat() {
    try { return Cap && Cap.find ? Cap.find('chat', settings.chat.model) : null; } catch (_) { return null; }
  }
  function capImage() {
    try { return Cap && Cap.find ? Cap.find('image', settings.image.model) : null; } catch (_) { return null; }
  }

  // 有效上下文窗口：用户手填优先，其次登记表；0 = 未知（压缩退回条数兜底）
  function chatContextWindow() {
    const manual = +settings.chat.contextWindow || 0;
    if (manual > 0) return manual;
    const cap = capChat();
    return (cap && +cap.contextWindow > 0) ? +cap.contextWindow : 0;
  }

  function sizeRatioLabel(s) {
    const m = String(s).match(/^(\d+)\s*[x×]\s*(\d+)$/);
    if (!m) return '';
    let a = +m[1], b = +m[2];
    const gcd = (x, y) => y ? gcd(y, x % y) : x;
    const g = gcd(a, b) || 1;
    a /= g; b /= g;
    if (a > 20 || b > 20) return '';
    return '（' + a + ':' + b + '）';
  }

  function pickSizeForAspect(sizes, aspect, w, h) {
    let target = 16 / 9;
    if (IMAGE_ASPECTS[aspect]) { target = IMAGE_ASPECTS[aspect][0] / IMAGE_ASPECTS[aspect][1]; }
    else if (aspect === 'custom' && w > 0 && h > 0) { target = w / h; }
    let best = sizes[0], bestD = Infinity;
    for (const s of sizes) {
      const m = String(s).match(/^(\d+)\s*[x×]\s*(\d+)$/);
      if (!m) continue;
      const d = Math.abs(Math.log((+m[1] / +m[2]) / target));
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  const LEVEL_LABELS = { low: '低（low）', medium: '中（medium）', high: '高（high）', max: '最大（max）' };

  // 手填尺寸时显示宽/高输入（预填档位模式下由档位决定，隐藏）
  function showImageWh(show) {
    $('#row-image-wh').classList.toggle('hidden', !show);
    $('#s-image-width').disabled = !show;
    $('#s-image-height').disabled = !show;
  }

  // 设置面板：按模型能力显隐参数（思考档位 / 尺寸 / 质量 / 上下文窗口提示）
  function renderCapabilityFields() {
    // —— 对话模型 ——
    const cap = capChat();
    const t = cap && cap.thinking;
    const thinkWrap = $('#wrap-chat-thinking');
    if (t && t.kind !== 'none') {
      thinkWrap.classList.remove('hidden');
      const opts = [['default', '默认（不下发）']];
      if (t.kind === 'toggle') {
        opts.push(['on', '开启思考']);
        if ((t.values || []).indexOf('disabled') >= 0) opts.push(['off', '关闭思考']);
      } else if (t.kind === 'levels') {
        (t.values || []).forEach(v => opts.push([v, LEVEL_LABELS[v] || v]));
        if (t.toggleParam) opts.push(['off', '关闭思考' + (t.alwaysOn ? '（该模型常开，不生效）' : '')]);
      }
      const cur = opts.some(o => o[0] === settings.chat.thinking) ? settings.chat.thinking : 'default';
      const sel = $('#s-chat-thinking');
      sel.innerHTML = opts.map(o => '<option value="' + o[0] + '">' + o[1] + '</option>').join('');
      sel.value = cur;
      settings.chat.thinking = cur;
    } else {
      thinkWrap.classList.add('hidden');
      settings.chat.thinking = 'default';
    }
    const ctxInput = $('#s-chat-ctx');
    ctxInput.value = (+settings.chat.contextWindow > 0) ? +settings.chat.contextWindow : '';
    ctxInput.placeholder = (cap && +cap.contextWindow > 0)
      ? (+cap.contextWindow + '（自动，按登记表）')
      : '不知道就留空（回退按条数压缩）';
    const parts = [];
    if (cap) {
      parts.push('预填参考：' + cap.model + (Cap.summarize ? '（' + Cap.summarize('chat', cap) + '）' : ''));
      if (cap.deprecated) parts.push('⚠ 该模型名可能已弃用，可改填新的');
    } else {
      parts.push('参数全部手填即可，不影响使用：上下文容量可在服务商「模型广场 / 文档」查到，不知道就留空（回退按条数压缩）；思考档位等厂商参数写进上面的「自定义请求参数」');
    }
    $('#s-chat-cap').textContent = parts.join(' · ');

    // —— 生图模型 ——
    const icap = capImage();
    const sizes = (icap && icap.image && Array.isArray(icap.image.sizes)) ? icap.image.sizes : [];
    const sizeWrap = $('#wrap-image-size'), aspectWrap = $('#wrap-image-aspect');
    const whRow = $('#row-image-wh'), qWrap = $('#wrap-image-quality');
    if (sizes.length) {
      sizeWrap.classList.remove('hidden');
      aspectWrap.classList.add('hidden');
      const sel = $('#s-image-size');
      sel.innerHTML = sizes.map(s => '<option value="' + s + '">' + s + sizeRatioLabel(s) + '</option>').join('')
        + '<option value="__custom__">自定义尺寸…（手填宽高）</option>';
      const cur = sizes.indexOf(settings.image.size) >= 0
        ? settings.image.size
        : (settings.image.size === '__custom__'
          ? '__custom__'
          : pickSizeForAspect(sizes, settings.image.aspect, +settings.image.width, +settings.image.height));
      sel.value = cur;
      settings.image.size = cur;
      showImageWh(cur === '__custom__');
      const qs = (icap.image.quality || []);
      if (qs.length) {
        qWrap.classList.remove('hidden');
        const qsel = $('#s-image-quality');
        qsel.innerHTML = ['<option value="">默认</option>'].concat(qs.map(q => '<option value="' + q + '">' + q + '</option>')).join('');
        qsel.value = qs.indexOf(settings.image.quality) >= 0 ? settings.image.quality : '';
        settings.image.quality = qsel.value;
      } else {
        qWrap.classList.add('hidden');
        delete settings.image.quality;
      }
    } else {
      sizeWrap.classList.add('hidden');
      aspectWrap.classList.remove('hidden');
      whRow.classList.remove('hidden');
      qWrap.classList.add('hidden');
      delete settings.image.size;
      delete settings.image.quality;
    }
  }

  // 背景图只作用于右栏舞台：底层是当前图的模糊放大副本（CSS 负责模糊 / 压暗）。
  // 全页背景图已取消——阅读面必须是纯 --bg，图不能透到文字后面。
  function setStageArt(src) {
    const bd = $('#stage-backdrop');
    if (!bd) return;
    if (!src) {
      bd.classList.remove('show');
      bd.style.backgroundImage = '';
      return;
    }
    bd.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
    bd.classList.add('show');
  }

  function thumb(dataUrl, maxW) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, (maxW || 560) / img.width);
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        try { resolve(cv.toDataURL('image/jpeg', 0.7)); }
        catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

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
        scrollChatBottom();
        if (i >= text.length) finish();
      }, 22);
      el.onclick = finish;
    });
  }

  /* ================= 存档点（T-P2-1 / §7） ================= */

  function snapshotStory(s, name) {
    return {
      id: 'sp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: name || ('存档点 ' + new Date().toLocaleString('zh-CN')),
      ts: Date.now(),
      turn: s.turn || 0,
      mode: s.mode || 'choice',
      log: clone((s.log || []).slice(-120)),
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
    if (!story) return null;
    story.savepoints = story.savepoints || [];
    const sp = snapshotStory(story, name);
    story.savepoints.push(sp);
    if (story.savepoints.length > 5) story.savepoints = story.savepoints.slice(-5);
    saveAll();
    renderSavepoints();
    return sp;
  }

  async function restoreSavepoint(id) {
    if (!story) return;
    if (busy) { toast('正在生成中，等这一步结束再回档'); return; }
    const sp = (story.savepoints || []).find(x => x.id === id);
    if (!sp) return;
    // §4.6 分流：存档点带着 nodeId 且节点还在（当前树或存档点自带的树里）→ 回到树上那个节点；
    // 老存档点（迁移前）没有节点可回 → 旧的整档快照，树随之重置成一条直线
    const hasNode = !!(sp.nodeId && ((story.tree && story.tree.nodes[sp.nodeId]) || (sp.tree && sp.tree.nodes && sp.tree.nodes[sp.nodeId])));
    const msg = '回到「' + sp.name + '」？当前进度会先自动存为一个新存档点。'
      + (hasNode ? '' : '\n\n这个存档点早于分支功能，回档会重置当前分支树为一条直线（回档前的分支树已整体备份进新存档点）。');
    if (!await irConfirm(msg, { title: '回档', okText: '回档' })) return;
    addSavepoint('回档前 · ' + fmtTime(Date.now()));
    if (hasNode) {
      if (!(story.tree && story.tree.nodes[sp.nodeId])) story.tree = clone(sp.tree);   // 树被重置过：从存档点把整棵接回来
      IR.Tree.switchTo(story, sp.nodeId);   // 含 project：head 落到该节点，世界卡 / 窗口跟着走
    } else {
      restoreSnapshot(story, sp);
      story.tree = null;                    // 没有分支可回：整棵树重置为线性链（§4.6）
      IR.Tree.ensure(story);
      IR.Tree.project(story);
    }
    currentChoices = choicesFromHead();
    saveAll();
    renderChat(); renderStage(); renderThumbs(); renderStoryPanels(); renderSavepoints();
    toast('已回到：' + sp.name);
  }

  function renderSavepoints() {
    const has = !!story;
    $('#sp-empty').classList.toggle('hidden', has);
    $('#sp-panel').classList.toggle('hidden', !has);
    if (!has) return;
    const list = $('#sp-list');
    list.innerHTML = '';
    const sps = (story.savepoints || []).slice().reverse();
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
    if (busy) { toast('正在生成中，等这一步结束再离开'); return; }   // 回合进行中切走会让异步续体写空/串档
    if (story) saveAll();       // 退出即自动存档
    story = null;
    busy = false;
    live = null;
    closeMenus();
    $('#screen-start').classList.add('hidden');
    $('#screen-game').classList.add('hidden');
    $('#screen-shelf').classList.remove('hidden');
    renderShelf();
  }

  // 开始页（应用入口）：三个模式先看介绍、点一张选中，再按「开始」
  function showStart() {
    if (busy) { toast('正在生成中，等这一步结束再离开'); return; }   // 同 showShelf：防异步续体写空/串档
    if (story) saveAll();
    story = null;
    busy = false;
    live = null;
    closeMenus();
    closeWorkbench();
    $('#screen-game').classList.add('hidden');
    $('#screen-shelf').classList.add('hidden');
    $('#screen-start').classList.remove('hidden');
    $('#btn-continue').classList.toggle('hidden', Store.listStories().length === 0);
    if (!$('#setup-premise').value.trim()) $('#setup-premise').value = DEFAULT_SETUP;
  }

  // 阅读页「＋ 新故事」：先把当前这一幕落盘，再开「新故事」选模式弹窗（三个模式共用同一入口）
  function newStoryFromGame() {
    if (busy) { toast('正在生成中，等这一步结束再离开'); return; }
    if (story) saveAll();             // 切走不丢：当前档先存下（仍留在书架里，可随时回去）
    openModal('modal-new');
  }

  // 开始页三模式（§4.8）：三张卡即三个开局入口，点哪张就按哪种模式开局（没有单独的开始按钮）
  //   剧情 = 设定框快通道；对话 = 直接开聊；扮演 = 先建角色卡
  function startFromStart(mode) {
    startMode = (mode === 'chat' || mode === 'rp') ? mode : 'choice';
    if (startMode === 'choice') startFromPremise();
    else createStoryImmediate(startMode);
  }

  // 剧情模式：用设定框里的文字直接开一局（v0.1 的快通道）
  function startFromPremise() {
    const premise = $('#setup-premise').value.trim() || DEFAULT_SETUP;
    const title = (premise.split('\n')[0] || '').replace(/^标题[:：]\s*/, '').slice(0, 40) || '未命名故事';
    story = Store.newStory({ premise, title, mode: 'choice' });
    enterGame(true, { deferOpening: true });
    openAnchor({ onDone: runOpening });   // §5：开局第一幕即进入试画引导（可跳过）
  }

  /* 离线演示（?demo=1）：内置剧本 + 本地占位图，直接开局。
     不联网、不需要 Key、配置不写盘；画风锚定 / 画师工作台 / 出图 / 存档等链路与真实模式完全一致。 */
  function startDemo() {
    IR.Demo.reset();
    $('#setup-premise').value = IR.Demo.premise;      // 首页设定框里留一份，退出演示后能看到这个开局长什么样
    $('#demo-chip').classList.remove('hidden');
    story = Store.newStory({ title: IR.Demo.title + '（演示）', premise: IR.Demo.premise, mode: 'choice' });
    enterGame(true, { deferOpening: true });          // 演示跳过试画锚定，直接开演
    toast('离线演示：' + IR.Demo.turnCount + ' 回合内置剧本 + 本地占位图，未连接任何模型。想接真模型就去掉地址栏的 ?demo=1。', false, true);
    runOpening();
  }

  // 「↶ 继续上次」
  function continueLast() {
    const s = Store.loadCurrent() || (Store.listStories()[0] && Store.loadStory(Store.listStories()[0].id));
    if (!s) { toast('没有找到存档'); showShelf(); return; }
    story = s;
    story.savepoints = story.savepoints || [];
    story.ui = Object.assign(Store.defaultUi(), story.ui || {});
    Store.setCurrentId(story.id);
    enterGame(false);
  }

  function renderShelf() {
    const grid = $('#shelf-grid');
    grid.innerHTML = '';
    const index = Store.listStories();
    $('#shelf-empty').classList.toggle('hidden', index.length > 0);
    for (const it of index) {
      const st = Store.loadStory(it.id) || {};
      const card = document.createElement('div');
      card.className = 'story-card';

      const thumbEl = document.createElement('div');
      thumbEl.className = 'story-thumb' + (it.thumb ? '' : ' empty');
      if (it.thumb) thumbEl.style.backgroundImage = 'url("' + it.thumb + '")';
      card.appendChild(thumbEl);

      const body = document.createElement('div');
      body.className = 'story-body';
      const name = document.createElement('div');
      name.className = 'story-name';
      name.textContent = it.title || '未命名故事';
      const meta = document.createElement('div');
      meta.className = 'story-meta';
      meta.textContent = '[' + (MODE_LABELS[st.mode] || '剧情') + '] 第 ' + (st.turn || 0) + ' 回合 · ' + fmtTime(it.updatedAt);
      body.appendChild(name); body.appendChild(meta);
      card.appendChild(body);

      const actions = document.createElement('div');
      actions.className = 'story-actions';
      actions.appendChild(miniBtn('继续', () => openStory(it.id)));
      actions.appendChild(miniBtn('改名', async () => {
        const t = await irConfirm('给这个故事起个新标题', {
          title: '改名', input: true, value: it.title || '未命名故事', okText: '保存',
        });
        if (t == null) return;
        const s2 = Store.loadStory(it.id);
        if (!s2) return;
        s2.title = String(t).trim() || s2.title;
        Store.saveStory(s2);
        renderShelf();
      }));
      actions.appendChild(miniBtn('导出', () => openExport(it.id)));
      actions.appendChild(miniBtn('删除', async () => {
        if (!await irConfirm('删除「' + (it.title || '未命名故事') + '」？此操作不可恢复。', { title: '删除故事', okText: '删除' })) return;
        Store.deleteStory(it.id);
        renderShelf();
        toast('已删除');
      }));
      card.appendChild(actions);
      grid.appendChild(card);
    }
  }

  function miniBtn(text, fn, cls) {
    const b = document.createElement('button');
    b.className = 'mini-btn' + (cls ? ' ' + cls : '');
    b.textContent = text;
    b.onclick = fn;
    return b;
  }

  function openStory(id) {
    const s = Store.loadStory(id);
    if (!s) { toast('没有找到这个存档', true); return; }
    story = s;
    story.savepoints = story.savepoints || [];
    story.ui = Object.assign(Store.defaultUi(), story.ui || {});
    Store.setCurrentId(story.id);
    enterGame(false);
  }

  /* ================= 导入 / 导出（T-P2-4 / §4.11） ================= */

  function openExport(id) {
    exportTargetId = id;
    const st = Store.loadStory(id);
    $('#export-story-name').textContent = '《' + ((st && st.title) || '未命名故事') + '》—— 导出为 .irstory.json 文件，别人导入即可阅读。';
    openModal('modal-export');
  }

  async function buildExportPack(st, kind, withSrc) {
    const images = [];
    for (const s of (st.scenes || []).slice(-12)) {
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
    const pack = {
      format: 'ir-story', schema: 2, kind: kind, app: '无限阅读 v0.4',
      title: st.title, premise: st.premise, mode: st.mode, styleTone: st.styleTone || '',
      world: st.world, styleCard: st.styleCard || null, rollingStyle: st.rollingStyle || null,
      characterCard: st.characterCard || null,
      createdAt: st.createdAt, updatedAt: st.updatedAt,
      images: images,
    };
    if (kind === 'full') {
      pack.log = st.log || [];
      pack.messages = st.messages || [];
      pack.summaries = st.summaries || [];
      pack.painterThread = st.painterThread || [];
      pack.userProfile = st.userProfile || [];
      pack.turn = st.turn || 0;
      pack.lastSceneSummary = st.lastSceneSummary || '';
      pack.tree = st.tree || null;   // 分支树（§5⑧）：full 包带整棵树，导入后 ensure 复原分支
    }
    return pack;
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
    markBackedUp();                                   // 导出单个故事也算一次备份
    closeModal('modal-export');
    toast(withSrc && !hasSrc ? '已导出（原图已不在本地，仅带缩略图 + 提示词）' : '已导出：' + safeTitle + '.irstory.json', false, true);
  }

  /* ================= 本地存储与备份（P0 数据安全） =================
   * 全部数据只在浏览器 localStorage（每站点约 5MB），没有任何服务端。这里做三件事：
   *  1) 申请持久化存储 navigator.storage.persist()：磁盘压力下的 LRU 淘汰会跳过本站
   *     （Safari 的 7 天无交互清除仍会生效，只能靠交互 / 加到主屏缓解）
   *  2) 算清本应用占用量，到 70% 提前预警（原来的提示只在写入失败之后才出现，已经晚了）
   *  3) 「一键导出全部备份」(.irbackup.json，可整体还原) + 超过 7 天没备份就提醒一次
   */
  let persistGranted = null;                      // null = 未知 / 不支持
  const LS_CHAR_LIMIT = 5000000;                  // localStorage 每站点约 5MB，按 UTF-16 字符数保守算
  const BACKUP_REMIND_MS = 7 * 24 * 3600 * 1000;  // 7 天
  const BACKUP_NAG_MS = 24 * 3600 * 1000;         // 提醒本身每天最多一次

  async function initStorageGuard() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        persistGranted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
        if (!persistGranted) persistGranted = await navigator.storage.persist();
      }
    } catch (_) { persistGranted = null; }
  }

  // 只统计本应用的键（ir: 前缀）：localStorage 上限是所有键共享的，这里的占用才是我们能控的
  function localUsage() {
    let chars = 0, keys = 0;
    try {
      const LS = window.localStorage;
      for (let i = 0; i < LS.length; i++) {
        const k = LS.key(i);
        if (!k || k.indexOf('ir:') !== 0) continue;
        chars += k.length + String(LS.getItem(k) || '').length;
        keys++;
      }
    } catch (_) {}
    return { chars: chars, keys: keys };
  }

  function markBackedUp() {
    settings.lastBackupAt = Date.now();
    settings.lastBackupRemindAt = Date.now();
    persistSettings();
    renderBackupHint();
  }

  function renderBackupHint() {
    const el = $('#backup-at');
    if (!el) return;
    const t = +settings.lastBackupAt || 0;
    el.textContent = t
      ? ('上次备份：' + fmtTime(t) + ((Date.now() - t > BACKUP_REMIND_MS) ? '（已超过 7 天，建议再备一次）' : ''))
      : '还没备份过';
    el.classList.toggle('alert', !t || (Date.now() - t > BACKUP_REMIND_MS));
  }

  // 真实占用：navigator.storage.estimate()（把 IndexedDB / Cache 等一起算在内，比数键位准得多）
  async function renderUsageLine() {
    const el = $('#storage-usage');
    if (!el) return;
    el.textContent = '正在统计占用…';
    let est = null;
    try { est = IR.Storage ? await IR.Storage.estimate() : null; } catch (_) {}
    let imgs = 0;
    try { imgs = (await Store.listImageKeys()).length; } catch (_) {}
    el.textContent = (est && est.usage != null)
      ? ('实测占用：约 ' + fmtMB(est.usage) + (est.quota ? '（浏览器给的额度约 ' + fmtMB(est.quota) + '）' : '')
        + ' · 现存原图 ' + imgs + ' 张。IndexedDB 的可用容量取决于浏览器、设备剩余空间与存储策略，不是无限大。')
      : ('这台浏览器查不到占用统计 · 现存原图 ' + imgs + ' 张。');
  }

  function renderStoragePanel() {
    const u = localUsage();
    const pct = Math.min(100, Math.round(u.chars / LS_CHAR_LIMIT * 100));
    const n = Store.listStories().length;
    const info = Store.storageInfo();
    const st = $('#storage-state');
    if (st) {
      if (info.backend === 'indexeddb') {
        st.textContent = '当前主库：IndexedDB（' + n + ' 个故事）—— 已解除 localStorage 约 5MB 的限制，'
          + '原图以 Blob 单独存放，缩略图与文本照旧跟着故事走。';
        st.classList.remove('alert');
      } else {
        st.textContent = '本应用存档已用约 ' + pct + '%（' + n + ' 个故事 / ' + u.keys + ' 个键位）——'
          + (pct >= 70
            ? '⚠ 接近写入上限，先「一键导出全部备份」，再删掉不用的故事腾空间。'
            : '每个站点约 5MB，到 70% 以上就该收拾一下了。')
          + (info.bootError
            ? '（升级到 IndexedDB 时出错，已安全退回：' + info.bootError + ' —— 数据没丢，但容量仍是约 5MB）'
            : (info.available ? '' : '（这台浏览器用不了 IndexedDB，所以退回原来的存储方式）'));
        st.classList.toggle('alert', pct >= 70);
      }
    }
    renderUsageLine();
    const ps = $('#storage-persist');
    if (ps) {
      ps.textContent = persistGranted === true
        ? '已获得「持久化存储」授权：浏览器的自动淘汰会跳过本站（手动清除数据、Safari 的 7 天规则仍会删）。'
        : (persistGranted === false
          ? '⚠ 未获得「持久化存储」授权：磁盘紧张时浏览器可能自动淘汰本站数据。多与页面交互、或把页面加为书签 / 应用，再刷新有机会获批。'
          : '（当前浏览器不支持，或暂时查不到持久化存储授权状态。）');
      ps.classList.toggle('alert', persistGranted === false);
    }
    renderBackupHint();
  }

  // 导出包：默认剥掉 API Key（备份文件常被放进网盘，带 Key 等于把钱包一起备份）
  function buildBackupPack(stripKeys) {
    const s = clone(settings);
    if (stripKeys) {
      ['chat', 'painter', 'scribe', 'draft', 'image'].forEach(k => { if (s[k]) s[k].apiKey = ''; });
    }
    return {
      format: 'ir-backup', schema: 1, app: '无限阅读 v0.4',
      exportedAt: Date.now(),
      settings: s,
      userProfile: Store.loadUserProfile(),
      stories: Store.listStories().map(it => Store.loadStory(it.id)).filter(Boolean),
    };
  }

  /* 「带原图备份」= 一个 zip 里放两样东西：
   *   ir-backup.json      与普通备份完全同款（schema 2 只多一份 images 清单）
   *   images/0001.png …   原图按二进制原样存放
   * 为什么不把原图 base64 塞进 JSON：大图转 base64 体积涨约 1/3，还会在内存里堆成巨型字符串；
   * zip 装的是原始字节，体积最省，导出 / 导入都不容易把内存打爆。代价是 .zip 不能直接肉眼查看。 */
  const IMAGE_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  };

  async function buildBackupZip(pack, onProgress) {
    // 只打包「还有故事引用着」的原图：孤儿图（引用已被删）本来就要靠「清理孤儿原图」清掉，不进备份
    const ids = Array.from(Store.knownImageIds());
    const files = [];
    const manifest = [];
    let bytes = 0;
    for (let i = 0; i < ids.length; i++) {
      const blob = await Store.getImage(ids[i]);
      if (blob && blob.size) {
        const path = 'images/' + String(manifest.length + 1).padStart(4, '0') + '.' + (IMAGE_EXT[blob.type] || 'bin');
        files.push({ name: path, data: blob });
        manifest.push({ id: ids[i], path: path, type: blob.type || 'application/octet-stream', size: blob.size });
        bytes += blob.size;
      }
      if (onProgress) onProgress(i + 1, ids.length, bytes);
    }
    const body = Object.assign({}, pack, { schema: 2, images: manifest });
    files.unshift({ name: 'ir-backup.json', data: JSON.stringify(body, null, 1) });
    return { blob: await IR.Zip.build(files), count: manifest.length, bytes: bytes };
  }

  async function doBackupAll() {
    const withKeys = !!($('#backup-with-keys') && $('#backup-with-keys').checked);
    const withSrc = !!($('#backup-with-src') && $('#backup-with-src').checked);
    const btn = $('#btn-backup-all');
    const oldText = btn ? btn.textContent : '';
    const pack = buildBackupPack(!withKeys);
    if (!pack.stories.length) { toast('还没有故事可以备份', true); return; }
    const day = new Date();
    const stamp = day.getFullYear() + String(day.getMonth() + 1).padStart(2, '0') + String(day.getDate()).padStart(2, '0');
    const note = withKeys ? '（含 API Key，请妥善保管）' : '（不含 API Key）';

    if (!withSrc) {
      download('ir-backup-' + stamp + '.irbackup.json', JSON.stringify(pack, null, 1));
      markBackedUp();
      renderStoragePanel();
      toast('已导出全部备份：' + pack.stories.length + ' 个故事' + note, false, true);
      return;
    }
    if (!(IR.Zip && IR.Zip.build)) { toast('打包模块没加载出来：请刷新页面重试', true, true); return; }

    if (btn) { btn.disabled = true; btn.textContent = '正在收集原图…'; }
    try {
      await Store.flush();                                  // 先把攒着的写盘落下去，备份的才是最新状态
      const zip = await buildBackupZip(pack, (done, total, bytes) => {
        if (btn) btn.textContent = '正在打包原图 ' + done + '/' + total + '（' + fmtMB(bytes) + '）…';
      });
      if (!zip.count) {
        // 一张原图都没取到：多半是 v0.2 时代的老故事只存了缩略图（那时原图还没有单独存放）
        download('ir-backup-' + stamp + '.irbackup.json', JSON.stringify(pack, null, 1));
        markBackedUp();
        renderStoragePanel();
        toast('本地没有原图可打包（旧故事可能只存了缩略图），已改为导出不含原图的 .irbackup.json', false, true);
        return;
      }
      downloadBlob('ir-backup-' + stamp + '.zip', zip.blob);
      markBackedUp();
      renderStoragePanel();
      toast('已导出全部备份：' + pack.stories.length + ' 个故事 + ' + zip.count + ' 张原图（' + fmtMB(zip.bytes) + '）' + note, false, true);
    } catch (e) {
      toast('打包失败：' + ((e && e.message) ? e.message : e), true, true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  }

  async function applyBackupImport(obj, zipEntries) {
    const stories = (Array.isArray(obj.stories) ? obj.stories : []).filter(s => s && s.id);
    // 带原图的备份：清单在正文里，图片本体在同包的 images/*（见 buildBackupZip）
    const manifest = Array.isArray(obj.images) ? obj.images.filter(x => x && x.id && x.path) : [];
    const pending = zipEntries ? manifest.filter(x => zipEntries.has(x.path)) : [];
    const missing = manifest.length - pending.length;
    if (!stories.length && !obj.settings) { toast('备份文件里没有可还原的内容', true); return; }
    const ok = await irConfirm(
      '导入备份：还原 ' + stories.length + ' 个故事'
      + (pending.length ? ' + ' + pending.length + ' 张原图' : '')
      + (obj.settings ? '，并覆盖当前的模型设置' : '')
      + (Array.isArray(obj.userProfile) ? '与用户画像' : '')
      + '？同 id 的故事会被覆盖，其它故事保留。',
      { title: '导入备份', okText: '还原' }
    );
    if (!ok) return;
    let n = 0;
    for (const raw of stories) {
      const s2 = Store.migrateStory(raw);
      if (!s2 || !s2.id) continue;
      Store.saveStory(s2);
      n++;
    }
    if (obj.settings) {
      const prev = settings;
      settings = Store.migrateSettings(obj.settings);
      // 备份可能刻意不带 Key：别把现有 Key 覆盖成空
      ['chat', 'painter', 'scribe', 'draft', 'image'].forEach(k => {
        if (settings[k] && !settings[k].apiKey && prev[k] && prev[k].apiKey) settings[k].apiKey = prev[k].apiKey;
      });
      persistSettings();
      syncSettingsToForm();
    }
    if (Array.isArray(obj.userProfile)) Store.saveUserProfile(obj.userProfile);

    // 原图：从 zip 条目直接写回 IndexedDB（字节原样落盘，不经过 base64）
    let imgs = 0, lost = 0;
    for (const im of pending) {
      const raw = zipEntries.get(im.path);
      if (!raw) { lost++; continue; }
      const blob = im.type ? raw.slice(0, raw.size, im.type) : raw;
      if (Store.putImage(im.id, blob, { from: 'backup' })) imgs++; else lost++;
    }
    if (pending.length) await Store.flush();

    renderShelf();
    renderStoragePanel();
    toast('已还原备份：' + n + ' 个故事'
      + (imgs ? ' + ' + imgs + ' 张原图' : '')
      + (lost
        ? '；有 ' + lost + ' 张原图没还原'
          + (IR.Storage && !IR.Storage.available ? '（这台浏览器用不了 IndexedDB，原图存不进本地）' : '（数据不完整）')
        : '')
      + (missing ? '；清单里有 ' + missing + ' 张图不在包里（备份文件可能被改动过）' : ''),
      !!lost, true);
  }

  // 超过 7 天没备份（且确实有故事）→ 启动后提醒一次；提醒本身每天最多一次，不刷屏
  function remindBackupIfNeeded() {
    if (DEMO) return;                 // 演示模式不提醒备份（配置与故事都不必当回事）
    const n = Store.listStories().length;
    if (!n) return;
    const now = Date.now();
    const last = +settings.lastBackupAt || 0;
    if (last && now - last < BACKUP_REMIND_MS) return;
    if (now - (+settings.lastBackupRemindAt || 0) < BACKUP_NAG_MS) return;
    settings.lastBackupRemindAt = now;
    persistSettings();
    setTimeout(() => toast(
      '你的 ' + n + ' 个故事只存在这个浏览器里，已经超过 7 天没备份了：设置 → 本地存储与备份 →「一键导出全部备份」',
      false, true
    ), 1800);
  }

  function openSettings() {
    if (DEMO) toast('演示模式：这里的设置改了也不会生效（演示不联网、不写盘）。去掉地址栏的 ?demo=1 重新打开，就可以接入真模型了。', false, true);
    syncSettingsToForm();
    renderStoragePanel();
    openModal('modal-settings');
    renderSidecarStatus();
    if (sidecarReady()) loadFeatureConfig();   // 打开设置时刷新一次安全项（真源在侧车）
  }

  function isZipFile(file) {
    const n = String((file && file.name) || '').toLowerCase();
    const t = String((file && file.type) || '').toLowerCase();
    return /\.zip$/.test(n) || t === 'application/zip' || t === 'application/x-zip-compressed' || t === 'multipart/x-zip';
  }

  // 从一个 zip 里找备份正文：优先根目录，也接受「被塞进一层文件夹」的情况
  function pickBackupJson(entries) {
    if (entries.has('ir-backup.json')) return entries.get('ir-backup.json');
    let best = null;
    for (const [name, blob] of entries) {
      if (!/(^|\/)ir-backup\.json$/i.test(name)) continue;
      if (!best || name.length < best.name.length) best = { name: name, blob: blob };
    }
    return best ? best.blob : null;
  }

  // 带原图的全量备份（.zip）：解出 ir-backup.json 走同一套还原流程，原图另走 images/*
  async function importZipFile(file) {
    if (!(IR.Zip && IR.Zip.read)) { toast('这个版本没有 zip 支持：请刷新页面重试', true, true); return; }
    toast('正在读取备份包…', false, true);
    let entries = null;
    try {
      entries = await IR.Zip.read(file);
    } catch (e) {
      toast('这个 .zip 打不开：' + ((e && e.message) ? e.message : e), true, true);
      return;
    }
    const main = pickBackupJson(entries);
    if (!main) {
      toast('这个 zip 里没有 ir-backup.json —— 只认识「一键导出全部备份（带原图）」导出的 .zip。'
        + '.irstory.json / .irbackup.json 请直接拖进来，不用先压缩。', true, true);
      return;
    }
    let obj = null;
    try { obj = JSON.parse(await main.text()); } catch (_) {
      toast('备份包里的 ir-backup.json 不是有效 JSON（文件可能损坏）', true, true);
      return;
    }
    if (!obj || obj.format !== 'ir-backup') { toast('备份包里的 ir-backup.json 不是本应用的备份格式', true, true); return; }
    applyBackupImport(obj, entries);
  }

  function handleImportFile(file) {
    if (!file) return;
    if (isZipFile(file)) { importZipFile(file); return; }
    const reader = new FileReader();
    reader.onload = () => {
      let obj = null;
      try { obj = JSON.parse(reader.result); } catch (_) { toast('文件不是有效的 JSON', true); return; }
      applyImport(obj);
    };
    reader.readAsText(file);
  }

  function applyImport(obj) {
    if (obj && obj.format === 'ir-backup') { applyBackupImport(obj); return; }   // 整体备份还原（P0）
    if (!obj || obj.format !== 'ir-story') { toast('这不是一个 .irstory.json / .irbackup.json 档案', true, true); return; }
    if (obj.kind === 'premise') {
      // 精简设定包 → 预填开局向导（§4.11 路径①）
      closeModal('modal-new');
      openWizard(wizardPrefillFromPack(obj));
      toast('精简设定包：已预填向导，确认后开始', false, true);
      return;
    }
    // 完整档案：原样续玩
    const st = Store.newStory({
      title: (obj.title || '导入的故事') + '（导入）',
      premise: obj.premise || '',
      mode: obj.mode || 'choice',
      styleTone: obj.styleTone || '',
      world: obj.world || {},
      styleCard: obj.styleCard || null,
      rollingStyle: obj.rollingStyle || null,
      characterCard: obj.characterCard || null,
      userProfile: obj.userProfile || [],
      painterThread: obj.painterThread || [],
    });
    st.log = Array.isArray(obj.log) ? obj.log : [];
    st.messages = Array.isArray(obj.messages) ? obj.messages : [];
    st.summaries = Array.isArray(obj.summaries) ? obj.summaries : [];
    st.turn = obj.turn || 0;
    st.lastSceneSummary = obj.lastSceneSummary || '';
    st.scenes = (obj.images || []).map((im, i) => ({
      id: im.id || ('sc-imp' + i), alt: im.alt || '', prompt: im.prompt || '', promptRaw: im.promptRaw || '',
      aspect: im.aspect || '', width: im.width || 0, height: im.height || 0,
      thumb: im.thumb || null, src: im.src || null, ts: Date.now(),
    }));
    st.lastBg = st.scenes.length ? st.scenes[st.scenes.length - 1].id : null;
    st.tree = obj.tree ? clone(obj.tree) : null;   // full 包带的分支树（§5⑧）
    IR.Tree.ensure(st);                            // 导入后建 / 校验树（无树旧包 → 线性链）
    Store.saveStory(st);
    showShelf();                       // 导入即进书架，能直接看到新卡片
    // 档案里带的原图（别人导出时勾了「附带原图」）：转成 Blob 存进 IndexedDB，之后照常显示原图
    const withOriginal = st.scenes.filter(sc => sc.src && sc.src.indexOf('data:') === 0);
    if (withOriginal.length) {
      (async () => {
        for (const sc of withOriginal) {
          const imageId = await storeOriginal(sc.id, sc.src, { width: sc.width, height: sc.height });
          if (imageId) {
            sc.imageId = imageId;
            // 这里 story 已被 showShelf 置空：直接在导入的 st 上找（原写法 findImageEntry 永远找不到）
            const entry = (st.log || []).find(e => e && e.type === 'image' && e.id === sc.id);
            if (entry) entry.imageId = imageId;
            // 分支树里同一张 scene / 图片条目也换键（§5⑧）：否则非当前分支的图全是死键
            const nodes = st.tree && st.tree.nodes;
            if (nodes) for (const nid of Object.keys(nodes)) {
              for (const sm of (nodes[nid].scenes || [])) if (sm && sm.id === sc.id) sm.imageId = imageId;
              for (const en of (nodes[nid].entries || [])) if (en && en.type === 'image' && en.id === sc.id) en.imageId = imageId;
            }
          }
        }
        Store.saveStory(st);   // 换键结果要落盘（story 已切走，saveAll 是空操作）
        renderStage(); renderThumbs();
      })();
    }
    toast('已导入：《' + st.title + '》', false, true);
  }

  function wizardPrefillFromPack(obj) {
    const w = obj.world || {};
    return {
      topic: obj.title || '',
      world: obj.premise || '',
      characters: (w.characters || []).map(c => [c.name || '', c.personality || '', c.speech || ''].join('｜')).join('\n'),
      style: obj.styleTone || (obj.styleCard && (obj.styleCard.styleKeywords || []).join(', ')) || '',
      role: '', development: '',
    };
  }

  /* ================= 剧情文本导入（R12 路径② / §4.11 / T-P6-1） =================
   * 粘贴任意剧情文本 → 整理向导（用「起草模型」；只有装不下才 map-reduce）→
   * premise + world 草稿 + 画风关键词 → 用户确认修改（不可跳过）→ 建新档 → 试画锚定 → 开场。
   * 调用失败退回本地规则。 */

  let importJob = null;    // { raw, plan, result, busy, err }

  // 整理模型：弹窗里可选（默认跟随剧情模型；也能用单独配置的起草模型）
  let importModelMode = 'follow';    // follow | draft

  function importCfg() {
    if (importModelMode === 'draft') return resolveSub('draft');   // 起草模型（没单独配就是剧情模型）
    const c = settings.chat;                                       // 跟随剧情模型
    return {
      provider: 'openai-compatible',
      baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model,
      temperature: 0.7, thinking: 'default',
    };
  }

  // 「这次用谁整理」的一行字（显示在提示与确认页上；避免只写模型名让人误以为是硬编码的）
  function importModelLabel() {
    const cfg = importCfg();
    const src = importModelMode === 'draft' ? '起草模型' : '跟随剧情模型';
    return cfg.model ? (cfg.model + '（' + src + '）') : ('未配置模型名（' + src + '）');
  }

  // 整理模型的有效窗口：跟随剧情模型 → 用剧情模型的；起草模型 → 单独配了才查登记表
  function importContextWindow() {
    if (importModelMode === 'draft') {
      const sub = settings.draft || {};
      if (!sub.provider && !sub.model) return chatContextWindow();
      try {
        const w = Cap && Cap.contextWindowOf ? Cap.contextWindowOf(sub.model || settings.chat.model, sub.provider) : null;
        return w || 0;
      } catch (_) { return 0; }
    }
    return chatContextWindow();
  }

  // 粘贴框下方的一行提示：整理模型 + 窗口 + 这次会一次调用还是 map-reduce（返回 plan 供调用方复用）
  function importPlanHint() {
    const raw = ($('#it-text').value || '').trim();
    const win = importContextWindow();
    const plan = IR.Context.planImport(raw, win);
    const parts = [
      '整理模型：' + importModelLabel(),
      win > 0 ? ('窗口 ' + Cap.formatWindow(win) + ' token') : '窗口未知（按一次调用处理）',
      '约 ' + raw.length + ' 字 → ' + (plan.needsMap
        ? ('分 ' + plan.chunks.length + ' 段 map-reduce，每段 ≤ ' + plan.budget + ' 字')
        : '一次调用'),
    ];
    $('#it-plan-hint').textContent = parts.join(' · ');
    return plan;
  }

  function openImportText() {
    importJob = null;
    $('#it-text').value = '';
    $('#it-model-mode').value = importModelMode;   // 记住上次选的整理模型
    $('#it-step-paste').classList.remove('hidden');
    $('#it-step-run').classList.add('hidden');
    $('#it-step-confirm').classList.add('hidden');
    importPlanHint();
    openModal('modal-import-text');
    $('#it-text').focus();
  }

  function closeImportText() {
    importJob = null;
    closeModal('modal-import-text');
  }

  function setImportStatus(text) {
    const el = $('#it-status');
    if (el) el.textContent = text || '';
  }

  async function callImportChat(cfg, task, text, meta) {
    const adapter = IR.ChatProviders[cfg.provider] || IR.ChatProviders['openai-compatible'];
    return adapter.chat(cfg, IR.Context.assembleImporter(task, text, meta));
  }

  function parseImportJson(raw) {
    const s = String(raw || '');
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i === -1 || j <= i) return null;
    let o = null;
    try { o = JSON.parse(s.slice(i, j + 1)); } catch (_) { return null; }
    return (o && typeof o === 'object') ? o : null;
  }

  function parseImportSummary(raw) {
    const o = parseImportJson(raw);
    return (o && o.summary) ? String(o.summary).trim() : '';
  }

  function parseImportResult(raw) {
    const o = parseImportJson(raw);
    if (!o || (!o.premise && !o.world)) return null;
    const w = (o.world && typeof o.world === 'object') ? o.world : {};
    return {
      title: String(o.title || '').trim().slice(0, 40),
      premise: String(o.premise || '').trim(),
      world: {
        place: String(w.place || ''), time: String(w.time || ''), scene: String(w.scene || ''),
        characters: Array.isArray(w.characters) ? w.characters.filter(c => c && c.name).map(c => ({
          name: String(c.name), presence: String(c.presence || '在场'),
          personality: String(c.personality || ''), speech: String(c.speech || ''), note: String(c.note || ''),
        })).slice(0, 6) : [],
        threads: Array.isArray(w.threads) ? w.threads.filter(Boolean).map(String).slice(0, 12) : [],
      },
      styleKeywords: Array.isArray(o.styleKeywords) ? o.styleKeywords.filter(Boolean).map(String).slice(0, 8) : [],
    };
  }

  // 本地兜底整理：只截取原文开头并结构化（调用失败时用；标「本地规则」，等用户改）
  function localImport(text) {
    const t = String(text || '').replace(/\r\n?/g, '\n').trim();
    const flat = t.replace(/\s+/g, ' ');
    const first = (t.split('\n').map(s => s.trim()).filter(Boolean)[0] || '');
    const book = first.match(/[《【]([^》】]{1,24})[》】]/);
    const head = first
      .replace(/^[#\s]*/, '').replace(/^标题[:：]\s*/, '')
      .replace(/^[《【\[]\s*/, '').replace(/[》】\]]\s*$/, '').trim();
    const title = ((book ? book[1] : head) || '导入的故事').slice(0, 20);
    const names = [];
    const re = /[「"]([^」"]{2,6})[」"]/g;   // 人名只认「」引号（《》是书名）
    let m;
    while ((m = re.exec(t)) && names.length < 4) {
      const n = m[1].trim();
      if (n && names.indexOf(n) < 0) names.push(n);
    }
    return {
      local: true,
      title: title,
      premise: [
        '标题：' + title,
        '世界：' + (flat.slice(0, 120) || '（原文没写清，可自行补充）'),
        '你的角色：故事里的主角（你可以随时扮演成任何人、做任何事）。',
        '风格：按原文语气自行补充。',
        'AI 扮演：旁白，以及故事里除你以外的所有角色。',
      ].join('\n'),
      world: {
        place: '', time: '', scene: flat.slice(0, 60),
        characters: names.map(n => ({ name: n, presence: '在场', personality: '', speech: '', note: '' })),
        threads: [],
      },
      styleKeywords: [],
    };
  }

  function parseImportCharacters(text) {
    return String(text || '').split('\n').map(line => {
      const p = line.split('｜').map(s => s.trim());
      if (!p[0]) return null;
      return { name: p[0], presence: p[1] || '在场', personality: p[2] || '', speech: p[3] || '', note: '', noteLocked: false };
    }).filter(Boolean);
  }

  function fillImportForm(res, plan) {
    $('#it-title').value = res.title || '';
    $('#it-premise').value = res.premise || '';
    const w = res.world || {};
    $('#it-place').value = w.place || '';
    $('#it-time').value = w.time || '';
    $('#it-scene').value = w.scene || '';
    $('#it-characters').value = (w.characters || [])
      .map(c => [c.name, c.presence || '在场', c.personality || '', c.speech || ''].join('｜')).join('\n');
    $('#it-threads').value = (w.threads || []).join('\n');
    $('#it-style').value = (res.styleKeywords || []).join(', ');
    const used = (plan && plan.needsMap) ? (plan.chunks.length + ' 段 map-reduce') : '一次调用';
    $('#it-confirm-info').textContent = '整理方式：' + used + ' · 整理模型：' + importModelLabel()
      + (res.local ? ' · 本地规则兜底（只截了原文开头，建议手动补充）' : '')
      + '。下面每一栏都可以改——确认这一步不能跳过。';
  }

  // 分段摘要合并（§4.11：分段各出摘要，再一次合并成开局材料）
  async function reduceImportSummaries(cfg, summaries, budget) {
    let list = summaries.slice();
    for (let round = 0; round < 4; round++) {
      const batches = IR.Context.planImportMerge(list, budget);
      if (batches.length <= 1) break;                 // 已能一次装下（或只剩一条）
      const next = [];
      for (let i = 0; i < batches.length; i++) {
        setImportStatus('合并摘要 · 第 ' + (i + 1) + ' / ' + batches.length + ' 批…');
        const raw = await callImportChat(cfg, 'merge', batches[i].join('\n\n'));
        next.push(parseImportSummary(raw) || batches[i].join(' ').slice(0, 200));
      }
      list = next;
    }
    return list.join('\n\n');
  }

  async function runImportText() {
    if (importJob && importJob.busy) return;
    const raw = ($('#it-text').value || '').trim();
    if (raw.length < 20) { toast('先贴一段剧情文本（至少 20 字），再点「开始整理」', true); return; }
    const cfg = importCfg();
    const plan = IR.Context.planImport(raw, importContextWindow());
    importJob = { raw: raw, plan: plan, busy: true, result: null, err: '' };
    $('#it-step-paste').classList.add('hidden');
    $('#it-step-confirm').classList.add('hidden');
    $('#it-step-run').classList.remove('hidden');
    $('#it-run-info').textContent = '整理模型：' + importModelLabel() + ' · ' + (plan.needsMap
      ? ('长文：整篇装不下（模型窗口 ' + Cap.formatWindow(plan.window) + '），分 ' + plan.chunks.length + ' 段摘要后再合并')
      : '一次调用整理整篇');
    setImportStatus('整理中…');

    let res = null;
    try {
      if (plan.needsMap) {
        const summaries = [];
        for (let i = 0; i < plan.chunks.length; i++) {
          setImportStatus('分段摘要 第 ' + (i + 1) + ' / ' + plan.chunks.length + ' 段…');
          const one = await callImportChat(cfg, 'map', plan.chunks[i], { index: i + 1, total: plan.chunks.length });
          summaries.push(parseImportSummary(one) || String(plan.chunks[i]).slice(0, 120));
        }
        setImportStatus('合并摘要…');
        const merged = await reduceImportSummaries(cfg, summaries, plan.budget);
        setImportStatus('整理成故事设定…');
        res = parseImportResult(await callImportChat(cfg, 'final', merged));
      } else {
        res = parseImportResult(await callImportChat(cfg, 'final', raw));
      }
    } catch (e) {
      importJob.err = (e && e.message) || String(e);
      res = null;
    }

    const local = !res;
    if (local) res = localImport(raw);
    importJob.busy = false;
    importJob.result = res;
    fillImportForm(res, plan);
    $('#it-step-run').classList.add('hidden');
    $('#it-step-confirm').classList.remove('hidden');
    toast(local
      ? ('整理没成功（' + (importJob.err || '模型没给出可用结果') + '）：已用本地规则生成草稿，请手动补充')
      : ('整理完成（' + (plan.needsMap ? plan.chunks.length + ' 段 map-reduce' : '一次调用') + '）：确认或改完再开局'),
      local, local);
  }

  function startFromImport() {
    if (!importJob || !importJob.result) { toast('先整理一遍再开局', true); return; }
    const title = ($('#it-title').value.trim() || '导入的故事').slice(0, 40);
    const premise = $('#it-premise').value.trim();
    const chars = parseImportCharacters($('#it-characters').value);
    const threads = $('#it-threads').value.split('\n').map(s => s.trim()).filter(Boolean);
    const style = $('#it-style').value.trim();
    if (!premise && !chars.length) {
      toast('设定还空着：至少留一行故事设定或一个人物（这一步不能跳过）', true);
      return;
    }
    const s = Store.newStory({ title: title, premise: premise || ('标题：' + title), mode: 'choice', styleTone: style });
    s.world.place = $('#it-place').value.trim();
    s.world.time = $('#it-time').value.trim();
    s.world.scene = $('#it-scene').value.trim();
    s.world.characters = chars;
    s.world.threads = threads;
    story = s;
    closeModal('modal-import-text');
    importJob = null;
    enterGame(true, { deferOpening: true });
    openAnchor({ onDone: runOpening });   // §4.11：建新档 → 试画锚定出画风候选图 → 开场
  }

  /* ================= 角色卡（R13 / §4.12 / T-P7-1） =================
   * 统一编辑器：自建 = 空白表单；导入 = SillyTavern V2/V3 PNG（只兼容格式，不复制内容）；改完即生效。
   * rp 开局 = 选（建 / 导入）一张角色卡；开场白作为首条旁白；示例对话喂给模型学口吻。 */

  let cardEditor = null;   // { mode: 'new'|'edit', source, onCancel }

  function openCardEditor(opts) {
    opts = opts || {};
    const mode = opts.mode === 'new' ? 'new' : 'edit';
    const card = opts.card || ((mode === 'edit' && story && story.characterCard) || IR.RoleCard.emptyCard());
    cardEditor = { mode: mode, source: card.source || 'custom', onCancel: opts.onCancel || null };
    fillCardForm(card);
    $('#card-modal-title').textContent = mode === 'new' ? '选一张角色卡（扮演开局）' : '角色卡';
    $('#card-source-hint').textContent = '来源：' + IR.RoleCard.sourceLabel(card)
      + (mode === 'new' ? '。可以空白自建，也可以导入你自己的 SillyTavern V2/V3 PNG 卡；导入后可随意改。' : '（改完即生效，下一回合开始用新卡）');
    $('#btn-rc-save').textContent = mode === 'new' ? '用这张卡开局' : '保存角色卡';
    openModal('modal-card');
  }

  function closeCardEditor(cancel) {
    const cb = cardEditor && cardEditor.onCancel;
    closeModal('modal-card');
    cardEditor = null;
    if (cancel && cb) cb();
  }

  function fillCardForm(card) {
    const c = IR.RoleCard.normalize(card);
    if (cardEditor) cardEditor.source = c.source;
    $('#rc-name').value = c.name;
    $('#rc-appearance').value = c.appearance;
    $('#rc-personality').value = c.personality;
    $('#rc-scene').value = c.scene;
    $('#rc-opening').value = c.opening;
    $('#rc-example').value = c.exampleDialogue;
    $('#rc-note').value = c.systemNote;
    $('#rc-sync-world').checked = true;
  }

  function readCardForm() {
    return IR.RoleCard.normalize({
      name: $('#rc-name').value,
      appearance: $('#rc-appearance').value,
      personality: $('#rc-personality').value,
      scene: $('#rc-scene').value,
      opening: $('#rc-opening').value,
      exampleDialogue: $('#rc-example').value,
      systemNote: $('#rc-note').value,
      source: (cardEditor && cardEditor.source) || 'custom',
      updatedAt: Date.now(),
    });
  }

  function saveCardFromEditor() {
    if (!cardEditor) return;
    const card = readCardForm();
    if (!card.name) { toast('先给角色起个名字吧', true); return; }
    const syncWorld = $('#rc-sync-world').checked;
    if (cardEditor.mode === 'new') {
      closeModal('modal-card');
      cardEditor = null;
      startStoryFromCard(card, syncWorld);
      return;
    }
    if (!story) { closeCardEditor(false); return; }
    story.characterCard = card;
    if (syncWorld) syncWorldCharacter(card);
    saveAll();
    renderStoryPanels();
    renderProfilePanel();
    closeCardEditor(false);
    toast('角色卡已保存，改完即生效');
  }

  function importCardFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let card = null;
      try { card = IR.RoleCard.parsePNG(new Uint8Array(reader.result)); } catch (_) { card = null; }
      if (!card) { toast('没能从这张 PNG 里读到角色卡：支持 SillyTavern V2 / V3 内嵌 JSON 的卡', true, true); return; }
      fillCardForm(card);
      toast('已读入角色卡「' + card.name + '」（' + IR.RoleCard.sourceLabel(card) + '），可以随意改，改完保存', false, true);
    };
    reader.readAsArrayBuffer(file);
  }

  // 卡 → 世界卡人物条目（personality / speech 对接，§4.12）；用户手改过的字段按 mergeWorld 规则保护
  function syncWorldCharacter(card) {
    if (!story || !card) return;
    const entry = IR.RoleCard.worldCharacter(card);
    if (!entry) return;
    story.world = story.world || Store.defaultWorld();
    IR.Context.mergeWorld(story.world, { characters: [entry] });
  }

  // 开场白 = rp 首条旁白（不花一次 AI 调用；§4.12）
  function pushCardOpening(card) {
    const text = String((card && card.opening) || '').trim();
    if (!story || !text) return;
    story.log.push({ type: 'narration', text: text, versions: [text], activeVersion: 0, ts: Date.now() });
  }

  function startStoryFromCard(card, syncWorld) {
    const s = Store.newStory({
      title: card.name || ('扮演 · ' + fmtTime(Date.now())),
      premise: rpPremise(card),
      mode: 'rp',
      characterCard: card,
    });
    if (syncWorld) {
      const entry = IR.RoleCard.worldCharacter(card);
      if (entry) IR.Context.mergeWorld(s.world, { characters: [entry] });
    }
    story = s;
    enterGame(true, { deferOpening: true });   // rp 不做开局锚定（P4）；开场白直接进日志
    pushCardOpening(card);
    saveAll();
    renderChat();
    toast('已登场：' + (card.name || '角色') + '。开场白是角色卡写的，接下来就由你们演。', false, true);
  }

  /* ---------------- 用户画像（R13 / §4.12 / T-P7-2） ----------------
   * 开关默认全关、可按模式单独开或全开；范围 global（ir:user-profile）/ per-story 用户自选。
   * 收集：真实模式由书记员校对时顺手提取；失败退回本地确定性规则（只认「我…」句式）。
   * 注入：每轮只带与当前话题相关的 Top-N + 常驻一行摘要（assembleAI1 的 opts.profile，见 callAI1）。 */

  function profileOn() {
    const up = settings.userProfile || {};
    return IR.Context.profileEnabledFor(up.enabled, (story && story.mode) || 'choice');
  }

  // 当前生效的画像条目（按 scope 取全局或本档）；关开关 / 没故事 → 空
  function activeProfileEntries() {
    if (!story || !profileOn()) return [];
    return ((settings.userProfile || {}).scope === 'global')
      ? Store.loadUserProfile()
      : (story.userProfile || []);
  }

  // 写入画像：关开关即停止收集；合并去重（同文只留最新），不设条数上限（§4.12 存储无上限）
  function applyProfileEntries(list) {
    if (!story || !profileOn() || !Array.isArray(list) || !list.length) return 0;
    const inc = IR.Context.normalizeProfile(list);
    if (!inc.length) return 0;
    if ((settings.userProfile || {}).scope === 'global') {
      Store.saveUserProfile(IR.Context.mergeProfile(Store.loadUserProfile(), inc));
    } else {
      story.userProfile = IR.Context.mergeProfile(story.userProfile || [], inc);
    }
    return inc.length;
  }

  // 失败兜底：只看玩家最后说的一句（确定性规则）
  function collectProfileLocal() {
    const last = [...((story && story.log) || [])].reverse().find(e => e.type === 'player' || e.type === 'choice');
    if (!last) return;
    const got = IR.Context.localProfileExtract(last.text);
    if (got.length) { applyProfileEntries(got); saveAll(); }
  }

  // 书记员输入里的画像指示：开没开都说清楚，省得模型乱输出
  function scribeProfileHint() {
    return profileOn()
      ? '[用户画像] 请提取：玩家值得长期记住的信息（每轮最多 3 条，同类只留最新；没有就省略 profile）。'
      : '[用户画像] 未开启：不要输出 profile 字段。';
  }

  /* ================= 开局向导（T-P2-3 / §4.8） ================= */

  function openWizard(prefill) {
    prefill = prefill || {};
    $('#wz-draft-input').value = prefill.topic || '';
    $('#wz-world').value = prefill.world || '';
    $('#wz-characters').value = prefill.characters || '';
    $('#wz-role').value = prefill.role || '';
    $('#wz-style').value = prefill.style || '';
    $('#wz-development').value = prefill.development || '';
    const cfg = resolveSub('draft');
    const sub = settings.draft || {};
    const src = (sub.provider || sub.model) ? '起草模型单独配置' : '跟随剧情模型';
    $('#wz-draft-hint').textContent = '起草模型：' + (cfg.model || '（未配置）') + '（' + src + '，可在模型设置里更换）。草稿出来后再改成你自己的话即可。';
    openModal('modal-wizard');
  }

  function parseCharacterLines(text) {
    return String(text || '').split('\n').map(line => {
      const p = line.split('｜').map(s => s.trim());
      if (!p[0]) return null;
      return { name: p[0], personality: p[1] || '', speech: p[2] || '' };
    }).filter(Boolean);
  }

  function firstSentence(text, max) {
    const t = String(text || '').trim().split(/[\n。；;]/)[0] || '';
    return t.slice(0, max || 40);
  }

  function localDraft(topic) {
    const t = String(topic || DEFAULT_TOPIC).replace(/^标题[:：]\s*/, '').trim();
    return {
      world: '围绕「' + t.slice(0, 24) + '」展开的世界。时代与地点贴近日常，但在寻常处埋着一点异样；规则不解释透，让故事自己显形。',
      characters: [
        { name: '叙述者', personality: '沉静、观察力强、话里有话', speech: '简短、克制' },
        { name: '旧识', personality: '看似随意、实则心事很重', speech: '喜欢反问、句子偏短' },
      ],
      role: '你是这场相遇的中心：一个带着未了心愿的人，可以在故事里做任何尝试。',
      styleTone: '克制的悬疑，暖光与冷影并存，雨夜的质感',
      development: '从一个安静的细节开场，让异样一点点渗出来。',
    };
  }

  function parseDraft(raw) {
    const s = String(raw || '');
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i === -1 || j <= i) return null;
    try {
      const o = JSON.parse(s.slice(i, j + 1));
      if (!o || (!o.world && !o.role && !Array.isArray(o.characters))) return null;
      return {
        world: String(o.world || ''),
        characters: Array.isArray(o.characters) ? o.characters.filter(Boolean).map(c => ({
          name: String(c.name || ''), personality: String(c.personality || c.persona || ''), speech: String(c.speech || ''),
        })).filter(c => c.name) : [],
        role: String(o.role || ''),
        styleTone: String(o.styleTone || o.style || ''),
        development: String(o.development || ''),
      };
    } catch (_) { return null; }
  }

  function fillWizard(d) {
    if (d.world) $('#wz-world').value = d.world;
    if (d.characters && d.characters.length) {
      $('#wz-characters').value = d.characters.map(c => [c.name, c.personality, c.speech].join('｜')).join('\n');
    }
    if (d.role) $('#wz-role').value = d.role;
    if (d.styleTone) $('#wz-style').value = d.styleTone;
    if (d.development) $('#wz-development').value = d.development;
  }

  async function draftWizard() {
    const topic = $('#wz-draft-input').value.trim() || DEFAULT_TOPIC;
    const btn = $('#btn-wz-draft');
    btn.disabled = true; btn.textContent = '起草中…';
    try {
      const cfg = resolveSub('draft');
      let d = null;
      if (!cfg.model) {
        await sleep(500);
        d = localDraft(topic);
      } else {
        const adapter = IR.ChatProviders[cfg.provider] || IR.ChatProviders['openai-compatible'];
        const raw = await adapter.chat(cfg, [
          { role: 'system', content: DRAFT_SYSTEM },
          { role: 'user', content: topic },
        ]);
        d = parseDraft(raw);
        if (!d) d = localDraft(topic);
      }
      fillWizard(d);
      toast('草稿已填入，改成你自己的话即可');
    } catch (e) {
      fillWizard(localDraft(topic));
      toast(netErrHint(e) + '（已改用本地模板草稿）', true, true);
    } finally {
      btn.disabled = false; btn.textContent = '✎ 起草';
    }
  }

  function buildPremise(f) {
    const lines = ['标题：' + f.title];
    if (f.world) lines.push('世界：' + f.world);
    if (f.role) lines.push('你的角色：' + f.role);
    if (f.chars.length) lines.push('主要人物：' + f.chars.map(c => c.name + '（' + [c.personality, c.speech].filter(Boolean).join('，') + '）').join('；'));
    if (f.style) lines.push('风格：' + f.style);
    if (f.dev) lines.push('想看的发展：' + f.dev);
    lines.push('AI 扮演：旁白，以及故事里除你以外的所有角色。剧情随玩家的行动自由生长，不要拒绝玩家的任何尝试。');
    return lines.join('\n');
  }

  function startFromWizard() {
    const topic = $('#wz-draft-input').value.trim();
    const worldText = $('#wz-world').value.trim();
    const chars = parseCharacterLines($('#wz-characters').value);
    const role = $('#wz-role').value.trim();
    const style = $('#wz-style').value.trim();
    const dev = $('#wz-development').value.trim();
    if (!worldText && !role && !chars.length) {
      toast('至少填一点世界观、人物或你的角色吧', true);
      return;
    }
    const title = (topic || firstSentence(worldText, 20) || '未命名故事').slice(0, 40);
    const premise = buildPremise({ title, world: worldText, role, chars, style, dev });
    const s = Store.newStory({ title, premise, mode: 'choice', styleTone: style });
    // 向导同时初始化世界卡（§4.8）：人物栏 → characters，世界观 → place
    s.world.place = firstSentence(worldText, 40);
    s.world.characters = chars.map(c => ({
      name: c.name, presence: '在场', personality: c.personality, speech: c.speech, note: '', noteLocked: false,
    }));
    story = s;
    closeModal('modal-wizard');
    enterGame(true, { deferOpening: true });
    openAnchor({ onDone: runOpening });   // §12：剧情模式「向导 → 试画 → 开场」
  }

  function createStoryImmediate(mode) {
    // R13：rp 开局 = 选角色卡（自建空白表单 / 导入 PNG），开场白由卡写、直接进日志
    if (mode === 'rp') { openCardEditor({ mode: 'new' }); return; }
    const s = Store.newStory({
      title: '对话 · ' + fmtTime(Date.now()),
      premise: CHAT_PREMISE,
      mode: 'chat',
    });
    story = s;
    enterGame(true);
  }

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
    if (story && (story.mode === 'chat' || story.mode === 'rp')) {
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
      if (args.world && typeof args.world === 'object') IR.Context.mergeWorld(story.world, args.world);
      if (args.relationship) IR.Context.mergeWorld(story.world, { relationship: args.relationship });
      // 画像条目按开关 / 范围写入（关开关即停止收集，§4.12）
      if (Array.isArray(args.profile)) applyProfileEntries(args.profile);
      summary = args.text ? ('更新记忆：' + args.text) : '更新记忆';
    } else if (name === 'recall_world_state') summary = '查阅了世界状态卡';
    else if (name === 'recall_style_card') summary = '查阅了视觉设定卡';
    else if (name === 'request_image') summary = '排队生图';   // §3.A.6：chat / rp 没有画师，措辞中立
    else if (name === 'schedule_once') summary = '安排了一次主动联系（待确认）';
    else if (name === 'schedule_heartbeat') summary = '安排了定时主动联系（待确认）';
    else if (name === 'schedule_cron') summary = '安排了日历主动联系（待确认）';
    else if (name === 'list_triggers') summary = '查看了主动联系安排';
    else if (name === 'cancel_trigger') summary = '取消了主动联系安排';
    story.log.push({ type: 'tool', tool: name, summary, ts: Date.now() });
  }

  function absorbReply(reply) {
    if (reply.world) IR.Context.mergeWorld(story.world, reply.world);
    if (Array.isArray(reply.tool_calls)) for (const c of reply.tool_calls) applyToolCall(c);
    // chat / rp 纯文本没有 scene_summary：拿旁白原文当画面参考，免得「🎨 作画」越画越旧
    if (story && (story.mode === 'chat' || story.mode === 'rp') && !reply.scene_summary && reply.narration) {
      story.lastSceneSummary = String(reply.narration).replace(/\s+/g, ' ').slice(0, 120);
    }
  }

  // 书记员是否可用于「模型任务」（压缩摘要 / 滚动风格摘要）：
  // 开关开启 + 书记员已启用 + 配了模型与适配器
  function scribeUsable() {
    const sc = settings.scribe || {};
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
        const recent = story.log.filter(l => l.type === 'narration').slice(-12).map(l => '· ' + l.text).join('\n');
        const said = story.log.filter(l => l.type === 'player' || l.type === 'choice').slice(-12).map(l => '· ' + l.text).join('\n');
        const raw = await IR.ChatProviders[cfg.provider].chat(cfg, [
          { role: 'system', content: SCRIBE_SYSTEM },
          {
            role: 'user',
            content: '[当前世界卡]\n' + IR.Context.worldCardText(story.world)
              + '\n\n[最近剧情]\n' + (recent || '（无）')
              + '\n\n[玩家最近说过的话]\n' + (said || '（无）')   // R13：画像提取的来源
              + '\n\n' + scribeProfileHint(),
          },
        ]);
        result = parseScribe(raw);
      }
    } catch (_) { result = null; }
    if (!result) result = IR.Context.localScribe(story.world);
    // 书记员是整卡重写（最终仲裁）：允许空数组清空
    if (result.world) IR.Context.mergeWorld(story.world, result.world, { allowEmpty: true });
    if (result.profile && result.profile.length) applyProfileEntries(result.profile);   // R13：顺手提取的画像
    story.world.scribeAt = Date.now();
    story.log.push({ type: 'tool', tool: 'scribe', summary: (result.diff || []).join('；') || '书记员校对完成', ts: Date.now() });
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
    const parts = ['[当前世界状态卡]\n' + IR.Context.worldCardText(story.world)];
    parts.push('[待压缩的原回合]（按幕分组，越靠前越旧）');
    let n = (story.summaries || []).length;
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
    if (!story || !scribeUsable()) return null;
    const plan = IR.Context.planCompression(story, { contextWindow: chatContextWindow() });
    if (!plan) return null;
    const cfg = resolveSub('scribe');
    const raw = await IR.ChatProviders[cfg.provider].chat(cfg, [
      { role: 'system', content: SCRIBE_COMPRESS_SYSTEM },
      { role: 'user', content: buildCompressInput(plan.groups) },
    ]);
    const parsed = parseScribeCompress(raw);
    if (!parsed || !parsed.summaries.length) return null;

    story.summaries = (story.summaries || []).concat(parsed.summaries);
    story.messages = story.messages.slice(plan.candidate.length);
    IR.Context.trimSummaries(story.summaries, IR.Context.DEFAULT_MAX_SUMMARIES);
    if (parsed.world) IR.Context.mergeWorld(story.world, parsed.world, { allowEmpty: true });
    if (parsed.profile && parsed.profile.length) applyProfileEntries(parsed.profile);   // R13
    story.world.scribeAt = Date.now();
    story.log.push({
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
    if (!story || !scene || !scribeUsable()) return;
    const sid = story.id;
    const cfg = resolveSub('scribe');
    const cur = IR.Context.rollingStyleText(story.rollingStyle);
    const card = story.styleCard;
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
      if (!rs || !story || story.id !== sid) return;    // 中途换档 / 回档：丢弃结果
      const target = story.rollingStyle = Object.assign(Store.defaultRollingStyle(), story.rollingStyle || {});
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
    if (!story) return;
    let comp = null;
    // 真实模式：书记员一次调用做「压缩 + 校对」（C-B 双职）
    if (scribeUsable()) {
      try { comp = await runSmartCompress(); } catch (_) { comp = null; }
    }
    if (!comp) {
      // 未触发 / 失败：本地确定性摘要器兜底（不花 API）
      try {
        comp = IR.Context.compressStory(story, {
          summarize: IR.Context.localSummarize,
          contextWindow: chatContextWindow(),   // T-M-1：登记表 / 手填容量 → 70% 阈值
        });
      } catch (_) { comp = null; }
      if (comp) story.log.push({ type: 'tool', tool: 'compress', summary: comp.compressedTurns + ' 幕压入摘要栈', ts: Date.now() });
      // 本地压缩没有重写世界卡：按每 N 回合单独校对
      const every = Math.max(1, +settings.scribe.every || 10);
      if (settings.scribe.enabled && story.turn > 0 && story.turn % every === 0) {
        await runScribe();
      }
    }
    // R13 用户画像：真实模式由书记员顺手提取（上面两条路径）；失败退回本地规则
    if (profileOn() && !scribeUsable()) collectProfileLocal();
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
    story.log.push(e);
  }

  // AI1 原始对话里的 assistant 条目：reasoning 一并存档（不进请求体，§4.5）
  function assistantMessage(reply, reasoning) {
    const m = { role: 'assistant', content: JSON.stringify(slimReply(reply)) };
    if (reasoning) m.reasoning = clipReasoning(reasoning);
    return m;
  }

  function maybeEnqueueImage(reply, isOpen, nodeId) {
    // 去重（§4.7）：本轮 AI1 已经用 request_image 出过图 → 时机出图跳过，同轮不画两张
    if (turnPaintedByTool) { turnPaintedByTool = false; return; }
    // §3.E.3：对话 / 扮演没有「时机出图」——图只来自模型调用工具或手动按钮（默认行为改动，见 CHANGELOG）
    if (story && (story.mode === 'chat' || story.mode === 'rp')) return;
    const mode = settings.trigger;
    let want = false;
    if (mode === 'every') want = true;
    else if (mode === 'choice' && (lastActionWasChoice || isOpen || story.turn === 1)) want = true;
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

  // 流式思考链（方案 B）：写进固定小窗，并始终滚到最新——点开看全量也不暂停
  function updateLiveReasoning() {
    if (!live) return;
    const el = $('#chat-scroll').querySelector('.reason-live-text');
    if (!el) { renderChat(); return; }
    el.textContent = live.reasoning || '';
    const panel = el.parentElement;
    if (panel) panel.scrollTop = panel.scrollHeight;
    scrollChatBottom();
  }

  /* ---------- P5-1 工具护栏：显式 400 拒绝 tools 的模型记住后不再下发（§4.5） ---------- */

  function noToolsKey(cfg) {
    return String((cfg && cfg.baseUrl) || '').replace(/\/+$/, '') + '|' + String((cfg && cfg.model) || '');
  }
  function noToolsFor(cfg) {
    return (settings.noTools || []).some(x => noToolsKey(x) === noToolsKey(cfg));
  }
  function rememberNoTools(cfg) {
    if (!cfg || !cfg.model) return;
    settings.noTools = (settings.noTools || []).filter(x => noToolsKey(x) !== noToolsKey(cfg));
    settings.noTools.push({ baseUrl: String(cfg.baseUrl || ''), model: String(cfg.model || ''), at: Date.now() });
    if (settings.noTools.length > 20) settings.noTools = settings.noTools.slice(-20);
    saveAll();
    renderNoToolsHint();
  }
  function renderNoToolsHint() {
    const el = $('#s-notools-hint');
    if (!el) return;
    const list = settings.noTools || [];
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
          if (!live) live = { text: '', reasoning: '' };
          live.text = cleanStream(preview);
          if (!liveEl) liveEl = $('#chat-scroll').querySelector('.bubble-live');
          if (liveEl) liveEl.textContent = live.text.slice(-1200);
          // 正文已开始流式 → 思考窗卷成一行（方案 B：不推走正文，也不骤折）
          if (liveReasonEl && !liveReasonCollapsed) {
            liveReasonCollapsed = true;
            liveReasonEl.classList.add('collapsed');
          }
          scrollChatBottom();
        },
        onReasoning(piece) { if (hooks && hooks.onReasoning) hooks.onReasoning(piece); },
        onToolCalls(calls) { if (hooks && hooks.onToolCalls) hooks.onToolCalls(calls); },
        onAborter(ctrl) { chatAbortCtrl = ctrl; },   // P0-1：「停止」按钮中断当前请求
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
        ? { onReasoning: hooks.onReasoning, onAborter(ctrl) { chatAbortCtrl = ctrl; } }
        : { onAborter(ctrl) { chatAbortCtrl = ctrl; } };
      text = await adapter.chat(cfg, messages, fbHooks);
      streamed = false;
    }
    return { text, streamed };
  }

  // 本回合是否已由工具出图（用于「工具已出图则跳过本轮时机出图」去重，§4.7）。
  // v0.5.1 起在**提交任务时**置位（原来是出图完成后），消费点（maybeEnqueueImage、开局路径）不变。
  let turnPaintedByTool = false;

  // 回合锚点（§3.A.4）：request_image 在 commit 之前提交、节点还没创建——任务提交时带上它；
  // 回合 commit 成功后补 nodeId，失败 / 主动停止置 dead；任务开跑前与写回前各核一次。
  let turnAnchor = { nodeId: null, dead: false };

  /* ================= 可选本地服务（sidecar）：调度工具与主动消息 ================= */

  // 调度工具只在「对话 / 扮演」+ 本地服务在线 + 后端已开启调度时才下发
  function scheduleToolsAvailable() {
    const S = IR.Sidecar;
    if (!S || typeof S.isOnline !== 'function' || !S.isOnline()) return false;
    const st = S.status();
    return !!(st.features && st.features.schedule && st.hasToken);
  }

  // 邮件 / 下单工具同样只在「本地服务在线 + 对应 feature 开启 + 有 token」时下发；
  // 另外 toolsForMode 只在 chat（智能体）模式放行（红线 7）。
  function proposalToolsAvailable() {
    const S = IR.Sidecar;
    if (!S || typeof S.isOnline !== 'function' || !S.isOnline()) return { email: false, payment: false };
    const st = S.status();
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
    if (!S || !S.isOnline()) {
      return '[调度失败] 本地服务没有在运行。请告诉用户：先在「设置 → 本地服务」里启动它，否则没法定时主动联系。';
    }
    try {
      if (name === 'schedule_once') {
        const at = parseWhen(a.at);
        if (!at) return '[调度失败] at 需要 ISO 8601 时间，例如 2026-10-11T09:00:00+08:00。';
        const t = await S.upsertTrigger({
          name: a.name, type: 'once', spec: { at: at },
          prompt: a.prompt, reason: a.reason, channel: story ? story.id : '', source: 'model',
        });
        return '[已提交，待用户确认] 一次性安排「' + t.name + '」定在 ' + fmtTime(at) + '；用户确认前不会触发。';
      }
      if (name === 'schedule_heartbeat') {
        const mins = Math.max(1, Math.floor(Number(a.everyMinutes) || 0));
        const t = await S.upsertTrigger({
          name: a.name, type: 'interval', spec: { everyMs: mins * 60000 },
          prompt: a.prompt, reason: a.reason, channel: story ? story.id : '', source: 'model',
        });
        return '[已提交，待用户确认] 每隔 ' + mins + ' 分钟的安排「' + t.name + '」已创建；用户确认前不会触发。';
      }
      if (name === 'schedule_cron') {
        const t = await S.upsertTrigger({
          name: a.name, type: 'cron', spec: { expr: a.expr, tz: a.tz || '' },
          prompt: a.prompt, reason: a.reason, channel: story ? story.id : '', source: 'model',
        });
        return '[已提交，待用户确认] 日历安排「' + t.name + '」：' + a.expr + '（' + (a.tz || 'UTC') + '）。';
      }
      if (name === 'list_triggers') {
        const list = await S.listTriggers();
        if (!list.length) return '[现有安排] 目前没有任何主动联系安排。';
        return '[现有安排]\n' + list.map(t =>
          '- ' + t.name + '（' + t.status + ' · ' + describeTrigger(t) + '）原因：' + (t.reason || '未写')
          + (t.channel ? '［仅当前会话］' : '')).join('\n');
      }
      if (name === 'cancel_trigger') {
        const want = String(a.name || '').trim();
        const list = await S.listTriggers();
        const hit = list.filter(t => t.name === want)[0];
        if (!hit) return '[取消失败] 没有叫「' + want + '」的安排（可以先 list_triggers 看看）。';
        await S.cancelTrigger(hit.id);
        if (typeof renderTriggerList === 'function') { try { renderTriggerList(); } catch (_) {} }
        return '[已取消] 安排「' + hit.name + '」已删除。';
      }
      return '[调度失败] 未知的调度动作：' + name;
    } catch (e) {
      return '[调度失败] ' + ((e && e.message) || e);
    }
  }

  /* ---- 侧车连接状态与主动消息投递 ---- */

  function sidecarReady() {
    const S = IR.Sidecar;
    return !!(S && typeof S.isOnline === 'function' && S.isOnline() && S.status().hasToken);
  }

  function sidecarOffHint() {
    return '需要启动本地服务：在项目目录运行 node sidecar/server.mjs，再把终端打印的 token 填到「设置 → 本地服务」。';
  }

  function renderSidecarStatus() {
    const S = IR.Sidecar;
    const st = S ? S.status() : { online: false, hasToken: false, features: {}, lastError: '' };
    const el = $('#sidecar-state');
    if (el) {
      el.textContent = st.online
        ? (st.hasToken ? '本地服务在线' : '本地服务在线（还没填 token）')
        : ('未启动' + (st.lastError ? '：' + st.lastError : ''));
      el.className = 'sidecar-state ' + (st.online ? 'on' : 'off');
    }
    // 三个功能分区：没连上 / 没 token 就整体灰显（安全项真源在侧车，读不到就别给假象）
    const ready = !!(st.online && st.hasToken);
    for (const id of ['#fs-email', '#fs-schedule', '#fs-payment']) {
      const fs = $(id);
      if (fs) fs.classList.toggle('feature-off', !ready);
    }
    renderFeatureBar();
  }

  // 邮件 / 定时主动 / 代下单只在「对话 / 扮演」模式可用：剧情模式里既不能出现，
  // 也不能被触发（入口函数自己也再挡一次，不依赖界面是否渲染）。
  function featuresAllowed() {
    return !!(story && (story.mode === 'chat' || story.mode === 'rp'));
  }

  // 局内功能入口：只有「对话 / 扮演」模式才有「＋」菜单；本地服务没启动时菜单项灰显
  function renderFeatureBar() {
    const plus = $('#btn-more-actions');
    const menu = $('#feature-menu');
    const state = $('#feature-bar-state');
    if (!plus || !menu) return;
    const allowed = featuresAllowed();
    plus.classList.toggle('hidden', !allowed);
    if (!allowed) {
      menu.classList.add('hidden');
      plus.setAttribute('aria-expanded', 'false');
      return;
    }
    const S = IR.Sidecar;
    const st = S ? S.status() : { online: false, hasToken: false, features: {} };
    const ready = !!(st.online && st.hasToken);
    // 「✉ 写邮件」「🛒 代下单」只在智能体（chat）下显示；扮演（rp）只留「⏰ 定时主动」（v0.6.0 行为变更，见 CHANGELOG）
    const isChat = !!(story && story.mode === 'chat');
    const emBtn = $('#btn-feat-email');
    if (emBtn) emBtn.classList.toggle('hidden', !isChat);
    const pmBtn = $('#btn-feat-payment');
    if (pmBtn) pmBtn.classList.toggle('hidden', !isChat);
    for (const sel of ['#btn-feat-email', '#btn-feat-schedule', '#btn-feat-payment']) {
      const b = $(sel);
      if (!b || b.classList.contains('hidden')) continue;
      b.disabled = !ready;
      b.title = ready ? '' : sidecarOffHint();
    }
    if (state) {
      if (!st.online) state.textContent = '本地服务未启动：写邮件 / 定时主动 / 代下单需要先启动本地服务。';
      else if (!st.hasToken) state.textContent = '本地服务在线，但还没填 token（设置 → 本地服务）。';
      else {
        const names = { email: '邮件', schedule: '定时主动', payment: '购物支付' };
        const on = ['email', 'schedule', 'payment'].filter(k => st.features && st.features[k]).map(k => names[k]);
        state.textContent = on.length ? ('已开启：' + on.join('、')) : '都还没在设置里开启。';
      }
    }
  }

  /* ---------- 下拉菜单（顶栏「⋯」/ 输入区「＋」） ---------- */
  function closeMenus(except) {
    for (const menu of document.querySelectorAll('.menu')) {
      if (menu === except) continue;
      menu.classList.add('hidden');
    }
    for (const btn of document.querySelectorAll('[aria-expanded="true"]')) {
      if (except && btn.getAttribute('aria-controls') === except.id) continue;
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  function toggleMenu(btn, menu) {
    if (!btn || !menu) return;
    const willOpen = menu.classList.contains('hidden');
    closeMenus(willOpen ? menu : null);
    menu.classList.toggle('hidden', !willOpen);
    btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen && menu === $('#feature-menu')) renderFeatureBar();
  }

  function yuan(cents) { return (Math.floor(Number(cents) || 0) / 100).toFixed(2) + ' 元'; }

  function irDownloadText(filename, text) {
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { toast('导出失败：' + ((e && e.message) || e), true); }
  }

  // 页面打开 / 重新上线时补跑：把侧车里排队的触达捞回来（页面关着时侧车只入队，不打扰）
  async function pullProactive() {
    const S = IR.Sidecar;
    const F = IR.Features;
    if (!S || !F || !S.isOnline() || !S.status().hasToken) return;
    try {
      const list = await S.listPending();
      for (const p of list) {
        if (p.channel && story && p.channel !== story.id) continue;   // 指定了别的会话就跳过
        F.accept({ fireId: p.id, prompt: p.prompt, name: p.name, reason: p.reason });
      }
    } catch (_) { /* 拉不到就等下一次 */ }
  }

  async function ackProactive(fireId) {
    const S = IR.Sidecar;
    if (!S || !fireId) return;
    try { await S.ackPending(fireId); } catch (_) {}
  }

  function initFeatures() {
    const F = IR.Features;
    if (!F) return;
    F.attach({
      // 什么时候能把主动消息送进回合流程：不忙、有故事、是对话 / 扮演模式、且在线
      canDeliver: () => !busy && !!story && (story.mode === 'chat' || story.mode === 'rp')
        && (typeof navigator === 'undefined' || navigator.onLine !== false),
      deliver: async payload => {
        if (!payload || !payload.prompt) return;
        await sendPlayerAction(payload.prompt, false, {
          kind: 'agent',
          triggerName: payload.name || '',
          reason: payload.reason || '',
          fireId: payload.fireId || '',
        });
      },
    });
  }

  function initSidecar() {
    const S = IR.Sidecar;
    if (!S) return;
    S.configure(settings.sidecar || {});
    S.on('state', () => {
      renderSidecarStatus();
      if (S.isOnline() && S.status().hasToken) { pullProactive(); loadFeatureConfig(); }
    });
    S.on('fire', payload => { if (IR.Features) IR.Features.accept(payload); });
    S.on('changed', () => { if (typeof renderTriggerList === 'function') { try { renderTriggerList(); } catch (_) {} } });
    S.start();
    renderSidecarStatus();
    pullProactive();
    if (sidecarReady()) loadFeatureConfig();
  }

  /* ---- 设置分区：安全项读写（真源在侧车 config.json，这里只是编辑界面） ---- */

  async function loadFeatureConfig() {
    if (!sidecarReady()) { renderSidecarStatus(); return; }
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
    if (!sidecarReady()) return;
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
      renderSidecarStatus();
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
    if (!sidecarReady()) {
      box.textContent = sidecarOffHint();
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
    if (!sidecarReady()) { box.textContent = '（本地服务未启动）'; return; }
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
    if (!sidecarReady()) { box.textContent = '（本地服务未启动）'; return; }
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
    if (!featuresAllowed() || !story || story.mode !== 'chat') { toast('写邮件只在智能体模式可用：切到智能体模式再用', true); return; }
    if (!sidecarReady()) { toast(sidecarOffHint(), true, true); return; }
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
    if (!sidecarReady()) { box.textContent = sidecarOffHint(); if (sum) sum.textContent = ''; return; }
    try {
      const r = await IR.Sidecar.paymentTransactions(20);
      const list = (r && r.transactions) || [];
      const s = await IR.Sidecar.paymentSummary('');
      if (sum && s && s.summary) {
        sum.textContent = '今日已用 ' + yuan(s.summary.spent.daily) + ' · 本月 ' + yuan(s.summary.spent.monthly)
          + ' · 每日剩余 ' + yuan(s.summary.remaining.daily);
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
        head.textContent = yuan(t.amountCents) + ' · ' + (t.merchant || '（未填商户）');
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
            if (rr && rr.receipt) irDownloadText('收据-' + t.intentId + '.txt', rr.receipt.text);
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
    if (!featuresAllowed() || !story || story.mode !== 'chat') { toast('代下单只在智能体模式可用：切到智能体模式再用', true); return; }
    if (!sidecarReady()) { toast(sidecarOffHint(), true, true); return; }
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
          '金额：' + yuan(amountCents),
          '商户：' + (merchant || '（未填）'),
          '品类：' + (category || '（未填）'),
        ];
        if (itemsText) lines.push('商品：' + itemsText);
        lines.push('', '每日剩余：' + yuan(rem.daily || 0) + ' · 每月剩余：' + yuan(rem.monthly || 0), '', '确认后才会真正扣款。');
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
        turnPaintedByTool = true;   // §3.A.3：提交即置位（原来是出图完成后）
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
    return '[已提交，待用户确认] 下单 ' + yuan(p.args.amountCents) + '（' + (p.args.merchant || '未填商户') + '）；用户确认前不会扣款。不要说已经付款。';
  }

  // 调 AI1；带工具时：工具调用 → 留痕 + 副作用 + 单次重发（§4.5）
  async function callAI1(playerAction, opts) {
    opts = opts || {};
    const cfg = settings.chat;
    const adapter = IR.ChatProviders[cfg.provider] || IR.ChatProviders['openai-compatible'];

    turnPaintedByTool = false;   // 本轮工具出图标记（§4.7 去重用）
    turnAnchor = { nodeId: null, dead: false };   // §3.A.4：本回合锚点，工具出图任务提交时带上
    // C-E 启发式注入（T-P5-3）：玩家输入命中世界卡 / 伏笔实体词 → 本轮自动带上对应条目（与工具召回并行）。
    // 只在「新回合」留痕（重试不重复记），条目本身由 assembleAI1 注入，用户可在留痕面板看到：静默忽略工具时也照带。
    const prevEntry = story.log[story.log.length - 1];
    if (prevEntry && (prevEntry.type === 'player' || prevEntry.type === 'choice')) {
      const hit = IR.Context.matchEntityTerms(playerAction, story.world);
      if (hit.terms.length) pushLog({ type: 'tool', tool: 'heuristic', summary: '自动带上相关记忆：' + hit.terms.join('、') });
    }
    // 🧠 注入记忆（§4.4 手动层）：一次性，本轮把完整记忆直接压进上下文（不用 tool_choice，第十六轮定案）
    const forceInject = pendingInject;
    if (forceInject) {
      pendingInject = false;
      renderInjectHint();
      pushLog({ type: 'system', text: '已注入完整记忆（世界卡 + 设定 + 视觉设定卡）：本轮先复述处境再继续' });
    }
    live = { text: '', reasoning: '' };
    liveReasonEl = null;
    liveReasonCollapsed = false;
    liveReasonOpen = false;
    renderChat();
    liveEl = $('#chat-scroll').querySelector('.bubble-live');

    const toolsOn = opts.tools !== false && !opts.recall
      && settings.toolsEnabled !== 'off' && !noToolsFor(cfg);
    // 调度工具只在「对话 / 扮演」+ 本地服务在线 + 后端已开启调度时追加；剧情模式工具集不变
    const schedTools = toolsOn && scheduleToolsAvailable();
    // 邮件 / 下单（提案制）只在智能体（chat）+ 对应 feature 开启时追加（红线 7；toolsForMode 内部再挡一次模式）
    const propTools = toolsOn ? proposalToolsAvailable() : { email: false, payment: false };
    const toolOpts = { schedule: schedTools, email: propTools.email, payment: propTools.payment };
    const asmOpts = Object.assign({}, opts);
    if (toolsOn) asmOpts.tools = IR.Context.toolNamesForMode(story.mode, toolOpts);
    if (forceInject) asmOpts.forceInject = true;
    asmOpts.profile = activeProfileEntries();   // R13：画像按开关 / 范围注入（关则空数组，零成本）
    asmOpts.contextWindow = chatContextWindow();   // P1-3：组装窗口按 token 动态装（context.js fitWindow）
    // P1-5（2026-10-14）：组装前先查预算，超了就地用本地摘要先压再组——此前是「先组后压」
    //（postTurn 收尾才压），越过 70% 阈值的那一回合会超发一轮（严格的服务端直接拒）。
    // 本地摘要确定性、不花 API；后续 postTurn 的书记员照常处理新批次。
    try {
      const cw = asmOpts.contextWindow;
      if (cw > 0 && IR.Context.estimateContextTokens(story, playerAction, asmOpts) > Math.floor(cw * IR.Context.COMPRESS_RATIO)) {
        IR.Context.compressStory(story, { summarize: IR.Context.localSummarize, contextWindow: cw });
      }
    } catch (_) { /* 压缩失败不拦回合：最坏按原样发 */ }
    const messages = IR.Context.assembleAI1(story, playerAction, asmOpts);
    const cfgTools = toolsOn
      ? Object.assign({}, cfg, { tools: IR.Context.toolsForMode(story.mode, toolOpts) })
      : cfg;

    let streamedCalls = [];
    let reasoning = '';
    const first = await streamAI1(adapter, cfgTools, messages, {
      onToolCalls(calls) { streamedCalls = streamedCalls.concat(toolList(calls)); },
      onReasoning(piece) { reasoning += piece; if (live) live.reasoning = reasoning; updateLiveReasoning(); },
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
        IR.Context.assembleAI1(story, playerAction, secondOpts),
        { onReasoning(piece) { reasoning += piece; if (live) live.reasoning = reasoning; updateLiveReasoning(); } });
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
    const k = story && story.ui && story.ui.kind;
    return (k === 'say' || k === 'direct') ? k : 'do';
  }
  // 外层前缀 [玩家行动] 保持不变（demo.js 靠它分派），类型标记作为内层前缀。
  // v0.6.0：chat（智能体）不做 / 说 / 导演——内层标记直接不加（组装历史时另有 stripKindMarker 兼容旧档）。
  function withKindMarker(text, kind) {
    const raw = String(text == null ? '' : text);
    if (story && story.mode === 'chat') return raw;
    const k = (kind === 'say' || kind === 'direct') ? kind : 'do';
    return '（' + KIND_LABELS[k] + '）' + raw;
  }
  function syncKindSwitch() {
    const k = currentKind();
    // chat（智能体）没有做 / 说 / 导演：整组开关隐藏（story.ui.kind 保留不清）
    const sw = $('#kind-switch');
    if (sw) sw.classList.toggle('hidden', !!(story && story.mode === 'chat'));
    document.querySelectorAll('#kind-switch .seg-btn').forEach(b => {
      const on = b.dataset.kind === k;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const inp = $('#player-input');
    if (inp) {
      inp.placeholder = (story && story.mode === 'chat') ? '说点什么，或交给我办件事……'
        : k === 'say' ? '说点什么……'
        : k === 'direct' ? '写一句导演指令（世界里的既成事实）……'
        : '做点什么，或说句话……';
    }
  }

  // meta.kind === 'agent'：这条是「模型主动找你」（来自调度触发），不是玩家输入
  async function sendPlayerAction(action, isChoice, meta) {
    if (busy || !story) return;
    action = String(action || '').trim();
    if (!action) return;
    if (offlineBlocked('这条消息')) return;
    const agentMsg = !!(meta && meta.kind === 'agent');
    // chat（智能体）：玩家条目 kind 恒为 'do'，发给模型的行动不带内层标记（withKindMarker 对 chat 直接返回原文）
    const chatMode = !!(story && story.mode === 'chat');
    const kind = isChoice ? 'do'
      : (agentMsg ? null
        : chatMode ? 'do'
        : (((meta && meta.actKind) === 'say' || (meta && meta.actKind) === 'direct') ? meta.actKind : currentKind()));
    const sentAction = kind ? withKindMarker(action, kind) : action;
    busy = true;
    stopRequested = false; chatAbortCtrl = null;   // P0-1：每回合复位停止标记
    lastActionWasChoice = !!isChoice;
    currentChoices = [];
    choicesTrayOpen = false;
    setSendButtonsBusy(true);   // P0-1：busy 期间发送按钮变身「停止」

    const mark = IR.Tree.begin(story);   // 记 logMark：必须在 pushLog 之前（§4.1）
    pushLog(agentMsg
      ? { type: 'agent', text: action, trigger: meta.triggerName || '', reason: meta.reason || '', fireId: meta.fireId || '' }
      : { type: isChoice ? 'choice' : 'player', text: action, kind: kind || 'do' });
    renderChat();

    try {
      const res = await callAI1(sentAction);
      const reply = res.reply;
      story.turn += 1;
      story.lastSceneSummary = reply.scene_summary || story.lastSceneSummary;
      const userMsg = { role: 'user', content: IR.Context.playerContent(story.premise, sentAction) };
      const asst = assistantMessage(reply, res.reasoning);
      story.messages.push(userMsg, asst);
      pushNarrationEntry(reply.narration, res.reasoning);
      await finishNarration(res.streamed);
      absorbReply(reply);
      currentChoices = reply.choices;
      renderChat();
      // §4.1 回合落节点：entries = log.slice(logMark)，head 前移；失败 / 停止不建节点
      const node = IR.Tree.commit(story, {
        action: {
          type: agentMsg ? 'agent' : (isChoice ? 'choice' : 'player'),
          text: action, kind: kind || null, sent: sentAction,
        },
        userMsg: userMsg, assistantMsg: asst, logMark: mark.logMark,
      });
      turnAnchor.nodeId = node.id;                // §3.A.4：锚点补 nodeId，后台出图任务写回时落位
      maybeEnqueueImage(reply, false, node.id);   // nodeId 随任务走（§4.4）
      await postTurn();
      IR.Tree.seal(story, node.id);               // 必须在 postTurn 之后（§10）：收进压缩 / 书记员的 tool 条目
      if (agentMsg && meta.fireId) await ackProactive(meta.fireId);   // 已送达：从侧车队列里销掉
    } catch (e) {
      live = null;
      turnAnchor.dead = true;   // §3.A.4：失败 / 停止——本回合排队中与在途的工具出图丢弃
      if (isStopError(e)) {   // P0-1：玩家主动停止——不算故障，不弹错误提示
        story.log.push({ type: 'narration', text: '（已停止。点「↻ 重试」或再试一次。）', versions: [], ts: Date.now() });
      } else {
        toast(netErrHint(e), true, true);
        story.log.push({ type: 'narration', text: '（AI 走神了，点「↻ 重试」或再试一次吧。）', versions: [], ts: Date.now() });
      }
      renderChat();
    } finally {
      busy = false;
      stopRequested = false; chatAbortCtrl = null;
      live = null; liveEl = null;
      setSendButtonsBusy(false);
      renderChat();
      if (IR.Features) IR.Features.drain();   // 忙完了，看看排队的主动消息能不能送
    }
  }

  // 旁白已进 log：流式就直接落定；非流式用打字机补观感
  async function finishNarration(streamed) {
    if (streamed) { live = null; return; }
    const el = liveEl || $('#chat-scroll').querySelector('.bubble-live');
    // 非流式：正文来了，思考窗同样卷成一行（与流式收尾一致）
    if (liveReasonEl && !liveReasonCollapsed) {
      liveReasonCollapsed = true;
      liveReasonEl.classList.add('collapsed');
    }
    const text = (story.log[story.log.length - 1] || {}).text || '';
    if (el) await typewrite(el, text);
    live = null;
  }

  // 开局第一幕：让 AI1 主动给出开场旁白与选项（不记录为玩家行动）
  // P2-11（2026-10-14）：实际请求与存档此前是两句不同的话，retryLast 会以存档版重发、与首发不一致——统一成常量
  const OPENING_ACTION = '（故事开场。请描写第一幕，把玩家带进场景。）';

  async function runOpening() {
    if (busy || !story) return;
    busy = true;
    stopRequested = false; chatAbortCtrl = null;   // P0-1
    setSendButtonsBusy(true);
    const mark = IR.Tree.begin(story);             // 记 logMark（§4.1）
    try {
      const res = await callAI1(OPENING_ACTION, { includePremise: true });
      const reply = res.reply;
      story.turn += 1;
      story.lastSceneSummary = reply.scene_summary || '';
      const userMsg = { role: 'user', content: IR.Context.playerContent(story.premise, OPENING_ACTION, { includePremise: true }) };
      const asst = assistantMessage(reply, res.reasoning);
      story.messages.push(userMsg, asst);
      pushNarrationEntry(reply.narration, res.reasoning);
      await finishNarration(res.streamed);
      absorbReply(reply);
      currentChoices = reply.choices;
      renderChat();
      // 开局同样是节点（§4.1）：action.type = 'opening'，sent = OPENING_ACTION
      const node = IR.Tree.commit(story, {
        action: { type: 'opening', text: OPENING_ACTION, kind: null, sent: OPENING_ACTION },
        userMsg: userMsg, assistantMsg: asst, logMark: mark.logMark,
      });
      turnAnchor.nodeId = node.id;                 // §3.A.4：锚点补 nodeId
      await postTurn();
      IR.Tree.seal(story, node.id);                // 必须在 postTurn 之后（§10）
      if (turnPaintedByTool) turnPaintedByTool = false;                        // 开局这一轮工具已出图 → 不再时机出图
      else if (story.mode === 'chat' || story.mode === 'rp') { /* §3.E.3：对话 / 扮演没有时机出图 */ }
      else if (settings.trigger !== 'manual') enqueueImage(reply.scene_summary, node.id);
      else toast('已开局。想看画面随时点右上角「作画」。');
      saveAll();
    } catch (e) {
      live = null;
      turnAnchor.dead = true;   // §3.A.4：失败 / 停止分支同样置位
      if (isStopError(e)) {
        story.log.push({ type: 'narration', text: '（已停止。输入任意内容开始故事。）', versions: [], ts: Date.now() });
      } else {
        toast(netErrHint(e), true, true);
        story.log.push({ type: 'narration', text: '（AI 走神了，输入任意内容开始故事。）', versions: [], ts: Date.now() });
      }
      renderChat();
    } finally {
      busy = false;
      stopRequested = false; chatAbortCtrl = null;
      live = null; liveEl = null;
      setSendButtonsBusy(false);
      renderChat();
    }
  }

  function pushLog(entry) {
    if (!story) return;
    entry.ts = Date.now();
    story.log.push(entry);
  }

  /* ================= 重试与分支（R1 / §4.2、§4.3） ================= */

  function lastNarration() {
    if (!story) return null;
    for (let i = story.log.length - 1; i >= 0; i--) if (story.log[i].type === 'narration') return story.log[i];
    return null;
  }
  function lastNarrationIndex() {
    if (!story) return -1;
    for (let i = story.log.length - 1; i >= 0; i--) if (story.log[i].type === 'narration') return i;
    return -1;
  }
  function lastActionEntry() {
    if (!story) return null;
    for (let i = story.log.length - 1; i >= 0; i--) {
      const t = story.log[i].type;
      if (t === 'player' || t === 'choice') return story.log[i];
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
    const t = story && story.tree;
    return (t && t.nodes && t.nodes[t.head]) ? choicesFromMsg(t.nodes[t.head].assistantMsg) : [];
  }
  function treeHeadNodeId() {
    return (story && story.tree && story.tree.head) || null;
  }
  // 这个 log 条目属于哪个节点（§4.4 锚点）：node.entries 与 story.log 是同一批对象（project 按引用共享）
  function nodeIdOwningEntry(entry) {
    const t = story && story.tree;
    if (!t || !t.nodes || !entry) return null;
    for (const id of Object.keys(t.nodes)) {
      if ((t.nodes[id].entries || []).indexOf(entry) >= 0) return id;
    }
    return null;
  }
  // 图所属的节点：条目可能已滑出可见 log 窗口（末 120 条），按 node.scenes 里的 scene id 再找一遍
  function nodeIdOwningScene(sceneId) {
    const t = story && story.tree;
    if (!t || !t.nodes || !sceneId) return null;
    for (const id of Object.keys(t.nodes)) {
      if ((t.nodes[id].scenes || []).some(s => s && s.id === sceneId)) return id;
    }
    return null;
  }

  /* ================= 重试 = 新增兄弟（§4.2） / 兄弟切换（§4.3） ================= */

  async function retryLast() {
    if (busy || !story) return;
    const tree = story.tree;
    const old = tree && tree.nodes && tree.nodes[tree.head];
    // §4.2：重试是在父节点下新增兄弟；当前 head 必须是已结算的回合节点
    if (!old || old.kind !== 'turn' || !old.sealed || !old.action) { toast('还没有可以重试的回合'); return; }
    const act = old.action;
    const isRetryOpening = act.type === 'opening';
    const sent = act.sent || withKindMarker(act.text, act.kind);
    const userMsg = old.userMsg || { role: 'user', content: IR.Context.playerContent(story.premise, sent) };

    // 世界卡 / 摘要 / 消息窗口先回到「这一回合发生之前」——对旧行为的修正（§10）：
    // 以前重试是在已被上一版改写过的世界卡上重来
    IR.Tree.switchTo(story, old.parent);
    story.turn += 1;            // 与正常回合同口径：turn 在提交前 +1
    currentChoices = [];

    busy = true;
    stopRequested = false; chatAbortCtrl = null;   // P0-1
    setSendButtonsBusy(true);
    renderChat();
    const mark = IR.Tree.begin(story);             // 记 logMark：必须在 pushLog 之前（§4.1）
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
      story.lastSceneSummary = reply.scene_summary || story.lastSceneSummary;
      const asst = assistantMessage(reply, res.reasoning);
      story.messages.push(userMsg, asst);          // userMsg 复用原文（不带重试后缀，§4.2）
      pushNarrationEntry(reply.narration, res.reasoning);
      await finishNarration(res.streamed);
      absorbReply(reply);
      currentChoices = reply.choices;
      renderChat();
      // 成功：parent = 原 head 的父节点（投影已停在那），落一个新兄弟
      const node = IR.Tree.commit(story, {
        action: { type: act.type, text: act.text, kind: act.kind || null, sent: act.sent || sent },
        userMsg: userMsg, assistantMsg: asst, logMark: mark.logMark,
      });
      turnAnchor.nodeId = node.id;   // §3.A.4：锚点补 nodeId
      await postTurn();
      IR.Tree.seal(story, node.id);
      saveAll();
    } catch (e) {
      // 失败 / 主动停止：回原 head，旧一对完整放回（§4.2）
      turnAnchor.dead = true;        // §3.A.4：失败分支置位，本次重试排队中的工具出图丢弃
      IR.Tree.switchTo(story, old.id);
      currentChoices = choicesFromHead();
      if (isStopError(e)) toast('已停止');
      else toast(netErrHint(e), true, true);
    } finally {
      busy = false;
      stopRequested = false; chatAbortCtrl = null;
      live = null; liveEl = null;
      setSendButtonsBusy(false);
      renderChat();
    }
  }

  // §4.3 兄弟切换：切到相邻兄弟，沿 active 下探到叶子（续写过的支线会回到它的末端）；不发任何请求
  function switchSiblingFromBubble(nid, dir) {
    if (!story || !nid) return;
    if (busy) { toast('正在生成中，等这一步结束再切分支'); return; }   // 沿用 showShelf 的做法（§4.1）
    const head = IR.Tree.switchSibling(story, nid, dir);
    if (!head) return;
    currentChoices = choicesFromHead();   // §4.3：选项跟着新 head 的 assistantMsg 走
    saveAll();
    renderChat(); renderStage(); renderThumbs(); renderStoryPanels(); renderSavepoints();
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
    if (!story) return;
    const tree = story.tree;
    const node = (nodeId && tree && tree.nodes) ? tree.nodes[nodeId] : null;
    if (nodeId && !node) return;
    const entry = { type: 'tool', tool: 'image', summary: summary, ts: Date.now() };
    if (node && node.sealed) IR.Tree.pushLate(story, node.id, entry);
    else story.log.push(entry);
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
    const storyId = story && story.id;
    const mode = story && story.mode;
    const a = args || {};
    // §3.E：对话 / 扮演直出（模型自己写提示词，不经画师）；剧情模式保持画师构思
    const direct = mode === 'chat' || mode === 'rp';
    const rawPrompt = String(a.prompt || '').trim() || String(a.subject || '').trim();
    const sceneRef = rawPrompt
      || (story && story.lastSceneSummary)
      || String((story && story.premise) || '').split('\n')[0] || 'story scene';
    const anchor = turnAnchor;   // 记住本回合的锚点对象（下一回合 callAI1 会换新对象）
    return submitPaint({
      key: null,
      anchor: anchor,
      storyId: storyId,
      nodeId: null,   // commit 前提交：写回时才从 anchor.nodeId 取（§3.A.4）
      run: () => runPaintTask({
        storyId: storyId,
        anchor: anchor,
        directPrompt: direct ? (rawPrompt || (story && story.lastSceneSummary) || 'atmospheric scene') : '',
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
    if (!story) return null;
    // 排队期间已换故事：直接取消，不花画师与生图额度
    if (opts.storyId && story.id !== opts.storyId) { toast('已切换故事，本次作画取消'); return null; }
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
        || story.lastSceneSummary || String(story.premise || '').split('\n')[0] || 'story scene';
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
    const storyId = story && story.id;   // 记住「为谁画的」：等图期间换档也不写错故事
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
    const storyId = story && story.id;   // 同上：任务自带故事 id，写入前核对
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
    return settings.stylePreset === 'custom'
      ? String(settings.styleCustom || '').trim()
      : (STYLE_PRESETS[settings.stylePreset] || '');
  }

  // P4：出图携带的画风后缀——已锚定用视觉设定卡关键词（卡优先），未锚定回退画风预设
  function styleSuffixText() {
    const card = story && story.styleCard;
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
    if (!story) return;
    const rs = story.rollingStyle = Object.assign(Store.defaultRollingStyle(), story.rollingStyle || {});
    const kw = (story.styleCard && story.styleCard.styleKeywords || []).filter(Boolean);
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
    const messages = IR.Context.assemblePainter(story, opts);
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
    const useTools = !!opts.tools && settings.toolsEnabled !== 'off';
    const cfg2 = useTools ? Object.assign({}, cfg, { tools: [IR.Context.RECALL_RECENT_PLOT_TOOL] }) : cfg;
    let raw;
    try {
      raw = await adapter.chat(cfg2, messages, hooks);
    } catch (e) {
      if (!useTools) throw e;
      raw = await adapter.chat(cfg, messages, hooks);   // 该模型不吃 tools：这一次不带工具重发
    }
    if (wantPlot && !opts.plot) {
      const raw2 = await adapter.chat(cfg, IR.Context.assemblePainter(story, Object.assign({}, opts, { plot: true })));
      return parsePainterReply(raw2);
    }
    return parsePainterReply(raw);
  }

  // 出一张图：调生图适配器 → 落 scene / log（可标记被替代的旧图，§2 supersededBy）
  async function runPaint(opts) {
    if (!story) return null;
    if (offlineBlocked('这次作画')) return null;
    const anchor = opts.anchor || null;
    // 工具出图在 commit 之前提交：写回时才从回合锚点取 nodeId（§3.A.4）
    const nodeId = opts.nodeId || (anchor && anchor.nodeId) || null;
    const cfgImg = imageCfg(opts.params);
    const imgAdapter = IR.ImageProviders[cfgImg.provider] || IR.ImageProviders['openai-images'];
    const src = await imgAdapter.generate(cfgImg, opts.prompt);

    // 写入前核对：等图期间换了故事 → 丢弃这张图，绝不写进别的故事
    if (opts.storyId && (!story || story.id !== opts.storyId)) {
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
    const tree = story.tree;
    const node = (nodeId && tree && tree.nodes) ? tree.nodes[nodeId] : null;
    if (nodeId && !node) {
      toast('这张图所属的回合已不在分支树里，刚画好的图已丢弃');
      return null;
    }
    const onPath = !node || IR.Tree.pathOf(story, tree.head).indexOf(node.id) >= 0;

    const scene = {
      id: 'sc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      prompt: opts.prompt, promptRaw: opts.promptRaw || '', alt: opts.alt || '',
      src, ts: Date.now(),
      model: cfgImg.model || '', size: cfgImg.size || '',
      aspect: cfgImg.aspect || '', width: cfgImg.width, height: cfgImg.height,
      styleCardId: story.styleCard ? (story.styleCard.id + '@' + (story.styleCard.version || 1)) : undefined,
    };
    scene.thumb = await thumb(src);
    // 原图以 Blob 存 IndexedDB（不再把 base64 塞进档案）；档案里只留一个引用键
    scene.imageId = await storeOriginal(scene.id, src, {
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
      IR.Tree.pushLate(story, node.id, scene);
      IR.Tree.pushLate(story, node.id, entry);
    } else {
      story.scenes.push(scene);
      story.log.push(entry);
    }
    if (onPath) {   // 不在当前分支 → 不动舞台 / 世界侧状态，也不泄漏进当前视图
      story.lastBg = scene.id;
      setStageArt(sceneSrc(scene) || src);
      updateRollingStyle(scene);           // §4.10 C-F：每次出图后自动更新（本地规则，不依赖模型）
      refreshRollingStyleByModel(scene);   // 真实模式：书记员顺手刷新；失败保留本地结果
    }
    saveAll();
    renderChat(); renderStage(); renderThumbs();
    return scene;
  }

  // （generateScene 已并入 runPaintTask：构思 → 组 prompt → 出图三处共用一个任务体，§3.B）

  /* ================= 画师工作台（§4.3，T-P3-1） ================= */

  let pw = null;   // { sceneId, prompt, promptRaw, alt, busy }

  function findImageEntry(id) {
    if (!story) return null;
    for (let i = story.log.length - 1; i >= 0; i--) {
      const e = story.log[i];
      if (e.type === 'image' && e.id === id) return e;
    }
    return null;
  }

  function openWorkbench(sceneId) {
    if (!story) { toast('先打开一个故事吧'); return; }
    const scene = sceneId ? imageSceneById(sceneId) : currentScene();
    if (!scene) { toast('还没有图。先点右上角「作画」。'); return; }
    const entry = findImageEntry(scene.id);
    pw = {
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
    pw = null;
  }

  // 出图参数与「模型设置 · 生图模型」共用同一份 settings.image
  function pwParamsToForm() {
    const im = settings.image;
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
    settings.image.aspect = a;
    if (IMAGE_ASPECTS[a]) {
      settings.image.width = IMAGE_ASPECTS[a][0];
      settings.image.height = IMAGE_ASPECTS[a][1];
    } else {
      settings.image.width = Math.max(64, parseInt($('#pw-width').value, 10) || 1280);
      settings.image.height = Math.max(64, parseInt($('#pw-height').value, 10) || 720);
    }
    saveAll();
  }

  function renderWorkbench() {
    if (!pw) return;
    const scene = imageSceneById(pw.sceneId);
    const entry = findImageEntry(pw.sceneId);
    const src = sceneSrc(scene, entry);
    const img = $('#pw-preview');
    if (src) { img.src = src; img.classList.remove('hidden'); }
    else { img.removeAttribute('src'); img.classList.add('hidden'); }
    $('#pw-alt').value = pw.alt;
    $('#pw-prompt').value = pw.prompt;
    const meta = [];
    if (entry && entry.id === (story.lastBg || '')) meta.push('当前画面');
    if (scene && scene.model) meta.push(scene.model);
    if (scene && scene.size) meta.push(scene.size);
    if (scene && scene.ts) meta.push(fmtTime(scene.ts));
    if (scene && scene.supersededBy) meta.push('已重画为新版');
    $('#pw-meta').textContent = meta.join(' · ');
    // 「按设定卡强制重画」只在已锚定时可用（§4.4 图片侧手动层）
    const card = story && story.styleCard;
    const hasCard = !!(card && card.locked !== false);
    const fb = $('#btn-pw-force');
    if (fb) {
      fb.disabled = !hasCard || !!pw.busy;
      fb.title = hasCard ? '把视觉设定卡的画风与人物设定压进这张图重画' : '还没锚定视觉设定卡（先点「锚定画风」）';
    }
    renderPainterThread();
  }

  function renderPainterThread() {
    const box = $('#pw-thread');
    box.innerHTML = '';
    const th = (story && story.painterThread) || [];
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
    if (!story || !pw || pw.busy) return;
    if (offlineBlocked('这句给画师的话')) return;
    const text = $('#pw-input').value.trim();
    if (!text) return;
    $('#pw-input').value = '';
    pw.busy = true;
    $('#btn-pw-send').disabled = true;
    $('#btn-pw-redraw').disabled = true;
    $('#btn-pw-force').disabled = true;
    // 用户可能手改过 prompt：先按当下的版本跟画师谈
    const curPrompt = $('#pw-prompt').value.trim();
    const curAlt = $('#pw-alt').value.trim();
    pw.prompt = curPrompt;
    pw.alt = curAlt;
    story.painterThread = story.painterThread || [];
    story.painterThread.push({ role: 'user', text, ts: Date.now() });
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
      if (pw && res.promptEn) {
        pw.promptRaw = res.promptEn;
        pw.prompt = fullPrompt;
        pw.alt = res.alt || pw.alt;
      }
      const reply = res.reply || (res.promptEn ? '提示词改好了。' : '（画师这次没给改动）');
      story.painterThread.push({
        role: 'painter', text: reply,
        prompt: fullPrompt, alt: res.alt || '', ts: Date.now(),
      });
      pending.remove();
      if (pw) renderWorkbench();
      if (res.promptEn) toast('画师已更新提示词，点「按此重画」看效果');
    } catch (e) {
      story.painterThread.push({ role: 'painter', text: '（画师这次没接上话：' + (e && e.message ? e.message : e) + '）', ts: Date.now() });
      pending.remove();
      if (pw) renderWorkbench();
      toast(netErrHint(e), true, true);
    } finally {
      if (pw) {
        pw.busy = false;
        $('#btn-pw-send').disabled = false;
        $('#btn-pw-redraw').disabled = false;
        $('#btn-pw-force').disabled = false;
      }
      saveAll();
    }
  }

  // 工作台「按此重画」：同 prompt 重画，旧图保留并标 supersededBy（R1/§4.2）
  async function redrawFromWorkbench() {
    if (!story || !pw || pw.busy) return;
    const prompt = $('#pw-prompt').value.trim();
    const alt = $('#pw-alt').value.trim();
    if (!prompt) { toast('prompt 不能为空', true); return; }
    const key = 'redraw:' + pw.sceneId;   // §3.C：带 key 防连点（不需要 busy 保护，它改的是已有的图）
    if (paintQ.has(key)) { toast('这张图已在作画队列里'); return; }
    pw.busy = true;
    $('#btn-pw-redraw').disabled = true;
    $('#btn-pw-send').disabled = true;
    $('#btn-pw-force').disabled = true;
    pwParamsToSettings();
    const scene = imageSceneById(pw.sceneId);
    const entry = findImageEntry(pw.sceneId);
    try {
      const newScene = await enqueuePaint({
        key: key,
        prompt, promptRaw: stripStyleSuffix(prompt), alt: alt || (scene && scene.alt) || '',
        supersedesEntry: entry, supersedesScene: scene,
      });
      if (newScene) {
        if (pw) {
          pw.sceneId = newScene.id;
          pw.prompt = newScene.prompt;
          pw.promptRaw = newScene.promptRaw;
          pw.alt = newScene.alt;
        }
        toast('已重画（旧图保留在记录里）');
      }
      if (pw) renderWorkbench();
    } finally {
      if (pw) pw.busy = false;   // 等图期间面板可能被关掉（pw 置空）
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
    if (!story || !pw || pw.busy) return;
    const card = story.styleCard;
    if (!card || card.locked === false) { toast('还没锚定视觉设定卡：先点「锚定画风」走一遍', true); return; }
    const curPrompt = $('#pw-prompt').value.trim() || pw.prompt || '';
    const alt = $('#pw-alt').value.trim() || pw.alt || '';
    const suffix = cardForceSuffix(card, alt + ' ' + curPrompt);
    let raw = curPrompt;
    const i = suffix ? raw.toLowerCase().indexOf(suffix.toLowerCase()) : -1;
    if (i >= 0) raw = raw.slice(0, i).replace(/[,，、]\s*$/, '').trim() || curPrompt;
    const prompt = composePrompt(raw, suffix);
    if (!prompt) { toast('这张图还没有可用的提示词', true); return; }

    const key = 'redraw:' + pw.sceneId;   // §3.C：带 key 防连点
    if (paintQ.has(key)) { toast('这张图已在作画队列里'); return; }
    pw.busy = true;
    $('#btn-pw-force').disabled = true;
    $('#btn-pw-redraw').disabled = true;
    $('#btn-pw-send').disabled = true;
    pwParamsToSettings();
    $('#pw-prompt').value = prompt;   // 透明：用户看到真正发出去的原话
    pw.prompt = prompt; pw.promptRaw = raw;
    const scene = imageSceneById(pw.sceneId);
    const entry = findImageEntry(pw.sceneId);
    try {
      const newScene = await enqueuePaint({
        key: key,
        prompt, promptRaw: raw, alt: alt || (scene && scene.alt) || '',
        supersedesEntry: entry, supersedesScene: scene,
      });
      if (newScene) {
        if (pw) {
          pw.sceneId = newScene.id;
          pw.prompt = newScene.prompt;
          pw.promptRaw = newScene.promptRaw;
          pw.alt = newScene.alt;
        }
        toast('已按视觉设定卡重画（旧图保留在记录里）');
      }
      if (pw) renderWorkbench();
    } finally {
      if (pw) pw.busy = false;   // 等图期间面板可能被关掉（pw 置空）
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
    if (!story) { toast('先打开一个故事吧'); return; }
    opts = opts || {};
    anchor = {
      onDone: typeof opts.onDone === 'function' ? opts.onDone : null,
      batch: 0, tried: [], candidates: [], pickedIdx: -1, card: null,
      busy: false, doneFired: false,
    };
    const card = story.styleCard;
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
    const a = anchor;
    anchor = null;
    closeModal('modal-anchor');
    if (a && !a.doneFired) {
      a.doneFired = true;
      if (a.onDone) a.onDone();
    }
  }

  function setAnchorBusy(on, note) {
    const b = !!on;
    $('#btn-anchor-more').disabled = b;
    $('#btn-anchor-use').disabled = b || !anchor || anchor.pickedIdx < 0;
    $('#btn-anchor-chat').disabled = b;
    $('#btn-anchor-lock').disabled = b;
    $('#btn-anchor-back').disabled = b;
    if (note != null) $('#ac-status').textContent = note;
  }

  function renderAnchorGrid(placeholder) {
    const grid = $('#anchor-grid');
    grid.innerHTML = '';
    if (!anchor) return;
    if (placeholder || !anchor.candidates.length) {
      const d = document.createElement('div');
      d.className = 'anchor-hint';
      d.textContent = placeholder || '（还没有候选）';
      grid.appendChild(d);
      return;
    }
    anchor.candidates.forEach((c, i) => {
      const cardEl = document.createElement('div');
      cardEl.className = 'anchor-card' + (i === anchor.pickedIdx ? ' sel' : '');
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
        if (!anchor || !c.src) return;
        anchor.pickedIdx = i;
        $('#btn-anchor-use').disabled = anchor.busy;
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
    if (!anchor || anchor.busy) return;
    anchor.busy = true;
    anchor.candidates = [];
    anchor.pickedIdx = -1;
    setAnchorBusy(true);
    renderAnchorGrid('画师正在构思 4 组画风…');
    try {
      const res = await painterAnchorCompose({
        mode: 'styles', batch: anchor.batch + 1, tried: anchor.tried.slice(-16),
      });
      if (!anchor) return;   // 等回包期间被「跳过 / ✕ / Esc」关掉：这条回包直接丢弃，别再碰 anchor
      const styles = (res.styles || []).slice(0, 4);
      if (!styles.length) throw new Error('画师没有给出候选画风');
      anchor.batch += 1;
      anchor.candidates = styles.map(s => ({
        keywords: s.keywords || [], promptEn: s.promptEn || '', alt: s.alt || '',
        src: '', loading: true, failed: false,
      }));
      for (const c of anchor.candidates) anchor.tried = anchor.tried.concat(c.keywords);
      renderAnchorGrid();
      // 4 张并发试画；回调里按住候选对象本身，批次被替换后不再更新界面
      anchor.candidates.forEach(cand => {
        paintCandidate(cand.promptEn).then(src => {
          cand.src = src; cand.loading = false;
          if (anchor && anchor.candidates.indexOf(cand) >= 0) renderAnchorGrid();
        }).catch(() => {
          cand.loading = false; cand.failed = true;
          if (anchor && anchor.candidates.indexOf(cand) >= 0) renderAnchorGrid();
        });
      });
    } catch (e) {
      // 已经关掉锚定弹窗时不再打扰用户（回包迟到 / 被跳过）
      if (anchor) {
        renderAnchorGrid('试画没成功：' + (e && e.message ? e.message : e) + '（可以点「再试一批」）');
        toast('试画失败：' + (e && e.message ? e.message : e), true, true);
      }
    } finally {
      if (anchor) anchor.busy = false;
      setAnchorBusy(false);
    }
  }

  async function anchorDraftCard() {
    if (!anchor || anchor.busy || anchor.pickedIdx < 0) return;
    const picked = anchor.candidates[anchor.pickedIdx];
    if (!picked || !picked.src) { toast('等这张画出来再选吧'); return; }
    anchor.busy = true;
    setAnchorBusy(true);
    $('#btn-anchor-use').textContent = '画师起草中…';
    try {
      const res = await painterAnchorCompose({ mode: 'card', picked });
      if (!res.card) throw new Error('画师没有给出设定卡');
      anchor.card = res.card;
      fillAnchorCardForm(res.card);
      $('#anchor-card-preview').src = picked.src;
      $('#ac-picked-kw').textContent = '选定画风：' + ((picked.keywords || []).slice(0, 4).join(', ') || picked.alt || '');
      $('#ac-status').textContent = res.reply || '';
      $('#anchor-step-pick').classList.add('hidden');
      $('#anchor-step-card').classList.remove('hidden');
    } catch (e) {
      toast('生成视觉设定卡失败：' + (e && e.message ? e.message : e), true, true);
    } finally {
      if (anchor) anchor.busy = false;
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
    if (!anchor || anchor.busy) return;
    const text = $('#ac-chat').value.trim();
    if (!text) return;
    $('#ac-chat').value = '';
    anchor.busy = true;
    setAnchorBusy(true, '画师修改中…');
    try {
      const res = await painterAnchorCompose({
        mode: 'cardchat', currentCard: readAnchorCardForm(), userText: text,
      });
      if (res.card) { anchor.card = res.card; fillAnchorCardForm(res.card); }
      $('#ac-status').textContent = res.reply || '已更新设定卡。';
    } catch (e) {
      $('#ac-status').textContent = '';
      toast('画师这次没接上话：' + (e && e.message ? e.message : e), true, true);
    } finally {
      if (anchor) anchor.busy = false;
      setAnchorBusy(false);
    }
  }

  function anchorLock() {
    if (!anchor || !story) return;
    const form = readAnchorCardForm();
    if (!form.styleKeywords.length && !form.medium && !form.palette && !form.characters.length && !form.note) {
      toast('至少给卡填一点画风关键词或说明', true);
      return;
    }
    const old = story.styleCard;
    story.styleCard = Object.assign({
      id: (old && old.id) || ('style' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
      version: ((old && +old.version) || 0) + 1,
      locked: true,
      updatedAt: Date.now(),
    }, form);
    saveAll();
    toast('已锁定视觉设定卡（v' + story.styleCard.version + '）：之后每张画都带着它', false, true);
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
    const messages = IR.Context.assemblePainter(story, opts);
    const raw = await adapter.chat(cfg, messages);
    return parsePainterAnchor(raw);
  }

  /* ================= 渲染：聊天记录窗口（§4.6） ================= */

  function scrollChatBottom() {
    const box = $('#chat-scroll');
    box.scrollTop = box.scrollHeight;
  }

  function imageSceneById(id) {
    return (story.scenes || []).find(s => s.id === id) || null;
  }
  function currentScene() {
    const sc = imageSceneById(story.lastBg);
    if (sc) return sc;
    const all = story.scenes || [];
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
      liveReasonOpen = wrap.classList.contains('open');
      panel.scrollTop = panel.scrollHeight;   // 展开后立刻跟到最新
    };
    wrap.appendChild(btn);
    wrap.appendChild(panel);
    return wrap;
  }

  function renderChat() {
    liveEl = null;   // DOM 重建后旧引用失效（否则工具回合后的第二次流式会写进已脱离的节点）
    liveReasonEl = null;
    const box = $('#chat-scroll');
    box.innerHTML = '';
    if (!story) return;
    const log = story.log || [];

    log.forEach((e, i) => {
      box.appendChild(bubbleFor(e, i));
    });

    // 流式 / 打字机中的临时旁白（思考链先流、正文后到，§4.5）
    if (live) {
      // 没有思考内容就不渲染折叠条（空白的「思考链」看着像坏了）
      if (settings.showReasoning && String(live.reasoning || '').trim()) {
        liveReasonEl = reasonLiveBlock(live.reasoning, liveReasonOpen);
        if (liveReasonCollapsed) liveReasonEl.classList.add('collapsed');
        box.appendChild(liveReasonEl);
        const p = liveReasonEl.querySelector('.reason-panel');
        if (p) p.scrollTop = p.scrollHeight;
      }
      const d = document.createElement('div');
      d.className = 'bubble bubble-narration bubble-live';
      if (live.text) {
        d.textContent = live.text;
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

    renderFeatureBar();
    scrollChatBottom();
  }

  function renderChoices() {
    const tray = $('#choice-tray');
    const btn = $('#btn-inspiration');
    const badge = $('#inspiration-count');
    const canShow = !busy && !live && !!story && story.mode === 'choice'
      && Array.isArray(currentChoices) && currentChoices.length > 0;
    const inline = (settings.ui && settings.ui.choices) === 'always';

    // 内联（always）：放在聊天记录的末尾（旁白下面；后面若又出了图，也不会被插队）
    if (canShow && inline) {
      const box = $('#chat-scroll');
      const wrap = document.createElement('div');
      wrap.className = 'choices-inline';
      currentChoices.forEach(c => {
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
      btn.setAttribute('aria-expanded', show && choicesTrayOpen ? 'true' : 'false');
      if (badge) {
        badge.textContent = show ? String(currentChoices.length) : '';
        badge.classList.toggle('hidden', !show);
      }
    }
    if (!tray) return;
    tray.innerHTML = '';
    if (!canShow || inline || !choicesTrayOpen) {
      tray.classList.add('hidden');
      return;
    }
    currentChoices.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tray-btn';
      b.textContent = c;
      b.title = c;
      b.onclick = () => { choicesTrayOpen = false; sendPlayerAction(c, true); };
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
    const src = safeImgSrc(sceneSrc(sc, e));
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

    const actionable = p.status === 'pending' && now < p.expiresAt && !busy;
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
    if (!sidecarReady()) { toast(sidecarOffHint(), true, true); return; }
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
        '金额：' + yuan(a.amountCents),
        '商户：' + (a.merchant || '（未填）'),
        '品类：' + (a.category || '（未填）'),
      ];
      const items = (a.items || []).map(i => i && i.name).filter(Boolean).join('、');
      if (items) lines.push('商品：' + items);
      lines.push('', '每日剩余：' + yuan(rem.daily || 0) + ' · 每月剩余：' + yuan(rem.monthly || 0), '', '确认后才会真正扣款。');
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
      : ('下单提案（' + yuan(p.args.amountCents) + ' · ' + (p.args.merchant || '未填商户') + '）');
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
      if (story && (story.mode === 'chat' || story.mode === 'rp')) return inlineImageBubble(e);
      // 场景标记行：56px 小缩略图 + 一行 alt（不再在聊天里内嵌大图）。
      // 点图 / 点文字 = 在右侧舞台选中这张；「工作台」入口悬停时才出现。
      const d = document.createElement('div');
      d.className = 'bubble bubble-image';
      const sc = imageSceneById(e.id);
      const src = sceneSrc(sc, e) || null;
      const selectScene = () => {
        if (!story) return;
        story.lastBg = e.id;
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
    if (e.type === 'narration' && settings.showReasoning && String(e.reasoning || '').trim()) {
      d.insertBefore(reasonBlock(e.reasoning, false), d.firstChild);
    }

    // 分支导航（§4.3/§5⑤）：凡是有兄弟的旁白都显示 ‹ n/m ›，点了就切到那条分支；
    // 「↻ 重试」仍只在最后一条（§5⑤）。旧版本栈已由迁移展开成兄弟（任务书 §6），不再兜底切换。
    const sibs = (e.type === 'narration' && e.nid && story && story.tree) ? IR.Tree.siblings(story, e.nid) : [];
    const showRetry = e.type === 'narration' && index === lastNarrationIndex() && !busy && lastActionEntry();
    const showSibs = e.type === 'narration' && !busy && sibs.length > 1;
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

  function renderStage() {
    const img = $('#stage-img'), empty = $('#stage-empty'), cap = $('#stage-caption');
    if (!story) {
      img.classList.add('hidden');
      empty.classList.remove('hidden');
      setStageArt('');
      if (cap) cap.textContent = '';
      return;
    }
    const sc = currentScene();
    const src = sceneSrc(sc);
    if (src) {
      img.src = src;
      img.alt = (sc && sc.alt) || '当前画面';
      img.classList.remove('hidden');
      empty.classList.add('hidden');
      setStageArt(src);
    } else {
      img.classList.add('hidden');
      empty.classList.remove('hidden');
      setStageArt('');
    }
    // 图下方一行淡色说明（alt）：舞台自己说明自己，聊天里不再放大图
    if (cap) cap.textContent = src ? ((sc && sc.alt) || '') : '';
  }

  function renderThumbs() {
    const strip = $('#thumb-strip');
    strip.innerHTML = '';
    const scenes = (story && story.scenes) || [];
    if (!scenes.length) {
      const d = document.createElement('div');
      d.className = 'thumb-empty';
      d.textContent = '作画后，这里按时间排开每一幕';
      strip.appendChild(d);
      return;
    }
    for (const sc of scenes) {
      // 缩略条优先用小图（快）；小图缺失但原图在 IndexedDB 里时，等它异步取回来再显示
      const src = sc.thumb || sceneSrc(sc);
      if (!src) continue;
      const img = document.createElement('img');
      img.className = 'thumb' + (story.lastBg === sc.id ? ' active' : '');
      img.src = src;
      img.alt = sc.alt || '场景缩略图';
      img.title = sc.alt || '';
      img.onclick = () => { story.lastBg = sc.id; saveAll(); renderStage(); renderThumbs(); };
      strip.appendChild(img);
    }
  }

  /* ================= 渲染：布局状态（P2 的统一入口） =================
   * 所有排版只由 #screen-game 的 data-layout 决定：
   *   auto → 宽度 ≥ 900px 用 split，否则 stack；immersive 只能由用户进入。
   * 比例 / 收起 / 选项显示都存在 settings.ui（全局），story.ui 只记输入类型。 */

  const LAYOUTS = ['auto', 'split', 'stack', 'immersive'];
  let immersiveTextHidden = false;

  function uiState() {
    if (!settings.ui || typeof settings.ui !== 'object') settings.ui = Store.defaultSettings().ui;
    return settings.ui;
  }

  function autoLayout() {
    return (typeof window !== 'undefined' && window.innerWidth >= 900) ? 'split' : 'stack';
  }

  function effectiveLayout() {
    // v0.6.0：chat（智能体）/ rp（扮演）是纯聊天布局（无画面区）；剧情模式的 split / stack / immersive 一行不动
    if (story && (story.mode === 'chat' || story.mode === 'rp')) return 'chat';
    const ui = uiState();
    if (ui.layout === 'immersive') return 'immersive';
    if (ui.layout === 'split' || ui.layout === 'stack') return ui.layout;
    return autoLayout();
  }

  // 设置里的布局项：chat / rp 下给一行灰字说明（布局选项本身不动，切回剧情模式照常生效）
  function renderLayoutHint() {
    const el = $('#ui-layout-hint');
    if (!el) return;
    const noStage = !!(story && (story.mode === 'chat' || story.mode === 'rp'));
    el.textContent = noStage ? '此模式没有画面区（纯聊天布局），下面的布局选项只对剧情模式生效。' : '';
  }

  function isImmersive() {
    return effectiveLayout() === 'immersive';
  }

  function setLayout(next) {
    const ui = uiState();
    ui.layout = LAYOUTS.indexOf(next) >= 0 ? next : 'auto';
    if (ui.layout !== 'immersive') immersiveTextHidden = false;
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
    el.classList.toggle('text-hidden', !!immersiveTextHidden);
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
    if (!story) return;
    const ui = uiState();
    if (isImmersive()) { setLayout('auto'); return; }
    ui.imageCollapsed = !ui.imageCollapsed;
    applyLayout();
    persistSettings();
  }

  function enterImmersive() {
    if (!story) return;
    setLayout('immersive');
    immersiveTextHidden = false;
    applyLayout();
  }

  // Esc / ✕ 退出沉浸态：回到「自动」布局
  function exitImmersive() {
    if (!isImmersive()) return false;
    immersiveTextHidden = false;
    setLayout('auto');
    return true;
  }

  function bindSplitter() {
    const sp = $('#splitter');
    if (!sp) return;
    let dragging = false;
    const onMove = (clientX, touch) => {
      if (!story || effectiveLayout() !== 'split') return;
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
      if (story) persistSettings();
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
    if (!story) return;
    // 分支树（§4.1/§3）：树是唯一真源——载入一律先 ensure（旧档建线性链 / 坏树降级）再 project 重建 log / messages 等
    try {
      IR.Tree.ensure(story);
      IR.Tree.project(story);
    } catch (e) { console.warn('IR.Tree 初始化失败（按存档原样继续）：', e); }
    story.ui = Object.assign(Store.defaultUi(), story.ui || {});
    $('#screen-start').classList.add('hidden');
    $('#screen-shelf').classList.add('hidden');
    $('#screen-game').classList.remove('hidden');
    $('#screen-game').classList.remove('stage-strip', 'text-hidden');
    closeMenus();
    immersiveTextHidden = false;
    $('#hud-title').textContent = story.title;
    $('#hud-mode').textContent = MODE_LABELS[story.mode] || '剧情';
    syncKindSwitch();
    choicesTrayOpen = false;
    applyLayout();
    renderChat();
    renderStage();
    renderThumbs();
    if (fresh) {
      currentChoices = choicesFromHead();
      renderChat();
      saveAll();
      // deferOpening：先走试画锚定（P4），锚定结束（锁定/跳过）后再开场
      if (!opts.deferOpening) runOpening();
    } else {
      currentChoices = choicesFromHead();   // §4.3：选项跟着 head 的 assistantMsg 恢复（刷新后不丢）
      renderNarrationToolsAfterLoad();
      saveAll();
      // 空档补开场（例：锚定向导还没走完就刷新了页面）
      if (!(story.log || []).length && !(story.messages || []).length) runOpening();
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
    const sc = settings.sidecar || {};
    if ($('#s-sidecar-port')) $('#s-sidecar-port').value = sc.port || 4319;
    if ($('#s-sidecar-token')) $('#s-sidecar-token').value = sc.token || '';
    $('#s-chat-base').value = settings.chat.baseUrl;
    $('#s-chat-model').value = settings.chat.model;
    $('#s-chat-key').value = settings.chat.apiKey;
    $('#s-chat-temp').value = settings.chat.temperature;
    $('#s-chat-params').value = typeof settings.chat.extraParams === 'string' ? settings.chat.extraParams : '';

    $('#s-painter-base').value = settings.painter.baseUrl;
    $('#s-painter-model').value = settings.painter.model;
    $('#s-painter-key').value = settings.painter.apiKey;

    $('#s-scribe-enabled').checked = !!settings.scribe.enabled;
    $('#s-scribe-every').value = settings.scribe.every || 10;
    $('#s-scribe-ai').checked = settings.scribe.aiTasks !== false;
    $('#s-scribe-base').value = settings.scribe.baseUrl;
    $('#s-scribe-model').value = settings.scribe.model;
    $('#s-scribe-key').value = settings.scribe.apiKey;

    $('#s-draft-base').value = settings.draft.baseUrl;
    $('#s-draft-model').value = settings.draft.model;
    $('#s-draft-key').value = settings.draft.apiKey;

    $('#s-image-base').value = settings.image.baseUrl;
    $('#s-image-model').value = settings.image.model;
    $('#s-image-key').value = settings.image.apiKey;
    $('#s-image-params').value = typeof settings.image.extraParams === 'string' ? settings.image.extraParams : '';
    $('#s-image-aspect').value = settings.image.aspect || '16:9';
    $('#s-image-width').value = settings.image.width || 1280;
    $('#s-image-height').value = settings.image.height || 720;
    applyAspectToFields();

    $('#s-show-reasoning').checked = !!settings.showReasoning;
    $('#s-tools-enabled').checked = settings.toolsEnabled !== 'off';
    renderNoToolsHint();
    // R13 用户画像：默认全关，可按模式单独开或全开（'all' 与三个勾等价）
    const up = settings.userProfile || {};
    const enabled = up.enabled === 'all' ? { choice: true, chat: true, rp: true } : (up.enabled || {});
    $('#s-profile-choice').checked = !!enabled.choice;
    $('#s-profile-chat').checked = !!enabled.chat;
    $('#s-profile-rp').checked = !!enabled.rp;
    $('#s-profile-scope').value = up.scope === 'per-story' ? 'per-story' : 'global';
    renderProfilePanel();
    $('#s-style-preset').value = settings.stylePreset;
    $('#s-style-custom').value = settings.styleCustom;
    const sui = settings.ui || Store.defaultSettings().ui;
    if ($('#s-ui-layout')) $('#s-ui-layout').value = sui.layout === 'immersive' ? 'auto' : sui.layout;
    if ($('#s-ui-choices')) $('#s-ui-choices').value = sui.choices === 'always' ? 'always' : 'tray';
    document.querySelectorAll('input[name="s-trigger"]').forEach(r => { r.checked = r.value === settings.trigger; });
    renderCapabilityFields();
    renderStoryPanels();
    renderInjectHint();
    renderSavepoints();
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
    settings.sidecar = {
      port: Number(($('#s-sidecar-port') || {}).value) || 4319,
      token: (($('#s-sidecar-token') || {}).value || '').trim(),
    };
    if (IR.Sidecar) IR.Sidecar.configure(settings.sidecar);
    settings.chat.provider = 'openai-compatible';
    settings.chat.baseUrl = $('#s-chat-base').value.trim();
    settings.chat.model = $('#s-chat-model').value.trim();
    settings.chat.apiKey = $('#s-chat-key').value.trim();
    settings.chat.temperature = parseFloat($('#s-chat-temp').value);
    if (!Number.isFinite(settings.chat.temperature)) settings.chat.temperature = 0.9;
    if (!$('#wrap-chat-thinking').classList.contains('hidden')) {
      settings.chat.thinking = $('#s-chat-thinking').value || 'default';
    } else {
      settings.chat.thinking = 'default';
    }
    settings.chat.contextWindow = Math.max(0, parseInt($('#s-chat-ctx').value, 10) || 0);
    // 手填参数原样并入请求体（providers.js mergeExtraParams）
    settings.chat.extraParams = $('#s-chat-params').value.trim();

    settings.painter.baseUrl = $('#s-painter-base').value.trim();
    settings.painter.model = $('#s-painter-model').value.trim();
    settings.painter.apiKey = $('#s-painter-key').value.trim();

    settings.scribe.enabled = $('#s-scribe-enabled').checked;
    settings.scribe.every = Math.max(1, parseInt($('#s-scribe-every').value, 10) || 10);
    settings.scribe.aiTasks = $('#s-scribe-ai').checked;
    settings.scribe.baseUrl = $('#s-scribe-base').value.trim();
    settings.scribe.model = $('#s-scribe-model').value.trim();
    settings.scribe.apiKey = $('#s-scribe-key').value.trim();

    settings.draft.baseUrl = $('#s-draft-base').value.trim();
    settings.draft.model = $('#s-draft-model').value.trim();
    settings.draft.apiKey = $('#s-draft-key').value.trim();

    settings.image.provider = 'openai-images';
    settings.image.baseUrl = $('#s-image-base').value.trim();
    settings.image.model = $('#s-image-model').value.trim();
    settings.image.apiKey = $('#s-image-key').value.trim();
    settings.image.aspect = $('#s-image-aspect').value;
    settings.image.width = parseInt($('#s-image-width').value, 10) || 1280;
    settings.image.height = parseInt($('#s-image-height').value, 10) || 720;
    settings.image.extraParams = $('#s-image-params').value.trim();
    if (!$('#wrap-image-size').classList.contains('hidden')) settings.image.size = $('#s-image-size').value;
    else delete settings.image.size;
    if (!$('#wrap-image-quality').classList.contains('hidden')) settings.image.quality = $('#s-image-quality').value;
    else delete settings.image.quality;

    // R13 用户画像：三个勾全开 = 'all'（等价写法，省得以后加模式还要改数据）
    const pChoice = $('#s-profile-choice').checked;
    const pChat = $('#s-profile-chat').checked;
    const pRp = $('#s-profile-rp').checked;
    settings.userProfile = {
      enabled: (pChoice && pChat && pRp) ? 'all' : { choice: pChoice, chat: pChat, rp: pRp },
      scope: $('#s-profile-scope').value === 'per-story' ? 'per-story' : 'global',
    };

    // 界面：布局 / 选项显示（P2；沉浸态不写回，保存后回到自动布局）
    if (!settings.ui) settings.ui = Store.defaultSettings().ui;
    if ($('#s-ui-layout')) {
      const lv = $('#s-ui-layout').value;
      settings.ui.layout = (lv === 'split' || lv === 'stack') ? lv : 'auto';
    }
    if ($('#s-ui-choices')) settings.ui.choices = $('#s-ui-choices').value === 'always' ? 'always' : 'tray';

    const prevShowReasoning = settings.showReasoning;
    settings.showReasoning = $('#s-show-reasoning').checked;
    settings.toolsEnabled = $('#s-tools-enabled').checked ? 'on' : 'off';
    settings.stylePreset = $('#s-style-preset').value;
    settings.styleCustom = $('#s-style-custom').value.trim();
    const t = document.querySelector('input[name="s-trigger"]:checked');
    settings.trigger = t ? t.value : 'choice';
    saveAll();
    if (story) { applyLayout(); renderChat(); }   // 布局 / 选项显示即时生效
    if (prevShowReasoning !== settings.showReasoning) renderChat();   // 思考链开关即时生效
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
    const has = !!story;
    const card = has ? story.styleCard : null;
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
    const rs = (has && story.rollingStyle) || {};
    const parts = [
      rs.style ? ('风格倾向：' + rs.style) : '',
      rs.scenes ? ('常见场景：' + rs.scenes) : '',
      rs.wardrobe ? ('服饰元素：' + rs.wardrobe) : '',
    ].filter(Boolean);
    $('#rolling-style-text').textContent = '滚动风格摘要（每次出图后自动更新）：'
      + (parts.length ? parts.join('；') : '（还没出过图）');
  }

  function renderStoryPanels() {
    const has = !!story;
    renderStylePanel();
    renderProfilePanel();
    renderCardPanel();
    $('#memory-empty').classList.toggle('hidden', has);
    $('#memory-panels').classList.toggle('hidden', !has);
    if (!has) return;
    const w = story.world || {};
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
    (story.summaries || []).forEach(s => { const d = document.createElement('div'); d.className = 'mono-line'; d.textContent = s; sl.appendChild(d); });
    $('#sum-count').textContent = (story.summaries || []).length;
    const tl = $('#tool-list'); tl.innerHTML = '';
    story.log.filter(e => e.type === 'tool').slice(-40).forEach(e => {
      const d = document.createElement('div'); d.className = 'mono-line';
      d.textContent = '· ' + (e.tool || '') + '：' + (e.summary || '');
      tl.appendChild(d);
    });
    $('#s-story-mode').value = story.mode || 'choice';
  }

  // 角色卡状态（R13）：rp 常驻；切出 rp 时卡保留在存档里只是停用（§4.8）
  function renderCardPanel() {
    const el = $('#rc-status');
    if (!el) return;
    $('#btn-edit-card').disabled = !story;
    const card = story && story.characterCard;
    if (!card) {
      el.textContent = '还没有角色卡：切到「扮演」会先让你建一张 / 导入一张（SillyTavern V2/V3 PNG 也可）。';
      return;
    }
    el.textContent = '角色卡：' + (card.name || '（无名）') + '（' + IR.RoleCard.sourceLabel(card) + '）'
      + (story.mode === 'rp' ? ' · 扮演中：每轮常驻，开场白已进场' : ' · 已保留：切到扮演模式即启用');
  }

  function saveWorldFromForm() {
    if (!story) return;
    const w = story.world || (story.world = Store.defaultWorld());
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
    if (!story) { toast('先打开一个故事'); return; }
    pendingInject = !pendingInject;
    renderInjectHint();
    toast(pendingInject
      ? '已排定：下一回合带上完整记忆，并要求 AI 先复述处境再继续'
      : '已取消注入');
  }

  function renderInjectHint() {
    const el = $('#inject-state');
    const btn = $('#btn-inject-memory');
    if (!el || !btn) return;
    btn.disabled = !story;
    btn.textContent = pendingInject ? '取消注入' : '注入记忆';
    el.textContent = pendingInject
      ? '已排定：下一回合把完整世界卡 + 设定 + 视觉设定卡直接注入上下文，并要求先复述处境再继续。'
      : '手动层：点一下排定下一回合强制注入完整记忆（世界卡 + 设定 + 视觉设定卡），让 AI 先复述处境再继续。';
  }

  /* ---------- 用户画像面板（R13 / §4.12：面板在模型设置里，每条可删、可清空） ---------- */

  function profileStore() {
    const scope = (settings.userProfile || {}).scope === 'per-story' ? 'per-story' : 'global';
    if (scope === 'global') return { scope: scope, entries: Store.loadUserProfile() };
    return { scope: scope, entries: story ? (story.userProfile || []) : [] };
  }

  function writeProfile(entries) {
    const scope = (settings.userProfile || {}).scope === 'per-story' ? 'per-story' : 'global';
    if (scope === 'global') Store.saveUserProfile(entries);
    else if (story) { story.userProfile = entries; saveAll(); }
  }

  function renderProfilePanel() {
    const el = $('#profile-list');
    if (!el) return;
    const st = profileStore();
    const on = IR.Context.profileEnabledFor((settings.userProfile || {}).enabled, (story && story.mode) || 'choice');
    $('#profile-state').textContent = (st.scope === 'per-story' && !story)
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
    if (!story) return;
    const m = e.target.value;
    const prev = story.mode || 'choice';
    if (m === 'rp' && !story.characterCard) {
      // §4.8：切到 rp 时若没有角色卡 → 弹角色卡选择 / 新建；取消则留在原模式
      story.mode = m;
      $('#hud-mode').textContent = MODE_LABELS[m] || '剧情';
      saveAll();
      applyLayout();
      syncKindSwitch();
      renderChat();
      openCardEditor({
        mode: 'edit',
        onCancel: () => {
          story.mode = prev;
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
    story.mode = m;
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
        if (mode === 'choice') openWizard(null);
        else createStoryImmediate(mode);
      };
    });
    $('#btn-shelf-settings').onclick = openSettings;
    $('#btn-shelf-home').onclick = showStart;
    $('#btn-import').onclick = () => $('#file-import').click();
    $('#file-import').onchange = e => { handleImportFile(e.target.files && e.target.files[0]); e.target.value = ''; };

    // —— 剧情文本导入（R12 路径②，§4.11 / T-P6-1） ——
    $('#btn-import-text').onclick = openImportText;
    $('#btn-start-import').onclick = openImportText;
    $('#btn-close-import-text').onclick = closeImportText;
    $('#btn-it-cancel').onclick = closeImportText;
    $('#btn-it-run').onclick = runImportText;
    $('#it-text').addEventListener('input', importPlanHint);
    $('#it-model-mode').addEventListener('change', e => {
      importModelMode = e.target.value === 'draft' ? 'draft' : 'follow';
      importPlanHint();
    });
    $('#btn-it-back').onclick = () => {
      if (importJob && importJob.busy) return;
      $('#it-step-confirm').classList.add('hidden');
      $('#it-step-run').classList.add('hidden');
      $('#it-step-paste').classList.remove('hidden');
      importPlanHint();
    };
    $('#btn-it-start').onclick = startFromImport;

    // —— 开始页：三张模式卡即三个开局入口，点哪张就按哪种模式开局（无「开始」按钮）——
    document.querySelectorAll('#start-modes .mode-card').forEach(b => {
      b.onclick = () => startFromStart(b.dataset.mode);
    });
    $('#btn-start-shelf').onclick = showShelf;
    $('#btn-open-settings').onclick = openSettings;
    $('#btn-continue').onclick = continueLast;
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
        handleImportFile(f);
      });
    });

    // —— 阅读页 HUD ——
    // 左上「←」退出故事回首页；书架、标题与模式留在顶栏，其余收进「⋯」。
    $('#btn-back-home').onclick = showStart;
    $('#btn-hud-shelf').onclick = showShelf;
    $('#btn-hud-new').onclick = () => { closeMenus(); newStoryFromGame(); };
    $('#btn-settings').onclick = () => { closeMenus(); openSettings(); };
    $('#btn-savepoint').onclick = async () => {
      closeMenus();
      if (!story) return;
      const name = await irConfirm('给这个存档点起个名字', {
        title: '存档点', input: true, okText: '保存',
        value: '第 ' + (story.turn || 0) + ' 回合 · ' + new Date().toLocaleTimeString('zh-CN'),
      });
      if (name == null) return;
      addSavepoint(String(name).trim() || undefined);
      toast('已打存档点');
    };
    const manualGenerate = () => {
      closeMenus();
      if (!story) { toast('先打开一个故事吧'); return; }
      if (busy) { toast('回复生成中，这一幕写完再作画'); return; }   // §3.C：回复生成中不入队
      if (offlineBlocked('这次作画')) return;   // 离线：不排进队列，也不花额度
      const key = 'manual:' + treeHeadNodeId();   // §3.C：同一幕不重复入队
      if (paintQ.has(key)) { toast('这一幕已在作画队列里'); return; }
      // 场景描述读当前 head 的 lastSceneSummary（投影后即 story.lastSceneSummary）
      enqueueImage(story.lastSceneSummary, treeHeadNodeId(), key);
      toast('已加入作画队列');
    };
    $('#btn-manual-gen').onclick = manualGenerate;
    $('#btn-stage-gen').onclick = e => { if (e) e.stopPropagation(); manualGenerate(); };
    $('#btn-toggle-image').onclick = toggleStagePanel;
    $('#btn-stage-painter').onclick = e => { if (e) e.stopPropagation(); openWorkbench(null); };
    $('#btn-immersive').onclick = e => {
      if (e) e.stopPropagation();
      if (!story) return;
      if (isImmersive()) exitImmersive(); else enterImmersive();
    };
    $('#btn-immersive-exit').onclick = e => { if (e) e.stopPropagation(); exitImmersive(); };

    // 顶栏「⋯」/ 输入区「＋」：打开前先刷新菜单项状态
    $('#btn-hud-more').onclick = e => { e.stopPropagation(); toggleMenu($('#btn-hud-more'), $('#hud-more-menu')); };
    $('#btn-more-actions').onclick = e => { e.stopPropagation(); toggleMenu($('#btn-more-actions'), $('#feature-menu')); };
    document.addEventListener('click', e => {
      if (e.target.closest && e.target.closest('.menu-item')) { closeMenus(); return; }
      if (e.target.closest && e.target.closest('.menu, .hud-more, .menu-wrap')) return;
      closeMenus();
    });

    // 舞台点击：沉浸态显示 / 隐藏文字；堆叠态收起 / 展开成细条
    $('#stage-wrap').addEventListener('click', e => {
      if (e.target.closest && e.target.closest('button')) return;
      const layout = effectiveLayout();
      if (layout === 'immersive') {
        immersiveTextHidden = !immersiveTextHidden;
        $('#screen-game').classList.toggle('text-hidden', immersiveTextHidden);
      } else if (layout === 'stack') {
        $('#screen-game').classList.toggle('stage-strip');
      }
    });

    // —— 输入 ——
    const doSend = (opts) => {
      // P0-1：busy 期间只有点「停止」按钮才中断；Enter / 输入不触发（玩家可能只是提前打字）
      if (busy) { if (opts && opts.allowStop) requestChatStop(); return; }
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
        if (!story) return;
        const k = b.dataset.kind;
        story.ui.kind = (k === 'say' || k === 'direct') ? k : 'do';
        syncKindSwitch();
        saveAll();
        $('#player-input').focus();
      };
    });

    // 💡 灵感：展开 / 收起这一轮的选项
    $('#btn-inspiration').onclick = () => {
      if (!currentChoices.length || busy || live) return;
      choicesTrayOpen = !choicesTrayOpen;
      renderChat();
      if (choicesTrayOpen) {
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
    $('#btn-wz-draft').onclick = draftWizard;
    $('#btn-wz-start').onclick = startFromWizard;

    // —— 导出 / 设置 ——
    $('#btn-close-export').onclick = () => $('#modal-export').classList.add('hidden');
    $('#btn-do-export').onclick = doExport;
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
      if (!pw) return;
      const sc = imageSceneById(pw.sceneId);
      const raw = (sc && sc.promptRaw) || pw.promptRaw || '';
      if (!raw) { toast('没有存下画师原稿'); return; }
      pw.prompt = composePrompt(raw, styleSuffixText());
      $('#pw-prompt').value = pw.prompt;
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
      if (!anchor || anchor.busy) return;
      $('#anchor-step-card').classList.add('hidden');
      $('#anchor-step-pick').classList.remove('hidden');
      $('#btn-anchor-use').disabled = anchor.pickedIdx < 0;
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
      if (!story) return;
      addSavepoint();
      toast('已打存档点');
    };
    $('#btn-clear-notools').onclick = () => {
      settings.noTools = [];
      saveAll();
      renderNoToolsHint();
      toast('已清空「不接受工具」的模型记录，下次会重新尝试下发工具');
    };
    $('#s-image-aspect').onchange = applyAspectToFields;
    $('#s-story-mode').onchange = onModeChange;
    $('#btn-save-world').onclick = saveWorldFromForm;
    $('#btn-inject-memory').onclick = toggleInjectMemory;

    // —— 角色卡（R13 / T-P7-1） ——
    $('#btn-edit-card').onclick = () => { if (!story) { toast('先打开一个故事'); return; } openCardEditor({ mode: 'edit' }); };
    $('#btn-close-card').onclick = () => closeCardEditor(true);
    $('#btn-rc-cancel').onclick = () => closeCardEditor(true);
    $('#btn-rc-save').onclick = saveCardFromEditor;
    $('#btn-rc-import').onclick = () => $('#file-card').click();
    $('#file-card').onchange = e => {
      importCardFile(e.target.files && e.target.files[0]);
      e.target.value = '';
    };
    $('#modal-card').addEventListener('click', e => {
      if (e.target === $('#modal-card')) closeCardEditor(true);
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
      if (sidecarReady()) saveFeatureConfig();    // 安全项真源在侧车：单独同步一次
    };

    // —— 可选本地服务：探测 / 功能入口 / 安排与台账 ——
    const probeBtn = $('#btn-sidecar-probe');
    if (probeBtn) probeBtn.onclick = () => {
      const S = IR.Sidecar;
      if (!S) return;
      settings.sidecar = {
        port: Number(($('#s-sidecar-port') || {}).value) || 4319,
        token: (($('#s-sidecar-token') || {}).value || '').trim(),
      };
      persistSettings();
      S.configure(settings.sidecar);
      S.probe().then(ok => {
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
      if (!featuresAllowed()) { toast('剧情模式里没有定时主动：切到智能体 / 扮演模式再用', true); return; }
      openModal('modal-settings');
      if (sidecarReady()) loadFeatureConfig();
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
      renderStoragePanel();
      toast('已清理 ' + orphans.length + ' 张孤儿原图', false, true);
    };
    $('#btn-clear-save').onclick = async () => {
      if (!await irConfirm('清空本地存档与全部设置？此操作不可恢复。', { title: '危险操作', okText: '清空' })) return;
      Store.clearAll();
      settings = Store.defaultSettings();
      story = null;
      syncSettingsToForm();
      showStart();
      toast('已清空');
    };
    // 模型名变化 → 按能力重排参数字段（T-M-1）
    $('#s-chat-model').addEventListener('change', () => {
      const cap = Cap.find('chat', $('#s-chat-model').value.trim());
      settings.chat.model = $('#s-chat-model').value.trim();
      if (cap && +cap.contextWindow > 0) settings.chat.contextWindow = 0; // 交回登记表自动值
      if (!cap || !cap.thinking || cap.thinking.kind === 'none') settings.chat.thinking = 'default';
      renderCapabilityFields();
    });
    $('#s-image-model').addEventListener('change', () => {
      settings.image.model = $('#s-image-model').value.trim();
      renderCapabilityFields();
    });
    // 选了「自定义尺寸…」就亮出宽高输入（预填档位模式下隐藏）
    $('#s-image-size').addEventListener('change', () => {
      settings.image.size = $('#s-image-size').value;
      showImageWh(settings.image.size === '__custom__');
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

    // 退出即自动存档
    window.addEventListener('beforeunload', () => { if (story) saveAll(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && story) saveAll(); });
  }

  /* ================= 启动 ================= */

  function init() {
    // 后台落盘失败（最常见：本地空间满）不再静默：10 秒节流提示一次导出备份
    Store.setPersistErrorHandler(() => {
      if (Date.now() - lastSaveWarnAt < 10000) return;
      lastSaveWarnAt = Date.now();
      toast('存档写入失败（本地空间可能已满）：请「一键导出全部备份」，或删掉不用的故事 / 原图腾出空间', true, true);
    });
    // 原图是 Blob、异步取的：取到后把画面与缩略图重画一遍
    Store.setImageReadyHandler(() => { renderStage(); renderThumbs(); });

    Store.migrateLegacy();            // v0.1 旧档 → v0.2（幂等）
    settings = Store.loadSettings();  // 迁移后重新读取
    if (DEMO) settings = IR.Demo.applyTo(settings);   // 只改内存：演示适配器生效，配置不落盘
    bind();
    syncSettingsToForm();
    initFeatures();                   // 主动消息编排：去重 + 排队（投递走 sendPlayerAction）
    if (DEMO) {
      // 演示模式保持零外联：把本地服务换成一整套内存 mock，界面链路照样跑通
      if (IR.Demo && IR.Demo.installSidecarMock) IR.Demo.installSidecarMock();
    }
    initSidecar();                    // 探测本地服务；离线则三功能保持禁用
    if (DEMO) startDemo();            // 演示模式直接开演（跳过开始页与试画锚定）
    else showStart();                 // 入口 = 开始页（v0.1 原样）
    renderShelf();
    initStorageGuard().then(renderStoragePanel);   // P0：申请持久化 + 刷新存储面板
    remindBackupIfNeeded();                        // P0：7 天没备份就提醒一次
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
})();
