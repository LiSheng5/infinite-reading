#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 自动标题纯逻辑测试（src/core/titles.ts）
 *
 * 不开浏览器、不联网：
 *   1. sanitize：引号 / 书名号 / markdown / 换行 / 结尾标点 / 超长 / 空串 / 多行解释；
 *      按码点计长度（emoji 与生僻字不被截坏）；
 *   2. fallback：首条用户消息截断；无消息 → 「新对话」；
 *   3. needsTitle：titleAuto / turn>=1 第一次 / turn>=6 第二次 / 跳号补跑 / 之后不再触发；
 *   4. buildPrompt：只含最近 3 轮、单条 ≤600 字、不含系统提示 / 世界卡 / 工具内容；
 *   5. applyTitle 写回护栏：titleAuto 已改假 → 不写；id 不一致 → 不写。
 *
 * 用法：node eval/titles-test.js
 */
const path = require('path');

global.window = global;
const T = require(path.join(__dirname, '..', 'src', 'core', 'titles.ts')).Titles;
if (!T) {
  console.error('加载失败：Titles 导出缺失');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}
function cps(s) { return Array.from(String(s == null ? '' : s)); }

/* ---------------- 1. sanitize ---------------- */

check('sanitize：首尾引号剥掉',
  T.sanitize('「雨夜便利店」', 'FB') === '雨夜便利店', T.sanitize('「雨夜便利店」', 'FB'));
check('sanitize：书名号剥掉',
  T.sanitize('《末班电车》', 'FB') === '末班电车', T.sanitize('《末班电车》', 'FB'));
check('sanitize：markdown 标记剥掉',
  T.sanitize('**便利店奇遇**', 'FB') === '便利店奇遇', T.sanitize('**便利店奇遇**', 'FB'));
check('sanitize：标题前缀 # 剥掉',
  T.sanitize('# 雨夜奇遇', 'FB') === '雨夜奇遇', T.sanitize('# 雨夜奇遇', 'FB'));
check('sanitize：换行（多行解释）→ fallback',
  T.sanitize('这段对话讲的是\n一个很长的解释', 'FB') === 'FB', T.sanitize('这段对话讲的是\n一个很长的解释', 'FB'));
check('sanitize：首尾换行只是收掉、不算多行',
  T.sanitize('\n雨夜便利店\n', 'FB') === '雨夜便利店', T.sanitize('\n雨夜便利店\n', 'FB'));
check('sanitize：结尾标点剥掉',
  T.sanitize('雨夜便利店。', 'FB') === '雨夜便利店', T.sanitize('雨夜便利店。', 'FB'));
check('sanitize：结尾逗号 / 分号剥掉',
  T.sanitize('雨夜便利店，', 'FB') === '雨夜便利店', T.sanitize('雨夜便利店，', 'FB'));
check('sanitize：空串 → fallback',
  T.sanitize('', 'FB') === 'FB', T.sanitize('', 'FB'));
check('sanitize：只有引号 → fallback',
  T.sanitize('「」', 'FB') === 'FB', T.sanitize('「」', 'FB'));
check('sanitize：多行解释（带说明）→ fallback',
  T.sanitize('标题：这是一段解释\n说明：还有第二行', 'FB') === 'FB', 'ok');

const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';   // 30 字
const longOut = T.sanitize(long, 'FB');
check('sanitize：超长截断加省略号（20 字 + …）',
  cps(longOut).length === 21 && longOut.endsWith('…') && cps(longOut)[19] === '十',
  longOut + ' / len=' + cps(longOut).length);

// 码点计长度：emoji 与生僻字不被截坏
const emojiTitle = '🚄' + '霓虹'.repeat(11);   // 1 + 22 = 23 码点
const emojiOut = T.sanitize(emojiTitle, 'FB');
check('sanitize：emoji 按码点截断（不截坏代理对）',
  cps(emojiOut).length === 21 && cps(emojiOut)[0] === '🚄' && emojiOut.endsWith('…'),
  emojiOut + ' / cp=' + cps(emojiOut).length + ' / utf16=' + emojiOut.length);
check('sanitize：生僻字不被截坏',
  T.sanitize('龘靐齉齾龗', 'FB') === '龘靐齉齾龗', T.sanitize('龘靐齉齾龗', 'FB'));
check('sanitize：内联 code 反引号剥掉',
  T.sanitize('`雨夜便利店`', 'FB') === '雨夜便利店', T.sanitize('`雨夜便利店`', 'FB'));

/* ---------------- 2. fallback ---------------- */

