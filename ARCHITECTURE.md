# 架构说明

一句话：**一个不依赖构建、不依赖后端、不依赖任何第三方 JS 库的单页应用**——`index.html` + 若干 IIFE 模块，全部逻辑跑在浏览器里，数据存在 `IndexedDB`。

设计稿（为什么这么设计）见 [`docs/DESIGN.md`](docs/DESIGN.md)；调研与竞品分析见 [`docs/NOTES.md`](docs/NOTES.md)。

---

## 1. 三条硬约束

改动代码前请先接受这三条，它们决定了很多取舍：

1. **零构建**：源码必须能被 `<script src>` 直接加载，不能有 import/export、不能需要编译。`file://` 双击也要能跑。
2. **零依赖**：不引入第三方库，只用浏览器原生 API 与 `fetch`。
3. **前端核心无后端依赖**：前端本身不需要任何服务器——没有服务端存储，所有状态都在 `IndexedDB`，所以「换 origin 就换数据」。邮件 / 定时主动 / 受限购物支付这三项能力由一个**可选的本地旁路服务（sidecar，`sidecar/`）**提供；**缺它则这三项功能关闭**并在界面上明示，其余功能完全不受影响（见 §12）。

## 2. 模块与命名空间

所有模块都是 IIFE，把导出对象挂到全局 `IR`：

| 文件 | 命名空间 | 职责 | 代表函数 |
|---|---|---|---|
| `js/providers.js` | `IR.ChatProviders` / `IR.ImageProviders` / `IR.VideoProviders` | 适配器层，唯一碰网络的地方 | `ChatProviders['openai-compatible'].chat()`、`ImageProviders['openai-images'].generate()`、`VideoProviders`（空，预留） |
| `js/context.js` | `IR.Context` | 上下文组装 + 压缩 + 回包解析，运行时与评测**同源**共用 | `assembleAI1`、`assemblePainter`、`compressStory`、`planCompression`、`mergeWorld`、`matchEntityTerms`、`tolerantJSONParse`、`normalizeAIReply` |
| `js/tree.js` | `IR.Tree` | 分支树数据层（**纯逻辑**，Node 可 `require`）：回合树是唯一真源，`log / messages / scenes / world / …` 是「根 → head」路径的投影；重试 = 新增兄弟、‹ n/m › 切换 | `ensure`、`begin` / `commit` / `seal`、`project`、`switchSibling` / `switchTo`、`pushLate`、`imageIdsOf` |
| `js/storage.js` | `IR.Storage` | IndexedDB 适配器（**唯一碰 IndexedDB 的地方**）：开库 + 增删改查，`available=false` 时上层自然退回 localStorage | `available`、`get` / `put` / `del` / `keys` / `entries`、`estimate` |
| `js/store.js` | `IR.Store` | 存档层（**唯一出口**）：内存优先 + 异步落盘，API 全同步 | `boot` / `flush`、`newStory`、`loadStory` / `saveStory`、`listStories`、`serializeStory`、`migrateStory`、`loadSettings` / `saveSettings`、`putImage` / `imageURL` / `releaseImage` |
| `js/modelCapabilities.js` | `IR.ModelCapabilities` | 模型参数参考表（默认**全空**，不预置厂商数据） | `find`、`contextWindowOf`、`summarize` |
| `js/roleCard.js` | `IR.RoleCard` | SillyTavern V2/V3 PNG 角色卡解析 | `parsePNG`、`fromST`、`normalize`、`worldCharacter` |
| `js/demo.js` | `IR.Demo` + 两个演示适配器 | 离线演示（`?demo=1`）：把「模型」换成内置剧本与本地占位图 | `enabled`、`applyTo`、`reset`；`ChatProviders['demo']`、`ImageProviders['demo-image']` |
| `js/zip.js` | `IR.Zip` | 极简 ZIP 读写（**零依赖、手写**）：给「带原图的全量备份」打包 / 解包。写入只用 store（不压缩，字节与原文件一致，任何解压工具都开得了），读取兼容 deflate（方法 8）与反斜杠路径 | `build`、`read`、`crc32` |
| `sw.js` / `js/pwa.js` | 无（Service Worker 全局） | PWA：预缓存外壳与静态资源、离线可用；注册逻辑只在 https / localhost 生效 | `install`（预缓存）、`fetch`（导航网络优先 / 静态缓存优先） |
| `js/app.js` | 无（不导出） | 状态机 + UI + 回合编排，消费上面所有模块 | `init`、`sendPlayerAction`、`callAI1` / `streamAI1`、`postTurn`、`maybeEnqueueImage`、`generateScene`、`buildExportPack` / `buildBackupPack` / `buildBackupZip`、`importZipFile` |
| `eval/run.js` | 无（Node 脚本） | 离线评测，`require` 同样的模块后重放剧本 | `evaluate`、`checkHeuristic`、`checkP7` |
| `eval/mock-story.js` | `IR.MockStory` | 评测剧本（32 回合 + 探针） | 数据文件 |
| `eval/tree-test.js` | 无（Node 脚本） | 分支树数据层测试（投影 / 兄弟切换 / 迁移 / store 集成，不联网不开浏览器） | `check`、`playTurn`、`retryTurn` |
| `js/sidecar.js` | `IR.Sidecar` | 可选本地服务的客户端：`/health` 探测与离线降级、token、`api()`、SSE 退避重连 | `probe`、`api`、`on`、`status`、`configure` |
| `js/features.js` | `IR.Features` | 主动触达的去重与排队（投递回调由 `app.js` 注册） | `attach`、`accept`、`drain` |
| `sidecar/`（Node 进程） | 无（独立进程） | 可选本地服务：调度器 / 邮件 / 支付网关；只绑 `127.0.0.1`，除 `/health` 外都要 Bearer token | `server.mjs`、`scheduler.mjs`、`cron.mjs`、`email.mjs`、`payment.mjs`、`payment-policy.mjs` |

