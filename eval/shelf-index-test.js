#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 书架索引条目测试（js/store.js，UI-2 §5）
 *
 * 不开浏览器、不联网：
 *   1. saveStory 写出的索引条目含 mode / turn / titleAuto / snippet；
 *   2. 旧索引条目（缺字段 / 空标题 / 坏条目）补齐后再运行为空操作（幂等）；
 *   3. deleteStory 同步清理索引与搜索文档；
 *   4. titleAuto 默认值：新建智能体 / 扮演为真，剧情为假，旧档迁移为假。
 *
 * 用法：node eval/shelf-index-test.js
 */
const path = require('path');

// 进程内 localStorage 垫片：让 store.js 走「无 IndexedDB → localStorage」回退路径，
// 测试可以直接读写原始键（造旧索引夹具）。
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
require(path.join(__dirname, '..', 'js', 'store.js'));
require(path.join(__dirname, '..', 'js', 'search.js'));

const Store = (global.IR || {}).Store;
const Search = (global.IR || {}).Search;
if (!Store) {
  console.error('加载失败：IR.Store 缺失');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}
const KEYS = Store.KEYS;

/* ---------------- 1. saveStory 索引条目 ---------------- */

{
  const st = Store.newStory({ title: '雨夜便利店', mode: 'chat' });
  st.turn = 3;
  st.log.push({ type: 'narration', text: '门铃响了，店员抬头看了一眼。', versions: ['门铃响了，店员抬头看了一眼。'], activeVersion: 0, ts: 1 });
  check('newStory：chat 默认 titleAuto=true、标题「新对话」',
    st.titleAuto === true && (st.title === '新对话' || st.title === '雨夜便利店'),   // 传了 title 就用传的
    'title=' + st.title + ' titleAuto=' + st.titleAuto);
  const okSave = Store.saveStory(st);
  const entry = Store.listIndex().find(x => x.id === st.id);
  check('saveStory：索引条目含 mode / turn / titleAuto / snippet',
    okSave && entry && entry.mode === 'chat' && entry.turn === 3
      && entry.titleAuto === true && typeof entry.snippet === 'string' && entry.snippet.length > 0,
    JSON.stringify(entry));
  check('saveStory：snippet 取最近一条旁白纯文本',
    entry.snippet === '门铃响了，店员抬头看了一眼。', entry.snippet);

  // 剧情模式助手 JSON：snippet 剥掉 JSON
  const st2 = Store.newStory({ title: '剧情', mode: 'choice' });
  st2.turn = 1;
  st2.tree = {
    v: 3, root: 'n0', head: 'n0',
    nodes: {
      n0: {
        id: 'n0', parent: null, children: [], kind: 'turn',
        action: { type: 'player', text: '推开门', kind: 'do', sent: '（做）推开门' },
        userMsg: { role: 'user', content: '[玩家行动]（做）推开门' },
        assistantMsg: { role: 'assistant', content: JSON.stringify({ narration: '货架尽头有一张旧照片。', choices: ['捡起', '走开'] }) },
        entries: [{ type: 'narration', text: '货架尽头有一张旧照片。', nid: 'n0', ts: 1 }],
        sealed: true, turn: 1, ts: 1,
      },
    },
  };
  Store.saveStory(st2);
  const entry2 = Store.listIndex().find(x => x.id === st2.id);
  check('saveStory：剧情 JSON 的 snippet 是旁白纯文本（不带 {"narration"）',
    entry2.snippet === '货架尽头有一张旧照片。' && entry2.snippet.indexOf('narration') < 0, entry2.snippet);
  check('saveStory：剧情新故事 titleAuto=false',
    entry2.titleAuto === false && entry2.mode === 'choice');
}

/* ---------------- 2. 旧索引迁移（幂等） ---------------- */