check('fallback：无消息 → 「新对话」',
  T.fallback({ messages: [] }) === '新对话', T.fallback({ messages: [] }));
check('fallback：首条用户消息截断（15 码点 + …）',
  T.fallback({ messages: [{ role: 'user', content: '[玩家行动]' + '午夜十二点的车站我们决定留下来'.repeat(3) }] })
    === '午夜十二点的车站我们决定留下来'.slice(0, 15) + '…',
  T.fallback({ messages: [{ role: 'user', content: '[玩家行动]' + '午夜十二点的车站我们决定留下来'.repeat(3) }] }));
check('fallback：短消息不加省略号',
  T.fallback({ messages: [{ role: 'user', content: '[玩家行动]推开门' }] }) === '推开门',
  T.fallback({ messages: [{ role: 'user', content: '[玩家行动]推开门' }] }));
check('fallback：跳过 assistant 取第一条 user',
  T.fallback({ messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: '找钥匙' }] }) === '找钥匙',
  T.fallback({ messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: '找钥匙' }] }));
check('fallback：剥掉（做/说/导演）内层标记',
  T.fallback({ messages: [{ role: 'user', content: '[玩家行动]（做）推开门' }] }) === '推开门',
  T.fallback({ messages: [{ role: 'user', content: '[玩家行动]（做）推开门' }] }));
check('fallback：跳过开局占位话术「（故事开场…）」',
  T.fallback({ messages: [
    { role: 'user', content: '（故事开场。请描写第一幕，把玩家带进场景。）' },
    { role: 'user', content: '[玩家行动]推开门走进便利店' },
  ] }) === '推开门走进便利店',
  T.fallback({ messages: [
    { role: 'user', content: '（故事开场。请描写第一幕，把玩家带进场景。）' },
    { role: 'user', content: '[玩家行动]推开门走进便利店' },
  ] }));
check('fallback：只有占位话术 → 「新对话」',
  T.fallback({ messages: [{ role: 'user', content: '（故事开场。请描写第一幕，把玩家带进场景。）' }] }) === '新对话');

/* ---------------- 3. needsTitle ---------------- */

check('needsTitle：titleAuto 为假 → 假',
  T.needsTitle({ titleAuto: false, turn: 1, titleGen: 0 }) === false);
check('needsTitle：titleAuto 缺失 → 假',
  T.needsTitle({ turn: 1, titleGen: 0 }) === false);
check('needsTitle：turn===1 未生成 → 真',
  T.needsTitle({ titleAuto: true, turn: 1, titleGen: 0 }) === true);
check('needsTitle：turn===1 已生成 → 假',
  T.needsTitle({ titleAuto: true, turn: 1, titleGen: 1 }) === false);
check('needsTitle：turn===6 未二次生成 → 真',
  T.needsTitle({ titleAuto: true, turn: 6, titleGen: 1 }) === true);
check('needsTitle：turn===6 已二次生成 → 假',
  T.needsTitle({ titleAuto: true, turn: 6, titleGen: 2 }) === false);
// 跳号：重试 / 切分支 / 导入让 turn 跨过 1 或 6，补跑第一次 / 第二次（不能永久停在「新对话」）
check('needsTitle：turn 跳过 1（turn=3）未生成 → 补跑第一次',
  T.needsTitle({ titleAuto: true, turn: 3, titleGen: 0 }) === true);
check('needsTitle：turn 跳过 6（turn=9）未二次生成 → 补跑第二次',
  T.needsTitle({ titleAuto: true, turn: 9, titleGen: 1 }) === true);
check('needsTitle：未到 6 且已生成第一次 → 假（不提前二次生成）',
  T.needsTitle({ titleAuto: true, turn: 2, titleGen: 1 }) === false
  && T.needsTitle({ titleAuto: true, turn: 5, titleGen: 1 }) === false);
check('needsTitle：两次都生成过 → 之后一律假',
  T.needsTitle({ titleAuto: true, turn: 7, titleGen: 2 }) === false
  && T.needsTitle({ titleAuto: true, turn: 30, titleGen: 2 }) === false);
check('needsTitle：turn=0（还没开局）→ 假',
  T.needsTitle({ titleAuto: true, turn: 0, titleGen: 0 }) === false);

/* ---------------- 4. buildPrompt ---------------- */

