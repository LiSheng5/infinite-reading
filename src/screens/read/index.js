/*
 * src/screens/read/index.js —— 阅读页挂载（阶段 4 · 屏 4）
 *
 * 挂载只替换 #game-layout 的内容并打 data-impl（共用外壳见 src/screens/_mount.js）：
 * 组件产出 chat-pane + splitter + image-pane，事件绑定一个都不少 —— 输入 / 发送 /
 * 做说导演 / 灵感 / 舞台按钮 / 视频菜单 / 分隔条等仍由 src/app/main.js 的 bind() 与
 * bindSplitter() 按 id 挂上。聊天流 / 缩略图条由 src/app/render.js 写 read.chat /
 * read.thumbs（同一份 $state）。屏幕可见性仍由界面层的 enterGame / showShelf 切
 * #screen-game 的 hidden。
 */
import { mountScreen } from '../_mount.js';
import ReadScreen from './ReadScreen.svelte';

mountScreen('game-layout', ReadScreen);
