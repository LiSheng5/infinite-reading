/*
 * eval/prefs-test.js —— 设置分层纯逻辑测试（UI-3 §6，Node、不联网）
 * 覆盖：effective / resolveChatCfg / visibleFor / sanitizePrefs / 导出剥凭证 /
 *       migrateStory 透传清洗 / migrateSettings 补 profiles / 压缩阈值随有效配置走。
 */
'use strict';
const path = require('path');

require(path.join(__dirname, '..', 'src', 'core', 'prefs.ts'));
require(path.join(__dirname, '..', 'src', 'core', 'context.ts'));
require(path.join(__dirname, '..', 'src', 'core', 'tree.ts'));   // store.js 依赖 IR.Tree（加载顺序同 index.html）
require(path.join(__dirname, '..', 'src', 'core', 'store.ts'));

const P = global.IR.Prefs;
const C = global.IR.Context;
const Store = global.IR.Store;

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed++; }
}
function eq(a, b, msg) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok(same, msg + (same ? '' : '（实际 ' + JSON.stringify(a) + ' ≠ 期望 ' + JSON.stringify(b) + '）'));
}

const FAKE_KEY = 'sk-FAKE-SECRET-0000-DO-NOT-LEAK';

function baseSettings() {
  return Store.migrateSettings({
    chat: { baseUrl: 'https://api.default.example/v1', apiKey: 'sk-default', model: 'default-model', temperature: 0.9, contextWindow: 10000 },
    profiles: [
      { id: 'p1', name: '甲', provider: 'openai-compatible', baseUrl: 'https://api.one.example/v1', apiKey: 'sk-one', model: 'model-one', temperature: 0.5, contextWindow: 20000 },
      { id: 'p2', name: '乙', provider: 'openai-compatible', baseUrl: 'https://api.two.example/v1', apiKey: 'sk-two', model: 'model-two', temperature: 0.3, contextWindow: 40000 },
    ],
  });
}

console.log('[1] effective：覆盖 / 跟随 / 各键独立');
{
  const s = baseSettings();
  // 缺省跟随全局（P-1 v0.11.0：trigger（出图时机）已下线，effective 不再有该键）
  eq(P.effective(s, { prefs: {} }, 'choices'), 'tray', '无 prefs 时 choices 跟随全局');
  eq(P.effective(s, { prefs: {} }, 'showReasoning'), true, '无 prefs 时 showReasoning 跟随全局');
  eq(P.effective(s, { prefs: {} }, 'ui.fontScale'), 'md', '无 prefs 时字号跟随全局默认');
  // story.prefs 覆盖全局
  const story = { prefs: { choices: 'always', showReasoning: false, ui: { fontScale: 'lg', layout: 'split' }, tools: { email: false } } };
  eq(P.effective(s, story, 'choices'), 'always', 'prefs.choices 覆盖全局');
  eq(P.effective(s, story, 'showReasoning'), false, 'prefs.showReasoning 覆盖全局');
  eq(P.effective(s, story, 'ui.fontScale'), 'lg', 'prefs.ui.fontScale 覆盖全局');
  // 各键独立：一个键的覆盖不影响别的键
  eq(P.effective(s, story, 'ui.density'), 'standard', 'ui.density 不受 ui.fontScale 覆盖影响');
  eq(P.effective(s, story, 'ui.splitRatio'), 0.5, 'ui.splitRatio 未覆盖 → 跟随全局');
  const tools = P.effective(s, story, 'tools');
  eq(tools.email, false, 'prefs.tools.email 覆盖');
  eq(tools.payment, true, 'prefs.tools.payment 未覆盖 → 跟随全局可用性');
  eq(tools.schedule, true, 'prefs.tools.schedule 未覆盖 → 跟随全局可用性');
  // profileId
  eq(P.effective(s, { prefs: { profileId: 'p1' } }, 'profileId'), 'p1', 'profileId 命中模型库');
  eq(P.effective(s, { prefs: {} }, 'profileId'), 'default', '未设置 profileId → default');
  eq(P.effective(s, { prefs: { profileId: 'nope' } }, 'profileId'), 'default', 'profileId 找不到 → 回退 default');
  const missingInfo = P.effectiveInfo(s, { prefs: { profileId: 'nope' } }, 'profileId');
  ok(missingInfo.missing === true, 'profileId 找不到时 effectiveInfo.missing = true');
  ok(P.effectiveInfo(s, { prefs: { profileId: 'p1' } }, 'profileId').missing === false, 'profileId 命中时 missing = false');
}

