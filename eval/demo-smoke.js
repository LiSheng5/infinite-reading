#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 离线演示模式冒烟测试（js/demo.js）
 *
 * 不开浏览器、不联网，只验一件事：演示模式注册的两个「假适配器」，与真实链路的接口对不对得上——
 *   AI1 回包能被 parseAIReply 认出来；画师回包能被 parsePainterReply 认出来；
 *   书记员等后台任务交回空串，让 app.js 走本地规则兜底；脚本用尽后不会崩。
 * 另外按任务书 §5 走一遍分支树的 demo 链路：3 回合 → 重试（新增兄弟）→ 切换 → 再切回。
 *
 * 用法：node eval/demo-smoke.js   [--json]
 */
const path = require('path');

global.window = global;
global.location = { search: '?demo=1' };          // 演示模式靠查询参数判定

require(path.join(__dirname, '..', 'src', 'core', 'context.ts'));
require(path.join(__dirname, '..', 'src', 'core', 'tree.ts'));
require(path.join(__dirname, '..', 'src', 'core', 'store.ts'));
require(path.join(__dirname, '..', 'src', 'core', 'roleCard.ts'));
require(path.join(__dirname, '..', 'src', 'core', 'demo.ts'));

const { Context, Store, Demo, ChatProviders, ImageProviders, Tree } = global.IR || {};
if (!Context || !Demo || !ChatProviders || !ImageProviders || !Tree) {
  console.error('加载失败：IR.Context / IR.Demo / IR.Tree / 适配器缺失。');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}

const demo = ChatProviders['demo'];
const demoImg = ImageProviders['demo-image'];

/* ---------------- 1. 演示模式判定与设置隔离 ---------------- */
check('?demo=1 判定为演示模式', Demo.enabled() === true, 'search=' + global.location.search);
global.location.search = '?foo=1';
check('不带 demo 参数时不进入演示模式', Demo.enabled() === false, 'search=' + global.location.search);
global.location.search = '?demo=1';

const realSettings = Store.defaultSettings();
const demoed = Demo.applyTo(realSettings);
check('applyTo：对话 / 生图都换成演示适配器',
  demoed.chat.provider === 'demo' && demoed.image.provider === 'demo-image'
    && !!ChatProviders[demoed.chat.provider] && !!ImageProviders[demoed.image.provider],
  demoed.chat.provider + ' / ' + demoed.image.provider);
check('applyTo：子模型留空 → 沿用剧情模型（同样是演示适配器）',
  !demoed.painter.provider && !demoed.painter.model && !demoed.scribe.model && !demoed.draft.model, 'ok');
check('applyTo：不动原对象（配置不落盘的前提）',
  realSettings.chat.provider !== demoed.chat.provider && realSettings.toolsEnabled !== 'off', 'ok');

/* ---------------- 2. AI1：内置剧本能被真实解析链路认出来 ---------------- */
function setupStory() {
  const s = Store.newStory({ title: Demo.title, premise: Demo.premise, mode: 'choice' });
  return s;
}

