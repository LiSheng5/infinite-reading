/*
 * eval/painter-context-test.js —— 画师上下文规则（P-1 §4，Node、不联网）
 *
 * 画师每次调用都隔离、用完即弃；scene 模式的输入只能包含（§4）：
 *   [system]  PAINTER_SYSTEM
 *   [system]  [画风锚]（设定卡优先，未锚定走降级文案）
 *   [system]  [最近两张图]（alt + prompt）
 *   [system]  [基底 prompt]（上一次出图的完整 prompt，差分基底；无上一张图时省略）
 *   [system]  [最近剧情]：最近 PAINTER_RECENT_TURNS 回合的「玩家行动 + 旁白」，
 *             玩家行动带（做）/（说）/（导演）标记，每条截断 200 字，按时间顺序
 *   [user]    [画面参考] + [画风要求]
 * 不得出现：更早的对话、世界卡全文、摘要栈、剧情规则提示词、用户画像、记忆条目。
 *
 * 另含静态断言（§6）：turn.js / round.js 源码里不再出现对 enqueueImage 的调用。
 *
 * 用法：node eval/painter-context-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

require(path.join(__dirname, '..', 'src', 'core', 'context.ts'));
const C = global.IR.Context;

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed++; }
}

const MARKS = { do: '（做）', say: '（说）', direct: '（导演）' };

// 超过 200 字的一条旁白（末尾埋一个只在未截断时才出现的哨兵串）
function longNarration(tag) {
  return tag + '前缀' + '长'.repeat(220) + 'TAIL-' + tag;
}

// ≥ 6 回合的故事：开场旁白 + 6 组「玩家行动 + 旁白」，回合间插两张图
function buildStory(opt) {
  opt = opt || {};
  const kinds = ['do', 'say', 'direct', 'do', 'say', 'direct'];
  const log = [{ type: 'narration', text: 'OPENINGNARR开场旁白' }];
  for (let t = 1; t <= 6; t++) {
    log.push({ type: 'player', text: 'T' + t + 'ACTION玩家行动', kind: kinds[t - 1] });
    log.push({ type: 'narration', text: t === 5 ? longNarration('T5NARR') : ('T' + t + 'NARR旁白') });
    if (t === 3) log.push({ type: 'image', id: 'im1', alt: 'IMG1ALT', prompt: 'IMG1PROMPT' });
    if (t === 5) log.push({ type: 'image', id: 'im2', alt: 'IMG2ALT', prompt: 'IMG2PROMPT' });
  }
  const story = {
    mode: 'choice',
    log: log,
    world: {
      place: 'WORLDPLACE特征串',
      scene: 'WORLDSCENE特征串',
      characters: [{ name: 'WORLDCHAR特征串', presence: '在场' }],
      threads: ['WORLDTHREAD特征串'],
      relationship: { stage: 'WORLDREL特征串', notes: 'WORLDNOTE特征串' },
    },
    summaries: ['SUMMARYSTACK特征串第一幕', 'SUMMARYSTACK特征串第二幕'],
    userProfile: [{ text: 'PROFILE特征串', kind: 'fact' }],
  };
  if (!opt.unanchored) {
    story.styleCard = {
      id: 'card1', locked: true,
      styleKeywords: ['ANCHORKW特征串', 'watercolor'],
      medium: 'watercolor',
      palette: 'cool blues',
      characters: [{ name: 'ANCHORCHAR特征串', appearanceEn: 'silver hair', outfit: 'coat', features: 'scar' }],
      negative: 'text, watermark',
      note: 'ANCHORNOTE特征串',
    };
  }
  return story;
}

function blockOf(msgs, title) {
  for (const m of msgs) {
    const c = String(m.content || '');
    if (c.indexOf(title) === 0) return c;
  }
  return '';
}

console.log('[1] recentTurnLines：只带最近 N 回合、类型标记、截断、时间顺序');
{
  const story = buildStory();
  ok(C.PAINTER_RECENT_TURNS === 3, '常量 PAINTER_RECENT_TURNS = 3（一处可调）');
  ok(C.PAINTER_RECENT_LINE_CHARS === 200, '常量 PAINTER_RECENT_LINE_CHARS = 200（一处可调）');
  const lines = C.recentTurnLines(story, C.PAINTER_RECENT_TURNS);
  ok(lines.length === 6, '最近 3 回合 = 3 组「玩家行动 + 旁白」共 6 行（实得 ' + lines.length + '）');
  ok(lines.join('\n').indexOf('T4ACTION') >= 0 && lines.join('\n').indexOf('T6NARR') >= 0,
    '含最近 3 回合（T4~T6）的玩家行动与旁白');
  ok(!/T[123](ACTION|NARR)/.test(lines.join('\n')) && lines.join('\n').indexOf('OPENINGNARR') < 0,
    '不含第 1~3 回合与开场旁白');
  ok(lines[0] === '· ' + MARKS.do + 'T4ACTION玩家行动', '第 4 回合行动带（做）：' + lines[0]);
  ok(lines[2] === '· ' + MARKS.say + 'T5ACTION玩家行动', '第 5 回合行动带（说）：' + lines[2]);
  ok(lines[4] === '· ' + MARKS.direct + 'T6ACTION玩家行动', '第 6 回合行动带（导演）：' + lines[4]);
  const joined = lines.join('\n');
  ok((joined.match(/（做）/g) || []).length === 1 && (joined.match(/（说）/g) || []).length === 1
    && (joined.match(/（导演）/g) || []).length === 1, '（做）/（说）/（导演）各恰好一次');
  const longLine = lines[3];   // T5NARR 的超长旁白
  ok(longLine.indexOf('T5NARR前缀') === 2, '超长旁白从头保留');
  ok(longLine.indexOf('TAIL-T5NARR') < 0, '超长旁白被截断：尾部哨兵串不出现');
  ok(longLine.length <= 2 + C.PAINTER_RECENT_LINE_CHARS,
    '截断后单条 ≤ 前缀 + 200 字（实得 ' + longLine.length + '）');
  ok(joined.indexOf('T4ACTION') < joined.indexOf('T5ACTION')
    && joined.indexOf('T5ACTION') < joined.indexOf('T6ACTION'), '按时间顺序：T4 → T5 → T6');
  // 纯函数：空 / 缺失 log 不抛错
  let threw = false;
  try { C.recentTurnLines({}, 3); C.recentTurnLines(null, 3); } catch (_) { threw = true; }
  ok(!threw, '空故事 / null 不抛错');
}

console.log('[2] assemblePainter（scene）：块齐全，[最近剧情] 只含最近 3 回合');
{
  const story = buildStory();
  const msgs = C.assemblePainter(story, { sceneRef: 'SCENEREF特征串', styleHint: 'STYLEHINT特征串' });
  const all = msgs.map(m => m.content).join('\n\n');
  ok(all.indexOf('[画风锚]') >= 0, '含 [画风锚]');
  ok(all.indexOf('[最近两张图]') >= 0, '含 [最近两张图]');
  ok(all.indexOf('[画面参考] SCENEREF特征串') >= 0, '含 [画面参考]');
  ok(all.indexOf('[画风要求] STYLEHINT特征串') >= 0, '含 [画风要求]');
  ok(msgs[0].content.indexOf('画师导演') >= 0 && msgs[0].role === 'system', '首条 = PAINTER_SYSTEM');
  ok(all.indexOf('ANCHORKW特征串') >= 0 && all.indexOf('ANCHORCHAR特征串') >= 0,
    '[画风锚] 用设定卡（含人物设定）');
  ok(all.indexOf('IMG1ALT') >= 0 && all.indexOf('IMG2PROMPT') >= 0, '[最近两张图] 带 alt + prompt');

  // 差分基底（v0.12.1）：上一次出图的完整 prompt 单独成块，且只给最近那一张
  const baseBlk = blockOf(msgs, '[基底 prompt]');
  ok(!!baseBlk, '有 [基底 prompt] 块（差分基底）');
  ok(baseBlk.indexOf('IMG2PROMPT') >= 0 && baseBlk.indexOf('IMG1PROMPT') < 0,
    '[基底 prompt] 取最近一张（IMG2），不含更早的 IMG1');
  ok(msgs[0].content.indexOf('基底') >= 0, 'PAINTER_SYSTEM 明确要求「以基底为准、风格原样保留」');
  ok(msgs[0].content.indexOf('完整') >= 0, 'PAINTER_SYSTEM 要求输出完整 prompt（不是差异）');

  const plot = blockOf(msgs, '[最近剧情]');
  ok(!!plot, '有 [最近剧情] 块');
  ok(plot.indexOf('T4ACTION') >= 0 && plot.indexOf('T6NARR旁白') >= 0, '[最近剧情] 含最近 3 回合');
  ok(!/T[123](ACTION|NARR)/.test(plot) && plot.indexOf('OPENINGNARR') < 0, '[最近剧情] 不含第 1~3 回合 / 开场');
  ok(plot.indexOf(MARKS.do) >= 0 && plot.indexOf(MARKS.say) >= 0 && plot.indexOf(MARKS.direct) >= 0,
    '[最近剧情] 玩家行动带（做）/（说）/（导演）');
  ok(plot.indexOf('TAIL-T5NARR') < 0 && plot.indexOf('T5NARR前缀') >= 0, '[最近剧情] 单条超 200 字被截断');
}

console.log('[3] 隔离规则：世界卡 / 摘要栈 / 剧情规则 / 画像 / 记忆一律不进画师上下文');
{
  const story = buildStory();
  const msgs = C.assemblePainter(story, { sceneRef: '雨夜的站台', styleHint: 'cinematic still' });
  const all = msgs.map(m => m.content).join('\n\n');
  ok(all.indexOf('WORLDPLACE特征串') < 0 && all.indexOf('WORLDSCENE特征串') < 0
    && all.indexOf('WORLDCHAR特征串') < 0 && all.indexOf('WORLDTHREAD特征串') < 0
    && all.indexOf('WORLDNOTE特征串') < 0 && all.indexOf('WORLDREL特征串') < 0,
    '不含世界卡全文与关系记忆');
  ok(all.indexOf('SUMMARYSTACK特征串') < 0, '不含摘要栈');
  ok(all.indexOf('"旁白":"旁白与对白') < 0 && all.indexOf('每次回复必须且只能输出一个 JSON 对象') < 0,
    '不含剧情规则提示词');
  ok(all.indexOf('PROFILE特征串') < 0, '不含用户画像');
  ok(all.indexOf('[前情摘要]') < 0 && all.indexOf('[世界状态卡]') < 0 && all.indexOf('[当前情势]') < 0,
    '不含 AI1 组装的任何注入块');
}

console.log('[4] 未锚定降级：不抛错、走「（未锚定，自由发挥）」');
{
  const story = buildStory({ unanchored: true });
  delete story.rollingStyle;
  let threw = false;
  let msgs = null;
  try { msgs = C.assemblePainter(story, { sceneRef: '深夜便利店', styleHint: '' }); } catch (_) { threw = true; }
  ok(!threw && msgs, '未锚定故事不抛错');
  const all = msgs.map(m => m.content).join('\n\n');
  ok(all.indexOf('[画风锚]\n（未锚定，自由发挥）') >= 0, '降级文案「（未锚定，自由发挥）」');
}

console.log('[4b] 差分基底的两种省略：第一次作画 / 工作台对话');
{
  const story = buildStory();
  story.log = story.log.filter(e => e.type !== 'image');
  story.scenes = [];
  const msgs = C.assemblePainter(story, { sceneRef: '雨夜站台', styleHint: '' });
  ok(!blockOf(msgs, '[基底 prompt]'), '没有上一张图 → 不发 [基底 prompt] 块');

  const chat = C.assemblePainter(buildStory(), { mode: 'chat', userText: '灯光暖一点', currentPrompt: 'CURPROMPT', currentAlt: 'CURALT' });
  ok(!blockOf(chat, '[基底 prompt]'), 'chat 模式不重复下发（已有 [当前这张图]）');
}

console.log('[5] chat（工作台）模式保持不动：[最近剧情] 仍是最近 3 条旁白 + recall_recent_plot');
{
  const story = buildStory();
  const msgs = C.assemblePainter(story, {
    mode: 'chat', userText: '灯光暖一点', tools: true,
    currentPrompt: 'CURPROMPT特征串', currentAlt: 'CURALT特征串',
  });
  const all = msgs.map(m => m.content).join('\n\n');
  ok(all.indexOf('recall_recent_plot') >= 0, '工作台仍带 recall_recent_plot 工具说明');
  ok(all.indexOf('CURPROMPT特征串') >= 0, '工作台带 [当前这张图]');
  const plot = blockOf(msgs, '[最近剧情]');
  ok(plot.indexOf('T6NARR') >= 0 && plot.indexOf('TAIL-T5NARR') < 0 && plot.indexOf('（做）') < 0,
    'chat 模式 [最近剧情] 保持旁白口径（不带玩家行动标记）');
}

console.log('[6] video 模式（§6）：隔离清单同 scene；图生带源画面、文生带画风要求');
{
  const story = buildStory();
  // 图生（i2v）：只写动起来的部分——输入带源图 alt + promptRaw
  const i2v = C.assemblePainter(story, {
    mode: 'video', videoKind: 'i2v',
    imageAlt: 'SRCALT特征串', imagePrompt: 'SRCPROMPT特征串',
  });
  const i2vAll = i2v.map(m => m.content).join('\n\n');
  ok(i2v[0].content.indexOf('动态提示词') >= 0 || i2v[0].content === C.PAINTER_VIDEO_SYSTEM,
    '首条 = PAINTER_VIDEO_SYSTEM');
  ok(i2vAll.indexOf('SRCALT特征串') >= 0 && i2vAll.indexOf('SRCPROMPT特征串') >= 0,
    'i2v 带源图 alt 与 promptRaw');
  ok(i2vAll.indexOf('图生') >= 0, 'i2v 标注「图生」');
  ok(i2vAll.indexOf('[画风锚]') >= 0 && i2vAll.indexOf('IMG1ALT') >= 0,
    'i2v 同样带 [画风锚] + [最近两张图]');
  const i2vPlot = blockOf(i2v, '[最近剧情]');
  ok(i2vPlot.indexOf('T4ACTION') >= 0 && !/T[123](ACTION|NARR)/.test(i2vPlot),
    'i2v [最近剧情] 只含最近 3 回合');
  // 隔离清单与 scene 相同：世界卡 / 摘要栈 / 画像一律不进（§6 上下文隔离规则不变）
  ok(i2vAll.indexOf('WORLDPLACE特征串') < 0 && i2vAll.indexOf('SUMMARYSTACK特征串') < 0
    && i2vAll.indexOf('PROFILE特征串') < 0 && i2vAll.indexOf('每次回复必须且只能输出一个 JSON 对象') < 0,
    'i2v 不含世界卡 / 摘要栈 / 画像 / 剧情规则');

  // 文生（t2v）：完整画面 + 动作 + 画风后缀（styleHint）
  const t2v = C.assemblePainter(story, {
    mode: 'video', videoKind: 't2v',
    sceneRef: 'T2VSCENEREF特征串', styleHint: 'T2VSTYLE特征串',
  });
  const t2vAll = t2v.map(m => m.content).join('\n\n');
  ok(t2vAll.indexOf('文生') >= 0, 't2v 标注「文生」');
  ok(t2vAll.indexOf('T2VSCENEREF特征串') >= 0, 't2v 带 [画面参考]');
  ok(t2vAll.indexOf('T2VSTYLE特征串') >= 0, 't2v 带 [画风要求]（画风后缀）');
  ok(t2vAll.indexOf('SRCALT特征串') < 0, 't2v 不带源画面块');
  ok(t2vAll.indexOf('WORLDPLACE特征串') < 0 && t2vAll.indexOf('SUMMARYSTACK特征串') < 0,
    't2v 同样遵守隔离清单');
}

console.log('[7] 静态断言：turn.js / round.js 不再调用 enqueueImage（含 maybeEnqueueImage）');
{
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'js', 'app', p), 'utf8');
  const turnSrc = read('turn.js');
  const roundSrc = read('round.js');
  ok(!/enqueueImage\s*\(/.test(turnSrc), 'turn.js 无 enqueueImage 调用');
  ok(!/enqueueImage\s*\(/.test(roundSrc), 'round.js 无 enqueueImage 调用');
  ok(turnSrc.indexOf('turnPaintedByTool') < 0 && roundSrc.indexOf('turnPaintedByTool') < 0,
    'turn.js / round.js 不再引用 turnPaintedByTool');
  const painterSrc = read('painter.js');
  ok(/function enqueueImage\s*\(/.test(painterSrc), 'painter.js 的 enqueueImage 保留（手动 🎨 唯一入口）');
  ok(/function runPaintTask\s*\(/.test(painterSrc) && /painterCompose/.test(painterSrc),
    '「构思 → 出图」仍集中在 runPaintTask 一处（画师分支未被误删）');
}

if (failed) {
  console.error('painter-context-test：' + failed + ' 项失败');
  process.exit(1);
}
console.log('✅ painter-context-test 全部通过');
