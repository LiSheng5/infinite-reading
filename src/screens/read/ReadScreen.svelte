<script>
 /* ReadScreen.svelte —— 阅读页五区（聊天区 / 输入区 / 选项托盘 / 舞台 / 缩略图条）
   * DOM 沿用 #game-layout 子树的 id / class；消息流改为按条目 key 增量更新，不再整条重建。
   *
   * 分工（与书架相同的架构约定）：
   *   - 动态区（消息流 / 开场引导 / 内联选项 / 托盘 / 缩略条）→ ReadScreen 状态桥推视图模型，
   *     组件按旧 DOM 渲染；消息流按条目 key 做 keyed 更新——旧气泡与内联图跨
   *     renderChat 常驻，不销毁重建（不再整条重新解码 / 重放入场动画），条目离开 log 才销毁；
   *   - 静态区（#player-input / #btn-send / 做说导演 / 灵感钮 / 舞台按钮 / 视频菜单 / 分隔条 /
   *     历史提示条 / 「＋」菜单）→ 组件只出同 id 结构，不带 handler——src/app/main.js 的 bind() 与
   *     bindSplitter() 在 Store.boot() 后按 id 原样绑定（挂载在 import 期完成），行为零改动；
   *   - 命令式逻辑照旧直接写 DOM：renderStage（换画 blur-up / fade-swap）、流式气泡 interior
   *     （span.delta，fillLiveDom 回填空壳）、syncKindSwitch、setSendButtonsBusy、
   *     updateHistoryBar、renderFeatureBar、setStageArt、#gen-status / #video-status 胶囊。
   * 安全红线：用户 / 模型产出一律文本插值；舞台图与缩略图的 url() 口径在旧代码与
   * readmodel.js（JSON.stringify 转义见书架屏），组件不拼样式串。 */
  import Icon from '../../ui/Icon.svelte';
  import ChatBubble from './ChatBubble.svelte';
  import AgentIntro from './AgentIntro.svelte';
  import PaintInk from './PaintInk.svelte';
  import { read } from './read.svelte.js';
  import { A as appApi } from '../../app/core.js';
  import { onActivate } from '../../ui/a11y.js';
  import { onMount } from 'svelte';

  const A = () => appApi;

  // 作画中的纸墨显影：队列非空（#gen-status 摘掉 hidden）且舞台还没有图（#stage-empty 未 hidden）
  // 时才挂载。两个 class 都由命令式代码直接改（painter.js / render.js），这里只观察、不反向写。
  let inkActive = $state(false);

  // 上下文用量气泡（非模态）：点按切换；键盘聚焦（:focus-visible）打开；
  // 点外面或 Esc 关闭（不进弹窗栈，不挡输入）
  let usageOpen = $state(false);
  function toggleUsage() { usageOpen = !usageOpen; }
  function focusUsage(e) {
    if (e.currentTarget.matches(':focus-visible')) usageOpen = true;
  }
  function closeUsageOnWindowClick(e) {
    if (!usageOpen) return;
    const inWrap = e.target && e.target.closest ? e.target.closest('.ctx-usage') : null;
    if (!inWrap) usageOpen = false;
  }
  function closeUsageOnEsc(e) {
    if (usageOpen && e.key === 'Escape') usageOpen = false;
  }
  // 手动压缩：点击直接执行（不弹确认，toast 里 8 秒内可撤销）；
  // 执行中 / 不可用都由按钮自己置灰（compactView），这里不重复判
  function runCompact() { A().compactNow(); }

  // 「开始第一幕」：与旧 renderOpeningHint 的按钮闭包同语义
  function runOpening() {
    const a = A();
    if (a.state.busy) { a.toast('正在生成中，等这一步结束'); return; }
    a.runOpening();
  }
  // 内联选项（choices=always）：选项文本即玩家行动
  function sendChoice(c) { A().sendPlayerAction(c, true); }
  // 托盘选项：点一下收起托盘再发出去（同旧 tray-btn 闭包）
  function pickChoice(c) {
    const a = A();
    a.state.choicesTrayOpen = false;
    a.sendPlayerAction(c, true);
  }
  // 缩略条点击 = 选中该场景（同旧 renderThumbs 的 img.onclick 闭包）
  function selectThumb(id) {
    const a = A();
    if (!a.state.story) return;
    a.state.story.lastBg = id;
    a.saveAll();
    a.renderStage();
    a.renderThumbs();
  }

  // 观察两个由命令式代码维护的 class，决定舞台空状态是「点 🎨 画一张」还是纸墨显影
  onMount(() => {
    const pill = document.getElementById('gen-status');
    const empty = document.getElementById('stage-empty');
    if (!pill || !empty) return;

    const sync = () => {
      inkActive = !pill.classList.contains('hidden') && !empty.classList.contains('hidden');
    };
    const observer = new MutationObserver(sync);
    observer.observe(pill, { attributes: true, attributeFilter: ['class'] });
    observer.observe(empty, { attributes: true, attributeFilter: ['class'] });
    sync();

    return () => observer.disconnect();
  });
