/* src/screens/read/read.svelte.js —— 阅读页屏的状态桥（Svelte 5 runes）
 *
 * src/app/render.js 的 renderChat / renderThumbs 经 ReadScreen 把视图模型推进来
 *（src/app/readmodel.js 同口径构建），组件只负责按旧 DOM 结构渲染：
 *   chat —— 聊天流 + 选项态：每次 renderChat 推数据；消息流按条目 key 做 keyed 更新
 *          （key = log 条目对象身份，readmodel 的 WeakMap 发号）——旧气泡跨
 *          renderChat 常驻，不再像旧 chat-scroll.innerHTML='' 那样整条销毁重建（内联图
 *          不重新解码、入场动画不重放），思考链开合态随条目保留；
 *   thumbs / thumbsEmpty —— 缩略图条：整表替换（empty 口径同旧 renderThumbs：scenes 空才算空态）。
 * 流式与打字机沿用旧实现：span.delta / typewrite 照旧往 .bubble-live 空壳里写（interior 由
 * render.js 的 fillLiveDom 回填）；syncKindSwitch / setSendButtonsBusy / updateHistoryBar /
 * renderFeatureBar / renderStage 等仍按 id 选择器直接读写组件产出的静态元素。
 * 视图模型口径与迁移前的 DOM 拼装逐字段一致。
 */
import { flushSync } from 'svelte';

export const read = $state({
  chat: {
    entries: [],      // [entryModel]（src/app/readmodel.js，每项带稳定 key）
    openingHint: false,
    agentIntro: false,   // 聊天空对话引导（只依赖无卡 + log.length === 0，不存状态）
    agentIntroDesc: '',  // 引导首行的模式说明（读 A.MODE_ENTRY.chat.desc，与剧情开局页共用一份文案表）
    agentChips: [],      // [{ id, label, prompt, enabled, why, fixGroup }]（readmodel 同构）
    agentIntroText: [],  // 引导文案行（只列判定为可用的能力）
    live: false,      // 流式 / 打字机临时旁白在场（组件渲染两个空壳）
    liveReason: false,
    choices: [],      // 内联选项（choices=always）
    tray: [],         // 托盘选项（展开时）
    trayVisible: false,
    trayOpen: false,
    inspiration: false,
    inspirationCount: '',
    usage: null,       // 上下文用量指示器（readmodel 的 usageView：只读估算，流式期间保持旧值）
    compact: null,     // 用量气泡底部的手动压缩按钮（readmodel 的 compactView；随 usage 一起出现）
  },
  thumbs: [],         // [thumbModel]
  thumbsEmpty: true,
});

/* 推视图模型的两个入口（src/app/render.js 调用）。
 * flushSync：推完立即可读 DOM——renderChat 的末尾要 scrollChatBottom，round.js / turn.js
 * 随后要查 .bubble-live / .reason-live-text，不能等微任务批量处理。 */
export function setChat(model) {
  flushSync(() => { read.chat = model; });
}

export function setThumbs(model) {
  flushSync(() => { read.thumbs = model.items; read.thumbsEmpty = model.empty; });
}
