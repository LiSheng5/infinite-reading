# 更新日志

## [0.11.0] — 2026-10-21 · P-1：画师代理改为「点按钮才动」（剧情模式不再自动出图）

### Changed

- **默认行为改动：剧情模式不再自动出图**（回合结束与开局都不再出图）。此前「每轮 / 做出选择后」的时机出图与开局第一张图都会在用户没要求时花一次画师构思 + 一次生图的钱；现在剧情模式的作画**只能**由用户触发——舞台右上角「🎨」（或「⋯ → 为当前场景作画」）与画师工作台的「按此重画 / 按设定卡强制重画」。开局后统一提示「已开局。想看画面随时点右上角「作画」。」；舞台没有图时显示引导「点 🎨 为当前场景画一张」（有图后消失）。
- **「出图时机」设置整体下线**：全局设置与本对话设置里的「出图时机」单选删除；`settings.trigger` 与 `story.prefs.trigger` 停止读写，旧值原样留在存档里（不读、不删，与 `split / showImage` 旧字段同一处理方式）；`defaultSettings` 不再写 `trigger`，`PREF_KEYS` 去掉 `trigger`（导入带 `trigger` 的旧包按未知键丢弃、不报错）。
- **剧情模型不再能请求作画**：`toolsForMode('choice')` 与 `TOOLS_AI1` 去掉 `request_image`（画师变体 `REQUEST_IMAGE_TOOL` 删除），剧情系统提示与工具说明里的「请画师作画 / 调用 request_image」措辞一并清理；对话 / 扮演的直出变体保持不变。模型若照旧会话历史仍调了 `request_image`（或不听话）：按「该工具不可用」回传，**不入队、不报错、不弹 toast**。
- **顶栏不再显示故事标题**：游戏页左上角的标题文字（如「雨夜便利店」）在所有模式下都不再出现，只留「← / 书架 / 模式标签」（`#hud-title` 与 `.story-title` 样式一并删除）。
- **进入剧情模式不再自动生成第一幕**：此前新建（首页设定 / 向导 / 文本导入）或刷新回到空档都会自动跑一次 `runOpening`，用户还没输入就花掉一次调用。现在进入只显示「▶ 开始第一幕」按钮，点了才生成（也可以直接在输入框写下第一个行动）；试画锚定关闭后同样回到按钮。离线演示（`?demo=1`）保持自动开局。见 `js/app/render.js` 的 `renderOpeningHint`。
- **画师上下文规则收紧（scene 模式）**：每次调用的输入只含 `PAINTER_SYSTEM` + `[画风锚]` + `[最近两张图]` + `[最近剧情]` + `[画面参考]` / `[画风要求]`。`[最近剧情]` 从「最近 3 条旁白」改为**最近 3 回合的「玩家行动 + 旁白」**（`PAINTER_RECENT_TURNS = 3`，`context.js` 顶部一处可调）：玩家行动保留（做）/（说）/（导演）类型标记，每条截断 200 字（`PAINTER_RECENT_LINE_CHARS`），按时间顺序——「（导演）外面下起暴雨」这类信息此前画师看不到。更早的对话、世界卡全文、摘要栈、剧情规则提示词、用户画像一律不进画师上下文；工作台对话（chat 模式）保持 `recall_recent_plot` 不动。

### Removed

- `turn.js` 的 `maybeEnqueueImage`（时机出图）与 `round.js` 的开局出图分支；`S.turnPaintedByTool`（工具 / 时机出图去重）与 `S.lastActionWasChoice`（时机出图判定）在没有读者后一并从 `core.js` 删除。
- `submitToolPaint` 里 `direct === false` 的画师分支（死代码）；「构思 → 出图」仍集中在 `runPaintTask` 一处。
- 设置控件清单里的 radio 组 `s-trigger`（`eval/settings-ids-test.js` 同步冻结清单变化）。

### Added

- **舞台空状态引导**：没有图时显示「点 🎨 为当前场景画一张」（草案文案），有图后消失；出现淡入走 UI-1 动效令牌与动效等级（off 不动）。
- **世界状态卡不再是一张空白卡**：新增 `Store.seedWorldFromPremise()`（纯本地规则、不花 API）：新建剧情故事时把设定里的「世界 / 时间 / 伏笔 / 你的角色 / AI 扮演 / 人物」解析进世界卡（地点、画面参考、关系备注、人物），已有值不覆盖；人物栏为空时给出「书记员校对会补」的占位提示。
- **生视频模型设置（预留）**：全局设置「生图与画风」新增 `settings.video`（Base URL / 模型 / API Key / 自定义请求参数）与对应表单，配置照常保存并纳入备份（「不带 Key」时同样剥离）；`VideoProviders` 尚未实现，面板里明确标注「暂不出视频」。
- `eval/painter-context-test.js`（新，Node 不联网）：固定 §4 的画师上下文规则（最近 3 回合 / 类型标记 / 200 字截断 / 隔离清单 / 未锚定降级）+ 静态断言（`turn.js` / `round.js` 不再调用 `enqueueImage`）；已接入 `npm test` 与 CI。

## [0.10.0] — 2026-10-21 · UI-4：分支页（整页分支树 + 从任意节点继续 / 改我说的分叉）

### Added

- **分支页**（游戏页顶栏「⋯ → 分支」；书架行「⋯ → 分支」会先打开该对话再叠分支页）：整页覆盖层的 git-graph 式分支树——主干 = 当前路径固定在 lane 0，其他分支从分叉点向右延伸（`js/treeLayout.js` 纯逻辑布局：泳道贪心 + 区间打包、子树结束后泳道可复用、嵌套分叉不交叉）；每个节点是一回合（圆点 + 右侧标签）。顶栏「← 返回对话」｜标题｜缩小 / 放大（0.5×–2×，`Ctrl/Cmd+滚轮` / 双指缩放、滚轮平移、拖拽平移）｜「回到当前」｜「展开全部折叠」。长单链（≥8 个不含 head / 书签 / 选中的单链节点）折叠成「··· N 回合」超级节点，点击展开（纯视图态，不进存档）。
- **节点面板**（桌面右侧停靠 360px；窄屏底部弹层）：回合序号 / 玩家行动 / AI 回复预览（400 字）/ 时间 / 模型（`meta.model`），三个操作——**回到这里并从此继续**（`switchTo` 落到该节点、不下探，聊天页进入历史位置）、**改我说的，从这之前分叉**（`forkBefore` 落到 parent，输入框预填原话并还原「做 / 说 / 导演」，`setComposerText` 不触发发送）、**切到这条分支的最新处**（`latestLeaf` 沿 `active` 下探到叶子）。
- **历史位置提示条**：`head` 有孩子时输入框上方显示「你在第 N 回合的历史位置 · 继续发送会创建新分支　[回到最新]」；历史位置发送**直接开新分支**（不弹确认），发送后提示条消失、「回到最新」= `switchTo(latestLeaf(head))`。
- **搜索结果跳转补完**（UI-2 §3.7）：命中节点在当前路径且在可见窗口内 → 滚动 + 高亮；否则打开对话并**直接进分支页**选中该节点（不自动 `switchTo`，由用户决定继续 / 分叉 / 切最新）。原「分支页上线后可直接跳转」toast 移除。
- **树语义 API**（`js/tree.js`，Node 可测）：`latestLeaf` / `forkBefore` / `canResume`；用测试固定「站在非叶子继续 = 新分支」（`commit` 以 head 为 parent、`parent.active` 更新、原孩子与子树不变）。`canResume`（纯函数）拦住 `sid === null` 的旧档迁移节点（只许查看，两个继续类操作置灰），「改我说的」连 parent 落点一起拦。
- **键盘与无障碍**：`↑` 父节点、`↓` 沿 `active` 的孩子、`←` `→` 兄弟间移动、`Enter` 开节点面板、`Esc` 关面板 / 返回对话；`role="tree"` / `treeitem` + `aria-activedescendant`；键盘移动到屏幕外会先把节点滚进视野。
- **动效**（走 UI-1 令牌）：rich = 边按深度描边生长（封顶 ~600ms）+ 节点弹簧弹出（新节点单独「长出来」）+ 当前路径**合成一条 path** 的流光 + head 呼吸 / 选中脉冲（同屏循环 ≤ 3）；standard = 整体淡入；off = 无。`data-paused` 全局暂停；>400 节点视口裁剪。
- 测试与工具：`eval/treelayout-test.js`（泳道 / 折叠 / 标签 / 确定性 / 2000 节点 < 500ms / 损坏输入）、`eval/tree-test.js` 增补 5 组（UI-4 §8）、`tools/make-big-tree.mjs`（~800 节点多层嵌套分叉的 `.irstory.json`，性能验收用），均接入 `npm test` 与 CI。

