/* src/ui —— 基础组件库（阶段 3，任务书 §6.3 / §7）
 * Svelte 5 组件 + 统一动效模块的 DOM 接线。样式一律作用域限定、只走设计令牌（css/tokens.css）。
 * 阶段 4 逐屏重写时从这里引入；图标与 0.12.1 sprite 逐字一致（eval/ui-lib-test.js 对账）。 */
export { default as Icon } from './Icon.svelte';
export { default as Button } from './Button.svelte';
export { default as IconButton } from './IconButton.svelte';
export { default as Field } from './Field.svelte';
export { default as TextInput } from './TextInput.svelte';
export { default as Select } from './Select.svelte';
export { default as Checkbox } from './Checkbox.svelte';
export { default as Modal } from './Modal.svelte';
export { default as Collapse } from './Collapse.svelte';
export * from './motion.js';