</script>

<svelte:window onclick={closeUsageOnWindowClick} onkeydown={closeUsageOnEsc} />

<div id="chat-pane" class="chat-pane">
  <div id="chat-scroll" class="chat-scroll">
    {#each read.chat.entries as e (e.key)}
      <ChatBubble entry={e} />
    {/each}
    {#if read.chat.openingHint}
      <div class="opening-hint">
        <p class="opening-hint-title">设定已就绪，第一幕还没开始。</p>
        <p class="hint">点下面按钮让 AI 按设定写第一幕（会调用一次模型）；也可以直接在输入框里写下你的第一个行动。</p>
        <button type="button" class="ui-btn primary" onclick={runOpening}><Icon name="play" class="ic-l" />开始第一幕</button>
      </div>
    {/if}
    {#if read.chat.agentIntro}
      <AgentIntro chat={read.chat} />
    {/if}
    {#if read.chat.live && read.chat.liveReason}
      <!-- 流式思考窗空壳：interior 由 render.js 的 fillLiveDom 命令式回填（span 系统零改动） -->
      <div class="reason-block reason-live"></div>
    {/if}
    {#if read.chat.live}
      <!-- 流式 / 打字机正文空壳：同上，appendLiveDelta / typewrite 照旧写进来 -->
      <div class="bubble bubble-narration bubble-live"></div>
    {/if}
    {#if read.chat.choices.length}
      <div class="choices-inline">
        {#each read.chat.choices as c}
          <button type="button" class="choice-btn" onclick={() => sendChoice(c)}>{c}</button>
        {/each}
      </div>
    {/if}
  </div>

  <footer class="composer">
    <!-- 选项托盘：默认收起，点「灵感」才展开 -->
    <div id="choice-tray" class="choice-tray" class:hidden={!read.chat.trayOpen}>
      {#each read.chat.tray as c}
        <button type="button" class="tray-btn" title={c} onclick={() => pickChoice(c)}>{c}</button>
      {/each}
    </div>
    <div class="composer-tools">
      <button id="btn-inspiration" class="tool-btn" class:hidden={!read.chat.inspiration} type="button" title="看这一轮的选项"
              aria-expanded={read.chat.inspiration && read.chat.trayOpen ? 'true' : 'false'}>
        <Icon name="bulb" class="ic-l" /><span>灵感</span><span id="inspiration-count" class="badge" class:hidden={!read.chat.inspiration}>{read.chat.inspirationCount}</span>
      </button>
      <span class="composer-spacer"></span>
      <!-- 上下文用量指示器（常驻，只读）：细进度条 + 文字，点按 / 聚焦弹出说明气泡（非模态） -->
      {#if read.chat.usage}
        {@const u = read.chat.usage}
        <div class="ctx-usage">
          <button type="button" class="ctx-meter-btn" aria-expanded={usageOpen}
                  onclick={toggleUsage} onfocus={focusUsage}>
            <span class="ctx-meter" role="meter" aria-valuemin="0"
                  aria-valuemax={u.windowKnown ? u.window : Math.max(u.tokens, 1)}
                  aria-valuenow={u.tokens} aria-valuetext={u.valuetext}>
              {#if u.windowKnown}
                <!-- 阈值刻度线：位置 = 自动压缩线 / 窗口（与压缩判定同一个数，不写死比例） -->
                <span class="ctx-bar" aria-hidden="true">
                  <span class="ctx-bar-fill" class:is-warn={u.level === 'warn'} class:is-over={u.level === 'over'} style:width={u.barPct + '%'}></span>
                  <span class="ctx-bar-tick" style:left={u.tickPct + '%'}></span>
                </span>
              {/if}
              <!-- 级别不只靠颜色：warn / over 换图标 + 前缀词（近压缩线 / 将自动压缩） -->
              {#if u.level === 'warn' || u.level === 'over'}<Icon name="warn" />{/if}
              <span class="ctx-meter-text" class:is-ok={u.level === 'ok'} class:is-warn={u.level === 'warn'} class:is-over={u.level === 'over'}>{u.text}</span>
            </span>
          </button>
          {#if usageOpen}
            <div class="ctx-bubble">
              <p class="ctx-bubble-main">{u.error ? '这次估算没算出来，原因已留在浏览器控制台。' : u.detail}</p>
              {#if u.lastUsage}<p class="ctx-bubble-usage">{u.lastUsage}</p>{/if}
              {#if !u.error}<p class="ctx-bubble-note">估算值不含你还没输入的那一句，与实际发送略有偏差。</p>{/if}
              <!-- 分层明细（点开气泡才看）：各层 token 之和等于上面的整体估算；拿不到 trace 就不显示 -->
              {#if !u.error && u.layers && u.layers.length}
                <div class="ctx-layers" role="group" aria-label="上下文分层明细">
                  <p class="ctx-layers-title">分层明细（估算）</p>
                  {#each u.layers as l (l.key)}
                    <div class="ctx-layer">
                      <span class="ctx-layer-label">{l.label}</span>
                      <span class="ctx-layer-track" aria-hidden="true"><span class="ctx-layer-fill" style:width={l.pct + '%'}></span></span>
                      <span class="ctx-layer-num">{l.tokens}</span>
                    </div>
                  {/each}
                </div>
              {/if}
              <!-- 手动压缩按钮：路径随书记员可用性标注；不可用置灰并在下方写明原因 -->
              {#if read.chat.compact}
                {@const c = read.chat.compact}
                <div class="ctx-bubble-foot">
                  <button type="button" class="ui-btn ctx-compact-btn" disabled={c.disabled} onclick={runCompact}>
                    {#if c.running}压缩中…{:else}压缩较早的对话（{c.scribe ? '书记员' : '本地摘要，质量较低'}）{/if}
                  </button>
                  {#if c.disabled && !c.running && c.reason}<p class="ctx-bubble-reason">{c.reason}</p>{/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
      <!-- 本地服务功能入口：只在「对话 / 扮演」模式出现；未启动时灰显并说明（renderFeatureBar 按 id 收口） -->
      <div class="menu-wrap">
        <button id="btn-more-actions" class="tool-btn hidden" type="button" title="更多功能"
                aria-label="更多功能" aria-haspopup="menu" aria-expanded="false"><Icon name="plus" /></button>
        <div id="feature-menu" class="menu menu-up hidden" role="menu">
          <button id="btn-feat-email" class="menu-item" type="button" role="menuitem"><Icon name="mail" class="ic-l" />写邮件</button>
          <button id="btn-feat-schedule" class="menu-item" type="button" role="menuitem"><Icon name="clock" class="ic-l" />定时主动</button>
          <button id="btn-feat-payment" class="menu-item" type="button" role="menuitem"><Icon name="cart" class="ic-l" />代下单</button>
          <p id="feature-bar-state" class="menu-note"></p>
        </div>
      </div>
    </div>
    <!-- 历史位置提示条：head 不是叶子时提醒「继续发送会创建新分支」（updateHistoryBar 按 id 收口） -->
    <div id="history-bar" class="history-bar hidden" role="status" aria-live="polite">
      <span id="history-bar-text"></span>
      <button id="btn-history-latest" class="history-jump" type="button">回到最新</button>
    </div>
    <div class="input-row">
      <div id="kind-switch" class="seg" role="group" aria-label="输入类型">
        <button class="seg-btn active" data-kind="do" type="button" title="做：你的行动">做</button>
        <button class="seg-btn" data-kind="say" type="button" title="说：你说的话">说</button>
        <button class="seg-btn" data-kind="direct" type="button" title="导演：世界里的既成事实">导演</button>
      </div>
      <input id="player-input" placeholder="做点什么，或说句话……" autocomplete="off">
      <button id="btn-send" class="ui-btn primary">发送</button>
    </div>
  </footer>
</div>

<div id="splitter" class="splitter" title="拖动调整文字 / 画面比例；双击恢复 1:1"></div>

<div id="image-pane" class="image-pane">
  <div id="stage-wrap" class="stage-wrap">
    <!-- 底层：当前图的模糊放大副本；上层：完整的图（contain）+ 暗角 -->
    <div id="stage-backdrop" class="stage-backdrop" aria-hidden="true"></div>
    <img id="stage-img" class="stage-img hidden" alt="">
    <video id="stage-video" class="stage-video hidden" controls playsinline loop muted></video>
    <div id="stage-empty" class="stage-empty" class:is-painting={inkActive}>
      {#if inkActive}
        <PaintInk />
      {:else}
        点 <Icon name="palette" class="ic-in" /> 为当前场景画一张
      {/if}
    </div>
    <span id="gen-status" class="pill stage-pill hidden"></span>
    <span id="video-status" class="pill stage-pill stage-pill-video hidden"></span>
    <button id="btn-video-cancel" class="ui-btn mini video-cancel hidden" type="button" title="只停止本地等待；云端任务可能已计费">取消等待</button>
    <div class="stage-actions">
      <button id="btn-stage-painter" class="stage-btn" title="画师工作台（看 / 改这张图的提示词）" aria-label="画师工作台"><Icon name="pencil" /></button>
      <button id="btn-stage-gen" class="stage-btn" title="为当前场景补一张" aria-label="为当前场景作画"><Icon name="palette" /></button>
      <div class="menu-wrap">
        <button id="btn-stage-video" class="stage-btn" title="把当前画面做成视频（MiniMax · 会按秒计费）" aria-label="生成视频" aria-haspopup="menu" aria-expanded="false"><Icon name="film" /></button>
        <div id="video-menu" class="menu hidden" role="menu">
          <button id="btn-video-i2v" class="menu-item" type="button" role="menuitem">以当前图生成视频</button>
          <button id="btn-video-t2v" class="menu-item" type="button" role="menuitem">按剧情文生视频</button>
        </div>
      </div>
      <button id="btn-immersive" class="stage-btn" title="沉浸（画面铺满）" aria-label="沉浸"><Icon name="expand" /></button>
    </div>
    <button id="btn-immersive-exit" class="stage-exit hidden" type="button" title="退出沉浸（Esc）" aria-label="退出沉浸"><Icon name="x" /></button>
  </div>
  <p id="stage-caption" class="stage-caption"></p>
  <div id="thumb-strip" class="thumb-strip">
    {#if read.thumbsEmpty}
      <div class="thumb-empty">作画后，这里按时间排开每一幕</div>
    {/if}
    {#each read.thumbs as t (t.id)}
      {#if t.isVideo}
        <!-- ▶ 角标画在 .thumb-wrap 上（img 的 ::after 不渲染） -->
        <span class="thumb-wrap is-video">
          <img class="thumb is-video" class:active={t.active} src={t.src} alt={t.alt} title={t.title} role="button" tabindex="0" onclick={() => selectThumb(t.id)} onkeydown={onActivate(() => selectThumb(t.id))} />
        </span>
      {:else}
        <img class="thumb" class:active={t.active} src={t.src} alt={t.alt} title={t.title} role="button" tabindex="0" onclick={() => selectThumb(t.id)} onkeydown={onActivate(() => selectThumb(t.id))} />
      {/if}
    {/each}
  </div>
</div>
