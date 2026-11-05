/* 首页的状态桥（Svelte 5 runes）
 * 「继续上次」的可见性与标题由界面层的 showStart 推进来（HomeScreen.setRecent），
 * 组件不自己查 Store——数据口径与旧实现一致（Store.listStories()[0]）。
 * recent：null = 没有存档（按钮隐藏）；'' = 有存档但没标题；其余 = 「《书名》」。
 *
 * lang：界面语言偏好（右上角胶囊切换器写入）。英文文案还没上线，先落按钮与偏好：
 * 初值从 localStorage（ir:lang）恢复（守卫写法同 index.html 的首帧动效档位读取），
 * 后续 i18n 文案接管时直接消费 home.lang，不必再另起状态。 */
function initialLang() {
  try {
    return localStorage.getItem('ir:lang') === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}
export const home = $state({ recent: null, lang: initialLang() });
