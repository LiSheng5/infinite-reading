/* src/screens/read/read.svelte.js —— 阅读页屏的状态桥（Svelte 5 runes）
 *
 * src/app/render.js 的 renderChat / renderThumbs 经 ReadScreen 把视图模型推进来
 *（src/app/readmodel.js 同口径构建），组件只负责按旧 DOM 结构渲染：
 *   chatSeq / chat —— 聊天流 + 选项态：每次 renderChat 推数据 chatSeq +1，{#key} 整体重建，
 *                    与旧 renderChat 的 chat-scroll.innerHTML='' 同语义（思考链开合态、
 *                    流式 span 不跨推送残留）；
 *   thumbs / thumbsEmpty —— 缩略图条：整表替换（empty 口径同旧 renderThumbs：scenes 空才算空态）。
 * 旧行为函数零改动：流式 span.delta / typewrite 照旧往 .bubble-live 空壳里写（interior 由
 * render.js 的 fillLiveDom 回填）；syncKindSwitch / setSendButtonsBusy / updateHistoryBar /
 * renderFeatureBar / renderStage 等仍按 id 选择器直接读写组件产出的静态元素。
 * 视图模型口径与 0.12.1 的 DOM 拼装逐字段一致。
 */
import { flushSync } from 'svelte';

export const read = $state({
  chatSeq: 0,
  chat: {
    entries: [],      // [entryModel]（src/app/readmodel.js）
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

/* 推视图模型的两个入口（src/app/render.js 调用）。
 * flushSync：推完立即可读 DOM——renderChat 的末尾要 scrollChatBottom，round.js / turn.js
 * 随后要查 .bubble-live / .reason-live-text，不能等微任务批量处理。 */
export function setChat(model) {
  flushSync(() => { read.chatSeq += 1; read.chat = model; });
}

export function setThumbs(model) {
  flushSync(() => { read.thumbs = model.items; read.thumbsEmpty = model.empty; });
}
