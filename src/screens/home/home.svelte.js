/* 阶段 4 · 屏 1 首页的状态桥（Svelte 5 runes）
 * 「继续上次」的可见性与标题由界面层的 showStart 推进来（IR.HomeScreen.setRecent），
 * 组件不自己查 Store——数据口径与旧实现一致（Store.listStories()[0]）。
 * recent：null = 没有存档（按钮隐藏）；'' = 有存档但没标题；其余 = 「《书名》」。 */
export const home = $state({ recent: null });
