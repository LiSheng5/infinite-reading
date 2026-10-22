/*
 * js/app/settings.js —— 设置界面 / 故事记忆面板 / 注入记忆 / 用户画像面板
 * 从 js/app.js 拆出（只搬家，不改行为）。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, Store, DEMO, MODE_LABELS, IMAGE_ASPECTS, applyMotion, toast, irConfirm, fmtTime, saveAll, miniBtn } = A;

  function syncSettingsToForm() {
    A.renderLayoutHint();   // 布局项在 chat / rp 下要有「此模式没有画面区」的灰字说明
    // 可选本地服务：这里只同步「怎么连它」（端口 + token）；额度 / 白名单等安全项由侧车 config.json 提供
    const sc = S.settings.sidecar || {};
    if ($('#s-sidecar-port')) $('#s-sidecar-port').value = sc.port || 4319;
    if ($('#s-sidecar-token')) $('#s-sidecar-token').value = sc.token || '';
    $('#s-chat-base').value = S.settings.chat.baseUrl;
    $('#s-chat-model').value = S.settings.chat.model;
    $('#s-chat-key').value = S.settings.chat.apiKey;
    $('#s-chat-temp').value = S.settings.chat.temperature;
    $('#s-chat-params').value = typeof S.settings.chat.extraParams === 'string' ? S.settings.chat.extraParams : '';

    $('#s-painter-base').value = S.settings.painter.baseUrl;
    $('#s-painter-model').value = S.settings.painter.model;
    $('#s-painter-key').value = S.settings.painter.apiKey;

    $('#s-scribe-enabled').checked = !!S.settings.scribe.enabled;
    $('#s-scribe-every').value = S.settings.scribe.every || 10;
    $('#s-scribe-ai').checked = S.settings.scribe.aiTasks !== false;
    $('#s-scribe-base').value = S.settings.scribe.baseUrl;
    $('#s-scribe-model').value = S.settings.scribe.model;
    $('#s-scribe-key').value = S.settings.scribe.apiKey;

    $('#s-draft-base').value = S.settings.draft.baseUrl;
    $('#s-draft-model').value = S.settings.draft.model;
    $('#s-draft-key').value = S.settings.draft.apiKey;

    $('#s-image-base').value = S.settings.image.baseUrl;
    $('#s-image-model').value = S.settings.image.model;
    $('#s-image-key').value = S.settings.image.apiKey;
    $('#s-image-params').value = typeof S.settings.image.extraParams === 'string' ? S.settings.image.extraParams : '';
    const vd = S.settings.video || {};
    $('#s-video-base').value = vd.baseUrl || '';
    $('#s-video-model').value = vd.model || '';
    $('#s-video-key').value = vd.apiKey || '';
    $('#s-video-duration').value = vd.duration || 5;
    $('#s-video-resolution').value = vd.resolution || '768P';
    $('#s-video-ratio').value = vd.ratio || '16:9';
    $('#s-video-params').value = typeof vd.extraParams === 'string' ? vd.extraParams : '';
    $('#s-image-aspect').value = S.settings.image.aspect || '16:9';
    $('#s-image-width').value = S.settings.image.width || 1280;
    $('#s-image-height').value = S.settings.image.height || 720;
    applyAspectToFields();

    $('#s-show-reasoning').checked = !!S.settings.showReasoning;
    $('#s-tools-enabled').checked = S.settings.toolsEnabled !== 'off';
    A.renderNoToolsHint();
    // R13 用户画像：默认全关，可按模式单独开或全开（'all' 与三个勾等价）
    const up = S.settings.userProfile || {};
    const enabled = up.enabled === 'all' ? { choice: true, chat: true, rp: true } : (up.enabled || {});
    $('#s-profile-choice').checked = !!enabled.choice;
    $('#s-profile-chat').checked = !!enabled.chat;
    $('#s-profile-rp').checked = !!enabled.rp;
    $('#s-profile-scope').value = up.scope === 'per-story' ? 'per-story' : 'global';
    renderProfilePanel();
    $('#s-style-preset').value = S.settings.stylePreset;
    $('#s-style-custom').value = S.settings.styleCustom;
    const sui = S.settings.ui || Store.defaultSettings().ui;
    if ($('#s-ui-layout')) $('#s-ui-layout').value = sui.layout === 'immersive' ? 'auto' : sui.layout;
    if ($('#s-ui-choices')) $('#s-ui-choices').value = sui.choices === 'always' ? 'always' : 'tray';
    if ($('#s-ui-motion')) $('#s-ui-motion').value = ['auto', 'off', 'standard', 'rich'].indexOf(sui.motion) >= 0 ? sui.motion : 'auto';
    // UI-3 §4.1 外观：字号 / 宽度 / 密度默认（扮演 / 智能体；本对话可覆盖）
    if ($('#s-ui-font')) $('#s-ui-font').value = ['sm', 'md', 'lg'].indexOf(sui.fontScale) >= 0 ? sui.fontScale : 'md';
    if ($('#s-ui-width')) $('#s-ui-width').value = ['narrow', 'standard', 'wide'].indexOf(sui.width) >= 0 ? sui.width : 'standard';
    if ($('#s-ui-density')) $('#s-ui-density').value = ['compact', 'standard'].indexOf(sui.density) >= 0 ? sui.density : 'standard';
    A.renderCapabilityFields();
    A.renderModelProfiles();   // UI-3：模型库列表（模型设置 · 模型库）
    renderStoryPanels();
    renderInjectHint();
    A.renderSavepoints();
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
    S.settings.sidecar = {
      port: Number(($('#s-sidecar-port') || {}).value) || 4319,
      token: (($('#s-sidecar-token') || {}).value || '').trim(),
    };
    if (IR.Sidecar) IR.Sidecar.configure(S.settings.sidecar);
    S.settings.chat.provider = 'openai-compatible';
    S.settings.chat.baseUrl = $('#s-chat-base').value.trim();
    S.settings.chat.model = $('#s-chat-model').value.trim();
    S.settings.chat.apiKey = $('#s-chat-key').value.trim();
    S.settings.chat.temperature = parseFloat($('#s-chat-temp').value);
    if (!Number.isFinite(S.settings.chat.temperature)) S.settings.chat.temperature = 0.9;
    if (!$('#wrap-chat-thinking').classList.contains('hidden')) {
      S.settings.chat.thinking = $('#s-chat-thinking').value || 'default';
    } else {
      S.settings.chat.thinking = 'default';
    }
    S.settings.chat.contextWindow = Math.max(0, parseInt($('#s-chat-ctx').value, 10) || 0);
    // 手填参数原样并入请求体（providers.js mergeExtraParams）
    S.settings.chat.extraParams = $('#s-chat-params').value.trim();

    S.settings.painter.baseUrl = $('#s-painter-base').value.trim();
    S.settings.painter.model = $('#s-painter-model').value.trim();
    S.settings.painter.apiKey = $('#s-painter-key').value.trim();

    S.settings.scribe.enabled = $('#s-scribe-enabled').checked;
    S.settings.scribe.every = Math.max(1, parseInt($('#s-scribe-every').value, 10) || 10);
    S.settings.scribe.aiTasks = $('#s-scribe-ai').checked;
    S.settings.scribe.baseUrl = $('#s-scribe-base').value.trim();
    S.settings.scribe.model = $('#s-scribe-model').value.trim();
    S.settings.scribe.apiKey = $('#s-scribe-key').value.trim();

    S.settings.draft.baseUrl = $('#s-draft-base').value.trim();
    S.settings.draft.model = $('#s-draft-model').value.trim();
    S.settings.draft.apiKey = $('#s-draft-key').value.trim();

    S.settings.image.provider = 'openai-images';
    S.settings.image.baseUrl = $('#s-image-base').value.trim();
    S.settings.image.model = $('#s-image-model').value.trim();
    S.settings.image.apiKey = $('#s-image-key').value.trim();
    S.settings.image.aspect = $('#s-image-aspect').value;
    S.settings.image.width = parseInt($('#s-image-width').value, 10) || 1280;
    S.settings.image.height = parseInt($('#s-image-height').value, 10) || 720;
    S.settings.image.extraParams = $('#s-image-params').value.trim();

    S.settings.video = S.settings.video || {};
    S.settings.video.provider = 'minimax-video';
    S.settings.video.baseUrl = $('#s-video-base').value.trim();
    S.settings.video.model = $('#s-video-model').value.trim();
    S.settings.video.apiKey = $('#s-video-key').value.trim();
    // 独立控件填常用项；「自定义请求参数」是高级覆盖（同名 key 以它为准，providers 后合并）
    S.settings.video.duration = Math.max(4, Math.min(15, parseInt($('#s-video-duration').value, 10) || 5));
    S.settings.video.resolution = $('#s-video-resolution').value || '768P';
    S.settings.video.ratio = $('#s-video-ratio').value || '16:9';
    S.settings.video.extraParams = $('#s-video-params').value.trim();
    if (!$('#wrap-image-size').classList.contains('hidden')) S.settings.image.size = $('#s-image-size').value;
    else delete S.settings.image.size;
    if (!$('#wrap-image-quality').classList.contains('hidden')) S.settings.image.quality = $('#s-image-quality').value;
    else delete S.settings.image.quality;

    // R13 用户画像：三个勾全开 = 'all'（等价写法，省得以后加模式还要改数据）
    const pChoice = $('#s-profile-choice').checked;
    const pChat = $('#s-profile-chat').checked;
    const pRp = $('#s-profile-rp').checked;
    S.settings.userProfile = {
      enabled: (pChoice && pChat && pRp) ? 'all' : { choice: pChoice, chat: pChat, rp: pRp },
      scope: $('#s-profile-scope').value === 'per-story' ? 'per-story' : 'global',
    };

    // 界面：布局 / 选项显示（P2；沉浸态不写回，保存后回到自动布局）
    if (!S.settings.ui) S.settings.ui = Store.defaultSettings().ui;
    if ($('#s-ui-layout')) {
      const lv = $('#s-ui-layout').value;
      S.settings.ui.layout = (lv === 'split' || lv === 'stack') ? lv : 'auto';
    }
    if ($('#s-ui-choices')) S.settings.ui.choices = $('#s-ui-choices').value === 'always' ? 'always' : 'tray';
    if ($('#s-ui-motion')) {
      const mv = $('#s-ui-motion').value;
      S.settings.ui.motion = ['auto', 'off', 'standard', 'rich'].indexOf(mv) >= 0 ? mv : 'auto';
      applyMotion();   // 动效强度即时生效
    }
    // UI-3 §4.1：字号 / 宽度 / 密度默认（非法值回默认）
    if ($('#s-ui-font')) {
      const fv = $('#s-ui-font').value;
      S.settings.ui.fontScale = ['sm', 'md', 'lg'].indexOf(fv) >= 0 ? fv : 'md';
    }
    if ($('#s-ui-width')) {
      const wv = $('#s-ui-width').value;
      S.settings.ui.width = ['narrow', 'standard', 'wide'].indexOf(wv) >= 0 ? wv : 'standard';
    }
    if ($('#s-ui-density')) {
      const dv = $('#s-ui-density').value;
      S.settings.ui.density = ['compact', 'standard'].indexOf(dv) >= 0 ? dv : 'standard';
    }

    const prevShowReasoning = S.settings.showReasoning;
    S.settings.showReasoning = $('#s-show-reasoning').checked;
    S.settings.toolsEnabled = $('#s-tools-enabled').checked ? 'on' : 'off';
    S.settings.stylePreset = $('#s-style-preset').value;
    S.settings.styleCustom = $('#s-style-custom').value.trim();
    // 「当前故事」组（推进模式 / 世界状态卡）也要跟着主「保存」落盘：
    // 否则只点底部「保存」时这两块的改动会被下次 renderStoryPanels 按旧值回填（看起来像「恢复默认」）。
    // 注意顺序：先读出模式（存世界卡会重绘表单、把下拉框刷回旧值），再写世界卡，最后换模式。
    if (S.story) {
      const sel = $('#s-story-mode');
      const m = sel ? sel.value : '';
      saveWorldFromForm({ silent: true, ifChanged: true });
      if (m && m !== (S.story.mode || 'choice')) onModeChange({ target: { value: m } });
    }
    saveAll();
    if (S.story) { A.applyLayout(); A.renderChat(); }   // 布局 / 选项显示即时生效
    if (prevShowReasoning !== S.settings.showReasoning) A.renderChat();   // 思考链开关即时生效
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
    video:   { kind: 'video', self: ['#s-video-base', '#s-video-key', '#s-video-model'] },
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
        provider: t.kind === 'image' ? 'openai-images' : (t.kind === 'video' ? 'minimax-video' : 'openai-compatible'),
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
      : t.kind === 'video'
        ? (IR.VideoProviders[cfg.provider] || IR.VideoProviders['minimax-video'])
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
    const has = !!S.story;
    const card = has ? S.story.styleCard : null;
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
    const rs = (has && S.story.rollingStyle) || {};
    const parts = [
      rs.style ? ('风格倾向：' + rs.style) : '',
      rs.scenes ? ('常见场景：' + rs.scenes) : '',
      rs.wardrobe ? ('服饰元素：' + rs.wardrobe) : '',
    ].filter(Boolean);
    $('#rolling-style-text').textContent = '滚动风格摘要（每次出图后自动更新）：'
      + (parts.length ? parts.join('；') : '（还没出过图）');
  }

  function renderStoryPanels() {
    const has = !!S.story;
    renderStylePanel();
    renderProfilePanel();
    renderCardPanel();
    // 推进模式只对「当前故事」有意义：没开故事时禁用并回默认，避免改了不生效、重开又像「恢复默认」
    const modeSel = $('#s-story-mode');
    if (modeSel) {
      modeSel.disabled = !has;
      modeSel.value = has ? (S.story.mode || 'choice') : 'choice';
    }
    $('#memory-empty').classList.toggle('hidden', has);
    $('#memory-panels').classList.toggle('hidden', !has);
    if (!has) return;
    const w = S.story.world || {};
    $('#w-place').value = w.place || '';
    $('#w-time').value = w.time || '';
    $('#w-scene').value = w.scene || '';
    $('#w-threads').value = (w.threads || []).join('\n');
    wCharEd().set(w.characters || []);   // 人物设定独立控件（可增删行）
    $('#w-rel-stage').value = (w.relationship || {}).stage || '';
    $('#w-rel-bonds').value = ((w.relationship || {}).bonds || []).join('\n');
    $('#w-rel-notes').value = (w.relationship || {}).notes || '';
    $('#world-scribe-at').textContent = w.scribeAt ? ('上次书记员校对：' + new Date(w.scribeAt).toLocaleTimeString()) : '尚未校对';
    const sl = $('#summary-list'); sl.innerHTML = '';
    (S.story.summaries || []).forEach(s => { const d = document.createElement('div'); d.className = 'mono-line'; d.textContent = s; sl.appendChild(d); });
    $('#sum-count').textContent = (S.story.summaries || []).length;
    const tl = $('#tool-list'); tl.innerHTML = '';
    S.story.log.filter(e => e.type === 'tool').slice(-40).forEach(e => {
      const d = document.createElement('div'); d.className = 'mono-line';
      d.textContent = '· ' + (e.tool || '') + '：' + (e.summary || '');
      tl.appendChild(d);
    });
  }

  // 角色卡状态（R13）：rp 常驻；切出 rp 时卡保留在存档里只是停用（§4.8）
  function renderCardPanel() {
    const el = $('#rc-status');
    if (!el) return;
    $('#btn-edit-card').disabled = !S.story;
    const card = S.story && S.story.characterCard;
    if (!card) {
      el.textContent = '还没有角色卡：切到「扮演」会先让你建一张 / 导入一张（SillyTavern V2/V3 PNG 也可）。';
      return;
    }
    el.textContent = '角色卡：' + (card.name || '（无名）') + '（' + IR.RoleCard.sourceLabel(card) + '）'
      + (S.story.mode === 'rp' ? ' · 扮演中：每轮常驻，开场白已进场' : ' · 已保留：切到扮演模式即启用');
  }

  // 人物设定独立控件（可增删行）：姓名 / 在场或离场 / 性格 / 说话方式 / 备注
  let wCharEdInst = null;
  function wCharEd() {
    return wCharEdInst || (wCharEdInst = A.charEditor($('#w-characters'), [
      { key: 'name', label: '名字', placeholder: '姓名' },
      { key: 'presence', label: '在场 / 离场', placeholder: '在场' },
      { key: 'personality', label: '性格', placeholder: '性格' },
      { key: 'speech', label: '说话方式', placeholder: '说话方式' },
      { key: 'note', label: '备注', placeholder: '手改后书记员不覆盖' },
    ], $('#btn-w-char-add')));
  }

  // 表单与当前世界卡是否不一致：modal「保存」用它决定要不要顺带落盘世界卡（没改就不写，避免误锁备注）
  function worldFormChanged(w) {
    w = w || {};
    const rel = w.relationship || {};
    const lines = v => String(v || '').split('\n').map(s => s.trim()).filter(Boolean);
    const rows = wCharEd().get().filter(p => p && p.name);
    const cur = (w.characters || []).filter(c => c && c.name);
    if ($('#w-place').value.trim() !== String(w.place || '')) return true;
    if ($('#w-time').value.trim() !== String(w.time || '')) return true;
    if ($('#w-scene').value.trim() !== String(w.scene || '')) return true;
    if (JSON.stringify(lines($('#w-threads').value)) !== JSON.stringify(w.threads || [])) return true;
    if ($('#w-rel-stage').value.trim() !== String(rel.stage || '')) return true;
    if (JSON.stringify(lines($('#w-rel-bonds').value)) !== JSON.stringify(rel.bonds || [])) return true;
    if ($('#w-rel-notes').value.trim() !== String(rel.notes || '')) return true;
    if (rows.length !== cur.length) return true;
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i], b = cur[i] || {};
      // 与 saveWorldFromForm 的写回语义一致：presence 空则沿用旧值，不算改动
      if (String(a.name) !== String(b.name || '')
        || String(a.presence || b.presence || '') !== String(b.presence || '')
        || String(a.personality || '') !== String(b.personality || '')
        || String(a.speech || '') !== String(b.speech || '')
        || String(a.note || '') !== String(b.note || '')) return true;
    }
    return false;
  }

  // opts：{ silent } 不弹提示（modal「保存」顺带落盘时用）；{ ifChanged } 仅当表单真的改过才写
  function saveWorldFromForm(opts) {
    if (!S.story) return;
    if (opts && opts.ifChanged && !worldFormChanged(S.story.world || {})) return;
    const w = S.story.world || (S.story.world = Store.defaultWorld());
    w.place = $('#w-place').value.trim();
    w.time = $('#w-time').value.trim();
    w.scene = $('#w-scene').value.trim();
    w.threads = $('#w-threads').value.split('\n').map(s => s.trim()).filter(Boolean);
    const prevByName = {};
    (w.characters || []).forEach(c => { if (c && c.name) prevByName[c.name] = c; });
    w.characters = wCharEd().get().map(p => {
      if (!p.name) return null;
      const prev = prevByName[p.name] || {};
      return Object.assign({}, prev, {
        name: p.name, presence: p.presence || prev.presence || '', personality: p.personality || '',
        speech: p.speech || '', note: p.note !== undefined ? p.note : '', noteLocked: true,
      });
    }).filter(Boolean);
    w.relationship = Object.assign({ stage: '', bonds: [], notes: '' }, w.relationship || {}, {
      stage: $('#w-rel-stage').value.trim(),
      bonds: $('#w-rel-bonds').value.split('\n').map(s => s.trim()).filter(Boolean),
      notes: $('#w-rel-notes').value.trim(),
    });
    w.updatedAt = Date.now();
    // 手改的派生数据要同步进 head 的内联状态，否则下次 project（刷新 / 切分支）会回滚这次编辑
    try { IR.Tree.resyncState(S.story); } catch (_) { /* 树还没建好时忽略 */ }
    saveAll();
    renderStoryPanels();
    if (!(opts && opts.silent)) toast('世界卡已保存，下一回合生效');
  }

  /* ---------- 🧠 注入记忆（§4.4 手动层；第十六轮定案：不用 tool_choice） ---------- */

  // 按钮在「模型设置 · 故事记忆」里：点一下排定下一回合强制注入完整世界卡 + 设定 + 视觉设定卡
  function toggleInjectMemory() {
    if (!S.story) { toast('先打开一个故事'); return; }
    S.pendingInject = !S.pendingInject;
    renderInjectHint();
    toast(S.pendingInject
      ? '已排定：下一回合带上完整记忆，并要求 AI 先复述处境再继续'
      : '已取消注入');
  }

  function renderInjectHint() {
    const el = $('#inject-state');
    const btn = $('#btn-inject-memory');
    if (!el || !btn) return;
    btn.disabled = !S.story;
    btn.textContent = S.pendingInject ? '取消注入' : '注入记忆';
    el.textContent = S.pendingInject
      ? '已排定：下一回合把完整世界卡 + 设定 + 视觉设定卡直接注入上下文，并要求先复述处境再继续。'
      : '手动层：点一下排定下一回合强制注入完整记忆（世界卡 + 设定 + 视觉设定卡），让 AI 先复述处境再继续。';
  }

  /* ---------- 用户画像面板（R13 / §4.12：面板在模型设置里，每条可删、可清空） ---------- */

  function profileStore() {
    const scope = (S.settings.userProfile || {}).scope === 'per-story' ? 'per-story' : 'global';
    if (scope === 'global') return { scope: scope, entries: Store.loadUserProfile() };
    return { scope: scope, entries: S.story ? (S.story.userProfile || []) : [] };
  }

  function writeProfile(entries) {
    const scope = (S.settings.userProfile || {}).scope === 'per-story' ? 'per-story' : 'global';
    if (scope === 'global') Store.saveUserProfile(entries);
    else if (S.story) { S.story.userProfile = entries; saveAll(); }
  }

  function renderProfilePanel() {
    const el = $('#profile-list');
    if (!el) return;
    const st = profileStore();
    const on = IR.Context.profileEnabledFor((S.settings.userProfile || {}).enabled, (S.story && S.story.mode) || 'choice');
    $('#profile-state').textContent = (st.scope === 'per-story' && !S.story)
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
    if (!S.story) return;
    const m = e.target.value;
    const prev = S.story.mode || 'choice';
    if (m === 'rp' && !S.story.characterCard) {
      // §4.8：切到 rp 时若没有角色卡 → 弹角色卡选择 / 新建；取消则留在原模式
      S.story.mode = m;
      $('#hud-mode').textContent = MODE_LABELS[m] || '剧情';
      saveAll();
      A.applyLayout();
      A.syncKindSwitch();
      A.renderChat();
      A.openCardEditor({
        mode: 'edit',
        onCancel: () => {
          S.story.mode = prev;
          $('#s-story-mode').value = prev;
          $('#hud-mode').textContent = MODE_LABELS[prev] || '剧情';
          saveAll();
          A.applyLayout();
          A.syncKindSwitch();
          A.renderChat();
        },
      });
      return;
    }
    S.story.mode = m;
    $('#hud-mode').textContent = MODE_LABELS[m] || '剧情';
    saveAll();
    A.applyLayout();      // 剧情 ↔ chat/rp 来回切：舞台与图都还在（只是不显示），布局要跟着模式走
    A.syncKindSwitch();   // chat 隐藏做 / 说 / 导演；story.ui.kind 保留不清
    A.renderChat();
    renderStoryPanels();
  }

  A.reg({ syncSettingsToForm, applyAspectToFields, applyFormToSettings, TEST_TARGETS, testConnection, renderStoryPanels, saveWorldFromForm, toggleInjectMemory, renderInjectHint, renderProfilePanel, clearProfile, onModeChange });
})();
