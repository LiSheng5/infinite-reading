/*
 * js/app/prefsui.js —— UI-3 设置分层的界面层
 *   ① 全局设置：分组导航（桌面左导航 / 窄屏列表下钻）+ 模型库管理；
 *   ② 本对话设置：右侧停靠面板（窄屏底部弹层），内容由 IR.Prefs.visibleFor(mode) 决定。
 * 只做界面与读写；分层规则的真源在 js/prefs.js（IR.Prefs）。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, Store, toast, irConfirm, saveAll, persistSettings, miniBtn, clone } = A;

  const P = () => IR.Prefs;

  /* ================= 全局设置：分组导航（§4.1） ================= */

  // fieldset → 分组：按 legend 归类（控件 id 不动，只是搬进分组面板）
  const GROUP_BY_LEGEND = [
    [/剧情对话模型|模型库/, 'g-models'],
    [/画师子代理/, 'g-subs'],
    [/书记员/, 'g-subs'],
    [/起草模型/, 'g-subs'],
    [/生图模型/, 'g-image'],
    [/生视频模型/, 'g-image'],
    [/画风/, 'g-image'],
    [/出图时机/, 'g-image'],
    [/生成过程/, 'g-tools'],
    [/本地服务/, 'g-tools'],
    [/邮件/, 'g-tools'],
    [/定时主动/, 'g-tools'],
    [/购物支付/, 'g-tools'],
    [/用户画像/, 'g-data'],
    [/本地存储/, 'g-data'],
    [/界面/, 'g-look'],
    [/推进模式/, 'g-story'],
    [/存档点/, 'g-story'],
    [/世界状态卡/, 'g-story'],
  ];
  const GROUP_TITLES = {
    'g-models': '模型库',
    'g-subs': '辅助模型',
    'g-image': '生图与画风',
    'g-tools': '工具与服务',
    'g-data': '数据',
    'g-look': '外观',
    'g-story': '当前故事',
  };

  function groupOfFs(fs) {
    const legend = fs.querySelector('legend');
    const text = legend ? legend.textContent : '';
    for (const [re, g] of GROUP_BY_LEGEND) if (re.test(text)) return g;
    return 'g-data';
  }

  function narrowSettings() {
    return typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(max-width: 720px)').matches
      : false;
  }

  // 把弹窗里的 fieldset / 危险行归进分组面板（幂等；只搬家，不改任何控件 id）
  function initSettingsNav() {
    const panels = $('#set-panels');
    const nav = $('#set-nav');
    if (!panels || !nav || panels.dataset.ready === '1') {
      syncSettingsNav();
      return;
    }
    panels.dataset.ready = '1';
    const byGroup = Object.create(null);
    const kids = Array.prototype.slice.call(panels.children);
    kids.forEach((el) => {
      if (el.id === 'set-back') return;
      let g = 'g-data';
      if (el.tagName === 'FIELDSET') g = groupOfFs(el);
      else if (el.classList && el.classList.contains('danger-row')) g = 'g-data';
      (byGroup[g] = byGroup[g] || []).push(el);
    });
    Object.keys(GROUP_TITLES).forEach((g) => {
      const sec = document.createElement('section');
      sec.className = 'set-panel';
      sec.dataset.group = g;
      const h = document.createElement('h3');
      h.className = 'set-panel-title';
      h.textContent = GROUP_TITLES[g];
      sec.appendChild(h);
      (byGroup[g] || []).forEach(el => sec.appendChild(el));
      panels.appendChild(sec);
    });
    nav.querySelectorAll('.set-nav-item').forEach(btn => {
      btn.onclick = () => openSettingsGroup(btn.dataset.group);
    });
    const back = $('#set-back');
    if (back) back.onclick = () => {
      $('#set-shell').classList.remove('detail');
      syncSettingsNav();
    };
    openSettingsGroup('g-models');
  }

  // 显示某分组；窄屏进「详情」态（列表 → 下钻），桌面始终左导航 + 右内容
  function openSettingsGroup(group) {
    const shell = $('#set-shell');
    if (!shell) return;
    const g = GROUP_TITLES[group] ? group : 'g-models';
    document.querySelectorAll('#set-panels .set-panel').forEach(sec => {
      sec.classList.toggle('hidden', sec.dataset.group !== g);
    });
    document.querySelectorAll('#set-nav .set-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.group === g);
    });
    const back = $('#set-back');
    if (narrowSettings()) {
      shell.classList.add('detail');
      if (back) back.classList.remove('hidden');
    } else {
      shell.classList.remove('detail');
      if (back) back.classList.add('hidden');
    }
    const panels = $('#set-panels');
    if (panels) panels.scrollTop = 0;
    return g;
  }

  // 打开设置 / 切窗口尺寸后的导航态同步
  function syncSettingsNav() {
    const shell = $('#set-shell');
    if (!shell) return;
    const active = document.querySelector('#set-nav .set-nav-item.active');
    const back = $('#set-back');
    if (narrowSettings()) {
      if (!shell.classList.contains('detail')) {
        // 列表态：分组面板全藏，导航可见
        document.querySelectorAll('#set-panels .set-panel').forEach(sec => sec.classList.add('hidden'));
      }
      if (back && shell.classList.contains('detail')) back.classList.remove('hidden');
    } else {
      shell.classList.remove('detail');
      if (back) back.classList.add('hidden');
      if (active) openSettingsGroup(active.dataset.group);
      else openSettingsGroup('g-models');
    }
  }

  /* ================= 模型库管理（§3.1） ================= */

  let mpEditingId = null;      // null = 新增；'copy:xxx' = 复制；其余 = 编辑
  let mpCopySource = null;

  function profileById(id) {
    return (S.settings.profiles || []).find(p => p && p.id === id) || null;
  }

  function usageOfProfile(id) {
    const used = [];
    try {
      Store.listIndex().forEach(it => {
        const st = Store.loadStory(it.id);
        if (st && st.prefs && st.prefs.profileId === id) used.push(st.title || it.title || it.id);
      });
    } catch (_) { /* 索引读不到就不计数，确认文案仍然给出 */ }
    return used;
  }

  function renderModelProfiles() {
    const box = $('#mp-list');
    if (!box) return;
    box.innerHTML = '';
    const list = S.settings.profiles || [];
    const st = $('#mp-state');
    if (st) st.textContent = list.length
      ? ('共 ' + list.length + ' 个模型 · 默认主模型在上面那块（每个对话可选自己的）')
      : '还没有别的模型：点「新增模型」加一个，就能在对话里单独选。';
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'mono-line';
      d.textContent = '（空）每个对话都用默认主模型';
      box.appendChild(d);
    }
    list.forEach(p => {
      const row = document.createElement('div');
      row.className = 'mono-row';
      const text = document.createElement('span');
      text.className = 'mono-line';
      text.textContent = (p.name || '（未命名）') + ' · ' + (p.model || '（未填模型）')
        + (p.apiKey ? ' · 已设置 Key' : ' · 无 Key（沿用默认）');
      row.appendChild(text);
      const used = usageOfProfile(p.id);
      if (used.length) {
        const tag = document.createElement('span');
        tag.className = 'hint';
        tag.textContent = '（' + used.length + ' 个对话在用）';
        row.appendChild(tag);
      }
      row.appendChild(miniBtn('编辑', () => openProfileEditor(p.id)));
      row.appendChild(miniBtn('复制', () => openProfileEditor('copy:' + p.id)));
      row.appendChild(miniBtn('删除', () => deleteProfile(p.id), 'danger'));
      box.appendChild(row);
    });
    renderStoryPrefs();
  }

  function openProfileEditor(id) {
    const wrapCopy = $('#mp-copy-key-wrap');
    const keyInput = $('#mp-key');
    const keyState = $('#mp-key-state');
    mpCopySource = null;
    if (id && id.indexOf('copy:') === 0) {
      const src = profileById(id.slice(5));
      if (!src) return;
      mpEditingId = 'copy:' + src.id;
      mpCopySource = clone(src);
      $('#mp-title').textContent = '复制「' + (src.name || src.model || src.id) + '」为新模型';
      $('#mp-name').value = (src.name || src.model || '模型') + ' 副本';
      $('#mp-base').value = src.baseUrl || '';
      $('#mp-model').value = src.model || '';
      $('#mp-temp').value = src.temperature != null ? src.temperature : '';
      $('#mp-ctx').value = src.contextWindow || '';
      $('#mp-thinking').value = src.thinking || 'default';
      $('#mp-params').value = typeof src.extraParams === 'string' ? src.extraParams : '';
      if (wrapCopy) wrapCopy.classList.remove('hidden');
      if (keyInput) { keyInput.value = ''; keyInput.placeholder = '留空 = 不带 Key（沿用默认主模型的 Key）'; }
      if (keyState) keyState.textContent = src.apiKey
        ? '源模型已设置 API Key：勾选上面的「带上 API Key」才会复制（Key 不回显）。'
        : '源模型没有单独的 Key。';
    } else if (id) {
      const p = profileById(id);
      if (!p) return;
      mpEditingId = p.id;
      $('#mp-title').textContent = '编辑「' + (p.name || p.model || p.id) + '」';
      $('#mp-name').value = p.name || '';
      $('#mp-base').value = p.baseUrl || '';
      $('#mp-model').value = p.model || '';
      $('#mp-temp').value = p.temperature != null ? p.temperature : '';
      $('#mp-ctx').value = p.contextWindow || '';
      $('#mp-thinking').value = p.thinking || 'default';
      $('#mp-params').value = typeof p.extraParams === 'string' ? p.extraParams : '';
      if (wrapCopy) wrapCopy.classList.add('hidden');
      if (keyInput) { keyInput.value = ''; keyInput.placeholder = p.apiKey ? '已设置（留空表示不改动）' : '还没有 Key（留空 = 沿用默认主模型）'; }
      if (keyState) keyState.textContent = p.apiKey
        ? '这个模型已设置 API Key（安全起见不回显）；要换新的就填，留空保持不变。'
        : '这个模型还没有单独的 Key，用默认主模型的 Key。';
    } else {
      mpEditingId = null;
      $('#mp-title').textContent = '新增模型（字段与「剧情对话模型」一致；留空项沿用默认主模型）';
      ['#mp-name', '#mp-base', '#mp-model', '#mp-temp', '#mp-ctx', '#mp-params'].forEach(s => { $(s).value = ''; });
      $('#mp-thinking').value = 'default';
      if (wrapCopy) wrapCopy.classList.add('hidden');
      if (keyInput) { keyInput.value = ''; keyInput.placeholder = 'sk-…（留空 = 沿用默认主模型的 Key）'; }
      if (keyState) keyState.textContent = 'API Key 只保存在本地；对话存档 / 导出不会带上它。';
    }
    $('#mp-editor').classList.remove('hidden');
    if ($('#mp-name')) $('#mp-name').focus();
  }

  function cancelProfileEditor() {
    mpEditingId = null;
    mpCopySource = null;
    const ed = $('#mp-editor');
    if (ed) ed.classList.add('hidden');
  }

  function saveProfileFromEditor() {
    const name = $('#mp-name').value.trim();
    const model = $('#mp-model').value.trim();
    if (!name && !model) { toast('至少填一个名称或模型名', true); return; }
    const keyVal = $('#mp-key').value.trim();
    const base = {
      name: name,
      provider: 'openai-compatible',
      baseUrl: $('#mp-base').value.trim(),
      model: model,
      temperature: parseFloat($('#mp-temp').value),
      thinking: $('#mp-thinking').value.trim() || 'default',
      contextWindow: Math.max(0, parseInt($('#mp-ctx').value, 10) || 0),
      extraParams: $('#mp-params').value.trim(),
    };
    if (!Number.isFinite(base.temperature)) base.temperature = 0.9;
    const list = (S.settings.profiles = S.settings.profiles || []);
    if (mpEditingId && mpEditingId.indexOf('copy:') === 0) {
      const copyKey = $('#mp-copy-key') && $('#mp-copy-key').checked && mpCopySource;
      list.push(Object.assign({}, base, {
        id: Store.genId(),
        apiKey: copyKey ? (mpCopySource.apiKey || '') : (keyVal || ''),
      }));
      toast('已复制为新模型' + (copyKey ? '（含 API Key）' : '（未带 API Key）'));
    } else if (mpEditingId) {
      const p = profileById(mpEditingId);
      if (!p) { cancelProfileEditor(); return; }
      Object.assign(p, base);
      if (keyVal) p.apiKey = keyVal;      // 留空 = 不改动已保存的 Key
      toast('模型已更新');
    } else {
      list.push(Object.assign({}, base, { id: Store.genId(), apiKey: keyVal || '' }));
      toast('已加入模型库');
    }
    persistSettings();
    cancelProfileEditor();
    renderModelProfiles();
    A.syncSettingsToForm();
  }

  async function deleteProfile(id) {
    const p = profileById(id);
    if (!p) return;
    const used = usageOfProfile(id);
    const msg = used.length
      ? '删除「' + (p.name || p.model || id) + '」？这些对话会回退到默认模型：' + used.join('、')
      : '删除「' + (p.name || p.model || id) + '」？目前没有对话在用它。';
    if (!await irConfirm(msg, { title: '删除模型', okText: '删除' })) return;
    S.settings.profiles = (S.settings.profiles || []).filter(x => !x || x.id !== id);
    // 用它的对话：清掉引用（下次请求自动走默认主模型）
    try {
      Store.listIndex().forEach(it => {
        const st = Store.loadStory(it.id);
        if (st && st.prefs && st.prefs.profileId === id) {
          delete st.prefs.profileId;
          delete st.prefs.profileLabel;
          Store.saveStory(st);
        }
      });
    } catch (_) { /* 清引用失败不影响删除本身（resolveChatCfg 也会兜底回退） */ }
    persistSettings();
    renderModelProfiles();
    toast(used.length ? '已删除：' + used.length + ' 个对话回到默认模型' : '已删除');
  }

  /* ================= 本对话设置面板（§4.2） ================= */

  function ensurePrefs() {
    if (!S.story) return null;
    if (!S.story.prefs || typeof S.story.prefs !== 'object') S.story.prefs = {};
    return S.story.prefs;
  }

  function prefHas(path) {
    const p = (S.story && S.story.prefs) || {};
    const seg = path.split('.');
    let cur = p;
    for (let i = 0; i < seg.length - 1; i++) {
      if (!cur || typeof cur !== 'object') return false;
      cur = cur[seg[i]];
    }
    return !!cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, seg[seg.length - 1]);
  }

  function setPref(path, value) {
    const prefs = ensurePrefs();
    if (!prefs) return;
    const seg = path.split('.');
    let cur = prefs;
    for (let i = 0; i < seg.length - 1; i++) {
      if (!cur[seg[i]] || typeof cur[seg[i]] !== 'object') cur[seg[i]] = {};
      cur = cur[seg[i]];
    }
    cur[seg[seg.length - 1]] = value;
  }

  function delPref(path) {
    const prefs = (S.story && S.story.prefs) || {};
    const seg = path.split('.');
    let cur = prefs;
    for (let i = 0; i < seg.length - 1; i++) {
      if (!cur || typeof cur[seg[i]] !== 'object') return;
      cur = cur[seg[i]];
    }
    delete cur[seg[seg.length - 1]];
  }

  // 一行「可覆盖控件」：标签 + 控件 + 跟随状态 + 重置
  function prefRow(path, labelText, controlBuilder, hint) {
    const row = document.createElement('div');
    row.className = 'prefs-row';
    const head = document.createElement('div');
    head.className = 'prefs-row-head';
    const label = document.createElement('span');
    label.className = 'prefs-label';
    label.textContent = labelText;
    head.appendChild(label);
    const badge = document.createElement('span');
    const over = prefHas(path);
    badge.className = 'prefs-badge' + (over ? ' over' : '');
    badge.textContent = over ? '本对话覆盖' : '跟随全局 ✓';
    head.appendChild(badge);
    if (over) {
      head.appendChild(miniBtn('重置', () => {
        delPref(path);
        if (path === 'profileId') delPref('profileLabel');
        saveAll();
        renderStoryPrefs();
        applyPrefsSideEffects(path);
      }));
    }
    row.appendChild(head);
    row.appendChild(controlBuilder(row));
    if (hint) {
      const h = document.createElement('p');
      h.className = 'hint';
      h.textContent = hint;
      row.appendChild(h);
    }
    return row;
  }

  function sel(options, value, onChange, id) {
    const s = document.createElement('select');
    if (id) s.id = id;
    options.forEach(([v, text]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = text;
      s.appendChild(o);
    });
    s.value = value;
    s.onchange = () => onChange(s.value);
    return s;
  }

  function chk(text, checked, onChange, id) {
    const wrap = document.createElement('label');
    wrap.className = 'check';
    const c = document.createElement('input');
    if (id) c.id = id;
    c.type = 'checkbox';
    c.checked = !!checked;
    c.onchange = () => onChange(c.checked);
    wrap.appendChild(c);
    wrap.appendChild(document.createTextNode(' ' + text));
    return wrap;
  }

  // 写完 prefs 后的即时生效：布局 / 渲染 / 提示
  function applyPrefsSideEffects(path) {
    if (!path || path.indexOf('ui') === 0) A.applyLayout();
    if (!path || path === 'choices' || path === 'showReasoning') A.renderChat();
  }

  function modelRow() {
    return prefRow('profileId', '模型', (row) => {
      const wrap = document.createElement('div');
      const def = (S.settings.chat && S.settings.chat.model) || '（还没填模型）';
      const opts = [['', '跟随默认（' + def + '）']];
      (S.settings.profiles || []).forEach(p => {
        opts.push([p.id, (p.name || '（未命名）') + ' · ' + (p.model || p.id)]);
      });
      const pid = P().effective(S.settings, S.story, 'profileId');
      const rawPid = (S.story.prefs && S.story.prefs.profileId) || '';
      const info = P().effectiveInfo(S.settings, S.story, 'profileId');
      let cur = rawPid && !info.missing ? rawPid : '';
      if (rawPid && info.missing) {
        opts.push([rawPid, '（原对话使用的模型已不存在）']);
        cur = rawPid;
      }
      wrap.appendChild(sel(opts, cur, (v) => {
        if (v) {
          setPref('profileId', v);
          setPref('profileLabel', P().profileLabel(S.settings, v));
        } else {
          delPref('profileId');
          delPref('profileLabel');
        }
        saveAll();
        renderStoryPrefs();
        toast('已切换模型：从下一条消息起生效');
      }, 'p-model'));
      if (info.missing) {
        const warn = document.createElement('p');
        warn.className = 'hint warn';
        const label = (S.story.prefs && S.story.prefs.profileLabel) || '原对话使用的模型';
        warn.textContent = '原对话使用的模型「' + label + '」在本机不存在，已使用默认模型。';
        wrap.appendChild(warn);
      }
      const note = document.createElement('p');
      note.className = 'hint';
      const resolved = P().resolveChatCfg(S.settings, S.story);
      note.textContent = '当前生效：' + (resolved.cfg.model || '（还没填模型）') + '（从下一条消息起生效）';
      wrap.appendChild(note);
      return wrap;
    }, '对话存档里只记模型引用名，不含 API Key 与接口地址（导出 / 分享安全）。');
  }

  function choicesRow() {
    return prefRow('choices', '选项显示', () => sel([
      ['tray', '收在「💡 灵感」里'],
      ['always', '始终内联在旁白下'],
    ], P().effective(S.settings, S.story, 'choices'), (v) => {
      setPref('choices', v); saveAll(); renderStoryPrefs(); A.renderChat();
    }, 'p-choices'), '');
  }

  function showReasoningRow() {
    return prefRow('showReasoning', '显示思考过程', () => chk(
      '展示深度思考链（模型返回 reasoning_content 时）',
      P().effective(S.settings, S.story, 'showReasoning'),
      (v) => { setPref('showReasoning', v); saveAll(); renderStoryPrefs(); A.renderChat(); },
      'p-show-reasoning',
    ), '');
  }

  function styleRow() {
    const row = document.createElement('div');
    row.className = 'prefs-row';
    const label = document.createElement('div');
    label.className = 'prefs-label';
    label.textContent = '画风';
    row.appendChild(label);
    const card = S.story && S.story.styleCard;
    const h = document.createElement('p');
    h.className = 'hint';
    h.textContent = card
      ? ('视觉设定卡 v' + (card.version || 1) + ' 已锚定，每张画都带着它。')
      : '未锚定：画师按画风预设兜底。';
    row.appendChild(h);
    const btn = miniBtn('打开画风设置', () => {
      closeStoryPrefs();
      A.openSettings();
      openSettingsGroup('g-image');
    });
    btn.id = 'p-style-open';
    row.appendChild(btn);
    return row;
  }

  function modeRow() {
    const row = document.createElement('div');
    row.className = 'prefs-row';
    const label = document.createElement('div');
    label.className = 'prefs-label';
    label.textContent = '推进模式（本对话）';
    row.appendChild(label);
    row.appendChild(sel([
      ['choice', '剧情（结尾给选项）'],
      ['chat', '智能体（带工具的助手）'],
      ['rp', '角色扮演（角色卡）'],
    ], (S.story && S.story.mode) || 'choice', (v) => {
      A.onModeChange({ target: { value: v } });
      renderStoryPrefs();
    }, 'p-mode'));
    const h = document.createElement('p');
    h.className = 'hint';
    h.textContent = '切换只改提示词与渲染，不影响记忆 / 重试 / 作画。';
    row.appendChild(h);
    return row;
  }

  function toolsRows() {
    const box = document.createElement('div');
    box.className = 'prefs-row';
    const head = document.createElement('div');
    head.className = 'prefs-row-head';
    const label = document.createElement('span');
    label.className = 'prefs-label';
    label.textContent = '工具开关';
    head.appendChild(label);
    const over = prefHas('tools');
    const badge = document.createElement('span');
    badge.className = 'prefs-badge' + (over ? ' over' : '');
    badge.textContent = over ? '本对话覆盖' : '跟随全局 ✓';
    head.appendChild(badge);
    if (over) {
      head.appendChild(miniBtn('重置', () => {
        delPref('tools');
        saveAll();
        renderStoryPrefs();
      }));
    }
    box.appendChild(head);
    const tools = P().effective(S.settings, S.story, 'tools');
    const avail = {
      image: true,
      memory: true,
      schedule: !!A.scheduleToolsAvailable(),
      email: !!(A.proposalToolsAvailable && A.proposalToolsAvailable().email),
      payment: !!(A.proposalToolsAvailable && A.proposalToolsAvailable().payment),
    };
    const LABELS = { image: '生图', memory: '记忆', schedule: '定时', email: '邮件', payment: '下单' };
    P().TOOL_KEYS.forEach(k => {
      if (!avail[k]) return;   // 只显示全局可用的
      box.appendChild(chk(LABELS[k] + (tools[k] ? '' : '（本对话已关）'), tools[k], (v) => {
        setPref('tools.' + k, v);
        saveAll();
        renderStoryPrefs();
      }, 'p-tool-' + k));
    });
    const h = document.createElement('p');
    h.className = 'hint';
    h.textContent = '关掉的工具不再下发给模型；其它对话不受影响。';
    box.appendChild(h);
    return box;
  }

  function scheduleRow() {
    return prefRow('tools.schedule', '定时主动', () => chk(
      '允许模型主动安排定时联系（仍需在「全局设置 · 定时」里确认每条安排）',
      P().effective(S.settings, S.story, 'tools').schedule,
      (v) => { setPref('tools.schedule', v); saveAll(); renderStoryPrefs(); },
      'p-schedule',
    ), '');
  }

  function characterCardRow() {
    const row = document.createElement('div');
    row.className = 'prefs-row';
    const label = document.createElement('div');
    label.className = 'prefs-label';
    label.textContent = '角色卡';
    row.appendChild(label);
    const card = S.story && S.story.characterCard;
    const h = document.createElement('p');
    h.className = 'hint';
    h.textContent = card ? ('角色卡：' + (card.name || '（无名）')) : '还没有角色卡。';
    row.appendChild(h);
    const btn = miniBtn('编辑角色卡 / 导入 PNG', () => {
      if (!S.story) return;
      closeStoryPrefs();
      A.openCardEditor({ mode: 'edit' });
    });
    btn.id = 'p-card-open';
    row.appendChild(btn);
    return row;
  }

  function layoutChoiceRow() {
    const box = document.createElement('div');
    box.className = 'prefs-row';
    box.appendChild(prefRow('ui.layout', '页面布局', () => sel([
      ['auto', '自动（宽屏双栏 / 窄屏堆叠）'],
      ['split', '双栏（左文右图）'],
      ['stack', '堆叠（图在上、文在下）'],
      ['immersive', '沉浸（画面铺满）'],
    ], P().effective(S.settings, S.story, 'ui').layout, (v) => {
      setPref('ui.layout', v); saveAll(); renderStoryPrefs(); A.applyLayout();
    }, 'p-layout'), ''));
    box.appendChild(prefRow('ui.splitRatio', '双栏比例', () => {
      const s = document.createElement('input');
      s.id = 'p-split';
      s.type = 'range';
      s.min = '0.28'; s.max = '0.72'; s.step = '0.02';
      s.value = String(P().effective(S.settings, S.story, 'ui').splitRatio || 0.5);
      s.oninput = () => {
        setPref('ui.splitRatio', Math.max(0.28, Math.min(0.72, +s.value)));
        A.applyLayout();
      };
      s.onchange = () => { saveAll(); renderStoryPrefs(); };
      return s;
    }, '双击分隔条恢复 1:1。'));
    box.appendChild(prefRow('ui.imageCollapsed', '舞台', () => chk(
      '收起画面（聊天占满）',
      P().effective(S.settings, S.story, 'ui').imageCollapsed,
      (v) => { setPref('ui.imageCollapsed', v); saveAll(); renderStoryPrefs(); A.applyLayout(); },
      'p-image-collapsed',
    ), ''));
    return box;
  }

  function layoutChatRow() {
    const box = document.createElement('div');
    box.className = 'prefs-row';
    const ui = P().effective(S.settings, S.story, 'ui');
    box.appendChild(prefRow('ui.fontScale', '字号', () => sel([
      ['sm', '小'], ['md', '中'], ['lg', '大'],
    ], ui.fontScale, (v) => { setPref('ui.fontScale', v); saveAll(); renderStoryPrefs(); A.applyLayout(); }, 'p-font'), ''));
    box.appendChild(prefRow('ui.width', '内容宽度', () => sel([
      ['narrow', '窄'], ['standard', '标准'], ['wide', '宽'],
    ], ui.width, (v) => { setPref('ui.width', v); saveAll(); renderStoryPrefs(); A.applyLayout(); }, 'p-width'), ''));
    box.appendChild(prefRow('ui.density', '密度', () => sel([
      ['compact', '紧凑'], ['standard', '标准'],
    ], ui.density, (v) => { setPref('ui.density', v); saveAll(); renderStoryPrefs(); A.applyLayout(); }, 'p-density'), ''));
    return box;
  }

  // 整体重绘（切换对话 / 改模式 / 改覆盖都要整画，别残留上一个对话的值）
  function renderStoryPrefs() {
    const body = $('#prefs-body');
    if (!body) return;
    body.innerHTML = '';
    if (!S.story) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = '先打开一个对话。';
      body.appendChild(p);
      return;
    }
    const mode = S.story.mode || 'choice';
    const visible = P().visibleFor(mode);
    const modeLabel = { choice: '剧情', chat: '智能体', rp: '扮演' }[mode] || '剧情';
    const head = document.createElement('p');
    head.className = 'hint';
    head.textContent = '当前对话：' + modeLabel + '模式 · 《' + (S.story.title || '未命名') + '》';
    body.appendChild(head);

    if (visible.has('model')) body.appendChild(modelRow());
    if (visible.has('style')) body.appendChild(styleRow());
    if (visible.has('mode')) body.appendChild(modeRow());
    if (visible.has('choices')) body.appendChild(choicesRow());
    if (visible.has('showReasoning')) body.appendChild(showReasoningRow());
    if (visible.has('tools')) body.appendChild(toolsRows());
    if (visible.has('schedule')) body.appendChild(scheduleRow());
    if (visible.has('characterCard')) body.appendChild(characterCardRow());
    if (visible.has('layout')) {
      body.appendChild((mode === 'choice') ? layoutChoiceRow() : layoutChatRow());
    }
  }

  function openStoryPrefs() {
    if (!S.story) { toast('先打开一个对话'); return; }
    renderStoryPrefs();
    const panel = $('#story-prefs');
    if (panel) panel.classList.remove('hidden');
    const game = $('#screen-game');
    if (game) game.classList.add('prefs-open');   // 桌面停靠：让出右侧宽度，不遮挡输入区
  }

  function closeStoryPrefs() {
    const panel = $('#story-prefs');
    if (panel) panel.classList.add('hidden');
    const game = $('#screen-game');
    if (game) game.classList.remove('prefs-open');
  }

  function bindPrefsUI() {
    const close = $('#prefs-close');
    if (close) close.onclick = closeStoryPrefs;
    const add = $('#mp-add');
    if (add) add.onclick = () => openProfileEditor(null);
    const save = $('#mp-save');
    if (save) save.onclick = saveProfileFromEditor;
    const cancel = $('#mp-cancel');
    if (cancel) cancel.onclick = cancelProfileEditor;
    const storyBtn = $('#btn-story-prefs');
    if (storyBtn) storyBtn.onclick = () => { A.closeMenus(); openStoryPrefs(); };
    if (window.matchMedia) {
      const mq = window.matchMedia('(max-width: 720px)');
      const onChange = () => syncSettingsNav();
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  A.reg({
    initSettingsNav, openSettingsGroup, syncSettingsNav,
    renderModelProfiles, openProfileEditor, cancelProfileEditor, saveProfileFromEditor, deleteProfile,
    renderStoryPrefs, openStoryPrefs, closeStoryPrefs,
    bindPrefsUI,
  });
})();