**脚本顺序是有意义的**（`index.html` 末尾）：

```
providers.js → context.js → tree.js → storage.js → store.js → modelCapabilities.js → roleCard.js → demo.js → zip.js → sidecar.js → features.js → app.js → pwa.js
```

`storage.js` 必须赶在 `store.js` 之前（`store.js` 启动时要拿 `IR.Storage`）；`tree.js` 不依赖 store，但必须赶在 `app.js` 之前（回合编排要 `IR.Tree`）；`demo.js` 要赶在 `app.js` 之前（注册演示适配器）；`zip.js` 也排在 `app.js` 之前（导出 / 导入备份时才用到，惰性查 `IR.Zip`）；`pwa.js` 是唯一的例外，它排在 `app.js` 之后——它不碰 `IR`，只注册 Service Worker。

**存储的两条硬约束**（改动时必须守住）：

- **内存优先**：`boot()` 之后所有读走内存、写是「改内存 + 后台异步落盘」，因此 `Store.*` 全是**同步签名**，`app.js` 不用改 async。等落盘用 `Store.flush()`（导出 / 卸载前）。
- **无 IndexedDB 也要能跑**：Node 评测（`eval/run.js`）没有 `indexedDB`，`Storage.available` 就是 `false`，`store.js` 自动退回 localStorage / 进程内内存。任何新的存储代码都要保留这条退路。

`app.js` 在 IIFE 执行期就读取 `IR.Store` 与 `IR.ModelCapabilities`，并在文件末尾直接调用 `init()`，所以它必须最后加载；其余模块之间运行时才互相访问（惰性查 `IR.*`），顺序靠前也不会报错。新增模块请插在 `app.js` 之前。

## 3. 一回合的完整调用链

```
玩家输入 / 点选项
  └─ app.js  doSend → sendPlayerAction(action, isChoice)
       ├─ pushLog({type:'player'|'choice'})
       ├─ callAI1(action)
       │    ├─ Context.matchEntityTerms(...)         ← 记下本轮实体词（C-E 启发式留痕）
       │    ├─ Context.assembleAI1(story, action, opts)  ← 拼系统提示词 + 记忆 + 历史 + tools
       │    ├─ streamAI1 → IR.ChatProviders[...].chat(cfg, messages, hooks)   ← 唯一的对话网络出口（带空闲 / 总超时与中断）
       │    ├─ parseAIReply → Context.normalizeAIReply(Context.tolerantJSONParse(text))
       │    └─ 若有 tool_calls → handleToolCalls → applyToolCall
       │         ├─ update_memory  → mergeWorld / 写 userProfile / 落一条 {type:'tool'} 留痕
       │         ├─ recall_*       → 重发一次（召回内容并入本轮 user 前缀注入）
       │         └─ request_image  → runToolPaint → painterCompose → assemblePainter
       │                              → 调对话模型（画师子代理）→ enqueuePaint
       ├─ 归档：story.messages.push(user + assistant)、pushNarrationEntry、absorbReply
       ├─ renderChat
       ├─ maybeEnqueueImage(reply,false)      ← 按 settings.trigger 三档决定是否出图
       │    └─ enqueueImage → generateScene → painterCompose → runPaint
       │         └─ IR.ImageProviders[...].generate(cfg, prompt)   ← 唯一的生图网络出口
       │            → 写入 scenes[] / 缩略图 → 舞台换图（模糊底色 + 完整图 + 缩略条）
       └─ await postTurn()   ← runSmartCompress（70% 阈值压缩）+ runScribe（书记员校准世界卡）
```

