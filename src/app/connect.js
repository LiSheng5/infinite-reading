/*
 * src/app/connect.js —— 接入模型配置向导（#modal-connect）+ 首次启动自动弹出
 *
 * 四步（默认走厂商直连）：① 三选一（厂商预设 / 自定义 Base URL / 聚合模式）
 * → ② 填 API Key（本地模型自动跳过）→ ③ 选模型（GET /models 自动拉取，失败退手填、不阻塞）
 * → ④ 测试连接（复用 ChatProviders 的 test，只读探测）→ 写入现有 S.settings.chat 完成接入。
 *
 * 三条既定口径：
 *   · 预设只预填 Base URL + 显示名，**永不预填 / 硬编码模型名**——模型名只来自 /models 或手填；
 *   · 向导写入现有 S.settings.chat / connectionMode，不造平行存储；完整设置表单仍是高级入口
 *     （每一步都能「跳过，直接填完整表单」）；
 *   · 聚合模式 = 走现成第三方聚合商（OpenRouter / 硅基流动）中转，不是自建网关：
 *     警示写在选择卡片上，选中后设置页常驻徽章，可一键切回直连（见 settings.js）。
 */
import { ChatProviders } from '../core/providers.ts';
import { A, saveAll, toast } from './core.js';

  const S = A.state;
  const { $, openModal, closeModal } = A;

  const STEP_IDS = ['cw-step-1', 'cw-step-2', 'cw-step-3', 'cw-step-4'];
  // 本地模型（Ollama / LM Studio / vLLM）：不用 Key，第二步直接跳过
  const LOCAL_BASE_RE = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i;

  const W = { step: 1, mode: '', via: '', base: '' };

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
    const chat = S.settings.chat || (S.settings.chat = {});
    chat.provider = 'openai-compatible';
    chat.baseUrl = cfg.baseUrl;
    chat.apiKey = cfg.apiKey;
    chat.model = cfg.model;
    S.settings.connectionMode = (W.mode === 'aggregate') ? 'aggregate' : 'direct';
    S.settings.connectionVia = (W.mode === 'aggregate') ? (W.via || '第三方聚合商') : '';
    markSetupSeen();
    saveAll();
    A.syncSettingsToForm();   // 设置表单 / 模型下拉 / 聚合徽章一起对账
    closeModal('modal-connect');
    toast('接入完成：' + cfg.baseUrl + (cfg.model ? ' · ' + cfg.model : '') + '，可以开始用了');
  }

  /* ---------------- 打开 / 绑定 ---------------- */

  function openConnectWizard() {
    W.mode = '';
    W.via = '';
    W.step = 1;
    W.base = '';
    // 重新打开时预填现有配置（方便改；模型名照旧只回显已填的值，不预置清单）
    const chat = S.settings.chat || {};
    const keyEl = $('#cw-key'); if (keyEl) keyEl.value = chat.apiKey || '';
    const modelEl = $('#cw-model'); if (modelEl) modelEl.value = chat.model || '';
    const customEl = $('#cw-custom-base'); if (customEl) customEl.value = chat.baseUrl || '';
    if (S.settings.connectionMode === 'aggregate') {
      // 聚合模式来的：回到聚合分支并带上现址（改直连要显式换分支）
      W.mode = 'aggregate';
      W.via = S.settings.connectionVia || '';
      W.base = chat.baseUrl || '';
    } else if (/^https?:\/\//i.test(String(chat.baseUrl || ''))) {
      W.mode = 'preset';
      W.base = chat.baseUrl || '';
    }
    showPickPanels();
    openModal('modal-connect');
    goStep(1);
    renderEcho();
  }

  // 跳过向导，直接打开完整设置表单（高级入口，一直保留）
  function skipToFullForm() {
    markSetupSeen();
    saveAll();
    closeModal('modal-connect');
    openModal('modal-settings');
    A.syncSettingsToForm();
  }

  function goNext() {
    const flow = stepFlow();
    const i = flow.indexOf(W.step);
    if (i < 0) return;
    if (i === 0) {
      const cfg = currentCfg();
      if (!cfg.baseUrl) {
        const hint = $('#cw-step1-hint');
        if (hint) hint.textContent = '先选一种接入方式（厂商预设 / 自定义地址 / 聚合模式），填好地址才能继续。';
        return;
      }
    }
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
        const hint = $('#cw-step1-hint');
        if (hint) hint.textContent = '';
      };
    });
    // 厂商速选 / 聚合商速选（事件委托）：点一下只填 Base URL（聚合商另记运营方）
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
      if (via) W.mode = 'aggregate';
      showPickPanels();
      // 本地模型不过「填 Key」：直接进流程里的下一步（可能是选模型）
      const flow = stepFlow();
      goStep(flow[Math.min(1, flow.length - 1)]);
    };
    const presetWrap = $('#cw-preset-wrap');
    if (presetWrap) presetWrap.addEventListener('click', onPick);
    const aggWrap = $('#cw-agg-wrap');
    if (aggWrap) aggWrap.addEventListener('click', onPick);

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

  A.reg({ openConnectWizard, bindConnectWizard, maybeOpenConnectWizard });
