#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 上下文组装评测（T-P0-1，设计出处 §4.10 C-D）
 *
 * 作用：离线量化「上下文组装 / 压缩逻辑」的好坏，改记忆机制前先跑它。
 *   - 重放长局剧本（eval/mock-story.js 的 IR.MockStory，32 回合）
 *   - 与运行时同源地跑 v2 组装（IR.Context.assembleAI1）与压缩链（IR.Context.compressStory）
 *   - 在第 10 / 20 / 30 回合插入「追问回合」，检查组装出的 prompt 里是否含探针事实
 *   - 只测组装/压缩逻辑本身，不调用任何 API
 *   - 输出 5 类探针命中率 + 总分，并对比 P0 记录的 v0.1 基线（60.0%）
 *
 * 用法：node eval/run.js   [--json] [--no-fail]
 *   --json     追加机器可读的 JSON 结果（CI 解析用）
 *   --no-fail  忽略退出码（默认：总分低于基线或校验未全中 → 退出 1）
 */
const path = require('path');

global.window = global;
const core = f => require(path.join(__dirname, '..', 'src', 'core', f + '.ts'));

const Context = core('context').Context;
const Store = core('store').Store;
const RoleCard = core('roleCard').RoleCard;
const { MockStory } = require(path.join(__dirname, 'mock-story.js'));
if (!Context || !MockStory) {
  console.error('加载失败：Context / MockStory 缺失。');
  process.exit(1);
}

const CATEGORIES = ['角色名', '时间设定', '伏笔原话', '地点细节', '玩家自己说过的事'];

// P0 记录的 v0.1 基线分（system + 最近 20 条 messages + premise），用于回归对比
const BASELINE_V1 = 60.0;

/* ---------- 复刻运行时的一回合归档（与 js/app.js 一致） ---------- */
function buildStory() {
  return Store.newStory({ title: MockStory.title, premise: MockStory.premise, mode: 'choice' });
}

function applyToolCalls(story, calls) {
  // 归档语义与真实链路同源（审查 可维护性 二·10）：工具吸收 / 提案留痕跳过 / 画像门控
  // 都走 IR.Context.absorbToolCalls——这里只注入「画像门控开、合并去重同真源」的写入函数
  Context.absorbToolCalls(story, calls, {
    applyProfile: entries => { story.userProfile = Context.mergeProfile(story.userProfile || [], entries); },
    now: 0,
  });
}

function applyTurn(story, t, opening) {
  const action = opening ? '（故事开场，请给出第一幕）' : (t.player || '继续');
  story.log.push({ type: t.player ? 'player' : 'system', text: action });
  story.messages.push({ role: 'user', content: Context.playerContent(story.premise, action, { includePremise: !!opening }) });

  const r = t.reply;
  if (r.world) Context.mergeWorld(story.world, r.world);           // AI1 自报世界卡（增量浅合并）
  // 条目形状与 turn.js 同源（审查 可维护性 二·10）：narrationEntry（含 versions / activeVersion）
  // 与 assistantEntry（slimReply 四字段）都用 IR.Context 的唯一实现
  const rr = {
    narration: r.narration || '', choices: r.choices || [],
    scene_change: !!r.scene_change, scene_summary: r.scene_summary || '',
  };
  story.log.push(Context.narrationEntry(rr.narration, '', 0));
  story.messages.push(Context.assistantEntry(rr, ''));
  if (r.tool_calls) applyToolCalls(story, r.tool_calls);

  story.turn += 1;
  // 压缩链（C-A/C-C）：超窗口即压进摘要栈
  Context.compressStory(story, { summarize: Context.localSummarize });
}

