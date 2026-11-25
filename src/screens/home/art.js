/*
 * src/screens/home/art.js —— 首页 ASCII 无限符号的唯一真源
 *
 * 唯一消费方是构建期注入，不许再抄一份字符画：
 *   index.html 的无 JS 兜底：vite.config.mjs 的 irShell 插件把占位
 *   <!--IR_HOME_ART--> 换成这里拼好的 <pre class="inf">（静态深蓝，不经过组件）。
 * 有 JS 时的首页主视觉是 canvas 粒子（InfinityStage / GridStage），不读这份字符画。
 * 改字符画只改这里；全仓只有这一份由 eval/ui-state-test.js 盯着。
 */
export const HOME_ART = [
  '    .-~~~~-.       .-~~~~-.',
  "  .'        '.   .'        '.",
  ' /            \\ /            \\',
  '|              X              |',
  ' \\            / \\            /',
  "  '.        .'   '.        .'",
  "    '-~~~~-'       '-~~~~-'",
];
