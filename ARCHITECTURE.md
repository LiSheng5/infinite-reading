# 架构说明

一句话：**一个不依赖构建、不依赖后端、不依赖任何第三方 JS 库的单页应用**——`index.html` + 若干 IIFE 模块，全部逻辑跑在浏览器里，数据存在 `IndexedDB`。

---

## 1. 三条硬约束

改动代码前请先接受这三条，它们决定了很多取舍：

1. **零构建**：源码必须能被 `<script src>` 直接加载，不能有 import/export、不能需要编译。`file://` 双击也要能跑。
2. **零依赖**：不引入第三方库，只用浏览器原生 API 与 `fetch`。
3. **前端核心无后端依赖**：前端本身不需要任何服务器——没有服务端存储，所有状态都在 `IndexedDB`，所以「换 origin 就换数据」。邮件 / 定时主动 / 受限购物支付这三项能力由一个**可选的本地旁路服务（sidecar，`sidecar/`）**提供；**缺它则这三项功能关闭**并在界面上明示，其余功能完全不受影响（见 §11）。

## 2. 模块与命名空间

所有模块都是 IIFE，把导出对象挂到全局 `IR`：

| 文件 | 命名空间 | 职责 | 代表函数 |
|---|---|---|---|
| `js/providers.js` | `IR.ChatProviders` / `IR.ImageProviders` / `IR.VideoProviders` | 适配器层，唯一碰网络的地方 | `ChatProviders['openai-compatible'].chat()`、`ImageProviders['openai-images'].generate()`、`ImageProviders['minimax-image'].generate()`（官方 `/v1/image_generation`，支持 `image-01-live` 的 `style` 画风）、`VideoProviders['minimax-video'].submit/poll/generate`（MiniMax V2） |
| `js/context.js` | `IR.Context` | 上下文组装 + 压缩 + 回包解析，运行时与评测**同源**共用 | `assembleAI1`、`assemblePainter`、`compressStory`、`planCompression`、`mergeWorld`、`matchEntityTerms`、`tolerantJSONParse`、`normalizeAIReply` |
| `js/tree.js` | `IR.Tree` | 分支树数据层（**纯逻辑**，Node 可 `require`）：回合树是唯一真源，`log / messages / scenes / world / …` 是「根 → head」路径的投影；重试 = 新增兄弟、‹ n/m › 切换；UI-4：任意节点继续 / 分叉 | `ensure`、`begin` / `commit` / `seal`、`project`、`switchSibling` / `switchTo`、`latestLeaf` / `forkBefore` / `canResume`、`pushLate`、`imageIdsOf` |
| `js/treeLayout.js` | `IR.TreeLayout` | 分支页画布几何（**纯逻辑**，Node 可 `require`，UI-4）：泳道分配（贪心 + 区间打包）、折叠长单链、标签截断、`pathEdgeD`；确定性输出 | `compute`、`pointsToD` |
| `js/storage.js` | `IR.Storage` | IndexedDB 适配器（**唯一碰 IndexedDB 的地方**）：开库 + 增删改查，`available=false` 时上层自然退回 localStorage | `available`、`get` / `put` / `del` / `keys` / `entries`、`estimate` |
| `js/store.js` | `IR.Store` | 存档层（**唯一出口**）：内存优先 + 异步落盘，API 全同步 | `boot` / `flush`、`newStory`、`loadStory` / `saveStory`、`listStories`、`serializeStory`、`migrateStory`、`loadSettings` / `saveSettings`、`putImage` / `imageURL` / `releaseImage` |
| `js/modelCapabilities.js` | `IR.ModelCapabilities` | 模型参数参考表（默认**全空**，不预置厂商数据） | `find`、`contextWindowOf`、`summarize` |
| `js/roleCard.js` | `IR.RoleCard` | SillyTavern V2/V3 PNG 角色卡解析 | `parsePNG`、`fromST`、`normalize`、`worldCharacter` |
| `js/zip.js` | `IR.Zip` | 极简 ZIP 读写（**零依赖、手写**）：给「带原图的全量备份」打包 / 解包。写入只用 store（不压缩，字节与原文件一致，任何解压工具都开得了），读取兼容 deflate（方法 8）与反斜杠路径 | `build`、`read`、`crc32` |
| `sw.js` / `js/pwa.js` | 无（Service Worker 全局） | PWA：预缓存外壳与静态资源、离线可用；注册逻辑只在 https / localhost 生效 | `install`（预缓存）、`fetch`（导航网络优先 / 静态缓存优先） |
| `js/app.js` | 无（组合根） | 事件绑定 + 启动（`bind` / `init` / boot IIFE），只接线不写业务；消费下面所有 `js/app/*` | `bind`、`init` |
| `js/app/*.js`（20 个） | `IR.App`（`A.state` 共享状态 + `A.reg` 注册表） | 主逻辑按功能节拆分（见 §2.1）：模块间调用一律 `A.xxx()` 晚绑定，只有 `core.js` 可被其他模块顶部解构 | 见 §2.1 |
| `eval/run.js` | 无（Node 脚本） | 离线评测，`require` 同样的模块后重放剧本 | `evaluate`、`checkHeuristic`、`checkP7` |
| `eval/mock-story.js` | `IR.MockStory` | 评测剧本（32 回合 + 探针） | 数据文件 |
| `eval/tree-test.js` | 无（Node 脚本） | 分支树数据层测试（投影 / 兄弟切换 / 迁移 / store 集成 / UI-4 继续与分叉，不联网不开浏览器） | `check`、`playTurn`、`retryTurn` |
| `eval/treelayout-test.js` | 无（Node 脚本） | 分支树布局测试（泳道 / 折叠 / 标签 / 确定性 / 2000 节点耗时，UI-4） | `check`、`mkTree` |
| `tools/make-big-tree.mjs` | 无（Node 脚本） | 生成 ~800 节点、多层嵌套分叉的可导入 `.irstory.json`（分支页性能验收） | `addNode`、`spine` |
| `js/sidecar.js` | `IR.Sidecar` | 可选本地服务的客户端：`/health` 探测与离线降级、token、`api()`、SSE 退避重连 | `probe`、`api`、`on`、`status`、`configure` |
| `js/features.js` | `IR.Features` | 主动触达的去重与排队（投递回调由 `js/app/sidecar.js` 的 `initFeatures` 注册） | `attach`、`accept`、`drain` |
| `js/paintQueue.js` | `IR.PaintQueue` | 作画串行队列（**纯逻辑**，Node 可 `require`）：时机 / 工具 / 手动 / 重画共用一条 FIFO 队列，画师构思也在队列里；`anchor.dead` 开跑前跳过、跑完带 `dead` 供写回前丢弃 | `create`、`enqueue`、`has`、`size` |
| `js/proposals.js` | `IR.Proposals` | 提案（**纯逻辑**，Node 可 `require`）：模型发起的邮件 / 下单**只能产生提案**，执行由用户点「确认」触发；不碰 DOM / story，sidecar 以参数注入、时间以 `now` 注入 | `create`、`isActionable`、`confirm`、`approveSecond`、`deny` |
| `src/core/motion.ts`（阶段 2 前为 `js/motion.js`） | `IR.Motion` | 统一 motion 模块的纯逻辑端（Node 可 `require`）：把设置项 `ui.motion` + 系统「减少动态效果」解析成 `off / standard / rich`，并持有 `TIERS` 三档政策、`LOOP_BUDGET` 循环上限与 `ANIMATIONS` 逐动画三档行为声明表，不碰 DOM | `resolve` `TIERS` `ANIMATIONS` `LOOP_BUDGET` |
| `js/prefs.js` | `IR.Prefs` | 本对话偏好（UI-3 设置分层，**纯逻辑**，Node 可 `require`）：`story.prefs` 清洗、「本对话覆盖 → 全局默认」解析、主模型配置解析（profileId → 模型库）、各模式可见控件、导出剥凭证；不碰 DOM / 存储 | `sanitizePrefs`、`effective` / `effectiveInfo`、`resolveChatCfg`、`visibleFor`、`exportPrefs`、`stripSecrets` |
| `js/titles.js` | `IR.Titles` | 自动标题（**纯逻辑**，UI-2 §3.3）：触发判定、给小模型的 prompt、输出清洗、本地兜底、写回护栏；不碰 DOM / 网络 | `needsTitle`、`buildPrompt`、`sanitize`、`fallback`、`applyTitle` |
| `js/search.js` | `IR.Search` | 全文搜索（**纯逻辑**，UI-2 §3.4）：标题 + 全部分支节点的子串检索（NFKC / 小写 / 折叠空白，AND 多词），片段带 `ranges`（**输出零 HTML**）；内存索引 `Map(id → doc)` 不持久化 | `buildDoc`、`query`、`createIndex`、`notifySave`、`drop` |
| `sidecar/`（Node 进程） | 无（独立进程） | 可选本地服务：调度器 / 邮件 / 支付网关；只绑 `127.0.0.1`，除 `/health` 外都要 Bearer token | `server.mjs`、`scheduler.mjs`、`cron.mjs`、`email.mjs`、`payment.mjs`、`payment-policy.mjs` |