{
  // 旧格式夹具：缺 mode / turn / titleAuto / snippet；一条空标题；一条坏条目；一条故事已丢失
  const st = Store.newStory({ title: '旧对话', mode: 'chat' });
  st.titleAuto = false;
  st.turn = 5;
  st.log.push({ type: 'narration', text: '旧档里的一句旁白。', versions: ['旧档里的一句旁白。'], activeVersion: 0, ts: 1 });
  Store.saveStory(st);
  // 把索引改回旧格式（模拟老版本写的索引）
  const oldIdx = [
    { id: st.id, title: '旧对话', updatedAt: 111, thumb: null },                  // 缺字段
    { id: 'gone-id', title: '丢了的故事', updatedAt: 222, thumb: null },          // 故事已不存在
    { title: '', updatedAt: 333 },                                                // 坏条目（无 id）
  ];
  localStorage.setItem(KEYS.index, JSON.stringify(oldIdx));

  const r1 = Store.ensureIndexComplete();
  check('迁移：旧索引补齐 1 条（缺字段的那条）',
    r1.patched === 1 && r1.total === 3, JSON.stringify(r1));
  check('迁移：异常条目被如实记录（无 id / 故事丢失）',
    r1.anomalies.length === 2 && r1.anomalies.some(a => a.reason === 'bad-entry')
      && r1.anomalies.some(a => a.reason === 'missing-story'),
    JSON.stringify(r1.anomalies));
  const idxAfter = Store.listIndex();
  const patched = idxAfter.find(x => x.id === st.id);
  check('迁移：补齐后条目含 mode / turn / titleAuto / snippet',
    patched && patched.mode === 'chat' && patched.turn === 5 && patched.titleAuto === false
      && patched.snippet === '旧档里的一句旁白。',
    JSON.stringify(patched));
  check('迁移：坏条目与丢失故事从索引剔除',
    idxAfter.length === 1 && idxAfter[0].id === st.id, JSON.stringify(idxAfter.map(x => x && x.id)));

  const snap = JSON.stringify(Store.listIndex());
  const r2 = Store.ensureIndexComplete();
  check('迁移：再跑一次是空操作（幂等）',
    r2.patched === 0 && r2.anomalies.length === 0 && JSON.stringify(Store.listIndex()) === snap,
    JSON.stringify(r2));
}

/* ---------------- 3. deleteStory 清理 ---------------- */

{
  const st = Store.newStory({ title: '要删的', mode: 'chat' });
  st.log.push({ type: 'narration', text: '这段待会就没了。', versions: ['这段待会就没了。'], activeVersion: 0, ts: 1 });
  Store.saveStory(st);
  Search.index.upsert(st);
  check('删除前：索引与搜索文档都在',
    Store.listIndex().some(x => x.id === st.id) && Search.index.has(st.id));
  Store.deleteStory(st.id);
  check('deleteStory：索引同步清理',
    !Store.listIndex().some(x => x.id === st.id));
  check('deleteStory：搜索文档同步清理',
    !Search.index.has(st.id) && Search.query(Search.index.docs(), '没了').length === 0);
  check('deleteStory：存档本体已删',
    Store.loadStory(st.id) == null);
}

/* ---------------- 4. titleAuto 默认值 ---------------- */

{
  check('newStory：chat / rp 默认 titleAuto=true',
    Store.newStory({ mode: 'chat' }).titleAuto === true && Store.newStory({ mode: 'rp' }).titleAuto === true);
  check('newStory：choice 默认 titleAuto=false',
    Store.newStory({ mode: 'choice' }).titleAuto === false);
  const old = Store.migrateStory({
    id: 'legacy', title: '旧档', mode: 'chat', createdAt: 1, updatedAt: 1,
    log: [], messages: [], turn: 2,
  });
  check('migrateStory：旧档 titleAuto=false（保留现有标题）',
    old.titleAuto === false && old.title === '旧档' && old.titleGen === 0,
    JSON.stringify({ t: old.title, a: old.titleAuto }));
  const newer = Store.migrateStory({ id: 'n1', title: 'x', mode: 'chat', titleAuto: true, titleGen: 1 });
  check('migrateStory：存档里显式的 titleAuto / titleGen 沿用',
    newer.titleAuto === true && newer.titleGen === 1);
}

/* ---------------- 报告 ---------------- */

let fails = 0;
for (const r of results) {
  if (r.hit) console.log('  ok  ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  else { console.error('  FAIL ' + r.name + (r.detail ? '  [' + r.detail + ']' : '')); fails++; }
}
if (fails) {
  console.error('shelf-index-test：' + fails + ' 项未通过');
  process.exit(1);
}
console.log('shelf-index-test：全部通过（' + results.length + ' 项）');
