#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 上下文用量描述门禁（不联网、不开浏览器）
 *
 * 守六件事：
 *   1. level 边界：ok / warn / over 恰在边界上逐个判定；窗口未知 → unknown；三种模式都算得出；
 *   2. tokens 与 estimateTokensOf(assembleAI1(story, '', opts)) 逐字一致（估算与实发同源）；
 *   3. dry 零副作用：buildAssembleOpts('', { dry: true }) 前后 S.pendingInject、
 *      S.turnUsage、story.log.length 不变（指示器只读，绝不消费 🧠 一次性开关、不留痕）；
 *   4. 分层明细：opts.trace 不改组装结果、连续覆盖全部消息、不塞私有字段，各层之和 == 整体估算；
 *   5. memo：key 不变不重算、key 变了才重算，key 对每个输入逐项敏感。
 *   6. 聊天提示词省 token：hasCard × 工具开关四组合的 system / tools 字符数快照与上界
 *      （无卡无工具不超旧智能体提示词、有卡无工具不超旧扮演提示词加助手段、
 *       空工具数组请求体不带 tools 字段）。
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

async function main() {
  /* ---------- 1. level 边界 ---------- */
  // 窗口 20000 → 阈值 14000 → warn 线 = 85% × 阈值 = 11900（整数边界，浮点不抖）
  const CW = 20000;
  const TH = Context.compressThreshold(CW);
  const WARN_LINE = Math.ceil(TH * 17 / 20);
  H.check('阈值口径 = compressThreshold（不另写一套）', TH === 14000 && WARN_LINE === 11900, 'th=' + TH + ' warn=' + WARN_LINE);
  for (const mode of ['choice', 'chat']) {
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
  const CARD_STORY = { characterCard: { name: '沈砚', opening: '「门没锁。」' } };
  const MODES = [
    ['choice', {}],
    ['chat', {}],
    ['chat（有卡）', CARD_STORY],
  ];
  for (const [tag, extra] of MODES) {
    for (const opts of combos) {
      const st = Object.assign(newStory(tag === 'choice' ? 'choice' : 'chat'), extra);
      st.messages.push({ role: 'user', content: '走' }, { role: 'assistant', content: '{"旁白":"雨更大了。","选项":[]}' });
      st.summaries.push('【第一幕】雨夜车站｜凌晨｜发生｜伏笔：埋下「未寄出的信」');
      const u = describeContextUsage(st, opts);
      const direct = Context.estimateTokensOf(Context.assembleAI1(st, '', opts));
      H.check('tokens 同源（' + tag + ' ' + JSON.stringify(opts).slice(0, 40) + '）', u.tokens === direct, u.tokens + ' ≠ ' + direct);
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

  /* ---------- 4. 分层明细（opts.trace）：不改组装结果，且各层之和 == 整体估算 ---------- */
  const plainKeys = ['system', 'persistent', 'summary', 'history', 'user'];
  const toolKeys = ['system', 'persistent', 'summary', 'tools', 'history', 'user'];
  for (const [modeTag, extra] of MODES) {
    for (const opts of combos) {
      const st = Object.assign(newStory(modeTag === 'choice' ? 'choice' : 'chat'), extra);
      st.messages.push({ role: 'user', content: '走' }, { role: 'assistant', content: '{"旁白":"雨更大了。","选项":[]}' });
      st.summaries.push('【第一幕】雨夜车站｜凌晨｜发生｜伏笔：埋下「未寄出的信」');
      const trace = [];
      const traced = Context.assembleAI1(st, '', Object.assign({}, opts, { trace: trace }));
      const plain = Context.assembleAI1(st, '', opts);
      const tag = modeTag + ' ' + JSON.stringify(opts).slice(0, 40);
      H.check('不传 / 传 trace 的组装结果逐字一致（' + tag + '）',
        JSON.stringify(traced) === JSON.stringify(plain));
      H.check('trace 连续覆盖全部消息（' + tag + '）', (() => {
        let cursor = 0;
        for (const t of trace) {
          if (!t || t.from !== cursor || t.to <= t.from || t.to > traced.length) return false;
          cursor = t.to;
        }
        return cursor === traced.length;
      })(), JSON.stringify(trace));
      H.check('trace 不往消息里塞私有字段（' + tag + '）',
        traced.every(m => Object.keys(m).every(k => k === 'role' || k === 'content')));
      const u = describeContextUsage(st, opts);
      const expectKeys = Array.isArray(opts.tools) && opts.tools.length ? toolKeys : plainKeys;
      H.check('分层键按拼装顺序（' + tag + '）',
        JSON.stringify(u.layers.map(l => l.key)) === JSON.stringify(expectKeys),
        JSON.stringify(u.layers.map(l => l.key)));
      const sum = u.layers.reduce((a, l) => a + l.tokens, 0);
      H.check('各层 token 之和 == 整体估算（' + tag + '）', sum === u.tokens, sum + ' ≠ ' + u.tokens);
      H.check('每层都有可读标签（' + tag + '）', u.layers.every(l => l.label && l.tokens > 0));
    }
  }

  /* ---------- 5. memo ---------- */
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

  /* ---------- 6. 聊天提示词省 token（hasCard × 工具开关四组合快照） ---------- */
  // 聊天（原智能体 / 扮演合并）的系统提示词按 {hasCard, tools} 三段拼装：核心助手段 +
  // 工具段（只写实际下发的类目）+ 角色段（有卡才带）。这里把四种组合的 system / tools
  // 字符数钉成快照，并守住三条线：
  //   ① 无卡 + 无工具：system 不超合并前智能体提示词，且不提任何工具与（做）/（说）/（导演）；
  //   ② 有卡 + 无工具：system 不超合并前扮演提示词加共用助手段；
  //   ③ 请求里工具数组为空时请求体不带 tools 字段（providers 的 chat 适配器）。
  {
    // 合并前提示词全文长度（旧 CHAT_SYSTEM / RP_SYSTEM，作为回归上界）
    const OLD_CHAT_SYSTEM_CHARS = 133;
    const OLD_RP_SYSTEM_CHARS = 90;
    const CARD = {
      name: '沈砚', appearance: '黑发，旧毛衣', personality: '冷淡、话少',
      scene: '深夜旧书店', opening: '「门没锁。」', exampleDialogue: '「书不卖。」', systemNote: '保持克制。',
    };
    const namesOf = list => list.map(t => t.function.name);
    const fullTools = Context.toolsForMode('chat', { schedule: true, email: true, payment: true });
    const combos = [
      { name: '无卡 + 无工具', hasCard: false, tools: [], snapSystem: 22, snapToolsJson: 2 },
      { name: '无卡 + 全工具', hasCard: false, tools: fullTools, snapSystem: 133, snapToolsJson: 4359 },
      { name: '有卡 + 无工具', hasCard: true, tools: [], snapSystem: 97, snapToolsJson: 2 },
      { name: '有卡 + 全工具', hasCard: true, tools: fullTools, snapSystem: 208, snapToolsJson: 4359 },
    ];
    const systems = {};
    for (const c of combos) {
      const names = namesOf(c.tools);
      const system = Context.systemForMode('chat', { hasCard: c.hasCard, tools: names });
      systems[c.name] = system;
      H.check('快照 ' + c.name + '（system ' + system.length + ' 字 / tools JSON ' + JSON.stringify(c.tools).length + ' 字）',
        system.length === c.snapSystem && JSON.stringify(c.tools).length === c.snapToolsJson,
        'system ' + system.length + ' / json ' + JSON.stringify(c.tools).length);
      // 组装结果与快照同源：system 首条就是拼装产物，空工具不出现 [可用工具] 块
      const st = Object.assign(newStory('chat'), c.hasCard ? { characterCard: CARD } : {});
      const msgs = Context.assembleAI1(st, '你好', { tools: names });
      const toolBlock = msgs.filter(m => String(m.content).indexOf('[可用工具]') === 0).length;
      H.check('组装：' + c.name + ' 的 system 首条与快照一致、[可用工具] 块随工具出现',
        msgs[0].content === system && toolBlock === (names.length ? 1 : 0),
        'block=' + toolBlock);
    }

    // ① 无卡 + 无工具：不超旧智能体提示词；不出现任何工具与做 / 说 / 导演的描述
    const plain = systems['无卡 + 无工具'];
    H.check('无卡无工具：system ≤ 合并前智能体提示词（' + plain.length + ' ≤ ' + OLD_CHAT_SYSTEM_CHARS + '）',
      plain.length <= OLD_CHAT_SYSTEM_CHARS, plain);
    H.check('无卡无工具：不提任何工具 / 能力面',
      ['工具', '函数', '画图', '记事', '定时', '邮件', '下单', '提案'].every(w => plain.indexOf(w) < 0), plain);
    H.check('无卡无工具：不出现（做）/（说）/（导演）标记说明',
      ['（做）', '（说）', '（导演）'].every(w => plain.indexOf(w) < 0), plain);

    // ② 有卡 + 无工具：不超旧扮演提示词 + 共用助手段；角色锚定在场（卡里的人 + 2~6 句）
    const role = systems['有卡 + 无工具'];
    H.check('有卡无工具：system ≤ 合并前扮演提示词 + 助手段（' + role.length + ' ≤ ' + (OLD_RP_SYSTEM_CHARS + Context.CHAT_CORE.length) + '）',
      role.length <= OLD_RP_SYSTEM_CHARS + Context.CHAT_CORE.length, role);
    H.check('有卡无工具：角色锚定在场（角色卡里的人 / 2~6 句）',
      role.indexOf('角色卡里的那个人') >= 0 && role.indexOf('2~6 句') >= 0, role);

    // 工具段只写实际下发的类目：全工具时列出五类；只开邮件时只列「记事、写邮件」并附提案红线
    H.check('无卡全工具：能力面列全五类且不超旧智能体提示词',
      systems['无卡 + 全工具'].indexOf('画图、记事、定时提醒、写邮件、下单') >= 0
      && systems['无卡 + 全工具'].length <= OLD_CHAT_SYSTEM_CHARS, systems['无卡 + 全工具']);
    const emailOnly = Context.systemForMode('chat', {
      tools: namesOf(Context.toolsForMode('chat', { email: true })),
    });
    H.check('只开邮件：只列命中的类目（base 的画图、记事 + 写邮件），没下发的类目不提',
      emailOnly.indexOf('画图、记事、写邮件') >= 0 && emailOnly.indexOf('定时提醒') < 0
      && emailOnly.indexOf('下单') < 0, emailOnly);
    const emailNoImage = Context.systemForMode('chat', { tools: ['recall_world_state', 'email_propose'] });
    H.check('工具清单没有画图时能力面也不提画图',
      emailNoImage.indexOf('画图') < 0 && emailNoImage.indexOf('记事、写邮件') >= 0, emailNoImage);
    H.check('只开邮件：提案红线随之出现（高风险动作在场才提）',
      emailOnly.indexOf(Context.PROPOSAL_RED_LINE) >= 0, emailOnly.slice(0, 60));
    const memoryOnly = Context.systemForMode('chat', { tools: ['recall_world_state', 'update_memory'] });
    H.check('只开记忆：没有邮件 / 下单时不附提案红线',
      memoryOnly.indexOf('确认') < 0 && memoryOnly.indexOf('记事') >= 0, memoryOnly);

    // 工具拼接顺序固定：不因开关组合变化（base → 调度 → 邮件 → 下单），利于请求前缀缓存
    const orderBase = namesOf(Context.toolsForMode('chat', {}));
    H.check('工具顺序固定：开关组合不改变拼接顺序',
      namesOf(Context.toolsForMode('chat', { email: true })).join(',')
        === orderBase.concat(['email_propose']).join(',')
      && namesOf(Context.toolsForMode('chat', { payment: true })).join(',')
        === orderBase.concat(['payment_propose']).join(',')
      && namesOf(Context.toolsForMode('chat', { email: true, payment: true })).join(',')
        === orderBase.concat(['email_propose', 'payment_propose']).join(','));

    // ③ 请求里工具数组为空 → 请求体不带 tools 字段（providers 侧的同一道门）
    {
      const { ChatProviders } = core('providers');
      const chat = ChatProviders['openai-compatible'].chat;
      const CFG = { baseUrl: 'https://api.invalid/v1', apiKey: 'k', model: 'm' };
      const bodies = [];
      const realFetch = global.fetch;
      global.fetch = async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      };
      try {
        await chat(Object.assign({}, CFG, { tools: [] }), [{ role: 'user', content: 'x' }]);
        await chat(Object.assign({}, CFG, { tools: Context.toolsForMode('chat', { email: true }) }), [{ role: 'user', content: 'x' }]);
      } finally { global.fetch = realFetch; }
      H.check('请求体：工具数组为空时不带 tools 字段、非空时才带',
        bodies.length === 2 && !('tools' in bodies[0]) && Array.isArray(bodies[1].tools) && bodies[1].tools.length === 5,
        JSON.stringify(bodies.map(b => (b.tools || []).length)));
    }
  }
}

H.run('上下文用量门禁', main);
