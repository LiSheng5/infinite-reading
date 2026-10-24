#!/usr/bin/env node
/**
 * 单文件打包（开源路线图 W2 / L1）
 *
 * 把 index.html + css/style.css + js/*.js 内联成一个 `dist/ir.html`：
 *   - 一个文件即可运行，能当附件发、能塞进邮件、能直接双击（仍是 file://）
 *   - 依然零依赖、零构建：这个脚本只是「可选工具」，运行时源码不依赖它
 *
 * 用法：
 *   node tools/bundle-single-file.mjs                  # 输出 dist/ir.html
 *   node tools/bundle-single-file.mjs --out dist/x.html
 *
 * 已知取舍（写进 README）：
 *   - 内联后 ?v= 缓存击穿串失效（不再有多文件版的增量更新）
 *   - file:// 下的 localStorage 与「本地服务 / 在线版」互不相通，迁移请用导出导入
 *   - 字体仍走 CDN；断网时自动退回系统字体
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
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

const readRel = rel => readFileSync(join(ROOT, rel.split('?')[0]), 'utf8');

let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const inlined = [];
const skipped = [];

// 1) 内联样式表：<link rel="stylesheet" href="css/style.css?v=…">
html = html.replace(/<link\b[^>]*href="(css\/[^"]+)"[^>]*>/g, (m, href) => {
  inlined.push(href.split('?')[0]);
  // CSS 里若出现 </style> 字面量，会提前截断样式块 → 转义（审查 可简化 #8）
  const css = readRel(href).replace(/<\/style>/gi, '<\\/style>');
  return '<style>\n' + css + '\n</style>';
});

// 2) 内联脚本：<script src="js/x.js?v=…"></script>（顺序即加载顺序，原样保留）
//    PWA 注册脚本跳过：单文件版旁边没有 sw.js，注册只会 404（它的 catch 是静默的，但没必要留着）
const SKIP = ['js/pwa.js'];
html = html.replace(/<script\b[^>]*src="(js\/[^"]+)"[^>]*><\/script>/g, (m, src) => {
  const rel = src.split('?')[0];
  if (SKIP.indexOf(rel) !== -1) {
    skipped.push(rel);
    return '';
  }
  inlined.push(rel);
  // 脚本里若出现 </script> 字面量（如字符串拼接），会提前截断标签 → 转义
  const js = readRel(src).replace(/<\/script>/gi, '<\\/script>');
  return '<script>\n' + js + '\n</script>';
});

if (!inlined.length) {
  console.error('没有内联到任何文件：index.html 结构变了？请检查 <link href="css/…"> 与 <script src="js/…">');
  process.exit(1);
}

// 3) 自检：不该再有指向本地 css/js 的外部引用
const left = html.match(/<(?:script|link)\b[^>]*(?:src|href)="(?:css|js)\//g) || [];
if (left.length) {
  console.error('仍有未内联的本地引用（' + left.length + ' 处）：' + left.join(' , '));
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);

const kb = (statSync(OUT).size / 1024).toFixed(1);
console.log('已生成 ' + OUT.replace(ROOT + '\\', '').replace(ROOT + '/', '') + '（' + kb + ' KB，内联 ' + inlined.length + ' 个文件）');
console.log('内联清单：' + inlined.join(' , '));
if (skipped.length) console.log('已跳过：' + skipped.join(' , ') + '（单文件版不带 Service Worker）');
