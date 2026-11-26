#!/usr/bin/env node
'use strict';
/* eval/schema-test.js —— schema 回归测试（验收门禁）
 *
 * 验收：「导出包 → 导入 → 还原 → 再导出，与原包逐字段一致；当前形状的存档归一幂等；
 * 过旧文件明确拒绝」。这里跑**数据层**的同一口径。数据由真实写入路径构造
 * （newStory / migrateStory / Tree.ensure / buildStoryPack / buildBackupPack）——
 * 旧版夹具存档与截图基线已随 acceptance/ 精简清理，不再依赖历史文件：
 *   ① 构造故事经真实导出路径产出的包全部过 Schema 校验——导出器与校验器必须对得上；
 *   ② 导入 → 还原（存盘往返）→ 导出逐字段一致：导出包 → storyFromPack（真实导入路径）
 *      → saveStory / loadStory（真实存盘往返）→ buildStoryPack（真实导出）→ 与原包逐字段比对
 *      （只忽略「注定会变」清单：app 版本串 / createdAt / updatedAt / images[].ts /「（导入）」后缀）；
 *      含旧「扮演」（mode='rp'）包：读入归一为 'chat'，角色卡与历史完整；
 *   ③ 全量备份：每个 story 迁移后过检 + 迁移幂等 + 与原档逐字段一致（旧 rp 按模式归一口径）；
 *      重打包逐字段一致（volatile 字段除外）；sidecar token 无条件剥净；
 *   ④ 当前形状：narration versions 补齐、prefs 清洗、设置归一与幂等；
 *      旧「扮演」（mode='rp'）读档 / 导入 / 索引一律归一为 'chat'，角色卡与历史完整；
 *      过旧存档（schema < 3）与过旧导出包（schema < 2）明确拒绝，不半加载。
 *
 * 用法：node eval/schema-test.js（任一不过 → 退出码 1）
 */
const path = require('path');
const H = require('./_harness.js');
const core = f => require(path.join(__dirname, '..', 'src', 'core', f + '.ts'));

const Store = core('store').Store;
const Tree = core('tree').Tree;
const Schema = core('schema').Schema;
const BackupPack = core('backupPack').BackupPack;
if (!Store || !Schema || !BackupPack) {
  console.error('加载失败：Store / Schema / BackupPack 导出缺失');
  process.exit(1);
}
const check = H.check;

// 逐字段比对（键序无关）：返回差异描述列表
function diffFields(a, b, pathStr, out) {
  out = out || [];
  const ta = a === null ? 'null' : (Array.isArray(a) ? 'array' : typeof a);
  const tb = b === null ? 'null' : (Array.isArray(b) ? 'array' : typeof b);
  if (ta !== tb) { out.push(pathStr + '：类型 ' + ta + ' ≠ ' + tb); return out; }
  if (ta === 'array') {
    if (a.length !== b.length) { out.push(pathStr + '：长度 ' + a.length + ' ≠ ' + b.length); return out; }
    for (let i = 0; i < a.length; i++) diffFields(a[i], b[i], pathStr + '[' + i + ']', out);
    return out;
  }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) { out.push(pathStr + '.' + k + '：导出侧缺失'); continue; }
      if (!(k in b)) { out.push(pathStr + '.' + k + '：导出侧多出'); continue; }
      diffFields(a[k], b[k], pathStr + '.' + k, out);
    }
    return out;
  }
  if (a !== b) out.push(pathStr + '：' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));
  return out;
}

/* 注定会变的字段（与 acceptance/tools/fixture.mjs RULES_STORY 同一份清单） */
function normalizeStoryPack(p) {
  const o = JSON.parse(JSON.stringify(p));
  delete o.createdAt;
  delete o.updatedAt;
  delete o.app;
  if (typeof o.title === 'string') o.title = o.title.replace(/（导入）$/, '');
  for (const im of (o.images || [])) delete im.ts;
  return o;
}

/* 旧「扮演」并入「聊天」：mode='rp' 的档案读入后应为 'chat'。
 * 往返 / 重打包比对时把原侧的 mode 按同一规则归一，其余字段仍严格逐字段一致。 */
function withModeMigrated(obj) {
  const o = JSON.parse(JSON.stringify(obj));
  if (o.mode === 'rp') o.mode = 'chat';
  if (Array.isArray(o.stories)) o.stories.forEach(s => { if (s && s.mode === 'rp') s.mode = 'chat'; });
  return o;
}

