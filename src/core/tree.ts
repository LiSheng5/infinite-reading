/*
 * 无限阅读 · 分支树数据层（第一期：数据模型 + 投影）
 *
 * 职责：story.tree 是回合树的**唯一真源**；story.log / messages / scenes / world / …
 * 全是「根 → head」这条路径的派生物（任务书 §2 / §3）。
 *  - 纯逻辑：不碰 DOM、不碰 IR.Storage、不联网；Node 里 require 就能测
 *  - 零依赖、零构建：IIFE 挂到全局 IR
 *
 * 另承载 IR 根级纯工具（genId / clone / sleep / plainReply，审查 可维护性 #5 与三·1/三·4/三·5）：
 * 零依赖、全模块可引用的小函数收敛在这里一处实现，其它模块只调用、不再各写一份。
 *
 * API（本期）：
 *   ensure(story)            建树 / 校验（幂等）；无树的旧档降级建线性链，
 *                            末条旁白 versions>1 展开成兄弟、旧存档点 sp.turn→nodeId 映射（§6）
 *   begin(story)             回合开始：记下 logMark（在 pushLog 之前调）
 *   commit(story, opts)      回合成功落一个 turn 节点，head 前移
 *   seal(story, nodeId)      回合结算后封存：entries 再切片、算 msgFloor、存 State
 *   project(story)           把「根 → head」路径投影回 log / messages / scenes / …
 *   pathOf(story, nodeId)    根到某节点的路径（含两端）
 *   siblings(story, nodeId)  某节点的兄弟 id 列表（含自身，按创建序）；无父 → [nodeId]
 *   switchSibling(story, nodeId, dir)  切兄弟（dir = -1 | +1），沿 active 下探到叶子后投影
 *   switchTo(story, nodeId)  直接落到某节点（存档点回档，§4.6），投影 + active 记忆对齐
 *   latestLeaf(story, nodeId)  沿 active 下探到叶子（descend 的公开版，UI-4 §2.2）
 *   forkBefore(story, nodeId)  落到该回合发生之前（= parent），返回原玩家行动（UI-4 §2.3）
 *   canResume(story, nodeId)  该节点能否作为「继续 / 分叉」的落点（sid 未知则不行，UI-4 §2.4）
 *   pushLate(story, nodeId, entry|scene)  晚到条目 / 画面（§4.4）：写节点；在路径上再同步进投影
 *   imageIdsOf(tree)         全树（含非当前分支）引用到的原图 id
 *
 * 约定（§3）：
 *   - 条目与消息对象**按引用共享**（project 不 clone 它们）：log 条目的就地修改
 *     （reasoning 补写等）自动落在树上；**State 才 clone**。
 *   - msgFloor = 路径 turn 节点序列的下标（0 = 第一个 turn 节点）：
 *     messages 窗口 = 从第 msgFloor 个 turn 节点起，依次展开 [userMsg, assistantMsg]。
 *   - 窗口对不上（messages 奇数条 / 与路径末尾对不齐）→ 节点退化存整窗口快照 msgSnap。
 */
import { IR, registerIR } from './ir.ts';
import type { Story, StoryTree } from './schema.ts';

/* ↑ 阶段 2 搬迁自 js/tree.js（IIFE → ES module，函数体逐字未动）。
 * 模块间现存的 global.IR 惰性互访按铁律保留（可选依赖语义，见 src/core/ir.ts 头注）；
 * 导出即真实 API，IR 只是给未迁移界面层的镜像。 */
