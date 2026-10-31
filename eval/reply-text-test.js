#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 「助手回复 → 纯文本」唯一口径测试（src/core/tree.ts 的 plainReply）
 *
 * 剧情模式的 assistant 内容是 {"narration":"…"} 包装，chat / rp 是纯文本；
 * 书架摘要、全文搜索索引、自动标题提示词、分支页标签与面板预览都要把它拍平。
 * 这层曾有多份逐字相近的实现（trim 口径还不一致），
 * 于是同一个回复在不同界面可能给出不同文本。现在只有 plainReply 一份：
 *   plainReply(raw)              —— 原样（不 trim；摘要 / 标签自己会再裁）
 *   plainReply(raw, {trim:true}) —— 去两侧空白（标题提示词要的形态）
 *
 * 覆盖：
 *   1. 拍平规则：narration / 中文键「旁白」/ text / choices / 坏 JSON / 非对象 JSON / 空值
 *   2. trim 选项：与旧的 titles 版逐字一致（choices 不 trim 也照旧）
 *   3. 消费方同口径：titles / treeLayout / search / store 四条链路对同一份内容给同一段文本
 *   4. 静态不变量：消费方不许再自带 JSON.parse；全仓「JSON.parse + 取旁白」只剩白名单内三处
 *
 * 用法：node eval/reply-text-test.js
 */
const fs = require('fs');
const path = require('path');
const H = require('./_harness.js');
const check = H.check;

// 进程内 localStorage 垫片：store.ts 在没有 IndexedDB 时走这条回退路径（与书架索引测试同款）
(function () {
  const m = new Map();
  global.localStorage = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    key: i => Array.from(m.keys())[i] || null,
    get length() { return m.size; },
  };
})();

global.window = global;
const core = f => require(path.join(__dirname, '..', 'src', 'core', f + '.ts'));

const Tree = core('tree');
const Titles = core('titles').Titles;
const TL = core('treeLayout').TreeLayout;
const Search = core('search').Search;
const Store = core('store').Store;
const plainReply = Tree.plainReply;

if (typeof plainReply !== 'function' || !Titles || !TL || !Search || !Store) {
  console.error('加载失败：tree / titles / treeLayout / search / store 导出缺失');
  process.exit(1);
}

const json = o => JSON.stringify(o);

/* ---------------- 1. 拍平规则 ---------------- */

{
  check('纯文本：原样返回（默认不 trim）',
    plainReply('  雨声渐大  ') === '  雨声渐大  ', JSON.stringify(plainReply('  雨声渐大  ')));
  check('JSON：取 narration',
    plainReply(json({ narration: '门铃响了' })) === '门铃响了');
  check('JSON：兼容旧档中文键「旁白」',
    plainReply(json({ '旁白': '旧档旁白' })) === '旧档旁白');
  check('JSON：没有旁白字段时取 text',
    plainReply(json({ text: '只有正文' })) === '只有正文');
  check('JSON：只有选项时拼成一行',
    plainReply(json({ choices: ['推开门', '转身离开'] })) === '推开门 转身离开');
  check('坏 JSON 当纯文本（不抛错）',
    plainReply('{"narration": 没写完的') === '{"narration": 没写完的');
  check('JSON 数组 / 数字当纯文本',
    plainReply('[1,2]') === '[1,2]' && plainReply('42') === '42');
  check('空值 → 空串',
    plainReply(null) === '' && plainReply(undefined) === '' && plainReply('') === '');
  check('空旁白不当命中、退回原文（0.13.0 起的既有语义）',
    plainReply(json({ narration: '' })) === json({ narration: '' }),
    JSON.stringify(plainReply(json({ narration: '' }))));
}

/* ---------------- 2. trim 选项（与旧 titles 版逐字一致） ---------------- */