### Changed

- `js/tree.js` 导出表增加 `latestLeaf` / `forkBefore` / `canResume`；`commit` 注释明确「parent = 当前 head」即历史位置继续 = 新分支（行为未变，用测试固定）。
- `openStory(id, opts)` 支持 `opts.focusNodeId`（兼容旧 `opts.nid`）；新增 `js/app/branch.js`（分支页）与 `js/treeLayout.js`（布局纯逻辑）。

### Notes

- 删除 / 合并 / 重命名分支、缩略小地图、分支标签、跨对话的图不在本期（另开任务）。
- 任务书里 §4.4 的「分支语义」写进 `ARCHITECTURE.md` §4.5；提示条 / 面板按钮文案见交付报告「草案文案」一节。

## [0.9.0] — 2026-10-21 · UI-3：设置分层（全局 / 本对话）+ 模型库 + 页面布局

**设置分层**

- 新增**本对话设置**（游戏页顶栏「⋯ → 本对话设置」）：桌面右侧停靠面板（约 360px，从右滑入），窄屏（≤720px）底部弹层；内容按模式只显示相关项——剧情：模型 / 出图时机 / 画风入口 / 推进模式 / 选项显示 / 显示思考过程 / 页面布局（四种 + 比例 + 舞台收起）；扮演：模型 / 角色卡入口 / 显示思考过程 / 定时主动开关 / 页面布局（字号 / 宽度 / 密度）；智能体：模型 / 工具开关（生图 / 记忆 / 定时 / 邮件 / 下单，只显示全局可用的）/ 显示思考过程 / 页面布局（字号 / 宽度 / 密度）。每个可覆盖项带「跟随全局 ✓」状态，点「重置」即回到全局默认；换模型「从下一条消息起生效」。
- 新增**模型库（profiles）**：全局设置里管理多套主模型（新增 / 编辑 / 复制 / 删除；删除在用的会弹确认并列出受影响的对话，确认后它们回退默认模型）。每个对话可在本对话设置里选自己的模型，不选跟随默认主模型。
- **全局设置重组**：单页长表单 → 左侧分组导航 + 右侧分组面板（模型库 / 辅助模型 / 生图与画风 / 工具与服务 / 数据 / 外观 / 当前故事）；窄屏是「分组列表 → 详情」下钻。**全部控件 id 不变**（`eval/settings-ids-test.js` 冻结清单护栏 + 运行时逐项读回回归）。
- **页面布局分层**：剧情沿用四种布局 + 双栏比例 + 舞台收起 + 选项显示；扮演 / 智能体新增字号（小 / 中 / 大）、内容宽度（窄 / 标准 / 宽）、密度（紧凑 / 标准）——由 `--font-scale / --content-w / --density` 令牌驱动，不为每档写样式。全局给默认（外观分组），本对话可覆盖。

**数据与安全**

- `story.prefs`（全部可选、缺省 = 跟随全局）：`profileId`（**只存引用 id**）+ `profileLabel`、`trigger`、`choices`、`showReasoning`、`tools{…}`、`ui{…}`；`migrateStory` 透传并清洗（丢未知键、剥凭证形字段），旧档 / 导入包无 `prefs` 不报错。
- **密钥红线**：故事导出 / 分享包整包剥 `apiKey / key / token / baseUrl`（任意嵌套层级），`prefs` 只带 `profileId + profileLabel`；导入到没有该 profile 的环境自动回退默认并在本对话设置里提示「原对话使用的模型 X 在本机不存在」。整库备份行为不变（默认剥 Key，勾选才带），剥除范围覆盖新增的模型库。
- 主模型请求一律走 `IR.Prefs.resolveChatCfg`（回合 / 重试 / 主动消息 / 工具重发）；压缩阈值等派生量跟随有效配置；回合节点 `meta.model` 记本回合模型名（分支页可显示）。工具下发 = 全局可用性 ∩ 本对话工具开关。
- 新增纯逻辑模块 `js/prefs.js`（Node 可测）与 `eval/prefs-test.js`、`eval/settings-ids-test.js`；`js/context.js` 抽出纯函数 `compressThreshold`。

**修复（验收中发现）**

- `userProfile.enabled = 'all'` 经 `migrateSettings` 后被拆成索引键，刷新后三个模式勾全丢——现在原样保留 `'all'`。
- 手改世界卡（保存世界卡）在刷新 / 切分支后会被树投影回滚——现在 `saveWorldFromForm` 会 `IR.Tree.resyncState` 把 head 的内联状态换成当前值。
- 本对话设置面板此前会盖住全局设置弹窗与输入区（z-index / 停靠让位）；窄屏触控目标不足 40px 一并补齐。

## [0.8.0] — 2026-10-20 · UI-2：书架改版（会话列表 + 自动标题 + 全文搜索 + 新建弹层）

### Added

- **书架变「会话列表」**（`js/app/shelf.js`）：顶栏「书架」标题 + 搜索框（上限约 560px）+「＋ 新建」/ 导入 / 设置；下面按 `updatedAt` 分组（今天 / 昨天 / 过去 7 天 / 更早），组头吸顶（轻微毛玻璃，`backdrop-filter` 只用在组头一个元素上）。行 = 56px 缩略图（无图显模式图标）+ 标题（单行省略）+ `[模式] · 第 N 回合 · 相对时间` + 一行摘要（≤60 字）；点整行打开，右侧「⋯」菜单（重命名 / 重新生成标题 / 导出 / 删除，取代旧卡片四按钮；桌面悬停显示、触屏常显）；当前对话（`Store.getCurrentId()`）左边蓝色标记；空状态一句话 + 「＋ 新建」大按钮；超过约 300 条时「更早」默认只渲染前 100 条 + 「展开更多」。
- **自动标题**（`js/titles.js` / `IR.Titles`，纯逻辑、Node 可测）：新建的**智能体 / 扮演**对话初始标题「新对话」（`titleAuto = true`），回合 `turn === 1` / `turn === 6` 在 `seal` 之后异步触发小模型（`resolveSub('scribe')`）起标题；输出经 `sanitize` 清洗（引号 / 书名号 / markdown / 结尾标点 / 码点截断），失败走本地 `fallback`（首条用户话前 15 字 + …）。**不占用 `busy`、不阻塞下一次发送**，每个故事同时只有一个标题任务；写回护栏（`applyTitle`）核 `story.id` 一致且 `titleAuto` 仍为真（用户改过名就丢弃结果）。书记员未启用 / 无 key / 无模型 → 直接本地兜底**不发任何网络请求**；模型失败静默、不计次。标题从「新对话」变结果时**打字机式替换**（rich 逐字；standard 淡入替换）。
- **全文搜索**（`js/search.js` / `IR.Search`，纯逻辑、Node 可测）：标题 + 正文（**含所有分支**节点）子串匹配、多词 AND、NFKC / 小写 / 折叠空白规整；标题命中权重 ×5、正文命中次数封顶、同分按更新时间；每结果最多 2 条片段，片段带 `[start,end]` `ranges`（**输出零 HTML**，UI 用 `createElement('mark')` + `textContent` 高亮）。内存索引不持久化：首次聚焦搜索框惰性构建（每批 ~5 个故事让出主线程），`saveStory` 后防抖 ~800ms 增量重建该 id，`deleteStory` 同步移除。查询非空时结果列表替换分组列表（交叉淡入）。
- **搜索结果点击（本期范围）**：打开对话停在当前 head；命中节点在当前路径且在可见窗口内 → 滚动到该消息并短暂高亮（蓝色描边淡出）；否则打开对话并 toast「该处在较早历史或其他分支，分支页上线后可直接跳转」（**不**挪 head，避免下一次发送意外分叉；完整跳转 UI-4 做）。
- **「＋ 新建」弹层**：三张模式卡（剧情 / 智能体 / 扮演）进入**现有**创建流程（剧情开局向导 / 扮演角色卡 / 智能体直接开始），流程本身不动；≤720px 底部弹层、其余居中弹窗，`Esc` / 点遮罩关闭。
- **键盘（桌面）**：`/` 或 `Ctrl/Cmd+K` 聚焦搜索；搜索框内 `↑ ↓` 移动（`role="listbox"` / `option` + `aria-activedescendant`）、`Enter` 打开、`Esc` 清空回列表；列表行 Tab 聚焦、`Enter` 打开、`Shift+F10` / `ContextMenu` 开「⋯」。
- **索引条目扩充**（`js/store.js`）：`ir:story-index` 增加 `mode / turn / titleAuto / snippet`，`renderShelf` 只读索引（不再对每个故事 `loadStory`）；`snippet` 每次 `saveStory` 重算（切兄弟 / 重试会变，不缓存）；旧索引条目由 `Store.ensureIndexComplete` 按需补齐并整体回写一次（幂等，坏条目 / 丢失故事剔除并记录）；`deleteStory` 同步清理索引与搜索文档。
- **动效**（走 UI-1 令牌，rich 档启用）：列表行错峰淡入上移（总时长封顶 ~600ms，只对首屏行）；标题打字机替换；搜索结果 ↔ 分组列表交叉淡入；「⋯」菜单 / 弹层沿用 UI-1 手感。
- 测试：`eval/titles-test.js`（38 项）、`eval/search-test.js`（22 项，含 50×500 节点性能健全性）、`eval/shelf-index-test.js`（18 项），已接入 `npm test` 与 CI（`npm run test:shelf`）。