const global = globalThis as any;

  const TREE_V = 1;
  // story 裁剪窗口的唯一口径：store.js 的 serializeStory 与书架导出一律引用这里的导出，
  // 不要再在别处写 120 / 12 / 5 字面量（改一处漏一处会静默裁错档）
  const LOG_WINDOW = 120;      // serializeStory 的 log 裁剪
  const SCENE_WINDOW = 12;     // serializeStory 的 scenes 裁剪
  const SAVEPOINT_KEEP = 5;    // 存档点最多保留
  const PAINTER_THREAD_KEEP = 20;  // State 里的 painterThread 只留末 20 条

  let seq = 0;
  // ID 生成的唯一口径（审查 可维护性 #5）：前端各处（store / painter / library / video /
  // styleanchor / proposals）一律用 IR.genId(prefix)，不要再各写 Date.now().toString(36)+random 变体。
  //   prefix —— 实体前缀（n/st/s/pf/sc/sp/vd/style/pp…）；
  //   now    —— 可选时间戳（提案等需要「以注入时间为准」的确定性场景），缺省 Date.now()。
  // seq 自增 + 3 位随机，保证同一毫秒内多次调用也不撞 id。
  function genId(prefix, now?) {
    seq += 1;
    return prefix + Number(now || Date.now()).toString(36) + seq.toString(36) + Math.random().toString(36).slice(2, 5);
  }

  // 深拷贝的唯一口径（审查 可维护性 三·1）：浏览器 / Node 用 structuredClone（不丢 undefined / Date、
  // 循环引用不炸）；环境没有或内容不可克隆（函数等）时回落 JSON 往返。
  // State / msgSnap 等一律用 IR.clone，不要再各写 JSON.parse(JSON.stringify(x))。
  function clone(x) {
    if (x == null || typeof x !== 'object') return x;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(x); } catch (_) { /* 含不可克隆值 → 回落 JSON 语义 */ }
    }
    return JSON.parse(JSON.stringify(x));
  }

  // 异步等待的唯一口径（审查 可维护性 三·5）：适配器轮询（providers）与 app 工具共用
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // 助手回复 → 纯文本的唯一口径（审查 可维护性 三·4）：剧情模式是 JSON（narration / 旁白），
  // 解析失败 / 无旁白字段时当纯文本（§3.4）。search.js 索引与 store.js 书架摘要共用这一份。
  function plainReply(raw) {
    const s = String(raw == null ? '' : raw);
    const t = s.trim();
    if (t.charAt(0) === '{') {
      try {
        const o = JSON.parse(t);
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          const n = o.narration || o['旁白'] || o.text || '';
          if (n) return String(n);
          if (Array.isArray(o.choices) && o.choices.length) {
            return o.choices.map(function (c) { return String(c); }).join(' ');
          }
        }
      } catch (_) { /* 坏 JSON：当纯文本 */ }
    }
    return s;
  }

  /* ---------------- 基础形状 ---------------- */

  // 与 serializeStory 输出同口径的 sceneMeta（不含 src：原图走 images store）
  // 视频场景字段（§5）：videoId / thumb（封面）/ sourceSceneId / mode / taskId / remoteUrl
  function sceneMetaOf(s) {
    return {
      id: s.id, alt: s.alt || '', prompt: s.prompt || '', promptRaw: s.promptRaw || '',
      kind: s.kind || undefined,                       // 'video' = 视频场景
      aspect: s.aspect || '', width: s.width || 0, height: s.height || 0,
      styleCardId: s.styleCardId || undefined,
      supersededBy: s.supersededBy || undefined,
      thumb: s.thumb || s.poster || null,
      imageId: s.imageId || undefined,
      videoId: s.videoId || undefined,
      sourceSceneId: s.sourceSceneId || undefined,
      mode: s.mode || undefined,
      taskId: s.taskId || undefined,
      remoteUrl: s.remoteUrl || s.videoUrl || undefined,
      duration: s.duration || undefined, resolution: s.resolution || undefined,
      ratio: s.ratio || undefined, model: s.model || undefined,
      ts: s.ts,
    };
  }

  // 结算后的 State 快照（§2）：随分支回退的那部分剧情推导产物
  function stateOf(story) {
    return {
      world: clone(story.world || {}),
      summaries: clone(story.summaries || []),
      rollingStyle: clone(story.rollingStyle || {}),
      painterThread: clone((story.painterThread || []).slice(-PAINTER_THREAD_KEEP)),
      lastSceneSummary: story.lastSceneSummary || '',
      lastBg: story.lastBg || null,
    };
  }

  // states 去重池（§2）：与父节点的 state 序列化后相同 → 复用父节点的 sid
  function internState(tree, state, parentSid) {
    const key = JSON.stringify(state);
    if (parentSid != null && tree.states[parentSid] && JSON.stringify(tree.states[parentSid]) === key) {
      return parentSid;
    }
    const sid = genId('st');
    tree.states[sid] = state;
    return sid;
  }

  function emptyTree() {
    return { v: TREE_V, root: null, head: null, nodes: {}, states: {} };
  }

  function makeNode(opts) {
    return {
      id: opts.id || genId('n'),
      parent: opts.parent == null ? null : opts.parent,
      children: [],
      active: null,
      kind: opts.kind,
      action: opts.action || null,
      userMsg: opts.userMsg || null,
      assistantMsg: opts.assistantMsg || null,
      entries: opts.entries || [],
      scenes: opts.scenes || [],
      sid: opts.sid == null ? null : opts.sid,
      msgFloor: typeof opts.msgFloor === 'number' ? opts.msgFloor : 0,
      msgSnap: opts.msgSnap || null,   // 窗口对不齐时的退化路径（§3）：整窗口克隆
      sealed: !!opts.sealed,
      turn: +opts.turn || 0,
      ts: opts.ts || Date.now(),
      meta: opts.meta || {},           // 预留给第二期（模型 / 备注等）
    };
  }

  // 回合产生的 sceneMeta：以「本回合 image 条目」为准，从 story.scenes 取同口径形状
  function scenesFor(story, entries) {
    const ids = [];
    for (const e of (entries || [])) {
      if (e && (e.type === 'image' || e.type === 'video') && e.id && ids.indexOf(e.id) < 0) ids.push(e.id);
    }
    if (!ids.length) return [];
    const by = new Map();
    for (const s of (story.scenes || [])) if (s && s.id) by.set(s.id, s);
    const out = [];
    for (const id of ids) { const s = by.get(id); if (s) out.push(sceneMetaOf(s)); }
    return out;
  }

  /* ---------------- action 还原 ---------------- */

  const KIND_LABELS = { do: '做', say: '说', direct: '导演' };
  const KIND_MARK_RE = /^（(做|说|导演)）/;

  // user 消息 → 实际发给 AI 的串（含 do/say/direct 标记）；与 app.js buildCompressInput 同口径
  function stripUserContent(s) {
    return String(s == null ? '' : s).replace(/^\[设定\][\s\S]*?\n\n/, '').replace(/^\[玩家行动\]\s*/, '');
  }
  function parseSent(sent) {
    const s = String(sent == null ? '' : sent);
    const m = KIND_MARK_RE.exec(s);
    if (!m) return { kind: null, text: s };
    const kind = m[1] === '说' ? 'say' : (m[1] === '导演' ? 'direct' : 'do');
    return { kind: kind, text: s.slice(m[0].length) };
  }
  function normalizeAction(action, userMsg) {
    const a = (action && typeof action === 'object') ? action : {};
    let type = a.type || 'player';
    let text = (a.text != null) ? String(a.text) : '';
    let kind = a.kind || null;
    let sent = (a.sent != null) ? String(a.sent) : '';
    if (!sent && userMsg && typeof userMsg.content === 'string') sent = stripUserContent(userMsg.content);
    if (!text && sent) {
      const p = parseSent(sent);
      text = p.text;
      if (!kind) kind = p.kind;
    }
    return { type: type, text: text, kind: kind, sent: sent };
  }

  /* ---------------- 路径 ---------------- */

  function pathNodes(tree, nodeId) {
    const out = [];
    const seen = new Set();
    let n = tree.nodes[nodeId];
    while (n && !seen.has(n.id)) {
      seen.add(n.id);
      out.push(n);
      n = n.parent ? tree.nodes[n.parent] : null;
    }
    return out.reverse();
  }

  /* ---------------- messages 窗口（§3） ---------------- */

  function sameMsg(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.role === b.role && String(a.content) === String(b.content);
  }

  // 窗口应等于「路径末尾若干个 turn 节点的 [userMsg, assistantMsg]」成对展开。
  // 成对且完全对得上 → 记 msgFloor；对不上（奇数条 / 对不齐）→ 退化存整窗口快照 msgSnap。
  function computeWindow(tree, node, messages) {
    const turns = pathNodes(tree, node.id).filter(n => n.kind === 'turn');
    let k = 0;
    while (k < turns.length) {
      const t = turns[turns.length - 1 - k];
      const ui = messages.length - 2 * k - 2;
      if (ui < 0) break;
      if (!sameMsg(messages[ui], t.userMsg) || !sameMsg(messages[ui + 1], t.assistantMsg)) break;
      k += 1;
    }
    const floor = turns.length - k;
    if (2 * k === messages.length) return { msgFloor: floor, msgSnap: null };
    return { msgFloor: floor, msgSnap: clone(messages) };
  }

  /* ---------------- ensure：建树 / 校验（§2，幂等） ---------------- */

  // 无树旧档 → 线性链（迁移细则见任务书 §6）：
  //   - 根节点 sid = 当前 State（旧档没有更早的历史状态）；
  //   - 按 messages 成对 + log 对应条目生成 turn 节点，链只覆盖现存的回合；
  //   - 只有 head 的 sid 是真实当前 State（复用根节点的 sid），更早的节点 sid = null；
  //   - 末条旁白 versions > 1 → 其余版本展开成 head 的兄弟节点（expandVersions）。
  function buildLinear(story) {
    const tree = emptyTree();
    const root = makeNode({ kind: 'root', turn: 0, sealed: true });
    root.sid = internState(tree, stateOf(story), null);
    tree.nodes[root.id] = root;
    tree.root = root.id;
    tree.head = root.id;

    const log = Array.isArray(story.log) ? story.log : [];
    const messages = Array.isArray(story.messages) ? story.messages : [];

    // [user, assistant] 成对 → 回合
    const pairs = [];
    for (let i = 0; i + 1 < messages.length; i += 2) pairs.push([messages[i], messages[i + 1]]);

    // log 按行动条目切组：每个 player / choice / agent 条目开一组；首个行动之前的归「开场组」。
    // 失败回合的「走神」提示条目（versions: [] 的 narration）不是树的一部分，直接丢弃（§10）。
    const groups = [];
    let cur = null;
    for (const e of log) {
      if (!e || typeof e !== 'object') continue;
      if (e.type === 'narration' && Array.isArray(e.versions) && !e.versions.length) continue;
      const isAction = e.type === 'player' || e.type === 'choice' || e.type === 'agent';
      if (isAction || !cur) { cur = { actionEntry: isAction ? e : null, entries: [] }; groups.push(cur); }
      cur.entries.push(e);
    }

    // 从尾部对齐：末 n 组 ↔ 末 n 对；多出来的前组归根节点（不丢 log）
    const n = Math.min(groups.length, pairs.length);
    for (let g = 0; g < groups.length - n; g++) {
      for (const e of groups[g].entries) root.entries.push(e);
    }

    const m = pairs.length;
    let prev = root;
    for (let j = 0; j < m; j++) {
      const g = (groups.length - n + j) >= 0 ? groups[groups.length - n + j] : null;
      const actEntry = g && g.actionEntry;
      const node = makeNode({
        kind: 'turn',
        parent: prev.id,
        action: normalizeAction({
          type: actEntry ? actEntry.type : (j === 0 ? 'opening' : 'player'),
          text: actEntry ? actEntry.text : '',
          kind: actEntry ? (actEntry.kind || null) : null,
        }, pairs[j][0]),
        userMsg: pairs[j][0],
        assistantMsg: pairs[j][1],
        entries: g ? g.entries : [],
        sealed: true,
        // 旧档没有逐节点 turn：按现值倒推（turn 越早越小）
        turn: Math.max(1, (+story.turn || m) - (m - 1 - j)),
      });
      node.scenes = scenesFor(story, node.entries);
      for (const e of node.entries) if (e && e.type === 'narration') e.nid = node.id;
      tree.nodes[node.id] = node;
      prev.children.push(node.id);
      prev.active = node.id;
      prev = node;
    }

    tree.head = prev.id;

    // 只有 head 的 sid 是真实当前 State（与根节点同一份）；更早的节点状态未知
    const turnNodes = pathNodes(tree, tree.head).filter(x => x.kind === 'turn');
    for (let j = 0; j < turnNodes.length; j++) {
      turnNodes[j].sid = (j === turnNodes.length - 1) ? root.sid : null;
    }

    // 窗口：head 按 §3 的成对规则算；更早的节点记 0（旧档的链就等于现存窗口，历史窗口已不可考）
    const head = tree.nodes[tree.head];
    if (head.kind === 'turn') {
      const w = computeWindow(tree, head, messages);
      head.msgFloor = 0;
      head.msgSnap = w.msgSnap;
    } else {
      root.msgFloor = 0;
      root.msgSnap = messages.length ? clone(messages) : null;
    }
    for (const id of Object.keys(tree.nodes)) {
      const nd = tree.nodes[id];
      if (nd !== head && nd.kind === 'turn') nd.msgFloor = 0;
    }
    expandVersions(tree);      // §6：末条旁白 versions>1 展开成兄弟（须在窗口算完之后）
    return tree;
  }

  // §6：末条旁白 versions > 1 → 把其余版本展开成 head 的兄弟节点（旧版本栈退役）。
  // 兄弟是**近似**节点：同 action、assistantMsg 只有 {narration}、标 meta.approx、sid 复用 head 的；
  // 兄弟序 = 版本序，activeVersion 那一版留在链上当 head。只有迁移（buildLinear）会走到这里。
  function expandVersions(tree) {
    const head = tree.nodes[tree.head];
    if (!head || head.kind !== 'turn' || !head.parent || !tree.nodes[head.parent]) return;
    let entry = null;
    for (let i = head.entries.length - 1; i >= 0; i--) {
      const e = head.entries[i];
      if (e && e.type === 'narration') { entry = e; break; }
    }
    const vs = entry && Array.isArray(entry.versions) ? entry.versions.filter(v => typeof v === 'string') : [];
    if (vs.length < 2) return;
    let av = (entry.activeVersion == null) ? vs.length - 1 : +entry.activeVersion;
    if (!(av >= 0 && av < vs.length)) av = vs.length - 1;

    const parent = tree.nodes[head.parent];
    const actEntry = head.entries.find(e => e && (e.type === 'player' || e.type === 'choice' || e.type === 'agent')) || null;
    const ordered = [];
    for (let i = 0; i < vs.length; i++) {
      if (i === av) { ordered.push(head.id); continue; }   // activeVersion 决定哪个是 head
      const sib = makeNode({
        kind: 'turn', parent: parent.id,
        action: clone(head.action),
        userMsg: head.userMsg || null,                       // 同一条玩家行动（与 retryLast 复用 userMsg 同口径）
        assistantMsg: { role: 'assistant', content: JSON.stringify({ narration: vs[i] }) },
        sealed: true, turn: head.turn, ts: head.ts,
        meta: { approx: true },
      });
      sib.sid = head.sid;                                    // sid 复用 head 的（状态无从分辨版本）
      if (actEntry) sib.entries.push(clone(actEntry));       // 该版旁白是近似的，行动条目克隆一份各自持有
      sib.entries.push({ type: 'narration', text: vs[i], versions: [vs[i]], activeVersion: 0, ts: entry.ts || head.ts, nid: sib.id });
      if (head.msgSnap) {
        // 窗口退化快照的近似：末条 assistant 换成本版，其余不动
        sib.msgSnap = head.msgSnap.map((m, k) =>
          (k === head.msgSnap.length - 1 && sameMsg(m, head.assistantMsg)) ? sib.assistantMsg : m);
      }
      tree.nodes[sib.id] = sib;
      ordered.push(sib.id);
    }
    parent.children = ordered;
    parent.active = head.id;
  }

  // §6：旧存档点（无 nodeId）用 sp.turn 对应到链上同 turn 的节点；对不上就保持无 nodeId。
  // 幂等：只补缺失的 nodeId，已有的与补不上的都不动。
  function mapSavepoints(story, tree) {
    const sps = Array.isArray(story.savepoints) ? story.savepoints : null;
    if (!sps || !sps.length || !tree || !tree.nodes) return;
    const chain = pathNodes(tree, tree.head);
    for (const sp of sps) {
      if (!sp || typeof sp !== 'object' || sp.nodeId) continue;
      const turn = +sp.turn;
      if (!(turn >= 0)) continue;
      const hit = chain.find(n => +n.turn === turn);
      if (hit) sp.nodeId = hit.id;
    }
  }

  function ensure(story: Story) {
    if (!story || typeof story !== 'object') return null;
    const t = story.tree;
    if (t && t.v === TREE_V && t.nodes && t.nodes[t.root] && t.nodes[t.head]) {
      if (!t.states || typeof t.states !== 'object') t.states = {};
      mapSavepoints(story, t);        // §6：旧存档点 sp.turn → nodeId（只补缺失，幂等）
      return t;                       // 合法树直接用（幂等）
    }
    if (t) console.warn('IR.Tree：story.tree 不合法，降级重建线性链（当前 log / messages 不丢）');
    story.tree = buildLinear(story);
    mapSavepoints(story, story.tree);
    return story.tree;
  }

  /* ---------------- 回合生命周期（§4.1） ---------------- */

  // 回合开始：记下 logMark（必须在 pushLog(player) 之前调）
  function begin(story: Story) {
    ensure(story);
    return { logMark: (story.log || []).length };
  }

  // 回合成功：落一个 turn 节点（parent = 当前 head），head 前移。
  // UI-4 §2.1：head 停在非叶子节点（switchTo 回到历史位置后再发送）时同样以它为 parent——
  // 新节点追加到该节点 children 末尾并更新 parent.active，天然产生一条新分支（测试固定）。
  function commit(story: Story, opts) {
    opts = opts || {};
    const tree = ensure(story);
    if (typeof opts.logMark !== 'number') throw new Error('Tree.commit：缺少 logMark（先调 Tree.begin）');
    const parent = tree.nodes[tree.head];
    const entries = (story.log || []).slice(opts.logMark);
    const node = makeNode({
      kind: 'turn',
      parent: parent.id,
      action: normalizeAction(opts.action, opts.userMsg),
      userMsg: opts.userMsg || null,
      assistantMsg: opts.assistantMsg || null,
      entries: entries,
      sealed: false,
      turn: +story.turn || 0,
      meta: opts.meta || {},   // UI-3 §3.3：meta.model 记本回合模型名（无密钥 / URL）
    });
    node.scenes = scenesFor(story, node.entries);
    // narration 条目写上 nid：UI 靠它找兄弟（§4.1）
    for (const e of node.entries) if (e && e.type === 'narration') e.nid = node.id;
    tree.nodes[node.id] = node;
    parent.children.push(node.id);
    parent.active = node.id;
    tree.head = node.id;
    return node;
  }

  // 回合结算后封存（必须在 postTurn 之后：书记员 / 压缩会改 world / summaries / messages，
  // 并往 log 追加 tool 条目——先 seal 会存到「半结算」状态，§10）
  function seal(story: Story, nodeId) {
    const tree = ensure(story);
    const node = tree.nodes[nodeId];
    if (!node) { console.warn('IR.Tree.seal：节点不存在', nodeId); return null; }
    if (node.sealed) return node;      // 幂等

    // entries / scenes 再切一遍片：收进 postTurn 追加的 tool 条目与迟到的图（§4.1）
    const from = node.entries.length ? (story.log || []).indexOf(node.entries[0]) : -1;
    if (from >= 0) node.entries = story.log.slice(from);
    node.scenes = scenesFor(story, node.entries);
    for (const e of node.entries) if (e && e.type === 'narration' && e.nid == null) e.nid = node.id;

    node.turn = +story.turn || node.turn;

    const w = computeWindow(tree, node, story.messages || []);
    node.msgFloor = w.msgFloor;
    node.msgSnap = w.msgSnap;

    node.sid = internState(tree, stateOf(story), node.parent ? tree.nodes[node.parent].sid : null);
    node.sealed = true;
    return node;
  }

  /* ---------------- 投影（§3）：树是真源，其余都是派生物 ---------------- */

  // 手改世界卡 / 摘要栈等「派生数据」后调用：把 head 的内联状态换成当前值。
  // 否则下一次 project（进入故事 / 切分支）会用旧快照把手改回滚掉。
  function resyncState(story: Story) {
    const tree = ensure(story);
    const head = tree.nodes[tree.head];
    if (!head) return null;
    head.sid = internState(tree, stateOf(story), head.parent ? tree.nodes[head.parent].sid : null);
    return head.sid;
  }

  function project(story: Story) {
    const tree = ensure(story);
    const path = pathNodes(tree, tree.head);
    const head = tree.nodes[tree.head];

    // log = 路径 entries 依次拼接，取末 120（引用共享，不 clone）
    let log = [];
    for (const n of path) if (n.entries && n.entries.length) log = log.concat(n.entries);
    story.log = log.slice(-LOG_WINDOW);

    // messages = 从 msgFloor 个 turn 节点起展开 [userMsg, assistantMsg]；msgSnap 优先。
    // 消息对象按引用共享（就地修改落在树上），但数组本身是新的——
    // 后续 push / splice（比如回合进行中往窗口里加消息）不会污染树上的快照。
    if (head.msgSnap) {
      story.messages = (head.msgSnap as any).slice();
    } else {
      const turns = path.filter(n => n.kind === 'turn');
      const floor = Math.max(0, Math.min(turns.length, +head.msgFloor || 0));
      const msgs = [];
      for (let i = floor; i < turns.length; i++) {
        if (turns[i].userMsg) msgs.push(turns[i].userMsg);
        if (turns[i].assistantMsg) msgs.push(turns[i].assistantMsg);
      }
      story.messages = msgs;
    }

    // scenes = 路径节点 scenes 依次拼接，取末 12（与 serializeStory 同口径；src 还原走加载图片的那条路）
    let scenes = [];
    for (const n of path) if (n.scenes && n.scenes.length) scenes = scenes.concat(n.scenes);
    story.scenes = scenes.slice(-SCENE_WINDOW);

    story.turn = +head.turn || 0;

    // State：sid === null（迁移来的旧节点，状态未知）→ 保持当前值不动（§6）
    const st = (head.sid != null && tree.states) ? tree.states[head.sid] : null;
    if (st) {
      story.world = clone(st.world);
      story.summaries = clone(st.summaries);
      story.rollingStyle = clone(st.rollingStyle);
      story.painterThread = clone(st.painterThread);
      story.lastSceneSummary = st.lastSceneSummary || '';
      story.lastBg = st.lastBg || null;
    }
    return story;
  }

  function pathOf(story: Story, nodeId) {
    const tree = ensure(story);
    return pathNodes(tree, nodeId).map(n => n.id);
  }

  /* ---------------- 兄弟切换（§4.3） ---------------- */

  // 沿 active 一路下探到叶子；没有 active（或指向已删的孩子）就取最后一个孩子
  function descend(tree, nodeId) {
    let n = tree.nodes[nodeId] || null;
    const seen = new Set();
    while (n && n.children && n.children.length && !seen.has(n.id)) {
      seen.add(n.id);
      const kids = n.children.filter(id => tree.nodes[id]);
      if (!kids.length) break;
      const nextId = (n.active && kids.indexOf(n.active) >= 0) ? n.active : kids[kids.length - 1];
      n = tree.nodes[nextId] || null;
    }
    return n;
  }

  function isOnPath(tree, nodeId) {
    return pathNodes(tree, tree.head).some(n => n.id === nodeId);
  }

  // 某节点的兄弟 id 列表（含自身，按创建序 = children 下标序）；根节点没有兄弟
  function siblings(story: Story, nodeId) {
    const tree = ensure(story);
    const node = tree.nodes[nodeId];
    if (!node) return [];
    if (!node.parent || !tree.nodes[node.parent]) return [node.id];
    return (tree.nodes[node.parent].children || []).slice();
  }

  // dir = -1 | +1：切到相邻兄弟，parent.active 记住它，再沿 active 下探到叶子（§4.3）。
  // 越界 / 根节点 / 未知节点 → 返回 null 且完全不动；成功返回新的 head 节点。
  function switchSibling(story: Story, nodeId, dir) {
    const tree = ensure(story);
    const node = tree.nodes[nodeId];
    if (!node || !node.parent || !tree.nodes[node.parent]) return null;
    const parent = tree.nodes[node.parent];
    const idx = (parent.children || []).indexOf(node.id);
    const to = idx + (dir < 0 ? -1 : 1);
    if (idx < 0 || to < 0 || to >= (parent.children || []).length) return null;
    const sib = tree.nodes[parent.children[to]];
    parent.active = sib.id;
    const head = descend(tree, sib.id);
    tree.head = head.id;
    project(story);
    return head;
  }

  // 直接落到某节点（存档点回档，§4.6）：head + 投影，并把路径上的 active 记忆对齐到目标——
  // 回到哪条支线，active 就指哪条；之后再切兄弟回来，落在当前所在的位置。
  function switchTo(story: Story, nodeId) {
    const tree = ensure(story);
    const node = tree.nodes[nodeId];
    if (!node) return null;
    const path = pathNodes(tree, node.id);
    for (let i = 0; i < path.length - 1; i++) path[i].active = path[i + 1].id;
    tree.head = node.id;
    project(story);
    return node;
  }

  /* ---------------- UI-4 §2：任意节点继续 / 分叉 ---------------- */

  // §2.2：沿 active 下探到叶子（descend 的公开版本，纯读不改）；无 active 时取最后一个孩子
  function latestLeaf(story: Story, nodeId) {
    const tree = story && story.tree;
    if (!tree || !tree.nodes) return null;
    return descend(tree, nodeId == null ? tree.head : nodeId);
  }

  // §2.3：站在「这一回合发生之前」= 把 head 落到 node.parent，供「改我说的」预填原话后分叉。
  // 根节点（没有 parent）与开局节点（action.type === 'opening'）不可改写 → { ok:false, reason }。
  function forkBefore(story: Story, nodeId) {
    const tree = ensure(story);
    const node = tree && tree.nodes[nodeId];
    if (!node) return { ok: false, reason: '节点不存在' };
    if (!node.parent || !tree.nodes[node.parent]) return { ok: false, reason: '开局之前没有可分叉的位置' };
    if (node.action && node.action.type === 'opening') return { ok: false, reason: '开局回合不能改写' };
    switchTo(story, node.parent);
    const a = normalizeAction(node.action, node.userMsg);
    return {
      ok: true,
      action: {
        type: (node.action && node.action.type) || 'player',
        text: a.text, kind: a.kind, sent: a.sent,
      },
    };
  }

  // §2.4（纯函数）：sid === null（旧档迁移来的早期回合，状态未知）→ 只能看，不能落到这里继续。
  // project 对 sid === null 会保持当前状态不动，落到这种节点世界卡 / 摘要就是错的（§9）。
  // 兼容两种调用：canResume(story, nodeId) / canResume(node)。
  function canResume(story: any, nodeId?) {
    let node = null;
    if (story && typeof story === 'object') {
      if (nodeId == null && story.kind && Array.isArray(story.children)) node = story;
      else if (story.tree && story.tree.nodes) node = story.tree.nodes[nodeId] || null;
    }
    return !!(node && node.sid != null);
  }

  /* ---------------- 晚到的条目 / 画面（§4.4） ---------------- */

  // entry（有 type）→ node.entries；scene（无 type）→ node.scenes（收成不含 src 的同口径形状）。
  // 节点在当前路径上 → 同一个对象插进 story.log / story.scenes 里该节点末条**之后**
  //（不是追加到末尾，否则回合顺序错乱）；不在路径上 → 只写节点，不得泄漏进当前投影。
  // 节点不存在 → 丢弃，返回 false。
  function pushLate(story: Story, nodeId, item) {
    const tree = ensure(story);
    const node = tree.nodes[nodeId];
    if (!node || !item || typeof item !== 'object') return false;
    const isEntry = typeof item.type === 'string';
    const onPath = isOnPath(tree, node.id);

    if (isEntry) {
      const anchor = node.entries.length ? node.entries[node.entries.length - 1] : null;
      if (item.type === 'narration' && item.nid == null) item.nid = node.id;
      node.entries.push(item);
      if (onPath) {
        const log = Array.isArray(story.log) ? story.log : (story.log = []);
        const at = anchor ? log.indexOf(anchor) : -1;
        if (at >= 0) log.splice(at + 1, 0, item);
        else log.push(item);
      }
    } else {
      const meta = sceneMetaOf(item);
      const anchor = node.scenes.length ? node.scenes[node.scenes.length - 1] : null;
      node.scenes.push(meta);
      if (onPath) {
        const scenes = Array.isArray(story.scenes) ? story.scenes : (story.scenes = []);
        const at = anchor ? scenes.indexOf(anchor) : -1;
        if (at >= 0) scenes.splice(at + 1, 0, meta);
        else scenes.push(meta);
      }
    }
    return true;
  }

  /* ---------------- 全树图集（§5：清理孤儿 / 删除 / 备份用） ---------------- */

  // tree.nodes[*].scenes 与 entries 里的 imageId 都算进去（含非当前分支），去重后返回。
  // 漏掉树内引用就会**静默删掉别的分支的图**（§10）。
  function imageIdsOf(tree: StoryTree | null): string[] {
    const out = [];
    const seen = new Set();
    const add = id => { if (id && !seen.has(id)) { seen.add(id); out.push(id); } };
    if (!tree || typeof tree !== 'object' || !tree.nodes) return out;
    for (const id of Object.keys(tree.nodes)) {
      const n = tree.nodes[id];
      if (!n) continue;
      for (const s of (n.scenes || [])) if (s) { add(s.imageId); add(s.videoId); }
      for (const e of (n.entries || [])) if (e) { add((e as any).imageId); add((e as any).videoId); }
    }
    return out;
  }

  const __irApi = {
    // IR 根级纯工具（零依赖、全模块可引用）：genId / clone / sleep / plainReply 的唯一口径
    genId: genId,
    clone: clone,
    sleep: sleep,
    plainReply: plainReply,
    Tree: {
      TREE_V, LOG_WINDOW, SCENE_WINDOW, SAVEPOINT_KEEP,
      ensure, begin, commit, seal, project, pathOf, resyncState,
      siblings, switchSibling, switchTo, latestLeaf, forkBefore, canResume,
      pushLate, imageIdsOf,
    },
  };
  registerIR(__irApi);
  export { genId, clone, sleep, plainReply };
  export const { Tree } = __irApi;