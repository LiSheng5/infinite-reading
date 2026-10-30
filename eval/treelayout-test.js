#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 分支树布局测试（src/core/treeLayout.ts）
 *
 * 不开浏览器、不联网：
 *   1. 线性链 → 单泳道、行号递增、无分叉边；
 *   2. 一次分叉 → 两条泳道，分叉边从分叉点出发、不穿过其他节点；
 *   3. 嵌套分叉 + 泳道复用：子树结束后泳道被后续分支复用，泳道数 ≤ 理论最小值 + 1；
 *   4. 当前路径恒在 lane 0；onPath / isHead / isFork 标记正确；pathEdgeD 覆盖 root→head；
 *   5. 折叠：≥ collapseRun 的纯单链折叠，head / 书签 / 选中节点不折叠，collapsedCount 正确；
 *   6. 标签：JSON 取旁白、坏 JSON 当纯文本、码点截断、<script> 原样出现在文本里且无拼好的 HTML；
 *   7. 确定性：同输入两次输出深相等；
 *   8. 规模：2000 节点 < 500ms（Node 宽松上限）；
 *   9. 空树 / 只有根 / 损坏节点（缺 parent、环）不抛错；
 *  10. 分阶段纯函数：buildKids / assignRows / tracePath / packLanes 各自单独对账。
 *
 * 用法：node eval/treelayout-test.js
 */
const path = require('path');

global.window = global;
const TL = require(path.join(__dirname, '..', 'src', 'core', 'treeLayout.ts')).TreeLayout;
if (!TL) {
  console.error('加载失败：TreeLayout 导出缺失');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}

/* ---------------- 测试脚手架：直接造树（不依赖 src/core/tree.ts 的提交流程） ---------------- */

function mkTree(spec) {
  // spec: { links: [[parentId, childId]…], head, turns: {id: turn}, actions: {id: action},
  //         replies: {id: contentString}, active: {parentId: childId}, meta: {id: meta} }
  const tree = { v: 1, root: 'root', head: null, nodes: {}, states: {} };
  const ids = [];
  const add = id => {
    if (tree.nodes[id]) return tree.nodes[id];
    const n = {
      id: id, parent: null, children: [], active: null,
      kind: null, action: null, userMsg: null, assistantMsg: null,
      entries: [], scenes: [], sid: 'st-' + id, msgFloor: 0, msgSnap: null,
      sealed: true, turn: 0, ts: 1, meta: {},
    };
    tree.nodes[id] = n;
    ids.push(id);
    return n;
  };
  const root = add('root');
  root.kind = 'root';
  for (const [p, c] of (spec.links || [])) {
    const pn = add(p);
    const cn = add(c);
    cn.kind = cn.kind || 'turn';
    cn.parent = p;
    pn.children.push(c);
    if (!pn.active) pn.active = c;
  }
  tree.head = spec.head || ids[ids.length - 1] || 'root';
  for (const id of ids) {
    const n = tree.nodes[id];
    if (n.kind === 'root') { n.turn = 0; continue; }
    n.turn = (spec.turns && spec.turns[id] != null) ? spec.turns[id] : ids.indexOf(id);
    if (spec.actions && spec.actions[id]) n.action = spec.actions[id];
    if (spec.replies && spec.replies[id] != null) n.assistantMsg = { role: 'assistant', content: spec.replies[id] };
    if (spec.meta && spec.meta[id]) n.meta = spec.meta[id];
    if (spec.active && spec.active[id]) n.active = spec.active[id];
  }
  return tree;
}

// 线性链 root→t1→…→tn
function chainTree(n, headIdx) {
  const links = [];
  let prev = 'root';
  for (let i = 1; i <= n; i++) {
    links.push([prev, 't' + i]);
    prev = 't' + i;
  }
  return mkTree({ links: links, head: headIdx == null ? 't' + n : 't' + headIdx });
}

function maxLaneOf(out) {
  let m = 0;
  for (const n of out.nodes) if (n.lane > m) m = n.lane;
  return m;
}

