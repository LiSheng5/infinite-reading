#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 聊天模式门禁（「扮演」并入「聊天」之后的行为契约）
 *
 * 守四件事：
 *   1. 旧「扮演」（mode='rp'）只作兼容值存在：读档 / 新建归一为 'chat'，角色卡与历史不丢
 *      （导入 / 索引路径的逐字段比对在 eval/schema-test.js，这里守读档与组装入口）；
 *   2. 聊天没有做 / 说 / 导演：输入不加内层标记，旧存档里带标记的历史在组装时被剥掉，
 *      系统提示词也不解释这些标记（模型看不到就不会复述）；
 *   3. 工具默认值与门控：无卡 / 有卡都默认不下发邮件与下单，有卡且用户在本对话显式打开才下发；
 *   4. 侧车离线（GitHub Pages 构建的情形）时定时 / 邮件 / 下单三类都不下发。
 *
 * 工具清单取的是真实链路：src/app/round.js 的 A.toolInjection（buildAI1Request 与空对话引导
 * 共用这一个判定），依赖用桩替代，只跑纯逻辑。
 *
 * 用法：node eval/chat-mode-test.js
 */
const path = require('path');
const H = require('./_harness.js');
const ROOT = path.join(__dirname, '..');
const core = (f) => require(path.join(ROOT, 'src', 'core', f + '.ts'));

const { Context } = core('context');
const { Prefs } = core('prefs');
const { Store } = core('store');

/* ---------- 夹具 ---------- */

function newStory(mode, extra) {
  return Object.assign({
    schema: 3, id: 'chat-story', title: '测试', premise: '在雨夜的车站。',
    mode: mode,
    log: [], messages: [], scenes: [], summaries: [],
    world: {
      place: '雨夜车站', time: '凌晨',
      characters: [{ name: '艾莉', presence: '在场', personality: '安静', speech: '轻声' }],
      threads: [], relationship: { stage: '', bonds: [], notes: '' }, scene: '',
    },
    ui: {}, prefs: {}, turn: 0, userProfile: [],
  }, extra || {});
}

const CARD = { name: '沈砚', personality: '冷淡、话少', opening: '「门没锁。」', source: 'custom' };

// 生图配置齐备：request_image 的「不可用」原因只可能来自开关，不会伪装成「没配模型」
function settingsWith(imageReady) {
  return {
    toolsEnabled: 'on',
    chat: { provider: 'openai-compatible', baseUrl: 'https://api.invalid/v1', apiKey: 'k', model: 'm' },
    image: imageReady
      ? { provider: 'openai-images', baseUrl: 'https://img.invalid/v1', apiKey: 'k', model: 'im' }
      : {},
    profiles: [],
  };
}

/* ---------- 1. 旧 rp 只作兼容值：归一为 chat，卡与历史完整 ---------- */

{
  const legacy = newStory('rp', {
    characterCard: CARD,
    log: [{ type: 'narration', text: '「门没锁。」' }, { type: 'player', text: '[玩家行动] （做）推门进去', kind: 'do' }],
  });
  H.check('Store.normalizeMode：旧值 rp → chat，其余模式原样',
    Store.normalizeMode('rp') === 'chat' && Store.normalizeMode('chat') === 'chat'
      && Store.normalizeMode('choice') === 'choice' && Store.normalizeMode('abc') === 'abc');
  const made = Store.newStory({ mode: 'rp', premise: '角色扮演：沈砚', characterCard: CARD });
  H.check('newStory：mode=rp 建出来的就是 chat', made.mode === 'chat', made.mode);
  H.check('newStory：角色卡逐字段保留（不因归一丢卡）',
    made.characterCard && made.characterCard.name === '沈砚'
      && made.characterCard.opening === CARD.opening && made.characterCard.personality === CARD.personality);
  H.check('newStory：有卡才带卡（无卡时 characterCard 不凭空出现）',
    !Store.newStory({ mode: 'chat' }).characterCard);
  H.check('读档归一后 mode 已是 chat（旧档再走一遍 withKindMarker 也不加标记）',
    Context.stripKindMarker(legacy.log[1].text) === '[玩家行动] 推门进去');
}

/* ---------- 2. 聊天没有做 / 说 / 导演 ---------- */

{
  const sys = Context.systemForMode('chat');
  H.check('系统提示词：不提（做）/（说）/（导演）', ['（做）', '（说）', '（导演）'].every(w => sys.indexOf(w) < 0), sys);
  H.check('系统提示词：有卡时也只换口吻，不解释内层标记',
    ['（做）', '（说）', '（导演）'].every(w => Context.systemForMode('chat', { hasCard: true }).indexOf(w) < 0));

  // 组装历史：旧 rp 存档里带标记的玩家消息被剥掉，正文保留
  const st = newStory('chat', { characterCard: CARD });
  st.messages.push(
    { role: 'user', content: '[玩家行动] （说）你好' },
    { role: 'assistant', content: '「门没锁。」' },
    { role: 'user', content: '[玩家行动] （导演）窗外开始下雨' },
  );
  const text = Context.messagesToText(Context.assembleAI1(st, '继续'));
  H.check('组装历史：旧（说）/（导演）内层标记被剥掉，正文保留',
    text.indexOf('（说）') < 0 && text.indexOf('（导演）') < 0
      && text.indexOf('你好') >= 0 && text.indexOf('窗外开始下雨') >= 0, text.slice(0, 120));
  H.check('剧情模式仍带标记说明（合并只动聊天）',
    Context.systemForMode('choice').indexOf('（做）') >= 0);
}