/* ---------- 逐回合重放 + 追问 ---------- */
function evaluate() {
  const story = buildStory();
  const probesByTurn = new Map();
  for (const p of MockStory.probes) {
    if (!probesByTurn.has(p.atTurn)) probesByTurn.set(p.atTurn, []);
    probesByTurn.get(p.atTurn).push(p);
  }

  const results = [];
  const tokenSeries = [];
  for (let i = 0; i < MockStory.turns.length; i++) {
    const turnNo = i + 1;
    applyTurn(story, MockStory.turns[i], turnNo === 1);

    // token 账：组装长度（每回合都量一次）
    tokenSeries.push(Context.estimateContextTokens(story, '继续'));

    const probes = probesByTurn.get(turnNo);
    if (!probes) continue;
    for (const p of probes) {
      const messages = Context.assembleAI1(story, p.question);
      const text = Context.messagesToText(messages);
      const hit = p.keywords.every(k => text.indexOf(k) !== -1);
      results.push({
        turn: turnNo, category: p.category, question: p.question, answer: p.answer,
        keywords: p.keywords, hit, promptTokens: Context.estimateTokens(text),
        summaries: (story.summaries || []).length,
      });
    }
  }
  return { results, tokenSeries, story, heuristic: checkHeuristic(story), p7: checkP7(), archive: checkArchive(story), mockTools: checkMockTools() };
}

/* ---------- C-E 启发式注入校验（T-P5-3 / §4.10 C-E） ----------
 * 用最终世界卡（角色 / 时间 / 伏笔都齐）各问一句：
 *   命中实体词 → 组装结果里必须出现「对应条目」；无实体词 → 不许注入（零成本）。
 * 这里只测客户端匹配 + 注入，不依赖模型是否调工具（覆盖「静默忽略工具」情形）。 */
function checkHeuristic(story) {
  const cases = [
    { name: '角色名 → 带回人物条目', question: '周叙现在还在店里吗？', must: ['话里有话'], mustNot: [] },
    { name: '伏笔实体词 → 带回伏笔条目', question: '再看看关东煮的锅，锅盖上有没有字', must: ['玩家对关东煮的气味过敏'], mustNot: [] },
    { name: '时间实体词 → 带回时间条目', question: '第八个货架到底在几点出现？', must: ['2:47'], mustNot: [] },
    { name: '无实体词 → 不注入（零成本）', question: '外面还在下雨吗？', must: [], mustNot: ['[自动带回'] },
    { name: '多实体词 → 注入有条数上限', question: '周叙、林姨、关东煮、第八个货架、收音机，都还在吗？', must: ['话里有话'], mustNot: [], limitEntries: true },
    { name: '虚词片段 → 不注入（防误命中）', world: { threads: ['他问那是什么东西'] }, question: '那是什么？', must: [], mustNot: ['[自动带回'] },
    { name: '同一张卡里的实体词仍照常命中', world: { threads: ['他问那是什么东西', '第八个货架只在凌晨三点出现'] }, question: '第八个货架在哪里？', must: ['第八个货架只在凌晨三点出现'], mustNot: [] },
  ];
  const out = [];
  for (const c of cases) {
    const storyLike = c.world ? Object.assign({}, story, { world: c.world }) : story;
    const messages = Context.assembleAI1(storyLike, c.question);
    const text = Context.messagesToText(messages);
    const block = messages
      .filter(m => typeof m.content === 'string' && m.content.indexOf('[自动带回') === 0)
      .map(m => m.content).join('\n');
    const entries = block ? block.split('\n').filter(l => l.indexOf('· ') === 0).length : 0;
    let hit = c.must.every(k => text.indexOf(k) !== -1) && c.mustNot.every(k => text.indexOf(k) === -1);
    if (hit && c.limitEntries) hit = entries > 0 && entries <= Context.HEURISTIC_MAX_ENTRIES;
    out.push({ name: c.name, question: c.question, entries: entries, hit: hit });
  }
  return out;
}

/* ---------- P7 角色卡 + 用户画像校验（T-P7-1 / T-P7-2 / §4.12） ----------
 * 角色卡：自造一张 V2（tEXt `chara`）与一张 V3（iTXt `ccv3`）PNG，验证解析 / 字段映射 / 世界卡对接 / CRC 护栏；
 *        再验 rp 组装带卡与关系、choice 组装不带（不涨常驻预算）。
 * 画像：按需求注入 Top-N + 一行摘要、条数 / 长度封顶、开关语义、合并去重、离线本地提取。
 * PNG 的 CRC 用评测里独立实现（表驱动），避免和被测解析器共用同一份代码。 */

