#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 备份包脱敏单测
 *
 * 只验纯数据，三个方向都钉住：
 *   导出 —— settings.sidecar.token 是本机服务凭据，无论是否勾「备份里带上 API Key」
 *           都不能出现在包里；端口等非凭据连接信息保持原样，调用方的 settings 不被修改。
 *   导入 —— 备份默认不带 Key，导入不能反手把本机 Key 冲成空；包里的 sidecar.token
 *           属于导出那台机器，一律不采信，只用本机值。
 *   带原图 —— buildBackupZip 读原图有并发上限（4），但清单顺序 / 文件名编号恒按 id 顺序，
 *           进度（done / total / bytes）单调且终值正确；改回逐张 await 会红。
 *
 * 用法：node eval/backup-pack-test.js
 */
const fs = require('fs');
const path = require('path');

const { BackupPack } = require(path.join(__dirname, '..', 'src', 'core', 'backupPack.ts'));

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed++; }
}
function eq(a, b, msg) {
  ok(a === b, msg + (a === b ? '' : '（实际 ' + JSON.stringify(a) + ' ≠ 期望 ' + JSON.stringify(b) + '）'));
}
// 数组 / 对象按序列化后比对（上面的 eq 是严格相等，只适合原始值）
function eqList(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(sa === sb, msg + (sa === sb ? '' : '（实际 ' + sa + ' ≠ 期望 ' + sb + '）'));
}

const SECRET = 'sidecar-SECRET-token-do-not-leak';
const base = {
  chat: { apiKey: 'sk-chat', model: 'm' },
  profiles: [{ id: 'p1', apiKey: 'sk-profile' }],
  sidecar: { port: 4319, token: SECRET },
};
const stories = [{ id: 's1', title: 't' }];

for (const withKeys of [false, true]) {
  const pack = BackupPack.buildBackupPack(base, [], stories, !withKeys);
  const text = JSON.stringify(pack);
  const label = withKeys ? '（勾选带上 API Key）' : '（默认）';
  ok(text.indexOf(SECRET) < 0, '备份不含 sidecar token' + label);
  eq(pack.settings.sidecar.token, '', 'sidecar.token 被置空' + label);
  eq(pack.settings.sidecar.port, 4319, 'sidecar.port 保留（不是凭据）' + label);
  eq(pack.stories.length, 1, '故事原样带上' + label);
  if (withKeys) eq(pack.settings.chat.apiKey, 'sk-chat', '显式勾选时 API Key 仍保留');
  else {
    eq(pack.settings.chat.apiKey, '', '默认剥掉 chat.apiKey');
    eq(pack.settings.profiles[0].apiKey, '', '默认剥掉 profiles[].apiKey');
  }
}

eq(base.sidecar.token, SECRET, '不修改调用方 settings（先 clone 再剥）');

/* ---------------- 导入方向：凭证合并 ---------------- */
{
  const local = {
    chat: { apiKey: 'sk-local-chat' },
    image: { apiKey: 'sk-local-image' },
    sidecar: { port: 4319, token: 'local-token' },
  };

  // 默认备份（Key 被剥）导入 → 本机 Key 必须留下，否则用户的模型全部变「未配置」
  const fromDefault = BackupPack.restoreSecrets(local, { chat: { apiKey: '' }, image: { apiKey: '', model: 'm' }, sidecar: { port: 4319, token: '' } });
  eq(fromDefault.chat.apiKey, 'sk-local-chat', '导入默认备份：chat.apiKey 沿用本机');
  eq(fromDefault.image.apiKey, 'sk-local-image', '导入默认备份：其它子模型的 Key 也沿用本机');
  eq(fromDefault.image.model, 'm', '导入默认备份：非凭证字段仍以包为准');

  // 显式「带上 Key」的备份导入 → 包里的 Key 生效（用户明确要换）
  const fromWithKeys = BackupPack.restoreSecrets(local, { chat: { apiKey: 'sk-pack' }, sidecar: { token: 'pack-token' } });
  eq(fromWithKeys.chat.apiKey, 'sk-pack', '导入带 Key 的备份：包里的 Key 生效');
  eq(fromWithKeys.sidecar.token, 'local-token', '导入：包里的 sidecar.token 不采信，沿用本机');

  // 本机还没配 token → 留空（等用户在设置里填），不能把别的机器的 token 装进来
  eq(BackupPack.restoreSecrets({}, { sidecar: { token: 'other-machine' } }).sidecar.token, '',
    '导入：本机没有 token 时留空（不继承旧包的值）');
  eq(local.sidecar.token, 'local-token', '导入合并不修改本机入参对象');
}

