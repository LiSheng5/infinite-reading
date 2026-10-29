<script>
  /* ReadScreen.svelte —— 阶段 4 · 屏 4 阅读页五区（聊天区 / 输入区 / 选项托盘 / 舞台 / 缩略图条）
   * 任务书 §7.3：功能与交互不变，DOM 与 0.12.1 的 #game-layout 子树逐节点同结构（截图逐像素对齐）。
   *
   * 分工（同屏 3 书架的架构约定）：
   *   - 动态区（消息流 / 开场引导 / 内联选项 / 托盘 / 缩略条）→ ReadScreen 状态桥推视图模型，
   *     组件按旧 DOM 渲染；{#key chatSeq} 整体重建 = 旧 chat-scroll.innerHTML='' 语义；
   *   - 静态区（#player-input / #btn-send / 做说导演 / 灵感钮 / 舞台按钮 / 视频菜单 / 分隔条 /
   *     历史提示条 / 「＋」菜单）→ 组件只出同 id 结构，不带 handler——src/app/main.js 的 bind() 与
   *     bindSplitter() 在 Store.boot() 后按 id 原样绑定（挂载在 import 期完成），行为零改动；
   *   - 命令式逻辑照旧直接写 DOM：renderStage（换画 blur-up / fade-swap）、流式气泡 interior
   *     （span.delta，fillLiveDom 回填空壳）、syncKindSwitch、setSendButtonsBusy、
   *     updateHistoryBar、renderFeatureBar、setStageArt、#gen-status / #video-status 胶囊。
   * 安全红线（§8）：用户 / 模型产出一律文本插值；舞台图与缩略图的 url() 口径在旧代码与
   * readmodel.js（JSON.stringify 转义见书架屏），组件不拼样式串。 */
  import Icon from '../../ui/Icon.svelte';
  import ChatBubble from './ChatBubble.svelte';
  import { read } from './read.svelte.js';
  import { A as appApi } from '../../app/core.js';

  const A = () => appApi;

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
</script>

<div id="chat-pane" class="chat-pane">
  <div id="chat-scroll" class="chat-scroll">
    {#key read.chatSeq}
      {#each read.chat.entries as e}
        <ChatBubble entry={e} />
      {/each}
      {#if read.chat.openingHint}
        <div class="opening-hint">
          <p class="opening-hint-title">设定已就绪，第一幕还没开始。</p>
          <p class="hint">点下面按钮让 AI 按设定写第一幕（会调用一次模型）；也可以直接在输入框里写下你的第一个行动。</p>
          <button type="button" class="btn primary" onclick={runOpening}><Icon name="play" class="ic-l" />开始第一幕</button>
        </div>
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
    {/key}
  </div>

  <footer class="composer">
    <!-- 选项托盘：默认收起，点「灵感」才展开（P2） -->
    <div id="choice-tray" class="choice-tray" class:hidden={!read.chat.trayVisible}>
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
    <!-- 历史位置提示条（UI-4 §5）：head 不是叶子时提醒「继续发送会创建新分支」（updateHistoryBar 按 id 收口） -->
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
      <button id="btn-send" class="btn primary">发送</button>
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
    <div id="stage-empty" class="stage-empty">点 <Icon name="palette" class="ic-in" /> 为当前场景画一张</div>
    <span id="gen-status" class="pill stage-pill hidden"></span>
    <span id="video-status" class="pill stage-pill stage-pill-video hidden"></span>
    <button id="btn-video-cancel" class="mini-btn video-cancel hidden" type="button" title="只停止本地等待；云端任务可能已计费">取消等待</button>
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
        <!-- ▶ 角标画在 .thumb-wrap 上（img 的 ::after 不渲染，§8） -->
        <span class="thumb-wrap is-video">
          <img class="thumb is-video" class:active={t.active} src={t.src} alt={t.alt} title={t.title} onclick={() => selectThumb(t.id)} />
        </span>
      {:else}
        <img class="thumb" class:active={t.active} src={t.src} alt={t.alt} title={t.title} onclick={() => selectThumb(t.id)} />
      {/if}
    {/each}
  </div>
</div>
