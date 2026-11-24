<script>
 /* AgentIntro.svelte —— 智能体空对话的「能做什么」引导（readmodel 的 agentIntro / agentChips 同构）
   * 第一行是模式说明（readmodel 取 A.MODE_ENTRY.chat.desc，与剧情 / 扮演的开局页共用一份文案表），
   * 之后才是「能帮你……」的能力清单——只列判定为可用的能力。
   * 发出第一条消息后 readmodel 不再给 agentIntro，这块自然消失（只依赖 log.length === 0，不存状态）。
   * 组件只产标记，点击行为走 A 注册表：
   *   已启用 → fillPlayerInput 把示例句预填进 #player-input（不自动发送），光标落在可编辑处；
   *   未启用 → openSettings + openSettingsGroup 跳到对应设置分组（不预填）。
   * 安全红线：文案一律文本插值（≡ textContent），绝不 {@html}。 */
  import { A as appApi } from '../../app/core.js';

  let { chat } = $props();

  const A = () => appApi;
  function chipClick(c) {
    const a = A();
    if (c.enabled) { a.fillPlayerInput(c.prompt); return; }
    a.openSettings();
    a.openSettingsGroup(c.fixGroup);
  }
</script>

<div class="agent-intro">
  {#if chat.agentIntroDesc}<p class="hint entry-desc">{chat.agentIntroDesc}</p>{/if}
  {#each chat.agentIntroText as line}<p class="agent-intro-line">{line}</p>{/each}
  <div class="agent-chips">
    {#each chat.agentChips as c (c.id)}
      <button type="button" class="agent-chip" class:off={!c.enabled} title={c.enabled ? c.prompt : c.why} onclick={() => chipClick(c)}><span class="agent-chip-label">{c.label}</span>{#if !c.enabled}<span class="agent-chip-fix">未启用 ›</span>{/if}</button>
    {/each}
  </div>
</div>