/* ================= 构造数据（真实写入路径，不依赖历史夹具） ================= */

const IMG_THUMB = 'data:image/jpeg;base64,dGVzdA==';
const TS0 = 1700000000000;   // 固定时间戳基准：只作数据内容，volatile 清单另有放行

function packImages(st) {
  return (st.scenes || []).map(s => ({
    id: s.id, alt: s.alt || '', prompt: s.prompt || '', promptRaw: '',
    aspect: '3:2', width: s.width || 0, height: s.height || 0,
    thumb: s.thumb || null, src: null, ts: TS0,
  }));
}

function seed() {
  // —— 故事 A：剧情（分支树 / 图 / 存档点 / 世界状态） ——
  const a = Store.newStory({ title: '雨夜便利店', premise: '深夜的便利店，雨下个不停。', mode: 'choice' });
  a.styleTone = '克制的悬疑';
  a.world.place = '雨夜便利店';
  a.world.time = '深夜·雨夜';
  a.world.scene = '收银台旁一台红色旋钮的旧收音机';
  a.world.threads = ['锅边便签：过了三点就别再添汤'];
  a.world.characters = [{ name: '周叙', presence: '在场', personality: '话里有话、克制' }];
  a.styleCard = { id: 'style-1', version: 2, locked: true, medium: 'watercolor' };
  a.rollingStyle = { style: '暖黄灯光的水彩', scenes: '便利店内部', wardrobe: '便利店制服', updatedAt: TS0 };
  a.prefs = { profileId: 'pf-1', profileLabel: '主模型 · 固定档' };
  a.log = [
    { type: 'narration', text: '凌晨的雨把街道泡成深色。', ts: TS0 + 1 },
    { type: 'player', text: '走到关东煮的柜台前', kind: 'do', ts: TS0 + 2 },
    { type: 'choice', text: '和店员搭话', kind: 'do', ts: TS0 + 3 },
    { type: 'image', id: 'sc-img1', alt: '雨夜便利店场景图', thumb: IMG_THUMB, ts: TS0 + 4 },
    { type: 'tool', tool: 'recall_world_state', summary: '世界状态已召回', ts: TS0 + 5 },
  ];
  a.messages = [
    { role: 'user', content: '（故事开场）' },
    { role: 'assistant', content: '凌晨的雨把街道泡成深色。' },
  ];
  a.summaries = ['【第1幕】雨夜便利店｜深夜·雨夜｜在场：周叙'];
  a.turn = 3;
  a.lastSceneSummary = '收银台旁的旧收音机';
  a.scenes = [{ id: 'sc-img1', alt: '雨夜便利店场景图', prompt: 'cinematic still', thumb: IMG_THUMB, width: 120, height: 80 }];
  a.lastBg = 'sc-img1';
  a.savepoints = [{
    id: 'sp-1', name: '开局前夜', ts: TS0,
    log: [], world: { place: '雨夜便利店', time: '深夜·雨夜', scene: '', characters: [], threads: [] },
  }];
  Tree.ensure(a);

  // —— 故事 B：聊天 + 角色卡 + 故事内画像 ——
  const b = Store.newStory({ title: '凌霜的航线夜谈', premise: '与星舰领航员凌霜的角色对话。', mode: 'chat' });
  b.characterCard = {
    name: '凌霜', appearance: '银白长发，舰桥制服', personality: '冷静、克制，偶尔冷幽默',
    scene: '星舰舰桥', opening: '「你迟到了三分钟。」', exampleDialogue: '「航线不是路，是承诺。」',
    systemNote: '保持克制的科幻语感', source: 'custom', updatedAt: TS0,
  };
  b.userProfile = [{ text: '玩家喜欢在夜里写东西', kind: 'preference', updatedAt: TS0 }];
  b.prefs = { profileId: 'pf-2', profileLabel: '备用便宜档' };
  b.log = [
    { type: 'narration', text: '「你迟到了三分钟。」她没有回头。', ts: TS0 + 1 },
    { type: 'player', text: '「路上遇到点事。」', kind: 'say', ts: TS0 + 2 },
  ];
  b.messages = [
    { role: 'user', content: '「路上遇到点事。」' },
    { role: 'assistant', content: '「嗯。坐。」' },
  ];
  b.turn = 1;
  Tree.ensure(b);

  // —— 故事 C：纯文本聊天（无卡无图） ——
  const c = Store.newStory({ title: '新对话', premise: '日常助手对话。', mode: 'chat' });
  c.log = [{ type: 'player', text: '帮我记一下周五的对接会', kind: 'do', ts: TS0 + 1 }];
  c.messages = [{ role: 'user', content: '帮我记一下周五的对接会' }];
  Tree.ensure(c);

  // 归一到当前形状（log versions 等），与真实存档同口径——后续迁移必须幂等
  const stories = [a, b, c].map(st => Store.migrateStory(st));

  // 导出包走真实导出路径 buildStoryPack；旧「扮演」包 = 导出包把 mode 改回 'rp'
  // （旧代码写 'rp' 的历史形状；当前导出一律写 'chat'）
  const packA = Store.buildStoryPack(stories[0], 'full', packImages(stories[0]), {});
  const packB = Store.buildStoryPack(stories[1], 'full', packImages(stories[1]), {});
  const packC = Store.buildStoryPack(stories[2], 'full', [], {});
  const rpPack = JSON.parse(JSON.stringify(packB));
  rpPack.mode = 'rp';

  // 全量备份：含一个旧「扮演」存档（mode='rp'，迁移归一为 'chat' 的真实输入形状）
  const rpStory = JSON.parse(JSON.stringify(stories[1]));
  rpStory.id = 'story-rp-legacy';
  rpStory.mode = 'rp';
  const SECRET = 'sidecar-SECRET-token-do-not-leak';
  const seedSettings = {
    chat: { baseUrl: 'https://api.invalid/v1', apiKey: 'sk-chat-KEY', model: 'fixture-model' },
    profiles: [{ id: 'pf-1', label: '主模型 · 固定档', apiKey: 'sk-profile-KEY', model: 'fixture-model' }],
    sidecar: { port: 4319, token: SECRET },
  };
  const gProfile = [{ text: '玩家喜欢在夜里写东西', kind: 'preference', updatedAt: TS0 }];
  const backup = BackupPack.buildBackupPack(seedSettings, gProfile, [stories[0], rpStory, stories[2]], true);

  return { packA, packB, packC, rpPack, backup, SECRET };
}