console.log('[2] resolveChatCfg：命中 / 缺失 / 未设置');
{
  const s = baseSettings();
  const hit = P.resolveChatCfg(s, { prefs: { profileId: 'p2' } });
  ok(hit.source === 'story' && hit.missing === false, '命中 profile → source=story, missing=false');
  eq(hit.cfg.model, 'model-two', '命中 profile → 用 profile 的 model');
  eq(hit.cfg.baseUrl, 'https://api.two.example/v1', '命中 profile → 用 profile 的 baseUrl');
  eq(hit.cfg.contextWindow, 40000, '命中 profile → 用 profile 的 contextWindow');

  const lost = P.resolveChatCfg(s, { prefs: { profileId: 'gone' } });
  ok(lost.source === 'default' && lost.missing === true, 'profileId 不存在 → 回退默认且 missing=true');
  eq(lost.cfg.model, 'default-model', '回退到默认主模型');

  const unset = P.resolveChatCfg(s, {});
  ok(unset.source === 'default' && unset.missing === false, '未设置 → 默认，missing=false');
  eq(unset.cfg.model, 'default-model', '未设置 → settings.chat');

  // 空 baseUrl / 空 model 的 profile 沿用默认（留空沿用）
  const s2 = Store.migrateSettings({
    chat: { baseUrl: 'https://api.default.example/v1', apiKey: 'sk-default', model: 'default-model' },
    profiles: [{ id: 'p9', name: '丙', model: '' }],
  });
  const partial = P.resolveChatCfg(s2, { prefs: { profileId: 'p9' } });
  eq(partial.cfg.model, 'default-model', 'profile.model 留空 → 沿用默认 model');
  eq(partial.cfg.baseUrl, 'https://api.default.example/v1', 'profile.baseUrl 留空 → 沿用默认 baseUrl');
  eq(partial.source, 'story', '仍是本对话来源');
}

console.log('[3] visibleFor：三种模式的可见控件集合');
{
  const choice = P.visibleFor('choice');
  const rp = P.visibleFor('rp');
  const chat = P.visibleFor('chat');
  ok(choice.has('model') && choice.has('choices') && choice.has('layout') && choice.has('showReasoning'),
    '剧情：模型 / 选项显示 / 布局 / 思考过程');
  ok(choice.has('style') && choice.has('mode'), '剧情：画风入口 + 推进模式');
  ok(!choice.has('trigger'), '剧情：不含出图时机（P-1 下线）');
  ok(!choice.has('tools') && !choice.has('schedule'), '剧情：不含工具开关 / 定时主动开关');
  ok(chat.has('model') && chat.has('tools') && chat.has('layout') && chat.has('showReasoning'), '智能体：模型 / 工具开关 / 布局 / 思考过程');
  ok(!chat.has('trigger') && !chat.has('choices'), '智能体：不含出图时机 / 选项显示');
  ok(rp.has('model') && rp.has('characterCard') && rp.has('layout') && rp.has('showReasoning') && rp.has('schedule'),
    '扮演：模型 / 角色卡入口 / 布局 / 思考过程 / 定时主动开关');
  ok(!rp.has('tools'), '扮演：不含工具开关组');
  ok(!rp.has('trigger') && !rp.has('choices'), '扮演：不含出图时机 / 选项显示');
  ok(P.visibleFor('unknown') instanceof Set, '未知模式回落剧情集合且不抛错');
}

