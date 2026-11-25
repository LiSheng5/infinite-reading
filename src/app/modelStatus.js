/*
 * src/app/modelStatus.js —— 测试连接、测试自动化与「模型」概览
 *
 * 三件事共用一份「当前表单里的角色配置」（readTestCfg）：
 *   1. 测试连接：按 TEST_TARGETS 读输入框 → 各适配器的 test()（只读、不生成内容、不花钱），
 *      结果写进 #test-*-state 与内存 Map（testResults，会话级——刷新页面回灰）；
 *   2. 测试自动化：地址 / Key / 模型失焦（change，防抖 800ms）自动测一次，短时缓存 + 并发去重；
 *   3. 模型概览（g-models 顶部六行）：host · 模型名 / 沿用剧情模型 / 未配置 / 未启用，
 *      左侧状态点读 testResults，点一行跳到对应配置（gotoSettingsBlock）。
 *
 * 只放内存：结果 Map、缓存、防抖计时器都不进 S.settings，不碰 store.ts（不新增持久化字段）。
 */
import { ImageProviders, VideoProviders, ChatProviders } from '../core/providers.ts';
import { A } from './core.js';

  const { $, errorText } = A;

  /* ---- 「测试连接」：只读当前输入框的值 ----
   * 三个原则：① 不保存设置、② 不生成内容、③ 生图绝不出图（不花钱）。
   * 子模型（画师 / 书记员 / 起草）留空的项按「沿用剧情模型」代入，测的就是实际会用到的那套配置。 */
  const TEST_TARGETS = {
    chat:    { kind: 'chat',  self: ['#s-chat-base', '#s-chat-key', '#s-chat-model'] },
    painter: { kind: 'chat',  self: ['#s-painter-base', '#s-painter-key', '#s-painter-model'], inherit: ['#s-chat-base', '#s-chat-key', '#s-chat-model'] },
    scribe:  { kind: 'chat',  self: ['#s-scribe-base', '#s-scribe-key', '#s-scribe-model'], inherit: ['#s-chat-base', '#s-chat-key', '#s-chat-model'] },
    draft:   { kind: 'chat',  self: ['#s-draft-base', '#s-draft-key', '#s-draft-model'], inherit: ['#s-chat-base', '#s-chat-key', '#s-chat-model'] },
    image:   { kind: 'image', self: ['#s-image-base', '#s-image-key', '#s-image-model'] },
    video:   { kind: 'video', self: ['#s-video-base', '#s-video-key', '#s-video-model'] },
  };

  /* 测试结果只进内存（会话级）：关掉设置页再开还在，刷新页面回灰。
   * 手动按钮与自动测试都走 testConnection → 同一份结果同时写 #test-*-state 与这里（概览读这里）。 */
  const testResults = new Map();   // key → { level: 'ok'|'warn'|'fail', message, at }

  function readTestCfg(t) {
    const pick = sel => { const el = $(sel); return el ? String(el.value || '').trim() : ''; };
    let inherited = false;
    const grab = i => {
      const own = pick(t.self[i]);
      if (own) return own;
      if (!t.inherit) return '';
      inherited = true;
      return pick(t.inherit[i]);
    };
    const pv = String((($('#s-image-provider') || {}).value) || '');
    return {
      cfg: {
        // 生图按面板上选的适配器测（comfyui 要带上 workflow / nodes，test 只用地址，出图才用它们）
        provider: t.kind === 'image'
          ? ((pv === 'minimax-image' || pv === 'comfyui') ? pv : 'openai-images')
          : (t.kind === 'video' ? 'minimax-video' : 'openai-compatible'),
        baseUrl: grab(0), apiKey: grab(1), model: grab(2),
        workflow: t.kind === 'image' ? String((($('#s-image-workflow') || {}).value || '')).trim() : '',
        nodes: t.kind === 'image' ? String((($('#s-image-nodes') || {}).value || '')).trim() : '',
      },
      inherited,
    };
  }

  async function testConnection(key, btn) {
    const t = TEST_TARGETS[key];
    if (!t) return;
    const el = $('#test-' + key + '-state');
    const set = (level, message) => {
      if (level) {
        testResults.set(key, { level: level, message: message, at: Date.now() });   // 概览状态点读这份
        renderModelOverview();   // 测完了把状态点当场刷出来（概览其余时刻跟表单走）
      }
      if (!el) return;
      el.className = 'hint test-state' + (level ? ' ' + level : '');
      el.textContent = message;
    };

    const { cfg, inherited } = readTestCfg(t);
    const adapter = t.kind === 'image'
      ? (ImageProviders[cfg.provider] || ImageProviders['openai-images'])
      : t.kind === 'video'
        ? (VideoProviders[cfg.provider] || VideoProviders['minimax-video'])
        : (ChatProviders[cfg.provider] || ChatProviders['openai-compatible']);
    if (!adapter || typeof adapter.test !== 'function') { set('fail', '这个适配器不支持测试连接。'); return; }

    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
    set(null, '正在连接 ' + (cfg.baseUrl || '（还没填地址）') + ' …');
    try {
      const r = await adapter.test(cfg);
      set(r.level, r.message + (inherited ? '（留空项已按剧情模型代入）' : ''));
    } catch (e) {
      set('fail', '测试失败：' + errorText(e));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  }

  /* ================= 测试连接自动化 =================
   * 地址 / Key / 模型填好后失焦（change）自动测一次，防抖 800ms；手动按钮保留（「重新测试」）。
   *
   * 自动测试只放「已核实只读、不生成内容、不花钱」的类型（对照 providers.ts 各 test() 的实现）：
   *   · image（openai-images / minimax-image / comfyui）—— 全是只读 GET（/models、GET 端点、/system_stats），绝不出图；
   *   · video（minimax-video）—— 只 GET 列任务（/v2/query/video_generation），绝不提交生成任务；
   *   · chat（openai-compatible）—— 主路径 GET /models 免费，但接口没有 /models 时会兜底一条
   *     max_tokens=1 的最小对话请求（providers.ts 注明「费用可忽略」，但确实可能产生费用、也算生成内容）。
   * 按「只对确认只读免费的类型启用自动测试；任何有可能产生费用的类型保持仅手动」这条口径：
   * 对话类（chat / painter / scribe / draft）不自动测，手动「重新测试」照旧可用。 */
  const AUTO_TEST = { image: true, video: true };
  const AUTO_TTL_MS = 2 * 60 * 1000;    // 「短时间缓存」：关掉设置页重开不重复狂测
  const AUTO_DEBOUNCE_MS = 800;
  const autoCache = new Map();     // sig → 上次测完的时间
  const autoInflight = new Map();  // sig → Promise（并发去重）
  const autoTimers = new Map();    // key → 防抖计时器
  const LOCAL_HOST_RE = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i;

  // 前置：Base URL 非空，且（Key 非空，或地址是本地 localhost / 127.0.0.1）
  function autoTestReady(key) {
    const t = TEST_TARGETS[key];
    if (!t || !AUTO_TEST[t.kind]) return false;
    const { cfg } = readTestCfg(t);
    const base = String(cfg.baseUrl || '').trim();
    const k = String(cfg.apiKey || '').trim();
    return !!base && (!!k || LOCAL_HOST_RE.test(base));
  }

  // 同一配置只算一次：地址 / Key / 模型（生图再加适配器）都进签名
  function autoTestSig(key) {
    const t = TEST_TARGETS[key];
    const { cfg } = readTestCfg(t);
    return key + '|' + String(cfg.provider || '') + '|' + String(cfg.baseUrl || '').trim()
      + '|' + String(cfg.apiKey || '').trim() + '|' + String(cfg.model || '').trim();
  }

  function maybeAutoTest(key) {
    if (!autoTestReady(key)) return;
    const sig = autoTestSig(key);
    const hit = autoCache.get(sig);
    if (hit && Date.now() - hit < AUTO_TTL_MS) return;   // 走缓存
    if (autoInflight.has(sig)) return;                   // 并发去重
    const p = Promise.resolve()
      .then(() => testConnection(key, null))             // 不弹 toast、不打断：只更新状态文字
      .catch(() => {})
      .then(() => {
        autoInflight.delete(sig);
        autoCache.set(sig, Date.now());
      });
    autoInflight.set(sig, p);
  }

  // 失焦（change）才触发，不在每次按键时打断输入；防抖约 800ms，连改几次只测一次
  function scheduleAutoTest(key) {
    if (autoTimers.has(key)) clearTimeout(autoTimers.get(key));
    autoTimers.set(key, setTimeout(() => { autoTimers.delete(key); maybeAutoTest(key); }, AUTO_DEBOUNCE_MS));
  }

  // 打开设置页补一轮（缓存命中就什么都不发）：概览的状态点当场就有底
  function autoTestSweep() {
    Object.keys(TEST_TARGETS).forEach(k => maybeAutoTest(k));
  }

  // 表单输入的公共绑定（只绑一次）：失焦自动测 + 概览即时跟表单走
  let liveBound = false;
  function bindModelFormLive() {
    if (liveBound) return;
    liveBound = true;
    Object.keys(TEST_TARGETS).forEach(key => {
      const t = TEST_TARGETS[key];
      t.self.forEach(sel => {
        const el = $(sel);
        if (!el) return;
        el.addEventListener('change', () => scheduleAutoTest(key));   // 失焦才测，不绑按键
        el.addEventListener('input', () => renderModelOverview());    // 概览即时更新
      });
    });
    // 生图适配器一换 = 换一套测试口径，也算配置变化
    const prov = $('#s-image-provider');
    if (prov) {
      prov.addEventListener('change', () => { scheduleAutoTest('image'); renderModelOverview(); });
    }
  }

  /* ---------- 角色配置一句话（概览与「剧情对话模型」状态行共用同一套格式） ----------
   * 只报主机名与模型名：不显示完整地址、绝不带 Key。
   * opts.inherit —— 该角色自己的字段全空 = 留空沿用剧情模型（画师 / 书记员 / 起草），
   *                这时不管代入后的配置长什么样，都只说「沿用剧情模型」；
   * opts.video   —— 生视频：留空 = 这功能没启用（不是「少配了什么」）。 */
  function hostOf(base) {
    const s = String(base || '').trim();
    if (!s) return '';
    try { return new URL(s).host || s; } catch (_) { return s; }
  }

  function describeRole(cfg, opts) {
    const o = opts || {};
    if (o.inherit) return '沿用剧情模型';
    const base = String((cfg && cfg.baseUrl) || '').trim();
    const model = String((cfg && cfg.model) || '').trim();
    const key = String((cfg && cfg.apiKey) || '').trim();
    if (!base && !model && !key) return o.video ? '未启用' : '未配置';
    const host = base ? hostOf(base) : '';
    if (host && model) return host + ' · ' + model;
    if (host) return host + '（还没选模型）';
    return '（还没填地址）' + (model ? ' · ' + model : '');
  }

  /* ---------- 模型概览（g-models 顶部）：六行，点一行跳到对应配置 ---------- */
  const OV_ROLES = [
    { key: 'chat', label: '剧情对话', group: 'g-models', target: '#fs-chat' },
    { key: 'painter', label: '画师', group: 'g-subs', target: '#fs-painter', inherit: true },
    { key: 'scribe', label: '书记员', group: 'g-subs', target: '#fs-scribe', inherit: true },
    { key: 'draft', label: '起草', group: 'g-subs', target: '#fs-draft', inherit: true },
    { key: 'image', label: '生图', group: 'g-image', target: '#fs-image' },
    { key: 'video', label: '生视频', group: 'g-image', target: '#fs-video', video: true },
  ];

  // 概览读「当前表单」（改地址 / 模型名即时跟着变，不用等保存）；状态点读 testResults（内存态）
  function renderModelOverview() {
    const box = $('#model-overview');
    if (!box) return;
    box.replaceChildren();
    OV_ROLES.forEach(r => {
      const t = TEST_TARGETS[r.key];
      const { cfg } = readTestCfg(t);
      const ownEmpty = t.self.every(s => {
        const el = $(s);
        return !el || !String(el.value || '').trim();
      });
      const desc = describeRole(cfg, { inherit: !!r.inherit && ownEmpty, video: !!r.video });
      const res = testResults.get(r.key);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ov-row';
      row.title = '点击跳到「' + r.label + '」的配置';
      const dot = document.createElement('span');
      dot.className = 'ov-dot' + (res ? (res.level === 'fail' ? ' st-fail' : ' st-ok') : '');
      dot.title = res ? String(res.message || '').slice(0, 120) : '还没测过（点右侧「重新测试」）';
      const label = document.createElement('span');
      label.className = 'ov-label';
      label.textContent = r.label;
      const d = document.createElement('span');
      d.className = 'ov-desc';
      d.textContent = desc;
      row.appendChild(dot);
      row.appendChild(label);
      row.appendChild(d);
      row.addEventListener('click', () => A.gotoSettingsBlock(r.group, r.target));
      box.appendChild(row);
    });
  }

  A.reg({ TEST_TARGETS, testConnection, describeRole, renderModelOverview, bindModelFormLive, autoTestSweep });