**脚本顺序是有意义的**（`index.html` 末尾）：

```
providers.js → prefs.js → context.js → tree.js → treeLayout.js → storage.js → store.js → modelCapabilities.js → roleCard.js → zip.js → sidecar.js → features.js → paintQueue.js → proposals.js → motion.js → titles.js → search.js → app/core.js → 其余 js/app/*.js（任意顺序）→ js/app.js → pwa.js
```

`prefs.js` 赶在 `store.js` 之前（`migrateStory` 调 `IR.Prefs.sanitizePrefs`，缺位时有兜底）；`storage.js` 必须赶在 `store.js` 之前（`store.js` 启动时要拿 `IR.Storage`）；`tree.js` 不依赖 store，但必须赶在 `store.js` 与 `js/app/*` 之前（`serializeStory` 用它的裁剪窗口常量、`imageIdsOf` 委托它的树遍历，缺了直接报错；回合编排也要 `IR.Tree`）；`zip.js`、`paintQueue.js`、`proposals.js`、`motion.js` 同理都要赶在 `js/app/*` 之前（分别是惰性查 `IR.Zip`、`IR.PaintQueue.create`、`IR.Proposals`、`IR.Motion.resolve`）；`js/app/core.js` 必须是**第一个**加载的 app 模块（建 `IR.App` / `A.state` / `A.reg`，其余模块顶部解构它的导出）；`js/app.js` 是组合根，**最后**加载（boot IIFE 末尾调 `init()`）；`pwa.js` 是唯一的例外，它排在 `js/app.js` 之后——它不碰 `IR`，只注册 Service Worker。

**存储的两条硬约束**（改动时必须守住）：

- **内存优先**：`boot()` 之后所有读走内存、写是「改内存 + 后台异步落盘」，因此 `Store.*` 全是**同步签名**，`js/app/*` 不用改 async。等落盘用 `Store.flush()`（导出 / 卸载前）。
- **无 IndexedDB 也要能跑**：Node 评测（`eval/run.js`）没有 `indexedDB`，`Storage.available` 就是 `false`，`store.js` 自动退回 localStorage / 进程内内存。任何新的存储代码都要保留这条退路。

`js/app.js` 在 boot IIFE 里先 `Store.boot()` 再调 `init()`，所以它必须最后加载；`js/app/*` 模块之间运行时才互相访问（`A.xxx()` 晚绑定），彼此顺序随意。新增模块请插在 `core.js` 之后、`js/app.js` 之前（见 §2.1）。

### 2.1 `js/app/*`：主逻辑拆分与 `IR.App` 约定（v0.7.1）

原 `js/app.js`（v0.7.0 时 6284 行）按功能节拆成经典脚本（IIFE），**行为、DOM、文案一行不变**（拆分时 15 个；此后随功能演进新增 / 再拆，现为 20 个——模块数以 `js/app/` 目录实际文件为准，本表随增量维护）：

| 文件 | 职责（源「节」） | 代表函数 |
|---|---|---|
| `js/app/core.js` | 默认值与提示词；共享状态 `A.state`；请求中断；小工具；弹窗栈 | `toast`、`irConfirm`、`openModal` / `closeModal` / `dismissModal`、`requestChatStop`、`persistSettings`、`saveAll` |
| `js/app/models.js` | 模型能力（T-M-1 / §4.13） | `chatContextWindow`、`renderCapabilityFields`、`thumb` |
| `js/app/library.js` | 原图（Blob）；存档点；开始页与开局入口；导入 / 导出 | `showShelf`、`startFromStart`、`doExport`、`storeOriginal` |
| `js/app/shelf.js` | 书架页（UI-2）：会话列表 + 搜索 + 自动标题 + 行菜单；`openStory(id, opts)` 支持滚动到命中消息 | `renderShelf`、`openStory`、`maybeAutoTitle`、`regenTitle`、`initShelf`、`searchStats` |
| `js/app/backup.js` | 本地存储与备份（P0 数据安全） | `initStorageGuard`、`doBackupAll`、`handleImportFile`、`importZipFile` |
| `js/app/importer.js` | 剧情文本导入（R12 路径②） | `openImportText`、`runImportText`、`startFromImport` |
| `js/app/cards.js` | 角色卡；用户画像（数据与导入） | `openCardEditor`、`importCardFile`、`applyProfileEntries` |
| `js/app/wizard.js` | 开局向导（T-P2-3） | `openWizard`、`draftWizard`、`startFromWizard` |
| `js/app/turn.js` | AI1 剧情回合；书记员任务；工具护栏；重试与分支 | `streamAI1`、`parseAIReply`、`postTurn`、`retryLast`、`switchSiblingFromBubble` |
| `js/app/round.js` | 回合编排（任务书模块表外新增）：`callAI1` / 玩家行动 / 开场 / 工具执行 / 旁白收尾 | `callAI1`、`sendPlayerAction`、`runOpening`、`finishNarration`、`pushLog` |
| `js/app/sidecar.js` | 本地服务连接状态、主动消息投递、下拉菜单 | `sidecarReady`、`initSidecar`、`pullProactive`、`toggleMenu` |
| `js/app/features.js` | 调度工具；安全项读写；主动联系 / 邮件 / 购物支付；提案卡 | `runScheduleTool`、`runProposalTool`、`confirmProposal`、`openEmailModal` |
| `js/app/painter.js` | 画师子代理 + 生图 + 作画队列；画师工作台；视频动态提示词 | `runPaintTask`、`enqueueImage`、`painterVideoPrompt`、`openWorkbench`、`redrawFromWorkbench` |
| `js/app/video.js` | 生视频（MiniMax V2，§5 / §10）：`videoQ` 独立串行队列、付费确认、提交 → 轮询 → 下载 / 降级 → 存 IndexedDB（`vid:<sceneId>`）→ 写回 story；`pendingVideos` 恢复轮询与取消 | `enqueueVideo`、`videoFromCurrentImage`、`videoFromPlot`、`resumePendingVideos`、`stopVideoWaiting`、`cancelActiveVideo`、`videoSrc`、`renderWorkbenchVideo` |
| `js/app/styleanchor.js` | 画风锚定（R3 / §5） | `openAnchor`、`runAnchorBatch`、`anchorLock` |
| `js/app/render.js` | 聊天记录、画面面板、进入 / 离开故事、灯箱 | `renderChat`、`renderStage`、`enterGame`、`closeLightbox` |
| `js/app/layout.js` | 布局状态（从 render.js 拆出的统一入口）：`#screen-game` 的 `data-layout`、字号 / 宽度 / 密度三档、舞台收起与沉浸模式（本对话覆盖 → 全局默认） | `effectiveLayout`、`applyLayout`、`bindSplitter` |
| `js/app/settings.js` | 设置界面、故事记忆面板、注入记忆、用户画像面板 | `syncSettingsToForm`、`testConnection`、`renderStoryPanels` |
| `js/app/prefsui.js` | UI-3 设置分层界面：全局设置分组导航（桌面左导航 / 窄屏下钻）、模型库管理、本对话设置面板（右侧停靠 / 窄屏底部弹层） | `initSettingsNav`、`renderModelProfiles`、`renderStoryPrefs`、`openStoryPrefs` |
| `js/app/branch.js` | UI-4 分支页：整页分支树（SVG 渲染 / 平移缩放 / 键盘树导航）、节点面板三操作、历史位置提示条 | `initBranch`、`openBranch`、`closeBranch`、`updateHistoryBar` |
| `js/app.js`（保留） | 组合根：事件绑定 + 启动 | `bind`、`init` |

