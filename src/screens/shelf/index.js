/*
 * src/screens/shelf/index.js —— 书架挂载（阶段 4 · 屏 3）
 *
 * 挂载只替换 #screen-shelf 的内容并打 data-impl（共用外壳见 src/screens/_mount.js）：
 *   - 搜索框 / 键盘 / 空状态按钮仍由 src/app/shelf.js 的 initShelf 按 id 绑定；
 *   - 行列表 / 搜索结果由 src/app/shelf.js 写 shelf.groups / shelf.hits（同一份 $state）。
 * 屏幕可见性仍由界面层的 showShelf / showStart 切 hidden（Nav.showScreen）。
 */
import { mountScreen } from '../_mount.js';
import ShelfScreen from './ShelfScreen.svelte';

mountScreen('screen-shelf', ShelfScreen);