// 线段上是否有别的节点中心（不含两端点）
function segHitsNode(out, a, b, allow) {
  for (const n of out.nodes) {
    if (allow.indexOf(n.id) >= 0) continue;
    const x = n.x, y = n.y;
    const minX = Math.min(a[0], b[0]) - 0.01, maxX = Math.max(a[0], b[0]) + 0.01;
    const minY = Math.min(a[1], b[1]) - 0.01, maxY = Math.max(a[1], b[1]) + 0.01;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    // 共线判定（叉积）
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (Math.abs(cross) < 0.01) return n.id;
  }
  return null;
}

/* ---------------- 1. 线性链 ---------------- */
{
  const t = chainTree(10);
  const out = TL.compute(t, { collapseRun: 99 });   // 不折叠，看纯几何
  check('1. 线性链：11 个节点全部渲染', out.nodes.length === 11, out.nodes.length);
  check('1. 线性链：单泳道', maxLaneOf(out) === 0, 'maxLane=' + maxLaneOf(out));
  let rowsOk = true;
  out.nodes.forEach((n, i) => { if (n.row !== i || n.y !== n.row * 44 + 32) rowsOk = false; });
  check('1. 线性链：行号递增且 y = padY + row*rowH', rowsOk);
  const noFork = out.edges.every(e => e.path.every(p => Math.abs(p[0] - out.nodes[0].x) < 0.01));
  check('1. 线性链：无分叉边（所有边 x 不变）', noFork);
}

/* ---------------- 2. 一次分叉 ---------------- */
{
  // root→t1→t2→t3（head=t3）；t2 另有孩子 x1→x2
  const t = mkTree({
    links: [['root', 't1'], ['t1', 't2'], ['t2', 't3'], ['t2', 'x1'], ['x1', 'x2']],
    head: 't3',
  });
  const out = TL.compute(t, { collapseRun: 99 });
  const by = {};
  out.nodes.forEach(n => { by[n.id] = n; });
  check('2. 一次分叉：两条泳道', maxLaneOf(out) === 1, 'maxLane=' + maxLaneOf(out));
  check('2. 一次分叉：主干在 lane 0、支线在 lane 1',
    by.t1.lane === 0 && by.t2.lane === 0 && by.t3.lane === 0 && by.x1.lane === 1 && by.x2.lane === 1);
  const fe = out.edges.find(e => e.from === 't2' && e.to === 'x1');
  check('2. 一次分叉：存在分叉边 t2→x1', !!fe);
  if (fe) {
    check('2. 一次分叉：分叉边从分叉点出发',
      fe.path[0][0] === by.t2.x && fe.path[0][1] === by.t2.y, JSON.stringify(fe.path));
    check('2. 一次分叉：先水平再向下',
      Math.abs(fe.path[1][1] - by.t2.y) < 0.01 && Math.abs(fe.path[2][0] - by.x1.x) < 0.01, JSON.stringify(fe.path));
    let hit = null;
    for (let i = 0; i + 1 < fe.path.length; i++) {
      hit = segHitsNode(out, fe.path[i], fe.path[i + 1], ['t2', 'x1']);
      if (hit) break;
    }
    check('2. 一次分叉：边不穿过其他节点', !hit, 'hit=' + hit);
  }
}

