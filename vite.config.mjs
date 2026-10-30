import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync, writeFileSync, readdirSync, statSync, rmSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_ART } from './src/screens/home/art.js';

/*
 * 阶段 1：Vite 接入
 * 两份产物：
 *   dist/site/    多文件，GitHub Pages / Docker 用（http 服务，PWA 可安装）
 *   dist/single/  单文件 index.html，file:// 双击可开（JS/CSS/图片全部内联，零外链）
 * 开发：npm run dev（Vite dev server）。旧脚本经 src/legacy.js 原样加载，界面零变化。
 *
 * 阶段 1c（本文件新增的 irShell 插件）：
 *   1. 版本戳构建注入：index.html 的 `__IR_VERSION__` 占位（meta 版本戳）→ VERSION 真源
 *     （不再手写 / 不走 ?v=；首页版本文字另走 vite define，见 src/core/version.ts）。
 *     同一个钩子还把首页无 JS 兜底的字符画（`<!--IR_HOME_ART-->`）从唯一真源
 *     src/screens/home/art.js 注入——字符画不在 HTML 与组件里各抄一份。
 *   2. dist/site 的 PWA 稳定名：Vite 会把 <link href> 资产哈希化（assets/manifest-x.webmanifest），
 *      manifest 内部的 icons/… 相对路径随之失效、PWA 装不上；这里把 manifest / 图标回写为稳定名
 *      并把真实文件拷进产物，hashed 副本删掉。
 *   3. sw.js 预缓存清单**构建期生成**： 点名的坑——正则 `(css|js|icons)/…` 已跟不上
 *      hash 文件名；改为按 dist/site 磁盘真实文件名全量注入 PRECACHE（见根目录 sw.js）。
 *   4. dist/single 的单文件收尾：JS / CSS 由 vite-plugin-singlefile 内联，这里把
 *      favicon / iOS 主屏图标也内联成 data URL、并摘掉 manifest 链接（file:// 无 PWA 诉求，
 *      留着只会 404）——产物目录只剩一个 index.html，拷走 / 发人都是完整一份。
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();

/* 无 JS 兜底的字符画：与首页组件同一个源（src/screens/home/art.js），这里只负责拼成 <pre>。
 * 转义只做 & 与 < —— 字符画里不会有标签，但换字符画的人不该被这个问题绊住。 */
const HOME_ART_HTML = '<pre class="inf" aria-hidden="true">'
  + HOME_ART.map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('\n')
  + '</pre>';