**三条约定**（经典脚本没有 import，靠 `IR.App` 松耦合）：

1. **共享可变状态集中在 `IR.App.state`**：模块顶部 `const A = IR.App, S = A.state;`，之后用 `S.story`、`S.busy`。只在一个模块内用的变量保持模块私有。局部变量遮蔽共享名（形参、`const story = …`）的地方保持原样不改写。
2. **跨模块调用一律走注册表、晚绑定**：文件末尾 `A.reg({ fnA, fnB })`（重名直接抛错），调用方写 `A.fnA(...)`，**不要在模块顶部解构别的模块的函数**（加载顺序无法保证）。唯一例外：`core.js` 最先加载，其他模块（含 `js/app.js`）可在顶部 `const { $, toast, irConfirm, … } = A;` 解构 **core 的导出**——白名单 = `core.js` 的 `A.reg` 键，由 `eval/app-structure-test.js` 门禁强制。跨模块的回调引用写作 `() => A.fn()` / `e => A.fn(e)`。
3. **加载顺序**：`IR.*` 模块 → `js/app/core.js` → 其余 `js/app/*.js`（任意顺序）→ `js/app.js`（组合根，最后）。模块顶层只做声明与 `A.reg`；顶层立即执行的代码（`addEventListener` 注册、启动 IIFE）只允许在 `js/app.js`。

**如何新增一个 app 模块**：① 在 `js/app/` 建文件，包 IIFE，顶部 `'use strict'` 与 `const A = IR.App, S = A.state;`（要用 core 工具再加一行解构）；② 业务函数写完后在文件末尾 `A.reg({ … })` 导出**被别的模块调用**的函数（模块私有函数不注册）；③ 在 `index.html` 的 `js/app/core.js` 之后、`js/app.js` 之前加 `<script src="js/app/<新模块>.js?v=…">`；④ 跑 `node eval/app-structure-test.js` 与 `node tools/check-free-calls.mjs`（行数 ≤ 800、`A.reg` 键全局唯一、`A.xxx` 引用闭合、无未解析裸调用）。

## 3. 一回合的完整调用链

```
玩家输入 / 点选项
  └─ js/app.js  doSend → js/app/round.js  sendPlayerAction(action, isChoice)
       ├─ pushLog({type:'player'|'choice'})
       ├─ callAI1(action)
       │    ├─ Context.matchEntityTerms(...)         ← 记下本轮实体词（C-E 启发式留痕）
       │    ├─ Context.assembleAI1(story, action, opts)  ← 拼系统提示词 + 记忆 + 历史 + tools
       │    ├─ streamAI1 → IR.ChatProviders[...].chat(cfg, messages, hooks)   ← 唯一的对话网络出口（带空闲 / 总超时与中断）
       │    ├─ parseAIReply → Context.normalizeAIReply(Context.tolerantJSONParse(text))
       │    └─ 若有 tool_calls → handleToolCalls → applyToolCall
       │         ├─ update_memory  → mergeWorld / 写 userProfile / 落一条 {type:'tool'} 留痕
       │         ├─ recall_*       → 重发一次（召回内容并入本轮 user 前缀注入）
       │         └─ request_image（仅 chat / rp，P-1 起剧情模式无此工具）
       │              ├─ chat / rp：submitToolPaint → paintQueue.enqueue（**立刻返回**，不等图）
       │              │    └─ 后台任务：runPaintTask（直出 prompt，跳过画师）→ runPaint
       │              └─ choice（旧历史诱导模型调了）：按「该工具不可用」回传重发，
       │                 不入队、不报错、不弹 toast（P-1 §3.3）
       ├─ 归档：story.messages.push(user + assistant)、pushNarrationEntry、absorbReply
       ├─ renderChat
       ├─ Tree.commit → turnAnchor.nodeId = node.id；失败 / 停止分支 → turnAnchor.dead = true
       └─ await postTurn()   ← runSmartCompress（70% 阈值压缩）+ runScribe（书记员校准世界卡）
          ※ 回合结束不再自动出图（P-1：maybeEnqueueImage / 开局出图分支已删除）——
            图只来自用户点 🎨（enqueueImage → runPaintTask → painterCompose → runPaint）或工作台重画

后台作画（队列里的 runPaintTask）：
  构思（画师 / 模型直出）→ 组 prompt → IR.ImageProviders[...].generate(cfg, prompt)   ← 唯一的生图网络出口
    → 写入 scenes[] / 缩略图 → 舞台换图（模糊底色 + 完整图 + 缩略条）
    → 落位按 §4.4：anchor.nodeId 有值走节点校验 / pushLate；为空写 story.log / scenes 由 commit 切片收进节点
```

要点：

- **对话与生图彻底分离**：两个 `Base URL` / `Key` / 模型名各自独立（设置面板里是两组配置）。
- **剧情模式的作画只能由用户触发（P-1，v0.11.0）**：时机出图（`settings.trigger` 的每轮 / 选择后）与开局自动出图已删除，「出图时机」设置整体下线（`settings.trigger` / `story.prefs.trigger` 停止读写，旧值原样留在存档里）；剧情模型也不再下发 `request_image`（工具清单与工具说明里都没有它，模型若照旧历史调了按「该工具不可用」回传）。唯一入口 = 🎨（`#btn-stage-gen` / `#btn-manual-gen`）与画师工作台重画；舞台无图时显示引导「点 🎨 为当前场景画一张」。
- **出图不卡回合**（v0.5.1）：`request_image`（chat / rp 直出变体）提交进**同一条作画队列**（`IR.PaintQueue`，严格串行、画师构思也在队列里）就立刻返回；图稍后落回「它所属的回合」——回合锚点 `turnAnchor` 在提交时随任务走，`commit` 成功补 `nodeId`、失败 / 停止置 `dead`（开跑前与写回前各核一次）。
- **画师是子代理，隔离上下文、用完即弃**：它不是独立会话，而是由 `assemblePainter` 拼出的一次性请求，产物是 `prompt_en / subject / alt`，可被用户改写。**scene 模式的输入只有固定几块（P-1 §4）**：`PAINTER_SYSTEM` + `[画风锚]`（设定卡优先）+ `[最近两张图]` + `[基底 prompt]`（上一次出图的**完整** prompt，差分基底：风格词原样保留、只改剧情变化的部分；第一次作画时整块省略）+ `[最近剧情]`（最近 `PAINTER_RECENT_TURNS = 3` 回合的「玩家行动 + 旁白」，玩家行动带（做）/（说）/（导演）标记、每条截断 200 字）+ `[画面参考]` / `[画风要求]`；**不得出现**更早对话、世界卡全文、摘要栈、剧情规则提示词、用户画像（`eval/painter-context-test.js` 固定）。**对话 / 扮演的工具出图不经画师**（§3.E）：模型自己写 `prompt` 直出；工作台对话（chat 模式）保持 `recall_recent_plot` 不动。
- **「停止」只管聊天回合**（v0.5.1）：`chatAbortCtrl` 只有聊天回合的请求写它；`painterCompose` / 生图不再挂上来，后台作画不被停止中断（超时沿用适配器自己的）。
- **出图任务带 `storyId`**：写入前核对，避免切故事后把图贴到别的档上。
- **临时例外（§3.F）**：对话 / 扮演的「手动作画」按钮本期仍走「画师优先、不可用则场景描述兜底」——工具被关 / 模型不吃 tools 时它是唯一出图入口，而 chat / rp 的 `lastSceneSummary` 只是旁白截断、不适合当提示词。等智能体模式改版（画布去掉、工具为主）时整体处理。

## 4. 数据模型

### 4.1 存储与键位（全部在 `js/store.js` 中定义）

**主库是 IndexedDB**（`ir-db`，适配器 `js/storage.js`），三个 object store：

| store | 内容 | 键 |
|---|---|---|
| `kv` | 小数据：设置 / 索引 / 当前故事 / 画像 / 迁移标记 | 见下表 |
| `stories` | 单个故事的完整档案（原图除外） | story id |
| `images` | 原图 Blob（`{ blob, meta, at }`） | imageId（`img:<sceneId>`） |

`kv` 里的键名沿用 localStorage 时代的 `ir:` 前缀（迁移时原样搬，不重命名）：