{
  const cases = [
    ['  纯文本  ', '纯文本'],
    [json({ narration: '  雨声渐大  ' }), '雨声渐大'],
    [json({ '旁白': '  旧的  ' }), '旧的'],
    [json({ text: '  正文  ' }), '正文'],
    [json({ choices: [' A ', 'B'] }), ' A  B'],         // choices 逐项原样、只用空格拼接（照旧）
    ['{"narration": 坏掉的', '{"narration": 坏掉的'],
    ['  ', ''],
  ];
  cases.forEach(([raw, want]) => {
    const got = plainReply(raw, { trim: true });
    check('trim：' + JSON.stringify(raw).slice(0, 34) + ' → ' + JSON.stringify(want),
      got === want, JSON.stringify(got));
  });
  check('trim 只在显式传参时生效（默认仍原样）',
    plainReply('  x  ') === '  x  ' && plainReply('  x  ', { trim: true }) === 'x');
}

/* ---------------- 3. 消费方同口径 ---------------- */

// 标题提示词：assistant 条目 → 去空白的纯文本
function promptTextOf(content) {
  const p = Titles.buildPrompt([{ role: 'assistant', content: content }], 'choice');
  return p[1] && p[1].content;
}

// 分支页标签：turn 1 的节点，没有玩家行动 → 取 AI 旁白
function labelOf(content) {
  const tree = {
    v: 1, root: 'root', head: 't1',
    nodes: {
      root: {
        id: 'root', parent: null, children: ['t1'], active: 't1', kind: 'root',
        action: null, userMsg: null, assistantMsg: null, entries: [], scenes: [],
        sealed: true, turn: 0, ts: 1, meta: {},
      },
      t1: {
        id: 't1', parent: 'root', children: [], active: null, kind: 'turn',
        action: null, userMsg: null, assistantMsg: { role: 'assistant', content: content },
        entries: [], scenes: [], sealed: true, turn: 1, ts: 1, meta: {},
      },
    },
  };
  const out = TL.compute(tree, { collapseRun: 99, labelLen: 200 });
  return out.nodes.find(n => n.id === 't1').label;
}

// 书架摘要：当前路径 head 的回复（先剥 JSON，再剥标记 / 折叠空白，最后截 60 字）
function snippetOf(content) {
  return Store.storySnippet({
    id: 's-snippet', title: 'x', log: [],
    tree: {
      v: 3, root: 'n1', head: 'n1',
      nodes: {
        n1: {
          id: 'n1', parent: null, children: [], kind: 'turn', turn: 1,
          action: null, entries: [], assistantMsg: { role: 'assistant', content: content },
        },
      },
    },
  });
}

// 搜索索引：doc.nodes[].text 已规整（NFKC + 小写 + 折叠空白）
function searchTextOf(content) {
  const doc = Search.buildDoc({
    id: 's-search', title: 'x', mode: 'choice', updatedAt: 1,
    tree: {
      v: 3, root: 'n1', head: 'n1',
      nodes: {
        n1: {
          id: 'n1', parent: null, children: [], kind: 'turn', turn: 1,
          action: null, entries: [], assistantMsg: { role: 'assistant', content: content },
        },
      },
    },
  });
  return doc.nodes.length ? doc.nodes[0].text : '';
}