/* ---------------- 带原图备份：并发上限 / 清单顺序 / 进度 ---------------- */
console.log('[2] buildBackupZip：并发上限 4、清单顺序与串行一致、进度单调');

async function zipChecks() {
  const { Store } = require(path.join(__dirname, '..', 'src', 'core', 'store.ts'));
  const { Zip } = require(path.join(__dirname, '..', 'src', 'core', 'zip.ts'));

  const ids = [];
  for (let i = 1; i <= 9; i++) ids.push('img-' + i);
  const sizeOf = (id) => Number(String(id).slice(4)) * 10;

  // 只替换两个门面方法：不碰 IndexedDB / 存储，直接量「同时在途的读取请求数」
  const origKnown = Store.knownImageIds;
  const origGet = Store.getImage;
  let inflight = 0;
  let maxInflight = 0;
  Store.knownImageIds = () => new Set(ids);
  Store.getImage = async (id) => {
    inflight++;
    if (inflight > maxInflight) maxInflight = inflight;
    // 第一张最慢：串行实现会一直等它，并发实现能让后面几张同时上路
    await new Promise((r) => setTimeout(r, id === 'img-1' ? 40 : 10));
    inflight--;
    if (id === 'img-4') return null;   // 没有原图（空图）不落清单，与原实现同口径
    return new Blob([new Uint8Array(sizeOf(id))], { type: 'image/png' });
  };

  const progress = [];
  let res = null;
  try {
    res = await BackupPack.buildBackupZip({ format: 'ir-backup', schema: 1, stories: stories },
      (d, t, b) => progress.push([d, t, b]));
  } finally {
    Store.knownImageIds = origKnown;
    Store.getImage = origGet;
  }

  const expectedIds = ids.filter((id) => id !== 'img-4');
  const expectedBytes = expectedIds.reduce((n, id) => n + sizeOf(id), 0);
  const entries = await Zip.read(res.blob);
  const body = JSON.parse(await entries.get('ir-backup.json').text());
  const manifest = body.images;

  ok(maxInflight <= 4, '读原图并发不超过 4（实测峰值 ' + maxInflight + '）');
  ok(maxInflight >= 2, '确实是并发读取（串行实现峰值为 1）');
  eq(res.count, expectedIds.length, '清单条数 = 有图的张数（空图跳过）');
  eq(res.bytes, expectedBytes, '总字节数 = 各原图大小之和');
  eqList(manifest.map((x) => x.id), expectedIds, '清单顺序 = id 顺序（并发不改变编号）');
  eqList(manifest.map((x) => x.path), expectedIds.map((_, i) => 'images/' + String(i + 1).padStart(4, '0') + '.png'),
    '文件名按顺序连续编号');
  eq(body.schema, 2, '正文升级为 schema 2（带 images 清单）');
  eq(body.stories.length, 1, '故事正文照旧随包');
  eq(progress.length, ids.length, '进度回调每个 id 一次');
  eqList(progress.map((p) => p[0]).sort((a, b) => a - b), ids.map((_, i) => i + 1), 'done 覆盖 1..N');
  ok(progress.every((p) => p[1] === ids.length), '进度里的 total 始终 = 图片总数');
  ok(progress.every((p, i) => i === 0 || p[2] >= progress[i - 1][2]), '进度字节数单调不减');
  eq(progress[progress.length - 1][2], expectedBytes, '最后一次进度的字节数 = 总字节');

  // 静态：串行逐张读的写法不许回来
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'backupPack.ts'), 'utf8');
  ok(/const ZIP_IMAGE_CONCURRENCY = 4;/.test(src), '并发上限写成常量 4（改上限只改一处）');
  ok(src.indexOf('await Store.getImage(ids[i])') < 0, '逐张 await 的串行循环已移除');
}

zipChecks().then(() => {
  console.log('\n备份包脱敏单测：' + (failed ? '有 ' + failed + ' 项失败' : '全部通过'));
  if (failed) process.exitCode = 1;
}, (e) => {
  console.error('  FAIL 带原图备份段异常：' + ((e && e.stack) || e));
  process.exitCode = 1;
});