### Changed

- 旧 `#shelf-grid` 卡片结构移除（「继续 / 改名 / 导出 / 删除」四小按钮由「⋯」菜单取代）；`renderShelf` / `openStory` 从 `js/app/library.js` 迁到新的 `js/app/shelf.js`。
- 剧情模式助手内容是 JSON 的地方（摘要、搜索文档、标题素材）统一「容错解析出旁白，失败当纯文本」，不再把 `{"narration":…` 原样塞进列表 / 搜索。

### Notes

- 与任务书假设的差异：`renderShelf` / `openStory` 实际位于 `js/app/library.js`（0.7.1 已拆分），本次新增 `js/app/shelf.js` 承载书架页（`js/app/library.js` 行数上限 800 会超）；`genChain` 在代码库中不存在，标题任务独立于 `PaintQueue`。详见交付报告。

## [0.7.1] — 2026-10-20 · 内部结构拆分：js/app.js → js/app/*.js（行为不变）

### Changed

- 内部结构拆分，**行为、DOM、文案、样式一行不变**：原 6284 行的 `js/app.js` 按功能节拆成 `js/app/` 下 15 个经典脚本（IIFE）+ 组合根 `js/app.js`（仅事件绑定与启动，478 行）。
- 共享状态集中在 `IR.App.state`（`S.xxx`），跨模块调用一律走 `IR.App` 注册表晚绑定（`A.xxx()`）；`core.js` 最先加载并提供工具与常量，`app.js` 最后加载。
- 新增 `eval/app-structure-test.js`（脚本顺序 / 行数上限 / `A.reg` 唯一 / 顶层解构白名单 / `A.xxx` 引用闭合 / 语法）与 `tools/check-free-calls.mjs`（裸调用启发式检查，允许名单 `tools/free-calls-allow.json`），均已接入 `npm test` 与 CI。
- 唯一超出「纯搬家」的代码改动：10 个函数内局部 `const S = IR.Sidecar` 改名为 `const SC`（51 处引用同步改名），消除与 `S = IR.App.state` 的撞名；除此之外无任何逻辑改动。

### 已知取舍

- 拆分时新增了 `js/app/round.js`（回合编排：`callAI1` / `sendPlayerAction` / `runOpening` / 工具执行 / 旁白收尾），任务书模块表未列——合并进 `turn.js` 会超过 800 行上限，故独立成模块。
- codemod 搬家时把源文件相邻的整块注释一并带进了部分模块（纯注释副本，无代码），不影响行为。

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 与 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的写法。
版本号真源是根目录的 `VERSION` 文件，发布时打同名 tag（如 `v0.2.0`）。

## [0.7.0] — 2026-10-20 · UI-1：白底蓝强调配色 + 动效基座

### Changed

- **全站配色换成「白做底、蓝做强调、黑做文字和主按钮」**（`css/style.css` 的 `:root`）：底 `#FFFFFF`、面 `#F5F7FA` / `#EEF2F7`、文字 `#0B0F19` / `#5B6678`、强调 `#2563EB`。旧的暖金强调与暗色取值全部废弃；主按钮改**黑底白字**（新令牌 `--on-ink`），蓝色只做强调。`<meta name="theme-color">`、`manifest.webmanifest` 的 `theme_color / background_color` 一并换成 `#FFFFFF`，并新增 `<meta name="color-scheme" content="light">` 与 `:root { color-scheme: light }`。
- **清理 `:root` 之外的所有颜色字面量**（原约 19 处）：滚动条、悬停底、按钮字色、弹窗 / 灯箱 / 沉浸遮罩、舞台按钮与暗角渐变等全部改走令牌（图上叠层遮罩保留专用令牌 `--scrim` / `--lightbox-bg` / `--stage-*` / `--immersive-scrim`，并在测试里写明理由）。输入框 / 按钮描边改用 `--line-strong`（≥3:1）；accent-soft 选中底上的文字统一用 `ink`。
- **阴影改静态轻阴影令牌** `--shadow-1` / `--shadow-2`（旧 `--shadow` / `--shadow-hover` 合并掉）；所有 transition 的时长 / 缓动改用动效令牌，不再写死；`box-shadow` 与 `max-height` 退出 transition（动画属性白名单见不变量）。

### Added

- **动效基座**：动效令牌 `--dur-fast/base/slow`、`--ease-out/spring/inout`、`--loop-busy/kb/ambient`；三档动效强度 `<html data-motion="off|standard|rich">`（`js/motion.js` / `IR.Motion.resolve`，设置 `ui.motion` 默认 `'auto'`，跟随系统「减少动态效果」自动降级、可手动覆盖，显式选择优先）；`visibilitychange` 写 `html[data-paused]` 暂停循环动画；同屏循环动画 ≤ 3 个。
- **第一批动效**（只动 `transform` / `opacity`，图片 blur-up 的 `filter` 是唯一例外）：
  - **切兄弟滑动**：‹ › 切分支时聊天内容区按方向横向滑入（±24px + 透明度，`--dur-base`，WAAPI）；先切数据 + 重渲染再播入场，连点正确打断；off 档直接切换。
  - **流式文字逐段淡入**：增量包进 `<span class="delta">`（`createElement` + `textContent`）套 `fadeIn`，存活 span ≤ 200（更早的合并进前缀文本节点），流结束整体合并成单个文本节点；standard 档只对整个气泡做一次淡入，off 无。
  - **顶栏忙碌进度线 `#busy-line`**：busy 时不确定进度横向流动（rich）/ 透明度呼吸（standard）/ 静态细线（off）。
  - **图片**：缩略图 → 原图就绪 blur-up（`filter: blur(12px) → 0`）；换画交叉淡入；rich 档舞台当前图缓慢 Ken Burns（离屏 / `data-paused` 暂停）。
  - **环境光**（仅 rich）：舞台背后与空状态一层极淡蓝径向渐变缓慢漂移（`--ambient-glow`）。
  - **通用手感**：按钮按下 `scale(.97)`、悬停轻微上浮；弹窗入场 `--ease-spring`；toast 滑入。
