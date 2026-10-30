#!/usr/bin/env node
/**
 * 单文件打包（阶段 1 起改走 Vite + vite-plugin-singlefile，本脚本只是契约不变的薄封装）
 *
 * 历史：这个文件原先是「正则把 <script src="js/…"> 内联进 HTML」的零构建打包器。
 * 阶段 1 接入 Vite 后脚本改成 ES module 入口（src/legacy.js），正则内联不再适用；
 * 单文件产物改由 vite-plugin-singlefile 生成（全部内联、file:// 双击可开、图片也内联）。
 * 对外契约保持不变：`npm run bundle` / `node tools/bundle-single-file.mjs` 仍产出 dist/ir.html。
 *
 * 用法：
 *   node tools/bundle-single-file.mjs                  # 输出 dist/ir.html
 *   node tools/bundle-single-file.mjs --out dist/x.html
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const outArgIdx = process.argv.indexOf('--out');
const outVal = outArgIdx !== -1 ? process.argv[outArgIdx + 1] : 'dist/ir.html';
if (!outVal) {
  console.error('--out 后面要跟输出路径');
  process.exit(1);
}
const OUT = resolve(ROOT, outVal);

// 1) 交给 Vite 打单文件产物（dist/single/index.html，JS/CSS/图片全内联）
const vite = resolve(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
const r = spawnSync(vite, ['build', '--mode', 'single'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) {
  console.error('vite 单文件构建失败');
  process.exit(r.status || 1);
}

// 2) 自检 + 落到契约路径：产物里不该再有指向本地文件的外部引用（JS / CSS 要内联，图标 / manifest 也是）
const single = join(ROOT, 'dist', 'single', 'index.html');
let html;
try { html = readFileSync(single, 'utf8'); } catch (e) {
  console.error('没找到构建产物 ' + single + '：' + e.message);
  process.exit(1);
}
// data:（图标内联）与 #（svg use 内部引用）之外的 src / href 都算没内联
const left = [...html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)="([^"]+)"/g)]
  .map(m => m[1])
  .filter(v => !v.startsWith('data:') && !v.startsWith('#') && !/^https?:/.test(v));
if (left.length) {
  console.error('单文件产物里仍有未内联的本地引用（' + left.length + ' 处）：' + left.join(' , '));
  process.exit(1);
}
if (html.includes('__IR_VERSION__')) {
  console.error('单文件产物里还有 __IR_VERSION__ 占位符没被替换');
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
copyFileSync(single, OUT);
const kb = (statSync(OUT).size / 1024).toFixed(1);
console.log('已生成 ' + OUT.replace(ROOT + '\\', '').replace(ROOT + '/', '') + '（' + kb + ' KB，vite-plugin-singlefile 内联）');
