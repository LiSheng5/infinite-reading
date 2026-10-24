/*
 * 无限阅读 · 全文搜索（IR.Search，纯逻辑，Node 可测，UI-2 §3.4）
 *
 * 职责：
 *   buildDoc(story)      故事 → 搜索文档（含全部分支节点；文本已规整）
 *   query(docs, q, opts) 子串匹配 + AND 多词 + 评分排序；命中片段带 ranges（不是 HTML）
 *   createIndex()        内存索引（增量重建 / 删除），默认单例 IR.Search.index
 *   notifySave(story)    saveStory 后防抖（约 800ms）增量重建该 id
 *   drop(id)             deleteStory 同步移除
 *
 * 硬约束：零依赖、无 DOM、无网络；输出里不含任何 HTML（高亮由 UI 用 createElement('mark') 做）；
 * 规整统一 NFKC + 小写 + 折叠空白（中文可用，子串匹配、不分词）。
 */
(function (global) {
  'use strict';

  var IR = global.IR || {};

  /* ---------------- 规整（NFKC / 小写 / 折叠空白） ---------------- */

  // 带偏移映射的规整：norm[i] 对应原文 raw[map[i] .. mapEnd[i])。
  // 标题高亮要映射回原文下标；片段直接在规整文本上切，ranges 与片段自洽。
  function normWithMap(s) {
    var raw = String(s == null ? '' : s);
    var out = '';
    var map = [];
    var mapEnd = [];
    var i = 0;
    var prevSpace = false;
    while (i < raw.length) {
      var cp = raw.codePointAt(i);
      var ch = String.fromCodePoint(cp);
      var adv = ch.length;
      var n = ch.normalize('NFKC').toLowerCase();
      var isSpace = /^\s$/.test(n);
      if (isSpace) {
        if (!out.length || prevSpace) { i += adv; continue; }   // 首部 / 连续空白折叠
        n = ' ';
        prevSpace = true;
      } else {
        prevSpace = false;
      }
      for (var k = 0; k < n.length; k++) {
        out += n.charAt(k);
        map.push(i);
        mapEnd.push(i + adv);
      }
      i += adv;
    }
    if (out.length && out.charAt(out.length - 1) === ' ') {
      out = out.slice(0, -1);
      map.pop();
      mapEnd.pop();
    }
    return { text: out, map: map, mapEnd: mapEnd };
  }

  function normalize(s) { return normWithMap(s).text; }

  /* ---------------- 纯文本提取（剥 JSON 与标记） ---------------- */

  // 助手回复 → 纯文本：唯一实现在 IR.plainReply（tree.js，审查 可维护性 三·4）。
  // store.js 的书架摘要共用同一口径，schema 演进只改一处；tree.js 必须先加载，缺了直接报错不静默降级
  const plainReply = (global.IR && global.IR.plainReply) || function () {
    throw new Error('IR.plainReply 未加载：tree.js 必须先于 search.js（见 ARCHITECTURE 加载顺序）');
  };

  // 玩家行动文本：去掉 [玩家行动] / [设定] 标记
  function plainAction(raw) {
    return String(raw == null ? '' : raw)
      .replace(/^\[设定\][\s\S]*?\n\n/, '')
      .replace(/^\[玩家行动\]\s*/, '');
  }

  /* ---------------- buildDoc：遍历全部节点（含非当前分支） ----------------
   * → { id, title, mode, updatedAt, nodes:[{ nid, text }] }；text 已规整。
   */
  function buildDoc(story) {
    var id = (story && story.id) || '';
    var title = String((story && story.title) || '');
    var mode = (story && story.mode) || 'choice';
    var updatedAt = +((story && story.updatedAt)) || 0;
    var nodes = [];

    var tree = story && story.tree;
    var table = tree && tree.nodes && typeof tree.nodes === 'object' ? tree.nodes : null;
    if (table) {
      Object.keys(table).forEach(function (nid) {
        var node = table[nid];
        if (!node) return;
        var parts = [];
        if (node.action && node.action.text) parts.push(plainAction(node.action.text));
        var reply = '';
        if (node.assistantMsg && node.assistantMsg.content != null) {
          reply = plainReply(node.assistantMsg.content);
        }
        if (reply) {
          parts.push(reply);
        } else if (Array.isArray(node.entries)) {
          // 兜底：没有 assistantMsg 时用条目文本（旁白 + 玩家话）
          node.entries.forEach(function (e) {
            if (!e || typeof e !== 'object') return;
            if ((e.type === 'narration' || e.type === 'player' || e.type === 'choice') && e.text) {
              parts.push(String(e.text));
            }
          });
        }
        var text = normalize(parts.join('\n'));
        if (text) nodes.push({ nid: String(nid), text: text });
      });
    } else if (story) {
      // 无树旧档：按 log 条目退化成节点（nid 尽量带上，供 UI 滚动定位）
      (Array.isArray(story.log) ? story.log : []).forEach(function (e, i) {
        if (!e || typeof e !== 'object') return;
        if (e.type !== 'narration' && e.type !== 'player' && e.type !== 'choice') return;
        var text = normalize(plainAction(e.text || ''));
        if (text) nodes.push({ nid: String(e.nid || ('log' + i)), text: text });
      });
    }

    return { id: id, title: title, mode: mode, updatedAt: updatedAt, nodes: nodes };
  }

  /* ---------------- query：子串匹配、AND、评分、片段 ----------------
   * 评分：标题命中权重 ×5；正文命中次数封顶（每词最多 3 次）；同分按 updatedAt 新到旧。
   * 每个结果最多 2 个命中片段（opts.maxHits）；片段取首个命中点前后各约 30 字；
   * ranges 是片段内的 [start,end] 数组；输出不含任何 HTML。
   */
  function query(docs, q, opts) {
    opts = opts || {};
    var maxHits = opts.maxHits == null ? 2 : +opts.maxHits;
    var limit = opts.limit == null ? 50 : +opts.limit;
    var terms = normalize(q).split(' ').filter(Boolean);
    if (!terms.length || !Array.isArray(docs)) return [];

    var out = [];
    for (var d = 0; d < docs.length; d++) {
      var doc = docs[d];
      if (!doc || !doc.id) continue;
      var tN = normWithMap(doc.title || '');
      var score = 0;
      var titleTerms = 0;
      var matched = 0;
      var termHit = [];   // 每个词的正文命中位置（按节点）
      for (var t = 0; t < terms.length; t++) {
        var term = terms[t];
        var inTitle = tN.text.indexOf(term) >= 0;
        var count = 0;
        var spots = [];
        var nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
        for (var n = 0; n < nodes.length; n++) {
          var nt = String((nodes[n] && nodes[n].text) || '');
          var pos = nt.indexOf(term);
          if (pos < 0) continue;
          spots.push({ nid: nodes[n].nid, text: nt, pos: pos });
          while (pos >= 0) { count++; pos = nt.indexOf(term, pos + term.length); }
        }
        termHit.push({ term: term, inTitle: inTitle, spots: spots });
        if (inTitle || count > 0) matched++;
        if (inTitle) titleTerms++;
        score += (inTitle ? 5 : 0) + Math.min(count, 3);
      }
      if (matched < terms.length) continue;   // AND：每个词都要命中

      // 标题高亮：全部词在标题里的命中区间，映射回原文下标
      var titleRanges = [];
      for (var h = 0; h < termHit.length; h++) {
        if (!termHit[h].inTitle) continue;
        var term2 = termHit[h].term;
        var p = tN.text.indexOf(term2);
        while (p >= 0) {
          titleRanges.push([tN.map[p], tN.mapEnd[p + term2.length - 1]]);
          p = tN.text.indexOf(term2, p + term2.length);
        }
      }
      titleRanges.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
      titleRanges = mergeRanges(titleRanges);

      // 命中片段：按节点顺序取前 maxHits 个含词的节点
      var hits = [];
      var seenNid = {};
      for (var s = 0; s < termHit.length && hits.length < maxHits; s++) {
        var spots2 = termHit[s].spots;
        for (var k = 0; k < spots2.length && hits.length < maxHits; k++) {
          var sp = spots2[k];
          if (seenNid[sp.nid]) continue;
          seenNid[sp.nid] = 1;
          var snip = makeSnippet(sp.text, sp.pos, termHit[s].term.length, termHit.map(function (x) { return x.term; }));
          hits.push({ nid: sp.nid, snippet: snip.text, ranges: snip.ranges });
        }
      }

      out.push({ id: doc.id, score: score, titleRanges: titleRanges, hits: hits });
    }

    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var ua = 0, ub = 0;
      for (var i = 0; i < docs.length; i++) {
        if (docs[i] && docs[i].id === a.id) ua = +docs[i].updatedAt || 0;
        if (docs[i] && docs[i].id === b.id) ub = +docs[i].updatedAt || 0;
      }
      return ub - ua;
    });
    return out.slice(0, limit);
  }

  // 片段：首个命中点前后各约 30 字；ranges 为片段内全部词命中的 [start,end]
  function makeSnippet(text, pos, firstLen, terms) {
    var start = Math.max(0, pos - 30);
    var end = Math.min(text.length, pos + firstLen + 30);
    var snip = text.slice(start, end);
    var ranges = [];
    for (var i = 0; i < terms.length; i++) {
      var term = terms[i];
      var p = snip.indexOf(term);
      while (p >= 0) {
        ranges.push([p, p + term.length]);
        p = snip.indexOf(term, p + term.length);
      }
    }
    ranges.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    return { text: snip, ranges: mergeRanges(ranges) };
  }

  function mergeRanges(rs) {
    var out = [];
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i];
      if (!r || r[1] <= r[0]) continue;
      var last = out[out.length - 1];
      if (last && r[0] < last[1]) {   // 只合重叠，不合相邻：每个区间都要能对回命中词
        if (r[1] > last[1]) last[1] = r[1];
      } else {
        out.push([r[0], r[1]]);
      }
    }
    return out;
  }

  /* ---------------- 内存索引（不持久化，§3.4） ---------------- */

  function createIndex() {
    var map = new Map();
    var api = {
      stats: { builds: 0 },
      upsert: function (story) {
        if (!story || !story.id) return null;
        var doc = buildDoc(story);
        map.set(story.id, doc);
        api.stats.builds += 1;
        return doc;
      },
      remove: function (id) { map.delete(id); },
      has: function (id) { return map.has(id); },
      get: function (id) { return map.get(id); },
      docs: function () { return Array.from(map.values()); },
      clear: function () { map.clear(); },
      size: function () { return map.size; },
    };
    return api;
  }

  var index = createIndex();

  // saveStory 后的增量重建：防抖约 800ms（同一 id 连续保存只重建一次）
  var timers = new Map();
  function notifySave(story) {
    if (!story || !story.id) return;
    var id = story.id;
    if (timers.has(id)) clearTimeout(timers.get(id));
    timers.set(id, setTimeout(function () {
      timers.delete(id);
      index.upsert(story);
    }, 800));
  }

  function drop(id) {
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    index.remove(id);
  }

  IR.Search = {
    normalize: normalize,
    normWithMap: normWithMap,
    plainReply: plainReply,
    buildDoc: buildDoc,
    query: query,
    createIndex: createIndex,
    index: index,
    notifySave: notifySave,
    drop: drop,
  };
  global.IR = IR;
})(typeof window !== 'undefined' ? window : global);