- **自动护栏**（全部 Node、零依赖，已接入 `npm test` 与 CI）：`tools/contrast-check.mjs`（WCAG 对比度令牌对）、`eval/tokens-test.js`（必需令牌 / `:root` 之外无颜色字面量 / `@keyframes` 属性白名单 / 动效令牌存在性 / transition 禁动画重排属性）、`eval/motion-test.js`（`IR.Motion.resolve` 解析）。
- 设置「界面」分组新增**「动效强度」**下拉（跟随系统 / 关 / 标准 / 丰富）。

### Notes

- 暗色主题**只预留结构**（将来加 `[data-theme="dark"]` 一套令牌即可），本期不实现。
- 循环动画配额的取舍：作画胶囊 `#gen-status` 与「生成中…」胶囊去掉呼吸循环（保持静态胶囊），把循环预算留给 `#busy-line` + Ken Burns + 环境光。
- 与任务书假设的差异见 `交付报告-视觉与动效基座-v0.7.0.md`（JS 行内颜色在 `demo.js` 的 canvas 占位图里、app.js 业务代码本就无颜色字面量等）。

## [0.6.0] — 2026-10-19 · 智能体模式 + 扮演模式去画布：纯聊天布局、内联图、提案制邮件 / 下单

### Added

- **提案制邮件 / 下单（`js/proposals.js` / `IR.Proposals`，纯逻辑、Node 可 `require`）**：模型发起的邮件 / 下单**只能产生提案卡**，执行必须由用户点「确认」触发（一次点击 → 最多一次执行）。提案有过期时间（默认 30 分钟）、状态机 `pending → executing → done | failed / denied / expired`，确认幂等（连点 / 网络慢再点只执行一次）。邮件走 `emailDraft` → `emailSendDraft`（**绝不直发 `emailSend`**）；下单的 `paymentPurchase` 只出现在用户点击之后，返回 `needsApproval` 时会**再弹一次带额度余量的确认**，不得自动批准（拒绝走 `paymentDeny`）。提案卡显示**工具参数原值**（收件人 / 主题 / 正文；金额 / 商户 / 品类 / 商品），全部 `textContent` 渲染。测试：新增 `eval/proposals-test.js`（41 项，假 sidecar、Node 离线）。
- **模型工具 `email_propose` / `payment_propose`**（`js/context.js`）：只在**智能体（chat）模式 + 本地服务在线 + 对应 feature 开启且有 token** 时下发（扮演 / 剧情即便能力齐备也不给）；策略文本随 `[可用工具]` 块下发，强调「只是提案，用户确认前不会执行」。工具回传是「已提交，待用户确认」——确认前模型不得声称已发出 / 已付款。
- **智能体 / 扮演的内联图气泡 + 轻量灯箱**：chat / rp 没有画面区后，图片条目直接内联在聊天流里（`max-width: min(100%, 420px)`、保持比例、带 alt 说明行），点图 / 点说明开灯箱（固定遮罩 + 大图，点遮罩 / `Esc` 关闭）；大图优先取原图（IndexedDB），没有就用缩略图；`src` 只放行 `data:` / `blob:` / `https:`。剧情模式保持「缩略图 + 舞台」不变。
- **纯聊天布局 `data-layout="chat"`**：智能体 / 扮演隐藏舞台区、分隔条、「画面」按钮、沉浸相关按钮与缩略条，聊天列占满宽度；剧情模式的 `split / stack / immersive` 与设置里的布局选项**一行不动**（这两模式下设置里显示灰字「此模式没有画面区」）。
- **`stripKindMarker`（`js/context.js`）**：组装 chat 历史时剥掉 `[玩家行动] ` 之后紧跟的内层标记（（做）/（说）/（导演）），外层 `[玩家行动]` 前缀保持不变（`demo.js` 分派不受影响）；只剥开头那一个，正文中间出现的不动。

### Changed

- **「对话」模式更名为「智能体」**（`story.mode` 的内部 id 仍是 `'chat'`，存档 / 导出 / 迁移都不用动）：开始页与新建弹窗的模式卡、设置里的故事模式下拉、书架条目前缀、README 同步改名。模式卡一句话说明改为「带工具的助手：能画图、记事、定时、写邮件、下单（都要你确认）」。
- **智能体系统提示替换（`CHAT_SYSTEM`）**：从「伴读者 AI，顺着玩家的话推进剧情或话题」换成通用助手定位（回答直接简洁、不提「工具 / 函数」、发邮件与花钱只提请求等确认）。**已有的「对话」存档会在下一次发消息起使用新的系统提示。**扮演（rp）与剧情（choice）的系统提示不变。
- **chat 不再有做 / 说 / 导演**：`#kind-switch` 在智能体模式隐藏；发给模型的玩家行动不再加内层标记（`story.ui.kind` 保留不清，切回剧情模式照常）；玩家条目的 `kind` 恒为 `'do'`。`systemForMode('chat')` 不再附标记说明（rp / choice 不变）。
- **「＋」菜单按模式收窄**：「✉ 写邮件」「🛒 代下单」两项**只在智能体（chat）下显示**，扮演（rp）只留「⏰ 定时主动」（**rp 的行为变更**：此前 rp 也能打开手写邮件 / 下单表单）。手写邮件 / 下单表单本身的行为不动。
- **运行中切模式即时生效**：剧情 ↔ 智能体 / 扮演来回切，舞台和图都还在（`story.scenes / lastBg` 不动，只是不显示），布局与做 / 说 / 导演开关跟着模式走。

### Notes

- **安全红线（v0.6.0 的核心）**：模型发起的有副作用动作一律走提案，前端永不在没有用户点击时调用 `emailSend` / `paymentPurchase` / `paymentApprove` / `paymentCharge` / `paymentMarkPaid`；本期不提供任何「读取邮箱」的工具（收件内容是外部不可信输入，读进上下文会给提示词注入开口）。
- 提案属于节点：重试 / 切分支后旧分支里的提案不在当前路径上、不可操作；回到该分支且未过期时恢复可点。提案过期用墙钟，常量 `IR.Proposals.DEFAULT_TTL_MS` 可调（客户端金额兜底上限 `MAX_AMOUNT_CENTS` = 200000 分 = 2000 元，真额度仍由侧车 mandate 管）。
- 本期不做：多步工具循环（仍是单轮：调一次、重发一次、重发不带工具、每轮最多 2 次调用）、视频、占位卡片、重画入口进 chat / rp 图片气泡。

## [0.5.1] — 2026-10-19 · 生图异步化（最小版）：不卡回合、不串线、不抢「停止」

### Added

- **作画串行队列（`js/paintQueue.js` / `IR.PaintQueue`，纯逻辑、Node 可 `require`）**：时机出图 / 工具出图 / 手动作画 / 工作台重画全走**同一条**先进先出队列，画师构思也在队列里跑（不再与队列外的构思并发）。单个任务出错不拖垮后面的；`key` 去重由调用方用 `has()` 拦截。测试：新增 `eval/paintqueue-test.js`（23 项，Node 离线）。
- **回合锚点（`turnAnchor`）**：`request_image` 在 `Tree.commit` 之前提交、节点还没创建——任务带上锚点，回合 `commit` 成功后补 `nodeId`、失败 / 主动停止置 `dead`；任务开跑前核 `dead`（不花额度）、生成完写回前再核一次（丢弃）。图始终落回「它所属的回合」：`nodeId` 有值走 §4.4 的 `pushLate` / 节点校验；`nodeId` 仍为空则写 `story.log` / `story.scenes`，由 `commit` 的 `logMark` 切片（连同 `scenesFor` 对 `scenes` 的收集）收进当前节点。

### Changed