要点：

- **对话与生图彻底分离**：两个 `Base URL` / `Key` / 模型名各自独立（设置面板里是两组配置）。
- **画师是子代理**：它不是独立会话，而是由 `assemblePainter` 拼出的一次性请求，产物是 `prompt_en / subject / alt`，可被用户改写。
- **出图任务带 `storyId`**：写入前核对，避免切故事后把图贴到别的档上。

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
| `ir:settings` | 模型配置、出图时机、界面开关等 |
| `ir:story-index` | 书架索引（标题、模式、回合数、更新时间） |
| `ir:current` | 上次打开的故事 id |
| `ir:user-profile` | 跨故事的玩家画像条目 |
| `ir:migrated-v2` | v0.1 → v0.2 迁移标记 |
| `ir:migrated-v3` | localStorage → IndexedDB 迁移标记（**只在 IndexedDB 的 `kv` 里**） |

`localStorage` 现在只承担两件事：① 升级前的旧数据（**只读，迁移后原样保留当回退快照，不再写入**）；② `infinite-reading-v1:*` 旧版键（仅用于一次性迁移）。

### 4.2 story schema（`Store.newStory`；`SCHEMA` = 3，分支树起）

顶层字段：`schema, id, title, premise, mode(choice|chat|rp), createdAt, updatedAt, log[], world{}, styleCard, rollingStyle{}, styleTone, characterCard, userProfile[], painterThread[], messages[], summaries[], savepoints[], ui{}, turn, scenes[], lastBg, lastSceneSummary, tree{}`。

- `world`（世界状态卡）：`place, time, characters[], threads[], relationship{stage,bonds,notes}, scene, updatedAt, scribeAt`。
- `ui`（随故事记住的界面状态）：`kind`（`do|say|direct`，输入框左侧的做 / 说 / 导演）；旧版遗留的 `split / showImage / immersive` 原样保留但不读取——布局已统一到 `settings.ui`（`layout / splitRatio / imageCollapsed / choices`）。
- `tree`（分支树，schema 3 起）：回合树是**唯一真源**（`root / head / nodes / states`），`log / messages / scenes / world / summaries / …` 全是「根 → head」路径的投影（`IR.Tree.project`）。重试 = 在同一父节点下新增兄弟节点；有兄弟的回合用 ‹ n/m › 切换。无 tree 的旧档由 `IR.Tree.ensure` 幂等迁移成线性链（末条旁白 `versions > 1` 展开成兄弟、旧存档点按 `sp.turn` 映射 `nodeId`）。
- 写盘前经 `serializeStory` 裁剪：`log` 只保留末 120 条、图片的 `src` 置空（缩略图另存）、`scenes` 只保留末 12 张、`savepoints` 只保留末 5 个；**裁剪不作用在 `tree` 上**（树里按节点存着全量条目 / 场景元数据）。
- 旧存档由 `migrateStory` / `migrateSettings` / `migrateLegacy` 升级（`migrateStory` 原样透传 `tree`，不校验），**改动结构必须同步升级 `SCHEMA` 与迁移函数**。

### 4.3 对外交换格式

| 文件 | 生成 | 结构 |
|---|---|---|
| `.irstory.json` | `buildExportPack` / `doExport` | `{format:'ir-story', schema:2, kind:'full'\|'premise', title, premise, mode, styleTone, world, styleCard, rollingStyle, characterCard, images[], …}` |
| `.irbackup.json` | `buildBackupPack` / `doBackupAll` | `{format:'ir-backup', schema:1, app, exportedAt, settings, userProfile, stories[]}`，默认剥掉 API Key |
| `.irbackup.zip` | `buildBackupZip` / `doBackupAll`（勾选「带上原图」） | 同一个包里两样东西：`ir-backup.json`（同上，`schema:2` 多一份 `images:[{id, path, type, size}]` 清单）+ `images/0001.png…`（原图按二进制原样存放，**不转 base64**） |

