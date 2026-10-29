/*
 * src/core/version.ts —— 应用版本号的唯一读口
 *
 * 构建产物里 __IR_VERSION__ 由 vite.config.mjs 的 define 注入（根目录 VERSION）。
 * Node 评测 / 静态检查没有这个注入，`typeof` 守卫让它降级成 'dev' 而不是抛 ReferenceError
 * （导出包的 app 戳只在真实导出时用，评测不校验它）。
 */
export const APP_VERSION: string = typeof __IR_VERSION__ !== 'undefined' ? __IR_VERSION__ : 'dev';
