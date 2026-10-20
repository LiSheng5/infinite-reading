#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 全文搜索纯逻辑测试（js/search.js，UI-2 §5）
 *
 * 不开浏览器、不联网：
 *   1. 中文子串命中；多词 AND；大小写与全半角规整（NFKC）；
 *   2. 标题命中排在仅正文命中之前；同分按更新时间新到旧；
 *   3. 非当前分支节点里的内容能被搜到；
 *   4. 片段 ranges 的偏移与片段文本逐一对应（含中文、emoji）；
 *   5. 输出里不含拼出来的 HTML（<script> 对抗用例 → 原样文本 + ranges）；
 *   6. 增量：更新一个对话后只重建该 id；删除后搜不到；
 *   7. 性能健全性：50 × 500 节点合成语料，一次查询 < 500ms（Node）；
 *   8. 剧情模式 JSON 内容容错：坏 JSON 当纯文本，不抛错。
 *
 * 用法：node eval/search-test.js
 */
const path = require('path');

global.window = global;
require(path.join(__dirname, '..', 'js', 'search.js'));

const S = (global.IR || {}).Search;
if (!S) {
  console.error('加载失败：IR.Search 缺失（js/search.js 没被 require 进来？）');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}

// 造一个最小 tree 形状的故事（节点字段与 js/tree.js makeNode 同口径）
function storyOf(opts) {
  opts = opts || {};
  const nodes = {};
  const list = opts.nodes || [];
  let parent = null;
  list.forEach((n, i) => {
    const id = n.nid || ('n' + i);
    nodes[id] = {
      id, parent,
      children: [],
      kind: n.kind || 'turn',
      action: n.action != null ? n.action : { type: 'player', text: n.user || '', kind: 'do', sent: n.user || '' },
      userMsg: { role: 'user', content: n.user || '' },
      assistantMsg: { role: 'assistant', content: n.reply != null ? n.reply : '' },
      entries: n.entries || [],
      sealed: true, turn: i, ts: 1,
    };
    if (parent) nodes[parent].children.push(id);
    parent = id;
  });
  return {
    id: opts.id || 'story',
    title: opts.title || '',
    mode: opts.mode || 'choice',
    updatedAt: opts.updatedAt || 1,
    log: opts.log || [],
    tree: list.length ? { v: 3, root: 'n0', head: list[list.length - 1].nid || ('n' + (list.length - 1)), nodes } : null,
  };
}

/* ---------------- 1. 命中 / AND / NFKC ---------------- */

{
  const doc = S.buildDoc(storyOf({
    id: 's-cn', title: '雨夜便利店', updatedAt: 5,
    nodes: [
      { user: '推开门', reply: JSON.stringify({ narration: '门铃响了，店员抬头看了一眼。' }) },
      { user: '走向货架', reply: JSON.stringify({ narration: '第八个货架尽头有一张旧照片。' }) },
    ],
  }));
  const r1 = S.query([doc], '货架');
  check('query：中文子串命中', r1.length === 1 && r1[0].id === 's-cn' && r1[0].hits.length > 0,
    JSON.stringify(r1[0] && r1[0].hits[0]));
  const r2 = S.query([doc], '货架 照片');
  check('query：多词 AND（都命中）', r2.length === 1);
  const r3 = S.query([doc], '货架 不存在词');
  check('query：多词 AND（缺一词 → 无结果）', r3.length === 0);
  const doc2 = S.buildDoc(storyOf({ id: 's-en', title: 'Hello World', nodes: [{ user: 'Say HELLO to the World', reply: 'hello world again' }] }));
  check('query：大小写规整', S.query([doc2], 'hello').length === 1 && S.query([doc2], 'HELLO').length === 1);
  const doc3 = S.buildDoc(storyOf({ id: 's-fw', title: 'ＡＢＣ冒险', nodes: [{ user: 'ＡＢＣ', reply: '全角内容' }] }));
  check('query：全半角规整（NFKC）', S.query([doc3], 'abc').length === 1, JSON.stringify(S.query([doc3], 'abc')));
  const tr = S.query([doc3], 'abc')[0].titleRanges;
  check('query：标题高亮区间映射回原文（全角）',
    tr.length === 1 && tr[0][0] === 0 && tr[0][1] === 3 && 'ＡＢＣ冒险'.slice(tr[0][0], tr[0][1]) === 'ＡＢＣ',
    JSON.stringify(tr));
}

/* ---------------- 2. 排序 ---------------- */