let CRC_TABLE = null;
function crc32Ref(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, payload) {
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  out.write(type, 4, 'latin1');
  payload.copy(out, 8);
  out.writeUInt32BE(crc32Ref(out.subarray(4, 8 + payload.length)), 8 + payload.length);
  return out;
}

function buildPNG(chunks) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([sig].concat(chunks).concat([pngChunk('IEND', Buffer.alloc(0))]));
}

function tEXTPNG(keyword, text) {
  return buildPNG([pngChunk('tEXt', Buffer.from(keyword + '\0' + text, 'latin1'))]);
}

function iTXTPNG(keyword, text) {
  // keyword \0 flag(0) method(0) language \0 translated \0 text
  return buildPNG([pngChunk('iTXt', Buffer.from(keyword + '\0' + '\0' + '\0' + 'en\0' + '\0' + text, 'latin1'))]);
}

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

const V2_CARD = {
  name: '沈砚',
  description: '瘦高，旧呢子大衣，手指有墨迹',
  personality: '冷淡、话少、答应的事一定做到',
  scenario: '深夜的旧书店，外面下着雨',
  first_mes: '「门没锁，进来吧。」他从书堆后面抬了下头。',
  mes_example: '{{char}}: 「书不卖。」\n{{user}}: 为什么？\n{{char}}: 「还没写完。」',
  system_prompt: '保持克制，不要替玩家说话。',
};

const V3_CARD = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '林昭', description: '银发，军装外套', personality: '直接、护短',
    scenario: '战后第三年的海边小镇', first_mes: '「你终于来了。」',
    mes_example: '{{char}}: 「别站在风口。」', system_prompt: '语气短促。',
    creator_notes: '（备注不应盖过 system_prompt）',
  },
};