console.log('[4] sanitizePrefs：丢未知键 / 剥凭证 / profileId 校验');
{
  const dirty = {
    profileId: 'p1',
    profileLabel: '甲 · model-one',
    trigger: 'manual',
    unknownTop: 'x',
    apiKey: FAKE_KEY,
    key: FAKE_KEY,
    token: FAKE_KEY,
    baseUrl: 'https://evil.example',
    tools: { email: false, token: FAKE_KEY, hacker: true, apiKey: FAKE_KEY },
    ui: { layout: 'split', splitRatio: 0.9, evil: { baseUrl: 'https://evil.example', key: FAKE_KEY }, fontScale: 'huge' },
  };
  const clean = P.sanitizePrefs(dirty);
  ok(!('unknownTop' in clean), '丢弃未知顶层键');
  ok(!('apiKey' in clean) && !('key' in clean) && !('token' in clean) && !('baseUrl' in clean), '剥掉顶层凭证形字段');
  eq(clean.profileId, 'p1', 'profileId 保留');
  eq(clean.profileLabel, '甲 · model-one', 'profileLabel 保留（仅显示）');
  eq(clean.tools, { email: false }, 'tools 只留白名单布尔键，token/apiKey 剥掉');
  ok(!('evil' in clean.ui), 'ui 深层未知键丢弃（连同其中的 baseUrl / key）');
  ok(!('fontScale' in clean.ui) || clean.ui.fontScale !== 'huge', 'ui.fontScale 非法值丢弃');
  eq(clean.ui.splitRatio, 0.72, 'ui.splitRatio 夹到 0.72');
  // P-1（v0.11.0）：trigger（出图时机）随 PREF_KEYS 下线——旧包里的 trigger 按未知键丢弃、不报错
  ok(!('trigger' in clean), 'trigger 不在白名单 → 被丢弃（旧包导入不报错）');
  {
    let threw = false;
    let dropped = null;
    try { dropped = P.sanitizePrefs({ trigger: 'manual', profileId: 'p1' }); } catch (_) { threw = true; }
    ok(!threw && dropped && !('trigger' in dropped) && dropped.profileId === 'p1',
      '旧包带 trigger 导入 → 被丢弃、不报错（其余键正常）');
  }

  const badId = P.sanitizePrefs({ profileId: 123, trigger: 'manual' });
  ok(!('profileId' in badId), 'profileId 非字符串被丢弃');
  const arrId = P.sanitizePrefs({ profileId: ['p1'] });
  ok(!('profileId' in arrId), 'profileId 数组被丢弃');
  ok(JSON.stringify(P.sanitizePrefs(null)) === '{}', 'sanitizePrefs(null) → {} 不抛错');
  ok(JSON.stringify(P.sanitizePrefs('str')) === '{}', 'sanitizePrefs(字符串) → {} 不抛错');
  // 任意嵌套层级的凭证都要剥
  const deep = P.sanitizePrefs({ ui: { layout: 'split' }, tools: { image: true }, profileId: 'p1' });
  ok(!JSON.stringify(deep).includes(FAKE_KEY), '清洗结果不含假密钥串');
}

console.log('[5] 导出：整个 JSON 不含 apiKey / baseUrl 键名与假密钥串');
{
  const s = baseSettings();
  const st = Store.newStory({ id: 'story-export', title: '导出测试', mode: 'choice' });
  st.prefs = {
    profileId: 'p1',
    profileLabel: P.profileLabel(s, 'p1'),
    apiKey: FAKE_KEY,
    tools: { token: FAKE_KEY },
    ui: { layout: 'split', nested: { baseUrl: 'https://evil.example', key: FAKE_KEY } },
  };
  st.world = Object.assign(st.world, { apiKey: FAKE_KEY, place: '测试地点' });
  st.log = [{ type: 'system', text: 'hello', baseUrl: 'https://evil.example', apiKey: FAKE_KEY }];
  const pack = Store.buildStoryPack(st, 'full', [{ id: 'im1', alt: 'a', prompt: 'p' }], s);
  const text = JSON.stringify(pack);
  ok(!/"apiKey"\s*:/.test(text), '导出 JSON 无 apiKey 键名');
  ok(!/"baseUrl"\s*:/.test(text), '导出 JSON 无 baseUrl 键名');
  ok(!/"key"\s*:/.test(text), '导出 JSON 无 key 键名');
  ok(!/"token"\s*:/.test(text), '导出 JSON 无 token 键名');
  ok(text.indexOf(FAKE_KEY) < 0, '导出 JSON 不含假密钥串');
  ok(!!pack.prefs && pack.prefs.profileId === 'p1', '导出保留 prefs.profileId（不透明 id）');
  ok(!!pack.prefs && typeof pack.prefs.profileLabel === 'string' && pack.prefs.profileLabel.indexOf('model-one') >= 0,
    '导出附 prefs.profileLabel（名称 · 模型名）');
  eq(pack.world.place, '测试地点', '正常字段不受剥凭证影响');
  const brief = Store.buildStoryPack(st, 'brief', [], s);
  ok(!/"apiKey"\s*:/.test(JSON.stringify(brief)), 'brief 包同样无凭证键名');
}