const DATA = seed();

/* ===================== ① 构造包过 schema 校验 ===================== */
console.log('[1] 构造故事经真实导出后过 Schema 校验（导出器与校验器对表）');
{
  const packs = [
    ['story-choice（剧情）', DATA.packA],
    ['story-chat-card（聊天+角色卡）', DATA.packB],
    ['story-chat（纯聊天）', DATA.packC],
    ['story-rp（旧「扮演」）', DATA.rpPack],
  ];
  for (const [label, p] of packs) {
    const probs = Schema.checkStoryPack(p);
    check(label + ' 过检', probs.length === 0, probs.slice(0, 5).join(' | '));
  }
  const pb = Schema.checkBackupPack(DATA.backup);
  check('backup 过检', pb.length === 0, pb.slice(0, 5).join(' | '));
  DATA.backup.stories.forEach((st, i) => {
    const p = Schema.checkStory(st);
    check('backup.stories[' + i + ']（' + st.title + '）过检', p.length === 0, p.slice(0, 5).join(' | '));
  });
  // zip 带原图备份的正文口径（buildBackupZip 的 body：schema 2 + images 清单）同样过检；
  // zip 字节层读写由 eval/zip-smoke.js 与 eval/backup-pack-test.js 覆盖
  const zipBody = Object.assign({}, DATA.backup, {
    schema: 2, images: [{ id: 'img:sc-img1', path: 'images/0001.jpeg', type: 'image/jpeg', size: 3 }],
  });
  const pz = Schema.checkBackupPack(zipBody);
  check('zip 备份正文（schema 2 + images 清单）过检', pz.length === 0, pz.slice(0, 5).join(' | '));
  check('zip 备份正文 schema=2 且带 images 清单',
    zipBody.schema === 2 && Array.isArray(zipBody.images) && zipBody.images.length > 0,
    'schema=' + zipBody.schema + ' images=' + (zipBody.images || []).length);
  part2();
}