| 键 | 内容 |
|---|---|
| `ir:settings` | 模型配置、界面开关等（出图时机 `trigger` 已下线，v0.11.0） |
| `ir:story-index` | 书架索引：`{ id, title, updatedAt, thumb, mode, turn, titleAuto, snippet }`（UI-2 §3.1；`snippet` 每次 `saveStory` 重算；旧索引条目由 `Store.ensureIndexComplete` 幂等补齐） |
| `ir:current` | 上次打开的故事 id |
| `ir:user-profile` | 跨故事的玩家画像条目 |
| `ir:migrated-v2` | v0.1 → v0.2 迁移标记 |
| `ir:migrated-v3` | localStorage → IndexedDB 迁移标记（**只在 IndexedDB 的 `kv` 里**） |

`localStorage` 现在只承担两件事：① 升级前的旧数据（**只读，迁移后原样保留当回退快照，不再写入**）；② `infinite-reading-v1:*` 旧版键（仅用于一次性迁移）。

### 4.2 story schema（`Store.newStory`；`SCHEMA` = 3，分支树起）

顶层字段：`schema, id, title, titleAuto, titleGen, premise, mode(choice|chat|rp), createdAt, updatedAt, log[], world{}, styleCard, rollingStyle{}, styleTone, characterCard, userProfile[], painterThread[], messages[], summaries[], savepoints[], ui{}, prefs{}, turn, scenes[], pendingVideos[], lastBg, lastSceneSummary, tree{}`。

- `titleAuto` / `titleGen`（UI-2 §3.2/§3.3）：`titleAuto` 为真时标题可被自动任务覆盖（新建的智能体 / 扮演对话为真，初始标题「新对话」；剧情新故事与旧存档为假）；任何手动改名 / 手动重新生成标题都会把 `titleAuto` 收成假。`titleGen` 记自动已生成次数（0 / 1 / 2），触发点是 `turn === 1`（第一次）与 `turn === 6`（第二次），失败不计次。

- `world`（世界状态卡）：`place, time, characters[], threads[], relationship{stage,bonds,notes}, scene, updatedAt, scribeAt`。
- `ui`（随故事记住的界面状态）：`kind`（`do|say|direct`，输入框左侧的做 / 说 / 导演）；旧版遗留的 `split / showImage / immersive` 原样保留但不读取——布局已统一到 `settings.ui`（`layout / splitRatio / imageCollapsed / choices`）。
- `prefs`（本对话偏好，UI-3 §3.2，全部可选、缺省 = 跟随全局）：`profileId`（**只存引用 id，绝不存 apiKey / baseUrl**）+ `profileLabel`（显示用「名称 · 模型名」）、`trigger`、`choices`、`showReasoning`、`tools{image,memory,schedule,email,payment}`、`ui{layout,splitRatio,imageCollapsed,fontScale,width,density}`。`migrateStory` 透传并经 `IR.Prefs.sanitizePrefs` 清洗（丢未知键、剥凭证形字段）；`serializeStory` 落盘同样清洗。
- `tree`（分支树，schema 3 起）：回合树是**唯一真源**（`root / head / nodes / states`），`log / messages / scenes / world / summaries / …` 全是「根 → head」路径的投影（`IR.Tree.project`）。重试 = 在同一父节点下新增兄弟节点；有兄弟的回合用 ‹ n/m › 切换。无 tree 的旧档由 `IR.Tree.ensure` 幂等迁移成线性链（末条旁白 `versions > 1` 展开成兄弟、旧存档点按 `sp.turn` 映射 `nodeId`）。
- 写盘前经 `serializeStory` 裁剪：`log` 只保留末 `IR.Tree.LOG_WINDOW`（120）条、图片的 `src` 置空（缩略图另存）、`scenes` 只保留末 `IR.Tree.SCENE_WINDOW`（12）张、`savepoints` 只保留末 `IR.Tree.SAVEPOINT_KEEP`（5）个；**裁剪不作用在 `tree` 上**（树里按节点存着全量条目 / 场景元数据）。裁剪窗口的唯一口径在 `js/tree.js` 顶部常量（store 与书架导出一律引用导出值），**不要在别处写字面量**。落盘快照**深拷贝**、`migrateStory` 入口同样先深拷贝——「已保存」内存快照不会被现场就地修改带脏，异步 put 也不会写进未 save 的现场。
- `pendingVideos[]`（生视频，v0.12.0）：已提交、未出结果的异步任务（`taskId` 等）；切档 / 刷新后由 `js/app/video.js` 据此**续轮询同一任务**（不重复提交），完成 / 取消 / 过期后从数组移除。
- 旧存档由 `migrateStory` / `migrateSettings` / `migrateLegacy` 升级（`migrateStory` 深拷贝后原样保留 `tree`，不校验），**改动结构必须同步升级 `SCHEMA` 与迁移函数**。

### 4.3 对外交换格式

| 文件 | 生成 | 结构 |
|---|---|---|
| `.irstory.json` | `buildExportPack` / `doExport` | `{format:'ir-story', schema:2, kind:'full'\|'premise', title, premise, mode, styleTone, world, styleCard, rollingStyle, characterCard, images[], …}` |
| `.irbackup.json` | `buildBackupPack` / `doBackupAll` | `{format:'ir-backup', schema:1, app, exportedAt, settings, userProfile, stories[]}`，默认剥掉 API Key |
| `.irbackup.zip` | `buildBackupZip` / `doBackupAll`（勾选「带上原图」） | 同一个包里两样东西：`ir-backup.json`（同上，`schema:2` 多一份 `images:[{id, path, type, size}]` 清单）+ `images/0001.png…`（原图按二进制原样存放，**不转 base64**） |

导入统一走 `handleImportFile` → `applyImport`，按 `format` 分派：备份整体还原、`kind:'premise'` 进开局向导、其余建新档续玩。`.zip` 由 `handleImportFile` 先判扩展名 → `importZipFile` 解包取 `ir-backup.json`，再走同一条 `applyBackupImport(obj, entries)`，原图按清单写回 IndexedDB。

### 4.4 设置分层与模型库（UI-3，v0.9.0）

**两层设置**：

- **全局设置**（`settings`，跨所有对话）：`chat`（默认主模型）、`profiles[]`（模型库，每条 `{id, name, provider, baseUrl, apiKey, model, temperature, thinking, contextWindow, extraParams}`，形状沿用 `chat`；`chat` 本身视作 id `'default'`，不进数组）、`painter / scribe / draft`（子代理，本期仍全局）、`image`、`video`（生视频：`duration / resolution / ratio` 以设置面板控件为唯一来源，`extraParams` 只补其它键）、`stylePreset / styleCustom`（P4 视觉设定卡之前的兜底画风与自定义画风）、`userProfile`、`ui`（`layout / splitRatio / imageCollapsed / choices / motion` + 新增 `fontScale / width / density` 默认）、`showReasoning`、`toolsEnabled / noTools`、`sidecar`、备份时间戳。（`trigger`（出图时机）v0.11.0 起下线：`defaultSettings` 不再写它，`migrateSettings` 对旧值原样透传、不读不删；`story.prefs.trigger` 随 `PREF_KEYS` 去掉，导入旧包按未知键丢弃。）
- **本对话设置**（`story.prefs`）：见 §4.2。解析顺序一律 `IR.Prefs.effective(settings, story, key)`（本对话覆盖 → 全局默认）；`profileId` 找不到对应 profile 时回退默认并在面板提示「原对话使用的模型 X 在本机不存在」。

**主模型请求配置**：所有发给主模型的请求（回合 / 重试 / 主动消息 / 工具重发）走 `IR.Prefs.resolveChatCfg(settings, story)` → `{cfg, source, missing}`，**不再直接读 `settings.chat`**；依赖模型的派生量跟着有效配置走：`chatContextWindow()`（70% 压缩阈值 `Context.compressThreshold`）、`thinking` / `extraParams`、`noTools`（按 `baseUrl + model` 记忆，天然随配置走）。子代理（画师 / 书记员 / 起草）仍走 `resolveSub`（回落 `settings.chat`，本期不变）。回合提交在节点 `meta.model` 记模型名字符串（无密钥 / URL）。

