# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 与 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的写法。
版本号真源是根目录的 `VERSION` 文件，发布时打同名 tag（如 `v0.2.0`）。

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