/** 构建期外壳处理：版本戳注入（两种产物 + dev）+ dist/single 单文件收尾 + dist/site 的 PWA 稳定名与 sw 预缓存清单 */
function irShell({ single }) {
  return {
    name: 'ir-shell',
    transformIndexHtml(html) {
      return html
        .replaceAll('__IR_VERSION__', VERSION)
        .replaceAll('<!--IR_HOME_ART-->', () => HOME_ART_HTML);
    },
    closeBundle() {
      const out = join(ROOT, 'dist', single ? 'single' : 'site');
      const htmlPath = join(out, 'index.html');

      if (single) {
        // —— 单文件收尾：图标内联 data URL + 摘掉 manifest 链接 ——
        // vite-plugin-singlefile 只内联 JS / CSS；favicon 与 iOS 主屏图标仍是 hashed 附件，
        // 拷走 index.html 就404。这里内联成 data URL 并删掉附件，产物只剩一个 HTML。
        // manifest 一并摘掉：file:// 下 PWA 装不了、SW 也不注册，留着链接只是空请求。
        let html = readFileSync(htmlPath, 'utf8');
        html = html.replace(/\s*<link rel="manifest"[^>]*>/, '');
        for (const [relAttr, file] of [['icon', 'icon-192.png'], ['apple-touch-icon', 'apple-touch-icon.png']]) {
          const b64 = readFileSync(join(ROOT, 'icons', file)).toString('base64');
          html = html.replace(
            new RegExp('<link rel="' + relAttr + '" href="[^"]+"'),
            '<link rel="' + relAttr + '" href="data:image/png;base64,' + b64 + '"',
          );
        }
        writeFileSync(htmlPath, html, 'utf8');
        for (const f of readdirSync(out)) {
          if (/^(manifest-|icon-192-|apple-touch-icon-)/.test(f)) rmSync(join(out, f));
        }

        // —— 自检：占位符已注入、零本地文件引用、目录里只剩 index.html ——
        const html2 = readFileSync(htmlPath, 'utf8');
        if (html2.includes('__IR_VERSION__')) throw new Error('版本占位符没被替换：' + htmlPath);
        if (html2.includes('<!--IR_HOME_ART-->')) throw new Error('首页字符画兜底没被注入：' + htmlPath);
        const refs = [...html2.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])
          .filter(v => !v.startsWith('#') && !v.startsWith('data:') && !/^https?:/.test(v));
        if (refs.length) throw new Error('单文件产物仍有本地文件引用：' + refs.join(' , '));
        const rest = readdirSync(out).filter(f => f !== 'index.html');
        if (rest.length) throw new Error('单文件产物目录应只剩 index.html，多出：' + rest.join(' , '));
        return;
      }

      // —— PWA 稳定名：manifest 与图标回写为相对稳定路径，hashed 副本删除 ——
      let html = readFileSync(htmlPath, 'utf8');
      const hashed = /\.(?:\/)?assets\/(manifest-[A-Za-z0-9_-]+\.webmanifest|icon-192-[A-Za-z0-9_-]+\.png|apple-touch-icon-[A-Za-z0-9_-]+\.png)/g;
      const STABLE = {
        'manifest-': './manifest.webmanifest',
        'icon-192-': './icons/icon-192.png',
        'apple-touch-icon-': './icons/apple-touch-icon.png',
      };
      html = html.replace(hashed, (_m, file) => {
        const key = Object.keys(STABLE).find(k => file.startsWith(k));
        return key ? STABLE[key] : _m;
      });
      writeFileSync(htmlPath, html, 'utf8');

      for (const f of readdirSync(join(out, 'assets'))) {
        if (/^(manifest-|icon-192-|apple-touch-icon-)/.test(f)) rmSync(join(out, 'assets', f));
      }
      copyFileSync(join(ROOT, 'manifest.webmanifest'), join(out, 'manifest.webmanifest'));
      mkdirSync(join(out, 'icons'), { recursive: true });
      for (const f of readdirSync(join(ROOT, 'icons'))) {
        copyFileSync(join(ROOT, 'icons', f), join(out, 'icons', f));
      }

      // —— sw.js 预缓存清单：构建期按磁盘真实文件名生成（含内容 hash 的 assets/） ——
      const files = [];
      (function walk(dir) {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const abs = join(dir, e.name);
          if (e.isDirectory()) walk(abs);
          else files.push('./' + relative(out, abs).split(/[\\/]/).join(posix.sep));
        }
      })(out);
      const precache = files.filter(f => f !== './sw.js').sort();

      const swPath = join(ROOT, 'sw.js');
      const sw = readFileSync(swPath, 'utf8');
      const needle = 'const PRECACHE = [];';
      if (!sw.includes(needle)) {
        throw new Error('sw.js 里找不到「' + needle + '」占位——模板被手改过，预缓存清单无法注入');
      }
      if (!sw.includes('__IR_VERSION__')) {
        throw new Error('sw.js 里找不到版本占位 __IR_VERSION__——缓存名必须构建注入');
      }
      // 版本号与预缓存清单都在构建期注入：源码里不再有手写的 vX.Y.Z
      const swOut = sw
        .replaceAll('__IR_VERSION__', VERSION)
        .replace(needle, 'const PRECACHE = ' + JSON.stringify(precache, null, 2) + ';');
      writeFileSync(join(out, 'sw.js'), swOut, 'utf8');

      // —— 自检：注入没生效就地失败，别把坏产物放出去 ——
      const html2 = readFileSync(htmlPath, 'utf8');
      if (html2.includes('__IR_VERSION__')) throw new Error('版本占位符没被替换：' + htmlPath);
      if (html2.includes('<!--IR_HOME_ART-->')) throw new Error('首页字符画兜底没被注入：' + htmlPath);
      if (!html2.includes('./manifest.webmanifest')) throw new Error('manifest 稳定名回写失败：' + htmlPath);
      const refs = [...html2.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map(m => m[1]);
      for (const r of refs) {
        const f = join(out, r.slice(2));
        if (!existsSync(f) || !statSync(f).isFile()) throw new Error('index.html 引用了不存在的产物：' + r);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    base: './',
    plugins: [svelte(), irShell({ single }), ...(single ? [viteSingleFile()] : [])],
    // 版本号构建注入（JS 侧）：Svelte 屏幕里的 `__IR_VERSION__` 标识符 → VERSION 真源
    define: { __IR_VERSION__: JSON.stringify(VERSION) },
    build: {
      outDir: single ? 'dist/single' : 'dist/site',
      emptyOutDir: true,
      target: 'es2020',
      // 单文件产物把图片等资源一并内联成 data URL——双击打开不缺任何东西
      assetsInlineLimit: single ? 100 * 1024 * 1024 : undefined,
    },
  };
});
