/*
 * 无限阅读 · 分支树布局（UI-4 §3，纯逻辑，Node 可测）
 *
 * 职责：把 story.tree 算成分支页画布要的几何数据。不碰 DOM、不联网、无副作用：
 *   IR.TreeLayout.compute(tree, opts)
 *     opts: { collapseRun: 8, laneW: 36, rowH: 44, labelLen: 24,
 *             selected, bookmarks, expanded, expandAll }   // 后四项为视图态（不进存档）
 *     → { nodes:[{ id, x, y, lane, row, onPath, isHead, isFork, collapsedCount?, label }],
 *         edges:[{ from, to, path:[[x,y]…], onPath }],
 *         pathEdgeD, width, height }
 *
 * 布局规则（§3）：
 *   - 行 = 回合深度（根 = 0，时间向下），列 = 泳道（lane）；
 *   - 主干 = 当前路径（root → head）固定在 lane 0；
 *   - 路径上节点的非路径孩子、以及任意支线内部再分出来的支线：整棵子树贪心 + 区间打包
 *     到更靠右的泳道（子树行区间不重叠即可复用同一泳道；子泳道恒 > 父泳道，保证不交叉）；
 *   - 分叉边用「先水平再向下」的折线（路径点在 edges[].path，倒圆角的 d 由 pointsToD 生成）；
 *   - 折叠：不含分叉、且不含 head / 书签 / 选中节点的连续 ≥ collapseRun 个单链节点，
 *     折叠成一个「··· N 回合」超级节点（collapsedCount = N，点击展开 = 传 opts.expanded）；
 *   - label = 回合序号 + 玩家行动（开局取 AI 旁白）前 labelLen 个**码点**；
 *     助手内容是 JSON 取旁白（兼容中文键「旁白」），坏 JSON 当纯文本；输出不含任何 HTML；
 *   - pathEdgeD = 当前路径合成一条 SVG path 的 d（流光动画只挂这一条）；
 *   - 确定性：同一棵树同一参数 → 输出完全相同。
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    collapseRun: 8,
    laneW: 36,
    rowH: 44,
    labelLen: 24,
    padX: 64,
    padY: 32,
    labelW: 260,   // 节点右侧留给标签的空间（决定画布宽度）
    corner: 18,    // 分叉边倒圆角半径
  };

  /* ---------------- 文本 ---------------- */

  // 按码点截断（Array.from：emoji / 生僻字不会截出半个代理对）
  function codeSlice(s, n) {
    return Array.from(String(s == null ? '' : s)).slice(0, Math.max(0, n | 0)).join('');
  }

  // 助手回复文本：剧情模式是 JSON（slimReply：narration；旧档中文键：旁白）；坏 JSON 当纯文本
  function replyText(node) {
    const m = node && node.assistantMsg;
    const c = m && m.content;
    if (typeof c !== 'string' || !c) return '';
    try {
      const j = JSON.parse(c);
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        const n = j.narration != null ? j.narration : (j['旁白'] != null ? j['旁白'] : null);
        if (n != null) return String(n);
      }
    } catch (_) { /* 坏 JSON：整段当纯文本 */ }
    return c;
  }

  // 标签：回合序号 + 玩家行动（开局没有玩家行动 → 取 AI 旁白）前 labelLen 个码点
  function labelOf(node, labelLen) {
    if (!node || typeof node !== 'object') return '';
    if (node.kind === 'root') return '开局';
    const a = node.action;
    let text = (a && a.type !== 'opening' && a.text) ? String(a.text) : '';
    if (!text) text = replyText(node);
    return String(+node.turn || 0) + ' · ' + codeSlice(text, labelLen);
  }

  /* ---------------- 几何 ---------------- */

  function fmt(v) {
    return (Math.round(v * 100) / 100).toString();
  }

  // 折线点序 → SVG path d；中间拐角用二次贝塞尔倒圆角（只用 M/L/Q，不拼任何标记）
  function pointsToD(pts, radius) {
    if (!pts || !pts.length) return '';
    const r = +radius > 0 ? +radius : DEFAULTS.corner;
    let d = 'M' + fmt(pts[0][0]) + ' ' + fmt(pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1], cur = pts[i];
      const last = (i === pts.length - 1);
      if (last) { d += ' L' + fmt(cur[0]) + ' ' + fmt(cur[1]); continue; }
      const next = pts[i + 1];
      const d1 = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
      const d2 = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
      const rr = Math.min(r, d1 / 2, d2 / 2);
      if (!(rr > 0.5) || !d1 || !d2) { d += ' L' + fmt(cur[0]) + ' ' + fmt(cur[1]); continue; }
      const ax = cur[0] + (prev[0] - cur[0]) / d1 * rr;
      const ay = cur[1] + (prev[1] - cur[1]) / d1 * rr;
      const bx = cur[0] + (next[0] - cur[0]) / d2 * rr;
      const by = cur[1] + (next[1] - cur[1]) / d2 * rr;
      d += ' L' + fmt(ax) + ' ' + fmt(ay);
      d += ' Q' + fmt(cur[0]) + ' ' + fmt(cur[1]) + ' ' + fmt(bx) + ' ' + fmt(by);
    }
    return d;
  }

  /* ---------------- 主入口 ----------------
   * compute 编排三段纯逻辑（审查 可维护性 #1）：
   *   layerTree  —— 分层：children 表 → BFS 行号 → 当前路径 → 泳道分配
   *   foldChains —— 折叠：≥ collapseRun 的纯单链折成超级节点
   *   geometryOf —— 几何：节点 / 边 / pathEdgeD / 画布尺寸
   * 三段都是纯函数（同一入参 → 同一出参），compute 只做编排 + 空树兜底。
   */

  // 归一化视图参数（一次算好，三段共用；缺省回落 DEFAULTS）
  function normalizeOpts(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    return {
      o: o,
      collapseRun: Math.max(2, +o.collapseRun || DEFAULTS.collapseRun),
      laneW: +o.laneW > 0 ? +o.laneW : DEFAULTS.laneW,
      rowH: +o.rowH > 0 ? +o.rowH : DEFAULTS.rowH,
      labelLen: +o.labelLen > 0 ? +o.labelLen : DEFAULTS.labelLen,
      padX: +o.padX >= 0 ? +o.padX : DEFAULTS.padX,
      padY: +o.padY >= 0 ? +o.padY : DEFAULTS.padY,
      labelW: +o.labelW >= 0 ? +o.labelW : DEFAULTS.labelW,
      corner: +o.corner >= 0 ? +o.corner : DEFAULTS.corner,
    };
  }

  /* —— 1. 分层：children 表（防环）→ BFS 行号 → 当前路径（root→head，主干 lane 0）→ 泳道 —— */
  function layerTree(tree, cfg) {
    const map = (tree && tree.nodes) || null;
    if (!map || typeof map !== 'object') return null;
    const rootId = tree.root;
    if (!rootId || !map[rootId] || typeof map[rootId] !== 'object') return null;

    /* children 表（防环 / 剔除自引用；缺 parent 的悬挂节点不可达，不渲染） */
    const kids = new Map();          // id → [childId…]（保持 children 数组序，缺登记的补在后面）
    const parentOf = new Map();
    for (const id of Object.keys(map)) {
      const n = map[id];
      if (!n || typeof n !== 'object') continue;
      const list = [];
      const seen = new Set();
      for (const c of (Array.isArray(n.children) ? n.children : [])) {
        if (!c || c === id || seen.has(c) || !map[c]) continue;
        seen.add(c);
        list.push(c);
      }
      kids.set(id, list);
    }
    // 补：parent 指针存在但没登记进 parent.children 的（损坏 / 手改档）——按 key 序补到末尾
    for (const id of Object.keys(map)) {
      const n = map[id];
      if (!n || typeof n !== 'object') continue;
      const p = n.parent;
      if (!p || p === id || !map[p]) continue;
      const list = kids.get(p) || [];
      if (list.indexOf(id) < 0) list.push(id);
      kids.set(p, list);
    }

    /* 从根 BFS：行（深度）+ 可达集 */
    const row = new Map();
    const order = [];                // BFS 序（确定性遍历的基准）
    {
      const q = [rootId];
      row.set(rootId, 0);
      for (let qi = 0; qi < q.length; qi++) {
        const id = q[qi];
        order.push(id);
        for (const c of (kids.get(id) || [])) {
          if (row.has(c)) continue;   // 环：不二次入队
          row.set(c, row.get(id) + 1);
          q.push(c);
        }
      }
    }
    if (!row.size) return null;
    parentOf.set(rootId, null);
    for (const id of order) {
      for (const c of (kids.get(id) || [])) {
        if (!parentOf.has(c)) parentOf.set(c, id);
      }
    }

    /* 当前路径（root → head），主干固定 lane 0 */
    const path = [];
    {
      const seen = new Set();
      let id = tree.head || null;
      while (id && row.has(id) && !seen.has(id)) {
        seen.add(id);
        path.push(id);
        const p = parentOf.get(id);
        id = p == null ? null : p;
      }
      path.reverse();
    }
    const onPathSet = new Set(path);

    /* 泳道分配：主干 + 每条支线一条「脊」；支线整棵子树区间打包到更靠右的泳道 */
    const laneOf = new Map();
    const occupied = [];             // occupied[lane] = [[rowStart, rowEnd]…]

    function fits(lane, s, e) {
      const iv = occupied[lane];
      if (!iv) return true;
      for (let i = 0; i < iv.length; i++) {
        if (s <= iv[i][1] && e >= iv[i][0]) return false;
      }
      return true;
    }
    function mark(lane, s, e) {
      if (!occupied[lane]) occupied[lane] = [];
      occupied[lane].push([s, e]);
    }

    // 子树行区间（含全部后代；memo + 防环）
    const rangeMemo = new Map();
    function subtreeRange(id) {
      if (rangeMemo.has(id)) return rangeMemo.get(id);
      const r0 = row.get(id);
      const out = [r0, r0];
      rangeMemo.set(id, out);        // 先占位防环
      for (const c of (kids.get(id) || [])) {
        if (!row.has(c)) continue;
        const cr = subtreeRange(c);
        if (cr[0] < out[0]) out[0] = cr[0];
        if (cr[1] > out[1]) out[1] = cr[1];
      }
      return out;
    }

    // 脊：从 start 沿「续接孩子」直下（同泳道），其余孩子进支线队列
    const forkQueue = [];
    function assignSpine(startId, lane, contOf) {
      const guard = new Set();
      let id = startId;
      while (id && row.has(id) && !guard.has(id)) {
        guard.add(id);
        laneOf.set(id, lane);
        const list = kids.get(id) || [];
        const cont = contOf(id, list);
        for (const c of list) {
          if (c === cont) continue;
          forkQueue.push({ id: c, minLane: lane + 1 });
        }
        id = cont || null;
      }
    }
    // 主干的续接 = 路径上的下一个节点（不看 active，路径本身就是主干）
    const pathNext = new Map();
    for (let i = 0; i + 1 < path.length; i++) pathNext.set(path[i], path[i + 1]);
    assignSpine(rootId, 0, (id) => pathNext.get(id) || null);
    // 支线的续接 = active（对齐 descend 的语义），没 active 取第一个孩子
    const defaultCont = (id, list) => {
      if (!list.length) return null;
      const n = map[id];
      const a = n && n.active;
      return (a && list.indexOf(a) >= 0) ? a : list[0];
    };
    for (let qi = 0; qi < forkQueue.length; qi++) {
      const f = forkQueue[qi];
      if (!row.has(f.id) || laneOf.has(f.id)) continue;
      const rg = subtreeRange(f.id);
      let lane = f.minLane;
      while (!fits(lane, rg[0], rg[1])) lane += 1;
      mark(lane, rg[0], rg[1]);
      assignSpine(f.id, lane, defaultCont);
    }
    // 防御：极少数损坏结构下没分到泳道的节点（不可达脊）——按行补到 0，保证可渲染
    for (const id of order) if (!laneOf.has(id)) laneOf.set(id, 0);

    return { map: map, head: tree.head, kids: kids, parentOf: parentOf, row: row, order: order, onPathSet: onPathSet, laneOf: laneOf };
  }

  /* —— 2. 折叠：≥ collapseRun 的纯单链（不含 head / 书签 / 选中 / 展开态） —— */
  function foldChains(L, cfg) {
    const o = cfg.o;
    const kids = L.kids, parentOf = L.parentOf, order = L.order;

    const protect = new Set();
    if (L.head) protect.add(L.head);
    if (o.selected) protect.add(o.selected);
    for (const b of (Array.isArray(o.bookmarks) ? o.bookmarks : (o.bookmarks ? [o.bookmarks] : []))) {
      if (b) protect.add(b);
    }
    const expandedSet = o.expandAll
      ? null
      : new Set(Array.isArray(o.expanded) ? o.expanded : (o.expanded ? [o.expanded] : []));

    const isLinear = id => (kids.get(id) || []).length === 1;
    const eligible = id => isLinear(id) && !protect.has(id);
    const collapsed = new Map();     // hiddenId → superId
    const supers = new Map();        // superId → { id, ids, count }
    if (expandedSet) {
      const placed = new Set();
      for (const id of order) {
        if (placed.has(id) || !eligible(id)) continue;
        const p = parentOf.get(id);
        if (p && eligible(p)) continue;      // 属于父链的 run，稍后由父链延伸出来
        const run = [id];
        placed.add(id);
        let cur = id;
        for (;;) {
          const k = (kids.get(cur) || [])[0];
          if (!k || !eligible(k) || placed.has(k)) break;
          run.push(k);
          placed.add(k);
          cur = k;
        }
        if (run.length < cfg.collapseRun) continue;
        let skip = false;
        for (const rid of run) if (expandedSet.has(rid)) { skip = true; break; }
        if (skip) continue;
        supers.set(run[0], { id: run[0], ids: run.slice(), count: run.length });
        for (const rid of run) collapsed.set(rid, run[0]);
      }
    }
    return { collapsed: collapsed, supers: supers };
  }

  /* —— 3. 几何：节点 / 边 / pathEdgeD —— */
  function geometryOf(L, F, cfg) {
    const map = L.map, kids = L.kids, parentOf = L.parentOf, row = L.row, order = L.order;
    const onPathSet = L.onPathSet, laneOf = L.laneOf;
    const collapsed = F.collapsed, supers = F.supers;
    const labelLen = cfg.labelLen, laneW = cfg.laneW, rowH = cfg.rowH;
    const padX = cfg.padX, padY = cfg.padY, labelW = cfg.labelW, corner = cfg.corner;

    const xOf = id => padX + (laneOf.get(id) || 0) * laneW;
    const yOf = id => padY + (row.get(id) || 0) * rowH;

    const outNodes = [];
    const outNodeIds = new Set();
    for (const id of order) {
      const hid = collapsed.get(id);
      if (hid != null && hid !== id) continue;          // 被折叠吞掉的节点
      const sup = supers.get(id);
      const n = map[id];
      const x = xOf(id), y = yOf(id);
      const base = {
        id: id, x: x, y: y,
        lane: laneOf.get(id) || 0,
        row: row.get(id) || 0,
        onPath: onPathSet.has(id),
        isHead: id === L.head,
        isFork: !sup && (kids.get(id) || []).length > 1,
      };
      if (sup) {
        base.collapsedCount = sup.count;
        base.label = '··· ' + sup.count + ' 回合';
        base.onPath = sup.ids.some(rid => onPathSet.has(rid));
        base.isHead = false;
        base.isFork = false;
      } else {
        base.label = labelOf(n, labelLen);
      }
      outNodes.push(base);
      outNodeIds.add(id);
    }

    // 边：可见节点（含超级节点）连到「代表化的」父
    const rep = id => {
      const hid = collapsed.get(id);
      return hid == null ? id : hid;
    };
    const outEdges = [];
    for (const id of order) {
      if (!outNodeIds.has(id)) continue;
      const p = parentOf.get(id);
      if (p == null || !row.has(p)) continue;
      const from = rep(p), to = id;
      if (from === to) continue;
      const x1 = xOf(from), y1 = yOf(from), x2 = xOf(to), y2 = yOf(to);
      const path2 = (Math.abs(x1 - x2) < 0.01)
        ? [[x1, y1], [x2, y2]]
        : [[x1, y1], [x2, y1], [x2, y2]];
      outEdges.push({
        from: from, to: to,
        path: path2,
        onPath: onPathSet.has(from) && onPathSet.has(to),
      });
    }

    // pathEdgeD：主干合成一条（流光只挂这一条）
    let pathEdgeD = '';
    {
      const trunkPts = [];
      for (const id of order) {
        if (!outNodeIds.has(id)) continue;
        if (!onPathSet.has(id) && !(supers.get(id) && supers.get(id).ids.some(r => onPathSet.has(r)))) continue;
        const pt = [xOf(id), yOf(id)];
        if (!trunkPts.length || trunkPts[trunkPts.length - 1][0] !== pt[0] || trunkPts[trunkPts.length - 1][1] !== pt[1]) {
          trunkPts.push(pt);
        }
      }
      // 按 y 排序保证 root→head 顺序（BFS 序本来有序，这里只是兜底）
      trunkPts.sort((a, b) => a[1] - b[1]);
      pathEdgeD = pointsToD(trunkPts, corner);
    }

    let maxLane = 0, maxRow = 0;
    for (const id of order) {
      const l = laneOf.get(id) || 0, r = row.get(id) || 0;
      if (l > maxLane) maxLane = l;
      if (r > maxRow) maxRow = r;
    }

    return {
      nodes: outNodes,
      edges: outEdges,
      pathEdgeD: pathEdgeD,
      width: padX * 2 + maxLane * laneW + labelW,
      height: padY * 2 + maxRow * rowH,
    };
  }

  function compute(tree, opts) {
    const cfg = normalizeOpts(opts);
    const empty = { nodes: [], edges: [], pathEdgeD: '', width: cfg.padX * 2, height: cfg.padY * 2 };
    const L = layerTree(tree, cfg);          // 分层
    if (!L) return empty;
    const F = foldChains(L, cfg);            // 折叠
    return geometryOf(L, F, cfg);            // 几何
  }

  global.IR = Object.assign(global.IR || {}, {
    TreeLayout: { DEFAULTS: DEFAULTS, compute: compute, pointsToD: pointsToD, codeSlice: codeSlice },
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