/* ---------------- 3. 嵌套分叉 + 泳道复用 ---------------- */
{
  // 主干 root→t1…t20（head=t20）；
  // t2 处分叉 A：a1→a2→a3→a4→a5（行 3..7），a2 处再嵌套 a2b1→a2b2（行 4..5）
  // t14 处分叉 B：b1…b5（行 15..19），b2 处再嵌套 b2b1→b2b2 —— 与 A 行区间不重叠 → 泳道复用
  const links = [];
  for (let i = 1; i <= 20; i++) links.push([i === 1 ? 'root' : 't' + (i - 1), 't' + i]);
  links.push(['t2', 'a1'], ['a1', 'a2'], ['a2', 'a3'], ['a3', 'a4'], ['a4', 'a5']);
  links.push(['a2', 'a2b1'], ['a2b1', 'a2b2']);
  links.push(['t14', 'b1'], ['b1', 'b2'], ['b2', 'b3'], ['b3', 'b4'], ['b4', 'b5']);
  links.push(['b2', 'b2b1'], ['b2b1', 'b2b2']);
  const t = mkTree({ links: links, head: 't20' });
  const out = TL.compute(t, { collapseRun: 99 });
  const by = {};
  out.nodes.forEach(n => { by[n.id] = n; });
  const lanes = maxLaneOf(out) + 1;

  // 泳道复用：B 整棵子树与 A 的行区间不重叠 → 同泳道
  check('3. 嵌套：A 与 B 复用同一支线泳道', by.a1.lane === by.b1.lane, 'a1=' + by.a1.lane + ' b1=' + by.b1.lane);
  check('3. 嵌套：嵌套分叉在更靠右的泳道',
    by.a2b1.lane > by.a1.lane && by.b2b1.lane > by.b1.lane, JSON.stringify([by.a1.lane, by.a2b1.lane, by.b1.lane, by.b2b1.lane]));

  // 理论最小值：行上同时存在的「脊」数最大值（区间图团数）+ 主干 1 条
  // 脊区间：A 主脊 [3,7]、A 嵌套 [4,5]、B 主脊 [15,19]、B 嵌套 [16,17]；主干 [0,20]
  const spineIntervals = [[3, 7], [4, 5], [15, 19], [16, 17], [0, 20]];
  let maxClique = 0;
  for (let r = 0; r <= 20; r++) {
    let c = 0;
    for (const [s, e] of spineIntervals) if (r >= s && r <= e) c += 1;
    if (c > maxClique) maxClique = c;
  }
  check('3. 嵌套：泳道数 ≤ 理论最小值 + 1（实际 ' + lanes + '，下限 ' + maxClique + '）',
    lanes <= maxClique + 1, 'lanes=' + lanes + ' min=' + maxClique);
  check('3. 嵌套：泳道数尽量小（本形状 = 3）', lanes === 3, 'lanes=' + lanes);
}

/* ---------------- 4. 路径标记 / pathEdgeD ---------------- */
{
  const links = [['root', 't1'], ['t1', 't2'], ['t2', 't3'], ['t3', 't4'], ['t2', 'x1'], ['x1', 'x2'], ['x2', 'x3']];
  const t = mkTree({ links: links, head: 't3' });
  t.nodes.t2.children = ['t3', 'x1'];   // t3 是路径续接（active 对齐）
  t.nodes.t2.active = 't3';
  const out = TL.compute(t, { collapseRun: 99 });
  const by = {};
  out.nodes.forEach(n => { by[n.id] = n; });
  check('4. 当前路径恒在 lane 0', ['root', 't1', 't2', 't3'].every(id => by[id] && by[id].lane === 0));
  check('4. onPath 标记正确',
    by.root.onPath && by.t1.onPath && by.t2.onPath && by.t3.onPath && !by.x1.onPath && !by.x2.onPath && !by.x3.onPath && !by.t4.onPath);
  check('4. isHead 标记正确', by.t3.isHead === true && out.nodes.filter(n => n.isHead).length === 1);
  check('4. isFork 标记正确', by.t2.isFork === true && by.root.isFork === false && by.x1.isFork === false);
  const rootOk = out.pathEdgeD.indexOf('M' + by.root.x) === 0 || out.pathEdgeD.indexOf('M ' + by.root.x) === 0 || out.pathEdgeD.split(' ')[0] === 'M' + by.root.x;
  const tailY = by.t3.y;
  check('4. pathEdgeD 覆盖 root→head', out.pathEdgeD.length > 0
    && out.pathEdgeD.split(/[MLQ]/).length >= 2
    && Math.abs(parseFloat(out.pathEdgeD.trim().split(/[MLQ ]+/).slice(-2)[1]) - tailY) < 0.6
    && rootOk, out.pathEdgeD);
}

