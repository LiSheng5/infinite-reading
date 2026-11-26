#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 手动压缩门禁（不联网、不开浏览器）
 *
 * 守两部分：
 *   A. force 口径（Context.compressStory）
 *     1. 忽略两个自动触发条件：远低于 70% 阈值 / 积压未超 16 条时也照压；
 *     2. 保留条数成对（偶数）、最少 2 条，默认 DEFAULT_KEEP_MESSAGES；
 *     3. 可压内容为空（消息不足 keep 条 / 没有 story）→ 返回 null，不动摘要栈。
 *   B. compactNow 编排（src/app/compact.js）
 *     4. 前置检查：无故事 / busy / head 非叶子 / 无可压内容，各自被拒且 S.busy 不残留；
 *     5. 本地兜底：只留最近 keep 条、摘要栈增长、留痕进 head.entries、resyncHead 重算窗口；
 *     6. 撤销：还原 messages / summaries / world，切分支再切回状态一致；
 *     7. 书记员可用走双职、失败自动退回本地并留 error 痕迹；
 *     8. 异步写回契约：等书记员期间换故事 → 丢弃结果、不落盘。
 *
 * 用法：node eval/compact-test.js
 */
const path = require('path');
const H = require('./_harness.js');
const ROOT = path.join(__dirname, '..');
const core = (f) => require(path.join(ROOT, 'src', 'core', f + '.ts'));

const { Context } = core('context');
const { Tree: T } = core('tree');

/* ---------- 夹具：mode 决定切幕口径（choice 按 scene_change，chat 按固定条数） ---------- */
function newStory(mode, n) {
  const story = {
    schema: 3, id: 'compact-story', title: '测试', premise: '在雨夜的车站。',
    mode: mode || 'choice',
    log: [], messages: [], scenes: [], summaries: [],
    world: { place: '雨夜车站', time: '凌晨', characters: [], threads: [], relationship: { stage: '', bonds: [], notes: '' }, scene: '' },
    ui: {}, prefs: {}, turn: 0, userProfile: [],
  };
  for (let i = 1; i <= (n || 0); i++) {
    story.messages.push({ role: 'user', content: '行动 ' + i });
    story.messages.push({
      role: 'assistant',
      content: JSON.stringify({ narration: '第 ' + i + ' 幕旁白', choices: [], scene_change: i % 3 === 0, scene_summary: '' }),
    });
  }
  return story;
}

/* ---------- app 层夹具：模拟 round.js 的一回合（begin → commit → seal） ---------- */
function playTurn(story, text, narration) {
  const mark = T.begin(story);
  story.log.push({ type: 'player', text: text, kind: 'do', ts: 1 });
  const um = { role: 'user', content: '[玩家行动]（做）' + text };
  const am = { role: 'assistant', content: JSON.stringify({ narration: narration, choices: [] }) };
  story.turn += 1;
  story.log.push({ type: 'narration', text: narration, versions: [narration], activeVersion: 0, ts: 2 });
  story.messages.push(um, am);
  const node = T.commit(story, {
    action: { type: 'player', text: text, kind: 'do', sent: '（做）' + text },
    userMsg: um, assistantMsg: am, logMark: mark.logMark,
  });
  T.seal(story, node.id);
  return node;
}

function retryTurn(story, text, narration) {
  const head = story.tree.nodes[story.tree.head];
  story.tree.head = head.parent;
  T.project(story);
  return playTurn(story, text, narration);
}

