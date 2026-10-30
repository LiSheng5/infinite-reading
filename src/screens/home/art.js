/*
 * src/screens/home/art.js —— 首页 ASCII 无限符号的唯一真源
 *
 * 两个消费方，都不许再抄一份字符画：
 *   1. src/screens/home/HomeScreen.svelte：逐字拆 span，做「深 → 浅」色带（有 JS 时）；
 *   2. index.html 的无 JS 兜底：构建期由 vite.config.mjs 的 irShell 插件把占位
 *      <!--IR_HOME_ART--> 换成这里拼好的 <pre class="inf">（静态深蓝，不经过组件）。
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