- **`request_image` 异步化**：工具调用不再 `await` 画师构思 + 出图——提交进队列立刻返回，旁白照常继续，图稍后自动落回本回合。留痕文案改为「排队生图」；工具回传改成「已排队生图」的提示，模型不再拿到「已出图」的结果。
- **工具结果按语义分流调整**：`request_image` 移出「调了就重发」名单——模型写了正文就不重发（省一次调用）；只有「纯工具、没正文」时才走原有的 `noProse` 重发，并把「已排队生图」的提示随包注入。失败不再回传给模型（它已经说过「在画了」）：失败改为 `toast` + 节点留痕（`{type:'tool', tool:'image'}`），玩家可见。
- **对话 / 扮演模式不再使用画师子代理**（工具出图）：`request_image` 改为模型自己写生图提示词（`prompt` 必填 + 可选 `alt`），直出送生图；剧情模式保持画师变体（`subject`）。工具名集合不变，既有断言继续通过。
- **对话 / 扮演模式不再有「时机出图」**（**默认行为改动**）：`settings.trigger`（每轮 / 选择后）只对剧情模式生效；对话 / 扮演的图只来自模型调用 `request_image` 或手动「作画」按钮。
- **手动作画加保护**：回复生成中不可用（提示「回复生成中，这一幕写完再作画」）；同一幕（当前 head + 手动）不重复入队（提示「这一幕已在作画队列里」）；场景描述确认读当前 head 的 `lastSceneSummary`。工作台「按此重画 / 按设定卡重画」同样带 `key` 防连点。
- **作画胶囊 `#gen-status`**：显示「构思中 / 作画中」时带上队列长度（如「作画中（队列 2）」），队列清空才隐藏。

### Fixed

- **后台作画不再抢「停止」**：`painterCompose` 不再写全局 `chatAbortCtrl`——「停止」只中断当前聊天回合；该回合已提交、尚未开跑的工具出图任务经 `anchor.dead` 丢弃，已经在跑的后台作画不被中断（写回前再核 `dead`）。
- **手动「为当前场景作画」不再画上一幕**：回合进行中点击会被拦下（busy 保护），不再拿旧的 `lastSceneSummary` 入队、也不再能连点堆进队列。
- **工具出图的「同轮去重」标记改在提交时置位**（原为出图完成后）：异步化后若等出图完成才置位，回合早已结算，去重会失效。

### Notes

- **临时例外（待智能体模式改版时整体处理）**：对话 / 扮演的「手动作画」按钮仍走「画师优先、不可用则场景描述兜底」——模型不支持工具或工具被关时它是唯一的出图入口，而 chat / rp 的 `lastSceneSummary` 只是旁白截断（约 120 字），不适合直接当提示词。
- 本期不做：占位卡片、内联图 / 视频气泡、画布改版、视频生成、作画取消按钮。
- 画师工作台「与画师对话」（`painterThreadSend`）保持现状、不进队列：`assemblePainter` 不读写 `painterThread`，与队列任务无写竞争（详见交付报告）。

## [0.5.0] — 2026-10-18 · 分支树第一期：兄弟切换

### Added

- **回合树（`js/tree.js` / `IR.Tree`，schema → 3）**：每个故事的回合都落在一棵树上（`story.tree`），「根 → head」路径是**唯一真源**——`log / messages / scenes / world / summaries / …` 全是它的投影（`Tree.project`），既有读取点一行没改。纯逻辑、零依赖，Node 里 `require` 就能测。
- **「↻ 重试」= 新增兄弟**：重试不再覆盖旧版本，而是在同一父节点下落一个新兄弟节点；凡是有兄弟的回合，旁白上就有 ‹ n/m › 可切换——切换后世界卡 / 前情摘要 / 消息窗口 / 画面都回到该分支该有的样子，**不发任何网络请求**。续写过的支线靠 `active` 记忆下探：切回来停在续写末端，而不是分叉点；刷新页面停在原分支。
- **晚到条目不串线**：出图 / 书记员等异步写回再加一道 `nodeId` 校验（§4.4）：节点不存在丢弃、已结算且不在当前路径只写节点，不泄漏进当前 log。「清理孤儿原图 / 删除故事 / 备份」的图集（`imageIdsOf` / `knownImageIds`）计入**非当前分支**的图引用，不会误删别的分支的图。
- **旧档无损升级**：无树旧档由 `Tree.ensure` 幂等迁移成线性链；末条旁白的旧版本栈（`versions > 1`）展开成兄弟节点（近似版标 `meta.approx`，`activeVersion` 决定哪版当 head）；旧存档点按 `sp.turn` 映射 `nodeId`。存档点回档优先回树上节点，老存档点映射不上才走整档快照（会明示「回档会重置分支树为一条直线」，并先整棵备份当前树）。
- 测试：新增 `eval/tree-test.js`（18 组 / 113 项，Node 离线：投影 / 兄弟切换 / 迁移 / store 集成）；`eval/demo-smoke.js` 增补「demo 走 3 回合 → 重试 → 切换 → 再切回」的分支树链路（现 24 项）。

### Changed

- **重试前先回滚世界卡**（对旧行为的修正）：以前重试是在已被上一版改写过的世界卡上重来；现在先回到「这一回合发生之前」的父节点状态再重试，失败 / 停止则完整放回原分支。
- 存档点额外记 `nodeId` 并整棵备份 `tree`；导出 / 导入的 full 包带上 `tree`，带原图导入换键时会落盘并同步树内 scene / 条目。
- `Store`：`SCHEMA` → 3，`migrateStory` 原样透传 `tree`，`serializeStory` 的裁剪不作用在 `tree` 上；旧版本栈的兜底切换（`switchVersion`）随迁移展开落地而删除，新条目只写 `versions: [text]`。

### Notes

- 本期只做数据层 + 兄弟切换：树状可视化、从任意历史点分叉、选项幽灵节点留给第二期。
- 迁移近似：旧档更早的节点 `sid = null`（状态未知，切换时沿用当前值）；非 head 节点 `msgFloor` 记 0（旧档的链恰好等于现存消息窗口）；`action.sent` 从 userMsg 剥 `[玩家行动]` 前缀还原；展开出来的版本兄弟只带「同 action + 本版旁白」，场景元数据无从分辨、留在 head 一侧。

## [0.4.0] — 2026-10-17 · 前端整改 P2（布局状态、输入类型与灵感选项）

### Added

- **布局状态模型**：`#screen-game[data-layout="split|stack|immersive"]` 是唯一排版依据，`setLayout()` 统一接管。`settings.ui` 新增 `layout`（`auto` 默认 / `split` / `stack` / `immersive`）、`splitRatio`（0.5）、`imageCollapsed`、`choices`（`tray` 默认 / `always`），`migrateSettings` 全部给默认值并把比例夹在 28%~72%。`auto`：宽度 ≥ 900px 用双栏，否则堆叠；沉浸只能由 ⛶ 进入，Esc / ✕ 退出。分隔条拖动与双击恢复 1:1 都写回设置。
- **窄屏堆叠 / 沉浸**：堆叠态图在上（高度 `clamp(180px, 38vh, 420px)`），点舞台可收成 44px 细条；输入框获得焦点且 `visualViewport` 变矮（虚拟键盘弹出）时自动收成细条。沉浸态画面铺满，文字叠在下半屏（最高 45vh、可滚动、底部渐变遮罩），点图区域显示 / 隐藏文字。顶栏 44px 单行、触控目标不小于 44px、`env(safe-area-inset-*)` 安全区已就位；390×844 模拟可用。
- **做 / 说 / 导演**：输入框左侧三段切换，状态按故事记在 `story.ui.kind`；玩家回合记录增加 `kind`（旧存档缺省按 `do` 读）；发给模型时保留外层 `[玩家行动]`，其后加内层标记 `（做）/（说）/（导演）`。系统提示词补了一句解释三种标记的话（**措辞为草案，待负责人确认后可改**）；导演指令被要求当作世界里的既成事实，不是玩家角色的行动。
- **💡 灵感**：模型每轮照旧输出选项，界面默认收起；输入框上方的「💡 灵感」带数量角标，点开是一排选项，点击即以该选项发送（保留 `lastActionWasChoice` 语义）。设置 → 界面可切到 `always`（内联在旁白下）。
- 设置 → 界面：布局（自动 / 双栏 / 堆叠）与选项显示（灵感 / 内联）可直接切换，即时生效。