导入统一走 `handleImportFile` → `applyImport`，按 `format` 分派：备份整体还原、`kind:'premise'` 进开局向导、其余建新档续玩。`.zip` 由 `handleImportFile` 先判扩展名 → `importZipFile` 解包取 `ir-backup.json`，再走同一条 `applyBackupImport(obj, entries)`，原图按清单写回 IndexedDB。

## 5. 关键不变量（改动时别碰坏）

| 不变量 | 位置 | 为什么 |
|---|---|---|
| **不把 `tool_calls` 写进历史** | `app.js`：`slimReply`、`assistantMessage` | assistant 消息带 `tool_calls` 却没有配对 `tool` 结果会触发 400；工具调用只留一条 `{type:'tool'}` 日志 |
| **`reasoning` 不进请求体** | `context.js`：`assembleAI1` 只取 `role/content` | 思考链只用于显示 |
| **压缩阈值 70%，保留窗口按 token 自适应** | `context.js`：`COMPRESS_RATIO`、`fitWindow`、`planCompression` | 已知容量时组装窗口按 token 动态（最多吃窗口一半，条数 ∈ [4, 40]），未知退回 8 条（评测口径不变）；超预算但无可压时降级保留窗口自救；组装前先查预算、超了就地先压再组 |
| **每轮工具调用上限 2 次** | `context.js`：`MAX_TOOL_CALLS_PER_TURN` | 防止模型反复调工具烧钱；超限调用留痕并告知模型，不静默丢弃 |
| **工具结果按语义分流** | `app.js`：`callAI1` | `recall_*` / `request_image` 调了就注入重发（模型要的信息 / 产物）；`update_memory` / 调度工具仅无正文时重发；重发永不再带工具 |
| **同轮去重**：工具已出图则跳过时机出图 | `app.js`：`turnPaintedByTool`、`maybeEnqueueImage` | 一回合只画一张 |
| **`tools` 降级**：显式 400 拒绝的模型记入「黑名单」 | `app.js`：`isToolsRejection`、`rememberNoTools`、`noToolsFor` | 试错降级，不做预探测 |
| **画像三条纪律**：存储不设上限 / 注入有预算 / 常驻仅一行摘要 | `context.js`：`profileBlock`、`PROFILE_TOP_N`、`PROFILE_MAX_CHARS` | 画像不能吃光预算 |
| **不预置模型名与厂商参数** | `modelCapabilities.js`（表默认空）、`store.js` 默认 provider | 参数随厂商变动，宁可留空让用户填 |
| **换档保护** | `app.js`：生图 / 书记员结果写回前核对 `storyId` | 切换故事时不污染新档 |
| **AI 文本一律 `textContent` 渲染** | `app.js` 渲染函数 | 模型输出与导入内容不可信，禁止拼 `innerHTML` |
| **树是唯一真源，其余字段是投影** | `js/tree.js`：`project` / `stateOf`；`app.js` 只读投影 | 切分支 = 换 head + 重新投影，既有读取点一行不改；条目与消息**按引用共享**（就地修改落树上），**State 才 clone**（`world` 会被 `mergeWorld` 原地改写，绝不存引用） |
| **`seal` 必须在 `postTurn` 之后** | `app.js`：`sendPlayerAction` / `retryLast` | 书记员 / 压缩会改 `world / summaries / messages` 并往 log 追加 tool 条目，先 seal 存的是「半结算」状态 |
| **全树图集必须含非当前分支** | `store.js`：`imageIdsOf` / `knownImageIds`、`js/tree.js`：`imageIdsOf` | 漏掉 `tree.nodes[*]` 的 scenes / entries 图引用就会**静默删掉别的分支的图**（清理孤儿 / 删除 / 备份共用一条口径） |
| **晚到条目 / 画面带 `nodeId` 校验** | `app.js`：`runPaint` / `generateScene` 写回、`js/tree.js`：`pushLate` | 节点不存在 → 丢弃；已 sealed 且不在当前路径 → 只写节点，不得泄漏进当前 log |

## 6. 上下文策略速览

`Context.assembleAI1` 由这几层自上而下拼成（从贵到便宜）：