(async function main() {
  Demo.reset();
  const story = setupStory();

  // 2.1 开局（第一次 AI1）：带流式钩子，验证 onDelta / onReasoning 与返回值一致
  const openMsgs = Context.assembleAI1(story, '（故事开场。请描写第一幕，把玩家带进场景。）', { includePremise: true });
  let streamed = '';
  let reasoning = '';
  const raw0 = await demo.chat(demoed.chat, openMsgs, {
    onDelta: p => { streamed += p; },
    onReasoning: p => { reasoning += p; },
  });
  check('AI1 开局：流式回包与返回值一致（打字机效果）', streamed === raw0 && raw0.length > 40, '长度 ' + raw0.length);
  check('AI1 开局：会给思考链钩子（演示思考链）', reasoning.length > 0, reasoning.slice(0, 12) + '…');

  const j0 = Context.normalizeAIReply(Context.tolerantJSONParse(raw0));
  check('AI1 开局：JSON 契约齐备（旁白 + 选项 + 画面）',
    !!j0 && j0.narration.length > 20 && Array.isArray(j0.choices) && j0.choices.length >= 2 && !!j0.scene_summary,
    j0 ? ('选项 ' + j0.choices.length + ' 个') : 'null');
  check('AI1 开局：自报世界卡能合并（地点 / 人物 / 伏笔）',
    (() => { Context.mergeWorld(story.world, j0.world); return !!story.world.place && story.world.characters.length > 0 && story.world.threads.length > 0; })(),
    story.world.place + '｜' + story.world.characters.length + ' 人｜' + story.world.threads.length + ' 伏笔');

  // 2.2 连续推进：走完剧本 + 一段收尾回合，确认不崩、不空
  const marks = [];
  for (let i = 0; i < Demo.turnCount + 3; i++) {
    const msgs = Context.assembleAI1(story, '继续（回合 ' + (i + 2) + '）');
    const raw = await demo.chat(demoed.chat, msgs, {});
    const j = Context.normalizeAIReply(Context.tolerantJSONParse(raw));
    marks.push(!!(j && j.narration));
    story.turn += 1;
  }
  check('AI1：连续 ' + marks.length + ' 轮（含剧本用尽后的收尾）都能给出旁白',
    marks.every(Boolean), marks.filter(Boolean).length + '/' + marks.length);

  // 2.3 压缩链仍由本地规则兜底（演示不调书记员模型）
  const before = (story.summaries || []).length;
  Context.compressStory(story, { summarize: Context.localSummarize });
  check('压缩：演示模式仍能本地压缩（不依赖模型）', (story.summaries || []).length >= before, '摘要 ' + (story.summaries || []).length + ' 幕');

  /* ---------------- 3. 画师子代理：场景 / 工作台 / 锚定三套回包 ---------------- */
  const sceneMsgs = Context.assemblePainter(story, { sceneRef: story.world.scene || '深夜电车车厢', styleHint: 'cinematic still, rain' });
  const sceneRaw = await demo.chat(demoed.chat, sceneMsgs, {});
  const p = JSON.parse(sceneRaw.slice(sceneRaw.indexOf('{'), sceneRaw.lastIndexOf('}') + 1));
  check('画师（场景）：给出英文 prompt_en + 中文 alt',
    typeof p.prompt_en === 'string' && p.prompt_en.length > 20 && p.alt === (story.world.scene || '深夜电车车厢'),
    p.prompt_en.slice(0, 34) + '…');
  check('画师（场景）：画风要求里的英文关键词被并入 prompt',
    sceneRaw.indexOf('rain') !== -1, 'ok');

  const chatMsgs = Context.assemblePainter(story, {
    mode: 'chat', userText: '灯光暖一点', currentPrompt: p.prompt_en, currentAlt: p.alt,
  });
  const chatRaw = await demo.chat(demoed.chat, chatMsgs, {});
  const pc = JSON.parse(chatRaw.slice(chatRaw.indexOf('{'), chatRaw.lastIndexOf('}') + 1));
  check('画师（工作台）：给出 reply + 改后 prompt_en',
    !!pc.reply && !!pc.prompt_en && pc.prompt_en !== p.prompt_en, (pc.reply || '').slice(0, 20) + '…');

  const styleMsgs = Context.assemblePainter(story, { mode: 'styles', batch: 1 });
  const styleRaw = await demo.chat(demoed.chat, styleMsgs, {});
  const ps = JSON.parse(styleRaw.slice(styleRaw.indexOf('{'), styleRaw.lastIndexOf('}') + 1));
  check('画师（锚定 · 试画）：给满 4 组画风',
    Array.isArray(ps.styles) && ps.styles.length === 4 && ps.styles.every(s => s.keywords && s.prompt_en && s.alt),
    (ps.styles || []).length + ' 组');

  const cardMsgs = Context.assemblePainter(story, { mode: 'card', picked: ps.styles[0] });
  const cardRaw = await demo.chat(demoed.chat, cardMsgs, {});
  const pcd = JSON.parse(cardRaw.slice(cardRaw.indexOf('{'), cardRaw.lastIndexOf('}') + 1));
  check('画师（锚定 · 设定卡）：card 字段齐备',
    !!(pcd.card && pcd.card.styleKeywords && pcd.card.medium && Array.isArray(pcd.card.characters) && pcd.card.negative),
    (pcd.card ? pcd.card.medium : '无'));

  /* ---------------- 4. 后台任务：交回空串 → app.js 走本地兜底 ---------------- */
  const scribeRaw = await demo.chat(demoed.chat, [
    { role: 'system', content: '你是这部视觉小说的「书记员」。只输出一个 JSON 对象。' },
    { role: 'user', content: '[当前世界卡]\n地点：电车' },
  ], {});
  check('书记员 / 压缩 / 滚动风格：返回空串（由本地规则兜底，不污染世界卡）', scribeRaw === '', JSON.stringify(scribeRaw));

  /* ---------------- 5. 生图适配器：接口形态与真实适配器一致 ---------------- */
  check('生图适配器已注册，且约定同样是 generate(cfg, prompt) -> src',
    typeof demoImg.generate === 'function' && demoImg.generate.length === 2, 'ok');

  /* ---------------- 6. 分支树：demo 走 3 回合 → 重试 → 切换 → 再切回（任务书 §5） ---------------- */
  Demo.reset();
  const bt = setupStory();
  let ai1Calls = 0;

  // 模拟 app.js 的一回合编排（§4.1）：begin → pushLog(player) → AI1 → commit → seal
  async function demoTurn(sent, requestSent) {
    const mark = Tree.begin(bt);
    const um = { role: 'user', content: Context.playerContent(bt.premise, sent) };
    const raw = await demo.chat(demoed.chat, Context.assembleAI1(bt, requestSent || sent), {});
    ai1Calls += 1;
    const j = Context.normalizeAIReply(Context.tolerantJSONParse(raw));
    const am = { role: 'assistant', content: JSON.stringify({ narration: j.narration, choices: j.choices }) };
    bt.turn += 1;
    bt.log.push({ type: 'player', text: sent, kind: 'do', ts: Date.now() });
    bt.log.push({ type: 'narration', text: j.narration, versions: [j.narration], activeVersion: 0, ts: Date.now() });
    bt.messages.push(um, am);
    if (j.world) Context.mergeWorld(bt.world, j.world);
    const node = Tree.commit(bt, {
      action: { type: 'player', text: sent, kind: 'do', sent: '（做）' + sent },
      userMsg: um, assistantMsg: am, logMark: mark.logMark,
    });
    Tree.seal(bt, node.id);
    return node;
  }

  // 3 回合
  const rounds = [];
  for (let i = 1; i <= 3; i++) {
    await demoTurn('继续（第 ' + i + ' 回合）');
    rounds.push(bt.log[bt.log.length - 1].text);
  }
  check('分支树 · demo 3 回合：一回合一个 turn 节点、每回合都有旁白',
    Tree.pathOf(bt, bt.tree.head).length === 4 && bt.turn === 3 && rounds.every(x => x && x.length > 10),
    rounds.map(x => x.slice(0, 8)).join('｜'));

  // 重试 = 新增兄弟（§4.2）：先回到这一回合之前，再换一种发展
  const old = bt.tree.nodes[bt.tree.head];
  Tree.switchTo(bt, old.parent);
  await demoTurn('继续（第 3 回合）', '继续（第 3 回合）\n（请换一种不同的发展，给出不同的走向）');
  const sib = bt.tree.nodes[bt.tree.head];
  rounds.push(bt.log[bt.log.length - 1].text);
  check('分支树 · 重试出兄弟：同 parent、两条分支、旁白不同',
    sib.parent === old.parent && bt.tree.nodes[sib.parent].children.length === 2 && rounds[3] !== rounds[2],
    rounds[2].slice(0, 8) + ' ≠ ' + rounds[3].slice(0, 8));

  // 切换 → 再切回（§4.3）：不发任何请求
  const callsBeforeSwitch = ai1Calls;
  const h1 = Tree.switchSibling(bt, sib.id, -1);
  check('分支树 · 切换：落到原分支末端，旁白 / 选项跟着换', !!h1 && h1.id === old.id
    && bt.log[bt.log.length - 1].text === rounds[2]
    && JSON.parse(bt.messages[bt.messages.length - 1].content).narration === rounds[2]);
  const h2 = Tree.switchSibling(bt, old.id, +1);
  check('分支树 · 再切回：落回重试分支末端，旁白 / 选项跟着回来', !!h2 && h2.id === sib.id
    && bt.log[bt.log.length - 1].text === rounds[3]
    && JSON.parse(bt.messages[bt.messages.length - 1].content).narration === rounds[3]);
  check('分支树 · 切换零网络请求（演示适配器没被再调用）', ai1Calls === callsBeforeSwitch, ai1Calls + ' 次');
  check('分支树 · siblings 顺序 = 创建序（‹ n/m › 用它定位）',
    Tree.siblings(bt, old.id).join(',') === [old.id, sib.id].join(','));

  /* ---------------- 报告 ---------------- */
  const hit = results.filter(r => r.hit).length;
  if (process.argv.indexOf('--json') !== -1) {
    console.log(JSON.stringify({ hit: hit, total: results.length, checks: results }, null, 2));
  } else {
    console.log('无限阅读 · 离线演示模式冒烟测试（js/demo.js）');
    for (const r of results) {
      console.log((r.hit ? '[命中] ' : '[未中] ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
    }
    console.log('\n合计：' + hit + '/' + results.length + (hit === results.length ? ' ✅' : ' ❌'));
  }
  if (hit !== results.length) process.exit(1);
})().catch(e => {
  console.error('冒烟测试异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
