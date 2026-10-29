#!/usr/bin/env node
/**
 * 版本号同步：以根目录 VERSION 为唯一真源。
 *
 * 阶段 6 起**运行时版本号全部构建注入**，源码里不再有手写的 vX.Y.Z：
 *   - 首页版本文字：src/screens/home/HomeScreen.svelte 用 `__IR_VERSION__`（vite define）
 *   - 导出包 / 备份包的 app 戳：src/core/{store,backupPack}.ts 用 `__IR_VERSION__`
 *   - Service Worker 缓存名：sw.js 里 `'ir-v' + '__IR_VERSION__'`，构建期由 vite.config.mjs 替换
 * 本脚本只负责「构建管不到」的两处：
 *   - package.json 的 version（npm 元数据，必须与 VERSION 一致）
 *   - README 徽章与「当前版本」文字（文档，随发版更新）
 * 同时守住三条红线：占位符不许丢、`?v=` 不许回来、运行时源码里不许再写版本字面量。
 *
 * 用法：
 *   node tools/sync-version.mjs           写入
 *   node tools/sync-version.mjs --check   只检查（CI 用；不一致 → 退出码 1）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('VERSION 内容不是 x.y.z 形式：' + JSON.stringify(version));
  process.exit(1);
}

let dirty = 0;

/* ---------- 1. 构建管不到的两处：npm 元数据与文档 ---------- */
const TARGETS = [
  {
    file: 'package.json',
    find: () => /("version"\s*:\s*")[^"]*(")/g,
    replace: (_m, a, b) => a + version + b,
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
    // 徽章下方那行「当前版本 vX」文字
    file: 'README.en.md',
    find: () => /\*\*Current version: v[0-9A-Za-z.\-]+\*\*/g,
    replace: () => '**Current version: v' + version + '**',
  },
];

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

/* ---------- 2. 红线 A：构建注入占位必须在 ---------- */
const PLACEHOLDERS = [
  ['sw.js', '__IR_VERSION__'],
  ['src/screens/home/HomeScreen.svelte', '__IR_VERSION__'],
  ['src/core/version.ts', '__IR_VERSION__'],
];
for (const [file, needle] of PLACEHOLDERS) {
  const p = join(ROOT, file);
  if (!existsSync(p)) continue;
  if (!readFileSync(p, 'utf8').includes(needle)) {
    console.error(file + ' 缺构建注入占位 ' + needle + '（版本号不许手写）');
    dirty += 1;
  } else {
    console.log('一致  ' + file + '（含 ' + needle + '）');
  }
}

/* ---------- 3. 红线 B：运行时源码里不许出现版本字面量 ---------- */
// 只看代码行（跳过整行注释）；允许 README / 文档 / 测试夹具写版本。
// 只盯「当前版本」这一串（vX.Y.Z 或裸 X.Y.Z），别的模块自己的版本号（如模型能力表 0.2.0）不算。
const LITERAL = new RegExp('(?<![\\w.])v?' + version.replace(/\./g, '\\.') + '(?![\\w.])');
const codeFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|ts|svelte)$/.test(e.name)) codeFiles.push(p);
  }
})(join(ROOT, 'src'));
codeFiles.push(join(ROOT, 'sw.js'));
for (const p of codeFiles) {
  const bad = readFileSync(p, 'utf8').split('\n')
    .map((line, i) => ({ line, i }))
    .filter(x => !/^\s*(\*|\/\/|\/\*)/.test(x.line) && LITERAL.test(x.line));
  if (bad.length) {
    for (const b of bad) {
      console.error(relative(ROOT, p) + ':' + (b.i + 1) + ' 出现手写版本号：' + b.line.trim().slice(0, 120));
    }
    dirty += 1;
  }
}

/* ---------- 4. 红线 C：index.html 不许有 ?v= 缓存击穿串 ---------- */
const htmlPath = join(ROOT, 'index.html');
if (existsSync(htmlPath) && /\?v=/.test(readFileSync(htmlPath, 'utf8'))) {
  console.error('index.html 又出现了 ?v= 缓存击穿串（资产走 hash 文件名，不需要它）');
  dirty += 1;
}

if (CHECK && dirty) process.exit(1);
console.log('版本号 ' + version + ' · ' + (CHECK ? '检查通过' : '同步完成'));