{
  const samples = [
    '  雨声渐大  ',
    json({ narration: '  门铃响了，店员抬头  ' }),
    json({ '旁白': '旧档中文旁白' }),
    json({ text: '只有 text 字段' }),
    '不是 JSON，但有一段旁白 { 花括号在里面',
  ];
  samples.forEach(raw => {
    const flat = plainReply(raw);
    const trimmed = plainReply(raw, { trim: true });
    const tag = JSON.stringify(raw).slice(0, 30);
    check('titles：' + tag + ' → plainReply(trim)',
      promptTextOf(raw) === trimmed, JSON.stringify(promptTextOf(raw)));
    check('treeLayout：' + tag + ' → plainReply',
      labelOf(raw) === '1 · ' + flat, JSON.stringify(labelOf(raw)));
    check('store 摘要：' + tag + ' → plainReply（折叠空白后）',
      snippetOf(raw) === flat.replace(/\s+/g, ' ').trim(), JSON.stringify(snippetOf(raw)));
    check('search 索引：' + tag + ' → plainReply（规整后）',
      searchTextOf(raw) === Search.normalize(flat), JSON.stringify(searchTextOf(raw)));
  });

  // 同一个回复在四处给出的正文必须一致。唯一的合法差异是 trim：
  // 标题提示词去两侧空白，标签 / 摘要 / 索引各自按用途折叠或规整，正文本身不能不同。
  const once = json({ narration: '  同一条回复里的同一段旁白  ' });
  const same = [
    promptTextOf(once),
    labelOf(once).replace(/^1 · /, ''),
    snippetOf(once),
    searchTextOf(once),
  ].map(x => x.replace(/\s+/g, ' ').trim());
  check('四处消费方对同一条回复给出同一段文本（无口径漂移）',
    same.every(x => x === same[0]), JSON.stringify(same));

  // 守卫：节点回复不是「非空字符串」时当没有，不把对象 String() 进标签 / 预览
  check('treeLayout.replyText：非字符串 / 空值 → 空串',
    TL.replyText(null) === '' && TL.replyText({}) === ''
      && TL.replyText({ assistantMsg: { content: {} } }) === ''
      && TL.replyText({ assistantMsg: { content: '' } }) === '');
  check('treeLayout.replyText：导出并走 plainReply',
    typeof TL.replyText === 'function'
      && TL.replyText({ assistantMsg: { content: json({ narration: '标签专用' }) } }) === '标签专用');
}

/* ---------------- 4. 静态不变量 ---------------- */

{
  const SRC = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|js|svelte)$/.test(e.name)) files.push(p);
    }
  })(SRC);
  const rel = p => path.relative(path.join(__dirname, '..'), p).split(path.sep).join('/');
  const read = p => fs.readFileSync(p, 'utf8');
  const byName = {};
  files.forEach(p => { byName[rel(p)] = read(p); });

  // 消费方自己不再解析 JSON：「回复 → 纯文本」只能调用 plainReply
  ['src/core/titles.ts', 'src/core/treeLayout.ts', 'src/app/branch.js'].forEach(f => {
    check('静态：' + f + ' 不再自带 JSON.parse',
      byName[f] != null && byName[f].indexOf('JSON.parse') < 0);
  });
  ['src/core/search.ts', 'src/core/titles.ts', 'src/core/treeLayout.ts', 'src/core/store.ts', 'src/app/branch.js']
    .forEach(f => {
      check('静态：' + f + ' 调用 plainReply / replyText',
        byName[f] != null && /plainReply|replyText/.test(byName[f]));
    });

  // 「JSON.parse + 取旁白」的实现全仓只允许三处：
  //   tree.ts    —— plainReply 本体
  //   context.ts —— 回包规整 / 压缩分组（该模块的约定是零 import，另计）
  //   turn.js    —— 书记员压缩输入同时要 scene_change，另取一次原始对象
  const offenders = files.filter(p => {
    const s = byName[rel(p)];
    return s.indexOf('JSON.parse') >= 0 && (/\.narration\b/.test(s) || /\[\s*['"]旁白['"]\s*\]/.test(s));
  }).map(rel).sort();
  check('静态：「JSON.parse + 取旁白」只剩白名单三处（新增副本即失败）',
    offenders.join(',') === 'src/app/turn.js,src/core/context.ts,src/core/tree.ts',
    offenders.join(','));

  // 实现本体仍在 tree.ts，且 trim 是显式选项（不是各自 trim 一遍）
  const treeSrc = byName['src/core/tree.ts'] || '';
  check('静态：plainReply 实现留在 tree.ts，支持 opts.trim',
    /function plainReply\(raw, opts\?\)/.test(treeSrc) && /opts\.trim/.test(treeSrc));
  check('静态：titles 的 assistantText 本地副本已删',
    byName['src/core/titles.ts'].indexOf('function assistantText') < 0);
}

H.finish('回复纯文本口径');