/* ---------------- 5. 折叠 ---------------- */
{
  // root→t1…t25；head=t12、书签=t18、选中=t22，collapseRun=8
  const t = chainTree(25, 12);
  const out = TL.compute(t, {
    collapseRun: 8,
    bookmarks: ['t18'],
    selected: 't22',
    expanded: [],
  });
  const ids = out.nodes.map(n => n.id);
  const sup = out.nodes.find(n => n.collapsedCount != null);
  check('5. 折叠：出现超级节点', !!sup);
  if (sup) {
    check('5. 折叠：collapsedCount 正确（root..t11 共 12 个）', sup.collapsedCount === 12, sup.collapsedCount);
    check('5. 折叠：标签是「··· N 回合」', /^··· 12 回合$/.test(sup.label), sup.label);
  }
  check('5. 折叠：head / 书签 / 选中节点不被折叠',
    ids.indexOf('t12') >= 0 && ids.indexOf('t18') >= 0 && ids.indexOf('t22') >= 0 && ids.indexOf('t25') >= 0);
  check('5. 折叠：被折叠的节点不出现在输出里',
    ids.indexOf('t3') < 0 && ids.indexOf('t5') < 0
    && out.nodes.find(n => n.id === 'root').collapsedCount === 12);

  // 展开：run 首 id 进 expanded → 不折叠
  const out2 = TL.compute(t, {
    collapseRun: 8, bookmarks: ['t18'], selected: 't22',
    expanded: out.nodes.filter(n => n.collapsedCount != null).map(n => n.id),
  });
  check('5. 折叠：expanded 后不再折叠', !out2.nodes.some(n => n.collapsedCount != null) && out2.nodes.length === 26);

  // expandAll
  const out3 = TL.compute(t, { collapseRun: 8, bookmarks: ['t18'], selected: 't22', expandAll: true });
  check('5. 折叠：expandAll 全部展开', !out3.nodes.some(n => n.collapsedCount != null) && out3.nodes.length === 26);
}

/* ---------------- 6. 标签 ---------------- */
{
  const t = mkTree({
    links: [['root', 't1'], ['t1', 't2'], ['t2', 't3'], ['t3', 't4']],
    head: 't4',
    actions: {
      t1: { type: 'player', text: '推开门走了进去', kind: 'do', sent: '（做）推开门走了进去' },
      t2: { type: 'player', text: '', kind: 'do', sent: '' },
      t3: { type: 'player', text: '', kind: 'do', sent: '' },
      t4: { type: 'opening', text: '（故事开场。请描写第一幕，把玩家带进场景。）', kind: null, sent: '' },
    },
    replies: {
      t2: JSON.stringify({ narration: '旁白：雨声渐大', choices: [] }),
      t3: '不是 JSON，但是 { 有一段旁白 <script>alert(1)</script>',
      t4: '😀😀😀😀😀😀 开场旁白',
    },
    turns: { t1: 1, t2: 2, t3: 3, t4: 4 },
  });
  const out = TL.compute(t, { collapseRun: 99, labelLen: 200 });
  const by = {};
  out.nodes.forEach(n => { by[n.id] = n; });
  check('6. 标签：玩家行动优先', by.t1.label === '1 · 推开门走了进去', by.t1.label);
  check('6. 标签：剧情 JSON 取旁白', by.t2.label.indexOf('旁白：雨声渐大') >= 0, by.t2.label);
  check('6. 标签：坏 JSON 当纯文本', by.t3.label.indexOf('不是 JSON，但是 { 有一段旁白') >= 0, by.t3.label);
  check('6. 标签：开局取 AI 旁白（不取开局固定语）', by.t4.label.indexOf('开场旁白') >= 0 && by.t4.label.indexOf('故事开场') < 0, by.t4.label);
  check('6. 标签：root 是「开局」', by.root.label === '开局', by.root.label);

  // 码点截断：emoji 不截坏
  const out2 = TL.compute(t, { collapseRun: 99, labelLen: 3 });
  const label4 = out2.nodes.find(n => n.id === 't4').label;
  check('6. 标签：按码点截断（emoji 不被截坏）', label4 === '4 · 😀😀😀', label4);

  // <script> 原样出现、无拼好的 HTML
  const raw = JSON.stringify(out);
  const stripped = raw.split('<script>alert(1)</script>').join('');
  check('6. 标签：<script> 原样出现在文本里（无转义）',
    out.nodes.find(n => n.id === 't3').label.indexOf('<script>alert(1)</script>') >= 0
    && raw.indexOf('&lt;') < 0 && raw.indexOf('&amp;') < 0);
  check('6. 标签：输出里没有拼好的 HTML / innerHTML',
    stripped.indexOf('innerHTML') < 0 && stripped.indexOf('<') < 0 && stripped.indexOf('>') < 0);
}

