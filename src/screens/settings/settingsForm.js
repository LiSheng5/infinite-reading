/*
 * src/screens/settings/settingsForm.js —— 设置屏的字段配置真源（任务书 §7.2）
 *
 * 一份字段配置（id / 标签 / 类型 / 所属分组 / 是否高级 / 自动展开规则）生成整块设置界面，
 * 取代 0.12.1 靠 legend 文字正则归类（js/app/prefsui.js 的 GROUP_BY_LEGEND）的做法。
 * 界面 DOM 由 SettingsScreen.svelte + Node.svelte 照这份配置渲染；行为仍在 js/app/*
 *（按 id 取元素：syncSettingsToForm / applyFormToSettings / syncAdvPanels …），id 一个不改。
 *
 * 节点类型（Node.svelte 按 k 分支渲染）：
 *   grid2 / row        —— 两列栅格 / 行内一排（row 可带 cls，如 danger-row）
 *   field              —— <label>文本<input|textarea></label>（type: text/password/number/textarea）；
 *                          label 省略 = 光杆控件；wrapId = 外层 <label> 带 id（能力位显隐用）
 *   select             —— <label>文本<select>…</select></label>（options 可空：由能力位逻辑回填）
 *   check              —— <label class="check"><input type="checkbox"> 文本<span class="check-sub">…</span></label>
 *   text / box         —— <p>（可带 id，界面层回填）/ <div>（界面层回填的容器）
 *   btn / test         —— 按钮 / 「测试连接」一行（按钮在左、结果文字在右）
 *   adv / help         —— 折叠块「高级参数 / 单独配置 / 详细设置」（data-auto 自动展开规则 + 状态标签）
 *                          /「填写说明」长说明
 *   details / datalist / inline-num / nodes —— 通用 details、datalist、行内数字（每 N 回合…）、裸节点列表
 *
 * 文案里允许 <b> <code> <br> 三种行内标记（Inline.svelte 解析）；用户 / 模型内容永不进这里。
 */

// —— Base URL 下拉（dl-base-url）：常见服务商速选；不内置模型名（§7.2：省得跟着厂商变动维护）——
export const BASE_URL_OPTIONS = [
  ['https://open.bigmodel.cn/api/paas/v4', '国内 · 智谱 GLM（BigModel，对话 + CogView 生图）'],
  ['https://dashscope.aliyuncs.com/compatible-mode/v1', '国内 · 阿里云百炼 · 通义千问（OpenAI 兼容）'],
  ['https://api.deepseek.com/v1', '国内 · DeepSeek（仅对话）'],
  ['https://ark.cn-beijing.volces.com/api/v3', '国内 · 火山方舟 · 豆包'],
  ['https://api.moonshot.cn/v1', '国内 · 月之暗面 Kimi'],
  ['https://api.siliconflow.cn/v1', '国内 · 硅基流动 SiliconFlow（对话 + 生图）'],
  ['https://api.hunyuan.cloud.tencent.com/v1', '国内 · 腾讯混元'],
  ['https://api.minimaxi.com', '国内 · MiniMax（生图 image-01 / image-01-live）'],
  ['https://api.minimax.io', '国外 · MiniMax（生图 image-01 / image-01-live）'],
  ['http://127.0.0.1:4320', '本地转发 · tools/video-proxy.mjs（仅 MiniMax 生图 / 生视频的 CORS 绕行）'],
  ['https://qianfan.baidubce.com/v2', '国内 · 百度千帆'],
  ['https://api.stepfun.com/v1', '国内 · 阶跃星辰 StepFun'],
  ['https://api.lingyiwanwu.com/v1', '国内 · 零一万物'],
  ['https://api.openai.com/v1', '国外 · OpenAI（对话 + gpt-image 生图）'],
  ['https://generativelanguage.googleapis.com/v1beta/openai/', '国外 · Google Gemini（OpenAI 兼容）'],
  ['https://api.x.ai/v1', '国外 · xAI Grok'],
  ['https://api.mistral.ai/v1', '国外 · Mistral'],
  ['https://api.groq.com/openai/v1', '国外 · Groq'],
  ['https://openrouter.ai/api/v1', '国外 · OpenRouter（聚合多家）'],
  ['https://api.together.xyz/v1', '国外 · Together AI'],
  ['https://api.fireworks.ai/inference/v1', '国外 · Fireworks'],
  ['http://localhost:11434/v1', '本地 · Ollama'],
  ['http://localhost:1234/v1', '本地 · LM Studio'],
  ['http://localhost:8000/v1', '本地 · vLLM / 其他本地 OpenAI 服务'],
];