async function main() {
  /* ---------- 1. force：低于阈值、积压不足也压 ---------- */
  {
    // 窗口 1,000,000 → 阈值 700,000，20 条消息远未超；条数 20 > 16 会走自动触发，这里用 16 条
    const plain = newStory('choice', 8);                       // 16 条 = 默认 maxMessages 上限，不触发
    H.check('对照：16 条 + 大窗口不传 force → null', Context.compressStory(plain, { contextWindow: 1000000 }) === null);

    const forced = newStory('choice', 8);
    const r = Context.compressStory(forced, { contextWindow: 1000000, force: true });
    H.check('force 低于阈值也压（大窗口）',
      !!r && r.compressedTurns > 0 && r.messagesRemoved === 8, JSON.stringify(r));
    H.check('force 后 messages 只剩最近 keep 条',
      forced.messages.length === Context.DEFAULT_KEEP_MESSAGES, forced.messages.length);
    H.check('force 后摘要栈 = 压入幕数',
      forced.summaries.length === r.compressedTurns && forced.summaries.length > 0, forced.summaries.length);
    H.check('force 留下的消息是最近的（尾部对齐）',
      forced.messages[0].content === '行动 5', forced.messages[0].content);

    const unknownWin = newStory('choice', 8);
    const ru = Context.compressStory(unknownWin, { force: true });
    H.check('force 窗口未知也压', !!ru && ru.messagesRemoved === 8, JSON.stringify(ru));
  }

  /* ---------- 2. 保留条数：默认 8、成对、最少 2 ---------- */
  {
    const cases = [
      [undefined, 8], [8, 8], [12, 12], [5, 4], [9, 8], [1, 2], [0, 2],
    ];
    for (const [keep, want] of cases) {
      const st = newStory('choice', 15);                       // 30 条，足够压
      Context.compressStory(st, { force: true, keepMessages: keep });
      H.check('keepMessages=' + String(keep) + ' → 保留 ' + want + ' 条',
        st.messages.length === want && want % 2 === 0, st.messages.length);
    }
    const short = newStory('chat', 10);                        // 20 条，keep=3 → 2
    Context.compressStory(short, { force: true, keepMessages: 3 });
    H.check('keep 保证成对（chat 模式 keep=3 → 2）', short.messages.length === 2, short.messages.length);
  }

  /* ---------- 3. 可压内容为空 → null ---------- */
  {
    const equal = newStory('choice', 4);                       // 8 条 = 默认 keep
    const before = JSON.stringify({ m: equal.messages.length, s: equal.summaries.length });
    H.check('消息恰为 keep 条 → null', Context.compressStory(equal, { force: true }) === null);
    H.check('无可压内容时不改摘要栈',
      JSON.stringify({ m: equal.messages.length, s: equal.summaries.length }) === before);

    const fewer = newStory('chat', 2);                         // 4 条 < 8
    H.check('消息少于 keep 条 → null', Context.compressStory(fewer, { force: true }) === null);

    const keepAll = newStory('choice', 10);                    // 20 条，keep=20
    H.check('keep ≥ 消息条数 → null', Context.compressStory(keepAll, { force: true, keepMessages: 20 }) === null);

    H.check('没有 story → null', Context.compressStory(null, { force: true }) === null);
    H.check('messages 不是数组 → null', Context.compressStory({ summaries: [] }, { force: true }) === null);
  }

  /* ---------- 4. 自动触发口径未被 force 改动 ---------- */
  {
    const auto = newStory('choice', 9);                        // 18 条 > 16
    const r = Context.compressStory(auto, { contextWindow: 0 });
    H.check('对照：不传 force 时积压 18 条照旧自动压', !!r && r.messagesRemoved > 0, JSON.stringify(r));
    H.check('对照：自动压缩保留条数 ≥ force 的下限 2', auto.messages.length >= 2, auto.messages.length);
  }

  /* ---------- 5. compactNow 编排（app 层：只加载 core.js + compact.js，晚绑定依赖给桩） ---------- */
  // toast 需要 DOM：给每个选择器一个惰性假元素（classList / textContent 可写即可）
  const fakeEl = () => ({
    textContent: '', onclick: null, hidden: false,
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, getAttribute() { return null; },
  });
  const els = new Map();
  global.document = {
    querySelector: (s) => { if (!els.has(s)) els.set(s, fakeEl()); return els.get(s); },
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener: () => {},
    hidden: false,
  };
  if (!global.navigator) global.navigator = { userAgent: 'node' };
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const { A } = require(path.join(ROOT, 'src', 'app', 'core.js'));
  require(path.join(ROOT, 'src', 'app', 'compact.js'));
  // 本测试不加载 render / turn：compact.js 经 A 晚绑定取用的依赖在这里给桩
  A.renderChat = () => {};
  A.treeHeadNodeId = () => A.state.story.tree.head;
  A.applyProfileEntries = () => {};
  A.scribeUsable = () => false;
  A.buildAssembleOpts = () => ({ asmOpts: {} });   // toast 的「约 A → B token」估算（round.js 不在本测试）
  const S = A.state;
  const mk = (id) => { const s = newStory('choice', 0); s.id = id; return s; };
  const snap = (s) => JSON.stringify({ m: s.messages, s: s.summaries, w: s.world });

  /* 5.1 前置检查：四种拒绝理由，且 S.busy 不残留 */
  {
    S.busy = false;
    S.story = null;
    let r = await A.compactNow();
    H.check('compactNow 无故事 → 拒绝「未进入故事」',
      r.ok === false && r.reason === '未进入故事' && S.busy === false, JSON.stringify(r));
    H.check('compactStatus 同因（无故事）', A.compactStatus().reason === '未进入故事', A.compactStatus().reason);

    const busy = mk('busy-story');
    T.ensure(busy);
    S.story = busy;
    S.busy = true;
    r = await A.compactNow();
    H.check('compactNow busy → 拒绝「正在生成」且不清别人占的 busy',
      r.ok === false && r.reason === '正在生成' && S.busy === true, JSON.stringify(r));
    H.check('compactStatus 同因（正在生成）', A.compactStatus().reason === '正在生成', A.compactStatus().reason);
    S.busy = false;

    const hist = mk('hist-story');
    const first = playTurn(hist, '一', '甲');
    playTurn(hist, '二', '乙');
    S.story = hist;
    hist.tree.head = first.id;
    T.project(hist);
    r = await A.compactNow();
    H.check('compactNow head 非叶子 → 拒绝「当前在历史位置，先回到最新」',
      r.ok === false && r.reason === '当前在历史位置，先回到最新' && S.busy === false, JSON.stringify(r));
    H.check('compactStatus 同因（历史位置）', A.compactStatus().reason === '当前在历史位置，先回到最新', A.compactStatus().reason);

    const empty = mk('empty-story');
    T.ensure(empty);
    S.story = empty;
    r = await A.compactNow();
    H.check('compactNow 无可压内容 → 拒绝「没有可压的内容」',
      r.ok === false && r.reason === '没有可压的内容' && S.busy === false, JSON.stringify(r));
    H.check('compactStatus 同因（无可压）+ 本地路径标注',
      A.compactStatus().reason === '没有可压的内容' && A.compactStatus().path === 'local', A.compactStatus().reason);
  }

  /* 5.2 本地兜底：只留 keep 条、摘要栈增长、留痕走 pushLate、resyncHead 重算窗口 */
  {
    const st = mk('local-story');
    for (let i = 1; i <= 6; i++) playTurn(st, '行动' + i, '第' + i + '幕');
    S.story = st;
    S.busy = false;
    const beforeM = st.messages.length;
    const beforeS = st.summaries.length;
    const r = await A.compactNow();
    const toastText = document.querySelector('#toast-text').textContent;
    const toastAct = document.querySelector('#toast-action');
    H.check('完成提示 = 幕数 + 路径 + 约 A → B token',
      /^已压缩 \d+ 幕（本地摘要，质量较低），约 [\d,]+ → [\d,]+ token$/.test(toastText), toastText);
    H.check('toast 带「撤销」动作', toastAct.textContent === '撤销', toastAct.textContent);
    A.hideToast();
    H.check('compactNow 本地路径成功并返回计数',
      r.ok === true && r.path === 'local' && r.compressedTurns > 0 && r.messagesRemoved > 0, JSON.stringify(r));
    H.check('本地压缩后只留最近 keep 条 / 摘要栈增长',
      st.messages.length === Context.DEFAULT_KEEP_MESSAGES && st.summaries.length > beforeS,
      st.messages.length + ' / ' + st.summaries.length);
    const head = st.tree.nodes[st.tree.head];
    H.check('压缩留痕走 pushLate（进 head.entries 与 story.log）',
      head.entries.some(e => e.tool === 'compress') && st.log.some(e => e.tool === 'compress'));
    H.check('压缩后 resyncHead 重算了窗口（msgFloor=2）', head.msgFloor === 2, head.msgFloor);
    H.check('执行后 S.busy 已清', S.busy === false);

    const beforeSnap = snap(st);                                // 压缩后（供撤销对照）
    H.check('compactUndo 还原 messages / summaries / world',
      (() => {
        const ok = A.compactUndo();
        A.hideToast();
        return ok === true && st.messages.length === beforeM && st.summaries.length === beforeS
          && S.busy === false && JSON.stringify({ m: st.messages, s: st.summaries, w: st.world }) !== beforeSnap;
      })(), st.messages.length + ' / ' + st.summaries.length);
  }

  /* 5.3 撤销 + 切分支往返：还原完整投影 */
  {
    const br = mk('branch-story');
    for (let i = 1; i <= 5; i++) playTurn(br, '正' + i, '正幕' + i);
    const alt = retryTurn(br, '改5', '改幕5');                  // 与第 5 回合同父的兄弟分支（10 条）
    S.story = br;
    S.busy = false;
    const pre = snap(br);
    const r = await A.compactNow();
    A.hideToast();
    const post = snap(br);
    H.check('兄弟分支上可压缩', r.ok === true && br.messages.length === Context.DEFAULT_KEEP_MESSAGES, JSON.stringify(r));
    T.switchSibling(br, alt.id, -1);                            // 切到原分支
    T.switchSibling(br, br.tree.head, 1);                       // 再切回压缩过的分支
    H.check('压缩后切分支再切回，状态一致', snap(br) === post);
    H.check('compactUndo 后还原压缩前投影', (() => {
      const ok = A.compactUndo();
      A.hideToast();
      return ok === true && snap(br) === pre;
    })());
    T.switchSibling(br, br.tree.head, -1);
    T.switchSibling(br, br.tree.head, 1);
    H.check('撤销后切分支再切回，状态一致', snap(br) === pre);
  }

  /* 5.4 书记员可用 → 双职；失败 → 本地兜底并留 error 痕迹 */
  {
    const sc = mk('scribe-story');
    for (let i = 1; i <= 6; i++) playTurn(sc, '行动' + i, '第' + i + '幕');
    S.story = sc;
    S.busy = false;
    A.scribeUsable = () => true;
    let midStatus = null;
    A.scribeCompress = async () => {
      midStatus = A.compactStatus();                            // 等书记员期间按钮应显示「压缩中…」
      return { parsed: { summaries: ['【书记员】摘要'], world: null, profile: [] }, err: '' };
    };
    let r = await A.compactNow();
    A.hideToast();
    H.check('书记员可用 → 走书记员并压入其摘要',
      r.ok === true && r.path === 'scribe' && sc.summaries.indexOf('【书记员】摘要') >= 0
        && sc.messages.length === Context.DEFAULT_KEEP_MESSAGES, JSON.stringify(r));
    H.check('执行中 compactStatus.running=true 且不可再点',
      !!midStatus && midStatus.running === true && midStatus.ok === false, JSON.stringify(midStatus));
    H.check('书记员可用时按钮标注书记员路径', A.compactStatus().path === 'scribe', A.compactStatus().path);

    const fb = mk('fallback-story');
    for (let i = 1; i <= 6; i++) playTurn(fb, '行动' + i, '第' + i + '幕');
    S.story = fb;
    A.scribeCompress = async () => ({ parsed: null, err: '模拟超时' });
    r = await A.compactNow();
    A.hideToast();
    H.check('书记员失败 → 本地兜底且标明 fallback',
      r.ok === true && r.path === 'local' && r.fallback === true
        && fb.messages.length === Context.DEFAULT_KEEP_MESSAGES, JSON.stringify(r));
    H.check('降级留痕带 error（可观测）', fb.log.some(e => e.tool === 'compress' && !!e.error));

    /* 5.5 异步写回契约：等书记员期间换故事 → 丢弃结果、不落盘 */
    const a = mk('switch-a');
    const b = mk('switch-b');
    for (let i = 1; i <= 6; i++) playTurn(a, '甲' + i, '甲幕' + i);
    for (let i = 1; i <= 6; i++) playTurn(b, '乙' + i, '乙幕' + i);
    S.story = a;
    A.scribeCompress = async () => {
      S.story = b;                                              // 用户等书记员时切了故事
      return { parsed: { summaries: ['不该落盘'], world: null, profile: [] }, err: '' };
    };
    const aM = a.messages.length;
    const bM = b.messages.length;
    r = await A.compactNow();
    A.hideToast();
    H.check('等书记员期间换故事 → 丢弃结果、不落盘',
      r.ok === false && a.messages.length === aM && b.messages.length === bM
        && !a.log.some(e => e.tool === 'compress') && !b.log.some(e => e.tool === 'compress'),
      JSON.stringify(r));
    A.scribeUsable = () => false;
  }
}

H.run('手动压缩（force + compactNow）门禁', main);
