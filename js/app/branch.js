/*
 * js/app/branch.js —— 分支页（UI-4）：整页分支树 + 从任意节点继续 / 改我说的分叉
 *
 * 结构（§4.2）：整页覆盖层。顶栏「← 返回对话」｜标题｜缩小 / 放大｜「回到当前」｜「展开全部折叠」；
 * 画布是 SVG（createElementNS 构造，绝不用 innerHTML 拼 SVG / 节点文字）；右侧（窄屏底部）节点面板。
 *
 * 硬约束（§9）：
 *   - 分支页渲染只读 story.tree：**打开分支页不得修改树**（不 ensure 写盘 / 不改 active），
 *     只有面板操作才通过 Tree.* 改树；
 *   - 忙碌（busy 或有未 sealed 的 head）时所有切换类操作拒绝，沿用现有 busy 提示；
 *   - canResume === false（sid === null 的迁移旧节点）只许查看；
 *   - 文本一律 textContent；键盘导航（role=tree / treeitem + aria-activedescendant）。
 *
 * 动效（§4.5）：rich = 边按深度描边生长 + 节点弹簧弹出 + 流光（只挂 pathEdgeD 一条）
 *              + head 呼吸 / 选中脉冲；standard = 整体淡入；off = 无。
 *   新出现的节点（从聊天页返回后）单独「长出来」——seen 集合只存视图态，不进存档。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, toast, motionLevel, motionMs, fmtTime, saveAll } = A;

  const NS = 'http://www.w3.org/2000/svg';
  const ROW_H = 44;
  const ZOOM_MIN = 0.5, ZOOM_MAX = 2;
  const REPLY_PREVIEW = 400;

  // 视图态（不进存档）
  const V = {
    open: false,
    selectId: null,
    panelOpen: false,
    zoom: 1,
    tx: 0,
    ty: 0,
    expanded: new Set(),   // 展开的折叠超级节点（run 首 id）
    expandAll: false,
    layout: null,
    seen: new Set(),       // 已渲染过的节点 id（判定「新长出来」）
    dragging: null,
    pinch: null,
    suppressClick: false,
    renderTimer: null,
  };

  function svgEl(name, attrs, text) {
    const e = document.createElementNS(NS, name);
    if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
    if (text != null) e.textContent = String(text);
    return e;
  }

  function tree() { return (S.story && S.story.tree) || null; }
  function nodeOf(id) {
    const t = tree();
    return (t && t.nodes && t.nodes[id]) || null;
  }
  function isNarrow() {
    return typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(max-width: 720px)').matches : false;
  }
  // §2.5：忙碌期间所有切换类操作被拒绝（busy 或有未 sealed 的 head）
  function isBusy() {
    const head = nodeOf(tree() ? tree().head : null);
    return !!S.busy || !!(head && !head.sealed);
  }
  function gateSwitch() {
    if (isBusy()) { toast('正在生成中，等这一步结束再切分支'); return false; }
    return true;
  }

  function bookmarkIds() {
    const out = new Set();
    for (const sp of ((S.story && S.story.savepoints) || [])) {
      if (sp && sp.nodeId) out.add(sp.nodeId);
    }
    return out;
  }

  // codeSlice 的唯一口径在 IR.TreeLayout.codeSlice（treeLayout.js，审查 可维护性 三·5）
  const codeSlice = IR.TreeLayout.codeSlice;

  // 面板预览文本（textContent 用）：玩家行动原话；AI 回复取旁白（坏 JSON 当纯文本）
  function replyPreview(node) {
    const m = node && node.assistantMsg;
    const c = m && m.content;
    if (typeof c !== 'string' || !c) return '';
    try {
      const j = JSON.parse(c);
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        const n = j.narration != null ? j.narration : (j['旁白'] != null ? j['旁白'] : null);
        if (n != null) return String(n);
      }
    } catch (_) { /* 坏 JSON 当纯文本 */ }
    return c;
  }
  function actionText(node) {
    const a = node && node.action;
    return (a && a.text) ? String(a.text) : '';
  }

  /* ================= 打开 / 关闭 ================= */

  function openBranch(opts) {
    opts = opts || {};
    const st = S.story;
    const t = tree();
    if (!st || !t || !t.nodes) { toast('先打开一个对话再看分支'); return; }
    // §9：只读打开——不 ensure、不 project、不改 active
    V.open = true;
    V.selectId = (opts.selectId && t.nodes[opts.selectId]) ? opts.selectId : t.head;
    V.panelOpen = !!opts.selectId;
    const page = $('#branch-page');
    page.classList.remove('hidden');
    page.classList.remove('enter');
    if (motionLevel() !== 'off') {
      void page.offsetWidth;
      page.classList.add('enter');
    }
    $('#branch-title').textContent = (st.title || '未命名') + ' · 分支';
    // 循环动画预算 ≤3（§4.5）：分支页盖在聊天页上时，暂停底下舞台的 Ken Burns 等循环
    // 阶段 5 第 3 步：data-branch 的写入收口到 IR.Nav（全仓唯一写入点）
    IR.Nav.setBranchOpen(true);
    bindCanvas();
    relayout();
    render();
    centerOn(V.selectId);
    if (V.panelOpen) renderPanel(); else setPanelOpen(false);
    updateActiveDescendant();
    const svg = $('#branch-svg');
    if (svg && svg.focus) svg.focus({ preventScroll: true });
  }

  function closeBranch() {
    V.open = false;
    V.dragging = null;
    const page = $('#branch-page');
    if (page) page.classList.add('hidden');
    IR.Nav.setBranchOpen(false);
  }

  /* ================= 布局 / 渲染 ================= */

  function relayout() {
    const t = tree();
    if (!t) return;
    V.layout = IR.TreeLayout.compute(t, {
      collapseRun: 8,
      laneW: isNarrow() ? 28 : 36,
      rowH: ROW_H,
      selected: V.selectId,
      bookmarks: Array.from(bookmarkIds()),
      expanded: Array.from(V.expanded),
      expandAll: V.expandAll,
    });
  }

  function applyTransform() {
    const world = $('#branch-world');
    if (world) world.setAttribute('transform', 'translate(' + V.tx + ',' + V.ty + ') scale(' + V.zoom + ')');
  }

  function scheduleRender() {
    clearTimeout(V.renderTimer);
    V.renderTimer = setTimeout(() => {
      if (!V.open) return;
      // ≤400 个节点没有视口裁剪：平移 / 缩放只改 transform 就够，不整树重建（省主线程）
      const n = (V.layout && V.layout.nodes) || [];
      if (n.length > 400) render();
    }, 200);
  }

  // 视口裁剪：> 400 个节点时只创建可见行附近的元素（§3），选中 / head 恒创建
  function visibleNodes() {
    const nodes = (V.layout && V.layout.nodes) || [];
    if (nodes.length <= 400) return nodes;
    const canvas = $('#branch-canvas');
    const h = (canvas && canvas.clientHeight) || 600;
    const rowPx = ROW_H * V.zoom;
    const r0 = Math.floor((0 - V.ty) / rowPx) - 2;
    const r1 = Math.ceil((h - V.ty) / rowPx) + 2;
    return nodes.filter(n =>
      (n.row >= r0 && n.row <= r1) || n.isHead || n.id === V.selectId);
  }

  function render() {
    const svg = $('#branch-svg');
    const t = tree();
    const lay = V.layout;
    if (!svg || !t || !lay) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const world = svgEl('g', { id: 'branch-world' });
    const gEdges = svgEl('g', { class: 'branch-edges' });
    const gFlow = svgEl('g', { class: 'branch-flow-layer' });
    const gNodes = svgEl('g', { class: 'branch-nodes' });
    world.appendChild(gEdges);
    world.appendChild(gFlow);
    world.appendChild(gNodes);
    svg.appendChild(world);

    const vis = visibleNodes();
    const visIds = new Set(vis.map(n => n.id));
    const bms = bookmarkIds();
    const depth = new Map();
    for (const n of lay.nodes) depth.set(n.id, n.row);
    // 同一排多个泳道时标签会叠字：只留主干 / 选中的标签，其余悬停再显（collide）
    const rowCount = new Map();
    for (const n of vis) rowCount.set(n.row, (rowCount.get(n.row) || 0) + 1);

    // 边：两端都可见才画（折叠超级节点已并入 lay）
    const newEdges = [];
    for (const e of lay.edges) {
      if (!visIds.has(e.from) || !visIds.has(e.to)) continue;
      const p = svgEl('path', {
        class: 'branch-edge' + (e.onPath ? ' on-path' : ''),
        d: IR.TreeLayout.pointsToD(e.path, 18),
      });
      gEdges.appendChild(p);
      if (!V.seen.has(e.to)) newEdges.push({ el: p, row: depth.get(e.to) || 0 });
    }

    // 流光：只挂当前路径合成的这一条（§4.5）
    if (lay.pathEdgeD) {
      gFlow.appendChild(svgEl('path', { class: 'branch-flow', d: lay.pathEdgeD }));
    }

    // 节点
    const newNodes = [];
    for (const n of vis) {
      const collide = (rowCount.get(n.row) || 0) > 1 && !n.onPath && n.id !== V.selectId && n.collapsedCount == null;
      const g = renderNode(n, bms, t, collide);
      gNodes.appendChild(g);
      if (!V.seen.has(n.id)) newNodes.push(g);
    }

    applyTransform();
    playEntry(newEdges, newNodes);
    for (const n of vis) V.seen.add(n.id);
    updateActiveDescendant();
  }

  function renderNode(n, bms, t, collide) {
    const real = t.nodes[n.id] || null;
    const g = svgEl('g', {
      id: 'branch-node-' + n.id,
      class: 'branch-node'
        + (n.onPath ? ' on-path' : '')
        + (n.isHead ? ' is-head' : '')
        + (n.isFork ? ' is-fork' : '')
        + (n.collapsedCount != null ? ' is-collapse' : '')
        + (collide ? ' collide' : '')
        + (n.id === V.selectId ? ' is-selected' : ''),
      transform: 'translate(' + n.x + ',' + n.y + ')',
      role: 'treeitem',
      'aria-level': String((n.row || 0) + 1),
      'aria-selected': n.id === V.selectId ? 'true' : 'false',
      'aria-label': n.label,
      tabindex: '-1',
      'data-id': n.id,
      'data-row': String(n.row || 0),
    });
    const inner = svgEl('g', { class: 'node-inner' });
    inner.appendChild(svgEl('circle', { class: 'hit', cx: 0, cy: 0, r: 13 }));
    inner.appendChild(svgEl('circle', { class: 'halo', cx: 0, cy: 0, r: 14 }));
    inner.appendChild(svgEl('circle', { class: 'pulse-ring', cx: 0, cy: 0, r: 11 }));
    inner.appendChild(svgEl('circle', { class: 'head-ring', cx: 0, cy: 0, r: 10 }));
    inner.appendChild(svgEl('circle', { class: 'sel-ring', cx: 0, cy: 0, r: 11 }));
    inner.appendChild(svgEl('circle', { class: 'dot', cx: 0, cy: 0, r: n.collapsedCount != null ? 8 : 6 }));
    if (n.isFork) {
      inner.appendChild(svgEl('rect', { class: 'fork-badge', x: 7, y: -18, width: 18, height: 12, rx: 6 }));
      inner.appendChild(svgEl('text', { class: 'fork-badge-text', x: 16, y: -12 },
        String((real && real.children ? real.children.length : 2))));
    }
    if (bms.has(n.id)) {
      inner.appendChild(svgEl('path', { class: 'bm-mark', d: 'M-13,-5.5 L-7,-5.5 L-7,5.5 L-10,2.6 L-13,5.5 Z' }));
    }
    if (real && real.meta && real.meta.approx) {
      inner.appendChild(svgEl('text', { class: 'approx-mark', x: -11, y: -8 }, '≈'));
    }
    inner.appendChild(svgEl('text', { class: 'branch-label', x: 16, y: 1 }, n.label || ''));
    g.appendChild(inner);

    g.addEventListener('click', e => {
      e.stopPropagation();
      if (V.suppressClick) return;
      if (n.collapsedCount != null) {          // 超级节点：点击展开（视图态，不进存档）
        V.expanded.add(n.id);
        relayout();
        render();
        return;
      }
      V.selectId = n.id;
      V.panelOpen = true;
      render();
      renderPanel();
    });
    return g;
  }

  // 入场动效（仅 rich）：边按深度描边生长（总时长封顶 ~600ms）；新节点弹簧弹出
  function playEntry(edges, nodeEls) {
    const lv = motionLevel();
    if (lv === 'off' || (typeof document !== 'undefined' && document.hidden)) return;
    if (lv !== 'rich') return;   // standard：整体淡入由 .enter 负责，不做逐元素动效
    for (const item of edges) {
      const p = item.el;
      try {
        const len = (p.getTotalLength ? p.getTotalLength() : 120) || 120;
        p.style.strokeDasharray = String(len);
        const anim = p.animate(
          [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
          {
            duration: motionMs('--dur-slow', 420),
            delay: Math.min(item.row * 20, 180),
            easing: 'cubic-bezier(.2,.8,.2,1)',
            fill: 'both',
          });
        anim.onfinish = () => { p.style.strokeDasharray = ''; };
      } catch (_) { p.style.strokeDasharray = ''; }
    }
    for (const g of nodeEls) {
      // 弹簧弹出挂在内层 <g> 上（外层 g 的 transform 是 translate，不能被 CSS 动画覆盖）
      const inner = g.querySelector ? g.querySelector('.node-inner') : null;
      const target = inner || g;
      try {
        target.animate(
          [
            { transform: 'scale(.4)', opacity: 0 },
            { transform: 'scale(1)', opacity: 1 },
          ],
          {
            duration: motionMs('--dur-base', 220),
            easing: 'cubic-bezier(.34,1.56,.64,1)',
            fill: 'both',
          });
      } catch (_) { /* SVG transform 动不了就静默降级 */ }
    }
  }

  /* ================= 视角：平移 / 缩放 / 定位 ================= */

  function centerOn(id) {
    const lay = V.layout;
    const canvas = $('#branch-canvas');
    if (!lay || !canvas) return;
    const n = lay.nodes.find(x => x.id === id);
    if (!n) return;
    V.tx = (canvas.clientWidth || 800) / 2 - n.x * V.zoom;
    V.ty = (canvas.clientHeight || 600) / 2 - n.y * V.zoom;
    applyTransform();
    scheduleRender();
  }

  // 键盘移动到屏幕外：先把该节点滚进视野（§9）
  function ensureVisible(id) {
    const lay = V.layout;
    const canvas = $('#branch-canvas');
    if (!lay || !canvas) return;
    const n = lay.nodes.find(x => x.id === id);
    if (!n) return;
    const w = canvas.clientWidth || 800, h = canvas.clientHeight || 600;
    const sx = n.x * V.zoom + V.tx, sy = n.y * V.zoom + V.ty;
    const pad = 64;
    if (sx < pad) V.tx += pad - sx;
    else if (sx > w - pad) V.tx -= sx - (w - pad);
    if (sy < pad) V.ty += pad - sy;
    else if (sy > h - pad) V.ty -= sy - (h - pad);
    applyTransform();
  }

  function setZoom(z, cx, cy) {
    const canvas = $('#branch-canvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = (cx == null ? rect.width / 2 : cx - rect.left);
    const py = (cy == null ? rect.height / 2 : cy - rect.top);
    const nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    const k = nz / V.zoom;
    V.tx = px - (px - V.tx) * k;
    V.ty = py - (py - V.ty) * k;
    V.zoom = nz;
    applyTransform();
    scheduleRender();
  }

  function bindCanvas() {
    const canvas = $('#branch-canvas');
    if (!canvas || canvas.dataset.branchBound) return;
    canvas.dataset.branchBound = '1';

    canvas.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return;
      // 注意：不要在节点上捕获指针——setPointerCapture 会把 click 重定向到画布，
      // 节点面板就点不开了（验收中发现）。空白处按下才捕获；节点上的拖动靠冒泡追踪。
      const onNode = !!(e.target && e.target.closest && e.target.closest('.branch-node'));
      if (!onNode && canvas.setPointerCapture) {
        try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
      }
      if (e.pointerType === 'touch') {
        if (!V.pinch) V.pinch = { pts: new Map(), dist0: 0, zoom0: V.zoom };
        V.pinch.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (V.pinch.pts.size === 2) {
          const pts = Array.from(V.pinch.pts.values());
          V.pinch.dist0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
          V.pinch.zoom0 = V.zoom;
          V.dragging = null;
          return;
        }
      }
      V.suppressClick = false;
      V.dragging = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: V.tx, ty: V.ty, moved: 0 };
      canvas.classList.add('dragging');
    });

    canvas.addEventListener('pointermove', e => {
      if (V.pinch && V.pinch.pts.has(e.pointerId)) {
        V.pinch.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (V.pinch.pts.size === 2) {
          const pts = Array.from(V.pinch.pts.values());
          const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
          setZoom(V.pinch.zoom0 * (dist / V.pinch.dist0),
            (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
        }
        return;
      }
      const d = V.dragging;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.moved = Math.max(d.moved, Math.abs(dx) + Math.abs(dy));
      if (d.moved > 4) V.suppressClick = true;
      V.tx = d.tx + dx;
      V.ty = d.ty + dy;
      applyTransform();
    });

    const endPointer = e => {
      if (V.pinch) {
        V.pinch.pts.delete(e.pointerId);
        if (!V.pinch.pts.size) V.pinch = null;
      }
      const d = V.dragging;
      if (!d || d.id !== e.pointerId) return;
      V.dragging = null;
      canvas.classList.remove('dragging');
      if (d.moved > 4) scheduleRender();
      else setTimeout(() => { V.suppressClick = false; }, 0);
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    // 滚轮滚动平移；Ctrl / Cmd + 滚轮缩放（0.5×–2×）
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        setZoom(V.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
      } else {
        V.tx -= e.deltaX;
        V.ty -= e.deltaY;
        applyTransform();
        scheduleRender();
      }
    }, { passive: false });

    canvas.addEventListener('dblclick', e => {
      if (e.target && e.target.closest && e.target.closest('.branch-node')) return;
      centerOn(V.selectId);
    });

    window.addEventListener('resize', scheduleRender);
  }

  /* ================= 选择 / 键盘导航 ================= */

  function updateActiveDescendant() {
    const svg = $('#branch-svg');
    if (!svg) return;
    if (V.selectId && tree() && tree().nodes[V.selectId]) {
      svg.setAttribute('aria-activedescendant', 'branch-node-' + V.selectId);
    } else {
      svg.removeAttribute('aria-activedescendant');
    }
  }

  function selectNode(id, openPanel) {
    if (!nodeOf(id)) return;
    V.selectId = id;
    if (openPanel) V.panelOpen = true;
    ensureVisible(id);
    render();
    if (V.panelOpen) renderPanel();
    updateActiveDescendant();
    const el = document.getElementById('branch-node-' + id);
    if (el && el.focus) { try { el.focus({ preventScroll: true }); } catch (_) {} }
  }

  function onKey(e) {
    if (!V.open) return;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      if (V.panelOpen) {
        setPanelOpen(false);
        const svg = $('#branch-svg');
        if (svg && svg.focus) svg.focus({ preventScroll: true });
      } else {
        closeBranch();
      }
      return;
    }
    const t = tree();
    const cur = t && t.nodes[V.selectId];
    if (!cur) return;
    if (k === 'ArrowUp') {
      e.preventDefault();
      if (cur.parent && t.nodes[cur.parent]) selectNode(cur.parent);
    } else if (k === 'ArrowDown') {
      e.preventDefault();
      const kids = (cur.children || []).filter(id => t.nodes[id]);
      if (kids.length) {
        const next = (cur.active && kids.indexOf(cur.active) >= 0) ? cur.active : kids[0];
        selectNode(next);
      }
    } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      const sibs = IR.Tree.siblings(S.story, V.selectId);
      const idx = sibs.indexOf(V.selectId);
      const to = idx + (k === 'ArrowLeft' ? -1 : 1);
      if (idx >= 0 && to >= 0 && to < sibs.length) selectNode(sibs[to]);
    } else if (k === 'Enter') {
      e.preventDefault();
      V.panelOpen = true;
      renderPanel();
    }
  }

  /* ================= 节点面板（§4.4） ================= */

  /* 阶段 4 屏 5：面板已换 Svelte 实现（src/screens/branch，容器打 data-impl="svelte"）。
   * 文本与 disabled 由 IR.BranchScreen 状态桥推视图模型；下面的旧 DOM 写法原样留给 ?ui=legacy。
   * 视图模型口径与 0.12.1 逐字一致（哪句警告、哪个钮禁用，全部照搬，不改判据）。 */
  function panelBridge() {
    return (window.IR && IR.BranchScreen) || null;
  }

  function setPanelOpen(open) {
    V.panelOpen = !!open;
    const b = panelBridge();
    if (b) { b.panelOpen(V.panelOpen); return; }
    const panel = $('#branch-panel');
    if (panel) panel.classList.toggle('hidden', !V.panelOpen);
  }

  function panelModel(node, t) {
    const parent = node.parent ? t.nodes[node.parent] : null;
    const can1 = IR.Tree.canResume(S.story, node.id);          // 回到这里并从此继续 → 落到本节点
    const can2 = can1                                          // 改我说的 → 落到 parent
      && !!parent
      && IR.Tree.canResume(S.story, parent.id)
      && !(node.action && node.action.type === 'opening');
    const busy = isBusy();

    let warn = '';
    if (busy) warn = '正在生成中：这一步结束后才能切换 / 分叉。';
    else if (!can1) warn = '旧存档早期回合没有状态快照，只能查看：「回到这里并从此继续」「改我说的」已停用；「切到这条分支的最新处」仍可用。';
    else if (node.action && node.action.type === 'opening') warn = '开局回合不能改说的：想重开走向，用「回到这里并从此继续」。';
    else if (!parent) warn = '这是故事起点：可以「回到这里并从此继续」，但没有「这之前」可分叉。';
    else if (!IR.Tree.canResume(S.story, parent.id)) warn = '上一回合没有状态快照，「改我说的」会弄错世界状态，已停用。';

    return {
      turn: node.kind === 'root' ? '开局' : ('第 ' + (node.turn || 0) + ' 回合'),
      action: actionText(node) || (node.kind === 'root' ? '（故事起点）' : '（无玩家行动）'),
      reply: codeSlice(replyPreview(node), REPLY_PREVIEW) || '（无）',
      time: fmtTime(node.ts) || '—',
      model: (node.meta && node.meta.model) ? String(node.meta.model) : '—',
      warn: warn,
      resumeDisabled: busy || !can1,
      forkDisabled: busy || !can2,
      latestDisabled: busy,
    };
  }

  function renderPanel() {
    const t = tree();
    const node = t && t.nodes[V.selectId];
    const b = panelBridge();
    if (!node) {
      if (b) b.panelOpen(false);
      else { const p = $('#branch-panel'); if (p) p.classList.add('hidden'); }
      return;
    }
    const model = panelModel(node, t);
    if (b) { b.panel(model); return; }

    // —— 旧 DOM 路径（?ui=legacy）——
    const panel = $('#branch-panel');
    if (!panel) return;
    panel.classList.remove('hidden');

    $('#bp-turn').textContent = model.turn;
    $('#bp-action').textContent = model.action;
    $('#bp-reply').textContent = model.reply;
    $('#bp-time').textContent = model.time;
    $('#bp-model').textContent = model.model;

    $('#btn-bp-resume').disabled = model.resumeDisabled;
    $('#btn-bp-fork').disabled = model.forkDisabled;
    $('#btn-bp-latest').disabled = model.latestDisabled;

    const warn = $('#bp-warn');
    if (model.warn) {
      warn.textContent = model.warn;
      warn.classList.remove('hidden');
    } else {
      warn.textContent = '';
      warn.classList.add('hidden');
    }
  }

  // 切换后的统一收尾：投影已由 Tree.* 做完，这里只重绘 + 落盘
  function afterSwitch() {
    S.currentChoices = A.choicesFromHead();
    saveAll();
    A.renderChat();
    A.renderStage();
    A.renderThumbs();
    A.renderStoryPanels();
    A.renderSavepoints();
    A.updateHistoryBar();
  }

  function opResume() {
    if (!gateSwitch()) return;
    const node = nodeOf(V.selectId);
    if (!node) return;
    if (!IR.Tree.canResume(S.story, node.id)) {
      toast('旧存档早期回合没有状态快照，只能查看', true);
      return;
    }
    if (!IR.Tree.switchTo(S.story, node.id)) return;
    closeBranch();
    afterSwitch();
  }

  function opFork() {
    if (!gateSwitch()) return;
    const node = nodeOf(V.selectId);
    const t = tree();
    const parent = node && node.parent ? t.nodes[node.parent] : null;
    if (!node || !IR.Tree.canResume(S.story, node.id)
      || (parent && !IR.Tree.canResume(S.story, parent.id))) {
      toast('旧存档早期回合没有状态快照，只能查看', true);
      return;
    }
    const res = IR.Tree.forkBefore(S.story, node.id);
    if (!res.ok) { toast(res.reason || '这里不能分叉', true); return; }
    closeBranch();
    afterSwitch();
    A.setComposerText(res.action.text, res.action.kind);   // 预填原话 + 还原「做 / 说 / 导演」，不触发发送
  }

  function opLatest() {
    if (!gateSwitch()) return;
    const node = nodeOf(V.selectId);
    const leaf = node && IR.Tree.latestLeaf(S.story, node.id);
    if (!leaf) return;
    if (!IR.Tree.switchTo(S.story, leaf.id)) return;
    closeBranch();
    afterSwitch();
  }

  /* ================= 历史位置提示条（§5） ================= */

  function updateHistoryBar() {
    const bar = $('#history-bar');
    if (!bar) return;
    const t = tree();
    const head = t && t.nodes[t.head];
    const atHistory = !!(head && head.children && head.children.length > 0);
    bar.classList.toggle('hidden', !atHistory);
    if (!atHistory) return;
    const text = $('#history-bar-text');
    if (text) {
      text.textContent = '你在第 ' + (head.turn || 0) + ' 回合的历史位置 · 继续发送会创建新分支';
    }
  }

  function gotoLatest() {
    if (!gateSwitch()) return;
    const t = tree();
    const head = t && t.nodes[t.head];
    const leaf = head && IR.Tree.latestLeaf(S.story, head.id);
    if (!leaf || leaf.id === t.head) return;
    if (!IR.Tree.switchTo(S.story, leaf.id)) return;
    afterSwitch();
  }

  /* ================= 事件绑定 ================= */

  function initBranch() {
    $('#btn-branch-back').onclick = closeBranch;
    $('#btn-branch-zoom-in').onclick = () => setZoom(V.zoom * 1.2);
    $('#btn-branch-zoom-out').onclick = () => setZoom(V.zoom / 1.2);
    $('#btn-branch-center').onclick = () => {
      const t = tree();
      if (!t || !t.head) return;
      setPanelOpen(false);
      selectNode(t.head, false);
      centerOn(t.head);
    };
    $('#btn-branch-expand-all').onclick = e => {
      V.expandAll = !V.expandAll;
      const btn = e.currentTarget;
      btn.setAttribute('aria-pressed', V.expandAll ? 'true' : 'false');
      relayout();
      render();
    };
    $('#btn-bp-close').onclick = () => {
      setPanelOpen(false);
      const svg = $('#branch-svg');
      if (svg && svg.focus) svg.focus({ preventScroll: true });
    };
    $('#btn-bp-resume').onclick = opResume;
    $('#btn-bp-fork').onclick = opFork;
    $('#btn-bp-latest').onclick = opLatest;

    const jump = $('#btn-history-latest');
    if (jump) jump.onclick = gotoLatest;

    const svg = $('#branch-svg');
    if (svg) svg.addEventListener('keydown', onKey);
    const page = $('#branch-page');
    if (page) {
      page.addEventListener('keydown', e => {
        if (e.key === 'Escape' && e.target !== svg) onKey(e);
      });
    }

    // HUD「⋯」→「分支」
    const hud = $('#btn-branch');
    if (hud) hud.onclick = () => { A.closeMenus(); openBranch({}); };
  }

  A.reg({
    initBranch,
    openBranch,
    closeBranch,
    updateHistoryBar,
  });
})();