export const VIDEO_BASE_OPTIONS = [
  ['http://127.0.0.1:4320', '本地转发 · tools/video-proxy.mjs（CORS 绕行）'],
  ['https://api.minimaxi.com', '国内 · MiniMax（生视频 · V2）'],
  ['https://api.minimax.io', '国外 · MiniMax（生视频 · V2）'],
];

// —— 「测试连接」一行：按钮在左、结果文字在右（§7.2）。
// id 以 id: '…' 字面量键值出现（不拼接）：eval/settings-ids-test.js 静态扫描这份配置的 id 真源，任一侧缺 id 即红。
const testRow = (ids, hint) => ({
  k: 'test', ...ids, text: '测试连接', icon: 'bolt', hint,
});

/* ================= 分组 → 分块 → 字段 ================= */

export const GROUPS = [
  {
    id: 'g-models', title: '模型',
    blocks: [
      {
        legend: '剧情对话模型',
        sub: '旁白与角色都由它来写，新对话默认用它。任何兼容 OpenAI 格式的接口都能接（云端 / 本地）。',
        nodes: [
          { k: 'grid2', items: [
            { k: 'field', id: 's-chat-base', label: '接口地址 Base URL', type: 'text', list: 'dl-base-url', placeholder: 'https://…（可从下拉选服务商）' },
            { k: 'field', id: 's-chat-model', label: '模型', type: 'text', placeholder: '填你的模型名' },
          ] },
          { k: 'field', id: 's-chat-key', label: 'API Key', type: 'password', placeholder: 'sk-…' },
          testRow({ id: 'btn-test-chat', stateId: 'test-chat-state' }, '只探测，不生成内容。'),
          {
            k: 'adv', title: '高级参数', nodes: [
              { k: 'grid2', items: [
                { k: 'field', id: 's-chat-temp', label: '温度（0~2，越高越发散）', type: 'number', attrs: { step: '0.1', min: '0', max: '2' } },
                { k: 'select', id: 's-chat-thinking', wrapId: 'wrap-chat-thinking', wrapHidden: true, label: '思考档位', options: [] },
              ] },
              { k: 'field', id: 's-chat-ctx', label: '上下文窗口（token，压缩阈值按它算）', type: 'number', attrs: { min: '0', step: '1000' }, placeholder: '不知道就留空（回退按条数压缩）' },
              { k: 'field', id: 's-chat-params', label: '自定义请求参数（key=value，逗号分隔，并入请求体）', type: 'text', placeholder: 'reasoning_effort=high, top_p=0.95' },
              { k: 'text', id: 's-chat-cap', cls: 'hint' },
            ],
          },
          {
            k: 'help', title: '填写说明', nodes: [
              { k: 'text', text: 'Base URL 通常以 /v1 结尾，点输入框会列出常见服务商；模型名去服务商控制台的「模型广场 / 文档」复制，注意大小写。不内置模型名，省得跟着厂商变动一直维护。' },
              { k: 'text', text: 'API Key 只保存在你浏览器本地，不会上传到别处。' },
            ],
          },
        ],
      },
      {
        id: 'fs-profiles', legend: '模型库',
        sub: '存几套备用的主模型，每个对话可在「本对话设置」里单独选；不选就用上面的默认模型。对话存档与导出只记引用名，<b>绝不带 Key 与接口地址</b>。',
        nodes: [
          { k: 'box', id: 'mp-list', cls: 'mono-list' },
          { k: 'row', items: [
            { k: 'btn', id: 'mp-add', text: '新增模型', icon: 'plus', cls: 'btn' },
            { k: 'text', id: 'mp-state', cls: 'hint' },
          ] },
          { k: 'box', id: 'mp-editor', cls: 'panel-block hidden', nodes: [
            { k: 'text', id: 'mp-title', cls: 'hint mp-title' },
            { k: 'grid2', items: [
              { k: 'field', id: 'mp-name', label: '名称（自己认得出就行）', type: 'text', placeholder: '例如：便宜的 / 聪明的' },
              { k: 'field', id: 'mp-model', label: '模型', type: 'text', placeholder: '填你的模型名' },
            ] },
            { k: 'field', id: 'mp-base', label: '接口地址 Base URL', type: 'text', list: 'dl-base-url', placeholder: 'https://…（留空 = 沿用默认主模型）' },
            { k: 'field', id: 'mp-key', label: 'API Key', type: 'password', placeholder: '留空 = 沿用默认主模型；已保存的 Key 不回显' },
            { k: 'text', id: 'mp-key-state', cls: 'hint' },
            { k: 'check', id: 'mp-copy-key', wrapId: 'mp-copy-key-wrap', wrapCls: 'hidden', checked: true, text: '复制时带上原模型的 API Key（不勾 = 只复制其它字段）' },
            {
              k: 'adv', title: '高级参数', nodes: [
                { k: 'grid2', items: [
                  { k: 'field', id: 'mp-temp', label: '温度（0~2）', type: 'number', attrs: { step: '0.1', min: '0', max: '2' }, placeholder: '0.9' },
                  { k: 'field', id: 'mp-thinking', label: '思考档位', type: 'text', placeholder: 'default（不下发）' },
                ] },
                { k: 'field', id: 'mp-ctx', label: '上下文窗口（token，0 = 未填）', type: 'number', attrs: { min: '0', step: '1000' }, placeholder: '不知道就留空' },
                { k: 'field', id: 'mp-params', label: '自定义请求参数（key=value，逗号分隔）', type: 'text', placeholder: 'reasoning_effort=high, top_p=0.95' },
              ],
            },
            { k: 'row', items: [
              { k: 'btn', id: 'mp-save', text: '保存这个模型', cls: 'btn primary' },
              { k: 'btn', id: 'mp-cancel', text: '取消', cls: 'btn ghost' },
            ] },
          ] },
        ],
      },
    ],
  },

  {
    id: 'g-subs', title: '辅助模型',
    blocks: [
      {
        legend: '画师子代理',
        sub: '把剧情写成绘画提示词。推荐填最便宜的模型；留空沿用剧情对话模型。每张图下方的「工作台」可查看 / 修改完整提示词。',
        nodes: [
          {
            k: 'adv', title: '单独配置', auto: 'filled', tagOff: '沿用剧情模型', tagOn: '已单独配置', nodes: [
              { k: 'grid2', items: [
                { k: 'field', id: 's-painter-base', label: '接口地址 Base URL', type: 'text', list: 'dl-base-url', placeholder: '留空 = 沿用剧情模型' },
                { k: 'field', id: 's-painter-model', label: '模型', type: 'text', placeholder: '留空 = 沿用剧情模型' },
              ] },
              { k: 'field', id: 's-painter-key', label: 'API Key', type: 'password', placeholder: '留空 = 沿用剧情模型' },
              testRow({ id: 'btn-test-painter', stateId: 'test-painter-state' }, '留空项按「沿用剧情模型」代入后再测。'),
            ],
          },
        ],
      },
      {
        legend: '书记员',
        sub: '校对世界卡、压缩摘要、提取画像。校对是便宜活，推荐填便宜的模型；留空沿用剧情对话模型。',
        nodes: [
          { k: 'check', id: 's-scribe-enabled', checked: true, text: '启用书记员' },
          { k: 'check', id: 's-scribe-ai', checked: true, text: '兼任「压缩摘要 + 滚动风格摘要」', sub: '调用失败时自动走本地规则，不花 API' },
          { k: 'inline-num', id: 's-scribe-every', before: '每', after: '回合校对一次', attrs: { type: 'number', min: '1', max: '100', value: '10' } },
          {
            k: 'adv', title: '单独配置', auto: 'filled', tagOff: '沿用剧情模型', tagOn: '已单独配置', nodes: [
              { k: 'grid2', items: [
                { k: 'field', id: 's-scribe-base', label: '接口地址 Base URL', type: 'text', list: 'dl-base-url', placeholder: '留空 = 沿用剧情模型' },
                { k: 'field', id: 's-scribe-model', label: '模型', type: 'text', placeholder: '留空 = 沿用剧情模型' },
              ] },
              { k: 'field', id: 's-scribe-key', label: 'API Key', type: 'password', placeholder: '留空 = 沿用剧情模型' },
              testRow({ id: 'btn-test-scribe', stateId: 'test-scribe-state' }, '留空项按「沿用剧情模型」代入后再测。'),
            ],
          },
        ],
      },
      {
        legend: '起草模型',
        sub: '开局向导里「一句话让 AI 起草」用它。起草需要创造力，推荐直接跟随剧情对话模型。',
        nodes: [
          {
            k: 'adv', title: '单独配置', auto: 'filled', tagOff: '沿用剧情模型', tagOn: '已单独配置', nodes: [
              { k: 'grid2', items: [
                { k: 'field', id: 's-draft-base', label: '接口地址 Base URL', type: 'text', list: 'dl-base-url', placeholder: '留空 = 沿用剧情模型' },
                { k: 'field', id: 's-draft-model', label: '模型', type: 'text', placeholder: '留空 = 沿用剧情模型' },
              ] },
              { k: 'field', id: 's-draft-key', label: 'API Key', type: 'password', placeholder: '留空 = 沿用剧情模型' },
              testRow({ id: 'btn-test-draft', stateId: 'test-draft-state' }, '留空项按「沿用剧情模型」代入后再测。'),
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'g-image', title: '生图与画风',
    blocks: [
      {
        legend: '生图模型',
        sub: '为每一幕作画。可以和对话不是同一家（有些服务商只做对话，就再配一家）。',
        nodes: [
          { k: 'select', id: 's-image-provider', label: '生图适配器', options: [
            ['openai-images', 'OpenAI 兼容（自动拼 /images/generations）'],
            ['minimax-image', 'MiniMax 原生（/v1/image_generation）'],
          ] },
          { k: 'grid2', items: [
            { k: 'field', id: 's-image-base', label: '接口地址 Base URL', type: 'text', list: 'dl-base-url', placeholder: 'https://…（可从下拉选）' },
            { k: 'field', id: 's-image-model', label: '模型', type: 'text', placeholder: '填你的生图模型名' },
          ] },
          { k: 'field', id: 's-image-key', label: 'API Key', type: 'password', placeholder: 'sk-…' },
          { k: 'grid2', items: [
            { k: 'select', id: 's-image-aspect', wrapId: 'wrap-image-aspect', label: '比例', options: [
              ['16:9', '16:9 横屏'], ['9:16', '9:16 竖屏'], ['1:1', '1:1 方形'], ['custom', '自定义'],
            ] },
            { k: 'select', id: 's-image-size', wrapId: 'wrap-image-size', wrapHidden: true, label: '尺寸（该模型支持的档位）', options: [] },
            { k: 'select', id: 's-image-quality', wrapId: 'wrap-image-quality', wrapHidden: true, label: '质量', options: [] },
          ] },
          { k: 'grid2', id: 'row-image-wh', items: [
            { k: 'field', id: 's-image-width', label: '宽', type: 'number', attrs: { min: '64', step: '16' }, placeholder: '1280' },
            { k: 'field', id: 's-image-height', label: '高', type: 'number', attrs: { min: '64', step: '16' }, placeholder: '720' },
          ] },
          testRow({ id: 'btn-test-image', stateId: 'test-image-state' }, '只探测地址是否可达，不真的出图，所以不花钱。'),
          {
            k: 'adv', title: '高级', nodes: [
              { k: 'select', id: 's-image-ref', label: '参考图（一致性）', options: [
                ['off', '关闭（纯文生图）'], ['prev', '用上一张图（人物 / 画风更连贯）'],
              ] },
              { k: 'field', id: 's-image-params', label: '自定义请求参数（key=value，逗号分隔）', type: 'text', placeholder: 'steps=30, negative_prompt=blurry' },
            ],
          },
          {
            k: 'help', title: '填写说明', nodes: [
              { k: 'text', id: 'hint-image-openai', cls: 'hint', text: '下拉里带「生图」标注的服务商可直接选，地址会自动拼上 /images/generations。尺寸用「比例 + 宽高」自己定（比例选「自定义」即可手填）；不确定的项留空，会走通用默认。画师工作台里也能改尺寸。' },
              { k: 'text', id: 'hint-image-minimax', cls: 'hint hidden', text: 'MiniMax 原生接口：地址填 https://api.minimaxi.com（国内）或 https://api.minimax.io（国外），带不带 /v1 都行；模型填 image-01 或 image-01-live。MiniMax 不给浏览器跨域，直连被拦时先跑 <code>node tools/video-proxy.mjs</code>，地址改填 http://127.0.0.1:4320。<br>尺寸：image-01-live 只认比例，自定义宽高只对 image-01 生效（512–2048 且 8 的倍数）。画风只对 live 生效，写进「自定义请求参数」：style.style_type=漫画（漫画 / 元气 / 中世纪 / 水彩）+ style.style_weight=0.8（0–1）。想更稳再加 seed=12345。' },
              { k: 'text', text: '参考图：开启后每次作画会把「上一张图」缩到长边 1024 的 JPEG，作为 subject_reference 交给接口，人物长相 / 服饰 / 画风更连贯，代价是构图更接近上一张。目前只有 MiniMax 原生适配器支持；第一次作画自动跳过。image-01-live 是否接受要实测，被拒会报 2013，改回「关闭」即可。' },
            ],
          },
        ],
      },
      {
        legend: '生视频模型',
        sub: 'MiniMax 生视频（V2）。视频是异步任务，通常 1~3 分钟出结果，<b>按秒计费</b>。',
        nodes: [
          { k: 'datalist', id: 'dl-video-base', options: VIDEO_BASE_OPTIONS },
          { k: 'grid2', items: [
            { k: 'field', id: 's-video-base', label: '接口地址 Base URL', type: 'text', list: 'dl-video-base', placeholder: 'https://api.minimaxi.com 或 https://api.minimax.io' },
            { k: 'field', id: 's-video-model', label: '模型', type: 'text', placeholder: '填你的生视频模型名' },
          ] },
          { k: 'field', id: 's-video-key', label: 'API Key', type: 'password', placeholder: 'sk-…' },
          { k: 'grid2', items: [
            { k: 'field', id: 's-video-duration', label: '时长（秒）', type: 'number', attrs: { min: '4', max: '15', step: '1', value: '5' } },
            { k: 'select', id: 's-video-resolution', label: '分辨率', options: [
              ['480P', '480P（最快）'], ['768P', '768P'], ['1080P', '1080P'], ['2K', '2K'],
            ] },
          ] },
          { k: 'select', id: 's-video-ratio', label: '画面比例（图生视频无效：画幅由首帧决定）', options: [
            ['16:9', '16:9 横屏'], ['9:16', '9:16 竖屏'], ['1:1', '1:1 方形'], ['4:3', '4:3'], ['3:4', '3:4'], ['21:9', '21:9'],
          ] },
          testRow({ id: 'btn-test-video', stateId: 'test-video-state' }, '只读探测：不提交任务，所以不花钱。'),
          {
            k: 'adv', title: '高级', nodes: [
              { k: 'field', id: 's-video-params', label: '自定义请求参数（key=value，逗号分隔；同名 key 以它为准）', type: 'text', placeholder: 'mode=std, watermark=false' },
            ],
          },
          {
            k: 'help', title: '填写说明', nodes: [
              { k: 'text', text: 'Base URL 填 <code>https://api.minimaxi.com</code>（国内）或 <code>https://api.minimax.io</code>（海外），模型名举例 <code>MiniMax-H3</code> / <code>MiniMax-H3-Max</code>。这两个是<b>接口地址、不是网站</b>，浏览器直接打开看到 404 是正常的；拿 Key 请去网页控制台 <code>platform.minimaxi.com</code>（国内）/ <code>platform.minimax.io</code>（海外）。' },
              { k: 'text', text: '剧情模式舞台右上角的胶片按钮触发生成。浏览器直连被 CORS 拦时，先起本地转发 <code>node tools/video-proxy.mjs</code>，Base URL 改填 <code>http://127.0.0.1:4320</code>。' },
            ],
          },
        ],
      },
      {
        legend: '画风',
        nodes: [
          { k: 'grid2', items: [
            { k: 'select', id: 's-style-preset', label: '画风预设（未锚定时的兜底）', options: [
              ['anime', '动漫 · 赛璐璐'], ['ink', '水墨 · 留白'], ['film', '电影 · 写实'], ['pixel', '像素 · 复古'], ['custom', '自定义'],
            ] },
            { k: 'field', id: 's-style-custom', label: '自定义画风关键词（英文逗号分隔）', type: 'text', placeholder: 'watercolor, soft light' },
          ] },
          { k: 'text', cls: 'set-sub', text: '锚定后由视觉设定卡接管；这里只在未锚定时兜底。' },
          { k: 'box', cls: 'panel-block', nodes: [
            { k: 'text', id: 'style-card-state', cls: 'hint' },
            { k: 'box', id: 'style-card-view', cls: 'hidden', nodes: [
              { k: 'box', id: 'style-card-text', cls: 'mono-line' },
              { k: 'row', items: [
                { k: 'field', id: 's-card-note', type: 'text', placeholder: '画风备注（只写画风偏好，别写时间 / 天气 / 地点）' },
                { k: 'btn', id: 'btn-save-card-note', text: '保存备注', cls: 'mini-btn' },
              ] },
              { k: 'text', cls: 'hint', text: '备注只管画面气质：时间、天气、地点、在场者由剧情与世界状态卡决定，玩家说放晴，就该画晴。' },
            ] },
            { k: 'row', items: [
              { k: 'btn', id: 'btn-anchor-rerun', text: '锚定画风（试画 4 张候选）', cls: 'btn' },
            ] },
            { k: 'text', id: 'rolling-style-text', cls: 'hint' },
          ] },
        ],
      },
    ],
  },

  {
    id: 'g-tools', title: '工具与服务',
    blocks: [
      {
        legend: '生成过程',
        nodes: [
          { k: 'check', id: 's-show-reasoning', checked: true, text: '展示深度思考链', sub: '模型返回 reasoning_content 时' },
          { k: 'check', id: 's-tools-enabled', checked: true, text: '向模型下发工具', sub: '召回世界卡 / 视觉设定卡、请求作画、写入记忆；模型不支持 function calling 时可关' },
          { k: 'row', items: [
            { k: 'text', id: 's-notools-hint', cls: 'hint' },
            { k: 'btn', id: 'btn-clear-notools', text: '清除降级记录', cls: 'mini-btn' },
          ] },
        ],
      },
      {
        id: 'fs-sidecar', legend: '本地服务',
        sub: '可选的本地小服务，只监听 127.0.0.1。邮件、定时主动、代下单都靠它；没启动时这些功能保持禁用，其它功能不受影响。',
        nodes: [
          { k: 'text', id: 'sidecar-state', cls: 'hint', text: '未启动' },
          { k: 'grid2', items: [
            { k: 'field', id: 's-sidecar-port', label: '端口', type: 'number', attrs: { min: '1', max: '65535' }, placeholder: '4319' },
            { k: 'field', id: 's-sidecar-token', label: 'token', type: 'text', spellcheck: false, placeholder: '启动本地服务时终端会打印' },
          ] },
          { k: 'row', items: [
            { k: 'btn', id: 'btn-sidecar-probe', text: '重新探测', cls: 'btn' },
            { k: 'text', cls: 'hint', text: '在项目目录运行 <code>node sidecar/server.mjs</code> 启动；token 防止本机其它程序乱调。' },
          ] },
        ],
      },
      {
        id: 'fs-email', legend: '邮件',
        sub: '默认关闭。白名单由本地服务硬校验：名单外的收件人只能先生成草稿，你确认后才会发出；所有发送 / 草稿 / 拒绝都有审计记录。',
        nodes: [
          { k: 'check', id: 's-email-enabled', text: '启用邮件功能' },
          {
            k: 'adv', title: '详细设置', auto: '#s-email-enabled', tagOff: '未启用', tagOn: '已启用', nodes: [
              { k: 'grid2', items: [
                { k: 'select', id: 's-email-provider', label: '发信渠道', options: [
                  ['mock', '模拟（只记账，不真的发信）'], ['resend', 'Resend（HTTP API）'],
                ] },
                { k: 'field', id: 's-email-dailylimit', label: '每日发送上限（0 = 一封都不发）', type: 'number', attrs: { min: '0', step: '1' } },
              ] },
              { k: 'field', id: 's-email-from', label: '发件人地址', type: 'text', spellcheck: false, placeholder: '例如 me@example.com' },
              { k: 'field', id: 's-email-resendkey', label: 'Resend API Key（只存在本地服务里；留空表示不改动已保存的 Key）', type: 'password', spellcheck: false },
              { k: 'field', id: 's-email-allowlist', label: '收件人白名单（每行一个）', type: 'textarea', attrs: { rows: '3', spellcheck: 'false' }, placeholder: 'buddy@example.com' },
              { k: 'details', cls: 'panel-block', summary: '邮件审计（最近记录）', nodes: [
                { k: 'box', id: 'email-audit', cls: 'mono-list' },
              ] },
            ],
          },
        ],
      },
      {
        id: 'fs-schedule', legend: '定时主动',
        sub: '默认关闭。免打扰时段与每日上限只存在本地服务里，<b>模型改不了</b>；模型提议的安排一律进「待确认」，要你点确认才生效。调度必须由本地服务常驻。',
        nodes: [
          { k: 'check', id: 's-sched-enabled', text: '启用定时主动联系' },
          { k: 'check', id: 's-sched-paused', text: '一键暂停所有主动行为' },
          {
            k: 'adv', title: '详细设置', auto: '#s-sched-enabled', tagOff: '未启用', tagOn: '已启用', nodes: [
              { k: 'grid2', items: [
                { k: 'field', id: 's-sched-dailycap', label: '每日主动消息上限（0 = 不限制）', type: 'number', attrs: { min: '0', step: '1' } },
                { k: 'select', id: 's-sched-missed', label: '错过触发时', options: [
                  ['SKIP', '跳过'], ['RUN_ONCE', '补一次'], ['RUN_ALL', '全部补齐'],
                ] },
              ] },
              { k: 'field', id: 's-sched-quiet', label: '免打扰时段（每行一段，格式 22:00-08:00）', type: 'textarea', attrs: { rows: '2', spellcheck: 'false' }, placeholder: '23:00-08:00' },
              { k: 'row', items: [
                { k: 'btn', id: 'btn-trigger-refresh', text: '刷新安排', cls: 'mini-btn' },
                { k: 'text', id: 'trigger-summary', cls: 'hint' },
              ] },
              { k: 'box', id: 'trigger-list', cls: 'mono-list' },
            ],
          },
        ],
      },
      {
        id: 'fs-payment', legend: '购物支付',
        sub: '默认关闭。策略由本地服务在代码层强制，AI 拿不到任何支付凭证；额度默认全是 0 = 什么都不放行。<b>AI 可能出错，请设置合理额度。</b>',
        nodes: [
          { k: 'check', id: 's-pay-enabled', text: '启用代下单功能' },
          {
            k: 'adv', title: '详细设置', auto: '#s-pay-enabled', tagOff: '未启用', tagOn: '已启用', nodes: [
              { k: 'grid2', items: [
                { k: 'select', id: 's-pay-provider', label: '渠道', options: [
                  ['mock', '模拟支付（不真实扣款）'], ['manual-order', '仅生成订单（自己手动付款）'],
                ] },
                { k: 'field', id: 's-pay-currency', label: '货币', type: 'text', attrs: { maxlength: '8' }, placeholder: 'CNY' },
              ] },
              { k: 'grid2', items: [
                { k: 'field', id: 's-pay-pertx', label: '单笔上限（分，0 = 不放行）', type: 'number', attrs: { min: '0', step: '100' } },
                { k: 'field', id: 's-pay-daily', label: '每日上限（分，0 = 不放行）', type: 'number', attrs: { min: '0', step: '100' } },
              ] },
              { k: 'grid2', items: [
                { k: 'field', id: 's-pay-monthly', label: '每月上限（分，0 = 不放行）', type: 'number', attrs: { min: '0', step: '100' } },
                { k: 'field', id: 's-pay-autoapprove', label: '免确认小额阈值（分，0 = 全部要确认）', type: 'number', attrs: { min: '0', step: '100' } },
              ] },
              { k: 'grid2', items: [
                { k: 'field', id: 's-pay-cooldown', label: '冷静期（分钟）', type: 'number', attrs: { min: '0', step: '1' } },
                { k: 'field', id: 's-pay-merchants', label: '商户白名单（每行一个，留空 = 不限）', type: 'textarea', attrs: { rows: '2', spellcheck: 'false' } },
              ] },
              { k: 'field', id: 's-pay-categories', label: '品类黑名单（每行一个）', type: 'textarea', attrs: { rows: '2', spellcheck: 'false' }, placeholder: '虚拟币' },
              { k: 'row', items: [
                { k: 'btn', id: 'btn-pay-refresh', text: '刷新台账', cls: 'mini-btn' },
                { k: 'text', id: 'pay-summary', cls: 'hint' },
              ] },
              { k: 'box', id: 'pay-ledger', cls: 'mono-list' },
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'g-data', title: '数据',
    blocks: [
      {
        legend: '用户画像',
        sub: '默认全关，可按模式开。开启后书记员校对时顺手提取，每轮只注入与当前话题相关的几条，不涨 token；关闭即停止收集，已存条目保留。',
        nodes: [
          { k: 'row', items: [
            { k: 'check', id: 's-profile-choice', text: '剧情' },
            { k: 'check', id: 's-profile-chat', text: '智能体' },
            { k: 'check', id: 's-profile-rp', text: '扮演' },
            { k: 'btn', id: 'btn-profile-all', text: '全部开启', cls: 'mini-btn' },
            { k: 'btn', id: 'btn-profile-none', text: '全部关闭', cls: 'mini-btn' },
          ] },
          { k: 'select', id: 's-profile-scope', label: '存储范围', options: [
            ['global', '全局（跨故事共享）'], ['per-story', '仅当前故事'],
          ] },
          { k: 'box', cls: 'panel-block', nodes: [
            { k: 'text', id: 'profile-state', cls: 'hint' },
            { k: 'box', id: 'profile-list', cls: 'mono-list' },
            { k: 'row', items: [
              { k: 'btn', id: 'btn-profile-clear', text: '清空画像', cls: 'mini-btn' },
            ] },
          ] },
        ],
      },
      {
        legend: '本地存储与备份',
        nodes: [
          { k: 'text', id: 'storage-state', cls: 'hint' },
          { k: 'text', id: 'storage-usage', cls: 'hint' },
          { k: 'row', items: [
            { k: 'btn', id: 'btn-backup-all', text: '导出全部备份', icon: 'down', cls: 'btn primary' },
            { k: 'btn', id: 'btn-clean-images', text: '清理孤儿原图', cls: 'mini-btn', title: '删掉没有任何故事引用的原图；剧情、缩略图、提示词都不动' },
            { k: 'text', id: 'backup-at', cls: 'hint' },
          ] },
          { k: 'check', id: 'backup-with-keys', text: '备份里带上 API Key', sub: '方便换设备直接可用；文件泄露有被盗刷风险，默认不带' },
          { k: 'check', id: 'backup-with-src', text: '备份里带上原图（导出为 .zip）', sub: '文件会明显变大，打包要等一会儿' },
          {
            k: 'help', title: '两种备份格式 · 数据存在哪 · 什么情况下会丢', nodes: [
              { k: 'text', text: '<b>.irbackup.json</b>：全部故事 + 模型设置 + 用户画像，不含原图，体积可控。<b>.zip</b>：同一份正文 + 全部原图，换设备时连图一起搬。把文件拖回书架窗口即可整体还原（同 id 的故事会被覆盖，其它保留）。只想带走单个故事，用书架卡片上的「导出 → 附带原图」。' },
              { k: 'text', text: '全部数据只存在<b>这台设备的这个浏览器</b>里（主库是 IndexedDB，原图以 Blob 单独存放），没有任何服务器。下列情况会让它消失：' },
              { k: 'text', text: '· 清「Cookie 和网站数据 / 站点数据」会全删（只清缓存不受影响）<br>· 无痕 / 隐私模式，关窗即没<br>· 换浏览器、换设备、换打开方式（<b>file:// 和 http://localhost 是两套独立数据</b>）<br>· Safari（含 iOS）：7 天没和页面交互，系统会自动清除脚本可写存储，建议「添加到主屏幕」或常来点一下<br>· 磁盘空间紧张时，浏览器可能自动淘汰' },
              { k: 'text', id: 'storage-persist', cls: 'hint' },
            ],
          },
        ],
      },
      {
        danger: true, nodes: [
          { k: 'btn', id: 'btn-clear-save', text: '清空本地存档与设置', cls: 'btn danger' },
        ],
      },
    ],
  },

  {
    id: 'g-look', title: '外观',
    blocks: [
      {
        legend: '界面',
        nodes: [
          { k: 'grid2', items: [
            { k: 'select', id: 's-ui-layout', label: '布局', options: [
              ['auto', '自动（宽屏双栏 / 窄屏堆叠）'], ['split', '双栏（左文右图）'], ['stack', '堆叠（图在上、文在下）'],
            ] },
            { k: 'select', id: 's-ui-choices', label: '选项显示', options: [
              ['tray', '收在「灵感」里'], ['always', '始终内联在旁白下'],
            ] },
            { k: 'select', id: 's-ui-motion', label: '动效强度', options: [
              ['auto', '跟随系统'], ['off', '关'], ['standard', '标准'], ['rich', '丰富'],
            ] },
          ] },
          { k: 'grid2', items: [
            { k: 'select', id: 's-ui-font', label: '字号默认（扮演 / 智能体）', options: [
              ['sm', '小'], ['md', '中'], ['lg', '大'],
            ] },
            { k: 'select', id: 's-ui-width', label: '内容宽度默认（扮演 / 智能体）', options: [
              ['narrow', '窄'], ['standard', '标准'], ['wide', '宽'],
            ] },
            { k: 'select', id: 's-ui-density', label: '密度默认（扮演 / 智能体）', options: [
              ['compact', '紧凑'], ['standard', '标准'],
            ] },
          ] },
          { k: 'text', id: 'ui-layout-hint', cls: 'hint' },
          { k: 'text', cls: 'hint', text: '首页的无限符号只在「丰富」档循环流动；「标准」「关」或系统开了「减少动态效果」时停成一道静态渐变。' },
        ],
      },
    ],
  },
];
