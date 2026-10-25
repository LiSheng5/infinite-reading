<script>
  /* 阶段 1 spike（任务书 §5）：用 Svelte 5 复刻「设置 · 剧情对话模型」切片。
   * 只回答三个问题：Svelte 5 runes 在单文件产物里跑不跑得动（file://）、
   * 产物体积增量多大、真实冻结 id 能不能原样保留（settings-ids-test 的 154 个 id）。
   * 不接真实保存、不联网（铁律 §3.5）。样式只走设计令牌（tokens-test：:root 之外无颜色字面量）。 */
  let baseUrl = $state('https://api.openai.com/v1');
  let model = $state('gpt-example');
  let apiKey = $state('');
  let temp = $state(0.8);
  let testState = $state('');
  const ready = $derived(!!baseUrl.trim() && !!model.trim());

  function testConnection() {
    testState = ready
      ? '（spike 不联网：真实实现在这里显示连接结果）'
      : '先填 Base URL 与模型名';
  }
</script>

<div class="spike-slice">
  <h3>设置 · 剧情对话模型（Svelte 5 spike 切片）</h3>
  <label class="spike-field">Base URL <input id="s-chat-base" bind:value={baseUrl} /></label>
  <label class="spike-field">模型 <input id="s-chat-model" bind:value={model} /></label>
  <label class="spike-field">API Key <input id="s-chat-key" type="password" bind:value={apiKey} /></label>
  <label class="spike-field">温度 <input id="s-chat-temp" type="number" min="0" max="2" step="0.1" bind:value={temp} /></label>
  <!-- §7.2「测试连接」：按钮在左、结果文字在右，一行 -->
  <div class="spike-row">
    <button id="btn-test-chat" type="button" disabled={!ready} onclick={testConnection}>测试连接</button>
    <span id="test-chat-state">{testState}</span>
  </div>
</div>

<style>
  .spike-slice {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 90;
    width: 320px;
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--bg);
    color: var(--ink);
    font-size: 13px;
    box-shadow: var(--shadow-2);
  }
  .spike-slice h3 { margin: 0 0 10px; font-size: 13px; }
  .spike-field { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .spike-field input {
    flex: 1;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--ink);
  }
  .spike-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .spike-row button {
    padding: 6px 14px;
    border-radius: 8px;
    border: 1px solid var(--ink);
    background: var(--ink);
    color: var(--bg);
    cursor: pointer;
  }
  .spike-row button:disabled { opacity: 0.5; cursor: default; }
  .spike-row span { color: var(--ink); opacity: 0.65; }
</style>
