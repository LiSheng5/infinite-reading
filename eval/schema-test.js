#!/usr/bin/env node
'use strict';
/* eval/schema-test.js —— schema 回归测试（阶段 2 验收门禁）
 *
 * 任务书 §5 阶段 2 验收：「回归夹具导入 → 还原 → 导出，与原文件逐字段一致；
 * 旧版本（0.11 及更早）的存档仍能迁移」。这里跑**数据层**的同一口径：
 *   ① schema 形状：三份真实夹具（acceptance/0.12.1/fixture/）全部过 IR.Schema 校验
 *      ——类型以真实档案形状为准的可执行证明，档案绝不反过来迁就类型；
 *   ② 导入 → 还原 → 导出逐字段一致：夹具 .irstory.json → storyFromPack（真实导入路径）
 *      → saveStory / loadStory（真实存盘往返）→ buildStoryPack（真实导出）→ 与原包逐字段比对
 *      （只忽略 fixture.mjs RULES_STORY 里同一份「注定会变」清单）；
 *   ③ 全量备份往返：backup-plain 的每个 story 迁移 / 序列化稳定、重打包逐字段一致；
 *   ④ 0.11 及更早：v0.1 旧键迁移（migrateLegacy）、schema v2 旧字段（ai2Thread / poster /
 *      videoUrl / image.size / prefs.trigger+apiKey）与旧 provider 别名全部能迁。
 *
 * 用法：node eval/schema-test.js（任一不过 → 退出码 1）
 */
const path = require('path');
const fs = require('fs');

global.window = global;
const core = f => require(path.join(__dirname, '..', 'src', 'core', f + '.ts'));

const Store = core('store').Store;
const Tree = core('tree').Tree;
const Schema = core('schema').Schema;
const BackupPack = core('backupPack').BackupPack;
const Zip = core('zip').Zip;
if (!Store || !Schema || !BackupPack) {
  console.error('加载失败：Store / Schema / BackupPack 导出缺失');
  process.exit(1);
}

const FIX = path.join(__dirname, '..', 'acceptance', '0.12.1', 'fixture');
let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log('  ok  ' + name); return; }
  failed += 1;
  console.error('FAIL  ' + name + (detail ? ' — ' + detail : ''));
}

function load(f) { return JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')); }

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

/* ===================== ① 三份真实夹具过 schema 校验 ===================== */
console.log('[1] 真实夹具过 IR.Schema 校验（类型以档案为准）');
{
  const choice = load('story-choice-full.irstory.json');
  const rp = load('story-rp-full.irstory.json');
  const backup = load('backup-plain.irbackup.json');
  const p1 = Schema.checkStoryPack(choice);
  check('story-choice-full.irstory.json 过检', p1.length === 0, p1.slice(0, 5).join(' | '));
  const p2 = Schema.checkStoryPack(rp);
  check('story-rp-full.irstory.json 过检', p2.length === 0, p2.slice(0, 5).join(' | '));
  const p3 = Schema.checkBackupPack(backup);
  check('backup-plain.irbackup.json 过检', p3.length === 0, p3.slice(0, 5).join(' | '));
  backup.stories.forEach((st, i) => {
    const p = Schema.checkStory(st);
    check('backup.stories[' + i + ']（' + st.title + '）过检', p.length === 0, p.slice(0, 5).join(' | '));
  });
  // zip 带原图备份的正文（schema 2 + images 清单）同样过检
  const zipPath = path.join(FIX, 'backup-with-src.zip');
  if (fs.existsSync(zipPath)) {
    const entries = Zip.read(new Blob([fs.readFileSync(zipPath)]));
    return entries.then(en => {
      const main = BackupPack.pickBackupJson(en);
      return main.text().then(txt => {
        const obj = JSON.parse(txt);
        const pz = Schema.checkBackupPack(obj);
        check('backup-with-src.zip 内 ir-backup.json 过检', pz.length === 0, pz.slice(0, 5).join(' | '));
        check('zip 备份 schema=2 且带 images 清单', obj.schema === 2 && Array.isArray(obj.images) && obj.images.length > 0,
          'schema=' + obj.schema + ' images=' + (obj.images || []).length);
        part2();
      });
    }).catch(e => {
      check('backup-with-src.zip 读取', false, String(e));
      part2();
    });
  }
  part2();
}

/* ============ ② 导入 → 还原（存盘往返）→ 导出，逐字段一致 ============ */
function part2() {
  console.log('[2] .irstory.json 导入 → 还原 → 导出逐字段一致');
  for (const f of ['story-choice-full.irstory.json', 'story-rp-full.irstory.json']) {
    const pack = load(f);
    // 导入（真实路径：js/app/backup.js applyImport 的数据段，阶段 2 抽到 core）
    const st = BackupPack.storyFromPack(pack);
    const saveOk = Store.saveStory(st);
    const reloaded = Store.loadStory(st.id);          // 还原：落盘再读回
    const images = (pack.images || []).map(im => Object.assign({}, im, { ts: undefined }));
    const out = Store.buildStoryPack(reloaded, reloaded && reloaded.id ? 'full' : 'full', images, {});
    const problems = Schema.checkStoryPack(out);
    check(f + '：导出包过 schema 校验', problems.length === 0, problems.slice(0, 5).join(' | '));
    const diffs = diffFields(normalizeStoryPack(pack), normalizeStoryPack(out), 'pack');
    check(f + '：导入→还原→导出逐字段一致', saveOk && reloaded != null && diffs.length === 0,
      diffs.slice(0, 8).join(' | ') || ('save=' + saveOk));
    Store.deleteStory(st.id);
  }
  part3();
}

/* ============ ③ 全量备份：迁移 / 序列化稳定 + 重打包逐字段一致 ============ */
function part3() {
  console.log('[3] 全量备份（backup-plain）迁移与重打包');
  const backup = load('backup-plain.irbackup.json');
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
    // 与原档逐字段一致（fixture 由真实存盘路径产出，已归一）
    const same = diffFields(
      JSON.parse(JSON.stringify(raw)),
      JSON.parse(JSON.stringify(m)),
      raw.title
    );
    if (same.length) { allSame = false; details.push(same.slice(0, 3).join(' | ')); }
  }
  check('backup 每个 story 迁移后过检 + 迁移幂等', allStable, details.join(' || ').slice(0, 300));
  check('backup 每个 story 迁移后与原档逐字段一致', allSame, details.join(' || ').slice(0, 300));
  // 重打包：与原备份逐字段一致（忽略 fixture.mjs RULES_BACKUP 的 volatile 清单）
  const repack = BackupPack.buildBackupPack(backup.settings, backup.userProfile, backup.stories.map(s => Store.migrateStory(s)), true);
  const a = JSON.parse(JSON.stringify(backup));
  const b = JSON.parse(JSON.stringify(repack));
  delete a.exportedAt; delete b.exportedAt;
  delete a.app; delete b.app;
  for (const s of (a.stories || [])) delete s.updatedAt;
  for (const s of (b.stories || [])) delete s.updatedAt;
  // stripKeys=true 会把设置里的 Key 清空：原夹具不含 Key（fixture 本身不带 Key），
  // 比对前统一按「剥 Key 后」口径处理原侧，确保比的是数据而不是 Key 策略
  const repackDiff = diffFields(a, b, 'backup');
  check('backup 重打包逐字段一致（volatile 字段除外）', repackDiff.length === 0, repackDiff.slice(0, 8).join(' | '));
  part4();
}

