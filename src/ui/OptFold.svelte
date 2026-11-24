<script>
 /* OptFold.svelte —— 开局页的「更多设定（可选）」折叠块（剧情向导 / 角色卡编辑共用一份）
  *
  * 三种模式的可选字段都收进同一个块：措辞（「更多设定（可选）」）与样式（css/overlays.css 的
  * .opt-fold）只此一份，不在各弹窗里再写第二遍——否则两处标题迟早会漂成两种说法。
  *
  * open 状态不归组件：wizard.js / cards.js 按 id 直接改 <details> 的 open（有内容才自动展开，
  * 手动折叠不被普通输入抢回去），摘要行也由它们按 id 写「人物 2 · 已填风格」这类已填提示，
  * 所以这里的 id / sumId 必须原样落到 DOM 上，组件自己不碰 open。
  *
  * 动画：内容区 .fold-body 在展开时淡入（css/overlays.css）；系统「减少动态效果」时
  * 由 css/motion.css 末尾的 @media 兜底压到接近 0（原生 details 直接跳变）。 */
  let { id = null, sumId = null, sumText = '', children } = $props();
</script>

<details {id} class="opt-fold">
  <summary>更多设定（可选）<span class="fold-sum" id={sumId}>{sumText}</span></summary>
  <div class="fold-body">{@render children?.()}</div>
</details>
