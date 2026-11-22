<script>
 /* ConnectWizardModal.svelte —— #modal-connect「接入主对话模型」向导
   * 行为在 src/app/connect.js（按 id 读写，与其余弹窗同一套约定）；这里只产标记：
   * 四步骨架（选接入方式 → 填 Key → 选模型 → 测试连接）+ 三选一卡片。
   * 既定口径写死在标记里：
   *   · 预设只带 Base URL 与厂商名，**永不带模型名**（模型名只来自 GET /models 或手填）；
   *   · 聚合模式的完整知情警示只写一处（选聚合商的面板里，谁中转 / 过什么内容 / 链路怎么走），
   *     父卡片只留一句简版——选它 = 接受对话正文与 API Key 经第三方转发；
   *   · 页脚层级：主按钮（下一步 / 完成并进入使用）最显眼、「上一步」次要、
   *     「跳过」是纯文字链接在最左；关闭走 dismissModal，由 connect.js 先确认再丢内容。 */
  import Card from '../../ui/ModalCard.svelte';
  import Field from '../../ui/Field.svelte';
  import TextInput from '../../ui/TextInput.svelte';
  import Button from '../../ui/Button.svelte';
  import { dismissModal } from '../../ui/modalHost.js';
  import { BASE_URL_OPTIONS, AGGREGATORS } from '../settings/settingsForm.js';

  const close = () => dismissModal('modal-connect');

  // 厂商速选按「国内 / 国外 / 本地」分组（标签前缀即分组）：显示厂商名 + 地址
  const groupOf = (label) => (/^国内/.test(label) ? '国内' : /^国外/.test(label) ? '国外' : '本地');
  const vendorName = (label) => label.replace(/^[^·]*·\s*/, '');
  const GROUPS = ['国内', '国外', '本地'].map(g => ({
    g, items: BASE_URL_OPTIONS.filter(o => groupOf(o[1]) === g),
  }));
</script>

