/*
 * src/core/globals.d.ts —— 构建期注入的全局常量声明（tsc 用）
 *
 * __IR_VERSION__：根目录 VERSION 的内容（vite.config.mjs 的 define 注入）。
 * 只在构建产物里存在；Node 评测（eval/*）不引用它，所以运行时报错也只会出现在漏构建的场景。
 */
declare const __IR_VERSION__: string;
