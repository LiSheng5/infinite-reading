/*
 * js/app/shelf.js —— 书架页（UI-2）：会话列表 + 搜索 + 自动标题 + 新建弹层
 *
 * - renderShelf：只读索引（不再对每个故事 loadStory），按 updatedAt 分组吸顶列表
 * - 「⋯」菜单：重命名 / 重新生成标题 / 导出 / 删除
 * - 自动标题：回合 seal 后异步触发（IR.Titles + resolveSub('scribe')），打字机式替换
 * - 搜索：首次聚焦惰性构建索引（分批让出主线程）；命中片段 createElement('mark') 高亮
 * - 键盘：/ 或 Ctrl/Cmd+K 聚焦搜索；↑↓ 选结果、Enter 打开、Esc 清空；行 Tab/Enter/Shift+F10
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, Store, MODE_LABELS, toast, irConfirm, openModal, fmtTime, motionLevel, saveAll, resolveSub } = A;

  /* ================= 小工具 ================= */

  const MODE_ICONS = { choice: 'book', chat: 'chat', rp: 'mask' };   // sprite 里的图标名
  const GROUP_LABELS = [
    { key: 'today', label: '今天' },
    { key: 'yesterday', label: '昨天' },
    { key: 'week', label: '过去 7 天' },
    { key: 'older', label: '更早' },
  ];
  const DAY = 86400000;
  const EARLIER_CAP = 100;      // 「更早」分组默认最多渲染 100 条（约 300 条以上时）
  const ROW_STAGGER_MAX = 600;  // 行错峰淡入总时长封顶（ms）
  const ROW_STAGGER_STEP = 45;

  let expandEarlier = false;    // 「展开更多」是否已点开
  let currentQuery = '';

  function escAttr(s) {
    return String(s == null ? '' : s).replace(/([\\"])/g, '\\$1');
  }

  function relTime(ts) {
    if (!ts) return '';
    // 时钟回拨 / 未来时间戳会给出负差值（显示「-3 分钟前」）：负值与非法值一律归「刚刚」（审查 低危 #20）
    let diff = Date.now() - ts;
    if (!Number.isFinite(diff) || diff < 0) diff = 0;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    const d = new Date(ts), now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= startOfToday) return Math.floor(diff / 3600000) + ' 小时前';
    if (ts >= startOfToday - DAY) return '昨天';
    if (ts >= startOfToday - 7 * DAY) return Math.floor((startOfToday - ts) / DAY) + ' 天前';
    return fmtTime(ts);
  }

  function groupKeyOf(ts) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= startOfToday) return 'today';
    if (ts >= startOfToday - DAY) return 'yesterday';
    if (ts >= startOfToday - 7 * DAY) return 'week';
    return 'older';
  }

  // 阶段 5 第 3 步：屏幕显隐的判定收口到 IR.Nav（本文件不再直接读 .hidden）
  function shelfVisible() {
    return IR.Nav.screenVisible('shelf');
  }

  function titleElOf(storyId) {
    return document.querySelector('.shelf-row[data-story-id="' + escAttr(storyId) + '"] .shelf-row-title');
  }

  /* ================= 列表渲染（只读索引，§3.1） ================= */

  function renderShelf() {
    const list = $('#shelf-list');
    if (!list) return;
    // 旧索引条目一次性补齐（幂等；§3.1 迁移）
    try { Store.ensureIndexComplete(); } catch (_) { /* 迁移失败不拦渲染 */ }
    // 阶段 4 屏 3：书架已换 Svelte 实现（src/screens/shelf，容器打 data-impl="svelte"）时，
    // #shelf-list 的行 DOM 由组件管——这里只推视图模型（分组 / 行错峰 / 「更早」截断），不再拼 DOM；
    // 旧拼装路径原样留给 ?ui=legacy 逃生口（阶段 6 随 legacy 入口一起删）。
    if (IR.ShelfScreen) {
      const index = Store.listStories();
      $('#shelf-empty').classList.toggle('hidden', index.length > 0);
      if (currentQuery) { runSearch(); return; }
      IR.ShelfScreen.render(shelfModel(index));
      return;
    }
    list.innerHTML = '';
    const index = Store.listStories();   // 已按 updatedAt 新 → 旧
    $('#shelf-empty').classList.toggle('hidden', index.length > 0);
    if (currentQuery) { runSearch(); return; }

    const currentId = Store.getCurrentId();
    const showAllEarlier = expandEarlier;
    const grouped = { today: [], yesterday: [], week: [], older: [] };
    for (const it of index) grouped[groupKeyOf(it.updatedAt || 0)].push(it);

    let rowIndex = 0;
    for (const g of GROUP_LABELS) {
      let items = grouped[g.key];
      if (!items.length) continue;
      const capped = (g.key === 'older' && index.length > 300 && !showAllEarlier && items.length > EARLIER_CAP);
      const shown = capped ? items.slice(0, EARLIER_CAP) : items;

      const head = document.createElement('div');
      head.className = 'shelf-group-head';
      head.textContent = g.label + ' · ' + items.length;
      list.appendChild(head);

      for (const it of shown) {
        list.appendChild(rowOf(it, currentId, rowIndex));
        rowIndex += 1;
      }
      if (capped) {
        const more = document.createElement('button');
        more.className = 'btn ghost shelf-more';
        more.textContent = '展开更多（还有 ' + (items.length - EARLIER_CAP) + ' 条）';
        more.onclick = showAllEarlier;
        list.appendChild(more);
      }
    }
  }

  function rowOf(it, currentId, rowIndex) {
    const row = document.createElement('div');
    row.className = 'shelf-row';
    row.id = 'shelf-row-' + it.id;
    row.dataset.storyId = it.id;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', it.id === currentId ? 'true' : 'false');
    row.tabIndex = 0;
    if (it.id === currentId) row.classList.add('current');
    if (rowIndex < 14) {
      row.classList.add('row-in');
      row.style.animationDelay = Math.min(rowIndex * ROW_STAGGER_STEP, ROW_STAGGER_MAX) + 'ms';
    }

    const thumb = document.createElement('div');
    // 导入档案的 thumb 不可信（审查 中危 #12）：白名单只放行 data:/blob:，并用 JSON.stringify
    // 转义进 url()——引号破不出 CSS 值，与 models.js setStageArt 的转义口径一致
    const thumbSrc = Store.safeThumb(it.thumb);
    thumb.className = 'shelf-row-thumb' + (thumbSrc ? '' : ' empty');
    if (thumbSrc) thumb.style.backgroundImage = 'url(' + JSON.stringify(thumbSrc) + ')';
    else thumb.innerHTML = A.icon(MODE_ICONS[it.mode] || MODE_ICONS.choice);
    row.appendChild(thumb);

    const body = document.createElement('div');
    body.className = 'shelf-row-body';
    const title = document.createElement('div');
    title.className = 'shelf-row-title';
    // 空标题只显示兜底文案，绝不回写存档（§6）
    title.textContent = it.title || '未命名故事';
    body.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'shelf-row-meta';
    meta.textContent = '[' + (MODE_LABELS[it.mode] || '剧情') + '] · 第 ' + (it.turn || 0) + ' 回合 · ' + relTime(it.updatedAt);
    body.appendChild(meta);
    const snip = document.createElement('div');
    snip.className = 'shelf-row-snippet';
    snip.textContent = it.snippet || '';
    body.appendChild(snip);
    row.appendChild(body);

    const more = document.createElement('button');
    more.className = 'shelf-row-more';
    more.innerHTML = A.icon('more');
    more.title = '更多操作';
    more.setAttribute('aria-label', '更多操作');
    more.onclick = e => { e.stopPropagation(); openRowMenu(row, it); };
    row.appendChild(more);

    row.addEventListener('click', () => openStory(it.id));
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); openStory(it.id); }
      else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
        e.preventDefault();
        openRowMenu(row, it);
      }
    });
    return row;
  }

  /* ============ 视图模型（阶段 4 屏 3：IR.ShelfScreen 状态桥） ============
   * Svelte 组件按这些数据渲染出与 rowOf / resultRowOf 同结构的 DOM；
   * 切分 / 分组 / 截断口径与旧拼装路径共用上面的常量与工具函数，不另起一套。 */

  function shelfModel(index) {
    const currentId = Store.getCurrentId();
    const grouped = { today: [], yesterday: [], week: [], older: [] };
    for (const it of index) grouped[groupKeyOf(it.updatedAt || 0)].push(it);
    const groups = [];
    let rowIndex = 0;
    for (const g of GROUP_LABELS) {
      const items = grouped[g.key];
      if (!items.length) continue;
      const capped = (g.key === 'older' && index.length > 300 && !expandEarlier && items.length > EARLIER_CAP);
      const shown = capped ? items.slice(0, EARLIER_CAP) : items;
      groups.push({
        key: g.key,
        label: g.label,
        count: items.length,
        items: shown.map(it => rowModel(it, currentId, rowIndex++)),
        capped,
        moreCount: items.length - EARLIER_CAP,
      });
    }
    return groups;
  }

  function rowModel(it, currentId, rowIndex) {
    return {
      id: it.id,
      current: it.id === currentId,
      rowIn: rowIndex < 14,
      delay: rowIndex < 14 ? Math.min(rowIndex * ROW_STAGGER_STEP, ROW_STAGGER_MAX) + 'ms' : '',
      // 导入档案的 thumb 不可信（审查 中危 #12）：白名单只放行 data:/blob:（safeThumb），
      // 组件拼 url() 时再经 JSON.stringify 转义——与旧 rowOf / models.js setStageArt 同口径
      thumb: Store.safeThumb(it.thumb),
      icon: MODE_ICONS[it.mode] || MODE_ICONS.choice,
      title: it.title || '未命名故事',
      meta: '[' + (MODE_LABELS[it.mode] || '剧情') + '] · 第 ' + (it.turn || 0) + ' 回合 · ' + relTime(it.updatedAt),
      snippet: it.snippet || '',
    };
  }

  function hitModel(hit, doc) {
    return {
      id: hit.id,
      rawTitle: doc.title,
      focusNid: (hit.hits && hit.hits[0] && hit.hits[0].nid) || null,
      titleSegs: segmentsOf(doc.title || '未命名故事', hit.titleRanges),
      meta: '[' + (MODE_LABELS[doc.mode] || '剧情') + '] · ' + relTime(doc.updatedAt),
      snippets: (hit.hits || []).slice(0, 2).map(h => segmentsOf(h.snippet, h.ranges)),
    };
  }

  // 「展开更多」：点开「更早」分组的截断（新旧两屏的行列表展开按钮共用）
  function showAllEarlier() {
    expandEarlier = true;
    renderShelf();
  }

  /* ================= 「⋯」菜单（§2.2） ================= */

  function closeRowMenus() {
    document.querySelectorAll('.row-menu').forEach(el => el.remove());
  }

  function openRowMenu(row, it) {
    closeRowMenus();
    if (A.closeMenus) A.closeMenus();
    const menu = document.createElement('div');
    menu.className = 'menu row-menu';
    const add = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.textContent = label;
      b.onclick = e => {
        e.stopPropagation();
        closeRowMenus();
        fn();
      };
      menu.appendChild(b);
    };
    add('重命名', () => renameStory(it.id));
    add('重新生成标题', () => regenTitle(it.id));
    // UI-4 §4.1：书架行「⋯」→「分支」：先打开该对话再叠分支页
    add('分支', () => {
      if (S.story && S.story.id === it.id) { A.openBranch({}); return; }
      openStory(it.id);
      A.openBranch({});
    });
    add('导出', () => { if (A.openExport) A.openExport(it.id); });
    add('删除', () => removeStory(it.id));
    row.appendChild(menu);
  }

  async function renameStory(id) {
    const st = Store.loadStory(id);
    if (!st) return;
    const t = await irConfirm('给这个对话起个新标题', {
      title: '重命名', input: true, value: st.title || '', okText: '保存',
    });
    if (t == null) return;
    const st2 = Store.loadStory(id);
    if (!st2) return;
    st2.title = String(t).trim() || st2.title;
    st2.titleAuto = false;   // 手动改名 → 不再被自动覆盖（§3.2）
    Store.saveStory(st2);
    renderShelf();
    toast('已重命名');
  }

  async function removeStory(id) {
    const st = Store.loadStory(id);
    const name = (st && st.title) || '这个对话';
    if (!await irConfirm('删除「' + name + '」？此操作不可恢复。', { title: '删除对话', okText: '删除' })) return;
    Store.deleteStory(id);
    renderShelf();
    toast('已删除');
  }

  /* ================= 自动标题（§3.3） ================= */

  const titleBusy = new Set();   // 每个故事同时只允许一个标题任务

  // 书记员未启用 / 没配置 key / 模型 → 不发任何网络请求，直接用本地兜底
  function titleModelUsable() {
    const sc = S.settings.scribe || {};
    if (!sc.enabled) return false;
    const cfg = resolveSub('scribe');
    if (!cfg.provider || !cfg.model) return false;
    const adapter = (IR.ChatProviders || {})[cfg.provider];
    if (!adapter || typeof adapter.chat !== 'function') return false;
    if (!cfg.apiKey) return false;
    return true;
  }

  // 打字机式替换标题（rich 逐字；standard 淡入替换；off 直接换）
  function typewriteTitle(storyId, text) {
    const el = titleElOf(storyId);
    if (!el) return;
    const level = motionLevel();
    if (level === 'rich') {
      const chars = Array.from(String(text));
      el.textContent = '';
      let i = 0;
      const step = () => {
        i += 1;
        el.textContent = chars.slice(0, i).join('');
        if (i < chars.length) setTimeout(step, 26);
      };
      step();
    } else if (level === 'standard') {
      el.textContent = text;
      el.classList.remove('title-swap');
      void el.offsetWidth;
      el.classList.add('title-swap');
    } else {
      el.textContent = text;
    }
  }

  // 回合 seal 之后调用：异步触发，不占用 busy、不阻塞下一次发送
  function maybeAutoTitle() {
    const story = S.story;
    if (!story || !IR.Titles || !IR.Titles.needsTitle(story)) return;
    const id = story.id;
    if (titleBusy.has(id)) return;
    titleBusy.add(id);
    const startedAt = Date.now();

    const writeBack = (title) => {
      if (!title) { titleBusy.delete(id); return; }
      // 竞态守卫（审查 中危 #14）：回合正在写盘（S.busy）时不能 saveAll——会把半截回合的
      // 中间态一起落盘。稍后重试；60 秒仍未收工就放弃这次（保留现有标题，titleAuto 仍为真）。
      if (S.busy && S.story && S.story.id === id) {
        if (Date.now() - startedAt > 60000) { titleBusy.delete(id); return; }
        setTimeout(() => writeBack(title), 2000);
        return;
      }
      titleBusy.delete(id);
      const st = (S.story && S.story.id === id) ? S.story : Store.loadStory(id);
      if (!st) return;
      if (!IR.Titles.applyTitle(st, id, title)) return;   // 护栏：id 一致 + titleAuto 仍为真
      if (S.story && S.story.id === id) saveAll();
      else Store.saveStory(st);
      if (shelfVisible()) {
        renderShelf();
        typewriteTitle(id, title);
      }
    };

    if (!titleModelUsable()) {
      writeBack(IR.Titles.fallback(story));
      return;
    }
    (async () => {
      let raw = '';
      try {
        const cfg = resolveSub('scribe');
        const msgs = IR.Titles.buildPrompt(story.messages || [], story.mode);
        raw = await IR.ChatProviders[cfg.provider].chat(cfg, msgs);
      } catch (_) {
        titleBusy.delete(id);   // 失败：静默，保留现有标题（不 toast、不计次）
        return;
      }
      writeBack(IR.Titles.sanitize(raw, '') || IR.Titles.fallback(story));
    })();
  }

  // 「重新生成标题」：任何对话都能手动触发一次（force 写回 + titleAuto 收掉）
  async function regenTitle(id) {
    if (titleBusy.has(id)) { toast('标题正在生成中，稍等一下'); return; }
    const st = Store.loadStory(id);
    if (!st) return;
    titleBusy.add(id);
    let title = '';
    try {
      if (titleModelUsable()) {
        const cfg = resolveSub('scribe');
        const msgs = IR.Titles.buildPrompt(st.messages || [], st.mode);
        let raw = '';
        try { raw = await IR.ChatProviders[cfg.provider].chat(cfg, msgs); } catch (_) { raw = ''; }
        title = IR.Titles.sanitize(raw, '');
      }
      if (!title) title = IR.Titles.fallback(st);
      if (IR.Titles.applyTitle(st, id, title, { force: true })) {
        st.titleAuto = false;   // 手动触发的结果不再被自动覆盖
        Store.saveStory(st);
        renderShelf();
        typewriteTitle(id, title);
        toast('标题已更新');
      }
    } finally {
      titleBusy.delete(id);
    }
  }

  /* ================= 搜索（§3.4 / §3.5） ================= */

  const searchStats = { buildMs: 0, lastQueryMs: 0, docs: 0, built: false };
  let searchBuilding = false;
  let searchTimer = null;
  let activeIdx = -1;

  // 首次聚焦搜索框才惰性构建（§3.4）：分批让出主线程，建完才允许查询
  function ensureSearchIndex() {
    if (searchStats.built || searchBuilding) return;
    searchBuilding = true;
    const items = Store.listStories();
    const t0 = Date.now();
    let i = 0;
    const BATCH = 5;   // 每批 ~5 个故事，setTimeout 0 让出主线程（§6）
    const step = () => {
      const end = Math.min(items.length, i + BATCH);
      for (; i < end; i++) {
        const st = Store.loadStory(items[i].id);
        if (st) IR.Search.index.upsert(st);
      }
      if (i < items.length) { setTimeout(step, 0); return; }
      searchBuilding = false;
      searchStats.built = true;
      searchStats.buildMs = Date.now() - t0;
      searchStats.docs = IR.Search.index.size();
      if (currentQuery) runSearch();
    };
    setTimeout(step, 0);
  }

  // 命中片段拆段：[{ t: '纯文本' }, { t: '命中', mark: true }]，旧拼装与 Svelte 组件共用切分口径
  function segmentsOf(text, ranges) {
    const s = String(text == null ? '' : text);
    const segs = [];
    let pos = 0;
    for (const r of (ranges || [])) {
      const a = Math.max(0, +r[0] || 0), b = Math.min(s.length, +r[1] || 0);
      if (b <= a || a < pos) continue;
      if (a > pos) segs.push({ t: s.slice(pos, a) });
      segs.push({ t: s.slice(a, b), mark: true });
      pos = b;
    }
    if (pos < s.length) segs.push({ t: s.slice(pos) });
    return segs;
  }

  // 高亮：createElement('mark') + textContent，绝不 innerHTML 拼片段（§0）
  function appendHighlighted(parent, text, ranges) {
    for (const seg of segmentsOf(text, ranges)) {
      if (!seg.mark) { parent.appendChild(document.createTextNode(seg.t)); continue; }
      const mark = document.createElement('mark');
      mark.textContent = seg.t;
      parent.appendChild(mark);
    }
  }

  function runSearch() {
    const input = $('#shelf-search');
    const q = (input && input.value || '').trim();
    currentQuery = q;
    const list = $('#shelf-list');
    const results = $('#shelf-results');
    const clearBtn = $('#shelf-search-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !q);
    if (!q) {
      results.classList.add('hidden');
      // 阶段 4 屏 3：结果行 DOM 由 Svelte 组件管时推空数组（等价于旧 innerHTML=''）
      if (IR.ShelfScreen) IR.ShelfScreen.results([]); else results.innerHTML = '';
      input.setAttribute('aria-expanded', 'false');
      input.setAttribute('aria-activedescendant', '');
      activeIdx = -1;
      $('#shelf-search-empty').classList.add('hidden');
      list.classList.remove('hidden');
      renderShelf();
      return;
    }
    if (!searchStats.built) { ensureSearchIndex(); return; }   // 等索引建好再查

    const t0 = Date.now();
    const hits = IR.Search.query(IR.Search.index.docs(), q);
    searchStats.lastQueryMs = Date.now() - t0;

    // 交叉淡入：结果替换分组列表
    list.classList.add('hidden');
    $('#shelf-empty').classList.add('hidden');
    results.classList.remove('hidden');
    results.classList.remove('fade-swap');
    void results.offsetWidth;
    results.classList.add('fade-swap');
    input.setAttribute('aria-expanded', 'true');
    activeIdx = -1;
    input.setAttribute('aria-activedescendant', '');

    const docs = new Map();
    for (const d of IR.Search.index.docs()) docs.set(d.id, d);

    $('#shelf-search-empty').classList.toggle('hidden', hits.length > 0);
    const termEl = $('#shelf-search-term');
    if (termEl && !hits.length) termEl.textContent = q;

    // 阶段 4 屏 3：命中行 DOM 由 Svelte 组件管（IR.ShelfScreen 推视图模型，高亮拆成 mark 段）；
    // 旧拼装路径原样留给 ?ui=legacy 逃生口。
    if (IR.ShelfScreen) {
      const models = [];
      for (const hit of hits) {
        const doc = docs.get(hit.id);
        if (doc) models.push(hitModel(hit, doc));
      }
      IR.ShelfScreen.results(models);
      return;
    }
    results.innerHTML = '';
    let i = 0;
    for (const hit of hits) {
      const doc = docs.get(hit.id);
      if (!doc) continue;
      results.appendChild(resultRowOf(hit, doc, i));
      i += 1;
    }
  }

  function resultRowOf(hit, doc, idx) {
    const row = document.createElement('div');
    row.className = 'shelf-hit';
    row.id = 'shelf-hit-' + hit.id;
    row.dataset.storyId = hit.id;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.tabIndex = 0;

    const title = document.createElement('div');
    title.className = 'shelf-hit-title';
    appendHighlighted(title, doc.title || '未命名故事', hit.titleRanges);
    row.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'shelf-hit-meta';
    meta.textContent = '[' + (MODE_LABELS[doc.mode] || '剧情') + '] · ' + relTime(doc.updatedAt);
    row.appendChild(meta);

    for (const h of (hit.hits || []).slice(0, 2)) {
      const snip = document.createElement('div');
      snip.className = 'shelf-hit-snippet';
      appendHighlighted(snip, h.snippet, h.ranges);
      row.appendChild(snip);
    }

    const openIt = () => openStory(hit.id, { focusNodeId: (hit.hits && hit.hits[0] && hit.hits[0].nid) || null });
    row.addEventListener('click', openIt);
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); openIt(); }
      else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
        e.preventDefault();
        openRowMenu(row, { id: hit.id, title: doc.title });
      }
    });
    return row;
  }

  // 搜索框内 ↑ ↓ 在结果间移动（aria-activedescendant）
  function moveActive(delta) {
    const results = $('#shelf-results');
    if (!results || results.classList.contains('hidden')) return;
    const rows = Array.from(results.querySelectorAll('.shelf-hit'));
    if (!rows.length) return;
    activeIdx = Math.max(0, Math.min(rows.length - 1, activeIdx + delta));
    rows.forEach((r, i) => {
      const on = i === activeIdx;
      r.classList.toggle('active', on);
      r.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const input = $('#shelf-search');
    input.setAttribute('aria-activedescendant', rows[activeIdx].id);
    if (rows[activeIdx].scrollIntoView) rows[activeIdx].scrollIntoView({ block: 'nearest' });
  }

  function clearSearch(focus) {
    const input = $('#shelf-search');
    if (!input) return;
    input.value = '';
    runSearch();
    if (focus) input.focus();
  }

  /* ================= 打开对话（§3.7） ================= */

  function openStory(id, opts) {
    if (S.story && S.story.id !== id) A.stopVideoWaiting();   // §7：切故事停本地轮询（pending 留在原档）
    const s = Store.loadStory(id);
    if (!s) { toast('没有找到这个存档', true); return; }
    S.story = s;
    S.story.savepoints = S.story.savepoints || [];
    S.story.ui = Object.assign(Store.defaultUi(), S.story.ui || {});
    Store.setCurrentId(S.story.id);
    A.enterGame(false);
    A.resumePendingVideos();   // §7：回到该故事，续上未出结果的生视频任务（不重复提交）
    // UI-4 §6：focusNodeId（兼容 UI-2 的 opts.nid）——搜索结果直接跳到命中的节点
    const focus = (opts && (opts.focusNodeId || opts.nid)) || null;
    if (focus) scrollToHit(focus);
  }

  // 命中节点在当前路径且在可见窗口内 → 滚动 + 短暂高亮（UI-2 已做）；
  // 否则 → 打开分支页、选中该节点（不自动 switchTo，由用户决定怎么继续，§6）
  function scrollToHit(nid) {
    setTimeout(() => {
      const sel = '#chat-scroll [data-nid="' + escAttr(nid) + '"]';
      const el = document.querySelector(sel);
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ block: 'center' });
        el.classList.remove('hit-flash');
        void el.offsetWidth;
        el.classList.add('hit-flash');
      } else {
        A.openBranch({ selectId: nid });
      }
    }, 80);   // 等 enterGame 把聊天区渲染出来
  }

  /* ================= 键盘（§2.4） ================= */

  function isTypingTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }

  function initShelf() {
    const input = $('#shelf-search');
    if (!input) return;

    input.addEventListener('focus', ensureSearchIndex);
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 120);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
      else if (e.key === 'Enter') {
        const results = $('#shelf-results');
        const rows = results ? Array.from(results.querySelectorAll('.shelf-hit')) : [];
        if (activeIdx >= 0 && rows[activeIdx]) {
          e.preventDefault();
          rows[activeIdx].click();
        }
      } else if (e.key === 'Escape') {
        if (input.value) {
          e.preventDefault();
          e.stopPropagation();   // 不触发全局的「关弹窗 / 退沉浸」
          clearSearch(true);
        }
      }
    });
    const clearBtn = $('#shelf-search-clear');
    if (clearBtn) clearBtn.onclick = () => clearSearch(true);

    const emptyNew = $('#btn-empty-new');
    if (emptyNew) emptyNew.onclick = () => openModal('modal-new');

    // / 或 Ctrl/Cmd+K 聚焦搜索（桌面）
    document.addEventListener('keydown', e => {
      if (!shelfVisible()) return;
      const k = e.key;
      if ((e.ctrlKey || e.metaKey) && (k === 'k' || k === 'K')) {
        e.preventDefault();
        input.focus();
        input.select();
        return;
      }
      if (k === '/' && !isTypingTarget(e.target)) {
        e.preventDefault();
        input.focus();
      }
    });

    // 点外面收掉「⋯」行菜单
    document.addEventListener('click', e => {
      if (e.target.closest && e.target.closest('.row-menu, .shelf-row-more')) return;
      closeRowMenus();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeRowMenus();
    });
  }

  A.reg({
    renderShelf,
    openStory,
    maybeAutoTitle,
    regenTitle,
    initShelf,
    searchStats,
    // 阶段 4 屏 3：Svelte 行上的「⋯」按钮 / Shift+F10 要叫到行菜单，「展开更多」要翻截断——
    // 两个入口登记给 A（函数体零改动 / 与旧按钮同语义），组件经 A() 调用
    openRowMenu,
    showAllEarlier,
  });
})();
