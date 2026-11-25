# 无限阅读 · ∞ Reading

[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![version](https://img.shields.io/badge/version-0.14.0-blue.svg)
[![runtime deps: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](#架构)
[![built with Vite + Svelte](https://img.shields.io/badge/build-Vite%20%2B%20Svelte%205-blue.svg)](#快速开始)
[![English](https://img.shields.io/badge/README-English-lightgrey.svg)](README.en.md)

**在这里你可以体验与创作各种优秀且令人难忘的剧情，无论是什么样剧情都尽情的在这体验吧，包括你心中所想的世界**

**当前版本 v0.14.0** ｜ 文档：[架构](ARCHITECTURE.md) · [参与贡献](CONTRIBUTING.md) · [English](README.en.md)

## 特色

- 🎭 **自由演出**：自由输入，或点 AI 给出的分支选项
- 🎨 **AI 画师现场作画**：提示词可见可改，还能与画师对话改画
- 🧭 **两种模式**：剧情 / 聊天。聊天是带工具的助手（画图、记事、定时、写邮件、下单；后两样要先提案、你确认才执行，且默认关着），想演角色就给它加一张角色卡（兼容 SillyTavern V2/V3 卡，带关系记忆与用户画像）——卡是可选的，不加就是普通助手
- 🧠 **记得住**：世界状态卡 + 按需召回 + 70% 自动压缩，长局不忘前情
- 📚 **玩得久**：故事书架、存档分支、`.irstory.json` 导入导出、剧情文本导入
- 🔌 **模型随便换**：对话与生图分离，兼容所有 OpenAI 格式接口（云端 / 本地，Base URL 自填）
- 🖼 **MiniMax 生图（`image-01` / `image-01-live`）**：「生图适配器」选 **MiniMax 原生**即走官方 `/v1/image_generation`；`image-01-live` 支持「漫画 / 元气 / 中世纪 / 水彩」四种画风（填进自定义参数 `style.style_type=漫画, style.style_weight=0.8`）。浏览器直连被 CORS 拦时同样用 `node tools/video-proxy.mjs` 转发（生图 / 生视频共用一个进程），接口地址填 `http://127.0.0.1:4320`
- 🖥 **ComfyUI 本地生图（零 API 费用）**：「生图适配器」选 **ComfyUI 本地**，地址填 `http://127.0.0.1:8188`，把 ComfyUI 里「导出（API 格式）」的 workflow JSON 贴进设置即可。每次作画只替换正向提示词、随机 seed 和宽高，模型 / 步数 / 负向提示词都以你的 workflow 为准。启动 ComfyUI 时加 `--enable-cors-header "*"` 即可跨域；出图上限 10 分钟
- 🎯 **画风不漂**：画师写提示词时以上一张图为「差分基底」（风格词原样保留、只改剧情变化的部分）；设置里打开「参考图 = 用上一张图」后，还会把上一张缩到长边 1024 的 JPEG 作为 `subject_reference` 一并提交，人物长相与服饰更连贯
- 🎬 **生视频（MiniMax）**：剧情模式舞台右上角「🎬」→「以当前图生成视频 / 按剧情文生视频」。画师把这一幕写成「动态提示词」，提交 MiniMax 异步任务（独立队列、每 10 秒轮询、不堵出图），完成后存进 IndexedDB 在舞台播放；中途刷新 / 切档回来自动续上同一个任务。走 MiniMax V2 接口（`MiniMax-H3` / `MiniMax-H3-Max`）。浏览器直连被 CORS 拦时，起 `node tools/video-proxy.mjs`（零依赖本地转发），接口地址填 `http://127.0.0.1:4320` 即可。

## 快速开始

用 git 取一份（也可以点仓库页的 **Code → Download ZIP**，无需 git）：

```bash
git clone git@github.com:LiSheng5/infinite-reading.git   # 或 https://github.com/LiSheng5/infinite-reading.git
cd infinite-reading
```

1. 构建（需要 Node ≥ 24，与 CI 同版本；源码是 ES module + Svelte，浏览器不能直接打开 `index.html`）：

   ```bash
   npm ci
   npm run build        # 产出 dist/site（多文件）与 dist/single/index.html（单文件）
   ```

   然后任选一种方式启动：
   - **Windows 一键**：双击 `启动.bat`——没有产物会先构建，再起本地服务并自动打开浏览器（优先用 Python，没有就退回内置的 PowerShell 服务器）
   - **单文件双击**：直接双击 `dist/single/index.html`（JS / CSS / 图标全部内联成一个 HTML，`file://` 可开；也可 `npm run bundle` 复制成 `dist/ir.html`）
   - 本地静态服务（更稳，推荐）：`python tools/serve.py`（仓库自带、离线；Windows 也可直接双击 `启动.bat`）；已装 Node 时可用 `npm run serve`（`npx serve`，开发期工具，首次需联网）
   - 开发模式：`npm run dev`（Vite dev server，热更新；发布前请用构建产物验收）
2. **接入模型配置向导**（首次启动自动弹出；设置里「接入向导」随时重开）：四步走——**选接入方式**（厂商预设只预填 Base URL / 自定义地址 / 聚合模式）→ **填 API Key**（Key 只存浏览器本地，请求由浏览器直发所选服务商，不经过任何中转；Ollama / LM Studio / vLLM 等本地模型自动跳过这步）→ **选模型**（自动 `GET /models` 拉取列表下拉可选，拉不到就手填，不阻塞）→ **测试连接**。任何一步都能「跳过，直接填完整表单」——完整设置表单（含生图 / 视频 / 辅助模型）仍是高级入口。**预设只带地址不带模型名**：模型名只来自 `GET /models` 或手填，跟着厂商实时变动、不做内置清单。
   - **聚合模式（可选）** = 走现成第三方聚合商（OpenRouter / 硅基流动）中转，不是自建网关：**你的对话正文与 API Key 会先经过该聚合商服务器再转发到模型厂商（浏览器 → 第三方 → 模型厂商）**，仅在接受这一点时使用；选中后设置页顶部有常驻琥珀徽章标明「对话经由 {运营方} 转发」，可一键切回直连。
   - 设置页所有「模型」输入框（剧情对话 / 模型库 / 画师 / 书记员 / 起草 / 生图 / 生视频）都会按对应地址自动回填 `/models` 列表，手填始终可用。
3. **点一张模式卡就开局**：开始页上有两张模式卡——**剧情**（用下面的「故事设定」框开一局）、**聊天**（带工具的助手：能画图、记事、定时、写邮件、下单，后两样都要你确认）。点哪张就直接按哪种模式开局，**没有单独的「开始」按钮**；「故事设定」框常驻，只给剧情模式用。聊天开局后是空的对话，引导页上有「添加角色卡（可选）」——想演角色就建 / 导入一张，不想就直接聊。
   - 「📄 文本导入」：把现成文本（设定文 / 小说片段 / 聊天记录）交给 AI 整理成开局材料，确认后再建新档。
   - 「☰ 我的书架」进故事列表（继续 / 改名 / 删除 / 导出），「↶ 继续上次」直接回到上一个故事；书架里的「＋新故事」也能选模式开局。
   - 进了故事：**剧情模式是「左文右图」**——左边只排文字（旁白是正文，玩家发言弱化成一侧细线 + 做/说/导演小标签），右边是舞台（当前画面 + 缩略条）；**聊天是纯聊天布局**（没有画面区，图片直接内联在聊天流里，点图开大图）。顶栏左上「←」是**回首页**，旁边是书架与标题；存档点、新故事、为当前场景作画、模型设置都收在右上角「⋯」里（开新故事前会先把当前这一幕存好）。
   - 输入框上方有「💡 灵感」：模型给的选项默认收在这里（只有剧情模式有选项），点开是一排选项，点哪个就以哪个行动继续；也可以完全不理它、自己打字。输入框左侧的「做 / 说 / 导演」只在剧情模式出现（聊天没有这组开关，有没有角色卡都一样），只改变模型如何理解这句话，按故事记住。

> ⚠️ `file://` 与 `http://localhost` 是两套独立数据，选定一种就别换。
> 浏览器直连 API 可能被 CORS 拦（`file://` 下尤其常见），遇到就改用本地静态服务。
> 只预置 Base URL，不预置模型名；没把握的参数可留空，或写进「自定义请求参数」（`key=value`，原样并入请求体）。
> 生图尺寸默认 `1280x720`，服务商不支持时按报错改。

## 作画（点按钮才动）

**剧情模式不再自动出图**（v0.11.0 起，开局也不出图）：想看画面时点舞台右上角「🎨」（或「⋯ → 为当前场景作画」），画师会按最近剧情构思一张并出图；同一幕重复点不会重复排队。画师工作台里的「按此重画 / 按设定卡强制重画」照旧可用。

聊天模式的图仍来自模型自己调用生图工具（模型直出提示词），或同样的手动按钮。生图工具默认关着（设置里标注「测试中」），需要时在「本对话设置 → 工具」里打开。

## 可选：本地服务（邮件 / 定时主动 / 代下单）

> ⚠️ **风险提示：AI 可能出错，请设置合理额度。** 这三项能力默认**全部关闭**、额度默认 **0**、白名单默认**为空**——不手动开启就什么都不放行。

三项能力需要一个**可选**的本地小服务（不启动它，应用照常用，只是这三个入口会显示「需要启动本地服务」并禁用）：

```bash
node sidecar/server.mjs            # 首次启动会打印 token
```

1. 在项目目录运行上面的命令；终端会打印一个 `token`。
2. 打开应用 →「模型设置 → 本地服务」，把 token 粘进去，点「重新探测」。
3. 再在「邮件 / 定时主动 / 购物支付」三个分区里按需开启并填好额度、白名单。

| 能力 | 说明 | 可用模式 |
|---|---|---|
| 邮件 | 代你写信 / 存草稿 / 发信；模型发起的只会停在**提案卡**上（参数原值可见），你点「确认」才发出；**收件人白名单由本地服务硬校验**，不在名单里的只能先落草稿、你确认后才发出；每日上限默认 0；每次发送 / 草稿 / 拒绝都写审计 | 聊天 |
| 定时主动 | 到点让 AI 主动来找你（一次性 / 固定间隔 / 日历表达式含时区）；触发器重启不丢；**免打扰时段与每日上限由你配置，模型改不了**；模型只能「提议」安排，需你确认才生效；可一键暂停 | 聊天 |
| 购物支付 | AI **拿不到任何支付凭证**，只能提交购买意图（同样停在**提案卡**上），由本地服务在代码层强制策略（单笔 / 每日 / 每月上限、商户与品类名单、冷静期、预算隔离）；超阈值弹窗给你确认；每笔台账可导出收据。本期只有「模拟支付」与「仅生成订单、由你在微信 / 支付宝里手动付款」 | 聊天 |

安全与边界（详见 [`CONTRIBUTING.md`](CONTRIBUTING.md) 的「安全说明」）：

- 服务**只监听 `127.0.0.1`**（局域网 / 外网访问不到），除健康检查外都要 token（SSE 例外：先用 token 换一张 30 秒一次性 ticket，见 `sidecar/README.md`）；按「单进程」设计，重复启动会被拒绝。
- 额度、白名单、免打扰时段、token 的**唯一真源是 `sidecar/data/config.json`**，它们不会回存到浏览器里——AI 也就无从改写。
- 支付策略是**防误操作 + 可审计**，不是「防你自己」：你拥有本机文件，理论上可以改配置或代码绕过。
- **不做任何对微信 / 支付宝 App 的自动化或绕过，也不保存支付密码**；不接真实支付回调。
- 密钥与账户都留在你本地，本项目不代管任何人的钱或邮箱。

## 数据与备份

数据**只存在当前浏览器里**（主库是 IndexedDB，容量由浏览器按设备剩余空间分配，远大于 localStorage 的约 5MB；原图以 Blob 单独存放），无服务器、无账号、不上传。

**会永久丢失的情况**：清「Cookie 和网站数据」、无痕模式关窗、换浏览器或设备、换打开方式（`file://` ⇄ `localhost`）、Safari 7 天未交互。只清「缓存」不受影响。磁盘空间紧张时浏览器也可能自动淘汰（应用启动时会申请「持久化存储」降低这个风险）。

**备份**：「模型设置 → 本地存储与备份 → 一键导出全部备份」有两种产物，拖回书架窗口即可整体还原：

- `.irbackup.json` —— 全部故事 + 模型设置 + 用户画像，体积可控；默认不含 API Key，可勾选带上。**本地服务的 token 无论如何都不进备份**（它是本机连接凭据，换设备还原也没有意义）
- `.zip` —— 上面那份正文 + **全部原图**（勾选「备份里也带上原图」）；图片按二进制原样打包，比 base64 省约 1/3 体积，换设备时连图一起搬

- 占用到 70% 预警；超 7 天未备份启动时提醒
- 单个故事可在书架卡片上「导出」为 `.irstory.json`（可勾选附带原图）

## 部署与分发（五种走法）

| 走法 | 命令 / 操作 | 适合 |
|---|---|---|
| 本地服务 | 双击 `启动.bat`（Windows）或 `python tools/serve.py` | 日常使用：绕开 `file://` 的 CORS 与数据隔离 |
| 单文件 | `npm run bundle` → `dist/ir.html`（约 708 KB） | 发给别人：一个 HTML 文件，双击即玩 |
| 在线 Demo | 仓库自带 GitHub Pages 工作流 | 零安装体验：`https://LiSheng5.github.io/infinite-reading/` |
| 自托管 | `docker compose up -d` → `http://localhost:8080/` | NAS / 内网 / 长期挂机（容器无状态，数据仍在各人浏览器里） |
| 可选本地服务 | `node sidecar/server.mjs` | 想用「邮件 / 定时主动 / 代下单」时另开一个终端跑它（需 Node ≥ 24：内置 `node:sqlite`，见 `sidecar/README.md`） |

**可安装（PWA）**：用 `https` 或 `localhost` 打开后，浏览器会出现「安装」入口；装完有桌面图标、可离线打开（Service Worker 只缓存本站静态资源，**跨域 API 请求与密钥一律不进缓存**）。

**Windows 一键启动**：`启动.bat` 起一个只绑 `127.0.0.1` 的静态服务并自动开浏览器；优先用 Python，没装 Python 就退回内置的 `tools/serve.ps1`（零依赖，含目录穿越防护）。

**自己改图标**：图标是脚本生成的，`node tools/make-icons.mjs` 会重画 `icons/`（矢量 + 各尺寸 PNG，含 maskable 与 iOS 主屏图标），产物已随仓库提交，正常使用无需运行。

## 架构

```
玩家行动 ─► AI1（剧情对话）─ JSON：narration / choices / scene_change / world
                │
                │   出图入口：用户点 🎨（剧情模式唯一入口）／ 聊天可调 request_image 直出提示词
                ▼
        画师代理 ─ JSON：prompt_en / subject / alt（手动 🎨 走这里；直出跳过）
                ▼
        ImageProvider（/images/generations）
                ▼
        背景淡入 + 书架 / 存档点（IndexedDB，存缩略图）
```

| 文件 | 作用 |
|---|---|
| `src/main.js` | **唯一入口**：按依赖顺序加载应用层 → 各屏 → 组合根 → PWA（旧 `src/legacy.js` 已删） |
| `src/core/providers.ts` | 适配器层：`ChatProviders` / `ImageProviders`（`openai-images` 通用兼容 · `minimax-image` 官方 `/v1/image_generation` · `comfyui` 本地 `/prompt` 提交 → 轮询 → 取图）/ `VideoProviders['minimax-video']`（MiniMax V2：`submit` / `poll` / `generate`） |
| `src/core/context.ts` | 上下文组装、压缩链、文本导入整理 |
| `src/core/tree.ts` | 分支树数据层：回合树是唯一真源（「↻ 重试」= 新增兄弟、‹ n/m › 切换），log / 世界卡等全是「根 → head」的投影 |
| `src/core/storage.ts` | IndexedDB 适配器（唯一碰 IndexedDB 的地方；无 IndexedDB 时自动退回 localStorage） |
| `src/core/store.ts` | 存档层（内存优先 + 异步落盘；schema v3、旧档迁移、书架、存档点） |
| `src/core/zip.ts` | 零依赖手写 ZIP：带原图的全量备份打包 / 解包 |
| `src/core/roleCard.ts` | 角色卡（SillyTavern PNG 解析） |
| `src/core/modelCapabilities.ts` | 上下文窗口参考表（默认留空；厂商形参走「自定义请求参数」） |
| `src/app/main.js` | 组合根：安装弹窗外壳 + 事件绑定 + 启动（业务在 `src/app/` 的 25 个模块里，见 [ARCHITECTURE.md](ARCHITECTURE.md) §2.1） |
| `src/screens/` + `src/ui/` | Svelte 5 屏幕与基础组件库（图标 / 按钮 / 弹窗卡片 / 视图过渡） |
| `src/core/sidecar.ts` + `src/core/features.ts` | 可选本地服务客户端：`/health` 探测与离线降级、主动触达去重与排队 |
| `src/pwa.js` + `sw.js` | PWA：注册 Service Worker；只缓存本站静态资源，跨域请求一律放行 |
| `eval/run.js` | 离线评测（mock 长局 + 探针，不花 API；剧本在 `eval/mock-story.js`） |
| `eval/tree-test.js` | 分支树数据层测试（Node 离线：投影 / 兄弟切换 / 旧档迁移 / store 集成） |
| `eval/proposals-test.js` | 提案模块单测（假 sidecar：模型发起的邮件 / 下单只能产生提案、确认才执行、幂等 / 过期，Node 离线） |
| `eval/zip-smoke.js` 等 | ZIP 冒烟与侧车 / 前端特性测试（`npm test` 一并跑） |
| `sidecar/` | 可选本地服务（Node 进程）：邮件 / 定时主动 / 受限购物支付；只绑 `127.0.0.1` |
| `tools/` | 可选脚本：版本号同步、单文件打包、图标生成、本地服务器、生视频本地转发 `video-proxy.mjs`（不属于运行时代码） |

模块职责、一回合的完整调用链、存储键位与备份格式、关键不变量，见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 参与与许可

- **想改代码**：`npm ci` 后用 `npm run dev` 开发、`npm test` 跑全量离线套件（含 44 个 `eval/*` 门禁，不花 API）。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- **不写代码也能贡献**：`.irstory.json` 故事、画风包、角色卡、文档纠错、错别字，都欢迎。
- **遇到问题**：安全相关请走私密渠道（见 [CONTRIBUTING.md](CONTRIBUTING.md) 的「安全说明」），其余请提 Issue（有模板）。
- **许可证**：[MIT](LICENSE)。第三方字体与资源的许可见 [CONTRIBUTING.md](CONTRIBUTING.md) 的「第三方资源与许可」。
- **注意**：API Key 明文存在浏览器 `IndexedDB`，共享设备上请勿保存 Key；本项目不收集、不上传任何数据。