console.log('[6] migrateStory：无 prefs 不报错；恶意 prefs 被清洗');
{
  const old = Store.newStory({ id: 'old', title: '旧档', mode: 'choice' });
  delete old.prefs;
  let threw = false;
  let migrated = null;
  try { migrated = Store.migrateStory(old); } catch (_) { threw = true; }
  ok(!threw && migrated, '旧故事（无 prefs）→ 不抛错');
  ok(!migrated.prefs || Object.keys(migrated.prefs).length === 0, '旧故事不凭空长出 prefs');

  const evil = Store.newStory({ id: 'evil', title: '恶意', mode: 'chat' });
  evil.prefs = {
    profileId: 'p1', apiKey: FAKE_KEY, baseUrl: 'https://evil.example',
    tools: { payment: false, token: FAKE_KEY, apiKey: FAKE_KEY },
    ui: { layout: 'stack', deep: { key: FAKE_KEY, baseUrl: 'https://evil.example' } },
    junk: 1,
  };
  const m2 = Store.migrateStory(evil);
  ok(!('apiKey' in (m2.prefs || {})) && !('baseUrl' in (m2.prefs || {})), 'migrateStory 后 prefs 无凭证键');
  ok(!JSON.stringify(m2.prefs).includes(FAKE_KEY), 'migrateStory 后 prefs 不含假密钥串');
  ok(!(m2.prefs || {}).junk, 'migrateStory 丢弃未知键');
  eq((m2.prefs || {}).profileId, 'p1', 'profileId 透传');
  eq((m2.prefs || {}).tools, { payment: false }, 'tools 清洗后透传');
  eq((m2.prefs || {}).ui, { layout: 'stack' }, 'ui 清洗后透传');

  // 落盘序列化同样带清洗（serializeStory）
  const ser = JSON.stringify(Store.serializeStory(evil));
  ok(!/"apiKey"\s*:/.test(ser) && ser.indexOf(FAKE_KEY) < 0, 'serializeStory 落盘也不含凭证');
}

console.log('[7] migrateSettings：幂等补 profiles；已有数据原样保留');
{
  const raw = {
    chat: { baseUrl: 'https://a.example/v1', apiKey: 'sk-a', model: 'm-a' },
    profiles: [{ id: 'p1', name: '甲', baseUrl: 'https://b.example/v1', apiKey: 'sk-b', model: 'm-b', temperature: 0.2 }],
  };
  const one = Store.migrateSettings(raw);
  ok(Array.isArray(one.profiles), 'profiles 是数组');
  eq(one.profiles.length, 1, '已有 profile 保留');
  eq(one.profiles[0].apiKey, 'sk-b', 'profile 的 apiKey 原样保留（全局设置允许存密钥）');
  eq(one.profiles[0].model, 'm-b', 'profile 的 model 原样保留');
  eq(one.profiles[0].temperature, 0.2, 'profile 的 temperature 原样保留');
  const again = Store.migrateSettings(one);
  eq(again.profiles, one.profiles, '二次迁移幂等');
  const empty = Store.migrateSettings({});
  eq(empty.profiles, [], '缺省补 profiles: []');
  eq(empty.ui.fontScale, 'md', '缺省补 ui.fontScale');
  eq(empty.ui.width, 'standard', '缺省补 ui.width');
  eq(empty.ui.density, 'standard', '缺省补 ui.density');
  // 非数组 / 坏数据不炸
  eq(Store.migrateSettings({ profiles: 'bad' }).profiles, [], 'profiles 非数组 → []');
  const withBad = Store.migrateSettings({ profiles: [{ id: 'ok', model: 'm' }, null, { name: '无 id' }] });
  ok(withBad.profiles.every(p => p && typeof p.id === 'string' && p.id), '坏 profile 条目被修成有 id 或丢弃');
}