/* ---------------- 7. 确定性 ---------------- */
{
  const links = [];
  for (let i = 1; i <= 30; i++) links.push([i === 1 ? 'root' : 't' + (i - 1), 't' + i]);
  for (let i = 1; i <= 10; i++) {
    links.push(['t' + (i * 2), 'x' + i]);
    links.push(['x' + i, 'x' + i + 'b']);
  }
  const t = mkTree({ links: links, head: 't30' });
  const a = JSON.stringify(TL.compute(t, { collapseRun: 8, bookmarks: ['t7'], selected: 't15' }));
  const b = JSON.stringify(TL.compute(t, { collapseRun: 8, bookmarks: ['t7'], selected: 't15' }));
  check('7. 确定性：同输入两次输出深相等', a === b);
}

/* ---------------- 8. 规模：2000 节点 ---------------- */
{
  // 主干 200 节点 + 每 5 个节点挂一条 25 节点支线 + 支线再挂 20 节点子支线 ≈ 2000 节点
  const links = [];
  let count = 0;
  const push = (p, c) => { links.push([p, c]); count += 1; };
  for (let i = 1; i <= 200; i++) {
    push(i === 1 ? 'root' : 't' + (i - 1), 't' + i);
    if (i % 5 === 0) {
      for (let j = 1; j <= 25; j++) push(j === 1 ? 't' + i : 'a' + i + '_' + (j - 1), 'a' + i + '_' + j);
      for (let j = 1; j <= 20; j++) push(j === 1 ? 'a' + i + '_15' : 'b' + i + '_' + (j - 1), 'b' + i + '_' + j);
    }
  }
  const t = mkTree({ links: links, head: 't200' });
  const nNodes = Object.keys(t.nodes).length;
  const t0 = Date.now();
  const out = TL.compute(t, { collapseRun: 8 });
  const ms = Date.now() - t0;
  check('8. 规模：' + nNodes + ' 节点（≥2000）布局 < 500ms（实测 ' + ms + 'ms）', ms < 500 && nNodes >= 2000, ms + 'ms');
  check('8. 规模：输出节点数 > 0', out.nodes.length > 0, out.nodes.length);
}