**工具集**：下发 = 全局可用性（`toolsEnabled` / `noTools` / 侧车 feature）∩ `IR.Prefs.effective(settings, story, 'tools')`（按 `IR.Prefs.toolCategory` 把工具名映射到 `image / memory / schedule / email / payment` 五个开关，缺省跟随全局）。

**安全红线（密钥）**：模型库与 `settings.*` 里的 apiKey 只存在本地全局设置；故事存档 / 导出包 / 分享包**绝不出现** `apiKey / key / token / baseUrl` 字段——`buildStoryPack`（`store.js`）整包过 `IR.Prefs.stripSecrets`，`prefs` 只带 `profileId + profileLabel`。整库备份 `.irbackup.json` **含 `settings`**（含 profiles）；默认剥掉全部 apiKey（勾「备份里也带上 API Key」才保留），行为不变、只是剥除范围覆盖新增的 `profiles[]`。

### 4.5 分支语义第二期与分支页（UI-4，v0.10.0）

**继续即分叉**：`commit` 的 parent 恒为**当前 `head`**——`switchTo` 回到历史位置（head 落在非叶子节点）后发送，新节点就追加到该节点 `children` 末尾并更新 `parent.active`，天然产生一条新分支（`eval/tree-test.js` 用例 19.1 固定）。提示条只看 `head.children.length > 0`（主动消息 / `pushLate` 不会改变它）。

**三个新 API**（`js/tree.js`）：

- `latestLeaf(story, nodeId)`：沿 `active` 下探到叶子（内部 `descend` 的公开版）；「切到这条分支的最新处」「回到最新」都用它。
- `forkBefore(story, nodeId)`：`switchTo(node.parent)`（站在这一回合发生之前），返回 `{ok, action:{type,text,kind,sent}}` 供输入框预填（`setComposerText(text, kind)`，不触发发送）；根节点与开局节点（`action.type === 'opening'`）返回 `{ok:false, reason}`。
- `canResume(story, nodeId)`（纯函数）：节点 `sid === null`（旧档迁移来的早期回合，状态未知）→ `false`。`project` 对 `sid === null` 保持当前状态不动，所以**所有会落到这类节点的继续 / 分叉入口都要拦**（面板按钮置灰，落点含「改我说的」的 parent）。

**分支页（`js/app/branch.js` + `js/treeLayout.js`）**：整页覆盖层，git-graph 式布局（主干 = 当前路径固定 lane 0，支线贪心 + 区间打包到右侧泳道、子树结束可复用）；折叠 ≥8 个纯单链节点成「··· N 回合」超级节点（视图态 `expanded`，不进存档）；节点面板三操作 = 回到这里并从此继续 / 改我说的，从这之前分叉 / 切到最新处。**打开分支页只读 `story.tree`**（不 `ensure` 写盘、不改 `active`），只有面板操作经 `Tree.*` 改树；忙碌（`busy` 或未 `sealed` 的 head）时切换类操作全部拒绝。键盘：`↑↓←→` 树导航（`role="tree"` / `treeitem` + `aria-activedescendant`）、`Enter` 开面板、`Esc` 关面板 / 返回。搜索命中不在当前路径 → 直接开分支页选中该节点（**不**自动 `switchTo`）。

**动效预算**（走 UI-1 令牌）：rich = 边按深度描边生长（封顶 ~600ms）+ 节点弹簧弹出（WAAPI，只动 `transform` / `opacity`，新节点「长出来」）+ **流光只挂 `pathEdgeD` 合成的一条 path** + head 呼吸 + 选中脉冲（循环动画恰好 3 条）；standard = 整体淡入；off = 无。`data-paused` 全局暂停循环；>400 节点视口裁剪（只建可见行附近的 SVG 元素）。

## 5. 关键不变量（改动时别碰坏）