function checkP7() {
  const out = [];
  const push = (name, hit, detail) => out.push({ name: name, hit: !!hit, detail: detail || '' });

  /* —— 角色卡：解析与映射 —— */
  const card2 = RoleCard && RoleCard.parsePNG(tEXTPNG('chara', b64(JSON.stringify(V2_CARD))));
  push('V2 PNG（tEXt chara）→ 字段映射正确',
    card2 && card2.name === '沈砚' && card2.appearance === V2_CARD.description
      && card2.personality === V2_CARD.personality && card2.scene === V2_CARD.scenario
      && card2.opening === V2_CARD.first_mes && card2.exampleDialogue === V2_CARD.mes_example
      && card2.systemNote === V2_CARD.system_prompt && card2.source === 'st-import',
    card2 ? ('name=' + card2.name + ' source=' + card2.source) : '解析失败');

  const card3 = RoleCard && RoleCard.parsePNG(iTXTPNG('ccv3', b64(JSON.stringify(V3_CARD))));
  push('V3 PNG（iTXt ccv3）→ 解出 data 字段',
    card3 && card3.name === '林昭' && card3.opening === '「你终于来了。」' && card3.systemNote === '语气短促。',
    card3 ? ('name=' + card3.name) : '解析失败');

  const wc = card2 && RoleCard.worldCharacter(card2);
  push('导入卡 → 世界卡人物条目（personality / speech 对接）',
    wc && wc.name === '沈砚' && wc.personality === V2_CARD.personality && wc.speech === '书不卖。',
    wc ? ('speech=' + JSON.stringify(wc.speech)) : '无条目');

  // 坏 CRC / 非 PNG：解析器必须拒绝（不静默出错）
  const bad = tEXTPNG('chara', b64(JSON.stringify(V2_CARD)));
  bad[bad.length - 20] ^= 0xFF;   // 破坏某个 chunk 的 CRC 覆盖范围
  push('坏块 / 非 PNG → 拒绝解析（不静默出错）',
    !RoleCard.parsePNG(bad) && !RoleCard.parsePNG(Buffer.from('not a png at all')) && !RoleCard.parsePNG(null),
    'ok');

  /* —— rp 组装：角色卡 + 关系常驻，choice 不带 —— */
  const storyRp = Store.newStory({ mode: 'rp', premise: '角色扮演：沈砚', characterCard: card2 });
  Context.mergeWorld(storyRp.world, { relationship: { stage: '初次见面', bonds: ['旧书店的雨天'], notes: '彼此都在试探' } });
  const rpText = Context.messagesToText(Context.assembleAI1(storyRp, '你这里有什么书？'));
  push('rp 组装：角色卡 + 示例对话 + 关系记忆进系统提示词',
    rpText.indexOf('[角色卡]') !== -1 && rpText.indexOf('性格：冷淡、话少') !== -1
      && rpText.indexOf('口吻') !== -1 && rpText.indexOf('[你们的关系]') !== -1 && rpText.indexOf('旧书店的雨天') !== -1,
    'ok');

  const storyChoice = Store.newStory({ mode: 'choice', premise: 'x', characterCard: card2 });
  const chText = Context.messagesToText(Context.assembleAI1(storyChoice, '继续'));
  push('choice 组装不常驻角色卡（不涨预算）', chText.indexOf('[角色卡]') === -1, 'ok');

  /* —— 用户画像：按需 Top-N + 一行摘要 + 预算 —— */
  const entries = [
    { text: '我怕蜘蛛', kind: 'taboo' },
    { text: '我喜欢雨天', kind: 'preference' },
    { text: '我住在城南', kind: 'fact' },
    { text: '我在写一本小说', kind: 'fact' },
  ];
  const profText = Context.messagesToText(Context.assembleAI1(storyRp, '墙角有一只很大的蜘蛛', { profile: entries }));
  const profLines = profText.split('\n').filter(l => l.indexOf('· ') === 0);
  push('画像：命中话题的条目被注入、无关条目不进（Top-N 精确）',
    profText.indexOf('[关于玩家] 画像 4 条') !== -1 && profLines.length === 1 && profLines[0].indexOf('我怕蜘蛛') !== -1,
    profLines.join(' / ') || '无');

  push('画像：关闭（不传）时零注入',
    Context.messagesToText(Context.assembleAI1(storyRp, '你这里有什么书？')).indexOf('[关于玩家]') === -1, 'ok');

  const hitAll = Context.profileBlock(entries, '蜘蛛、雨天、城南、小说都聊到了', 99);
  const lines = hitAll.split('\n').filter(l => l.indexOf('· ') === 0);
  push('画像：单轮注入条数 ≤ Top-N', lines.length > 0 && lines.length <= Context.PROFILE_TOP_N, '注入 ' + lines.length + ' 条');

  // 多条都命中时：块长必须封在预算内（摘要 + Top-N + 截断）
  const many = [];
  for (let i = 0; i < 8; i++) many.push({ text: '画像' + i + '：'.padEnd(30, '细节'), kind: 'fact' });
  const capped = Context.profileBlock(many, '画像相关的都说说');
  push('画像：块长封顶', capped.length <= Context.PROFILE_MAX_CHARS, capped.length + ' 字');

  push('画像：开关语义（all / 按模式）',
    Context.profileEnabledFor('all', 'choice') && Context.profileEnabledFor({ rp: true }, 'rp')
      && !Context.profileEnabledFor({ rp: true }, 'chat') && !Context.profileEnabledFor({}, 'rp'),
    'ok');

  const merged = Context.mergeProfile([{ text: '我怕蜘蛛', kind: 'fact' }], [{ text: '我怕蜘蛛', kind: 'taboo' }, { text: '我喜欢雨天', kind: 'preference' }]);
  push('画像：合并去重（同文只留最新 kind）',
    merged.length === 2 && merged[0].kind === 'taboo', '共 ' + merged.length + ' 条');

  const local = Context.localProfileExtract('我从小就怕蜘蛛。对了，我喜欢雨天，叫我阿泽就好。');
  push('离线本地提取（确定性规则）',
    local.length >= 2 && local.some(e => e.kind === 'taboo' && e.text.indexOf('怕蜘蛛') !== -1)
      && local.some(e => e.kind === 'preference' && e.text.indexOf('雨天') !== -1),
    local.map(e => e.kind).join('/') || '无');

  push('离线本地提取：问句不算画像',
    Context.localProfileExtract('你还记得我怕什么吗？').length === 0,
    'ok');

  /* —— AI1 回包宽容解析（真实模型常见坏包：裸换行 / 截断 / 围栏） —— */
  const okJson = Context.tolerantJSONParse('{"narration":"雨停了。","choices":["出门","继续等"],"scene_change":false}');
  push('宽容解析：正常 JSON 照常',
    okJson && okJson.narration === '雨停了。', okJson ? 'ok' : 'null');

  const nlJson = Context.tolerantJSONParse('{"narration":"他说：\n「门没锁。」\n雨声很轻。","choices":[]}');
  push('宽容解析：字符串里的裸换行能救回',
    nlJson && nlJson.narration.indexOf('门没锁') !== -1 && nlJson.narration.indexOf('\n') !== -1,
    nlJson ? JSON.stringify(nlJson.narration).slice(0, 34) : 'null');

  const cut = Context.tolerantJSONParse('{"narration":"台灯下，他抬了下头。「雨的书在第三排。」","choices":["往第三排走"],"scene_change":true,"world":{"place":"旧书店","time":"深夜"');
  push('宽容解析：尾部截断（括号没闭合）能救回',
    cut && cut.narration.indexOf('第三排') !== -1 && cut.world && cut.world.place === '旧书店',
    cut ? 'ok' : 'null');

  const fenced = Context.tolerantJSONParse('好的，这是回复：\n```json\n{"narration":"雨小了。"}\n```\n（完）');
  push('宽容解析：围栏与前后说明文字能剥掉',
    fenced && fenced.narration === '雨小了。', fenced ? 'ok' : 'null');

  push('宽容解析：纯散文返回 null（走 fail-open 展示原文）',
    Context.tolerantJSONParse('这只是一段普通的散文，没有 JSON。') === null, 'ok');

  /* —— 剧情模式 v0.3 中文键契约：解析归一化 + 历史组装一致性 —— */
  const cn = Context.normalizeAIReply(Context.tolerantJSONParse(
    '{"旁白":"雨停了。","人物":[{"名字":"周叙","在场":"在场","性格":"克制","说话方式":"简短"}],"地点":"便利店","时间":"凌晨三点","伏笔":["挑便宜的就走"],"画面":"暖光货架","场景切换":true,"选项":["出门","继续等"]}'));
  push('中文键契约：旁白 / 选项 / 场景切换 / 画面归一化',
    cn && cn.narration === '雨停了。' && cn.choices.length === 2 && cn.scene_change === true
      && cn.scene_summary === '暖光货架', cn ? 'ok' : 'null');
  push('中文键契约：人物 / 地点 / 时间 / 伏笔 → world（下游链路不用改）',
    cn && cn.world && cn.world.place === '便利店' && cn.world.time === '凌晨三点'
      && cn.world.threads[0] === '挑便宜的就走' && cn.world.characters[0].name === '周叙', 'ok');
  push('中文键契约：英文键回包（chat / rp / 旧存档）原样透传',
    Context.normalizeAIReply({ narration: 'x', choices: [] }).narration === 'x', 'ok');

  const storyCn = Store.newStory({ mode: 'choice', premise: 'x' });
  storyCn.messages.push(
    { role: 'user', content: '[玩家行动] 推门' },
    { role: 'assistant', content: JSON.stringify({ narration: '门开了。', choices: ['进去'], scene_change: true, scene_summary: '门口' }) },
  );
  const cnText = Context.messagesToText(Context.assembleAI1(storyCn, '继续'));
  push('剧情模式组装：历史 assistant 消息转成中文键（与本轮契约一致）',
    cnText.indexOf('"旁白":"门开了。"') !== -1 && cnText.indexOf('"narration"') === -1, 'ok');

  return out;
}