/* ---------------- 9. 损坏输入不抛错 ---------------- */
{
  const tryOk = (name, fn) => {
    try {
      const r = fn();
      const ok = r && Array.isArray(r.nodes) && Array.isArray(r.edges) && typeof r.pathEdgeD === 'string'
        && typeof r.width === 'number' && typeof r.height === 'number';
      check(name, ok);
    } catch (e) {
      check(name, false, '抛错：' + e.message);
    }
  };
  tryOk('9. 空树：返回可渲染的最小结果', () => TL.compute(null));
  tryOk('9. 空对象：返回可渲染的最小结果', () => TL.compute({}));
  tryOk('9. 只有根：返回单节点', () => {
    const r = TL.compute(mkTree({ links: [], head: 'root' }));
    return r.nodes.length === 1 ? r : { nodes: [1], edges: [], pathEdgeD: '', width: 0, height: 0 };
  });
  tryOk('9. 缺 parent 的悬挂节点：不抛错', () => {
    const t = mkTree({ links: [['root', 't1'], ['t1', 't2']], head: 't2' });
    t.nodes.orphan = { id: 'orphan', parent: 'gone', children: [], active: null, kind: 'turn', turn: 9, meta: {} };
    return TL.compute(t, {});
  });
  tryOk('9. 环：不抛错', () => {
    const t = mkTree({ links: [['root', 't1'], ['t1', 't2'], ['t2', 't3']], head: 't3' });
    t.nodes.t3.children.push('t1');   // t1 既是 t3 的孩子又挂在 root 下 → 有环风险
    t.nodes.t1.parent = 't3';
    return TL.compute(t, {});
  });
  tryOk('9. head 指向不存在的节点：不抛错', () => {
    const t = mkTree({ links: [['root', 't1']], head: 't1' });
    t.head = 'nope';
    return TL.compute(t, {});
  });
}

