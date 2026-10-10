#!/usr/bin/env node
/**
 * 版本号同步：以根目录 VERSION 为唯一真源，把各处的版本号写齐。
 *   - index.html 里所有 ?v=…（CSS / JS 缓存击穿串）
 *   - package.json 的 version 字段
 *   - sw.js 里 Service Worker 的缓存名（ir-v…）
 *   - README.md / README.en.md 的版本徽章
 *
 * 用法：
 *   node tools/sync-version.mjs           写入
 *   node tools/sync-version.mjs --check   只检查（CI 用；不一致 → 退出码 1）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('VERSION 内容不是 x.y.z 形式：' + JSON.stringify(version));
  process.exit(1);
}

/** 每个文件：读 → 替换 → 需要时写回 */
const TARGETS = [
  {
    file: 'index.html',
    find: () => /\?v=[0-9A-Za-z.\-]+/g,
    replace: () => '?v=' + version,
  },
  {
    file: 'package.json',
    find: () => /("version"\s*:\s*")[^"]*(")/g,
    replace: (_m, a, b) => a + version + b,
  },
  {
    // Service Worker 的缓存名：版本一变 → 换缓存 → 旧资源自然淘汰
    file: 'sw.js',
    find: () => /const CACHE = 'ir-v[0-9A-Za-z.\-]+'/g,
    replace: () => "const CACHE = 'ir-v" + version + "'",
  },
  {
    file: 'README.md',
    find: () => /badge\/version-[0-9A-Za-z.\-]+-blue/g,
    replace: () => 'badge/version-' + version + '-blue',
  },
  {
    file: 'README.en.md',
    find: () => /badge\/version-[0-9A-Za-z.\-]+-blue/g,
    replace: () => 'badge/version-' + version + '-blue',
  },
];

let dirty = 0;
for (const t of TARGETS) {
  const p = join(ROOT, t.file);
  if (!existsSync(p)) continue;
  const before = readFileSync(p, 'utf8');
  const after = before.replace(t.find(), t.replace);
  if (before === after) {
    console.log('一致  ' + t.file);
    continue;
  }
  dirty += 1;
  if (CHECK) {
    console.error('不一致 ' + t.file + '（应为 ' + version + '，跑 node tools/sync-version.mjs 修正）');
  } else {
    writeFileSync(p, after);
    console.log('已更新 ' + t.file);
  }
}

if (CHECK && dirty) process.exit(1);
console.log('版本号 ' + version + ' · ' + (CHECK ? '检查通过' : '同步完成'));