### Notes

- `docs/screenshot.png` 换成了新界面的实拍（README 首屏）；`feature-demo.png` 未重拍。
- **未改**出图时机默认值（仍是「做出选择后」）；任务书里「改为场景切换时」的联动需要负责人确认，本期不动。
- 沉浸态的重复输入条（`immersive-bar` / `#immersive-input`）已删除，只保留一个输入框与一个发送函数。
- `context.js` 只加了一句输入类型说明，输出契约（JSON 键、`playerContent` 外层前缀）未改。

## [0.3.2] — 2026-10-17 · 前端整改 P1（电影化暗色舞台）

### Changed

- **设计令牌**：`css/style.css` 顶部统一为暗色舞台的一套变量（`--bg / --stage / --surface / --line / --ink* / --accent / --danger`，圆角统一 `8px`），其余规则只引用变量；删掉 `prefers-color-scheme` 分支，默认始终暗色。纸白主题只在 `[data-theme="paper"]` 预留位置，本期不实现。正文与操作文字保持 4.5:1 以上对比度，焦点环保留，继续尊重 `prefers-reduced-motion`。
- **去掉远程字体**：删除 Google Fonts（7 个字族）与 jsdelivr 霞鹜文楷；旁白改用衬线系统栈，界面用 `system-ui / PingFang SC / Microsoft YaHei`，提示词用等宽。断网刷新不再依赖任何外部资源。
- **左栏 = 安静的阅读面**：旁白直接排版成正文（17.5px / 1.95，阅读列约 40em，段间距 22px），无卡片、无纹理、无背景透图；玩家发言弱化为「左侧细线 + 次要色 + 做/说/导演小标签」；聊天区背景为纯 `--bg`。
- **场景标记行**：聊天里的 `bubble-image` 从大图改成 56px 小缩略图 + 一行 alt，点击即在右侧舞台选中这张；「工作台」入口悬停出现（触屏常显）。
- **右栏 = 舞台**：全页背景图（`bg-a` / `bg-b`）取消，改为只作用于舞台——底层是当前图的模糊放大副本（`blur(36px) brightness(.45)`），上层是完整的图（`object-fit: contain`）+ 轻微暗角；图下方一行 alt，再下面是缩略条。舞台按钮：✎ 画师工作台、🎨 补一张、⛶ 沉浸（桌面悬停显示，触屏常显）。
- **顶栏瘦身**：44px 单行；左侧 ← / 书架 / 标题 / 模式芯片 / 演示芯片，右侧「画面」与「⋯」；存档点、新故事、为当前场景作画、模型设置收进「⋯」菜单，原 id 与功能全部保留。
- **输入区外壳**：一个输入框 + 发送；上方一行预留「💡 灵感」与「＋」。`feature-bar` 改成「＋」菜单（写邮件 / 定时主动 / 代下单），只在对话 / 扮演模式渲染；剧情模式不渲染，且 `openEmailModal` / `openPaymentModal` 与定时入口函数直接返回。本地服务离线时菜单项灰显并在菜单里说明原因。
- **布局状态先落地**：`#screen-game[data-layout="split|stack|immersive"]` 成为唯一排版依据，新增 `settings.ui`（`layout / splitRatio / imageCollapsed / choices`）与 `migrateSettings` 默认值；`setLayout()` 取代原先分散的 `btn-toggle-image` / `btn-immersive` / `bindSplitter` 三处逻辑。分隔条可拖动（每栏最小 28%）、双击恢复 1:1；沉浸态复用同一个输入框（删除 `immersive-bar` 的重复输入）。

## [0.3.1] — 2026-10-17 · 前端整改 P0（先修会让界面看起来坏掉的 bug）

### Fixed

- **旁白被压扁、聊天区不能滚动**：`.chat-scroll` 是纵向 flex，`.bubble-narration` 又设了 `overflow: hidden`（自动最小高度为 0），于是气泡被收缩成一条、`scrollHeight` 恒等于 `clientHeight`。现在 `.chat-scroll > * { flex-shrink: 0 }`，并补齐 `#screen-game / .chat-pane / .chat-scroll` 的 `min-height: 0` 祖先链；连发十余轮旁白完整可见、能滚动，新消息照常自动滚到底。
- **提示条盖住输入框与弹窗按钮**：`.toast` 从「页面底部居中」改到「顶栏下方居中」（`position: fixed`），整条 `pointer-events: none`（只有错误提示的 ✕ 单独放行），不再遮挡发送键与弹窗底部按钮；同一时刻仍只保留一条，后来者替换前者。
- **弹窗叠放**：新增最小的弹窗栈 `openModal(id)` / `closeModal(id)`。功能类弹窗（写邮件 / 代为下单 / 设置里的定时主动）互斥，打开时先关掉其它功能类；确认弹窗可叠在任意弹窗上；Esc 只关最上层（确认弹窗走 `closeConfirm`，Promise 不会悬空）。
- **空白思考链**：没有思考内容（纯空白）时不再渲染「思考链」折叠条。

### Notes

- 本阶段只动 `index.html`、`css/style.css` 与 `js/app.js` 的 UI 部分，不动 `context.js` 的输出契约、存档结构与 `sidecar/`。

## [Unreleased]

### Added

- **可选本地服务（sidecar）**：新增 `sidecar/`（Node 内置能力，**本期零第三方依赖**），为「对话 / 扮演」两种模式提供三项**默认关闭**的能力。不启动它，前端照常使用，三项功能在界面上显示「需要启动本地服务」并禁用，其余功能完全不受影响。
  - **邮件**：写信 / 读收件箱 / 存草稿都由本地服务执行；**收件人白名单后端硬校验**（不在名单里只能落草稿、你确认后才发出）、每日发送上限（默认 0 = 一封都不发）、全量审计（发送 / 草稿 / 拒绝，只记事实不记正文）。渠道可换：本期 Mock 与 Resend(HTTP)；SMTP 需 `nodemailer`，**后置**。
  - **模型主动行动**：一次性 / 固定间隔（心跳）/ cron（含时区，自写解析）三种触发器，SQLite 持久化、重启不丢；到点由侧车触发——页面开着走 SSE 实时送达，页面关着入队、再打开按 `SKIP / RUN_ONCE / RUN_ALL` 补跑，补跑走的是与真实用户消息**完全相同的回合链路**。免打扰时段与每日主动上限只存在侧车、**模型改不了**；每次主动联系记录触发原因；可一键暂停。模型有 5 个调度工具（`schedule_once` / `schedule_heartbeat` / `schedule_cron` / `list_triggers` / `cancel_trigger`），但**只提案，需用户在界面上确认后才生效**。
  - **受限购物支付**：AI **拿不到任何支付凭证**，只能提交购买意图；策略在**代码层**强制（单笔 / 每日 / 每月上限、商户与品类白名单/黑名单、免确认小额阈值、冷静期、不同 agent 预算隔离、长期授权范围）；超阈值弹窗人工确认（展示商品 / 金额 / 商户 / 剩余额度），被拒返回结构化错误码；每笔台账（agent / 金额 / 商户 / 时间 / 状态）可导出收据。本期渠道只有 Mock 与「仅生成订单、由你在微信 / 支付宝里手动付款」，**不做任何支付 App 自动化，不保存支付密码**。
  - 安全：只绑 `127.0.0.1` + 本地 token（防本机其它进程 / 网页乱调，含 DNS rebinding）；**单进程**（锁文件 + 端口占用双重检测）；安全项（额度 / 白名单 / 上限 / 免打扰时段 / token）真源在 `sidecar/data/config.json`（权限 `600`，已加入 `.gitignore`），前端只是它的编辑界面。
