#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 上下文用量描述门禁（不联网、不开浏览器）
 *
 * 守四件事：
 *   1. level 边界：ok / warn / over 恰在边界上逐个判定；窗口未知 → unknown；三种模式都算得出；
 *   2. tokens 与 estimateTokensOf(assembleAI1(story, '', opts)) 逐字一致（估算与实发同源）；
 *   3. dry 零副作用：buildAssembleOpts('', { dry: true }) 前后 S.pendingInject、
 *      S.turnUsage、story.log.length 不变（指示器只读，绝不消费 🧠 一次性开关、不留痕）；
 *   4. memo：key 不变不重算、key 变了才重算，key 对每个输入逐项敏感。
 *
 * 用法：node eval/ctxusage-test.js
 */
const path = require('path');
const H = require('./_harness.js');
const ROOT = path.join(__dirname, '..');
const core = (f) => require(path.join(ROOT, 'src', 'core', f + '.ts'));

const { describeContextUsage, usageMemoKey, describeContextUsageCached } = core('ctxusage');
const { Context } = core('context');

/* ---------- 夹具：能被 assembleAI1 完整吃下的最小 story ---------- */
function newStory(mode) {
  return {
    schema: 3, id: 'ctx-story', title: '测试', premise: '在雨夜的车站。',
    mode: mode,
    log: [], messages: [], scenes: [], summaries: [],
    world: {
      place: '雨夜车站', time: '凌晨',
      characters: [{ name: '艾莉', presence: '在场', personality: '安静', speech: '轻声' }],
      threads: [], relationship: { stage: '', bonds: [], notes: '' }, scene: '',
    },
    ui: {}, prefs: {}, turn: 0, userProfile: [],
  };
}

// 用中文填充把 tokens 精确顶到 target：同一消息槽里加 N 个非 ASCII 字符，估算正好 +N
// （estimateTokens 里中文 1 字 = 1 token；先垫一条空消息把槽位与连接符固定下来）
function padToTarget(story, opts, target) {
  story.messages.push({ role: 'user', content: '' });
  const base = describeContextUsage(story, opts).tokens;
  const n = target - base;
  if (n <= 0) throw new Error('目标低于基线：target=' + target + ' base=' + base);
  story.messages[story.messages.length - 1].content = '中'.repeat(n);
  return describeContextUsage(story, opts);
}