/* ================= ④ 0.11 及更早存档仍能迁移 ================= */
function part4() {
  console.log('[4] 0.11 及更早存档迁移');
  // —— 4.1 schema v2 旧字段：ai2Thread→painterThread、poster→thumb、videoUrl→remoteUrl、
  //      narration 无 versions 补齐、image.size 遗留键 ——
  const oldStory = {
    schema: 2, id: 'old-011', title: '旧档', mode: 'choice', createdAt: 1, updatedAt: 2,
    log: [
      { type: 'narration', text: '第一幕', ts: 10 },
      { type: 'image', id: 'im1', prompt: 'p', alt: 'a', poster: 'data:image/jpeg;base64,x', videoUrl: 'http://expire/link', ts: 11 },
    ],
    ai2Thread: [{ text: '画师旧线程' }],
    scenes: [{ id: 'im1', poster: 'data:image/jpeg;base64,x', videoUrl: 'http://expire/link', ts: 12 }],
    prefs: { apiKey: 'sk-LEAK', trigger: 'turn', profileId: 'pf-1', junk: 1 },
  };
  const m = Store.migrateStory(oldStory);
  const p = Schema.checkStory(m);
  check('0.11 旧字段迁移后过 schema 校验', p.length === 0, p.slice(0, 5).join(' | '));
  check('ai2Thread → painterThread', Array.isArray(m.painterThread) && m.painterThread.length === 1
    && m.painterThread[0].text === '画师旧线程', JSON.stringify(m.painterThread));
  check('poster → thumb、videoUrl → remoteUrl（log 条目，旧键原样保留）',
    m.log[1].thumb === 'data:image/jpeg;base64,x' && m.log[1].remoteUrl === 'http://expire/link'
    && m.log[1].poster === 'data:image/jpeg;base64,x' && m.log[1].videoUrl === 'http://expire/link',
    JSON.stringify(m.log[1]));
  check('poster → thumb、videoUrl → remoteUrl（scenes，旧键原样保留）',
    m.scenes[0].thumb === 'data:image/jpeg;base64,x' && m.scenes[0].remoteUrl === 'http://expire/link'
    && m.scenes[0].poster === 'data:image/jpeg;base64,x',
    JSON.stringify(m.scenes[0]));
  check('narration 无 versions → 补齐 versions/activeVersion',
    Array.isArray(m.log[0].versions) && m.log[0].versions.length === 1 && m.log[0].activeVersion === 0
    && m.log[0].text === m.log[0].versions[0], JSON.stringify(m.log[0]));
  check('prefs 凭证与旧键剥净（apiKey / trigger / junk）',
    m.prefs && !('apiKey' in m.prefs) && !('trigger' in m.prefs) && !('junk' in m.prefs)
    && m.prefs.profileId === 'pf-1', JSON.stringify(m.prefs));
  check('无 tree 的旧档不造 tree 字段', !('tree' in m) || m.tree == null, JSON.stringify(Object.keys(m)));

  // —— 4.2 旧设置：provider 别名、video 控件折回、trigger 下线、旧 image.size ——
  const oldSettings = {
    chat: { provider: 'openai-compatible', baseUrl: 'https://x', apiKey: 'sk-1', model: 'mm' },
    image: { provider: 'minimax', apiKey: 'sk-2', model: 'i', size: '512x768' },
    video: { provider: 'minimax', apiKey: 'sk-3', extraParams: 'duration=8, resolution=1080P, ratio=9:16, foo=bar' },
    trigger: 'turn',
    profiles: [{ name: '无 id' }, { id: 'p2', model: 'm2' }],
  };
  const ms = Store.migrateSettings(oldSettings);
  check('image.provider 旧别名 minimax → minimax-image', ms.image.provider === 'minimax-image', ms.image.provider);
  check('image.size → aspect/width/height（v0.1 遗留）',
    ms.image.aspect === 'custom' && ms.image.width === 512 && ms.image.height === 768 && !('size' in ms.image),
    JSON.stringify(ms.image));
  check('video.provider 旧别名 → minimax-video', ms.video.provider === 'minimax-video', ms.video.provider);
  check('video.extraParams 折回控件（duration/resolution/ratio）且不留同名键',
    ms.video.duration === 8 && ms.video.resolution === '1080P' && ms.video.ratio === '9:16'
    && !/duration/.test(ms.video.extraParams) && /bar/.test(ms.video.extraParams),
    JSON.stringify(ms.video));
  // P-1（v0.11.0）：trigger（出图时机）停止读写——defaultSettings 不再写它，
  // 旧档里的值**原样留在存档**（不读、不删）：迁移后仍可见，但默认包里永远没有
  check('trigger 不读不删（旧档值原样留存，默认包不再写）',
    ms.trigger === 'turn' && !('trigger' in Store.defaultSettings()),
    'ms.trigger=' + ms.trigger);
  check('profiles 幂等补 id', Array.isArray(ms.profiles) && ms.profiles.length === 2
    && ms.profiles.every(x => x && typeof x.id === 'string' && x.id), JSON.stringify(ms.profiles));

  // —— 4.3 v0.1 旧键（infinite-reading-v1:*）→ migrateLegacy ——
  const mem = new Map();
  global.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); },
    key: i => Array.from(mem.keys())[i] || null,
    get length() { return mem.size; },
  };
  mem.set('infinite-reading-v1:story', JSON.stringify({
    title: 'v0.1 故事', premise: '老前提',
    log: [{ type: 'narration', text: '开场', ts: 1 }],
    ai2Thread: [{ text: '旧画师' }],
  }));
  mem.set('infinite-reading-v1:settings', JSON.stringify({
    chat: { provider: 'openai-compatible', baseUrl: 'https://y', apiKey: 'sk-v1', model: 'old' },
  }));
  // v0.1 迁移依赖内存态 store：先 boot 再迁（幂等标记未写过就一定迁）
  Store.boot().then(() => {
    const res = Store.migrateLegacy();
    check('v0.1 旧键迁移返回 storyId', !!(res && res.storyId), JSON.stringify(res));
    const st = res && res.storyId ? Store.loadStory(res.storyId) : null;
    check('v0.1 故事迁移后过 schema 校验', !!st && Schema.checkStory(st).length === 0,
      st ? Schema.checkStory(st).slice(0, 3).join(' | ') : '（读不到）');
    check('v0.1 故事 ai2Thread 迁移', !!(st && Array.isArray(st.painterThread) && st.painterThread.length === 1),
      st ? JSON.stringify(st.painterThread) : '');
    const s2 = Store.loadSettings();
    check('v0.1 设置迁移生效（model=old）', s2 && s2.chat && s2.chat.model === 'old', JSON.stringify(s2 && s2.chat));
    const again = Store.migrateLegacy();
    check('v0.1 迁移幂等（第二次跳过）', again === null, JSON.stringify(again));

    // —— 4.4 tree.ensure：旧档无树 → 线性链，且过 schema ——
    const plain = Store.migrateStory({ id: 'lin1', title: '线性', log: [{ type: 'player', text: '走', ts: 1 }] });
    Tree.ensure(plain);
    const pt = Schema.checkStory(plain);
    check('无树旧档 ensure 后过检（线性链）', pt.length === 0 && plain.tree && plain.tree.root,
      pt.slice(0, 3).join(' | '));

    done();
  }).catch(e => {
    check('v0.1 迁移流程', false, String(e));
    done();
  });
}

function done() {
  if (failed) {
    console.error('schema-test：' + failed + ' 项未过');
    process.exit(1);
  }
  console.log('schema-test：全部通过');
}
