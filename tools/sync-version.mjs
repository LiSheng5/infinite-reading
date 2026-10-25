#!/usr/bin/env node
/**
 * 版本号同步：以根目录 VERSION 为唯一真源，把各处的版本号写齐。
 *   - package.json 的 version 字段
 *   - sw.js 里 Service Worker 的缓存名（ir-v…）
 *   - README.md / README.en.md 的版本徽章与「当前版本 vX」文字行
 *   - js/store.js（阶段 2 起 src/core/store.ts）与 src/core/backupPack.ts 里导出包的版本戳（「无限阅读 v…」）
 *
 * 阶段 1 起不再管 index.html 的版本串：缓存击穿 `?v=` 已随构建期 hash 文件名消失，
 * 首页版本文字改由构建注入（index.html 写 `v__IR_VERSION__` 占位符，
 * vite.config.mjs 的 irShell 插件在 dev / 两种产物里换成 VERSION 的值）。
 * 本脚本顺带守住两条红线：占位符不许丢、`?v=` 不许回来。
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
    // 徽章下方那行「当前版本 vX」文字（曾因不在同步范围停在 v0.3）
    file: 'README.md',
    find: () => /\*\*当前版本 v[0-9A-Za-z.\-]+\*\*/g,
    replace: () => '**当前版本 v' + version + '**',
  },
  {
    file: 'README.en.md',
    find: () => /badge\/version-[0-9A-Za-z.\-]+-blue/g,
    replace: () => 'badge/version-' + version + '-blue',
  },
  {
    // 徽章下方那行「当前版本 vX」文字（曾因不在同步范围停在 v0.3）
    file: 'README.en.md',
    find: () => /\*\*Current version: v[0-9A-Za-z.\-]+\*\*/g,
    replace: () => '**Current version: v' + version + '**',
  },
  {
    // 导出包的版本戳（曾因不在同步范围停在 v0.4）
    file: 'src/core/store.ts',
    find: () => /无限阅读 v[0-9A-Za-z.\-]+/g,
    replace: () => '无限阅读 v' + version,
  },
  {
    file: 'src/core/backupPack.ts',
    find: () => /无限阅读 v[0-9A-Za-z.\-]+/g,
    replace: () => '无限阅读 v' + version,
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

// —— index.html 的两条红线（阶段 1 起版本文字 / 缓存击穿都不再手写） ——
const htmlPath = join(ROOT, 'index.html');
if (existsSync(htmlPath)) {
  const html = readFileSync(htmlPath, 'utf8');
  if (!html.includes('v__IR_VERSION__')) {
    console.error('index.html 缺版本占位符 v__IR_VERSION__（首页版本文字必须走构建注入，不能写死）');
    dirty += 1;
  }
  if (/\?v=/.test(html)) {
    console.error('index.html 又出现了 ?v= 缓存击穿串（阶段 1 起资产走 hash 文件名，不需要它）');
    dirty += 1;
  }
  if (!dirty) console.log('一致  index.html（版本占位符在、无 ?v=）');
}

if (CHECK && dirty) process.exit(1);
console.log('版本号 ' + version + ' · ' + (CHECK ? '检查通过' : '同步完成'));