1. **模式系统提示词** `systemForMode`：剧情 / 对话 / 扮演三套人格与输出契约（剧情模式为中文键 `旁白 / 选项 / 场景切换`；对话 / 扮演是「伴读者」定位 + 2~6 句体量锚定，扮演无角色卡时用降级提示词）。
2. **风格基调 + 故事设定常驻**：`[风格基调]`（≤120 字）与 `[故事设定（常驻）]`（≤400 字摘要）——地基信息不随摘要合并流失。
3. **世界状态卡** + **当前情势一行** `buildSummaryLine`。
4. **前情摘要栈** `summaries[]`（`trimSummaries` 限长）。
5. **C-E 启发式注入** `matchEntityTerms` + `heuristicBlock`：玩家话里出现世界卡实体词时，按条数上限带回对应条目；无实体词则零成本不注入。
6. **按需召回**：由 `recall_world_state` / `recall_style_card` 工具触发，客户端以「单次重发」实现。
7. **最近消息窗口**：已知容量时按 token 动态装（最多吃窗口一半，条数 ∈ [4, 40]），未知退回 8 条；更早的内容在超过 70% 预算时由 `compressStory` 压进摘要栈（组装前先查预算、超了先压再组）。

召回结果、工具回传、启发式与强制注入统一**并入本轮 user 消息前缀**（不插中段 system 块，规避兼容层吞中段 system）。

扮演模式额外常驻角色卡与关系记忆（`characterCardText` / `relationshipBlock`），剧情与对话模式不常驻，避免涨预算。

## 7. 离线演示模式（`?demo=1`）

`js/demo.js` 用「**换适配器**」而不是「分叉业务逻辑」的方式实现零安装演示——演示不是另一套 App，而是同一条链路接了两个假适配器：

| 项 | 做法 |
|---|---|
| 判定 | `IR.Demo.enabled()` 读 `location.search`（`?demo=1` / `?demo` / `?demo=true`） |
| 对话 | 注册 `ChatProviders['demo']`，按**提示词特征**分派：system 含「AI 画师导演」→ 画师任务（场景 / 工作台 / 试画 / 设定卡各有内置回包）；含「书记员」→ 返回空串，让本地规则兜底；user 消息以 `[玩家行动]` / `[设定]` 开头 → AI1，按**调用序号**推进内置剧本（不依赖历史长度，压缩后也不会错位） |
| 生图 | 注册 `ImageProviders['demo-image']`，用 canvas 现画一张带提示词的占位图并返回 dataURL，出图链路（缩略图、背景淡入、图库）完全一致 |
| 设置 | `IR.Demo.applyTo(settings)` 返回**副本**：对话 / 生图换成演示适配器、子模型留空沿用、关掉工具；`app.js` 的 `persistSettings()` 在演示模式直接 return，配置永不落盘 |
| 入口 | `init()` 检测到演示模式就直接 `startDemo()`（跳过开始页与试画锚定）；顶栏「🎬 演示」与开始页「🎬 离线演示」是进出这个模式的开关 |

推论：**新增功能只要走适配器层，演示模式就自动跟着一起走**。反过来，如果哪天演示跑不通，多半说明有人绕过了适配器层——这是个便宜的一致性检查。

本地服务的三个功能也照这条办：`?demo=1` 下不连真实 sidecar（保持零外联），而是由 `IR.Demo.installSidecarMock()` 把 `IR.Sidecar` 换成一整套**内存实现**（同一批方法名、同样走保守策略），因此「写邮件 / 定时主动 / 代下单」的界面链路在演示模式下也能完整跑一遍。

`eval/demo-smoke.js` 在 Node 里不放浏览器地跑这套契约（24 项，含「demo 走 3 回合 → 重试 → 切换 → 再切回」的分支树链路），已接入 CI。

## 8. 评测如何做

`eval/run.js` 只 `require` 纯逻辑模块（`context.js` / `store.js` / `roleCard.js`），不加载 `app.js`，因此**不发任何网络请求**：

- 重放 `eval/mock-story.js` 的 32 回合剧本，与运行时同样地调用 `assembleAI1` / `compressStory`；
- 在第 10 / 20 / 30 回合插入「追问回合」，检查组装出的 prompt 是否命中 5 类探针（角色名 / 时间设定 / 伏笔原话 / 地点细节 / 玩家自己说过的事）；
- `checkHeuristic` 校验 C-E 启发式注入的命中与「零注入」；`checkP7` 校验角色卡解析（自造 V2/V3 PNG）与画像预算 / 合并 / 本地提取；
- 输出总分并与 v0.1 基线（60.0%）对比；低于基线或校验未全中时返回非 0 退出码（CI 据此拦截回归）。

改记忆、压缩、召回相关代码前请先跑 `node eval/run.js`。

## 9. PWA 与离线缓存（`sw.js`）