/* ---------- 归档形状对齐校验（审查 可维护性 二·10） ----------
 * 复刻归档此前与 turn.js 字段漂移：缺 versions / activeVersion、提案留痕没跳过、画像无门控。
 * 现归档走 IR.Context 共享实现（narrationEntry / assistantEntry / absorbToolCalls），
 * 这里把「形状契约」钉住：共享实现或复刻一漂移，评测即失败。 */
function checkArchive(story) {
  const out = [];
  const push = (name, hit, detail) => out.push({ name: name, hit: !!hit, detail: detail || '' });

  const narr = (story.log || []).filter(e => e && e.type === 'narration');
  push('旁白条目带 versions / activeVersion 版本栈（与 turn.js 同形状）',
    narr.length > 0 && narr.every(e => Array.isArray(e.versions) && e.versions.length >= 1
      && Number.isInteger(e.activeVersion) && e.versions[e.activeVersion] === e.text),
    narr.length + ' 条');

  const asst = (story.messages || []).filter(m => m && m.role === 'assistant');
  push('assistant 消息 = slimReply 四字段 JSON（无 world / tool_calls）',
    asst.length > 0 && asst.every(m => {
      try {
        const j = JSON.parse(m.content);
        return j && typeof j.narration === 'string' && Array.isArray(j.choices)
          && typeof j.scene_change === 'boolean' && typeof j.scene_summary === 'string'
          && !('world' in j) && !('tool_calls' in j);
      } catch (_) { return false; }
    }), asst.length + ' 条');

  // 合成调用钉语义：提案工具跳过留痕；画像写入走 applyProfile 门控（二·10 两个漂移点）
  const s2 = Store.newStory({ mode: 'chat', premise: 'x' });
  applyToolCalls(s2, [{ name: 'email_propose', arguments: '{"to":"a@b.c","subject":"hi","body":"x"}' }]);
  push('提案类工具吸收时跳过 tool 留痕（留痕是提案卡本身）',
    s2.log.filter(e => e.type === 'tool').length === 0, s2.log.length + ' 条留痕');
  applyToolCalls(s2, [{ name: 'update_memory', arguments: '{"text":"记一下","profile":[{"text":"我怕蜘蛛","kind":"taboo"}]}' }]);
  push('update_memory 画像经门控写入 + per-tool 留痕文案同源',
    (s2.userProfile || []).length === 1 && s2.log.some(e => e.type === 'tool' && e.summary === '更新记忆：记一下'),
    (s2.userProfile || []).length + ' 条画像 / ' + s2.log.filter(e => e.type === 'tool').map(e => e.summary).join('、'));

  return out;
}