| 不变量 | 位置 | 为什么 |
|---|---|---|
| **不把 `tool_calls` 写进历史** | `js/app/turn.js`：`slimReply`、`assistantMessage` | assistant 消息带 `tool_calls` 却没有配对 `tool` 结果会触发 400；工具调用只留一条 `{type:'tool'}` 日志 |
| **`reasoning` 不进请求体** | `context.js`：`assembleAI1` 只取 `role/content` | 思考链只用于显示 |
| **压缩阈值 70%，保留窗口按 token 自适应** | `context.js`：`COMPRESS_RATIO`、`fitWindow`、`planCompression` | 已知容量时组装窗口按 token 动态（最多吃窗口一半，条数 ∈ [4, 40]），未知退回 8 条（评测口径不变）；超预算但无可压时降级保留窗口自救；组装前先查预算、超了就地先压再组 |
| **每轮工具调用上限 2 次** | `context.js`：`MAX_TOOL_CALLS_PER_TURN` | 防止模型反复调工具烧钱；超限调用留痕并告知模型，不静默丢弃 |
| **工具结果按语义分流** | `js/app/round.js`：`callAI1` | `recall_*` 调了就注入重发（模型要的信息）；`request_image`（chat / rp）已异步化——写了正文就不重发，仅 `noProse` 时把「已排队生图」提示注入；剧情模式的 `request_image`（旧历史诱导）按「该工具不可用」回传重发，不入队；`update_memory` / 调度工具 / 提案工具（`email_propose` / `payment_propose`，事后动作）仅无正文时重发；重发永不再带工具 |
| **剧情作画只能点按钮**（P-1，v0.11.0） | `js/app/round.js`（删 `maybeEnqueueImage` 与开局出图）、`js/context.js`：`toolsForMode('choice')` 无 `request_image` | 回合结束 / 开局不再自动出图，`S.turnPaintedByTool` 已随去重需求一起删除；省掉没要求时的画师构思 + 生图开销 |
| **画师上下文隔离规则**（P-1 §4） | `context.js`：`assemblePainter`（scene）/ `recentTurnLines`、`PAINTER_RECENT_TURNS` / `PAINTER_RECENT_LINE_CHARS` | 画师每次调用只看固定几块（画风锚 / 最近两张图 / 基底 prompt / 最近 3 回合剧情 / 画面参考）；更早对话、世界卡、摘要栈、剧情规则、画像一律不进（`eval/painter-context-test.js` 固定） |
| **画风稳定靠「差分 prompt」** | `context.js`：`lastImagePrompt`、`PAINTER_SYSTEM`（差分规则）；`providers.js`：`clipPromptText` | 生图是纯文生图（不传图），风格只能靠文字锚：把上一次出图的完整 prompt 作为基底、只重写变化部分；超长 prompt 截断时保留尾部画风词（不许被 1500 字上限切掉） |
| **视觉设定卡有两套视图** | `context.js`：`styleCardText`（画师）/ `styleCardTextForText` + `textAnchorText`（AI1） | 卡里的英文人物外观、媒介、色板、负面提示词都是**生图参数**，灌给旁白模型就会漏进思考链与正文（「画师的提示词混进来了」）；召回与 🧠 注入一律走文本侧视图（画风关键词 + 中文备注，并注明不要复述）。`eval/style-card-text-test.js` 固定 |
| **参考图是唯一「真传图」的口子** | `js/app/library.js`：`refImageDataUrl`；`js/app/painter.js`：`runPaint`；`providers.js`：`minimax-image.supportsReference` + `subject_reference` | 仅当 `settings.image.refMode === 'prev'` 且适配器声明 `supportsReference` 时才把上一张图（长边 ≤1024 JPEG）塞进 `subject_reference`；拿不到图**不拦**这次作画（退化成本文生图），第一次作画自然跳过 |
| **作画只有一条串行队列，构思也在里面** | `js/paintQueue.js`、`js/app/painter.js`：`paintQ` / `runPaintTask` | 手动 / 工具 / 重画严格 FIFO；画师构思不与队列外的活并发（`painterThread` 只有用户显式对话才写）；「构思 → 出图」集中在 `runPaintTask` 一处 |
| **回合锚点 `turnAnchor`** | `S.turnAnchor`（`IR.App.state`）；`js/app/round.js` / `turn.js` 的 commit / catch、`js/app/painter.js` 的 `runPaint` 写回前核对 | 工具出图在 commit 之前提交：`dead` 必须在**所有**失败 / 停止分支置位，漏一处就有图落进不存在的节点；`nodeId` 为空时写 `story.log`，由 `commit` 的 `logMark` 切片（含 `scenesFor` 对 `scenes` 的收集）收进节点 |
| **「停止」只中断聊天回合** | `S.chatAbortCtrl`（`IR.App.state`）只有 `js/app/turn.js` 的 `streamAI1` 写入 | 后台作画与「停止」脱钩：不中断在途作画，也不抢走聊天的 abort；在途结果写回前再核 `dead` |
| **`tools` 降级**：显式 400 拒绝的模型记入「黑名单」 | `js/app/turn.js`：`isToolsRejection`、`rememberNoTools`、`noToolsFor` | 试错降级，不做预探测 |
| **画像三条纪律**：存储不设上限 / 注入有预算 / 常驻仅一行摘要 | `context.js`：`profileBlock`、`PROFILE_TOP_N`、`PROFILE_MAX_CHARS` | 画像不能吃光预算 |
| **不预置模型名与厂商参数** | `modelCapabilities.js`（表默认空）、`store.js` 默认 provider | 参数随厂商变动，宁可留空让用户填 |
| **换档保护** | `js/app/painter.js` / `turn.js`：生图 / 书记员结果写回前核对 `storyId`；`js/app/video.js` 的轮询循环同样每次核对 | 切换故事时不污染新档，也不再等旧任务（视频任务转入 `pendingVideos` 待恢复，见下一行） |
| **视频不进作画队列** | `js/app/video.js`：`videoQ = IR.PaintQueue.create()`（第二个实例）、`#video-status` 独立胶囊 | 视频 1~3 分钟且 run() 内整段轮询，绝不能堵出图；提交成功立刻写 `story.pendingVideos[]`，切档 / 刷新只停本地等待，回到该故事用 `poll` 续同一 `task_id`（不重复提交）；下载被拦走 `remoteUrl` 限时降级 |
| **AI 文本一律 `textContent` 渲染** | `js/app/render.js` 渲染函数 | 模型输出与导入内容不可信，禁止拼 `innerHTML` |
| **树是唯一真源，其余字段是投影** | `js/tree.js`：`project` / `stateOf`；`js/app/*` 只读投影 | 切分支 = 换 head + 重新投影，既有读取点一行不改；条目与消息**按引用共享**（就地修改落树上），**State 才 clone**（`world` 会被 `mergeWorld` 原地改写，绝不存引用） |
| **`seal` 必须在 `postTurn` 之后** | `js/app/round.js`：`sendPlayerAction`、`js/app/turn.js`：`retryLast` | 书记员 / 压缩会改 `world / summaries / messages` 并往 log 追加 tool 条目，先 seal 存的是「半结算」状态 |
| **全树图集必须含非当前分支** | `js/tree.js`：`imageIdsOf`（树遍历**唯一实现**）；`store.js`：`imageIdsOf`（扫 log / scenes 后委托树遍历）、`knownImageIds` | 漏掉 `tree.nodes[*]` 的 scenes / entries 图引用就会**静默删掉别的分支的图**（清理孤儿 / 删除 / 备份共用一条口径；树遍历只留一份实现，两处漂移过就是删档级事故） |
| **晚到条目 / 画面带 `nodeId` 校验** | `js/app/painter.js`：`runPaint` 写回（`nodeId` 来自任务或 `turnAnchor`）、`js/tree.js`：`pushLate` | 节点不存在 → 丢弃；已 sealed 且不在当前路径 → 只写节点，不得泄漏进当前 log（retry / 切分支时在途任务落回原节点，正是靠这条） |
| **模型发起的有副作用动作一律走提案** | `js/proposals.js`：`confirm` / `approveSecond` / `deny`；`js/app/features.js`：`runProposalTool`、`confirmProposal`、`denyProposal` | **前端永不在没有用户点击时调用 `emailSend` / `paymentPurchase` / `paymentApprove` / `paymentCharge` / `paymentMarkPaid`**（提案路径只用 `emailDraft`→`emailSendDraft`；`paymentPurchase` 只出现在用户点「确认」之后，返回 `needsApproval` 时必须再弹一次带额度的确认，不得自动批准）。确认幂等（`confirm` 同步抢占状态）、提案有 TTL、只在所属节点处于当前分支路径上时可操作 |
| **动画只动合成层属性** | `css/motion.css` 的 `@keyframes`（全仓唯一定义点）与 transition；`eval/tokens-test.js` 有可执行检查 | `@keyframes` 只允许 `transform / opacity / filter / stroke-dashoffset / stroke-dasharray`，小面积装饰元素可用 `@property` 注册的自定义属性（注册块须可动画 syntax + `inherits: false`）；transition 不得动画 `width / height / top / left / margin / box-shadow` 等触发重排的属性。阴影只做静态值；`will-change` 只在动画进行时临时加、结束移除 |
| **颜色只从令牌来** | `css/tokens.css` 的 `:root`（唯一改色的地方，阶段 3 起独立成文件）；`tools/contrast-check.mjs`、`eval/tokens-test.js` | 组件规则里不写 `#hex / rgb()`；改色先跑 `node tools/contrast-check.mjs`（WCAG 对比度）与 `node eval/tokens-test.js`（令牌回归）。暗色主题将来加 `[data-theme="dark"]` 一套令牌即可，不在组件层写死 |
| **自动标题写回护栏**（UI-2 §3.3） | `js/titles.js`：`applyTitle(story, id, title)`；触发在 `js/app/round.js` / `turn.js` 的 `seal` 之后、编排在 `js/app/shelf.js`：`maybeAutoTitle` | 写回前核 `story.id` 一致且 `titleAuto` 仍为真（用户期间改过名就丢弃结果）；任务异步、不占 `busy`、不阻塞下一次发送；每个故事同时只允许一个标题任务；模型走 `resolveSub('scribe')`，书记员未启用 / 无 key / 无模型 → 直接本地兜底**不发网络请求**；失败静默不计次 |
| **搜索输出零 HTML、高亮只走 ranges**（UI-2 §3.4/§3.5） | `js/search.js`：`query`（片段 + ranges）；`js/app/shelf.js`：`appendHighlighted`（`createElement('mark')` + `textContent`） | 查询结果只有纯文本与 `[start,end]` 下标；UI 高亮不得拼 `innerHTML`（对抗内容如 `<script>` 原样保留为文本）。搜索文档遍历**全部分支节点**；内存索引不持久化，首次聚焦搜索框惰性构建（分批 ~5 个故事让出主线程），`saveStory` 防抖 ~800ms 增量重建该 id，`deleteStory` 同步移除 |
| **书架只读索引**（UI-2 §3.1） | `js/store.js`：索引条目 `{ id, title, updatedAt, thumb, mode, turn, titleAuto, snippet }`、`ensureIndexComplete`；`js/app/shelf.js`：`renderShelf` | `renderShelf` 不再对每个故事 `loadStory`；`snippet` 每次 `saveStory` 重算（切兄弟 / 重试会变，不缓存）；旧索引条目由 `ensureIndexComplete` 按需补齐并整体回写一次（幂等）；空标题只显示兜底文案、**不回写存档** |

| **故事与导出里绝不带密钥**（UI-3 §3.4） | `js/prefs.js`：`sanitizePrefs` / `stripSecrets` / `exportPrefs`；`js/store.js`：`migrateStory` / `serializeStory` / `buildStoryPack` | 故事会被导出 / 分享 / 备份：`story.prefs` 只存 `profileId`（不透明引用）与 `profileLabel`（显示用）；导出包整包剥 `apiKey / key / token / baseUrl`（任意嵌套层级），`eval/prefs-test.js` 有可执行断言 |
| **主模型配置走 `resolveChatCfg`**（UI-3 §3.3） | `js/prefs.js`：`resolveChatCfg`；`js/app/models.js`：`chatCfg` / `chatContextWindow`；`js/app/round.js`：`callAI1` | 每对话可选自己的模型（profile），派生量（压缩阈值 / thinking / extraParams / noTools 键）必须跟着**有效**配置走；`profileId` 找不到 → 回退默认并提示，绝不硬失败 |
| **工具集 = 全局可用性 ∩ `prefs.tools`**（UI-3 §3.3） | `js/app/round.js`：`callAI1` 的 `toolAllowed` 过滤；`js/prefs.js`：`toolCategory` | 对话里可单独关掉「下单 / 邮件 / …」，默认跟随全局；其它对话不受影响 |
| **手改派生数据后 `resyncState`** | `js/tree.js`：`resyncState`；`js/app/settings.js`：`saveWorldFromForm` | 树是真源、`project` 会用 head 的内联状态覆盖 `world / summaries / …`——手改世界卡后必须把 head 的状态换成当前值，否则下次进故事 / 切分支会把编辑回滚掉 |
| **打开分支页只读树**（UI-4 §9） | `js/app/branch.js`：`openBranch` | 分支页渲染**不得** `ensure` 写盘 / 改 `active` / `project`——只有面板操作经 `Tree.switchTo` / `forkBefore` 改树 |
| **`canResume` 拦住 `sid === null` 的落点**（UI-4 §2.4/§9） | `js/tree.js`：`canResume`；`js/app/branch.js`：`renderPanel` / `opResume` / `opFork` | `project` 对 `sid === null` 保持当前状态——落到这种节点世界卡 / 摘要是错的；「改我说的」的落点是 **parent**，同样要过 `canResume` |
| **分支页流光只挂一条 path**（UI-4 §4.5） | `js/app/branch.js`：`render`（`pathEdgeD`）；`css/style.css`：`.branch-flow` | 循环动画预算 ≤ 3（流光 / head 呼吸 / 选中脉冲），每条边单独加动画会炸掉预算 |

