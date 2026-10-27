/* src/screens/read/read.svelte.js —— 阅读页屏的状态桥（Svelte 5 runes）
 *
 * js/app/render.js 的 renderChat / renderThumbs 经 window.IR.ReadScreen 把视图模型推进来
 *（js/app/readmodel.js 同口径构建），组件只负责按旧 DOM 结构渲染：
 *   chatSeq / chat —— 聊天流 + 选项态：每次 renderChat 推数据 chatSeq +1，{#key} 整体重建，
 *                    与旧 renderChat 的 chat-scroll.innerHTML='' 同语义（思考链开合态、
 *                    流式 span 不跨推送残留）；
 *   thumbs / thumbsEmpty —— 缩略图条：整表替换（empty 口径同旧 renderThumbs：scenes 空才算空态）。
 * 旧行为函数零改动：流式 span.delta / typewrite 照旧往 .bubble-live 空壳里写（interior 由
 * render.js 的 fillLiveDom 回填）；syncKindSwitch / setSendButtonsBusy / updateHistoryBar /
 * renderFeatureBar / renderStage 等仍按 id 选择器直接读写组件产出的静态元素。
 * 旧屏（?ui=legacy）不注册这个桥（render.js 走 DOM 拼装老路），行为与 0.12.1 一致。
 */
export const read = $state({
  chatSeq: 0,
  chat: {
    entries: [],      // [entryModel]（js/app/readmodel.js）
    openingHint: false,
    live: false,      // 流式 / 打字机临时旁白在场（组件渲染两个空壳）
    liveReason: false,
    choices: [],      // 内联选项（choices=always）
    tray: [],         // 托盘选项（展开时）
    trayVisible: false,
    trayOpen: false,
    inspiration: false,
    inspirationCount: '',
  },
  thumbs: [],         // [thumbModel]
  thumbsEmpty: true,
});
