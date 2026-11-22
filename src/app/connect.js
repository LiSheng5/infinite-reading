/*
 * src/app/connect.js —— 接入主对话模型的向导（#modal-connect）+ 首次启动自动弹出
 *
 * 四步（默认走厂商直连）：① 三选一（厂商预设 / 自定义 Base URL / 聚合模式）
 * → ② 填 API Key（本地模型自动跳过）→ ③ 选模型（GET /models 自动拉取，失败退手填、不阻塞）
 * → ④ 测试连接（复用 ChatProviders 的 test，只读探测）→ 写入现有 S.settings.chat 完成接入。
 *
 * 既定口径：
 *   · 预设只预填 Base URL + 显示名，**永不预填 / 硬编码模型名**——模型名只来自 /models 或手填；
 *   · 向导写入现有 S.settings.chat / connectionMode，不造平行存储；也可以直接在设置里填写
 *     （页脚「跳过，直接在设置里填写」）；
 *   · 聚合模式 = 走现成第三方聚合商（OpenRouter / 硅基流动）中转，不是自建网关：
 *     完整知情警示只写一处（选聚合商的面板），选中后设置页常驻徽章，可一键切回直连（见 settings.js）；
 *   · 步骤节奏统一：选好后一律手点「下一步」（自定义地址按回车 = 点下一步），按钮常亮、
 *     不能走时点一下就给出明确原因；
 *   · 误关不丢数据：本次打开后填过内容时，X / 遮罩 / Esc 先弹确认再丢弃。
 */
