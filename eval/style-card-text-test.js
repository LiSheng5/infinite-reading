#!/usr/bin/env node
'use strict';
/*
 * eval/style-card-text-test.js —— 视觉设定卡的「两套视图」回归（Node、不联网）
 *
 * 背景（用户反馈）：思考链里混进了英文画风词与「负面提示词」，像画师的草稿。
 * 原因：视觉设定卡原本只有一套文本（给画师写的），AI1 的 recall_style_card / 🧠 注入记忆
 * 也原样喂给了旁白模型。
 *
 * 现在的约定：
 *   styleCardText(card)          → **给画师**：画风 / 媒介 / 色板 / 人物外观（英文）/ 负面 / 备注，原样
 *   styleCardTextForText(card)   → **给 AI1**：只留画风关键词（注明别复述）+ 中文备注；
 *                                  不含人物英文外观、媒介、色板、负面提示词
 *   recallBlock(story,'style') / forceInjectBlock(story) 一律用文本侧视图
 *
 * 用法：node eval/style-card-text-test.js
 */
const path = require('path');

require(path.join(__dirname, '..', 'src', 'core', 'context.ts'));
const C = global.IR.Context;

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed++; }
}

const CARD = {
  id: 'c1', locked: true,
  styleKeywords: ['anime style', 'cel shading', 'film grain'],
  medium: 'photographic, 35mm film',
  palette: 'deep indigo, muted blue',
  characters: [{ name: '店员', appearanceEn: 'silver hair, tired eyes', outfit: 'navy uniform', features: 'scar on left hand' }],
  negative: 'text, watermark, signature, extra fingers, deformed hands',
  note: '始终深夜、始终下雨',
};

function storyOf(card) {
  return {
    mode: 'choice',
    premise: '标题：雨夜便利店',
    world: { place: '便利店', time: '凌晨三点', characters: [{ name: '店员', presence: '在场' }] },
    rollingStyle: { style: '冷色调', scenes: '深夜便利店' },
    styleCard: card || null,
  };
}

console.log('[1] 画师视图不变：外观与负面提示词都要');
{
  const t = C.styleCardText(CARD);
  ok(t.indexOf('画风：anime style') === 0, '含画风关键词');
  ok(t.indexOf('silver hair') >= 0, '含人物外观（英文，给生图用）');
  ok(t.indexOf('负面：text, watermark') >= 0, '含负面提示词');
  ok(t.indexOf('媒介：') >= 0 && t.indexOf('色板：') >= 0, '含媒介 / 色板');
}

console.log('[2] 文本侧视图（AI1）：只留画风关键词 + 中文备注');
{
  const t = C.styleCardTextForText(CARD);
  ok(t.indexOf('anime style') >= 0, '保留画风关键词（模型据此把握氛围）');
  ok(t.indexOf('始终深夜、始终下雨') >= 0, '保留中文备注（仅作画风参考）');
  ok(t.indexOf('剧情事实') >= 0 && t.indexOf('世界状态卡') >= 0 && t.indexOf('冲突时听剧情') >= 0,
    '备注标注为「画风参考，剧情事实以世界卡为准」');
  ok(t.indexOf('silver hair') < 0 && t.indexOf('navy uniform') < 0, '不含人物英文外观');
  ok(t.indexOf('watermark') < 0 && t.indexOf('负面') < 0, '不含负面提示词');
  ok(t.indexOf('媒介：') < 0 && t.indexOf('色板：') < 0, '不含媒介 / 色板');
  ok(t.indexOf('复述') >= 0, '明确写了「不要复述这些词」');
}

console.log('[3] 召回块与强制注入都走文本侧视图');
{
  const rb = C.recallBlock(storyOf(CARD), 'style');
  ok(rb.indexOf('silver hair') < 0 && rb.indexOf('watermark') < 0, 'recall_style_card 不再带英文外观 / 负面');
  ok(rb.indexOf('anime style') >= 0, 'recall_style_card 仍给画风关键词');
  ok(rb.indexOf('不要在旁白、对白或选项里复述') >= 0, '召回块带「不要复述」指令');

  const fi = C.forceInjectBlock(storyOf(CARD), '玩家行动');
  ok(fi.indexOf('silver hair') < 0 && fi.indexOf('watermark') < 0, '🧠 注入记忆不再带英文外观 / 负面');
  ok(fi.indexOf('【画面基调】') >= 0, '注入块用「画面基调」标签（不再冒充完整设定卡）');
}

console.log('[4] assembleAI1 的整包文本里没有生图参数');
{
  const msgs = C.assembleAI1(storyOf(CARD), '她抬头看你', { forceInject: true, heuristic: false, windowMessages: 2 });
  const all = msgs.map(m => String(m.content || '')).join('\n\n');
  ok(all.indexOf('watermark') < 0 && all.indexOf('silver hair') < 0 && all.indexOf('deformed hands') < 0,
    '不含负面提示词 / 英文人物外观');
  ok(all.indexOf('anime style') >= 0, '画风关键词仍保留（供氛围参考）');
}

console.log('[4b] 画师侧：画风锚带作用域说明（剧情事实优先，备注不能钉死天气）');
{
  const msgs = C.assemblePainter(storyOf(CARD), { sceneRef: '雨停了，天放晴', styleHint: 'anime style' });
  const anchor = msgs.map(m => String(m.content || '')).filter(c => c.indexOf('[画风锚]') === 0)[0] || '';
  ok(anchor.indexOf('以 [最近剧情] 为准') >= 0 && anchor.indexOf('天气') >= 0,
    '[画风锚] 声明「地点 / 时间 / 天气听剧情」');
  ok(anchor.indexOf('始终深夜、始终下雨') >= 0, '备注仍给画师（画风气质要用），但已被限定作用域');
}

console.log('[5] 未锚定：退到滚动风格摘要，不出现「（未锚定，自由发挥）」');
{
  const st = storyOf(null);
  ok(C.textAnchorText(st) === '风格倾向：冷色调\n常见场景：深夜便利店', 'textAnchorText 退到滚动风格摘要');
  const rb = C.recallBlock(st, 'style');
  ok(rb.indexOf('（未锚定，自由发挥）') < 0, '召回块不把「未锚定」这种内部话术说给模型');
  ok(C.recallBlock({ mode: 'choice' }, 'style').indexOf('还没有视觉设定卡') >= 0, '完全没有卡时给降级文案');
}

if (failed) {
  console.error('style-card-text-test：' + failed + ' 项失败');
  process.exit(1);
}
console.log('✅ style-card-text-test 全部通过');
