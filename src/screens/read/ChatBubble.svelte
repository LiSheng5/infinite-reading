<script>
  /* ChatBubble.svelte —— 聊天流一条消息（阶段 4 屏 4，src/app/render.js 的 bubbleFor 同构）
   * 按 entry.kind 分派：text / note / image / video / agent / proposal；
   * DOM 与 0.12.1 各子渲染器（textBubble / toolNoteBubble / imageRowBubble / inlineImageBubble /
   * videoBubble / agentBubble / proposalBubble）逐节点同结构——类名、title、aria 全保留。
   * 安全红线（§8）：用户 / 模型产出一律文本插值（≡ textContent），绝不 {@html}。
   * 思考链开合是组件本地状态：每次 renderChat 的 {#key} 重建即复位（旧 DOM innerHTML='' 同语义）。
   * 点击动作直连应用层注册表（src/app/core.js 的 A）。
   *
   * ⚠ 模板必须紧凑书写（兄弟节点间零空白）：.bubble 是 white-space: pre-wrap（style.css），
   *   Svelte 在 {#if} 锚点两侧留下的 " " 空白文本节点会被渲染成空行 / 行首空格，
   *   把文字整体推歪（换行点漂移）。注释不渲染，可作行内分隔。 */
  import Icon from '../../ui/Icon.svelte';
  import { A as appApi } from '../../app/core.js';

  let { entry: e } = $props();

  const A = () => appApi;
  let reasonOpen = $state(false);

  // 点图 / 点文字 = 在右侧舞台选中这张（同旧 selectScene / selectVideo）
  function selectScene() {
    const a = A();
    if (!a.state.story) return;
    a.state.story.lastBg = e.entry.id;
    a.saveAll();
    a.renderStage();
    a.renderThumbs();
  }
  function openWorkbench() { A().openWorkbench(e.entry.id); }
  function openLightbox() { A().openLightbox(e.entry); }
  function openRemote() {
    try { window.open(e.entry.remoteUrl, '_blank', 'noopener'); } catch (_) {}
  }
  function retry() { A().retryLast(); }
  function switchSib(dir) { A().switchSiblingFromBubble(e.nid, dir); }
  function confirmProposal() { A().confirmProposal(e.entry); }
  function denyProposal() { A().denyProposal(e.entry); }
</script>

{#if e.kind === 'text'}
<!-- 文本气泡：reason-block 在最前（旧 insertBefore(firstChild) 同序）→ kind-tag → 正文 → 工具行 -->
<div class={e.cls} data-nid={e.nid || null}>{#if e.reasoning}<div class="reason-block" class:open={reasonOpen}><button type="button" class="reason-toggle" onclick={() => (reasonOpen = !reasonOpen)}><span class="reason-caret"><Icon name="chev" /></span><span class="reason-label">思考链</span></button><div class="reason-panel"><div class="reason-text">{e.reasoning}</div></div></div>{/if}{#if e.kindTag}<span class="kind-tag">{e.kindTag}</span>{/if}<span class="bubble-text">{e.text}</span>{#if e.showRetry || e.nav}<div class="bubble-tools">{#if e.showRetry}<button class="mini-btn" title="换一种不同的发展（旧版留在分支里，可用上一条 / 下一条分支切回）" onclick={retry}>↻ 重试</button>{/if}{#if e.nav}<span class="version-nav"><button class="mini-btn" title="上一条分支" aria-label="上一条分支" onclick={() => switchSib(-1)}><Icon name="chev-l" /></button><span class="version-label">{e.nav.index}/{e.nav.count}</span><button class="mini-btn" title="下一条分支" aria-label="下一条分支" onclick={() => switchSib(1)}><Icon name="chev" /></button></span>{/if}</div>{/if}</div>
{:else if e.kind === 'note'}
<div class="chat-note">{e.text}</div>
{:else if e.kind === 'image' && e.variant === 'row'}
<!-- 场景标记行：56px 缩略图 + alt（点击 = 舞台选中）；「工作台」悬停才出现 -->
<div class="bubble bubble-image">{#if e.src}<img src={e.src} alt={e.alt} title="在右侧舞台看这张" onclick={selectScene} />{/if}<div class="img-alt-row"><span class="img-alt" title="点击在右侧舞台查看" onclick={selectScene}>{e.cap}</span><button class="mini-btn" type="button" title="看 / 改完整 prompt、跟画师说着改、按此重画" onclick={openWorkbench}>工作台</button></div></div>
{:else if e.kind === 'image'}
<!-- chat / rp 内联图（v0.6.0）：图直接排在聊天流里，点开是灯箱 -->
<div class="bubble bubble-image bubble-image-inline">{#if e.src}<img src={e.src} alt={e.alt} loading="lazy" onclick={openLightbox} />{/if}<div class="img-alt" onclick={openLightbox}>{e.cap}</div></div>
{:else if e.kind === 'video'}
<!-- 视频（§8）：封面 + alt + ▶，点一下在舞台选中；无 videoId 只有外链时给降级入口 -->
<div class="bubble bubble-image">{#if e.cover}<img src={e.cover} alt={e.alt} title="在右侧舞台播放这段视频" onclick={selectScene} />{/if}<div class="img-alt-row"><span class="img-alt" title="点击在右侧舞台播放" onclick={selectScene}><Icon name="play" class="ic-l" />{e.cap}</span>{#if e.hasRemote}<button class="mini-btn" type="button" title="浏览器无法转存，链接限时有效" onclick={openRemote}>新标签页打开</button>{/if}</div></div>
{:else if e.kind === 'agent'}
<!-- 模型主动联系：样式同玩家气泡 + 「谁 / 何时 / 为何找你」标注 -->
<div class="bubble bubble-player bubble-agent"><div class="agent-note"><Icon name="spark" class="ic-l" />{e.note}</div><div>{e.text}</div></div>
{:else if e.kind === 'proposal'}
{#if e.empty}<div class="bubble proposal-card">（提案数据缺失）</div>{:else}<!-- 提案卡：参数原值文本插值（红线 4），未确认不可执行 --><div class="bubble proposal-card"><div class="proposal-title"><Icon name={e.icon} class="ic-l" />{e.title}</div><div class="proposal-args">{#each e.rows as r}<div class="proposal-row"><span class="proposal-key">{r.k}</span><span class="proposal-val">{r.v}</span></div>{/each}</div><div class="proposal-foot"><span class="proposal-status">{e.statusText}</span>{#if e.actionable}<button class="mini-btn proposal-ok" type="button" title="确认后才会真正执行（一封邮件 / 一笔扣款）" onclick={confirmProposal}>确认</button><button class="mini-btn" type="button" onclick={denyProposal}>拒绝</button>{/if}</div></div>{/if}
{/if}
