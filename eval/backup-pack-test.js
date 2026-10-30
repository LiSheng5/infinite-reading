#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 备份包脱敏单测
 *
 * 只验纯数据，两个方向都钉住：
 *   导出 —— settings.sidecar.token 是本机服务凭据，无论是否勾「备份里带上 API Key」
 *           都不能出现在包里；端口等非凭据连接信息保持原样，调用方的 settings 不被修改。
 *   导入 —— 备份默认不带 Key，导入不能反手把本机 Key 冲成空；包里的 sidecar.token
 *           属于导出那台机器，一律不采信，只用本机值。
 *
 * 用法：node eval/backup-pack-test.js
 */
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

console.log('\n备份包脱敏单测：' + (failed ? '有 ' + failed + ' 项失败' : '全部通过'));
if (failed) process.exitCode = 1;