{#snippet foot()}
  <Button id="cw-skip-form" variant="ghost" class="cw-skip">跳过，直接在设置里填写</Button>
  <Button id="cw-back" variant="ghost" class="cw-foot-btn">上一步</Button>
  <Button id="cw-next" variant="primary" class="cw-foot-btn">下一步</Button>
{/snippet}

<Card title="接入主对话模型" closeId="btn-close-connect" onclose={close} footer={foot}>
  <!-- ================= 第一步 · 三选一 ================= -->
  <section id="cw-step-1">
    <p class="cw-step-title">第一步 · 选接入方式</p>
    <div class="mode-cards">
      <button type="button" class="mode-card cw-pick" id="cw-card-preset" data-mode="preset">
        <b>厂商直连 · 厂商预设</b>
        <span>从常见服务商里选一个，只自动填接口地址（Base URL）；模型名下一步自动拉取或手填。</span>
      </button>
      <button type="button" class="mode-card cw-pick" id="cw-card-custom" data-mode="custom">
        <b>厂商直连 · 自定义 Base URL</b>
        <span>手填任意 OpenAI 兼容接口地址（通常以 /v1 结尾）。</span>
      </button>
      <button type="button" class="mode-card cw-pick" id="cw-card-agg" data-mode="aggregate">
        <b>聚合模式（可选）</b>
        <span>走现成的第三方聚合商（OpenRouter / 硅基流动）中转，不是自建网关。</span>
        <span class="cw-warn">知情警示：你的对话内容与 API Key 会先经过聚合商服务器再转发到模型厂商；展开选择面板后有完整说明。</span>
      </button>
    </div>

    <!-- 厂商预设：点一家只填 Base URL（模型名一个不带），再点「下一步」继续 -->
    <div id="cw-preset-wrap" class="hidden">
      <p class="hint">点一家就填好接口地址，然后点「下一步」（模型名不预填）：</p>
      {#each GROUPS as grp}
        <p class="cw-group-title">{grp.g}</p>
        <div class="cw-vendor-list">
          {#each grp.items as opt}
            <button type="button" class="cw-vendor" data-base={opt[0]}>
              <b>{vendorName(opt[1])}</b>
              <span class="cw-vendor-url">{opt[0]}</span>
            </button>
          {/each}
        </div>
      {/each}
    </div>

    <!-- 自定义 Base URL -->
    <div id="cw-custom-wrap" class="hidden">
      <Field label="Base URL" for="cw-custom-base" hint="通常以 /v1 结尾。浏览器直接打开看到 404 是正常的——那是接口地址，不是网页。">
        <TextInput id="cw-custom-base" placeholder="https://…/v1" />
      </Field>
    </div>

    <!-- 聚合模式：选聚合商（地址来自聚合商预设）；完整知情警示只写这一处 -->
    <div id="cw-agg-wrap" class="hidden">
      <p class="hint">选一家聚合商（之后同样走 Key + 模型列表流程）：</p>
      <p class="cw-warn" id="cw-agg-warn">完整知情警示：走现成的第三方聚合商中转，不是自建网关。谁运营中转——你选的那家聚合商；经过什么内容——你的对话正文与 API Key；链路：浏览器 → 该第三方聚合商 → 模型厂商。仅在你接受这一点时使用；不想经过第三方，请返回改选厂商直连。</p>
      <div class="mode-cards">
        {#each AGGREGATORS as agg}
          <button type="button" class="mode-card cw-agg-pick" data-base={agg.baseUrl} data-via={agg.via}>
            <b>{agg.via}</b>
            <span class="cw-vendor-url">{agg.baseUrl}</span>
          </button>
        {/each}
      </div>
    </div>
    <p class="hint" id="cw-step1-hint"></p>
  </section>

  <!-- ================= 第二步 · 填 API Key ================= -->
  <section id="cw-step-2" class="hidden">
    <p class="cw-step-title">第二步 · 填 API Key</p>
    <Field label="API Key" for="cw-key">
      <TextInput id="cw-key" type="password" placeholder="sk-…" autocomplete="off" />
    </Field>
    <p class="hint">Key 只保存在浏览器本地，请求由浏览器发往你选的服务商（聚合模式会先经过聚合商服务器，见第一步的知情警示）。本地模型（Ollama / LM Studio / vLLM）通常不用 Key，留空即可。</p>
    <!-- 「去 xxx 获取 Key」：只在厂商的密钥页被官方文档核实过时才出现（清单在 settingsForm.js 的 VENDOR_KEY_URLS），
         地址层在 connect.js 的 renderEcho 里按当前 Base URL 填；本地 / 自定义地址不显示 -->
    <p class="hint hidden" id="cw-key-link-wrap"><a id="cw-key-link" target="_blank" rel="noopener noreferrer">获取 API Key</a></p>
    <p class="hint" id="cw-key-note"></p>
    <p class="hint" id="cw-base-echo"></p>
  </section>

  <!-- ================= 第三步 · 选模型 ================= -->
  <section id="cw-step-3" class="hidden">
    <p class="cw-step-title">第三步 · 选模型</p>
    <datalist id="cw-dl-model"></datalist>
    <Field label="模型" for="cw-model" hint="不预置任何模型名：列表来自你所选服务商的 /models 接口，拉不到就手填，不影响流程。">
      <TextInput id="cw-model" list="cw-dl-model" placeholder="点输入框从列表选，或手填模型名" />
    </Field>
    <!-- 拼写提示：列表拉到了才可能亮（modelLists.js 的 checkModelSpelling），不拦「下一步」 -->
    <p class="hint warn hidden" id="cw-model-spell"></p>
    <div class="row-inline">
      <Button id="cw-model-reload">重新拉取模型列表</Button>
      <p class="hint" id="cw-model-hint"></p>
    </div>
  </section>

  <!-- ================= 第四步 · 测试连接 ================= -->
  <section id="cw-step-4" class="hidden">
    <p class="cw-step-title">第四步 · 测试连接</p>
    <p class="hint" id="cw-summary"></p>
    <p class="hint cw-warn hidden" id="cw-agg-echo"></p>
    <div class="test-row">
      <Button id="cw-test-btn">测试连接</Button>
      <span class="hint test-state" id="cw-test-state">只读探测：不生成内容，不花钱。</span>
    </div>
  </section>
</Card>

<style>
  .cw-step-title {
    font-family: var(--font-note);
    font-size: 13.5px;
    color: var(--accent);
    letter-spacing: .08em;
    margin: 2px 0 10px;
  }
  .cw-group-title {
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--ink-dim);
    letter-spacing: .08em;
    margin: 12px 0 6px;
  }
  .cw-vendor-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px;
  }
  .cw-vendor {
    text-align: left;
    padding: 9px 12px;
    border: 1px solid var(--btn-line);
    border-radius: var(--radius);
    background: transparent;
    color: var(--btn-ink);
    cursor: pointer;
    font-family: var(--font-ui);
    transition: border-color var(--m-t-color-base) var(--ease-out), background-color var(--m-t-color-base) var(--ease-out);
  }
  .cw-vendor b { display: block; font-weight: 500; font-size: 13.5px; color: var(--ink); }
  .cw-vendor-url {
    display: block; margin-top: 3px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-faint);
    overflow-wrap: anywhere;
  }
  .cw-vendor:hover { border-color: var(--accent-line); background: var(--accent-soft); }
  /* 选中态（cw-sel 由界面层按点击加，写 :global 免得编译器判「未使用」） */
  .cw-vendor:global(.cw-sel) { border-color: var(--accent-line); background: var(--accent-soft); }
  .cw-pick:global(.cw-sel) { border-color: var(--accent-line); background: var(--accent-soft); }
  .cw-pick:global(.cw-sel) b { color: var(--accent); }
  /* 聚合模式知情警示：琥珀色、跟着卡片走（完整版只写一处：选聚合商的面板） */
  .cw-warn {
    color: var(--warn);
    background: var(--warn-soft);
    border-left: 3px solid var(--warn-line);
    padding: 6px 10px;
    border-radius: 6px;
  }
  .mode-card .cw-warn { margin-top: 6px; }
  /* 页脚层级：「跳过」降为纯文字链接、钉在最左（margin-right:auto 推开右边的按钮组）；
     三个操作都不换行，窄屏一行放得下。
     选择器要 :global：类名挂在 Button 组件渲染的根按钮上，父组件的 scoped hash 到不了那里
     （cw- 前缀是本向导专用，不会串到别的按钮） */
  :global(button.cw-skip) {
    margin-right: auto;
    padding: 0 4px;
    border: 0;
    background: none;
    color: var(--ink-dim);
    font-family: var(--font-ui);
    font-size: 13px;
    letter-spacing: 0;
    text-decoration: underline;
    text-underline-offset: 3px;
    white-space: nowrap;
  }
  :global(button.cw-skip:hover) { background: none; color: var(--accent); }
  :global(button.cw-foot-btn) { white-space: nowrap; }
</style>