function main() {
  /* ---------- 1. level 边界 ---------- */
  // 窗口 20000 → 阈值 14000 → warn 线 = 85% × 阈值 = 11900（整数边界，浮点不抖）
  const CW = 20000;
  const TH = Context.compressThreshold(CW);
  const WARN_LINE = Math.ceil(TH * 17 / 20);
  H.check('阈值口径 = compressThreshold（不另写一套）', TH === 14000 && WARN_LINE === 11900, 'th=' + TH + ' warn=' + WARN_LINE);
  for (const mode of ['choice', 'chat', 'rp']) {
    for (const [target, level] of [[WARN_LINE - 1, 'ok'], [WARN_LINE, 'warn'], [TH - 1, 'warn'], [TH, 'over'], [TH + 1, 'over']]) {
      const u = padToTarget(newStory(mode), { contextWindow: CW }, target);
      H.check(mode + ' tokens=' + target + ' → ' + level,
        u.tokens === target && u.level === level,
        'tokens=' + u.tokens + ' level=' + u.level);
    }
    H.check(mode + ' ratio 与阈值线同源', (() => {
      const u = describeContextUsage(newStory(mode), { contextWindow: CW });
      return u.ratio === u.tokens / CW && u.threshold === TH && u.window === CW;
    })());
  }

  // 窗口容量未知 → unknown：只报 token 数，不画比例与阈值线
  for (const opts of [{}, { contextWindow: 0 }, { contextWindow: -1 }, { contextWindow: NaN }]) {
    const u = describeContextUsage(newStory('choice'), opts);
    H.check('窗口未知 → unknown（' + JSON.stringify(opts) + '）',
      u.level === 'unknown' && u.threshold === 0 && u.ratio === 0 && u.tokens > 0,
      JSON.stringify(u));
  }

  /* ---------- 2. tokens 与实发估算逐字一致 ---------- */
  const combos = [
    {},
    { contextWindow: 32000 },
    { contextWindow: 32000, tools: ['update_memory', 'recall_world_state'], profile: ['玩家喜欢甜食'] },
  ];
  for (const mode of ['choice', 'chat', 'rp']) {
    for (const opts of combos) {
      const st = newStory(mode);
      st.messages.push({ role: 'user', content: '走' }, { role: 'assistant', content: '{"旁白":"雨更大了。","选项":[]}' });
      st.summaries.push('【第一幕】雨夜车站｜凌晨｜发生｜伏笔：埋下「未寄出的信」');
      const u = describeContextUsage(st, opts);
      const direct = Context.estimateTokensOf(Context.assembleAI1(st, '', opts));
      H.check('tokens 同源（' + mode + ' ' + JSON.stringify(opts).slice(0, 40) + '）', u.tokens === direct, u.tokens + ' ≠ ' + direct);
    }
  }

  /* ---------- lastUsage：最近一条旁白的实报，仅说明文字 ---------- */
  {
    const st = newStory('choice');
    st.log.push(
      { type: 'narration', text: 'a', usage: { prompt: 1, completion: 1, total: 2 } },
      { type: 'tool', tool: 'recall_world_state', summary: '查阅了世界状态卡' },
      { type: 'narration', text: 'b', usage: { prompt: 10, completion: 20, total: 30 } },
    );
    H.check('lastUsage = 最近一条旁白的实报', describeContextUsage(st, {}).lastUsage.total === 30);
    st.log.push({ type: 'narration', text: 'c' });
    H.check('最近一条旁白没上报 → null（不拿旧值冒充）', describeContextUsage(st, {}).lastUsage === null);
    H.check('没有旁白条目 → null', describeContextUsage(newStory('choice'), {}).lastUsage === null);
    H.check('lastUsage 不参与 level', (() => {
      const u = describeContextUsage(newStory('choice'), { contextWindow: CW });
      return (u.level === 'ok' || u.level === 'warn' || u.level === 'over') && u.lastUsage === null;
    })());
  }

  /* ---------- 3. dry 零副作用（buildAssembleOpts 唯一口径） ---------- */
  // 指示器的组装选项来自 src/app/round.js 的 buildAssembleOpts：这里把 app 层拉起来
  // （只加载 core.js + round.js，晚绑定依赖给桩），断言 dry 路径分毫不动共享状态。
  global.window = global;
  global.document = { querySelector: () => null, addEventListener: () => {}, hidden: false };
  if (!global.navigator) global.navigator = { userAgent: 'node' };
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const { A } = require(path.join(ROOT, 'src', 'app', 'core.js'));
  require(path.join(ROOT, 'src', 'app', 'round.js'));
  // 本测试不加载 models / cards / sidecar 等模块：round.js 经 A 晚绑定取用的依赖在这里给桩
  A.noToolsFor = () => false;
  A.sidecarFeatureWhy = () => null;
  A.activeProfileEntries = () => [];
  A.chatContextWindow = () => 100000;
  A.renderInjectHint = () => {};

  const S = A.state;
  S.story = newStory('choice');
  S.story.log.push({ type: 'player', text: '艾莉在吗', kind: 'do' });   // 命中启发式所需的前置条目
  S.pendingInject = true;
  S.turnUsage = { prompt: 1, completion: 1, total: 2 };
  const anchor = S.turnAnchor;
  const model = S.turnModel;
  const logLen = S.story.log.length;

  const built = A.buildAssembleOpts('艾莉在吗', { dry: true });
  H.check('dry 前后 S.pendingInject 不变（不消费 🧠 开关）', S.pendingInject === true);
  H.check('dry 前后 S.turnUsage 不变', !!S.turnUsage && S.turnUsage.total === 2);
  H.check('dry 前后 story.log.length 不变（启发式命中也不留痕）', S.story.log.length === logLen, S.story.log.length);
  H.check('dry 不写 S.turnModel / S.turnAnchor', S.turnModel === model && S.turnAnchor === anchor);
  H.check('dry 的估算照样把 🧠 记忆块算进下一轮基线', built.asmOpts.forceInject === true);
  H.check('dry 返回的组装选项是真选项', built.asmOpts.contextWindow === 100000 && built.toolsOn === true && Array.isArray(built.tools)
    && built.asmOpts.dry === undefined, JSON.stringify(Object.keys(built.asmOpts)));

  // 对照：真发路径照旧消费开关并留痕（证明上面的断言不是空跑）
  A.buildAssembleOpts('艾莉在吗', {});
  H.check('真发路径照旧消费 🧠 开关并留痕', S.pendingInject === false && S.story.log.length === logLen + 2, S.story.log.length);

  /* ---------- 4. memo ---------- */
  {
    const st = newStory('choice');
    const opts = { contextWindow: 32000, tools: ['update_memory'], profile: ['喜欢甜食'] };
    const k1 = usageMemoKey(st, 'n1', opts);
    const v1 = describeContextUsageCached(k1, st, opts);
    const v1b = describeContextUsageCached(k1, st, opts);
    H.check('key 不变不重算（缓存原样返回）', v1 === v1b);
    const k2 = usageMemoKey(st, 'n2', opts);
    const v2 = describeContextUsageCached(k2, st, opts);
    H.check('key 变了才重算', v2 !== v1);
    // key 对每个输入逐项敏感：故事 id / head 节点 / messages 条数 / summaries 条数 / 窗口 / 工具 / 画像
    const base = usageMemoKey(st, 'n1', opts);
    const grown = newStory('choice');
    grown.messages.push({ role: 'user', content: 'x' });
    const summed = newStory('choice');
    summed.summaries.push('s');
    const sensitive = [
      ['故事 id', usageMemoKey({ id: 'other' }, 'n1', opts)],
      ['head 节点', usageMemoKey(st, 'n2', opts)],
      ['messages 条数', usageMemoKey(grown, 'n1', opts)],
      ['summaries 条数', usageMemoKey(summed, 'n1', opts)],
      ['contextWindow', usageMemoKey(st, 'n1', { contextWindow: 64000, tools: ['update_memory'], profile: ['喜欢甜食'] })],
      ['工具签名', usageMemoKey(st, 'n1', { contextWindow: 32000, tools: ['recall_world_state'], profile: ['喜欢甜食'] })],
      ['画像签名', usageMemoKey(st, 'n1', { contextWindow: 32000, tools: ['update_memory'], profile: ['别的'] })],
    ];
    for (const [name, k] of sensitive) H.check('key 对' + name + '敏感', k !== base, k);
  }
}

H.run('上下文用量门禁', main);
