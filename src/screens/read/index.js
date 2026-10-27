/*
 * src/screens/read/index.js —— 阶段 4 · 屏 4 阅读页重写挂载（铁律 3：新旧共存，开关切换）
 *
 * 默认挂 Svelte 新阅读页（聊天区 / 输入区 / 选项托盘 / 舞台 / 缩略图条）；
 * URL 带 ?ui=legacy 时退回 0.12.1 的旧 DOM（过渡期逃生口，阶段 6 删）。
 * 挂载把 #game-layout 里的旧 DOM 清空换成组件输出（chat-pane + splitter + image-pane），
 * 并在容器上打 data-impl="svelte"：
 *   - 事件绑定一个都不跳过：输入 / 发送 / 做说导演 / 灵感 / 舞台按钮 / 视频菜单 / 分隔条等
 *     仍由 js/app.js 的 bind() 与 bindSplitter() 按 id 原样挂上（挂载在 import 期同步完成、
 *     bind() 在 Store.boot() 之后才跑，组件输出的同 id 静态元素照常被绑到），行为零改动；
 *   - js/app/render.js 的 renderChat / renderThumbs 经 IR.ReadScreen 状态桥把视图模型推进来，
 *     气泡 / 开场引导 / 选项托盘 / 缩略条由组件按旧 DOM 结构渲染；renderStage / 流式气泡
 *     interior 等命令式逻辑照旧直接写 DOM（元素由组件静态输出，选择器照常命中）。
 * 屏幕可见性仍由界面层的 enterGame / showShelf 切 #screen-game 的 hidden，与旧实现同一套开关。
 */
import { mount, flushSync } from 'svelte';
import ReadScreen from './ReadScreen.svelte';
import { read } from './read.svelte.js';

const legacy = new URLSearchParams(location.search).get('ui') === 'legacy';

if (!legacy) {
  const layout = document.getElementById('game-layout');
  if (layout) {
    layout.replaceChildren();
    layout.dataset.impl = 'svelte';
    mount(ReadScreen, { target: layout });
    (window.IR = window.IR || {}).ReadScreen = {
      // flushSync：推完立即落 DOM——renderChat 是同步语义（末尾就要 scrollChatBottom，
      // round.js / turn.js 随后要查 .bubble-live / .reason-live-text），不能等微任务批处理
      chat(model) { flushSync(() => { read.chatSeq += 1; read.chat = model; }); },
      thumbs(model) { flushSync(() => { read.thumbs = model.items; read.thumbsEmpty = model.empty; }); },
    };
  }
}