import { ChatProviders } from '../core/providers.ts';
import { matchAggregator, matchBaseUrlOption, vendorKeyUrl, vendorKeyName } from '../screens/settings/settingsForm.js';
import { A, saveAll, toast } from './core.js';

  const S = A.state;
  const { $, openModal, closeModal, irConfirm } = A;

  const STEP_IDS = ['cw-step-1', 'cw-step-2', 'cw-step-3', 'cw-step-4'];
  // 本地模型（Ollama / LM Studio / vLLM）：不用 Key，第二步直接跳过
  const LOCAL_BASE_RE = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i;

  // from = 这次向导从哪开的（settings = 设置页里点进来 / first-run = 首次启动）；
  // dirty = 本次打开后用户动过内容（预填不算）——关闭确认只拦「真的会丢东西」的场景
  const W = { step: 1, mode: '', via: '', base: '', from: 'first-run', dirty: false };

  function isLocalBase(base) { return LOCAL_BASE_RE.test(String(base || '').trim()); }

  function currentCfg() {
    const base = (W.mode === 'custom'
      ? String((($('#cw-custom-base') || {}).value) || '')
      : String(W.base || '')).trim();
    return {
      provider: 'openai-compatible',
      baseUrl: base,
      apiKey: String((($('#cw-key') || {}).value) || '').trim(),
      model: String((($('#cw-model') || {}).value) || '').trim(),
    };
  }

  // 本地模型不过「填 Key」那一步：流程按当前地址动态收 / 放
  function stepFlow() {
    return isLocalBase(currentCfg().baseUrl) ? [1, 3, 4] : [1, 2, 3, 4];
  }

  /* ---------------- 步骤渲染 ---------------- */

  function goStep(n) {
    const flow = stepFlow();
    if (flow.indexOf(n) < 0) n = flow[0];
    W.step = n;
    STEP_IDS.forEach((id, i) => {
      const el = $('#' + id);
      if (el) el.classList.toggle('hidden', i + 1 !== n);
    });
    const back = $('#cw-back');
    if (back) back.disabled = (n === flow[0]);
    const next = $('#cw-next');
    if (next) next.textContent = (n === 4) ? '完成并进入使用' : '下一步';
    renderEcho();
    if (n === 3) loadModels();
    if (n === 4) setTest(null, '只读探测：不生成内容，不花钱。');
  }

  // 第二 / 四步的「你现在接的是谁」回显（聚合模式再补一条知情警示）
  function renderEcho() {
    const cfg = currentCfg();
    const echo = $('#cw-base-echo');
    if (echo) echo.textContent = cfg.baseUrl ? ('当前接入：' + cfg.baseUrl) : '';
    const sum = $('#cw-summary');
    if (sum) sum.textContent = cfg.baseUrl
      ? ('当前接入：' + cfg.baseUrl + (cfg.model ? ' · ' + cfg.model : '（还没选模型）'))
      : '';
    const aggEcho = $('#cw-agg-echo');
    if (aggEcho) {
      const agg = W.mode === 'aggregate';
      aggEcho.classList.toggle('hidden', !agg);
      if (agg) {
        aggEcho.textContent = '聚合模式提醒：你的对话内容与 API Key 会先经过 '
          + (W.via || '该第三方聚合商') + ' 服务器再转发到模型厂商（浏览器 → '
          + (W.via || '第三方') + ' → 模型厂商）。仅在你接受这一点时使用；不想经过第三方请返回第一步选厂商直连。';
      }
    }
    const keyNote = $('#cw-key-note');
    if (keyNote) {
      keyNote.textContent = cfg.apiKey ? '' : '还没填 Key：多数云服务商需要它；本地模型则不用。填不填都能继续，测试连接失败时回来补。';
    }
    // 「去 xxx 获取 Key」：只对核实过密钥页的厂商亮出来（本地 / 自定义 / 未收录 → 整行藏起来）
    const keyLinkWrap = $('#cw-key-link-wrap');
    const keyLink = $('#cw-key-link');
    const keyUrl = vendorKeyUrl(cfg.baseUrl);
    if (keyLinkWrap && keyLink) {
      keyLinkWrap.classList.toggle('hidden', !keyUrl);
      if (keyUrl) {
        const name = vendorKeyName(cfg.baseUrl) || '该厂商';
        keyLink.href = keyUrl;
        keyLink.textContent = '去 ' + name + ' 获取 Key';
      } else {
        keyLink.removeAttribute('href');
        keyLink.textContent = '';
      }
    }
  }

  // 第一步的三种选择面板：互斥显示
  function showPickPanels() {
    const map = { preset: '#cw-preset-wrap', custom: '#cw-custom-wrap', aggregate: '#cw-agg-wrap' };
    Object.keys(map).forEach(k => {
      const el = $(map[k]);
      if (el) el.classList.toggle('hidden', W.mode !== k);
    });
    ['cw-card-preset', 'cw-card-custom', 'cw-card-agg'].forEach(id => {
      const el = $('#' + id);
      if (el) {
        const on = el.getAttribute('data-mode') === W.mode;
        el.classList.toggle('cw-sel', on);
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    });
  }

  /* ---------------- 第三步：模型列表（拉取失败退手填，不阻塞） ---------------- */

  let modelLoadSeq = 0;

  async function loadModels() {
    const seq = ++modelLoadSeq;
    const hint = $('#cw-model-hint');
    const setHint = (cls, msg) => {
      if (hint) { hint.className = 'hint' + (cls ? ' ' + cls : ''); hint.textContent = msg; }
    };
    const cfg = currentCfg();
    if (!cfg.baseUrl) { setHint('', '先回到第一步选好接口地址。'); return; }
    setHint('', '正在拉取模型列表…');
    // 模型列表走 A 注册表（src/app/modelLists.js）：app 模块间调用统一走 A
    const r = await A.fetchModelList(cfg.baseUrl, cfg.apiKey);
    if (seq !== modelLoadSeq) return;   // 地址换了 / 又点了一次：旧结果作废
    A.fillDatalist('cw-dl-model', r.models);
    // 清单存进 modelLists.js 的缓存，再按它检查已填的模型名（不一致才提示，绝不拦「下一步」）
    A.noteModelList('cw-dl-model', r.ok ? r.models : []);
    A.checkModelSpelling('cw-dl-model', '#cw-model', 'cw-model-spell');
    if (r.ok) {
      setHint('ok', r.models.length
        ? ('拉到 ' + r.models.length + ' 个模型：点上面的输入框下拉挑一个，也可以直接输入。')
        : '接口可达，但没返回模型清单：直接手填模型名即可。');
    } else {
      setHint('warn', (r.message || '没拉到模型列表') + '。不影响流程：直接手填模型名即可。');
    }
  }

  /* ---------------- 第四步：测试连接（复用适配器的只读探测） ---------------- */

  function setTest(level, message) {
    const el = $('#cw-test-state');
    if (!el) return;
    el.className = 'hint test-state' + (level ? ' ' + level : '');
    el.textContent = message;
  }

  async function testWizard() {
    const cfg = currentCfg();
    if (!cfg.baseUrl) { setTest('fail', '还没填接口地址：回到第一步选一个。'); return; }
    if (!cfg.model) { setTest('fail', '还没填模型名：回到第三步选一个或手填。'); return; }
    const btn = $('#cw-test-btn');
    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
    setTest(null, '正在连接 ' + cfg.baseUrl + ' …');
    try {
      const r = await ChatProviders['openai-compatible'].test(cfg);
      setTest(r.level, r.message);
    } catch (e) {
      // test() 本身不抛（失败也返回人话结果），这里只兜底意外异常
      setTest('fail', '测试失败：' + ((e && e.message) ? e.message : String(e)));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  }

  /* ---------------- 完成：写入现有设置结构 ---------------- */

  function markSetupSeen() {
    S.settings.setupSeen = true;
  }

  function finishConnect() {
    const cfg = currentCfg();
    if (!cfg.baseUrl) {
      toast('还没填接口地址：回到第一步选一个', true);
      goStep(1);
      return;
    }
    // 「首次接入」必须在 markSetupSeen 之前判：那一步会把 setupSeen 置 true
    const firstRun = !S.settings.setupSeen;
    const chat = S.settings.chat || (S.settings.chat = {});
    chat.provider = 'openai-compatible';
    chat.baseUrl = cfg.baseUrl;
    chat.apiKey = cfg.apiKey;
    chat.model = cfg.model;
    // 接入方式只认最终写入的地址（与设置表单保存同口径）：命中聚合商 = 聚合模式
    const agg = matchAggregator(cfg.baseUrl);
    S.settings.connectionMode = agg ? 'aggregate' : 'direct';
    S.settings.connectionVia = agg ? (agg.via || '第三方聚合商') : '';
    markSetupSeen();
    saveAll();
    A.syncSettingsToForm();   // 设置表单 / 模型下拉 / 聚合徽章一起对账
    closeModal('modal-connect');
    toast('接入完成：' + cfg.baseUrl + (cfg.model ? ' · ' + cfg.model : '') + '，可以开始用了');
    if (firstRun) showFirstRunGuide();
  }

  /* ---- 首次接入后的「其余可稍后再配」引导 ----
   * 只在这一步真的发生「没接入 → 接入」时出现；老用户重走向导是来改配置的，不再重复。
   * 文案有据：生图 / 生视频各走自己的队列（src/core/paintQueue.ts 的串行作画队列、视频是独立异步任务），
   * 配置缺失只让这一次作画失败并给出提示，回合正文照常生成、故事照常读——所以「不配也能读故事」成立，
   * 少的只是自动作画。不写成「完全没有影响」，也不写成「必须配好才能读」。 */
  async function showFirstRunGuide() {
    const go = await irConfirm(
      '生图、生视频不是必须现在配：不配也能照常读故事，只是不会自动作画，之后随时可以在设置里补上。',
      { title: '接入完成 · 可以开始用了', okText: '去配置生图' },
    );
    if (!go) return;
    A.openSettings();              // 先打开设置页（顺带回填表单、展开已配置的折叠块）
    A.openSettingsGroup('g-image');   // 再切到「生图与画风」
  }

  /* ---------------- 打开 / 绑定 ---------------- */

  function openConnectWizard(from) {
    W.mode = '';
    W.via = '';
    W.step = 1;
    W.base = '';
    W.dirty = false;
    // 来源：设置页点进来的（关掉向导就回到设置）/ 首次启动自动弹的（跳过才要顺路开设置）
    W.from = from || (A.modalStack.indexOf('modal-settings') >= 0 ? 'settings' : 'first-run');
    // 重新打开时预填现有配置（方便改；模型名照旧只回显已填的值，不预置清单）
    const chat = S.settings.chat || {};
    const keyEl = $('#cw-key'); if (keyEl) keyEl.value = chat.apiKey || '';
    const modelEl = $('#cw-model'); if (modelEl) modelEl.value = chat.model || '';
    const customEl = $('#cw-custom-base'); if (customEl) customEl.value = chat.baseUrl || '';
    // 已有配置落在哪个分支只看地址：命中聚合商 → 聚合分支；命中厂商预设 → 预设分支；
    // 其余（自定义地址）→ 自定义分支（以前一律算预设，自定义地址会被错归类）
    const agg = matchAggregator(chat.baseUrl);
    if (agg) {
      W.mode = 'aggregate';
      W.via = agg.via;
      W.base = chat.baseUrl || '';
    } else if (matchBaseUrlOption(chat.baseUrl)) {
      W.mode = 'preset';
      W.base = chat.baseUrl || '';
    } else if (String(chat.baseUrl || '').trim()) {
      W.mode = 'custom';
    }
    showPickPanels();
    openModal('modal-connect');
    goStep(1);
    renderEcho();
    renderStep1Hint();
  }

  // 跳过向导：设置页开进来的只关向导（设置就在下面）；首次启动的才顺路打开设置
  function skipToFullForm() {
    markSetupSeen();
    saveAll();
    closeModal('modal-connect');
    if (W.from !== 'settings') openModal('modal-settings');
    A.syncSettingsToForm();
  }

  // X / 遮罩 / Esc 的统一收尾（modalHost.dismissModal 收口到这里）：
  // 本次打开后填过内容就先弹确认，确认了才丢弃——误关不丢数据
  async function closeConnectWizard() {
    if (W.dirty && wizardHasInput()) {
      const ok = await irConfirm('向导里已经填了内容，关闭就会丢弃。确定关闭吗？', {
        title: '关闭接入向导', okText: '丢弃并关闭',
      });
      if (!ok) return;
    }
    closeModal('modal-connect');
  }

  function wizardHasInput() {
    const cfg = currentCfg();
    return !!(cfg.baseUrl || cfg.apiKey || cfg.model
      || String((($('#cw-custom-base') || {}).value) || '').trim());
  }

  // 第一步「下一步」的准入检查：返回不能走的原因（'' = 可以走）。
  // 按钮常亮，不能走时点一下就把原因写在提示行——不给「按钮灰着但不知道为什么」的体验。
  function step1Blocker() {
    if (!W.mode) return '先选一种接入方式（厂商预设 / 自定义地址 / 聚合模式），选好才能继续。';
    const cfg = currentCfg();
    if (!cfg.baseUrl) {
      return W.mode === 'custom'
        ? '还没填 Base URL：填一个接口地址（通常以 /v1 结尾）才能继续。'
        : '还没选服务商：点一家填好接口地址才能继续。';
    }
    if (!/^https?:\/\//i.test(cfg.baseUrl) && !isLocalBase(cfg.baseUrl)) {
      return '地址要以 http:// 或 https:// 开头（本地模型可以写 localhost:端口）。';
    }
    return '';
  }

  function renderStep1Hint() {
    const hint = $('#cw-step1-hint');
    if (hint) hint.textContent = step1Blocker() || '没问题了，点「下一步」继续。';
  }

  function goNext() {
    const flow = stepFlow();
    const i = flow.indexOf(W.step);
    if (i < 0) return;
    if (i === 0 && step1Blocker()) { renderStep1Hint(); return; }
    if (i >= flow.length - 1) { finishConnect(); return; }
    goStep(flow[i + 1]);
  }

  function goBack() {
    const flow = stepFlow();
    const i = flow.indexOf(W.step);
    if (i > 0) goStep(flow[i - 1]);
  }

  function bindConnectWizard() {
    // 第一步：三选一卡片（换分支就清空已选地址，防止带着上一个分支的地址走）
    ['cw-card-preset', 'cw-card-custom', 'cw-card-agg'].forEach(id => {
      const el = $('#' + id);
      if (el) el.onclick = () => {
        W.mode = el.getAttribute('data-mode') || '';
        W.via = '';
        W.base = '';
        showPickPanels();
        renderStep1Hint();
      };
    });
    // 厂商速选 / 聚合商速选（事件委托）：点一下只填 Base URL（聚合商另记运营方），
    // 不自动跳步——与自定义地址同节奏，一律点「下一步」继续
    const onPick = (e) => {
      const b = e.target.closest && e.target.closest('[data-base]');
      if (!b) return;
      const base = b.getAttribute('data-base') || '';
      const via = b.getAttribute('data-via') || '';
      document.querySelectorAll('.cw-vendor, .cw-agg-pick').forEach(x => x.classList.remove('cw-sel'));
      b.classList.add('cw-sel');
      if (base !== W.base) {
        W.base = base;
        // 换了服务商：旧模型名对新地址不适用，清掉（模型名只来自 /models 或手填）
        const m = $('#cw-model');
        if (m) m.value = '';
      }
      W.via = via;
      W.dirty = true;
      if (via) W.mode = 'aggregate';
      showPickPanels();
      renderStep1Hint();
    };
    const presetWrap = $('#cw-preset-wrap');
    if (presetWrap) presetWrap.addEventListener('click', onPick);
    const aggWrap = $('#cw-agg-wrap');
    if (aggWrap) aggWrap.addEventListener('click', onPick);

    // 用户动过内容就记一笔（预填不算）：关闭确认只拦「真的会丢东西」的场景
    ['cw-key', 'cw-model', 'cw-custom-base'].forEach(id => {
      const el = $('#' + id);
      if (el) el.addEventListener('input', () => { W.dirty = true; });
    });
    // 模型名失焦：走设置页同一个拼写检查（列表没拉到 / 为空时什么都不提示，也不拦流程）
    const cwModelEl = $('#cw-model');
    if (cwModelEl) {
      cwModelEl.addEventListener('change', () => A.checkModelSpelling('cw-dl-model', '#cw-model', 'cw-model-spell'));
    }
    // 自定义 Base URL：回车 = 点「下一步」；失焦时把「还差什么」写清楚（按钮本身常亮）
    const customBase = $('#cw-custom-base');
    if (customBase) {
      customBase.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); goNext(); }
      });
      customBase.addEventListener('blur', () => { if (W.mode === 'custom') renderStep1Hint(); });
    }

    const next = $('#cw-next'); if (next) next.onclick = goNext;
    const back = $('#cw-back'); if (back) back.onclick = goBack;
    const skip = $('#cw-skip-form'); if (skip) skip.onclick = skipToFullForm;
    const reload = $('#cw-model-reload'); if (reload) reload.onclick = loadModels;
    const testBtn = $('#cw-test-btn'); if (testBtn) testBtn.onclick = testWizard;
  }

  // 首次启动（还没接入过）自动弹向导；已经配过接入的老用户记为看过，不打扰
  function maybeOpenConnectWizard() {
    if (S.settings.setupSeen) return;
    if (!S.settings.chat.baseUrl) { openConnectWizard(); return; }
    markSetupSeen();
    saveAll();
  }

  A.reg({ openConnectWizard, closeConnectWizard, bindConnectWizard, maybeOpenConnectWizard });