### 5.1 设计令牌与动效等级（UI-1）

**颜色**：全站只从 `css/tokens.css` 的 `:root` 令牌取色（阶段 3 起独立成文件）——白做底（`--bg #FFFFFF`）、蓝做强调（`--accent #2563EB`）、黑做文字和主按钮（`--ink` / `--on-ink`）。主按钮是黑底白字，蓝色只做强调（链接、选中态、分支线、进度线、焦点环）；`--line-strong` 是输入框 / 按钮描边（≥3:1）。护栏：`node tools/contrast-check.mjs`（WCAG 对比度表）+ `node eval/tokens-test.js`（:root 之外无颜色字面量、@keyframes 属性白名单、动效令牌存在性）。暗色主题**只预留结构**：将来加 `[data-theme="dark"]` 一整套令牌即可，组件规则里没有任何字面色。

**动效令牌**（同样在 `:root`，调手感只改这里）：`--dur-fast/base/slow`、`--ease-out/spring/inout`、`--loop-busy/kb/ambient/flow/inf` 与档位参数 `--dur-off/shift/flash/none`。圆角统一 `--radius: 8px`（阶段 3 补上定义：0.12.1 漏定义，实际渲染成了方角）。

**动效强度（阶段 3 统一 motion 模块）**：语义真源 `src/core/motion.ts`（`resolve` / `TIERS` / `LOOP_BUDGET` / `ANIMATIONS` 逐动画三档声明），CSS 端 `css/motion.css`（`@keyframes` 唯一定义点 + 档位收口变量 `--m-*` + 动画名表 `--an-*` + 暂停规则），DOM 端 `src/ui/motion.js`（`initMotion` / `registerLoop` 循环预算 / `suspendLoops` 子树挂起）。`<html data-motion="off|standard|rich">` 由 `IR.Motion.resolve(pref, prefersReduced)` 解析（设置 `settings.ui.motion`，默认 `auto`；显式选择优先于系统「减少动态效果」），`js/app/core.js` 的 `applyMotion` 在启动与 `matchMedia` 变化时写入；每个动画的三档行为在 `ANIMATIONS` 显式声明（`none / fade / shift / full / loop`），`eval/tokens-test.js` 对账 `@keyframes`、`--an-*` 名表与声明表三者一致。

| 档 | 行为 |
|---|---|
| off | 无位移、无循环；最多保留瞬时（≤80ms）的透明度变化 |
| standard | 淡入淡出与短位移（≤160ms）；无循环动画；无 Ken Burns、无环境光、无逐段文字淡入 |
| rich | 全部动效（默认） |

循环预算：同屏同时运行的循环动画 ≤ 3 组（一组 = 同名 keyframes 的错相多实例），登记走 `registerLoop`（超出者挂 `data-loop="wait"` 暂停）；页面不可见 `html[data-paused]` 全局暂停；分支页打开时暂停底下阅读页的循环（旧屏走 `html[data-branch="open"]` 规则，新屏走 `suspendLoops`）。

**本期动效**（都只动 `transform` / `opacity`，图片 blur-up 的 `filter` 是唯一例外）：切兄弟滑动（WAAPI，先切数据 + 重渲染再播入场，可打断）、流式文字逐段淡入（增量包 `span.delta`，存活 span ≤ 200，流结束合并成单个文本节点）、顶栏忙碌进度线 `#busy-line`、图片 blur-up / 舞台交叉淡入 / Ken Burns（离屏与 `data-paused` 暂停）、环境光（仅 rich，`--ambient-glow`）、按钮 / 弹窗 / toast 手感。

**分支页动效（UI-4 §4.5）**：rich = 边按深度描边生长（`stroke-dashoffset`，总时长封顶 ~600ms）+ 节点弹簧弹出（新节点单独「长出来」）+ 当前路径流光（**只挂 `pathEdgeD` 合成的一条 path**）+ head 呼吸环 + 选中 / 悬停脉冲环；standard = 整体淡入、无循环；off = 无动画。

**暂停与预算**：`visibilitychange` 写 `html[data-paused]`，CSS 暂停一切循环动画；同屏循环动画 ≤ 3 个（阅读页：`#busy-line` + Ken Burns + 环境光；分支页：流光 + head 呼吸 + 选中脉冲，且流光只有 1 条 path）；`will-change` 只在动画进行时临时加、结束移除。

## 6. 上下文策略速览

`Context.assembleAI1` 由这几层自上而下拼成（从贵到便宜）：

1. **模式系统提示词** `systemForMode`：剧情 / 智能体 / 扮演三套人格与输出契约（剧情模式为中文键 `旁白 / 选项 / 场景切换`；智能体是通用助手定位，工具能力含画图 / 记事 / 定时 / 写邮件 / 下单，后两样只是提案；扮演是「角色卡里的人」+ 2~6 句体量锚定，无角色卡时用降级提示词）。
2. **风格基调 + 故事设定常驻**：`[风格基调]`（≤120 字）与 `[故事设定（常驻）]`（≤400 字摘要）——地基信息不随摘要合并流失。
3. **世界状态卡** + **当前情势一行** `buildSummaryLine`。
4. **前情摘要栈** `summaries[]`（`trimSummaries` 限长）。
5. **C-E 启发式注入** `matchEntityTerms` + `heuristicBlock`：玩家话里出现世界卡实体词时，按条数上限带回对应条目；无实体词则零成本不注入。
6. **按需召回**：由 `recall_world_state` / `recall_style_card` 工具触发，客户端以「单次重发」实现。
7. **最近消息窗口**：已知容量时按 token 动态装（最多吃窗口一半，条数 ∈ [4, 40]），未知退回 8 条；更早的内容在超过 70% 预算时由 `compressStory` 压进摘要栈（组装前先查预算、超了先压再组）。

召回结果、工具回传、启发式与强制注入统一**并入本轮 user 消息前缀**（不插中段 system 块，规避兼容层吞中段 system）。

扮演模式额外常驻角色卡与关系记忆（`characterCardText` / `relationshipBlock`），剧情与对话模式不常驻，避免涨预算。

## 7. 评测如何做

`eval/run.js` 只 `require` 纯逻辑模块（`context.js` / `store.js` / `roleCard.js`），不加载 `js/app.js` 与 `js/app/*`，因此**不发任何网络请求**：

- 重放 `eval/mock-story.js` 的 32 回合剧本，与运行时同样地调用 `assembleAI1` / `compressStory`；
- 在第 10 / 20 / 30 回合插入「追问回合」，检查组装出的 prompt 是否命中 5 类探针（角色名 / 时间设定 / 伏笔原话 / 地点细节 / 玩家自己说过的事）；
- `checkHeuristic` 校验 C-E 启发式注入的命中与「零注入」；`checkP7` 校验角色卡解析（自造 V2/V3 PNG）与画像预算 / 合并 / 本地提取；
- 输出总分并与 v0.1 基线（60.0%）对比；低于基线或校验未全中时返回非 0 退出码（CI 据此拦截回归）。

改记忆、压缩、召回相关代码前请先跑 `node eval/run.js`。