- 前端新增 `js/sidecar.js`（`IR.Sidecar`：`/health` 探测与离线降级、token、`api()`、SSE 退避重连）与 `js/features.js`（`IR.Features`：主动触达的去重与排队）；`js/context.js` 新增调度工具定义与 `toolsForMode(mode, {schedule})` 门控（剧情模式工具集不变）；`index.html` 新增「本地服务 / 邮件 / 定时主动 / 购物支付」四个设置分区、局内功能入口条与写邮件 / 代下单两个弹窗；`css/style.css` 复用既有变量补齐样式（不引入新配色或框架）。
- 演示模式（`?demo=1`）新增 `IR.Demo.installSidecarMock()`：不连真实侧车（保持零外联），把 `IR.Sidecar` 换成一整套**内存实现**，三项功能的界面链路照样能完整跑通。
- 测试：新增 `eval/scheduler-test.js`（虚拟时钟，51 项）、`eval/email-test.js`（35 项）、`eval/payment-test.js`（策略边界，67 项）、`eval/sidecar-smoke.js`（真启子进程走 HTTP，25 项）、`eval/frontend-smoke.js`（假 fetch 验离线降级与工具门控，32 项），全部接入 `npm test`；新增 `npm run sidecar` 与 `npm run test:features`。

### Changed

- `package.json` 的 `engines.node` 由 `>=18` 提到 `>=22`（`node:sqlite` 需要 ≥ 22.5；22.5–23.3 需加 `--experimental-sqlite`，≥ 23.4 无需）。
- 邮件与支付**不做成模型可调用工具**——它们是高风险副作用动作，一律走「用户显式发起（界面按钮）→ 确认弹窗 → 执行」，模型最多只能建议；因此 `MAX_TOOL_CALLS_PER_TURN` 仍为 2。
- 「无后端」这条硬约束改写为「**前端核心无后端依赖**；邮件 / 调度 / 支付由可选本地服务提供，缺它则功能关闭」（`ARCHITECTURE.md §1`、`§12` 与 `SECURITY.md` 威胁模型同步更新）。
- **提示词（2026-10-14 链路评审）**：对话 / 扮演模式系统提示词由极简的「你是一个 AI」升级为「伴读者」定位（顺着玩家的话推进剧情或话题）+ 输出体量锚定（每次回应 2~6 句中文）；扮演模式无角色卡时（导入 / 旧档）改用降级提示词（自拟角色并保持一致），不再让指令指向不存在的卡。
- **上下文组装分层**：`[风格基调]`（≤120 字）与 `[故事设定（常驻）]`（≤400 字摘要）进系统块——此前 styleTone 只影响画面、premise 只在开局一回合在场，世界观地基会随摘要合并流失；召回 / 工具回传 / 启发式 / 强制注入四层**并入本轮 user 消息前缀**（不再插在历史与 user 之间的中段 system 块，规避 Gemini OpenAI 兼容层等对中段 system 的合并 / 忽略）。
- **上下文预算自适应**：组装窗口不再恒 8 条——已知容量时按 token 从最近往前装（最多吃窗口一半，条数 ∈ [4, 40]，`context.js fitWindow`），未知容量仍退回 8 条（评测口径不变）；压缩保留窗口用同一函数保证「压多少 / 留多少」同口径；「超预算但无可压」（小窗口 + 长旁白）时降级保留窗口（×0.75 → ×0.5 → ×0.25）自救，不再每轮超发；组装前先查预算、超了就地用本地摘要**先压再组**（此前先组后压，越过 70% 阈值的那一回合会超发一轮）。
- **token 估算**：ASCII 字符按 4 字符 / token 折算（此前按字符全长计，英文输入会把 70% 压缩阈值高估约 4 倍、压缩晚触发）。
- **工具结果分流**：「写了正文 + 调了工具」不再是工具结果的死角——`recall_*` / `request_image`（模型需要的信息 / 产物）调了就注入重发；`update_memory` / 调度工具（fire-and-forget）仅在没有正文时重发（原行为）。重发不可用而第一版正文可用时回退第一版，不再用占位提示丢给玩家。

### Fixed

- **正式对话请求无超时**（此前只有「测试连接」有 15s 超时）：流式空闲超时（两个 chunk 之间最多 60 秒）+ 两种形态总上限 10 分钟，SSE 挂起不再把回合永久卡死；`providers.js` 经 `hooks.onAborter` 暴露 `AbortController`。
- **「停止」按钮**：busy 期间发送按钮变身「停止」（点击即中断当前请求，含画师子代理请求；Enter 键不触发，玩家可能只是提前打字）；主动停止不算故障——不弹错误提示、失败回合照常可重试。
- **超出每轮工具上限的调用不再静默丢弃**：留痕「已达本轮工具上限，未执行：…」，重发时也告知模型当作没有这回事。
- **开局回合的请求文本与存档文本不一致**（实际发的是「（故事开场。请描写第一幕，把玩家带进场景。）」、存的是另一句）：统一为常量，`retryLast` 重试与首发不再错位。

### Notes

- 设计稿把「免确认小额阈值」排在冷静期与预算之前；实现时**有意后置**——否则小额免确认可以绕过每日 / 每月上限与预算隔离（重复小额下单即可刷爆额度）。
- 「页面关闭时的调度行为」按「只触发入队」实现，并做成可替换的策略点（后续可切「离线跑完整回合」或「离线只发邮件」）。

## [0.3.0] — 2026-10-10

### Added

- **存储迁移 IndexedDB**（新增 `js/storage.js`，重写 `js/store.js` 的读写核心）：
  - **内存优先 + 异步落盘**：`boot()` 时把数据读进内存，之后 `Store.*` 全部保持**同步签名**，界面层零改动；写操作是「改内存 + 后台异步落盘」，落盘失败走回调提示（10 秒节流），并可在导出 / 卸载前用 `Store.flush()` 等落盘
  - **一次性迁移 localStorage → IndexedDB**：先写入、再逐项读回校验，全通过才写标记 `ir:migrated-v3`；任何一步失败都不写标记、不改动旧数据，并让本次会话安全退回 localStorage 运行
  - **重复迁移保护**：有标记直接跳过；localStorage 旧数据**原样保留**当回退快照（旧版可随时退回）
  - 读 IndexedDB 失败先重试一次，仍失败才退回；退回原因显示在存储面板（不静默）
  - 没有 `indexedDB` 的环境（Node 离线评测 / 老浏览器）自动退回 localStorage / 进程内内存，`npm test` 不受影响
- **原图以 Blob 存 IndexedDB**（新 `images` store，键 `img:<sceneId>`）：不再把 base64 塞进普通文本存储，故事档案只留引用键 `imageId`
  - 渲染走 `URL.createObjectURL`；缩略条优先用小图，原图缺失时异步取回再重绘
  - 删除故事连带删原图；新增「清理孤儿原图」
  - 单个故事导出可勾选「附带原图」（从 IndexedDB 取回 Blob 再转 base64）
- **带原图的全量备份（`.irbackup.zip`）**：设置里勾选「备份里也带上原图」，一键导出即可把全部故事连原图一起搬走（换设备 / 离线归档）
  - 一个包里放两样东西：`ir-backup.json`（与普通备份同款，`schema:2` 多一份 `images` 清单）+ `images/0001.png…`（原图按二进制原样存放，**不转 base64**，比单个故事导出省约 1/3 体积）
  - 新增 `js/zip.js`：**零依赖手写 ZIP**。写入只用 store（不压缩）——原始字节与文件完全一致，系统自带解压工具 / 第三方工具都能直接打开；读取兼容 deflate（方法 8）与 Windows 压缩工具的反斜杠路径
  - 导入侧：把 `.zip` 拖回书架即可，按清单把原图写回 IndexedDB；包损坏 / 缺图 / 这台浏览器用不了 IndexedDB，都会明说原因，不静默失败
  - 新增 `eval/zip-smoke.js`（20 项）：用**独立实现的第二套 CRC32** 复算校验值、手工解析中央目录核对偏移、手工造 deflate 包验读取路径，已接入 `npm test` 与 CI