{
  const a = S.buildDoc(storyOf({ id: 'title-hit', title: '末班电车', updatedAt: 1, nodes: [{ user: 'x', reply: '夜里走路' }] }));
  const b = S.buildDoc(storyOf({ id: 'body-hit', title: '别的故事', updatedAt: 2, nodes: [{ user: '电车', reply: '电车 电车 电车 电车 电车' }] }));
  const r = S.query([b, a], '电车');
  check('query：标题命中排在仅正文命中之前',
    r.length === 2 && r[0].id === 'title-hit' && r[1].id === 'body-hit', r.map(x => x.id + ':' + x.score).join(','));
  const t1 = S.buildDoc(storyOf({ id: 'old', title: '同一个词', updatedAt: 1, nodes: [{ user: 'x', reply: 'y' }] }));
  const t2 = S.buildDoc(storyOf({ id: 'new', title: '同一个词', updatedAt: 9, nodes: [{ user: 'x', reply: 'y' }] }));
  const r2 = S.query([t1, t2], '同一个词');
  check('query：同分按更新时间新到旧', r2.length === 2 && r2[0].id === 'new' && r2[1].id === 'old',
    r2.map(x => x.id).join(','));
}

/* ---------------- 3. 非当前分支 ---------------- */

{
  // head 在 n0（主线）；sibling 分支 n-branch 里藏了「月台上的长椅」，不在当前路径
  const st = storyOf({
    id: 's-branch', title: '车站',
    nodes: [
      { nid: 'n0', user: '主线行动', reply: JSON.stringify({ narration: '主线旁白。' }) },
    ],
  });
  st.tree.nodes['n-branch'] = {
    id: 'n-branch', parent: 'n0', children: [], kind: 'turn',
    action: { type: 'player', text: '另一条分支的行动', kind: 'do', sent: '另一条分支的行动' },
    userMsg: { role: 'user', content: '另一条分支的行动' },
    assistantMsg: { role: 'assistant', content: JSON.stringify({ narration: '月台上的长椅落满了灰。' }) },
    entries: [], sealed: true, turn: 1, ts: 2,
  };
  st.tree.nodes.n0.children.push('n-branch');
  const doc = S.buildDoc(storyOf({ id: 'tmp' }));   // 占位，防止误用
  const doc2 = S.buildDoc(st);
  const r = S.query([doc2], '月台');
  check('query：非当前分支节点里的内容能被搜到',
    r.length === 1 && r[0].hits.length && r[0].hits[0].nid === 'n-branch',
    JSON.stringify(r[0] && r[0].hits[0] && r[0].hits[0].nid));
  void doc;
}

/* ---------------- 4. ranges 与片段自洽（中文 + emoji） ---------------- */

{
  const text = '🚄列车进站，站台上的灯光闪烁。';
  const doc = S.buildDoc(storyOf({ id: 's-emoji', title: 'x', nodes: [{ user: text, reply: '' }] }));
  const r = S.query([doc], '站台');
  const hit = r[0] && r[0].hits[0];
  check('query：片段含 emoji 时 ranges 自洽',
    !!hit && hit.ranges.length >= 1 && hit.ranges.every(([a, b]) => hit.snippet.slice(a, b) === '站台'),
    JSON.stringify(hit));
  // 多处命中 + 中文边界
  const doc2 = S.buildDoc(storyOf({ id: 's-multi', title: 'x', nodes: [{ user: '风铃风铃风铃', reply: '' }] }));
  const hit2 = S.query([doc2], '风铃')[0].hits[0];
  check('query：片段内多处命中合并出多个 ranges',
    hit2.ranges.length >= 1 && hit2.ranges.every(([a, b]) => hit2.snippet.slice(a, b) === '风铃'),
    JSON.stringify(hit2));
  check('query：每个结果最多 2 个命中片段',
    (() => {
      const d = S.buildDoc(storyOf({
        id: 's-cap', title: 'x',
        nodes: [1, 2, 3, 4].map(i => ({ nid: 'm' + i, user: '关键词' + i, reply: '关键词在此' })),
      }));
      return S.query([d], '关键词')[0].hits.length === 2;
    })());
}

/* ---------------- 5. 无 HTML（<script> 对抗用例） ---------------- */

{
  const evil = '<script>alert(1)</script>货架底下的秘密';
  const doc = S.buildDoc(storyOf({ id: 's-evil', title: '标题<script>x</script>', nodes: [{ user: evil, reply: '' }] }));
  const r = S.query([doc], '秘密');
  const dump = JSON.stringify(r);
  check('query：输出不含拼出来的 HTML（无 mark/span 标签）',
    !/<mark|<\/mark|<span|<\/span|<b>|<em/i.test(dump), dump.slice(0, 80));
  const hit = r[0] && r[0].hits[0];
  check('query：对抗内容原样保留在片段文本里（不做转义拼接）',
    !!hit && hit.snippet.indexOf('<script>') >= 0, hit && hit.snippet);
  check('query：片段是文档文本的原样子串',
    !!hit && doc.nodes[0].text.indexOf(hit.snippet) >= 0, hit && hit.snippet);
  const rt = S.query([doc], 'script')[0];
  check('query：标题里的对抗内容也只出 ranges 不出 HTML',
    !!rt && Array.isArray(rt.titleRanges) && !/<mark/i.test(JSON.stringify(rt.titleRanges)),
    JSON.stringify(rt && rt.titleRanges) + ' → ' + JSON.stringify(doc.title.slice(...(rt ? rt.titleRanges[0] : [0, 0]))));
}

