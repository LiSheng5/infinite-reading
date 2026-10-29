<script>
  /* NewStoryModal.svelte —— #modal-new「新故事 · 选模式」（屏 6b 重建）
   * 三张模式卡就是三个开局入口（无「开始」按钮），点击由 src/app/main.js 的统一绑定按
   * `#modal-new .mode-card` + data-mode 派发，所以这里只产标记、不挂 handler。
   * 卡片保留 0.12.1 的 .mode-card 类（css/style.css 里是完整的卡面视觉）。 */
  import Card from './Card.svelte';

  const MODES = [
    { mode: 'choice', name: '剧情', desc: '给选项的故事。开头有一页设定向导，你把世界观与人物交代清楚，故事就从那里生长。' },
    { mode: 'chat', name: '智能体', desc: '带工具的助手：能画图、记事、定时、写邮件、下单（都要你确认）。' },
    { mode: 'rp', name: '扮演', desc: '角色扮演。以一张角色卡登场（可空白自建，也可导入 SillyTavern V2/V3 PNG 卡），玩的是关系。' },
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