console.log('[8] 压缩阈值：不同 profile 的 contextWindow → 不同 70% 阈值');
{
  ok(typeof C.compressThreshold === 'function', 'context.js 导出纯函数 compressThreshold');
  const s = baseSettings();
  const c1 = P.resolveChatCfg(s, { prefs: { profileId: 'p1' } }).cfg;
  const c2 = P.resolveChatCfg(s, { prefs: { profileId: 'p2' } }).cfg;
  const t1 = C.compressThreshold(c1.contextWindow);
  const t2 = C.compressThreshold(c2.contextWindow);
  eq(t1, Math.floor(20000 * 0.7), 'profile p1 阈值 = floor(20000×0.7)');
  eq(t2, Math.floor(40000 * 0.7), 'profile p2 阈值 = floor(40000×0.7)');
  ok(t1 !== t2, '同样消息量下两个 profile 的 70% 阈值不同');
  eq(C.compressThreshold(0), 0, 'contextWindow=0 → 阈值 0（未知，回退条数）');
  eq(C.compressThreshold(1000), 700, 'compressThreshold(1000) = 700');
}

console.log('[9] 生视频三参数唯一源 = 面板控件（审查 三·2 双数据源）');
{
  const s = Store.migrateSettings({
    video: { duration: 8, resolution: '1080P', ratio: '9:16', extraParams: 'duration=10, resolution=2K, watermark=false' },
  });
  eq(s.video.duration, 10, 'extraParams 同名键折回控件字段（值不丢）：duration=10');
  eq(s.video.resolution, '768P', '非法分辨率夹回默认 768P（2K 不在档位表）');
  eq(s.video.ratio, '9:16', '控件 ratio 保留');
  eq(String(s.video.extraParams).indexOf('duration') < 0, true, 'duration 键已从 extraParams 移除');
  eq(String(s.video.extraParams).indexOf('watermark=false') >= 0, true, '其它 extraParams 键原样保留');
  const s2 = Store.migrateSettings(s);
  eq(s2.video.duration, 10, '幂等：二次迁移不再改值');
  eq(s2.video.extraParams, s.video.extraParams, '幂等：extraParams 不再变化');
}

console.log('[10] boot 关键依赖自检（审查 可维护性 #9）');
{
  ok(typeof Store.assertDeps === 'function', 'Store.assertDeps 已导出');
  let threw = null;
  try { Store.assertDeps(); } catch (e) { threw = e; }
  ok(!threw, '依赖齐全（IR.Tree + IR.Prefs）→ assertDeps 通过' + (threw ? '（抛了：' + threw.message + '）' : ''));
  const saved = global.IR.Prefs;
  try {
    delete global.IR.Prefs;
    let e2 = null;
    try { Store.assertDeps(); } catch (e) { e2 = e; }
    ok(!!e2 && e2.code === 'IR_DEP_MISSING', '缺 IR.Prefs → 抛 IR_DEP_MISSING（启动即失败，不静默降级）');
  } finally {
    global.IR.Prefs = saved;
    let e3 = null;
    try { Store.assertDeps(); } catch (e) { e3 = e; }
    ok(!e3, '恢复依赖后自检重新通过');
  }
}

if (failed) {
  console.error('prefs-test：' + failed + ' 项失败');
  process.exit(1);
}
console.log('✅ prefs-test 全部通过');