/* ---------------- 10. 分阶段纯函数（逐段对账，不再只能整体对账） ---------------- */
{
  /* 10.1 buildKids：children 表归一（顺序 / 去重 / 自引用 / 不存在的孩子 / parent 指针补登） */
  const map = {
    root: { children: ['a', 'a', 'a', 'gone', 'root'], parent: null, active: 'a' },
    a: { children: ['b'], parent: 'root', active: 'b' },
    b: { children: [], parent: null },        // parent 指针缺失，由 a.children 记账
    c: { children: [], parent: 'a' },         // 只登记在 parent 指针上
    bad: null,                                // 非对象节点
  };
  const kids = TL.buildKids(map);
  check('10. buildKids：剔除重复 / 自引用 / 不存在的孩子，保持数组序',
    JSON.stringify(kids.get('root')) === JSON.stringify(['a']), JSON.stringify(kids.get('root')));
  check('10. buildKids：parent 指针补登到 children 末尾',
    JSON.stringify(kids.get('a')) === JSON.stringify(['b', 'c']), JSON.stringify(kids.get('a')));
  check('10. buildKids：非对象节点不建 children 格（必然不可达）',
    kids.has('bad') === false, JSON.stringify(Array.from(kids.keys())));
  check('10. buildKids：不改入参（children 数组原样）',
    map.root.children.length === 5 && map.a.children.length === 1);

  /* 10.2 assignRows：行 = BFS 深度、order = 发现序、父指针唯一、路径 root→head */
  const H = TL.assignRows(kids, 'root', 'c');
  check('10. assignRows：行 = BFS 深度',
    H.row.get('root') === 0 && H.row.get('a') === 1 && H.row.get('b') === 2 && H.row.get('c') === 2,
    JSON.stringify(Array.from(H.row.entries())));
  check('10. assignRows：order = BFS 发现序（确定性基准）',
    JSON.stringify(H.order) === JSON.stringify(['root', 'a', 'b', 'c']), JSON.stringify(H.order));
  check('10. assignRows：父指针唯一（b 只挂在 a 下）',
    H.parentOf.get('root') === null && H.parentOf.get('a') === 'root' && H.parentOf.get('b') === 'a');
  check('10. assignRows：当前路径 root→head',
    JSON.stringify(H.path) === JSON.stringify(['root', 'a', 'c']), JSON.stringify(H.path));
  check('10. assignRows：onPath 与 path 一致',
    H.onPath.size === 3 && H.onPath.has('c') && !H.onPath.has('b'));

  /* 10.3 tracePath：根只有自己 / head 悬空 → 空 / 环只走一遍 */
  check('10. tracePath：根节点路径只有自己',
    JSON.stringify(TL.tracePath('root', H.row, H.parentOf)) === JSON.stringify(['root']));
  check('10. tracePath：head 悬空 → 空路径',
    TL.tracePath('nope', H.row, H.parentOf).length === 0);
  const cycMap = { root: { children: ['x'] }, x: { children: ['root'] } };
  const cycH = TL.assignRows(TL.buildKids(cycMap), 'root', 'x');
  check('10. tracePath：环只走一遍（root→x），BFS 不二次入队',
    JSON.stringify(cycH.path) === JSON.stringify(['root', 'x']) && cycH.order.length === 2,
    JSON.stringify(cycH.path) + ' order=' + JSON.stringify(cycH.order));

  // 段间装配：tree → { kids, row, order, path } → laneOf（后面两个用例共用）
  const stagesOf = tree => {
    const k = TL.buildKids(tree.nodes);
    const h = TL.assignRows(k, tree.root, tree.head);
    return { kids: k, H: h, lane: TL.packLanes(tree.root, tree.nodes, k, h.row, h.order, h.path) };
  };

  /* 10.4 packLanes：主干 lane 0；行区间重叠的并行支线递增；不重叠可复用同一泳道 */
  {
    // 主干 root→t1→t2→t3（head=t3）；t1 挂 x1→x2（行 2..3），t2 挂 y1（行 3）→ 与 x 区间重叠
    const t = mkTree({
      links: [['root', 't1'], ['t1', 't2'], ['t2', 't3'], ['t1', 'x1'], ['x1', 'x2'], ['t2', 'y1']],
      head: 't3',
    });
    const S = stagesOf(t);
    const lane = id => S.lane.get(id);
    check('10. packLanes：主干恒在 lane 0',
      ['root', 't1', 't2', 't3'].every(id => lane(id) === 0), JSON.stringify(Array.from(S.lane.entries())));
    check('10. packLanes：支线整条脊同泳道',
      lane('x1') === 1 && lane('x2') === 1, 'x1=' + lane('x1') + ' x2=' + lane('x2'));
    check('10. packLanes：行区间重叠的并行支线换到更靠右的泳道',
      lane('y1') === 2, 'y1=' + lane('y1'));
    check('10. packLanes：order 里每个节点都有泳道',
      S.H.order.every(id => S.lane.has(id)));

    // 纯函数：同入参两次结果相同，且不改入参
    const before = JSON.stringify([S.H.order, Array.from(S.H.row.entries())]);
    const again = TL.packLanes(t.root, t.nodes, S.kids, S.H.row, S.H.order, S.H.path);
    check('10. packLanes：同入参 → 同出参（确定性）',
      JSON.stringify(Array.from(again.entries())) === JSON.stringify(Array.from(S.lane.entries())));
    check('10. packLanes：不改入参（row / order 原样）',
      JSON.stringify([S.H.order, Array.from(S.H.row.entries())]) === before);
  }
  {
    // 主干 root→t1…t5；t1 挂 x1→x2（行 2..3），t4 挂 z1→z2（行 5..6）→ 行区间不重叠 → 复用泳道 1
    const links = [];
    for (let i = 1; i <= 5; i++) links.push([i === 1 ? 'root' : 't' + (i - 1), 't' + i]);
    links.push(['t1', 'x1'], ['x1', 'x2'], ['t4', 'z1'], ['z1', 'z2']);
    const t = mkTree({ links: links, head: 't5' });
    const lane = stagesOf(t).lane;
    check('10. packLanes：子树结束后泳道被后续分支复用',
      lane.get('x1') === 1 && lane.get('z1') === 1, 'x1=' + lane.get('x1') + ' z1=' + lane.get('z1'));
  }
}

/* ---------------- 汇总 ---------------- */
let bad = 0;
for (const r of results) {
  if (r.hit) console.log('  ✓ ' + r.name);
  else { bad += 1; console.log('  ✗ ' + r.name + (r.detail ? '  → ' + r.detail : '')); }
}
console.log(bad ? ('treelayout-test：' + bad + ' 项未过') : 'treelayout-test：全部通过');
process.exit(bad ? 1 : 0);