/* ---------- mock 工具形状 == 运行时 schema（审查 文档一致性 5.7） ----------
 * mock-story 的 tool_calls 曾写出真实 schema 里不存在的参数（update_memory 的 scope），
 * 真实链路会整包忽略 → 剧本「声称记住了」实际什么都没写，评测数据掺水。
 * 这里把剧本里的每次工具调用对着运行时导出的工具 schema 钉一遍：
 * 工具名必须在注册表里、参数键必须是 schema properties 的子集。 */
function checkMockTools() {
  const out = [];
  const push = (name, hit, detail) => out.push({ name: name, hit: !!hit, detail: detail || '' });

  const registry = {};
  for (const t of [].concat(
    Context.TOOLS_AI1 || [], Context.REQUEST_IMAGE_DIRECT_TOOL || [],
    Context.SCHEDULE_TOOLS || [], Context.EMAIL_TOOLS || [], Context.PAYMENT_TOOLS || [])) {
    if (t && t.function && t.function.name) registry[t.function.name] = t.function;
  }

  let calls = 0;
  for (let i = 0; i < MockStory.turns.length; i++) {
    const list = (MockStory.turns[i].reply && MockStory.turns[i].reply.tool_calls) || [];
    for (const c of list) {
      calls += 1;
      const fn = (c && c.function) || {};
      const label = '第' + (i + 1) + '回合 ' + (fn.name || '(无名)');
      const def = registry[fn.name];
      if (!def) { push('mock 工具在运行时注册表里：' + label, false, '未知工具名'); continue; }
      let args = null;
      try { args = JSON.parse(fn.arguments || '{}'); } catch (_) { args = null; }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        push('mock 工具参数是 JSON 对象：' + label, false, 'arguments 不是对象'); continue;
      }
      const props = (def.parameters && def.parameters.properties) || {};
      const extra = Object.keys(args).filter(k => !Object.prototype.hasOwnProperty.call(props, k));
      push('mock 工具参数形状 == schema：' + label, extra.length === 0,
        extra.length ? 'schema 外参数：' + extra.join('、') : 'ok');
    }
  }
  push('剧本含工具调用（本组校验有覆盖）', calls > 0, calls + ' 次');
  return out;
}

