/*
 * src/screens/home/index.js —— 首页挂载（阶段 4 · 屏 1）
 *
 * 挂载只替换 #screen-start 的内容并打 data-impl（共用外壳见 src/screens/_mount.js）。
 * 屏幕可见性仍由界面层的 showStart / showShelf 切 #screen-start 的 hidden（Nav.showScreen）。
 * 「继续上次」的状态由 src/app/library.js 写 home.recent（同一份 $state）；
 * 状态单独放 home.svelte.js 而不并进本文件：$state 只能写在 .svelte.js 模块里，
 * 而本文件 import 了 HomeScreen —— 状态若挪进来，组件就得反过来 import 挂载模块（成环）。
 */
import { mountScreen } from '../_mount.js';
import HomeScreen from './HomeScreen.svelte';

mountScreen('screen-start', HomeScreen);
