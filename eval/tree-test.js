#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 分支树数据层测试（js/tree.js，任务书 §2 / §3）
 *
 * 不开浏览器、不联网：只测树数据模型与投影，外加 store 集成（序列化 / 图集）——
 *   1. ensure：空档建根、幂等、损坏树降级重建；
 *   2. 线性提交 5 回合：project 出的 log / messages / world / summaries 与手工期望一致；
 *   3. 条目与消息对象按引用共享（就地修改落在树上），State 是 clone；
 *   4. states 去重：state 与父节点相同复用 sid，变了才开新 sid；
 *   5. msgFloor：压缩（messages 被吃掉前几对）后 seal，切兄弟再切回，窗口逐条相同；
 *   6. msgSnap 退化：messages 奇数条 / 对不齐 → 整窗口快照，project 逐条还原；
 *   7. 深分支：project 到祖先 / 后代，log / messages / turn 随之回退；
 *   8. 迁移：无树旧档 → 线性链、head 状态 = 当前、走神条目不进树、幂等；
 *   9. 失败回合：begin 后不 commit，树不变；
 *  10. 序列化往返：JSON 往返 → ensure → project，内容一致、引用重建；
 *  11. switchSibling：重试出兄弟后往返切换，world / log / messages 各自还原（用例 2）；
 *  12. 深分支：切兄弟沿 active 下探到叶子，切回停在「续写过的那条线」末端（用例 4）；
 *  13. pushLate：在路径上插到该节点末条之后；不在路径上只写节点、不泄漏（用例 5）；
 *  14. imageIdsOf：找得到非当前分支节点里的图（用例 8）；
 *  15. siblings / switchSibling 边界：单孩子、越界、根节点、未知节点无副作用（用例 10）；
 *  16. switchTo：存档点回档落点 + active 记忆对齐（§4.6 树侧）；
 *  17. store 集成：SCHEMA=3、migrateStory 透传 tree、serializeStory 不裁树、
 *      saveStory / loadStory 往返、imageIdsOf / knownImageIds 计入全树图集（用例 7 / 8）；
 *  18. 迁移补测（用例 6）：末条旁白 versions>1 展开成兄弟（meta.approx）、
 *      旧存档点 sp.turn → nodeId 映射、幂等（连跑两次深相等）。
 *  19. UI-4 §8 增补：站在非叶子继续 = 新分支（commit 以 head 为 parent）、
 *      forkBefore / latestLeaf / canResume、历史位置发送的完整序列投影无旧分支泄漏。
 *
 * 用法：node eval/tree-test.js
 */
const path = require('path');

global.window = global;
const core = f => require(path.join(__dirname, '..', 'src', 'core', f + '.ts'));