/* ============ ② 导入 → 还原（存盘往返）→ 导出，逐字段一致 ============ */
function part2() {
  console.log('[2] 导出包导入 → 还原 → 再导出逐字段一致');
  const packs = [
    ['story-choice', DATA.packA],
    ['story-chat-card', DATA.packB],
    ['story-rp', DATA.rpPack],
  ];
  for (const [label, pack] of packs) {
    // 导入（真实路径：src/app/backup.js 的应用入口，数据段在 src/core/backupPack.ts）
    const st = BackupPack.storyFromPack(pack);
    const saveOk = Store.saveStory(st);
    const reloaded = Store.loadStory(st.id);          // 还原：落盘再读回
    const images = (pack.images || []).map(im => Object.assign({}, im, { ts: undefined }));
    const out = Store.buildStoryPack(reloaded, 'full', images, {});
    const problems = Schema.checkStoryPack(out);
    check(label + '：导出包过 schema 校验', problems.length === 0, problems.slice(0, 5).join(' | '));
    if (pack.mode === 'rp') {
      check(label + '：旧 rp 包读入后模式归一为 chat（导入 / 读回 / 再导出）',
        st.mode === 'chat' && reloaded.mode === 'chat' && out.mode === 'chat',
        'import=' + st.mode + ' load=' + reloaded.mode + ' export=' + out.mode);
    }
    const diffs = diffFields(withModeMigrated(normalizeStoryPack(pack)), normalizeStoryPack(out), 'pack');
    check(label + '：导入→还原→导出逐字段一致（模式按归一口径）', saveOk && reloaded != null && diffs.length === 0,
      diffs.slice(0, 8).join(' | ') || ('save=' + saveOk));
    Store.deleteStory(st.id);
  }
  part3();
}

/* ============ ③ 全量备份：迁移 / 序列化稳定 + 重打包逐字段一致 ============ */
function part3() {
  console.log('[3] 全量备份迁移与重打包');
  const backup = DATA.backup;
  check('buildBackupPack 无条件剥掉 sidecar token（输入里的 token 不出现在包中）',
    JSON.stringify(backup).indexOf(DATA.SECRET) < 0,
    'token 出现在包里则安全红线被破坏');
  let allStable = true, allSame = true;
  const details = [];
  for (const raw of backup.stories) {
    const m = Store.migrateStory(raw);
    const p = Schema.checkStory(m);
    if (p.length) { allStable = false; details.push(raw.title + ' 过检失败：' + p[0]); }
    // 迁移幂等：再迁一次结果不变
    const m2 = Store.migrateStory(m);
    const idem = diffFields(JSON.parse(JSON.stringify(m)), JSON.parse(JSON.stringify(m2)), raw.title);
    if (idem.length) { allStable = false; details.push('幂等失败 ' + idem[0]); }
    // 与原档逐字段一致（构造数据已归一；旧 rp 只按「模式归一」这一处不同）
    const same = diffFields(
      withModeMigrated(raw),
      JSON.parse(JSON.stringify(m)),
      raw.title
    );
    if (same.length) { allSame = false; details.push(same.slice(0, 3).join(' | ')); }
  }
  check('backup 每个 story 迁移后过检 + 迁移幂等', allStable, details.join(' || ').slice(0, 300));
  check('backup 每个 story 迁移后与原档逐字段一致', allSame, details.join(' || ').slice(0, 300));
  // 重打包：与原备份逐字段一致（忽略 fixture.mjs RULES_BACKUP 的 volatile 清单）
  const repack = BackupPack.buildBackupPack(backup.settings, backup.userProfile, backup.stories.map(s => Store.migrateStory(s)), true);
  const a = withModeMigrated(backup);   // 旧 rp 故事重打包后写 'chat'，原侧按同一口径比
  const b = JSON.parse(JSON.stringify(repack));
  delete a.exportedAt; delete b.exportedAt;
  delete a.app; delete b.app;
  for (const s of (a.stories || [])) delete s.updatedAt;
  for (const s of (b.stories || [])) delete s.updatedAt;
  // stripKeys=true 会把设置里的 Key 清空：构造备份已按「剥 Key 后」口径产出，
  // 比对前统一按同一口径处理，确保比的是数据而不是 Key 策略。
  // sidecar.token 则是无条件剥：本机服务凭据不属于可备份数据。
  const fixtureToken = (a.settings && a.settings.sidecar && a.settings.sidecar.token) || '';
  if (a.settings && a.settings.sidecar) a.settings.sidecar.token = '';
  const repackDiff = diffFields(a, b, 'backup');
  check('backup 重打包逐字段一致（volatile 字段除外）', repackDiff.length === 0, repackDiff.slice(0, 8).join(' | '));
  check('backup 重打包不含 sidecar token（无条件剥离）',
    (!fixtureToken || JSON.stringify(b).indexOf(fixtureToken) < 0)
      && !!b.settings && !!b.settings.sidecar && b.settings.sidecar.token === '',
    'token=' + JSON.stringify(b.settings && b.settings.sidecar && b.settings.sidecar.token));
  part4();
}

