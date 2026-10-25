import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';

/*
 * 阶段 1：Vite 接入（任务书 §2 / §5）
 * 两份产物：
 *   dist/site/    多文件，GitHub Pages / Docker 用（http 服务，PWA 可安装）
 *   dist/single/  单文件 index.html，file:// 双击可开（JS/CSS/图片全部内联，零外链）
 * 开发：npm run dev（Vite dev server）。旧脚本经 src/legacy.js 原样加载，界面零变化。
 */
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    base: './',
    plugins: [svelte(), ...(single ? [viteSingleFile()] : [])],
    build: {
      outDir: single ? 'dist/single' : 'dist/site',
      emptyOutDir: true,
      target: 'es2020',
      // 单文件产物把图片等资源一并内联成 data URL——双击打开不缺任何东西
      assetsInlineLimit: single ? 100 * 1024 * 1024 : undefined,
    },
  };
});
