/*
 * src/ui/a11y.js —— 键盘可达性的小工具
 *
 * 有些「可点元素」是图片 / 文本节点（聊天内图片、舞台缩略图），浏览器给它们的语义是
 * 纯静态内容：鼠标点得动，键盘和读屏碰不到。给它们补 role="button" + tabindex="0" 之后，
 * 还差「按下去」这一步——Enter / Space 必须触发同一个动作，Space 还得压住默认的翻页滚动。
 *
 * 只做这一件事，不接管别的键（Tab / 方向键 / Esc 仍归焦点陷阱与应用层）。
 */

/**
 * 把点击动作包成 keydown 处理器：Enter / Space 触发，其它键原样放行。
 * @param {(e: KeyboardEvent) => void} fn 与 onclick 同语义的动作
 * @returns {(e: KeyboardEvent) => void}
 */
export function onActivate(fn) {
  return (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();   // Space 不翻页、Enter 不重复提交
    fn(e);
  };
}
