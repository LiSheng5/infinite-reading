/* src/screens/shelf/shelf.svelte.js —— 书架屏的状态桥（Svelte 5 runes）
 *
 * js/app/shelf.js 的 renderShelf / runSearch 经 window.IR.ShelfScreen 把视图模型推进来
 *（分组行列表 / 搜索命中），组件只负责按旧 DOM 结构渲染：
 *   seq / groups —— 行列表：每次 renderShelf 推数据 seq +1，{#key} 整体重建行 DOM，
 *                   与旧 renderShelf 的 list.innerHTML='' 同语义（行错峰淡入重放、行菜单随行销毁）；
 *   resSeq / hits —— 搜索结果：每次结果替换 resSeq +1，同样整体重建（旧 innerHTML='' 同语义）。
 * 旧行为函数（openStory / rename / regen / search / keyboard）零改动，靠 id / class 选择器
 * 直接读写组件产出的 DOM（titleElOf、moveActive、closeRowMenus 等）。
 * 旧屏（?ui=legacy）不注册这个桥（shelf.js 走 DOM 拼装老路），行为与 0.12.1 一致。
 */
export const shelf = $state({
  seq: 0,
  groups: [],   // [{ key, label, count, items: [rowModel], capped, moreCount }]
  resSeq: 0,
  hits: [],     // [hitModel]
});