/* ---------- 报告 ---------- */
function displayWidth(str) {
  let w = 0;
  for (const ch of String(str)) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}
function pad(str, width) {
  const s = String(str);
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

function report(out) {
  const { results, tokenSeries } = out;
  const lines = [];
  lines.push('无限阅读 · 上下文组装评测（T-P0-1 / §4.10 C-D）');
  lines.push('组装实现：IR.Context.assembleAI1（v2：摘要行 + 摘要栈 + 保留窗口 ' + Context.DEFAULT_KEEP_MESSAGES + ' 条 + C-E 启发式注入）');
  lines.push('剧本：' + MockStory.title + '（' + MockStory.turns.length + ' 回合）· 探针 ' + results.length + ' 条 · 不消耗任何 API');
  lines.push('');
  lines.push('—— 追问回合明细 ——');
  for (const r of results) {
    const mark = r.hit ? '[命中]' : '[未中]';
    const q = r.question.length > 20 ? r.question.slice(0, 19) + '…' : r.question;
    lines.push('第' + pad(r.turn, 3) + '回合  ' + pad(r.category, 14) + '  ' + mark + '  ' + pad(q, 42) + ' → ' + r.answer + '  (' + r.promptTokens + ' 字 / ' + r.summaries + ' 幕摘要)');
  }
  lines.push('');
  lines.push('—— 5 类探针命中率 ——');
  const perCat = {};
  for (const c of CATEGORIES) perCat[c] = { hit: 0, total: 0 };
  for (const r of results) {
    if (!perCat[r.category]) perCat[r.category] = { hit: 0, total: 0 };
    perCat[r.category].total += 1;
    if (r.hit) perCat[r.category].hit += 1;
  }
  let totalHit = 0, totalAll = 0;
  for (const c of CATEGORIES) {
    const v = perCat[c];
    totalHit += v.hit; totalAll += v.total;
    const pct = v.total ? (v.hit / v.total * 100).toFixed(1) : '0.0';
    lines.push(pad(c, 18) + v.hit + '/' + v.total + '   (' + pct + '%)');
  }
  const score = totalAll ? (totalHit / totalAll * 100).toFixed(1) : '0.0';
  const tmin = Math.min.apply(null, tokenSeries);
  const tmax = Math.max.apply(null, tokenSeries);
  const tlast = tokenSeries[tokenSeries.length - 1];
  lines.push('');
  lines.push('总分：' + totalHit + '/' + totalAll + ' = ' + score + '%');
  lines.push('对比 v0.1 基线（P0 记录）：' + BASELINE_V1 + '% → ' + (Number(score) >= BASELINE_V1 ? '不低于基线 ✅' : '低于基线 ❌'));
  lines.push('组装长度（字）：最小 ' + tmin + ' / 最大 ' + tmax + '（末回合 ' + tlast + '）—— 压缩链使其保持稳定');

  const heur = out.heuristic || [];
  if (heur.length) {
    lines.push('');
    lines.push('—— C-E 启发式注入（T-P5-3 / §4.10 C-E：与工具召回并行的兜底）——');
    for (const h of heur) {
      const q = h.question.length > 20 ? h.question.slice(0, 19) + '…' : h.question;
      lines.push(pad(h.name, 30) + (h.hit ? '[命中]' : '[未中]') + '  ' + pad(q, 40) + ' 注入 ' + h.entries + ' 条');
    }
    const hhit = heur.filter(x => x.hit).length;
    lines.push('C-E 校验：' + hhit + '/' + heur.length + (hhit === heur.length
      ? ' ✅（输入含实体词 → 上下文出现对应条目；无实体词不注入）'
      : ' ❌'));
  }

  const p7 = out.p7 || [];
  if (p7.length) {
    lines.push('');
    lines.push('—— P7 角色卡 + 用户画像（T-P7-1 / T-P7-2 / §4.12）——');
    for (const c of p7) lines.push(pad(c.name, 40) + (c.hit ? '[命中]' : '[未中]') + '  ' + c.detail);
    const phit = p7.filter(x => x.hit).length;
    lines.push('P7 校验：' + phit + '/' + p7.length + (phit === p7.length ? ' ✅' : ' ❌'));
  }

  const arch = out.archive || [];
  if (arch.length) {
    lines.push('');
    lines.push('—— 归档形状对齐（审查 可维护性 二·10：与 turn.js 共用 IR.Context 归档）——');
    for (const c of arch) lines.push(pad(c.name, 56) + (c.hit ? '[命中]' : '[未中]') + '  ' + c.detail);
    const ahit = arch.filter(x => x.hit).length;
    lines.push('归档校验：' + ahit + '/' + arch.length + (ahit === arch.length ? ' ✅' : ' ❌'));
  }

  const mock = out.mockTools || [];
  if (mock.length) {
    lines.push('');
    lines.push('—— mock 工具形状 == 运行时 schema（审查 文档一致性 5.7：剧本参数对齐工具注册表）——');
    for (const c of mock) lines.push(pad(c.name, 56) + (c.hit ? '[命中]' : '[未中]') + '  ' + c.detail);
    const mhit = mock.filter(x => x.hit).length;
    lines.push('mock 工具校验：' + mhit + '/' + mock.length + (mhit === mock.length ? ' ✅' : ' ❌'));
  }

  console.log(lines.join('\n'));
  return {
    results, totalHit, totalAll, score: Number(score), tmin, tmax, tlast,
    heuristic: heur, heuristicHit: heur.filter(x => x.hit).length,
    p7: p7, p7Hit: p7.filter(x => x.hit).length,
    archive: arch, archiveHit: arch.filter(x => x.hit).length,
    mockTools: mock, mockToolsHit: mock.filter(x => x.hit).length,
  };
}

const summary = report(evaluate());

/* ---------- 退出码（供 CI 拦截回归） ----------
 * 总分低于 v0.1 基线，或 C-E / P7 校验未全中 → 退出 1。
 * 只想看报告、不在意退出码时加 --no-fail。 */
const failed = [];
if (summary.score < BASELINE_V1) failed.push('总分 ' + summary.score + '% 低于基线 ' + BASELINE_V1 + '%');
if (summary.heuristicHit < summary.heuristic.length) {
  failed.push('C-E 校验 ' + summary.heuristicHit + '/' + summary.heuristic.length + ' 未全中');
}
if (summary.p7Hit < summary.p7.length) {
  failed.push('P7 校验 ' + summary.p7Hit + '/' + summary.p7.length + ' 未全中');
}
if (summary.archiveHit < summary.archive.length) {
  failed.push('归档形状校验 ' + summary.archiveHit + '/' + summary.archive.length + ' 未全中');
}
if (summary.mockToolsHit < summary.mockTools.length) {
  failed.push('mock 工具形状校验 ' + summary.mockToolsHit + '/' + summary.mockTools.length + ' 未全中');
}

if (process.argv.indexOf('--json') !== -1) {
  console.log('\n' + JSON.stringify({
    story: MockStory.title,
    turns: MockStory.turns.length,
    keepMessages: Context.DEFAULT_KEEP_MESSAGES,
    totalHit: summary.totalHit,
    totalAll: summary.totalAll,
    score: summary.score,
    baselineV1: BASELINE_V1,
    assembledTokens: { min: summary.tmin, max: summary.tmax, last: summary.tlast },
    heuristic: { hit: summary.heuristicHit, total: summary.heuristic.length, checks: summary.heuristic },
    p7: { hit: summary.p7Hit, total: summary.p7.length, checks: summary.p7 },
    archive: { hit: summary.archiveHit, total: summary.archive.length, checks: summary.archive },
    mockTools: { hit: summary.mockToolsHit, total: summary.mockTools.length, checks: summary.mockTools },
    probes: summary.results.map(r => ({ turn: r.turn, category: r.category, hit: r.hit, answer: r.answer })),
  }, null, 2));
}

if (failed.length && process.argv.indexOf('--no-fail') === -1) {
  console.error('\n❌ 评测未通过：\n  - ' + failed.join('\n  - '));
  process.exit(1);
}
if (!failed.length) console.log('\n✅ 评测通过（可作 CI 门禁）');