/* ---------------- 6. 增量索引 ---------------- */

{
  const idx = S.createIndex();
  const a = storyOf({ id: 'a', title: '第一个', nodes: [{ user: '苹果', reply: '' }] });
  const b = storyOf({ id: 'b', title: '第二个', nodes: [{ user: '香蕉', reply: '' }] });
  const c = storyOf({ id: 'c', title: '第三个', nodes: [{ user: '橘子', reply: '' }] });
  idx.upsert(a); idx.upsert(b); idx.upsert(c);
  const base = idx.stats.builds;
  const bDocBefore = idx.get('b');
  const cDocBefore = idx.get('c');
  // 更新 b（同一 id、新内容）：只重建 b
  const b2 = storyOf({ id: 'b', title: '第二个', updatedAt: 99, nodes: [{ user: '葡萄换成了蜜柚', reply: '' }] });
  idx.upsert(b2);
  check('增量：更新一个对话后只重建该 id（builds +1）',
    idx.stats.builds === base + 1 && idx.get('b') !== bDocBefore && idx.get('c') === cDocBefore,
    'builds=' + idx.stats.builds + ' base=' + base);
  check('增量：更新后能搜到新内容',
    S.query(idx.docs(), '葡萄').length === 1 && S.query(idx.docs(), '香蕉').length === 0);
  idx.remove('b');
  check('增量：删除后搜不到', S.query(idx.docs(), '葡萄').length === 0 && idx.size() === 2);
}

/* ---------------- 7. 性能健全性（50 × 500 节点） ---------------- */

{
  const N_STORY = 50, N_NODE = 500;
  const stories = [];
  for (let i = 0; i < N_STORY; i++) {
    const nodes = [];
    for (let j = 0; j < N_NODE; j++) {
      nodes.push({
        nid: 'n' + j,
        user: '第 ' + j + ' 次行动，玩家推开了门。',
        reply: JSON.stringify({ narration: '旁白第 ' + j + ' 段：雨声、灯光、旧照片上的字迹。' }),
      });
    }
    nodes[N_NODE - 1].reply = JSON.stringify({ narration: '第 ' + i + ' 个故事的独有词：藏匿点' + i + '。' });
    stories.push(storyOf({ id: 'p' + i, title: '性能故事 ' + i, updatedAt: i, nodes }));
  }
  const t0 = Date.now();
  const docs = stories.map(s => S.buildDoc(s));
  const buildMs = Date.now() - t0;
  const t1 = Date.now();
  const r = S.query(docs, '藏匿点7');
  const queryMs = Date.now() - t1;
  check('性能：50 × 500 节点一次查询 < 500ms（Node）',
    queryMs < 500 && r.length === 1 && r[0].id === 'p7',
    'build=' + buildMs + 'ms query=' + queryMs + 'ms docs=' + docs.length
      + ' nodes=' + docs.reduce((s, d) => s + d.nodes.length, 0));
  // 数值写进报告
  console.log('  [perf] 搜索首次构建（' + N_STORY + ' 故事 × ' + N_NODE + ' 节点）：' + buildMs + 'ms；单次查询：' + queryMs + 'ms');
}

/* ---------------- 8. 剧情模式 JSON 容错 ---------------- */

{
  const st = {
    id: 's-bad', title: 'x', mode: 'choice', updatedAt: 1, log: [],
    tree: {
      v: 3, root: 'n0', head: 'n0',
      nodes: {
        n0: {
          id: 'n0', parent: null, children: [], kind: 'turn',
          action: { type: 'player', text: '坏 JSON 行动', kind: 'do', sent: '' },
          userMsg: { role: 'user', content: '坏 JSON 行动' },
          assistantMsg: { role: 'assistant', content: '{"narration": 没写完的' },
          entries: [], sealed: true, turn: 1, ts: 1,
        },
      },
    },
  };
  let threw = false;
  let doc = null;
  try { doc = S.buildDoc(st); } catch (_) { threw = true; }
  check('buildDoc：坏 JSON 当纯文本、不抛错',
    !threw && doc && doc.nodes.length === 1 && doc.nodes[0].text.indexOf('没写完的') >= 0,
    doc && doc.nodes[0] && doc.nodes[0].text.slice(0, 30));
  check('query：坏 JSON 文档也能搜',
    S.query([doc], '没写完').length === 1);
}

/* ---------------- 报告 ---------------- */

let fails = 0;
for (const r of results) {
  if (r.hit) console.log('  ok  ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  else { console.error('  FAIL ' + r.name + (r.detail ? '  [' + r.detail + ']' : '')); fails++; }
}
if (fails) {
  console.error('search-test：' + fails + ' 项未通过');
  process.exit(1);
}
console.log('search-test：全部通过（' + results.length + ' 项）');
