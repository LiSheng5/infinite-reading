/*
 * src/core/ir.ts —— IR 命名空间的唯一定义点（阶段 2：核心逻辑模块化）
 *
 * 角色：**薄兼容层**。
 *  - 核心模块（src/core/*.ts）都是正经 ES module，各自 `export` 真实 API；
 *  - 本文件只提供一张「导出镜像表」：registerIR() 把各模块导出登记到 globalThis.IR，
 *    让还没迁移的界面层（js/app/*.js、js/app.js）照旧用 IR.Store / IR.Tree …… 访问；
 *  - 模块之间现存的 `global.IR.x` 惰性互访（含缺位兜底语义）**逐字保留**——
 *    这些查找是有意的可选依赖（如 IR.Prefs 缺位时 store 走更严的兜底清洗），
 *    改成静态 import 会改变行为，等屏幕逐个迁移（阶段 4/6）再拆。
 *
 * 等所有屏幕迁完、IR 没有消费者了，删掉这个文件与各模块的 registerIR() 调用即可（阶段 6）。
 */

/** 兼容命名空间对象：与浏览器里的 window.IR、Node 里的 globalThis.IR 是同一个对象 */
export const IR: Record<string, any> = (globalThis as any).IR ??= {};

/** 把一个模块的导出登记进 IR 兼容层（键名 = 旧 IR 属性名，保持不变） */
export function registerIR(part: Record<string, unknown>): void {
  Object.assign(IR, part);
}