const worldCard = '【世界卡】地点：雨夜便利店；人物：店员周叙……（此处省略五百字设定）';
const toolJunk = '{"tool_calls":[{"id":"call-1","function":{"name":"request_image"}}]}';
const msgs = [
  { role: 'system', content: '你是这部视觉小说的旁白……' + worldCard },
  { role: 'user', content: '[设定]' + worldCard + '\n\n[玩家行动]（做）推开门走进便利店' },
  { role: 'assistant', content: JSON.stringify({ narration: '门铃响了。店员抬头看了你一眼。', choices: ['打招呼', '径直走向货架'] }) },
  { role: 'user', content: '[玩家行动]（说）这么晚还在营业？' },
  { role: 'assistant', content: JSON.stringify({ narration: '「嗯，值夜班。」他擦着杯子。' }) },
  { role: 'tool', content: toolJunk },
  { role: 'user', content: '[玩家行动]（做）走向传说中的第八个货架' },
  { role: 'assistant', content: JSON.stringify({ narration: '货架尽头有一张旧照片。' }) },
  { role: 'user', content: '[玩家行动]（做）捡起照片' },
  { role: 'assistant', content: JSON.stringify({ narration: '照片背面写着一行小字：' + '字'.repeat(700) }) },
];
const prompt = T.buildPrompt(msgs, 'choice');
check('buildPrompt：首条是标题系统提示',
  prompt[0].role === 'system' && prompt[0].content.indexOf('只输出标题本身') >= 0, prompt[0].content.slice(0, 20));
check('buildPrompt：只含最近 3 轮（最多 6 条对话）',
  prompt.length === 1 + 6 && prompt[1].content.indexOf('这么晚还在营业') >= 0,
  'len=' + prompt.length + ' first=' + prompt[1].content.slice(0, 12));
check('buildPrompt：不含故事系统提示 / 世界卡',
  prompt.slice(1).every(m => m.content.indexOf('世界卡') < 0 && m.content.indexOf('旁白……') < 0));
check('buildPrompt：不含工具调用内容',
  prompt.slice(1).every(m => m.content.indexOf('tool_calls') < 0 && m.content.indexOf('request_image') < 0));
check('buildPrompt：不含 [设定] / [玩家行动] 标记',
  prompt.slice(1).every(m => m.content.indexOf('[设定]') < 0 && m.content.indexOf('[玩家行动]') < 0));
check('buildPrompt：剧情 JSON 解析成旁白纯文本',
  prompt.some(m => m.content === '货架尽头有一张旧照片。') && prompt.some(m => m.content === '「嗯，值夜班。」他擦着杯子。'),
  prompt.map(m => m.role + ':' + m.content.slice(0, 10)).join(' | '));
check('buildPrompt：单条 ≤ 600 字（码点）',
  prompt.every(m => cps(m.content).length <= 600),
  prompt.map(m => cps(m.content).length).join(','));
check('buildPrompt：坏 JSON 当纯文本不抛错',
  T.buildPrompt([{ role: 'assistant', content: '{"narration": 坏掉的' }], 'choice')[1].content.indexOf('坏掉的') >= 0);

/* ---------------- 5. applyTitle 写回护栏 ---------------- */

{
  const st = { id: 's1', title: '新对话', titleAuto: true, titleGen: 0 };
  check('applyTitle：正常写回 + 计次',
    T.applyTitle(st, 's1', '雨夜便利店') === true && st.title === '雨夜便利店' && st.titleGen === 1,
    st.title + '/' + st.titleGen);
}
{
  const st = { id: 's1', title: '旧标题', titleAuto: false, titleGen: 0 };
  check('applyTitle：titleAuto 已改为假 → 不写',
    T.applyTitle(st, 's1', '新标题') === false && st.title === '旧标题' && !st.titleGen,
    st.title);
}
{
  const st = { id: 's1', title: '旧标题', titleAuto: true, titleGen: 0 };
  check('applyTitle：id 不一致 → 不写',
    T.applyTitle(st, 's2', '新标题') === false && st.title === '旧标题',
    st.title);
}
{
  const st = { id: 's1', title: '旧标题', titleAuto: false, titleGen: 3 };
  check('applyTitle：force（手动重新生成）跳过 titleAuto 检查',
    T.applyTitle(st, 's1', '手动新标题', { force: true }) === true && st.title === '手动新标题',
    st.title);
}

/* ---------------- 报告 ---------------- */

let fails = 0;
for (const r of results) {
  if (r.hit) console.log('  ok  ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  else { console.error('  FAIL ' + r.name + (r.detail ? '  [' + r.detail + ']' : '')); fails++; }
}
if (fails) {
  console.error('titles-test：' + fails + ' 项未通过');
  process.exit(1);
}
console.log('titles-test：全部通过（' + results.length + ' 项）');