- **「测试连接」按钮**（剧情 / 画师 / 书记员 / 起草 / 生图五个区块各一个）：只探测可达性，**不生成任何内容、不花钱**
  - 对话类：`GET /models`，识别出所填模型名即报成功；服务商没有该接口时退回一条 `max_tokens:1` 的最小请求
  - 生图类：只做 `GET /models` 探测 + 配置格式校验，**绝不调用生图接口**
  - 子模型留空的项按「沿用剧情模型」代入，测的就是实际会用到的那套配置
  - 错误人话化（401 → Key、404 → 地址、连不上 → 网络 / CORS），并原样带出服务商返回的正文
- **断网不排队**：离线时点「作画 / 发送 / 试画 / 和画师说话」直接提示「这次没有发出」，**不发请求、不入队、不事后补发**——出图时机含自动触发，补发会在用户不知情时扣额度；`online` / `offline` 事件另给状态提示
- 存储面板显示**真实占用**（`navigator.storage.estimate()` 的 usage / quota）与现存原图张数，并明示「IndexedDB 可用容量取决于浏览器、设备剩余空间与存储策略，并非无限」
- 移动端：`viewport-fit=cover` + 刘海屏安全区（`env(safe-area-inset-*)`）、画面按钮与发送键放大到 44px 触控目标、缩略图加大、输入框字号兜底

- **离线演示模式 `?demo=1`**（`js/demo.js`）：10 回合内置剧本 + canvas 本地占位图，零配置、零联网跑通完整链路（剧情 / 选项 / 画师子代理 / 出图 / 画师工作台 / 画风锚定 / 存档 / 书架）
  - 演示模式只覆盖内存里的设置，**不写盘**，不会污染真实配置；子模型（画师 / 书记员 / 起草）自动沿用演示适配器
  - 开始页新增「🎬 离线演示」入口；游戏页顶栏新增「🎬 演示」标识，点它即回到可配置真模型的普通模式
- `eval/demo-smoke.js`：演示模式冒烟测试（18 项契约检查，不开浏览器、不花 API），已接入 CI
- `tools/bundle-single-file.mjs` + `npm run bundle`：把 HTML / CSS / JS 内联成单文件 `dist/ir.html`，可直接当附件发送
- `.github/workflows/pages.yml`：GitHub Pages 在线 Demo（部署后 `?demo=1` 一键体验）
- `docs/screenshot.png`：演示模式运行截图（README 首屏用）
- **PWA / 可安装**（`manifest.webmanifest` + `sw.js` + `js/pwa.js`）：https 或 `localhost` 下可安装到桌面，断网也能打开
  - Service Worker 只在 `install` 时预缓存「外壳 + index.html 里解析出的带 `?v=` 的资源」，导航走网络优先（更新不会被缓存卡住）
  - 跨域请求（对话 / 生图 API、字体 CDN）与非 GET 一律不缓存、直接放行；缓存名 `ir-v<版本>` 由 `VERSION` 注入
- `icons/`：应用图标（矢量 SVG + 192/512 PNG + maskable + iOS 主屏），由 `tools/make-icons.mjs` 生成并随仓库提交（零依赖手写 PNG 编码）
- `启动.bat` + `tools/serve.ps1`：Windows 一键启动本地服务（Python 优先，退回零依赖 PowerShell 静态服务器，只绑 `127.0.0.1`，含目录穿越防护）
- `Dockerfile` + `docker-compose.yml` + `docker/nginx.conf`：自托管镜像（webmanifest MIME、`sw.js` / `index.html` 不长缓存、带 `?v=` 的资源长缓存）
- `index.html`：补 manifest / favicon / apple-touch-icon / theme-color
- **开源基座**：`LICENSE`（MIT）、`VERSION`、`.gitignore`
- 社区文档：`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`CHANGELOG.md`、`THIRD-PARTY-NOTICES.md`、`ARCHITECTURE.md`
- 英文说明 `README.en.md`；`README.md` 补徽章与文档索引
- `.github/`：Issue 表单（Bug / 功能建议）、PR 模板、`ci.yml`、`release.yml`
- `tools/sync-version.mjs`：以 `VERSION` 为真源同步 `index.html` 的 `?v=` 与 `package.json`（支持 `--check`）
- `package.json`：仅作开发脚本入口（`npm test` / `npm run serve`），**无运行时依赖**

### Changed

- 存储后端由 localStorage 换成 IndexedDB；`.irbackup.json` 全量备份默认**不含原图**（体积可控），要连原图一起带走可勾选「带上原图」导出 `.irbackup.zip`，或用单个故事的「导出 → 附带原图」
- `serializeStory` 的 `scenes` 新增 `imageId`；`.irstory.json` 的 `images[]` 新增 `id`（导入时才能把图片与聊天记录里的图片气泡对上号）
- 版本号收敛到单一真源 `VERSION` 并推进到 0.3.0：此前 `css?v=0.5.0` 与 `js?v=0.2.x` 各自漂移，现全部由 `tools/sync-version.mjs` 注入 `index.html` 与 `package.json`（Service Worker 缓存名 `ir-v<版本>` 随之更换，旧资源整批淘汰）
- 设置落盘收敛到单一出口 `persistSettings()`：演示模式下自动跳过写盘
- 单文件打包跳过 `js/pwa.js`（单文件版旁边没有 `sw.js`）
- Pages 工作流补上 `icons` / `manifest.webmanifest` / `sw.js`
- CI 增加「单文件打包冒烟」「演示模式冒烟」「ZIP 读写冒烟」「PWA 清单与图标自检」四个步骤
- `eval/run.js`：新增退出码语义——总分低于 v0.1 基线，或 C-E / P7 校验未全中时返回非 0（供 CI 拦截回归），可用 `--no-fail` 关闭

## [0.2.0] — 2026-10-05

首个公开版本：「有限的书页，无限的故事。」

### Added

- **三种推进模式**：剧情（选项 + 自由输入）/ 对话 / 角色扮演（角色卡 + 关系记忆 + 用户画像）
- **世界状态卡**：AI 自报 + 书记员每 10 回合校准 + 用户可改；配合按需召回（`recall_world_state`）与 70% 自动压缩，长局不忘前情
- **AI 画师子代理**：`request_image` 工具触发，画师产出 `prompt_en / subject / alt`；提示词可见可改，并可与画师对话改画
- **画师工作台**：提示词版本对比、改画、手动补图（右上角「🎨 作画」）
- **画风锚定**：起草画风卡 → 批量试画 → 选定并锁定，之后每张图携带设定卡
- **模型接入**：对话与生图分离，兼容所有 OpenAI 格式接口（云端 / 本地，Base URL 自填）；不预置模型名
- **故事管理**：书架、存档点、`.irstory.json` 单档导出、`.irbackup.json` 一键全量备份与还原
- **文本导入**：把设定文 / 小说片段 / 聊天记录整理成开局材料
- **角色卡**：SillyTavern V2/V3 PNG 解析（只兼容格式，不复制内容）
- **思考链显示**：模型返回 `reasoning_content` 时渲染为可折叠区块，可关闭
- **数据安全**：持久化存储申请、存储占用 70% 预警、超 7 天未备份提醒
- **离线评测** `eval/run.js`：32 回合 mock 长局 + 5 类探针 + C-E 启发式校验 + P7 角色卡/画像校验，不花 API

### Notes

- 视频生成已预留适配器位置（`IR.VideoProviders`），尚未实现
- 工具调用治理定案：试错降级（显式 400 拒绝 `tools` 的模型会被记住并降级），召回类工具采用「单次重发」，不把 `tool_calls` 写进历史

## [0.1.0] — 内部基线（日期未记录，未公开发布）

### Added

- AI1 回包 JSON 契约：`narration / choices / scene_change / world`
- 出图时机三档：每轮 / 选择后（默认）/ 仅手动
- v2 上下文组装初版（摘要行 + 保留窗口 + premise），探针命中率基线 60.0%
