<script>
 /* NewStoryModal.svelte —— #modal-new「新故事 · 选模式」
   * 两张模式卡就是两个开局入口（无「开始」按钮），点击由 src/app/main.js 的统一绑定按
   * `#modal-new .mode-card` + data-mode 派发，所以这里只产标记、不挂 handler。
   * 卡片保留迁移前的 .mode-card 类（css/overlays.css 里是完整的卡面视觉）。 */
  import Card from '../../ui/ModalCard.svelte';

  const MODES = [
    { mode: 'choice', name: '剧情', desc: '给选项的故事。开头有一页设定向导，你把世界观与人物交代清楚，故事就从那里生长。' },
    { mode: 'chat', name: '聊天', desc: '助手，可选角色卡。有事直说，它替你去办。' },
  ];
</script>

<Card title="新故事" narrow closeId="btn-close-new">
  <div class="mode-cards">
    {#each MODES as m}
      <button class="mode-card" type="button" data-mode={m.mode}>
        <b>{m.name}</b><span>{m.desc}</span>
      </button>
    {/each}
  </div>
</Card>
