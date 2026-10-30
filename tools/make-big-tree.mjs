#!/usr/bin/env node
/*
 * tools/make-big-tree.mjs —— 生成含 ~800 节点、多层嵌套分叉的可导入 .irstory.json
 *
 * 用途：分支页性能验收（步骤 8）——平移 / 缩放 / 折叠在大树上的表现。
 * 形状（确定性，无随机）：主干 240 节点；每 12 个主干节点挂一条 15 节点支线；
 * 支线每 9 个节点挂 10 节点子支线；子支线每 5 个节点挂 6 节点孙支线；
 * 节点数达到 TARGET 后停止（实际数会打印出来）。
 *
 * 用法：
 *   node tools/make-big-tree.mjs [输出路径] [--legacy]
 *   --legacy   把主干最早的 20 个回合做成 sid === null 的「旧存档迁移」形状
 *              （分支页里这些节点两个继续类操作应置灰，用于步骤 5）
 *
 * 导入：生成的 .irstory.json 拖进书架（或「导入」按钮）即可。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const LEGACY = args.includes('--legacy');
const outArg = args.find(a => !a.startsWith('--'));
const OUT = outArg || join(dirname(fileURLToPath(import.meta.url)), '..', 'big-tree.irstory.json');
const TARGET = 800;

const nodes = {};
const states = {};
let seq = 0;
let turnSeq = 0;

function addState(id, worldTime) {
  const sid = 'st-' + id;
  states[sid] = {
    world: {
      place: '第 ' + worldTime + ' 站', time: '第 ' + worldTime + ' 幕',
      characters: [{ name: '旅人', presence: '在场', personality: '沉默', speech: '简短' }],
      threads: ['未回收：第八个货架'], relationship: { stage: '初识', bonds: ['同行'], notes: '' },
      scene: '走廊尽头', updatedAt: 1600000000000, scribeAt: 1600000000000,
    },
    summaries: ['【第 ' + worldTime + ' 幕】走廊｜深夜｜旅人｜前进｜伏笔：埋下「第八个货架」'],
    rollingStyle: { style: 'cel shading', scenes: '走廊, 车站', wardrobe: '风衣', updatedAt: 1600000000000 },
    painterThread: [],
    lastSceneSummary: '走廊尽头的灯还亮着',
    lastBg: null,
  };
  return sid;
}

function addNode(parentId, kind, legacy) {
  seq += 1;
  turnSeq += 1;
  const id = 'n' + String(seq).padStart(4, '0');
  const narration = '第 ' + turnSeq + ' 幕旁白（' + id + '）：走廊尽头的灯还亮着，雨声没有停。';
  const actionText = '走向第 ' + turnSeq + ' 扇门';
  const node = {
    id: id,
    parent: parentId || null,
    children: [],
    active: null,
    kind: parentId ? 'turn' : 'root',
    action: parentId
      ? { type: 'player', text: actionText, kind: 'do', sent: '（做）' + actionText }
      : null,
    userMsg: parentId ? { role: 'user', content: '[玩家行动]（做）' + actionText } : null,
    assistantMsg: parentId
      ? { role: 'assistant', content: JSON.stringify({ narration: narration, choices: ['继续前进', '回头看看', '推开那扇门'] }) }
      : null,
    entries: parentId ? [
      { type: 'player', text: actionText, kind: 'do', ts: 1600000000000 + seq * 1000 },
      { type: 'narration', text: narration, versions: [narration], activeVersion: 0, ts: 1600000000000 + seq * 1000 + 500, nid: id },
    ] : [],
    scenes: [],
    sid: legacy ? null : addState(id, turnSeq),
    msgFloor: 0,
    msgSnap: null,
    sealed: true,
    turn: parentId ? turnSeq : 0,
    ts: 1600000000000 + seq * 1000,
    meta: legacy ? { legacy: true } : { model: 'big-tree-generator' },
  };
  nodes[id] = node;
  if (parentId) {
    const p = nodes[parentId];
    p.children.push(id);
    if (!p.active) p.active = id;
  }
  return node;
}

function spine(parentId, length, legacy, depth) {
  let last = parentId;
  for (let i = 0; i < length; i++) {
    if (seq >= TARGET) return last;
    const legacyThis = legacy && depth === 0 && turnSeq < 20;
    const n = addNode(last, 'turn', legacyThis);
    last = n.id;
    // 多层嵌套分叉：主干 → 支线 → 子支线 → 孙支线
    // 间隔留大些（≥ 折叠阈值 8）：验收要能看到「··· N 回合」折叠与展开
    if (depth === 0 && i % 12 === 5) spine(n.id, 15, false, 1);
    else if (depth === 1 && i % 9 === 2) spine(n.id, 10, false, 2);
    else if (depth === 2 && i % 5 === 1) spine(n.id, 6, false, 3);
  }
  return last;
}

const root = addNode(null, 'root', false);
const head = spine(root.id, 240, LEGACY, 0);

// 存档点（书签图标用）：挂在主干靠前的三个节点上
const mainChain = [];
{
  let cur = nodes[head];
  while (cur) { mainChain.push(cur.id); cur = cur.parent ? nodes[cur.parent] : null; }
  mainChain.reverse();
}
const savepoints = [10, 30, 60].filter(i => mainChain[i]).map((i, k) => ({
  id: 'sp-big-' + k, name: '存档点 ' + (k + 1) + '（第 ' + nodes[mainChain[i]].turn + ' 回合）',
  turn: nodes[mainChain[i]].turn, nodeId: mainChain[i], ts: 1600000000000,
}));

// 投影字段（导入时会被 project 重建，但导入口径需要完整一份）
const headNode = nodes[head];
const log = [];
const messages = [];
{
  let cur = headNode;
  const chain = [];
  while (cur) { chain.push(cur); cur = cur.parent ? nodes[cur.parent] : null; }
  chain.reverse();
  for (const n of chain) {
    for (const e of n.entries) log.push(e);
    if (n.userMsg) messages.push(n.userMsg);
    if (n.assistantMsg) messages.push(n.assistantMsg);
  }
}

const pack = {
  format: 'ir-story',
  schema: 2,
  kind: 'full',
  app: '无限阅读 big-tree generator',
  title: '大树压力测试（' + Object.keys(nodes).length + ' 节点）',
  premise: '用于分支页性能验收的合成故事：主干 + 多层嵌套分叉。',
  mode: 'choice',
  styleTone: '',
  world: states[headNode.sid] ? states[headNode.sid].world : {},
  styleCard: null,
  rollingStyle: null,
  characterCard: null,
  createdAt: 1600000000000,
  updatedAt: 1600000000000,
  images: [],
  log: log.slice(-120),
  messages: messages,
  summaries: (states[headNode.sid] && states[headNode.sid].summaries) || [],
  painterThread: [],
  userProfile: [],
  turn: headNode.turn,
  lastSceneSummary: '走廊尽头的灯还亮着',
  savepoints: savepoints,
  tree: { v: 1, root: root.id, head: head, nodes: nodes, states: states },
};

writeFileSync(OUT, JSON.stringify(pack), 'utf8');
console.log('已生成 ' + OUT);
console.log('  节点数：' + Object.keys(nodes).length + '（目标 ~' + TARGET + '）');
console.log('  主干 head：' + head + '（第 ' + headNode.turn + ' 回合）');
console.log('  存档点：' + savepoints.length + ' 个（分支页书签图标）');
console.log('  旧档形状（sid === null）：' + (LEGACY ? '主干前 20 回合' : '无（加 --legacy 生成）'));
console.log('把文件拖进书架即可导入。');
