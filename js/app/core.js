/*
 * js/app/core.js —— 默认值与提示词 / 共享状态 / 动效基座 / 小工具 / 弹窗栈
 * 从 js/app.js 拆出（只搬家，不改行为）。
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
  /* ---------- IR.App.state：原「状态」节的共享可变状态 ---------- */
  const A = (IR.App = IR.App || {});
  A.state = {
    settings: Store.loadSettings(),
    story: null,              // 进行中的故事
    busy: false,              // AI1 回合进行中
    currentChoices: [],       // 最新一轮的选项（choice 模式：默认收在「灵感」里）
    choicesTrayOpen: false,   // 选项托盘是否展开（每轮重置）
    live: null,               // 流式 / 打字机中的临时旁白 { text, reasoning }
    liveEl: null,
    liveReasonEl: null,       // 流式思考窗（方案 B：固定小窗滚动跟随）
    liveReasonCollapsed: false,   // 正文已开始 → 思考窗卷成一行
    liveReasonOpen: false,        // 用户点开看全量（照样自动跟随，不暂停）
    pendingInject: false,     // 注入记忆：已排定下一回合强制注入完整记忆（§4.4 手动层）
    anchor: null,             // 画风锚定状态（P4：{ onDone, batch, tried, candidates, pickedIdx, card, busy }）
    chatAbortCtrl: null,
    stopRequested: false,
    lastSaveWarnAt: 0,
    importJob: null,          // { raw, plan, result, busy, err }
    importModelMode: 'follow',    // follow | draft
    turnAnchor: { nodeId: null, dead: false },
    pw: null,                 // 画师工作台 { sceneId, prompt, promptRaw, alt, busy }
    immersiveTextHidden: false,
  };
  A.reg = function reg(map) {
    for (const k of Object.keys(map)) {
      if (Object.prototype.hasOwnProperty.call(A, k)) throw new Error('IR.App.reg: 重复注册 ' + k);
      A[k] = map[k];
    }
    return A;
  };
  const S = A.state;

  function requestChatStop() {
    if (!S.busy || S.stopRequested) return;
    S.stopRequested = true;
    if (S.chatAbortCtrl) { try { S.chatAbortCtrl.abort(); } catch (_) {} }
    toast('正在停止……');
  }
  // 用户主动停止导致的请求失败：跳过「流式失败转非流式」「tools 400 降级」等自动重试
  function isStopError(e) {
    return S.stopRequested && (e && (e.name === 'AbortError' || /abort/i.test((e && e.message) || '')));
  }
  // busy 期间发送按钮变身「停止」：按钮保持可点，点击即中断当前回合
  // 顶栏忙碌进度线 #busy-line 跟着同一状态显隐（UI-1 §4.3）
  function setSendButtonsBusy(on) {
    const line = $('#busy-line');
    if (line) line.classList.toggle('hidden', !on);
    const btn = $('#btn-send');
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = on ? '停止' : '发送';
    btn.classList.toggle('stop', !!on);
  }

  /* ================= 动效基座（UI-1） ================= */

  const motionMQ = (typeof window !== 'undefined' && window.matchMedia)
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  // 当前动效强度：settings.ui.motion + 系统「减少动态效果」→ IR.Motion.resolve
  function motionLevel() {
    return IR.Motion.resolve((S.settings.ui && S.settings.ui.motion) || 'auto', !!(motionMQ && motionMQ.matches));
  }

  function applyMotion() {
    const lv = motionLevel();
    document.documentElement.dataset.motion = lv;
    return lv;
  }

  // 页面不可见 → html[data-paused]（CSS 暂停一切循环动画）
  function applyPaused() {
    if (document.hidden) document.documentElement.dataset.paused = '1';
    else delete document.documentElement.dataset.paused;
  }

  // 动效令牌里的时长（毫秒）：JS 侧的 WAAPI 与 CSS 共用同一个真源
  function motionMs(name, fallbackMs) {
    try {
      const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
      return Number.isFinite(v) && v > 0 ? v : fallbackMs;
    } catch (_) { return fallbackMs; }
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
     irConfirm(msg, { title, okText, input, value, placeholder, checkbox }) → Promise
       无输入：确定 resolve(true)，取消 / 关闭 resolve(null)
       有输入：确定 resolve(字符串)，取消 / 关闭 resolve(null)
       有 checkbox（勾选文案）：确定 resolve({ ok:true, checked })，取消 / 关闭 resolve(null) */
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
      const withCheck = !!opts.checkbox && !withInput;
      const cw = $('#cf-check-wrap');
      if (cw) {
        cw.classList.toggle('hidden', !withCheck);
        const cb = $('#cf-check');
        if (cb) cb.checked = false;
        const ct = $('#cf-check-text');
        if (ct) ct.textContent = String(opts.checkbox || '');
      }
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
    if (!$('#cf-input-wrap').classList.contains('hidden')) return $('#cf-input').value;
    const cw = $('#cf-check-wrap');
    if (cw && !cw.classList.contains('hidden')) {
      const cb = $('#cf-check');
      return { ok: true, checked: !!(cb && cb.checked) };
    }
    return true;
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
    if (id === 'modal-painter') { A.closeWorkbench(); return; }
    if (id === 'modal-anchor') { A.closeAnchor(); return; }
    if (id === 'modal-import-text') { A.closeImportText(); return; }
    if (id === 'modal-card') { A.closeCardEditor(true); return; }
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

  // sleep / clone 的唯一口径在 IR.sleep / IR.clone（tree.js，审查 可维护性 三·1 / 三·5）：
  // 这里只转接进 A.reg，app 模块照旧解构 { sleep, clone }，实现全仓只有一份
  const sleep = IR.sleep;
  const clone = IR.clone;
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

  // 设置落盘的唯一出口：演示模式只改内存，不写盘
  function persistSettings() {
    if (DEMO) return;
    Store.saveSettings(S.settings);
  }

  function saveAll() {
    persistSettings();
    if (S.story) {
      const ok = Store.saveStory(S.story);
      Store.setCurrentId(S.story.id);
      // 写入失败（多为本地存储超限）不再静默：提示用户导出备份（10 秒节流防刷屏）
      if (!ok && Date.now() - S.lastSaveWarnAt > 10000) {
        S.lastSaveWarnAt = Date.now();
        toast('存档写入失败（本地存储可能已满）：请导出故事备份，或删除不用的故事腾出空间', true, true);
      }
    }
  }

  // 子模型（画师/书记员/起草）配置：留空即沿用剧情模型
  function resolveSub(name) {
    const sub = S.settings[name] || {};
    const c = S.settings.chat;
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
    const im = Object.assign({}, S.settings.image, override || {});
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

  /* 图标：sprite 在 index.html 顶部（#ir-icons）。icon() 返回静态 SVG 字符串（只拼固定名字，不含用户数据），
   * iconEl() 返回元素。cls 例：'ic-l' = 图标在文字左边留一点空隙。 */
  function icon(name, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }
  function iconEl(name, cls) {
    const t = document.createElement('template');
    t.innerHTML = icon(name, cls);
    return t.content.firstChild;
  }

  function miniBtn(text, fn, cls) {
    const b = document.createElement('button');
    b.className = 'mini-btn' + (cls ? ' ' + cls : '');
    b.textContent = text;
    b.onclick = fn;
    return b;
  }

  /* 人物设定独立控件（可增删行）：替代「名字｜性格｜说话方式」一行一个的竖线文本框。
   * container 渲染行（.char-row）；addBtn 可选（不传就自建「+ 添加人物」放容器后面）。
   * fields: [{ key, label?, placeholder? }]，每行每字段一个输入框。
   * opts.variant：'row'（默认，表格形态：一行五字段 + 表头，向导 / 文本导入用）
   *              'card'（行卡形态：首行「名字 + 在场/离场」各占一半、下方三个全宽输入、
   *                      右上角 40px 删除钮、不出表头——本对话设置的世界卡编辑器用，
   *                      阶段 4 屏 2 迁移方案）。
   * 返回 { set(list), get(), add(vals) }：get() 滤掉全空行、不造字段外的值。 */
  function charEditor(container, fields, addBtn, opts) {
    fields = fields || [];
    const variant = (opts && opts.variant === 'card') ? 'card' : 'row';
    // 表头：每个字段的可见名字（名字 / 性格 / 说话方式……），与输入框同列对齐（行卡形态不出表头）
    function makeHead() {
      const head = document.createElement('div');
      head.className = 'char-head';
      fields.forEach(f => {
        const s = document.createElement('span');
        s.textContent = f.label || '';
        head.appendChild(s);
      });
      const spacer = document.createElement('span');
      spacer.className = 'char-del';
      head.appendChild(spacer);
      return head;
    }
    function makeRow(vals) {
      const row = document.createElement('div');
      row.className = 'char-row' + (variant === 'card' ? ' card' : '');
      fields.forEach((f, i) => {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.dataset.k = f.key;
        inp.placeholder = f.placeholder || f.label || f.key;
        inp.spellcheck = false;
        inp.value = vals && vals[f.key] != null ? String(vals[f.key]) : '';
        if (variant === 'card' && i >= 2) inp.className = 'char-wide';   // 性格 / 说话方式 / 备注整行
        row.appendChild(inp);
      });
      const del = miniBtn('', () => row.remove(), 'char-del');
      del.innerHTML = icon('x');
      del.title = '删除这一行'; del.setAttribute('aria-label', '删除这一行');
      row.appendChild(del);
      return row;
    }
    function rows() { return Array.prototype.slice.call(container.querySelectorAll('.char-row')); }
    const api = {
      set(list) {
        container.textContent = '';
        if (variant === 'row' && fields.some(f => f.label)) container.appendChild(makeHead());
        (Array.isArray(list) ? list : []).forEach(v => container.appendChild(makeRow(v)));
        if (!rows().length) container.appendChild(makeRow(null));   // 空表也给一行，看得见字段形状
      },
      get() {
        return rows().map(row => {
          const o = {};
          let any = false;
          Array.prototype.slice.call(row.querySelectorAll('input')).forEach(inp => {
            const v = inp.value.trim();
            if (v) any = true;
            o[inp.dataset.k] = v;
          });
          return any ? o : null;
        }).filter(Boolean);
      },
      add(vals) {
        const r = makeRow(vals);
        container.appendChild(r);
        return r;
      },
    };
    let btn = addBtn;
    if (!btn) {
      btn = miniBtn('+ 添加人物', null, 'char-add');
      if (container.parentNode) container.parentNode.insertBefore(btn, container.nextSibling);
    }
    btn.onclick = () => {
      const r = api.add(null);
      const inp = r.querySelector('input');
      if (inp) inp.focus();
    };
    if (!rows().length) api.set([]);   // 挂载即见表头 + 一行空行
    return api;
  }

  A.reg({
    $,
    Store,
    Cap,
    DEMO,
    STYLE_PRESETS,
    MODE_LABELS,
    KIND_LABELS,
    DEFAULT_TOPIC,
    CHAT_PREMISE,
    rpPremise,
    SCRIBE_SYSTEM,
    SCRIBE_COMPRESS_SYSTEM,
    SCRIBE_ROLLING_SYSTEM,
    DRAFT_SYSTEM,
    IMAGE_ASPECTS,
    requestChatStop,
    isStopError,
    setSendButtonsBusy,
    motionMQ,
    motionLevel,
    applyMotion,
    applyPaused,
    motionMs,
    toast,
    hideToast,
    icon,
    iconEl,
    irConfirm,
    closeConfirm,
    confirmValue,
    charEditor,
    MODAL_IDS,
    modalStack,
    openModal,
    closeModal,
    dismissModal,
    closeTopModal,
    netErrHint,
    offlineBlocked,
    sleep,
    clone,
    fmtTime,
    fmtMB,
    persistSettings,
    saveAll,
    resolveSub,
    imageCfg,
    miniBtn,
  });
})();