const T = core('tree').Tree;
const S = core('store').Store;
if (!T) {
  console.error('加载失败：Tree 导出缺失');
  process.exit(1);
}
if (!S) {
  console.error('加载失败：Store 导出缺失');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* ---------------- 测试脚手架（模拟 app.js 的一回合编排，§4.1） ---------------- */

function newStory() {
  return {
    schema: 2, id: 'test-story', title: '测试', premise: '在雨夜的车站。',
    mode: 'choice',
    log: [], messages: [], scenes: [],
    world: { place: '车站', time: '雨夜', characters: [], threads: [], relationship: { stage: '', bonds: [], notes: '' }, scene: '', updatedAt: 0, scribeAt: 0 },
    summaries: [], rollingStyle: { style: '', scenes: '', wardrobe: '', updatedAt: 0 },
    painterThread: [], savepoints: [],
    lastBg: null, lastSceneSummary: '', turn: 0,
  };
}

// 完整走一个回合：begin → pushLog(player) → 归档 → commit → (postTurn 追加) → seal
function playTurn(story, o) {
  o = o || {};
  const mark = T.begin(story);
  story.log.push({ type: o.actionType || 'player', text: o.text, kind: o.kind || 'do', ts: 1 });
  const um = { role: 'user', content: (o.premise ? '[设定]' + story.premise + '\n\n' : '') + '[玩家行动]' + (o.sent != null ? o.sent : '（做）' + o.text) };
  const am = { role: 'assistant', content: JSON.stringify({ 旁白: o.narration, 选项: o.choices || [] }) };
  story.turn += 1;
  story.log.push({ type: 'narration', text: o.narration, versions: [o.narration], activeVersion: 0, ts: 2 });
  story.messages.push(um, am);
  if (o.world) Object.assign(story.world, o.world);
  if (o.summariesPush) story.summaries.push(o.summariesPush);
  const node = T.commit(story, {
    action: { type: o.actionType || 'player', text: o.text, kind: o.kind || 'do', sent: o.sent != null ? o.sent : '（做）' + o.text },
    userMsg: um, assistantMsg: am, logMark: mark.logMark,
  });
  // postTurn 会往 log 追加 tool 条目、可能压缩 messages（seal 必须在这之后）
  if (o.toolEntry) story.log.push({ type: 'tool', tool: 'compress', summary: '压入摘要栈', ts: 3 });
  if (o.dropMessagePairs) story.messages = story.messages.slice(o.dropMessagePairs * 2);
  if (o.appendOddMessage) story.messages.push({ role: 'user', content: '（孤立的半句话' });
  T.seal(story, node.id);
  return node;
}

// 模拟「重试出兄弟」：回到父节点下再走一回合（app.js 的 retryLast 会先 project 到父节点）
function retryTurn(story, o) {
  const head = story.tree.nodes[story.tree.head];
  story.tree.head = head.parent;
  T.project(story);
  return playTurn(story, o);
}

// 模拟兄弟切换（switchSibling 的核心：改 head + project）
function headTo(story, nodeId) {
  story.tree.head = nodeId;
  T.project(story);
}

/* ---------------- 用例 ---------------- */

// 1. ensure：空档建根、幂等
{
  const s = newStory();
  const t1 = T.ensure(s);
  check('ensure：空档只建一个根节点', t1 && t1.root === t1.head && Object.keys(t1.nodes).length === 1);
  check('ensure：根节点 kind=root、sealed、有初始 State', (() => {
    const r = t1.nodes[t1.root];
    return r.kind === 'root' && r.sealed === true && r.sid != null && !!t1.states[r.sid];
  })());
  const before = JSON.stringify(s.tree);
  T.ensure(s);
  T.ensure(s);
  check('ensure：幂等（连跑两次树不变）', JSON.stringify(s.tree) === before);
}

// 1b. ensure：损坏树降级重建，不抛错、不丢 log
{
  const s = newStory();
  playTurn(s, { text: '走进车站', narration: '雨声里，你推开了车站的门。', world: { place: '车站大厅' } });
  s.tree = { v: 1, root: 'nope', head: 'nope', nodes: {}, states: {} };
  let threw = false;
  let t = null;
  try { t = T.ensure(s); } catch (_) { threw = true; }
  check('ensure：损坏树降级重建线性链且不抛错', !threw && t && !!t.nodes[t.head] && t.nodes[t.head].kind === 'turn');
  check('ensure：降级后 log 不丢', s.log.length === 2, s.log.length);
  check('ensure：降级后重建出 turn 节点', Object.keys(t.nodes).length === 2, Object.keys(t.nodes).length);
}

// 2. 线性 5 回合：project 与手工期望逐项一致
{
  const s = newStory();
  const narr = [];
  for (let i = 1; i <= 5; i++) {
    narr.push('第 ' + i + ' 幕旁白');
    playTurn(s, {
      text: '行动 ' + i,
      narration: '第 ' + i + ' 幕旁白',
      world: { time: '第 ' + i + ' 天' },
      summariesPush: i % 2 === 0 ? '第 ' + i + ' 幕摘要' : null,
    });
  }
  T.project(s);
  const wantLogTexts = [];
  for (let i = 1; i <= 5; i++) wantLogTexts.push('行动 ' + i, '第 ' + i + ' 幕旁白');
  check('project：log = 各回合条目按序拼接', eq(s.log.map(e => e.text), wantLogTexts), JSON.stringify(s.log.map(e => e.text)));
  check('project：messages = 5 对 [user, assistant]', s.messages.length === 10 && s.messages[0].role === 'user' && s.messages[9].role === 'assistant');
  check('project：messages 内容 = 期望', s.messages[0].content === '[玩家行动]（做）行动 1' && JSON.parse(s.messages[9].content).旁白 === '第 5 幕旁白');
  check('project：world = head 结算后的 State', s.world.time === '第 5 天' && s.world.place === '车站');
  check('project：summaries = 期望', eq(s.summaries, ['第 2 幕摘要', '第 4 幕摘要']), JSON.stringify(s.summaries));
  check('project：turn = head.turn', s.turn === 5);
}

// 3. 引用共享：条目 / 消息就地修改落在树上；State 是 clone
{
  const s = newStory();
  playTurn(s, { text: '行动', narration: '旁白', world: { time: '第一天' } });
  T.project(s);
  const tree = s.tree;
  const head = tree.nodes[tree.head];
  check('project：log 条目与 node.entries 同一对象', s.log[0] === head.entries[0] && s.log[1] === head.entries[1]);
  check('project：messages 与 node.userMsg/assistantMsg 同一对象', s.messages[0] === head.userMsg && s.messages[1] === head.assistantMsg);
  s.log[1].text = '改过的旁白';
  s.messages[1].content = JSON.stringify({ 旁白: '改过的回包' });
  check('共享：改 log / message 就地落在树上', head.entries[1].text === '改过的旁白' && head.assistantMsg.content === JSON.stringify({ 旁白: '改过的回包' }));
  s.world.time = '第 N 天';
  const st = tree.states[head.sid];
  check('State 是 clone：改 story.world 不影响 states 池', st.world.time === '第一天', st.world.time);
}

// 4. states 去重：与父节点 state 相同 → 复用 sid
{
  const s = newStory();
  const n1 = playTurn(s, { text: 'a', narration: 'n1' });
  const n2 = playTurn(s, { text: 'b', narration: 'n2' });          // 没动 state
  const n3 = playTurn(s, { text: 'c', narration: 'n3', world: { time: '第二天' } });  // 动了 world
  const root = s.tree.nodes[s.tree.root];
  check('去重：state 未变的回合复用父节点 sid', n1.sid === root.sid && n2.sid === n1.sid);
  check('去重：state 变了才开新 sid', n3.sid !== n2.sid);
  check('去重：states 池条数 = 根 + 1', Object.keys(s.tree.states).length === 2, Object.keys(s.tree.states).length);
}

// 5. msgFloor：压缩后 seal；重试出兄弟，来回切换窗口逐条相同
{
  const s = newStory();
  playTurn(s, { text: '行动 1', narration: '第 1 幕旁白' });
  playTurn(s, { text: '行动 2', narration: '第 2 幕旁白' });
  playTurn(s, { text: '行动 3', narration: '第 3 幕旁白', dropMessagePairs: 2 });  // 模拟 compressStory 吃掉前 2 对
  const headA = s.tree.nodes[s.tree.head];
  check('msgFloor：窗口 = 末 1 对时 floor = 2', headA.msgFloor === 2 && headA.msgSnap === null, headA.msgFloor);

  // 在第 3 回合重试 → 兄弟（同父），seal 时窗口里是「前 2 对 + 新一对」？
  // 不——重试会先 project 回父节点，窗口回到「第 3 回合之前」= 末 2 对
  const msgsBefore = s.messages.slice();
  const sib = retryTurn(s, { text: '行动 3', narration: '第 3 幕旁白（另一次发展）', dropMessagePairs: 0 });
  check('重试出兄弟：同 parent、children = 2', sib.parent === headA.parent && s.tree.nodes[sib.parent].children.length === 2);
  const msgsSib = s.messages.slice();
  headTo(s, headA.id);
  check('切回原分支：messages 与切换前逐条相同', eq(s.messages, msgsBefore), JSON.stringify(s.messages));
  headTo(s, sib.id);
  check('切到兄弟：messages 与该分支 seal 后一致', eq(s.messages, msgsSib));
  headTo(s, headA.id);
  check('再切回：仍是逐条相同', eq(s.messages, msgsBefore));
  check('切换不改变树的节点数', Object.keys(s.tree.nodes).length === 5);
}

// 6. msgSnap 退化：奇数 messages → 整窗口快照
{
  const s = newStory();
  playTurn(s, { text: '行动 1', narration: '第 1 幕旁白' });
  playTurn(s, { text: '行动 2', narration: '第 2 幕旁白', appendOddMessage: true });   // 窗口末尾挂一条不成对消息
  const head = s.tree.nodes[s.tree.head];
  check('msgSnap：messages 奇数条 → 存整窗口快照', head.msgSnap != null && head.msgSnap.length === 5, head.msgSnap && head.msgSnap.length);
  const before = s.messages.slice();
  const root = s.tree.nodes[s.tree.root];
  headTo(s, root.id);
  check('msgSnap：切走后窗口变空（根节点无消息）', s.messages.length === 0);
  headTo(s, head.id);
  check('msgSnap：切回后窗口逐条相同（含孤立消息）', eq(s.messages, before), JSON.stringify(s.messages));
}

// 7. 深分支：project 到祖先 / 后代随 active 下探语义（本期用 head 直接指定验证投影）
{
  const s = newStory();
  const n1 = playTurn(s, { text: '行动 1', narration: '第 1 幕旁白', world: { time: '第一天' } });
  const n2 = playTurn(s, { text: '行动 2', narration: '第 2 幕旁白', world: { time: '第二天' } });
  const n3 = playTurn(s, { text: '行动 3', narration: '第 3 幕旁白', world: { time: '第三天' } });
  headTo(s, n1.id);
  check('project 到祖先：log / turn 回退', s.log.length === 2 && s.turn === 1, s.log.length + '/' + s.turn);
  check('project 到祖先：world 回退到该节点状态', s.world.time === '第一天', s.world.time);
  check('project 到祖先：messages 只剩该节点前的窗口', s.messages.length === 2 && JSON.parse(s.messages[1].content).旁白 === '第 1 幕旁白');
  headTo(s, n3.id);
  check('project 回叶子：全部恢复', s.log.length === 6 && s.turn === 3 && s.world.time === '第三天' && s.messages.length === 6);
  check('active 记忆：祖先的 active 仍指向下探方向', s.tree.nodes[s.tree.root].active === n1.id && s.tree.nodes[n2.id].active === n3.id);
}

// 8. 迁移：无树旧档 → 线性链（幂等、不丢 log、走神条目不进树）
{
  const s = newStory();
  s.premise = '在雨夜的车站。';
  s.log = [
    { type: 'player', text: '行动 1', kind: 'do', ts: 1 },
    { type: 'narration', text: '第 1 幕旁白', versions: ['第 1 幕旁白'], activeVersion: 0, ts: 2 },
    { type: 'player', text: '行动 2', kind: 'say', ts: 3 },
    { type: 'narration', text: '第 2 幕旁白', versions: ['第 2 幕旁白'], activeVersion: 0, ts: 4 },
    { type: 'narration', text: '（AI 走神了，点「↻ 重试」或再试一次吧。）', versions: [], ts: 5 },  // 失败回合尾巴
  ];
  s.messages = [
    { role: 'user', content: '[设定]' + s.premise + '\n\n[玩家行动]（做）行动 1' },
    { role: 'assistant', content: JSON.stringify({ 旁白: '第 1 幕旁白' }) },
    { role: 'user', content: '[玩家行动]（说）行动 2' },
    { role: 'assistant', content: JSON.stringify({ 旁白: '第 2 幕旁白' }) },
  ];
  s.turn = 7;
  s.world.time = '第三天';

  const t = T.ensure(s);
  const ids = T.pathOf(s, t.head);
  check('迁移：链 = 根 + 2 个 turn 节点', ids.length === 3 && t.nodes[t.root].kind === 'root', ids.length);
  check('迁移：head = 最后一个 turn 节点', t.nodes[t.head].kind === 'turn');
  check('迁移：head.sid = 当前 State（= 根节点那份）', t.nodes[t.head].sid === t.nodes[t.root].sid && t.states[t.nodes[t.head].sid].world.time === '第三天');
  check('迁移：更早的 turn 节点 sid = null', t.nodes[ids[1]].sid === null);
  check('迁移：走神条目不进树', Object.values(t.nodes).every(n => n.entries.every(e => !(e.type === 'narration' && Array.isArray(e.versions) && !e.versions.length))));
  check('迁移：turn 从现值倒推', t.nodes[ids[1]].turn === 6 && t.nodes[ids[2]].turn === 7);
  check('迁移：action 还原（sent 带标记 / kind 来自标记）', (() => {
    const a = t.nodes[ids[2]].action;
    return a.type === 'player' && a.text === '行动 2' && a.kind === 'say' && a.sent === '（说）行动 2';
  })(), JSON.stringify(t.nodes[ids[2]].action));
  check('迁移：narration 条目带上 nid', s.log[1].nid === ids[1] && s.log[3].nid === ids[2]);

  T.project(s);
  check('迁移后 project：messages 与原窗口逐条相同', s.messages.length === 4 && JSON.parse(s.messages[1].content).旁白 === '第 1 幕旁白');
  check('迁移后 project：log 只丢走神条目', s.log.length === 4 && s.log[0].text === '行动 1', s.log.length);

  const before = JSON.stringify(s.tree);
  T.ensure(s);
  T.ensure(s);
  check('迁移：幂等（再跑两次树深相等）', JSON.stringify(s.tree) === before);
}

// 9. 失败回合：begin 后不 commit，树不变、没有悬挂节点
{
  const s = newStory();
  playTurn(s, { text: '行动 1', narration: '第 1 幕旁白' });
  const before = JSON.stringify(s.tree);
  const mark = T.begin(s);
  s.log.push({ type: 'player', text: '行动 2', kind: 'do', ts: 9 });
  s.log.push({ type: 'narration', text: '（AI 走神了……）', versions: [], ts: 9 });
  // 不 commit：失败回合不产生节点
  T.project(s);
  check('失败回合：树不变', JSON.stringify(s.tree) === before);
  check('失败回合：悬挂尾巴随 project 消失', s.log.length === 2 && s.log[1].text === '第 1 幕旁白', s.log.length);
  check('失败回合：begin 不改树、logMark 记录正确', mark.logMark === 2);
}

// 10. 序列化往返：JSON 往返 → ensure → project，内容一致、引用重建
{
  const s = newStory();
  playTurn(s, { text: '行动 1', narration: '第 1 幕旁白', world: { time: '第一天' } });
  const sib = retryTurn(s, { text: '行动 1', narration: '第 1 幕旁白（另一次发展）', world: { time: '第一夜' } });
  playTurn(s, { text: '行动 2', narration: '第 2 幕旁白', dropMessagePairs: 1, toolEntry: true });

  const snap = JSON.parse(JSON.stringify(s));
  const s2 = JSON.parse(JSON.stringify(s));
  T.ensure(s2);
  T.project(s2);
  check('往返：ensure 不重建（树合法）', eq(s2.tree, snap.tree));
  check('往返：log 逐条相同', eq(s2.log, snap.log));
  check('往返：messages 逐条相同', eq(s2.messages, snap.messages));
  check('往返：world / summaries / turn 相同', eq(s2.world, snap.world) && eq(s2.summaries, snap.summaries) && s2.turn === snap.turn);
  check('往返：引用重建（log 条目 === node.entries）', (() => {
    const head = s2.tree.nodes[s2.tree.head];
    return s2.log[s2.log.length - 1] === head.entries[head.entries.length - 1];
  })());
  check('往返：兄弟分支都还在', s2.tree.nodes[sib.parent].children.length === 2);
}

// 边界：只有一个孩子时投影正常、commit 往 head 下续
{
  const s = newStory();
  playTurn(s, { text: '行动 1', narration: '第 1 幕旁白' });
  const root = s.tree.nodes[s.tree.root];
  check('边界：根节点只有一个孩子', root.children.length === 1);
  check('边界：pathOf 含两端', eq(T.pathOf(s, s.tree.head), [root.id, root.children[0]]));
}

/* ---------------- 兄弟切换 / 晚到条目 / 全树图集（§4.3 / §4.4 / §5） ---------------- */

// 11. switchSibling：重试出兄弟，world / log / messages 各自还原（用例 2）
{
  const s = newStory();
  playTurn(s, { text: '行动 1', narration: '第 1 幕旁白', world: { time: '第一天' } });
  const a = playTurn(s, { text: '行动 2', narration: 'A 版旁白', world: { place: 'A 线' } });
  const b = retryTurn(s, { text: '行动 2', narration: 'B 版旁白', world: { place: 'B 线' } });
  check('switchSibling 前：head 在 B 线', s.tree.head === b.id && s.world.place === 'B 线');
  const h1 = T.switchSibling(s, b.id, -1);
  check('switchSibling(-1)：切到兄弟 A', !!h1 && h1.id === a.id && s.tree.head === a.id);
  check('切换还原：world 回到 A 线状态', s.world.place === 'A 线' && s.world.time === '第一天', s.world.place);
  check('切换还原：log / messages 跟着换', s.log[s.log.length - 1].text === 'A 版旁白'
    && JSON.parse(s.messages[s.messages.length - 1].content).旁白 === 'A 版旁白');
  const h2 = T.switchSibling(s, a.id, +1);
  check('switchSibling(+1)：切回 B 线并还原', !!h2 && h2.id === b.id && s.world.place === 'B 线'
    && JSON.parse(s.messages[s.messages.length - 1].content).旁白 === 'B 版旁白');
  check('siblings：两兄弟含自身、按创建序', eq(T.siblings(s, a.id), [a.id, b.id]), JSON.stringify(T.siblings(s, a.id)));
}

// 12. 深分支：切兄弟沿 active 下探到叶子，切回停在「续写过的那条线」末端（用例 4）
{
  const s = newStory();
  const n1 = playTurn(s, { text: '行动 1', narration: '第 1 幕旁白' });
  const n2 = playTurn(s, { text: '行动 2', narration: '第 2 幕旁白' });
  const s2 = retryTurn(s, { text: '行动 2', narration: '第 2 幕旁白（B 线）' });  // n2 的兄弟
  const s3 = playTurn(s, { text: '行动 3', narration: '第 3 幕旁白（B 线）' });  // B 线续写
  headTo(s, n2.id);
  const n3 = playTurn(s, { text: '行动 3', narration: '第 3 幕旁白' });          // A 线续写
  check('深分支就位：head 在 A 线末端', s.tree.head === n3.id && n2.active === n3.id);

  const h1 = T.switchSibling(s, n2.id, +1);
  check('active 下探：切到兄弟后落在 B 线末端 s3，不是 s2', !!h1 && h1.id === s3.id, h1 && h1.id);
  check('active 下探：投影是 B 线第 3 幕', s.log[s.log.length - 1].text === '第 3 幕旁白（B 线）');
  const h2 = T.switchSibling(s, s2.id, -1);
  check('active 下探：切回落在 A 线叶子 n3，不是兄弟本身 n2', !!h2 && h2.id === n3.id && s.log[s.log.length - 1].text === '第 3 幕旁白');
  check('切换不动树结构', Object.keys(s.tree.nodes).length === 6 && s.tree.nodes[n1.id].children.length === 2);
}

// 13. pushLate：晚到条目 / 画面（用例 5）
{
  const s = newStory();
  const n1 = playTurn(s, { text: '行动 1', narration: '第 1 幕旁白' });
  const n2 = playTurn(s, { text: '行动 2', narration: '第 2 幕旁白' });

  // ① 在路径上：插到该节点末条之后（不是 log 末尾）
  const late = { type: 'image', id: 'sc-late1', imageId: 'img-late1', text: '迟到的图', ts: 9 };
  const ok1 = T.pushLate(s, n1.id, late);
  check('pushLate 在路径上：node.entries 收下', ok1 && n1.entries[n1.entries.length - 1] === late);
  check('pushLate 在路径上：插在该节点末条之后', s.log[2] === late && s.log.length === 5
    && s.log[3].text === '行动 2', s.log.map(e => e.text).join('|'));

  // ② 不在路径上：只写节点，不得泄漏进当前 log
  const sib = retryTurn(s, { text: '行动 2', narration: '第 2 幕旁白（B 线）' });
  const late2 = { type: 'tool', tool: 'scribe', text: '晚到的书记员条目', ts: 10 };
  T.pushLate(s, n2.id, late2);
  check('pushLate 不在路径上：进 node.entries', n2.entries[n2.entries.length - 1] === late2);
  check('pushLate 不在路径上：不泄漏进当前 log', s.log.indexOf(late2) < 0);
  T.switchSibling(s, sib.id, -1);
  check('切回该分支：晚到条目随投影出现', s.log.indexOf(late2) === s.log.length - 1
    && s.log[2] === late, s.log.map(e => e.text).join('|'));

  // ③ 画面晚到：scene 收成不含 src 的同口径形状，在路径上同步进 story.scenes
  const sc = { id: 'sc-1', alt: '雨夜车站', prompt: 'p', imageId: 'img-1', ts: 11, src: 'blob:xxx' };
  T.pushLate(s, n2.id, sc);
  const scNode = n2.scenes[n2.scenes.length - 1];
  check('pushLate scene：进 node.scenes（同口径不含 src）', !!scNode && scNode.id === 'sc-1'
    && scNode.imageId === 'img-1' && scNode.src === undefined, JSON.stringify(scNode));
  check('pushLate scene：在路径上 → 同一对象进 story.scenes', s.scenes.indexOf(scNode) >= 0);
  check('pushLate scene：不在路径上只写节点', (() => {
    const before = s.scenes.length;
    T.pushLate(s, sib.id, { id: 'sc-2', imageId: 'img-2', ts: 12 });
    return s.scenes.length === before && sib.scenes.some(x => x.id === 'sc-2') && s.scenes.every(x => x.id !== 'sc-2');
  })());
  check('pushLate：节点不存在 → 丢弃', T.pushLate(s, 'nope', late) === false);
}

// 14. imageIdsOf：非当前分支的图也在（用例 8）
{
  const s = newStory();
  playTurn(s, { text: '行动 1', narration: '第 1 幕旁白' });
  const n2 = playTurn(s, { text: '行动 2', narration: '第 2 幕旁白' });
  T.pushLate(s, n2.id, { type: 'image', id: 'scA', imageId: 'imgA', ts: 1 });
  T.pushLate(s, n2.id, { id: 'scA', imageId: 'imgA', ts: 1 });
  const sib = retryTurn(s, { text: '行动 2', narration: '第 2 幕旁白（B 线）' });
  T.pushLate(s, sib.id, { type: 'image', id: 'scB', imageId: 'imgB', ts: 2 });

  const ids = T.imageIdsOf(s.tree);
  check('imageIdsOf：含非当前分支节点里的图', ids.indexOf('imgA') >= 0 && ids.indexOf('imgB') >= 0, ids.join(','));
  check('imageIdsOf：entry 与 scene 同图只算一次', ids.filter(x => x === 'imgA').length === 1, ids.join(','));
  check('非当前分支的图不进当前投影', s.log.every(e => e.imageId !== 'imgA') && s.scenes.every(x => x.imageId !== 'imgA'));
  check('imageIdsOf：空树 / 非法入参返回空', eq(T.imageIdsOf(null), []) && eq(T.imageIdsOf({}), []));

  // §5③：videoId 同样要收（漏了会误删 / 残留视频）——含非当前分支
  T.pushLate(s, n2.id, { type: 'video', id: 'vdA', videoId: 'vid:A', ts: 3 });
  T.pushLate(s, n2.id, { id: 'vdA', videoId: 'vid:A', ts: 3 });
  T.pushLate(s, sib.id, { type: 'video', id: 'vdB', videoId: 'vid:B', ts: 4 });
  const vids = T.imageIdsOf(s.tree);
  check('imageIdsOf：含视频 videoId（含非当前分支）', vids.indexOf('vid:A') >= 0 && vids.indexOf('vid:B') >= 0, vids.join(','));
}

// 15. siblings / switchSibling 边界（用例 10）
{
  const s = newStory();
  const n1 = playTurn(s, { text: '行动 1', narration: '第 1 幕旁白' });
  check('siblings：只有一个孩子时返回长度 1', eq(T.siblings(s, n1.id), [n1.id]));
  const before = JSON.stringify(s.tree);
  const headBefore = s.tree.head;
  check('switchSibling 越界无副作用', T.switchSibling(s, n1.id, -1) === null
    && T.switchSibling(s, n1.id, +1) === null && s.tree.head === headBefore
    && JSON.stringify(s.tree) === before);
  check('switchSibling：根节点 / 未知节点不动', T.switchSibling(s, s.tree.root, +1) === null
    && T.switchSibling(s, 'nope', +1) === null && JSON.stringify(s.tree) === before);
  check('siblings：未知节点返回空', eq(T.siblings(s, 'nope'), []));
}

// 16. switchTo：存档点回档落点 + active 记忆对齐（§4.6 树侧）
{
  const s = newStory();
  const n1 = playTurn(s, { text: '行动 1', narration: '第 1 幕旁白' });
  const n2 = playTurn(s, { text: '行动 2', narration: '第 2 幕旁白', world: { place: 'A 线' } });
  const s2 = retryTurn(s, { text: '行动 2', narration: '第 2 幕旁白（B 线）', world: { place: 'B 线' } });
  const s3 = playTurn(s, { text: '行动 3', narration: '第 3 幕旁白（B 线）' });

  const h = T.switchTo(s, n2.id);
  check('switchTo：head 落到目标节点并投影', !!h && h.id === n2.id && s.tree.head === n2.id
    && s.world.place === 'A 线' && s.log.length === 4 && s.turn === 2);
  check('switchTo：active 记忆对齐到目标', s.tree.nodes[n1.id].active === n2.id
    && s.tree.nodes[s.tree.root].active === n1.id);
  check('switchTo：未知节点返回 null 不动', T.switchTo(s, 'nope') === null && s.tree.head === n2.id);

  const h2 = T.switchSibling(s, n2.id, +1);
  check('switchTo 后切兄弟：照旧落到 B 线末端', !!h2 && h2.id === s3.id);
  const h3 = T.switchSibling(s, s2.id, -1);
  check('active 对齐后切回：落在存档点节点，不是旧末端', !!h3 && h3.id === n2.id && s.world.place === 'A 线');
}

/* ---------------- store 集成（§5：SCHEMA 3 / 透传 tree / 不裁树 / 全树图集） ---------------- */

// 17. store：migrateStory 透传 tree、serializeStory 不裁树、往返、knownImageIds 计入非当前分支
{
  check('store：SCHEMA = 3、新档 schema 字段跟着升', S.SCHEMA === 3 && S.newStory({}).schema === 3);

  const s = newStory();
  s.id = 'store-int';
  const n1 = playTurn(s, { text: '行动 1', narration: '第 1 幕旁白' });
  const a = playTurn(s, { text: '行动 2', narration: 'A 版旁白', world: { place: 'A 线' } });
  const b = retryTurn(s, { text: '行动 2', narration: 'B 版旁白', world: { place: 'B 线' } });
  // 当前分支（B 线）一张图 + 非当前分支（A 线）一张图：后者不得被「清理孤儿」当成孤儿
  T.pushLate(s, b.id, { type: 'image', id: 'scB', imageId: 'imgB', ts: 1 });
  T.pushLate(s, b.id, { id: 'scB', imageId: 'imgB', ts: 1 });
  T.pushLate(s, a.id, { type: 'image', id: 'scA', imageId: 'imgA', ts: 2 });
  T.pushLate(s, a.id, { id: 'scA', imageId: 'imgA', ts: 2 });
  T.project(s);

  // ① migrateStory：tree 原样透传（不校验、不依赖 IR.Tree）；无 tree 的旧档不造字段
  const m = S.migrateStory(JSON.parse(JSON.stringify(s)));
  check('store：migrateStory 透传 raw.tree（深相等）', !!m.tree && eq(m.tree, s.tree));
  check('store：无 tree 的旧档 migrate 后仍无 tree', S.migrateStory({ id: 'x', log: [] }).tree === undefined);

  // ② serializeStory：log / scenes / savepoints 照旧裁剪，但裁剪不作用在 tree 上（用例 7）
  const s2 = JSON.parse(JSON.stringify(s));
  for (let i = 0; i < 130; i++) s2.log.push({ type: 'tool', tool: 'pad', text: '填充 ' + i, ts: i });
  for (let i = 0; i < 14; i++) s2.scenes.push({ id: 'pad-sc-' + i, ts: i });
  for (let i = 0; i < 7; i++) s2.savepoints.push({ id: 'sp-' + i, turn: i });
  const raw = S.serializeStory(s2);
  check('serializeStory：log / scenes / savepoints 照旧裁剪',
    raw.log.length === 120 && raw.scenes.length === 12 && raw.savepoints.length === 5,
    raw.log.length + '/' + raw.scenes.length + '/' + raw.savepoints.length);
  check('serializeStory：裁剪不作用在 tree 上，且落盘深拷贝（不与在用 story 共享引用）',
    raw.tree !== s2.tree && eq(raw.tree, s2.tree));

  // ③ saveStory → loadStory 往返：tree 完好，ensure 不重建，project 还原投影
  S.saveStory(s);
  const l = S.loadStory(s.id);
  check('store 往返：loadStory 带回 tree（深相等）', !!l.tree && eq(l.tree, s.tree));
  check('store 往返：ensure 不重建（树合法）', T.ensure(l) === l.tree && eq(l.tree, s.tree));
  T.project(l);
  check('store 往返：project 后 log / world / scenes 与原档一致',
    eq(l.log, s.log) && eq(l.world, s.world) && eq(l.scenes, s.scenes));
  check('store 往返：兄弟分支还在，非当前分支的图不进投影',
    l.tree.nodes[a.parent].children.length === 2 && l.log.every(e => e.imageId !== 'imgA')
    && l.tree.nodes[n1.id].children.length === 2);

  // ④ 全树图集：非当前分支的图必须在 keep 里（§10：漏了就静默删图）
  const keep = S.knownImageIds();
  check('knownImageIds：含非当前分支的图', keep.has('imgA') && keep.has('imgB'), Array.from(keep).join(','));
  check('imageIdsOf：tree 内引用算数（scenes + entries）', (() => {
    const ids = S.imageIdsOf(S.serializeStory(s));
    return ids.indexOf('imgA') >= 0 && ids.indexOf('imgB') >= 0;
  })());
  check('imageIdsOf：无 tree 的旧档照旧只扫 log / scenes', (() => {
    const ids = S.imageIdsOf({ scenes: [{ imageId: 'imgC' }], log: [{ type: 'image', imageId: 'imgD' }] });
    return ids.indexOf('imgC') >= 0 && ids.indexOf('imgD') >= 0;
  })());
}

// 17b. store：imageIdsOf / knownImageIds 计入 videoId（§5③，孤儿清理不误删视频）
{
  const s = newStory();
  s.id = 'store-video';
  const n1 = playTurn(s, { text: '行动 1', narration: '第 1 幕旁白' });
  const a = playTurn(s, { text: '行动 2', narration: 'A 版旁白', world: { place: 'A 线' } });
  const b = retryTurn(s, { text: '行动 2', narration: 'B 版旁白', world: { place: 'B 线' } });
  // 当前分支（B 线）两段视频（其中一段只在投影里）+ 非当前分支（A 线）一段视频
  T.pushLate(s, b.id, { type: 'video', id: 'vdB', videoId: 'vid:B', ts: 1 });
  T.pushLate(s, b.id, { id: 'vdB', videoId: 'vid:B', ts: 1 });
  T.pushLate(s, a.id, { type: 'video', id: 'vdA', videoId: 'vid:A', ts: 2 });
  T.pushLate(s, a.id, { id: 'vdA', videoId: 'vid:A', ts: 2 });
  T.pushLate(s, b.id, { type: 'video', id: 'vdC', videoId: 'vid:C', ts: 3 });
  T.pushLate(s, b.id, { id: 'vdC', kind: 'video', videoId: 'vid:C', mode: 'i2v', sourceSceneId: 'vdB', taskId: 'tk-1', ts: 3 });
  T.project(s);
  S.saveStory(s);   // knownImageIds 只看已保存的故事

  const ids = S.imageIdsOf(S.serializeStory(s));
  check('store imageIdsOf：scenes / log / tree 里的 videoId 都收',
    ids.indexOf('vid:A') >= 0 && ids.indexOf('vid:B') >= 0 && ids.indexOf('vid:C') >= 0, ids.join(','));

  const keep = S.knownImageIds();
  check('knownImageIds：视频不被当孤儿（含非当前分支）',
    keep.has('vid:A') && keep.has('vid:B') && keep.has('vid:C'), Array.from(keep).join(','));

  check('serializeStory：视频 scene 字段白名单保留（§5①）', (() => {
    const sc = (S.serializeStory(s).scenes || []).find(x => x.id === 'vdC');
    return !!sc && sc.kind === 'video' && sc.videoId === 'vid:C'
      && sc.mode === 'i2v' && sc.taskId === 'tk-1' && sc.sourceSceneId === 'vdB';
  })());

  check('pendingVideos：serializeStory / migrateStory 保留（§5⑤）', (() => {
    s.pendingVideos = [{ taskId: 'tk1', mode: 'i2v', prompt: 'p', sourceSceneId: 'vdC', nodeId: n1.id, createdAt: 1 }];
    const raw = S.serializeStory(s);
    const back = S.migrateStory(raw);
    return back.pendingVideos.length === 1 && back.pendingVideos[0].taskId === 'tk1';
  })());

  check('migrateStory：旧字段 poster / videoUrl 归一到 thumb / remoteUrl', (() => {
    const old = S.migrateStory({
      id: 'old-vd', title: 'x', mode: 'choice',
      scenes: [{ id: 'vdOld', kind: 'video', poster: 'data:image/jpeg;base64,P', videoUrl: 'https://cdn/old.mp4', ts: 1 }],
      log: [{ type: 'video', id: 'vdOld', poster: 'data:image/jpeg;base64,P', videoUrl: 'https://cdn/old.mp4', ts: 1 }],
    });
    const sc = old.scenes[0];
    return sc.thumb === 'data:image/jpeg;base64,P' && sc.remoteUrl === 'https://cdn/old.mp4'
      && old.log[0].thumb === 'data:image/jpeg;base64,P' && old.log[0].remoteUrl === 'https://cdn/old.mp4';
  })());
}

/* ---------------- 迁移补测（§6 / 用例 6）：versions>1 展开成兄弟 + 存档点映射 ---------------- */

// 18. 末条旁白 versions>1 展开成兄弟（meta.approx）、旧存档点 sp.turn → nodeId、幂等
{
  const s = newStory();
  s.premise = '在雨夜的车站。';
  s.log = [
    { type: 'player', text: '行动 1', kind: 'do', ts: 1 },
    { type: 'narration', text: '第 1 幕旁白', versions: ['第 1 幕旁白'], activeVersion: 0, ts: 2 },
    { type: 'player', text: '行动 2', kind: 'do', ts: 3 },
    {
      type: 'narration', text: '第 2 幕旁白（B 版）',
      versions: ['第 2 幕旁白（A 版）', '第 2 幕旁白（B 版）', '第 2 幕旁白（C 版）'], activeVersion: 1, ts: 4,
    },
    { type: 'narration', text: '（AI 走神了，点「↻ 重试」或再试一次吧。）', versions: [], ts: 5 },
  ];
  s.messages = [
    { role: 'user', content: '[设定]' + s.premise + '\n\n[玩家行动]（做）行动 1' },
    { role: 'assistant', content: JSON.stringify({ narration: '第 1 幕旁白', choices: ['选项一'] }) },
    { role: 'user', content: '[玩家行动]（做）行动 2' },
    { role: 'assistant', content: JSON.stringify({ narration: '第 2 幕旁白（B 版）', choices: ['选项二'] }) },
  ];
  s.turn = 2;
  s.world.time = '第三天';
  s.savepoints = [
    { id: 'sp-1', name: '第 1 回合后', turn: 1 },
    { id: 'sp-2', name: '第 2 回合后', turn: 2 },
    { id: 'sp-x', name: '对不上的', turn: 99 },
    { id: 'sp-keep', name: '已有 nodeId 不动', turn: 2, nodeId: 'keep-me' },
  ];

  const t = T.ensure(s);
  const ids = T.pathOf(s, t.head);
  const head = t.nodes[t.head];
  const parent = t.nodes[head.parent];
  check('versions 展开：链长不变（根 + 2 个 turn 节点）', ids.length === 3 && t.nodes[t.root].kind === 'root', ids.length);
  check('versions 展开：head = activeVersion 那一版（B 版）',
    head.entries.some(e => e && e.text === '第 2 幕旁白（B 版）'));
  check('versions 展开：head 状态 = 当前 State', head.sid === t.nodes[t.root].sid
    && t.states[head.sid].world.time === '第三天');
  check('versions 展开：其余版本变兄弟、兄弟序 = 版本序', (() => {
    const sibs = T.siblings(s, t.head);
    return parent.children.length === 3 && sibs.length === 3 && sibs.indexOf(t.head) === 1;
  })(), parent.children.length);

  const sibA = t.nodes[parent.children[0]];
  const sibC = t.nodes[parent.children[2]];
  check('versions 展开：兄弟是近似节点（meta.approx / assistantMsg 只有 narration）', (() => {
    const ja = JSON.parse(sibA.assistantMsg.content);
    return sibA.meta.approx === true && sibC.meta.approx === true
      && eq(Object.keys(ja), ['narration']) && ja.narration === '第 2 幕旁白（A 版）'
      && JSON.parse(sibC.assistantMsg.content).narration === '第 2 幕旁白（C 版）';
  })());
  check('versions 展开：兄弟同 action、sid 复用 head 的',
    eq(sibA.action, head.action) && sibA.sid === head.sid && sibC.sid === head.sid);
  check('versions 展开：兄弟条目 = 行动 + 本版旁白（nid 各归各）', (() => {
    return sibA.entries.length === 2 && sibA.entries[0].text === '行动 2' && sibA.entries[0] !== head.entries[0]
      && sibA.entries[1].text === '第 2 幕旁白（A 版）' && sibA.entries[1].nid === sibA.id;
  })());

  // 幂等：再跑两次，树与存档点都深相等（含已映射的 sp.nodeId）
  const before = JSON.stringify({ tree: s.tree, savepoints: s.savepoints });
  T.ensure(s);
  T.ensure(s);
  check('versions 展开 + 存档点映射：幂等（连跑两次树与存档点深相等）',
    JSON.stringify({ tree: s.tree, savepoints: s.savepoints }) === before);

  check('存档点映射：sp.turn → nodeId（链上同 turn 的节点）',
    s.savepoints[0].nodeId === ids[1] && s.savepoints[1].nodeId === t.head,
    s.savepoints[0].nodeId + '/' + s.savepoints[1].nodeId);
  check('存档点映射：对不上保持无 nodeId、已有 nodeId 不动',
    !s.savepoints[2].nodeId && s.savepoints[3].nodeId === 'keep-me');

  const h1 = T.switchSibling(s, t.head, -1);
  check('切到近似兄弟：log / messages 换成本版旁白', !!h1 && h1.id === sibA.id
    && s.log[s.log.length - 1].text === '第 2 幕旁白（A 版）'
    && JSON.parse(s.messages[s.messages.length - 1].content).narration === '第 2 幕旁白（A 版）');
  check('切到近似兄弟：世界卡沿用（sid 复用 head 的）', s.world.time === '第三天');
  const h2 = T.switchSibling(s, sibA.id, +1);
  check('切回 activeVersion：落回 B 版，选项跟着回来', !!h2 && h2.id === t.head
    && s.log[s.log.length - 1].text === '第 2 幕旁白（B 版）'
    && eq(JSON.parse(s.messages[s.messages.length - 1].content).choices, ['选项二']));
}

/* ---------------- 19. UI-4 §8 增补：任意节点继续 / 分叉 ---------------- */

// 19.1 站在非叶子节点继续 = 新分支（§2.1）
{
  const s = newStory();
  const n1 = playTurn(s, { text: '行动一', narration: '第一幕', world: { time: '第一天' }, summariesPush: '摘要一' });
  const n2 = playTurn(s, { text: '行动二', narration: '第二幕', world: { time: '第二天' }, summariesPush: '摘要二' });
  const n3 = playTurn(s, { text: '行动三', narration: '第三幕', world: { time: '第三天' }, summariesPush: '摘要三' });

  const kidsBefore = n2.children.slice();
  const n3Before = JSON.stringify(s.tree.nodes[n3.id]);
  T.switchTo(s, n2.id);
  check('§2.1 switchTo 到非叶子不下探：head 就落在 n2', s.tree.head === n2.id);

  const n4 = playTurn(s, { text: '行动四', narration: '第四幕', world: { time: '第四天' }, summariesPush: '摘要四' });
  check('§2.1 非叶子继续 = 新分支：新节点是 n2 的新孩子（children.length + 1）',
    n2.children.length === kidsBefore.length + 1 && n2.children[n2.children.length - 1] === n4.id,
    n2.children.join(','));
  check('§2.1 parent.active 指向新节点', n2.active === n4.id);
  check('§2.1 原有孩子与其子树不变', JSON.stringify(s.tree.nodes[n3.id]) === n3Before
    && s.tree.nodes[n3.id].parent === n2.id);

  // 19.2 forkBefore（§2.3）
  const r = T.forkBefore(s, n3.id);
  check('§2.3 forkBefore：head 落到 parent', !!r.ok && s.tree.head === n2.id);
  check('§2.3 forkBefore：返回的 action 与原节点一致',
    r.ok && r.action.text === '行动三' && r.action.kind === 'do' && r.action.type === 'player',
    r.ok ? JSON.stringify(r.action) : r.reason);
  const rootRes = T.forkBefore(s, s.tree.root);
  check('§2.3 forkBefore：根节点返回 ok:false', rootRes.ok === false && !!rootRes.reason);
  const missingRes = T.forkBefore(s, 'nope');
  check('§2.3 forkBefore：未知节点返回 ok:false', missingRes.ok === false);
}

// 19.3 开局节点不可改写（§2.3）
{
  const s = newStory();
  const o1 = playTurn(s, {
    actionType: 'opening', text: '（故事开场。请描写第一幕，把玩家带进场景。）', narration: '开场旁白',
  });
  const res = T.forkBefore(s, o1.id);
  check('§2.3 forkBefore：开局节点返回 ok:false', res.ok === false && !!res.reason, res.reason);
  check('§2.3 forkBefore：开局节点拒绝时不动 head', s.tree.head === o1.id);
}

// 19.4 latestLeaf（§2.2）
{
  const s = newStory();
  const p1 = playTurn(s, { text: 'P1', narration: 'n1' });
  const p2 = playTurn(s, { text: 'P2', narration: 'n2' });
  const p2b = retryTurn(s, { text: 'P2b', narration: 'n2b' });   // p2 的兄弟

  T.switchTo(s, p2.id);
  const p3 = playTurn(s, { text: 'P3', narration: 'n3' });       // p2 续写 → p3
  check('§2.2 latestLeaf：沿 active 下探到叶子', T.latestLeaf(s, p1.id).id === p3.id,
    T.latestLeaf(s, p1.id).id);
  check('§2.2 latestLeaf：叶子就是自己', T.latestLeaf(s, p3.id).id === p3.id);
  s.tree.nodes[p1.id].active = null;
  check('§2.2 latestLeaf：无 active 时取最后一个孩子', T.latestLeaf(s, p1.id).id === p2b.id,
    T.latestLeaf(s, p1.id).id);
  check('§2.2 latestLeaf：未知节点返回 null', T.latestLeaf(s, 'nope') == null);
}

// 19.5 canResume（§2.4）
{
  const s = newStory();
  const c1 = playTurn(s, { text: 'C1', narration: 'c1' });
  const c2 = playTurn(s, { text: 'C2', narration: 'c2' });
  check('§2.4 canResume：正常节点 → true', T.canResume(s, c1.id) === true && T.canResume(s, c2.id) === true);
  s.tree.nodes[c1.id].sid = null;
  check('§2.4 canResume：sid === null → false', T.canResume(s, c1.id) === false);
  check('§2.4 canResume：未知节点 → false', T.canResume(s, 'nope') === false);
  check('§2.4 canResume：直接传节点对象也认', T.canResume(s.tree.nodes[c1.id]) === false
    && T.canResume(s.tree.nodes[c2.id]) === true);
  // 旧档迁移：早期回合 sid 全是 null（用例 8 的形状）
  const old = newStory();
  old.log = [
    { type: 'player', text: '旧一', kind: 'do', ts: 1 },
    { type: 'narration', text: '旧旁白一', versions: ['旧旁白一'], activeVersion: 0, ts: 2 },
    { type: 'player', text: '旧二', kind: 'do', ts: 3 },
    { type: 'narration', text: '旧旁白二', versions: ['旧旁白二'], activeVersion: 0, ts: 4 },
  ];
  old.messages = [
    { role: 'user', content: '[玩家行动]（做）旧一' },
    { role: 'assistant', content: JSON.stringify({ narration: '旧旁白一', choices: [] }) },
    { role: 'user', content: '[玩家行动]（做）旧二' },
    { role: 'assistant', content: JSON.stringify({ narration: '旧旁白二', choices: [] }) },
  ];
  old.turn = 2;
  const t = T.ensure(old);
  const chain = T.pathOf(old, t.head);
  const early = t.nodes[chain[1]];
  check('§2.4 迁移旧档：早期回合被 canResume 拦住（sid === null）',
    early.sid == null && T.canResume(old, early.id) === false && T.canResume(old, t.head) === true);
}

// 19.6 历史位置发送完整序列（begin → commit → seal）后投影无旧分支泄漏（§8.5）
{
  const s = newStory();
  const q1 = playTurn(s, { text: '旧一', narration: '旧旁白一', world: { time: '旧时间' }, summariesPush: '旧摘要一' });
  const q2 = playTurn(s, { text: '旧二', narration: '旧旁白二', world: { time: '旧时间二' }, summariesPush: '旧摘要二' });
  const q3 = playTurn(s, { text: '旧三', narration: '旧旁白三', world: { time: '旧时间三' }, summariesPush: '旧摘要三' });

  T.switchTo(s, q1.id);
  const mark = T.begin(s);
  s.log.push({ type: 'player', text: '新一', kind: 'do', ts: 10 });
  const um = { role: 'user', content: '[玩家行动]（做）新一' };
  const am = { role: 'assistant', content: JSON.stringify({ narration: '新旁白一', choices: [] }) };
  s.turn += 1;
  s.log.push({ type: 'narration', text: '新旁白一', versions: ['新旁白一'], activeVersion: 0, ts: 11 });
  s.messages.push(um, am);
  s.world.time = '新时间';
  s.summaries.push('新摘要');
  const qn = T.commit(s, {
    action: { type: 'player', text: '新一', kind: 'do', sent: '（做）新一' },
    userMsg: um, assistantMsg: am, logMark: mark.logMark,
  });
  T.seal(s, qn.id);
  T.project(s);

  check('§8.5 新节点是 q1 的新孩子、与 q2 成兄弟',
    q1.children.length === 2 && q1.children[1] === qn.id && q1.active === qn.id);
  check('§8.5 log 只含新路径内容（无旧二 / 旧三）',
    s.log.some(e => e.text === '新旁白一') && s.log.some(e => e.text === '旧旁白一')
    && !s.log.some(e => e.text === '旧旁白二') && !s.log.some(e => e.text === '旧旁白三'));
  check('§8.5 messages 只含新路径窗口（无旧旁白二）',
    s.messages.some(m => m.content.indexOf('新旁白一') >= 0)
    && !s.messages.some(m => m.content.indexOf('旧旁白二') >= 0)
    && s.messages.length === 4);
  check('§8.5 world / summaries 是新分支的',
    s.world.time === '新时间' && s.summaries.indexOf('新摘要') >= 0
    && s.summaries.indexOf('旧摘要二') < 0 && s.summaries.indexOf('旧摘要三') < 0);
  check('§8.5 旧分支节点仍在树上（q2 / q3 不丢）',
    !!s.tree.nodes[q2.id] && !!s.tree.nodes[q3.id] && s.tree.nodes[q2.id].parent === q1.id);
}

/* ---------------- 依赖装配（阶段 6：静态 import） ---------------- */
{
  // 原来靠「只引 tree + store，再让 assertDeps 报缺 Prefs」守住加载顺序；
  // 现在 store 静态 import prefs，这条缺位路径在结构上不存在——改成验证清洗真的生效。
  const clean = S.sanitizePrefsSafe({ profileId: 'p1', unknownKey: 1 });
  check('store 静态装配 Prefs：未知键被丢弃、已知键保留',
    clean.profileId === 'p1' && clean.unknownKey === undefined, JSON.stringify(clean));
  check('加载顺序自检已随静态 import 删除', S.assertDeps === undefined);
}

/* ---------------- 汇总 ---------------- */

let bad = 0;
for (const r of results) {
  if (!r.hit) bad += 1;
  console.log((r.hit ? '✓' : '✗') + ' ' + r.name + (r.detail ? '  → ' + r.detail : ''));
}
console.log('—');
console.log('tree-test：' + (results.length - bad) + '/' + results.length + ' 通过');
process.exit(bad ? 1 : 0);