/* ================= ④ 当前形状归一 + 过旧文件明确拒绝 ================= */
function part4() {
  console.log('[4] 当前形状归一 / 过旧存档拒绝');
  // —— 4.0 过旧存档 / 过旧导出包：明确拒绝，不半加载 ——
  const tooOld = { schema: 2, id: 'old-011', title: '旧档', mode: 'choice', log: [{ type: 'narration', text: '第一幕', ts: 10 }] };
  check('过旧存档（schema 2 < 当前 3）不再迁移', Store.migrateStory(tooOld) === null && Store.storyTooOld(tooOld));
  check('过旧导出包（schema 1 < 当前 2）不再兼容',
    Store.storyPackTooOld({ format: 'ir-story', schema: 1 })
      && !Store.storyPackTooOld({ format: 'ir-story', schema: Store.PACK_SCHEMA })
      && !Store.storyPackTooOld({ format: 'ir-backup', schema: 1 }));
  check('当前形状的存档照常迁移',
    !Store.storyTooOld({ schema: Store.SCHEMA })
      && !!Store.migrateStory({ schema: Store.SCHEMA, id: 'cur', title: '当前', mode: 'choice' }));

  // —— 4.1 当前形状：narration versions 补齐、prefs 清洗、无 tree 不长 tree、幂等 ——
  const curStory = {
    schema: Store.SCHEMA, id: 'cur-011', title: '当前档', mode: 'choice', createdAt: 1, updatedAt: 2,
    log: [
      { type: 'narration', text: '第一幕', ts: 10 },
      { type: 'image', id: 'im1', prompt: 'p', alt: 'a', thumb: 'data:image/jpeg;base64,x', ts: 11 },
    ],
    prefs: { apiKey: 'sk-LEAK', profileId: 'pf-1', junk: 1 },
  };
  const m = Store.migrateStory(curStory);
  const p = Schema.checkStory(m);
  check('当前形状存档归一后过 schema 校验', p.length === 0, p.slice(0, 5).join(' | '));
  check('narration 无 versions → 补齐 versions/activeVersion',
    Array.isArray(m.log[0].versions) && m.log[0].versions.length === 1 && m.log[0].activeVersion === 0
    && m.log[0].text === m.log[0].versions[0], JSON.stringify(m.log[0]));
  check('prefs 凭证与未知键剥净（apiKey / junk）',
    m.prefs && !('apiKey' in m.prefs) && !('junk' in m.prefs)
    && m.prefs.profileId === 'pf-1', JSON.stringify(m.prefs));
  check('无 tree 的存档不长出 tree 字段', !('tree' in m) || m.tree == null, JSON.stringify(Object.keys(m)));
  // 归一表整体幂等：再归一次逐字段不变（某步的 when 写错会在这里爆）
  const mAgain = Store.migrateStory(m);
  const mIdem = diffFields(m, mAgain, 'story');
  check('当前形状归一幂等（再归一次逐字段不变）', mIdem.length === 0, mIdem.slice(0, 3).join(' || '));

  // —— 4.1b 旧「扮演」并入「聊天」：导出包 / 存档 / 索引都归一，卡与历史完整 ——
  const rpPack = DATA.rpPack;
  const rpImported = BackupPack.storyFromPack(rpPack);
  check('旧 rp 导出包：导入后 mode === chat', rpImported.mode === 'chat', rpImported.mode);
  check('旧 rp 导出包：角色卡逐字段完整',
    diffFields(rpPack.characterCard, rpImported.characterCard, 'characterCard').length === 0);
  check('旧 rp 导出包：历史 / 消息 / 分支树条数完整',
    rpImported.log.length === rpPack.log.length
      && rpImported.messages.length === rpPack.messages.length
      && !!rpImported.tree === !!rpPack.tree,
    'log=' + rpImported.log.length + '/' + rpPack.log.length
      + ' messages=' + rpImported.messages.length + '/' + rpPack.messages.length);

  // 存档路径：落盘时仍是旧值 'rp'，读回才归一（懒迁移），索引随保存写成 chat
  const legacyRp = Store.newStory({ id: 'legacy-rp-io', title: '旧扮演', mode: 'chat' });
  legacyRp.mode = 'rp';   // newStory 会归一 mode，这里改回旧值才构成真懒迁移用例
  legacyRp.characterCard = rpPack.characterCard;
  legacyRp.log = rpPack.log;
  legacyRp.messages = rpPack.messages;
  const savedRp = Store.saveStory(legacyRp);
  const loadedRp = Store.loadStory('legacy-rp-io');
  const idxRp = Store.listIndex().find(x => x && x.id === 'legacy-rp-io');
  check('旧 rp 存档：读回后 mode === chat（懒迁移）', savedRp && !!loadedRp && loadedRp.mode === 'chat',
    loadedRp && loadedRp.mode);
  check('旧 rp 存档：角色卡 / 历史不丢',
    !!loadedRp && diffFields(rpPack.characterCard, loadedRp.characterCard, 'characterCard').length === 0
      && loadedRp.log.length === rpPack.log.length && loadedRp.messages.length === rpPack.messages.length);
  check('旧 rp 存档：书架索引条目写成 chat', !!idxRp && idxRp.mode === 'chat', idxRp && idxRp.mode);
  Store.deleteStory('legacy-rp-io');

  // —— 4.2 设置归一：provider 归一、video 控件折回、profiles 补 id ——
  const oldSettings = {
    chat: { provider: 'openai-compatible', baseUrl: 'https://x', apiKey: 'sk-1', model: 'mm' },
    image: { provider: 'minimax', apiKey: 'sk-2', model: 'i' },
    video: { provider: 'minimax', apiKey: 'sk-3', extraParams: 'duration=8, resolution=1080P, ratio=9:16, foo=bar' },
    profiles: [{ name: '无 id' }, { id: 'p2', model: 'm2' }],
  };
  const ms = Store.migrateSettings(oldSettings);
  check('image.provider 旧别名 minimax → minimax-image', ms.image.provider === 'minimax-image', ms.image.provider);
  check('video.provider 旧别名 → minimax-video', ms.video.provider === 'minimax-video', ms.video.provider);
  check('video.extraParams 折回控件（duration/resolution/ratio）且不留同名键',
    ms.video.duration === 8 && ms.video.resolution === '1080P' && ms.video.ratio === '9:16'
    && !/duration/.test(ms.video.extraParams) && /bar/.test(ms.video.extraParams),
    JSON.stringify(ms.video));
  check('profiles 幂等补 id', Array.isArray(ms.profiles) && ms.profiles.length === 2
    && ms.profiles.every(x => x && typeof x.id === 'string' && x.id), JSON.stringify(ms.profiles));
  // 归一表整体幂等：再归一次必须逐字段不变——任何一步的 when 写得太宽，这里立刻爆
  const msAgain = Store.migrateSettings(JSON.parse(JSON.stringify(ms)));
  const msIdem = diffFields(ms, msAgain, 'settings');
  check('设置归一幂等（再归一次逐字段不变）', msIdem.length === 0, msIdem.slice(0, 3).join(' | '));

  // —— 4.3 tree.ensure：无树的故事 → 线性链，且过 schema ——
  const plain = Store.migrateStory({ schema: Store.SCHEMA, id: 'lin1', title: '线性', log: [{ type: 'player', text: '走', ts: 1 }] });
  Tree.ensure(plain);
  const pt = Schema.checkStory(plain);
  check('无树故事 ensure 后过检（线性链）', pt.length === 0 && plain.tree && plain.tree.root,
    pt.slice(0, 3).join(' | '));
  H.finish('schema 回归测试（导出 / 导入 / 还原逐字段一致）');
}