/* ---------- 3 / 4. 工具门控：拉起 round.js 的真实判定 ---------- */

global.document = {
  querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
  getElementById: () => null, hidden: false, documentElement: { dataset: {}, lang: 'zh-CN' },
};
if (!global.navigator) global.navigator = { userAgent: 'node' };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { A } = require(path.join(ROOT, 'src', 'app', 'core.js'));
require(path.join(ROOT, 'src', 'app', 'round.js'));

const S = A.state;
A.noToolsFor = () => false;
A.sidecarFeatureWhy = () => '';           // 侧车在线 + token 齐 + 三个 feature 全开
A.activeProfileEntries = () => [];
A.chatContextWindow = () => 100000;
A.renderInjectHint = () => {};
A.imageBrief = () => '';

function inject(story, patch) {
  S.settings = Object.assign(settingsWith(true), patch && patch.settings);
  S.story = story;
  A.sidecarFeatureWhy = (patch && patch.why) || (() => '');
  const r = A.toolInjection();
  return { names: r.tools.map(t => t.function.name), why: r.why, on: r.on };
}
const has = (names, n) => names.indexOf(n) >= 0;
const SIDE_EFFECTS = ['schedule_once', 'email_propose', 'payment_propose'];

{
  const none = inject(newStory('chat', { characterCard: CARD }));
  H.check('有卡 + 未显式开启：邮件 / 下单都不下发',
    !has(none.names, 'email_propose') && !has(none.names, 'payment_propose'), none.names.join(','));
  H.check('有卡 + 未显式开启：仍带基础记忆工具（记忆默认开）',
    has(none.names, 'recall_world_state') && has(none.names, 'update_memory'), none.names.join(','));
  H.check('有卡 + 未显式开启：定时 / 生图默认关（测试中）',
    !has(none.names, 'schedule_once') && !has(none.names, 'request_image'), none.names.join(','));
  H.check('有卡 + 未显式开启：why 给出「本对话里已关掉它」（与开关同源）',
    none.why.email === '本对话里已关掉它' && none.why.payment === '本对话里已关掉它', JSON.stringify(none.why));

  const plain = inject(newStory('chat'));
  H.check('无卡 + 未显式开启：同样不带邮件 / 下单（全局默认关，不与「有没有卡」绑定）',
    !has(plain.names, 'email_propose') && !has(plain.names, 'payment_propose'), plain.names.join(','));
}

{
  const on = inject(newStory('chat', {
    characterCard: CARD,
    prefs: { tools: { email: true, payment: true } },
  }));
  H.check('有卡 + 本对话显式打开：邮件 / 下单才下发',
    has(on.names, 'email_propose') && has(on.names, 'payment_propose'), on.names.join(','));
  H.check('显式打开只放行这两类，定时仍按自己的开关（默认关）',
    !has(on.names, 'schedule_once'), on.names.join(','));

  const onlyEmail = inject(newStory('chat', { characterCard: CARD, prefs: { tools: { email: true } } }));
  H.check('只开邮件：下单仍不下发（两类各管各的）',
    has(onlyEmail.names, 'email_propose') && !has(onlyEmail.names, 'payment_propose'), onlyEmail.names.join(','));
}

{
  // 侧车离线：GitHub Pages 上没有本地服务，三类工具一个都不下发（与开关无关）
  const off = () => '本地服务未启动';
  const story = newStory('chat', {
    characterCard: CARD,
    prefs: { tools: { email: true, payment: true, schedule: true, image: true } },
  });
  const r = inject(story, { why: off });
  H.check('侧车离线：定时 / 邮件 / 下单都不下发（即便本对话全开）',
    SIDE_EFFECTS.every(n => !has(r.names, n)), r.names.join(','));
  H.check('侧车离线：记忆与生图不受影响（只关依赖本地服务的三类）',
    has(r.names, 'update_memory') && has(r.names, 'request_image'), r.names.join(','));
  H.check('侧车离线：why[k] 原样透传 sidecarFeatureWhy 的口径',
    r.why.schedule === '本地服务未启动' && r.why.email === '本地服务未启动', JSON.stringify(r.why));
}

{
  // 剧情模式：邮件 / 下单即便传 true 也不给，作画工具也不给
  const ch = inject(newStory('choice', { prefs: { tools: { email: true, payment: true, schedule: true } } }));
  H.check('剧情模式：三类副作用工具与作画工具都不下发',
    SIDE_EFFECTS.every(n => !has(ch.names, n)) && !has(ch.names, 'request_image'), ch.names.join(','));
}

{
  // 聊天默认态：Prefs.effective 解析出的开关里四类「测试中」为关、记忆为开
  //（「没有工具就不带 tools 字段」在 ctxusage-test.js 第 6 节守）
  const chat = Prefs.effective(settingsWith(true), newStory('chat', { characterCard: CARD }), 'tools');
  H.check('聊天默认态：解析出的开关里四类「测试中」为关、记忆为开',
    chat.image === false && chat.schedule === false && chat.email === false && chat.payment === false
      && chat.memory === true, JSON.stringify(chat));
}

H.finish('聊天模式门禁');