PWA 是「装个帽子」，不是「换条路」：`js/pwa.js` 在 https / `localhost` 下注册 `sw.js`，`file://` 直接跳过，**业务代码一行都不用改**。

| 请求类型 | 策略 | 为什么 |
|---|---|---|
| 导航（打开页面，含 `?demo=1`） | 网络优先 → 断网回退预缓存的 `index.html` | 网络优先保证「改了立刻生效」，绝不被缓存卡住 |
| 同源静态资源（CSS / JS / 图标 / manifest） | 缓存优先 + 后台静默更新（SWR） | 秒开；`?v=` 版本串本身就是失效开关 |
| 跨域（对话 / 生图 API、字体 CDN） | 不拦截、不缓存 | **API Key 与剧情文本绝不进缓存** |
| 非 GET | 不拦截 | 上传/导入走原路 |

预缓存清单**不写死在 SW 里**，而是 `install` 时抓 `index.html`、用正则解析出里面所有 `css/` `js/` `icons/` 资源（含 `?v=`）再逐个缓存——清单跟着页面走，不存在「两份清单不同步」的问题。

`CACHE` 名（`ir-v<版本>`）由 `tools/sync-version.mjs` 从 `VERSION` 注入：版本一变就换缓存、`activate` 时清掉旧的，等价于「跟着发布节奏清缓存」。**改前端资源后如果本地看到旧文件，先怀疑 Service Worker**（DevTools → Application → Service Workers → Unregister）。

## 10. 想扩展的话

- **接新的模型服务**：在 `js/providers.js` 的 `ChatProviders` / `ImageProviders` 上注册一个 key，保持签名 `chat(cfg, messages, hooks)` / `generate(cfg, prompt)`；再在设置面板的 provider 选项里加上它。不需要改 `app.js` 的业务逻辑。
- **视频**：`IR.VideoProviders` 的约定是 `generate(cfg, {prompt, image}) -> {url}`（异步任务型 API 需自行轮询），目前为空。
- **主题**：`css/style.css` 顶部的 CSS 变量就是主题入口（「纸白主题」在 Backlog 里）。
- **格式与内容**：`.irstory.json` / 角色卡的解析入口集中在 `store.js` 与 `roleCard.js`，新增字段请同步 `migrateStory`。

## 11. 已知边界

- **主库是 IndexedDB**（`js/storage.js` + `js/store.js`），容量由浏览器按磁盘空间分配，不再受 localStorage 约 5MB 限制；但这仍是**本机这个浏览器**的额度，且**不是无限大**——浏览器、设备剩余空间与存储策略都会影响它。旧版数据留在 localStorage 里作为回退快照，不再写入。
- `file://` / `http://localhost` / 未来桌面壳的 origin 各不相同，数据天然隔离，只能靠导入导出搬运（**IndexedDB 也按 origin 隔离**）。
- 浏览器直连第三方 API 会被 CORS 拦，无法在纯前端层面解决。
- API Key 明文存 IndexedDB（详见 [`SECURITY.md`](SECURITY.md)）。

## 12. 可选本地服务（sidecar）

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

**工具通道的取舍**：调度保留 5 个模型工具（`schedule_once` / `schedule_heartbeat` / `schedule_cron` / `list_triggers` / `cancel_trigger`），但**只在 `chat` / `rp` 模式且侧车在线时下发**，且模型新建的触发器一律是 `pending_confirm`，需用户在界面上点确认才生效。邮件与支付**不做成模型工具**——它们是高风险副作用动作，一律走「用户显式发起（界面按钮）→ 确认弹窗 → 执行」，模型最多只能在回复里建议。因此 `MAX_TOOL_CALLS_PER_TURN` 仍是 2。

**页面关闭时**：侧车到点只把触发**写入待处理队列**（不打扰、不猜）；前端下次打开时按 `SKIP / RUN_ONCE / RUN_ALL` 补跑，补跑时走的是与真实用户消息完全相同的回合链路（合成一条入站消息 → `sendPlayerAction`）。「页面开着」则由 SSE 实时推送 `trigger.fire`。这一处做成了可替换的策略点（见 `scheduler.mjs` 的 `missedPolicy`）。

**测试**：`eval/scheduler-test.js`（虚拟时钟）、`eval/email-test.js`、`eval/payment-test.js`（策略边界）、`eval/sidecar-smoke.js`（真启子进程走 HTTP）、`eval/frontend-smoke.js`（假 fetch 验离线降级与工具门控），全部接入 `npm test`。