## 8. PWA 与离线缓存（`sw.js`）

PWA 是「装个帽子」，不是「换条路」：`js/pwa.js` 在 https / `localhost` 下注册 `sw.js`，`file://` 直接跳过，**业务代码一行都不用改**。

| 请求类型 | 策略 | 为什么 |
|---|---|---|
| 导航（打开页面） | 网络优先 → 断网回退预缓存的 `index.html` | 网络优先保证「改了立刻生效」，绝不被缓存卡住 |
| 同源静态资源（CSS / JS / 图标 / manifest） | 缓存优先 + 后台静默更新（SWR） | 秒开；`?v=` 版本串本身就是失效开关 |
| 跨域（对话 / 生图 API、字体 CDN） | 不拦截、不缓存 | **API Key 与剧情文本绝不进缓存** |
| 非 GET | 不拦截 | 上传/导入走原路 |

预缓存清单**不写死在 SW 里**，而是 `install` 时抓 `index.html`、用正则解析出里面所有 `css/` `js/` `icons/` 资源（含 `?v=`）再逐个缓存——清单跟着页面走，不存在「两份清单不同步」的问题。

`CACHE` 名（`ir-v<版本>`）由 `tools/sync-version.mjs` 从 `VERSION` 注入：版本一变就换缓存、`activate` 时清掉旧的，等价于「跟着发布节奏清缓存」。**改前端资源后如果本地看到旧文件，先怀疑 Service Worker**（DevTools → Application → Service Workers → Unregister）。

## 9. 想扩展的话

- **接新的模型服务**：在 `js/providers.js` 的 `ChatProviders` / `ImageProviders` 上注册一个 key，保持签名 `chat(cfg, messages, hooks)` / `generate(cfg, prompt)`；再在设置面板的 provider 选项里加上它。不需要改 `js/app/*` 的业务逻辑。
- **视频**：`IR.VideoProviders['minimax-video']`（MiniMax V2）的约定是把**异步任务**拆成分步接口——`submit(cfg, {prompt, image?, mode}) -> {taskId}`、`poll(cfg, taskId) -> {status, url?, error?}`（`queued|running|succeeded|failed|cancelled|expired`）、`generate(cfg, req, hooks)`（= submit + 每 10 秒 poll；`hooks.onTaskId / onStatus / signal`；总超时常量 `VIDEO_TOTAL_TIMEOUT_MS` 默认 15 分钟）。旧约定 `generate(cfg, {prompt, image}) -> {url}` 保留。恢复轮询用 `poll` 续同一 `task_id`（`js/app/video.js`），不在适配器里做。「测试连接」只走只读列任务探测，绝不提交生成任务。新增渠道（可灵 / Vidu 等）只需实现这几个方法并注册 key。浏览器直连被 CORS 拦（2026-10-22 实测 MiniMax 不带 `Access-Control-Allow-*`）时，用 `tools/video-proxy.mjs`（零依赖本地转发：只监听 `127.0.0.1`、转发目标钉死 MiniMax 两个域名〔绝对 URI / 协议相对 URI 一律拒〕、回包只补本机来源的 CORS 头；**不改 sidecar**），把设置里的 Base URL 填 `http://127.0.0.1:4320` 即可；下载 mp4 仍走应用内 remoteUrl 降级，不过代理。
- **主题**：`css/style.css` 顶部的 CSS 变量就是主题入口。当前是白底蓝强调浅色主题（UI-1）；暗色只要再写一套 `[data-theme="dark"]` 的令牌覆盖即可，组件规则里没有字面色。
- **格式与内容**：`.irstory.json` / 角色卡的解析入口集中在 `store.js` 与 `roleCard.js`，新增字段请同步 `migrateStory`。

## 10. 已知边界

- **主库是 IndexedDB**（`js/storage.js` + `js/store.js`），容量由浏览器按磁盘空间分配，不再受 localStorage 约 5MB 限制；但这仍是**本机这个浏览器**的额度，且**不是无限大**——浏览器、设备剩余空间与存储策略都会影响它。旧版数据留在 localStorage 里作为回退快照，不再写入。
- `file://` / `http://localhost` / 未来桌面壳的 origin 各不相同，数据天然隔离，只能靠导入导出搬运（**IndexedDB 也按 origin 隔离**）。
- 浏览器直连第三方 API 会被 CORS 拦，无法在纯前端层面解决。
- API Key 明文存 IndexedDB（详见 [`CONTRIBUTING.md`](CONTRIBUTING.md) 的「安全说明」）。

## 11. 可选本地服务（sidecar）

**定位**：不是「应用必须有后端」。前端核心照旧纯前端；`sidecar/` 是一个**可选**的本地伴侣进程，只有三项能力靠它：

| 能力 | 为什么必须在侧车 |
|---|---|
| 邮件 | 浏览器无法开 SMTP；收件人白名单与每日上限需要**后端硬校验** |
| 定时主动 | 浏览器定时器只在页面打开时跑；要「重启不丢 + 常驻触发」必须有进程 |
| 购物支付 | 策略必须在**模型改不到的代码层**强制执行 |

**启动与连接**：

```bash
node sidecar/server.mjs            # 首次启动会打印 token
node sidecar/server.mjs --show-token
```

- 只绑 `127.0.0.1`（局域网不可达），端口默认 `4319`（可用 `IR_SIDECAR_PORT` / `IR_SIDECAR_DATA_DIR` 环境变量覆盖，单测就是这么隔离的）。
- 除 `/health` 外所有接口都要 `Authorization: Bearer <token>`；`/health` 只回能力布尔位，前端靠它决定「在线 / 离线」。
- 前端探测失败即降级：三个功能显示「需要启动本地服务」并禁用（设置里三个分区整体灰显），其余功能不受影响。
- **单进程**：启动时用锁文件 + 端口占用双重检测，重复启动会被拒绝（避免定时触发被跑两遍）。

**存储与真源**：侧车用 `node:sqlite`（`sidecar/data/ir-sidecar.db`）持久化触发器、触发记录、邮件审计与草稿、支付台账与授权范围。**安全项（额度 / 白名单 / 每日上限 / 免打扰时段 / token）的唯一真源是 `sidecar/data/config.json`**，前端设置页只是它的编辑界面（经 `GET/PUT /api/config`），前端本地不保存这些值，模型也没有任何写入通道——这与 SillyTavern（`config.yaml` + `secrets.json`）、Open WebUI（环境变量 + Admin Panel）、LibreChat（`.env` > `yaml` > 面板）三家一致。

**工具通道的取舍（v0.6.0 起）**：调度保留 5 个模型工具（`schedule_once` / `schedule_heartbeat` / `schedule_cron` / `list_triggers` / `cancel_trigger`），**只在 `chat`（智能体）/ `rp` 模式且侧车在线时下发**，且模型新建的触发器一律是 `pending_confirm`，需用户在界面上点确认才生效。邮件与支付也做成了模型工具（`email_propose` / `payment_propose`），但**只是提案制**：模型发起的一律停在提案卡上，执行必须由用户点「确认」触发（`js/proposals.js` 状态机 + `IR.Sidecar` 侧车双层把关）；工具**只在 `chat` 模式 + 侧车在线 + 对应 feature 开启且有 token 时下发**（rp / choice 即便能力齐备也不给）。用户显式发起的手写邮件 / 下单表单仍是「界面按钮 → 确认弹窗 → 执行」的老路径。因此 `MAX_TOOL_CALLS_PER_TURN` 仍是 2。

**页面关闭时**：侧车到点只把触发**写入待处理队列**（不打扰、不猜）；前端下次打开时按 `SKIP / RUN_ONCE / RUN_ALL` 补跑，补跑时走的是与真实用户消息完全相同的回合链路（合成一条入站消息 → `sendPlayerAction`）。「页面开着」则由 SSE 实时推送 `trigger.fire`。这一处做成了可替换的策略点（见 `scheduler.mjs` 的 `missedPolicy`）。

**测试**：`eval/scheduler-test.js`（虚拟时钟）、`eval/email-test.js`、`eval/payment-test.js`（策略边界）、`eval/sidecar-smoke.js`（真启子进程走 HTTP）、`eval/frontend-smoke.js`（假 fetch 验离线降级与工具门控），全部接入 `npm test`。
