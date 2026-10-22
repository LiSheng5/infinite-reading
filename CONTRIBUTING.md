# 贡献指南

先说最重要的一条：**这个项目不需要 `npm install`**。
改 `js/*.js` 或 `css/style.css`，刷新浏览器就能看到效果——没有构建、没有打包、没有编译步骤。

感谢你愿意花时间。本文包含四部分：**贡献流程（一~八）**、**行为准则（九）**、**安全说明（十）**、**第三方资源与许可（十一）**；后三部分按需查阅。

---

## 一、本地跑起来

```bash
git clone <你的 fork 地址>
cd infinite-reading
```

三种打开方式，任选其一：

| 方式 | 命令 / 操作 | 说明 |
|---|---|---|
| 直接开 | 双击 `index.html` | 最省事，但 `file://` 下直连 API 更容易被 CORS 拦 |
| 本地服务（推荐） | `npx serve .` 或 `python -m http.server 8000` | 起在 `http://localhost`，界面与线上一致 |
| npm 脚本 | `npm run serve` | 等价于 `npx serve .` |

> ⚠️ `file://` 和 `http://localhost` 是**两套独立的本地存储（IndexedDB / localStorage 都按 origin 隔离）**，开发时固定用其中一种，别来回切。

Node 只在可选处用到（都不是必须的）：跑离线评测 `node eval/run.js`、同步版本号 `node tools/sync-version.mjs`、以及可选的本地服务 `sidecar/`（`node sidecar/server.mjs`）。要求 Node ≥ 22（侧车用到 `node:sqlite`，见 `package.json` 的 `engines`）。

## 二、目录地图

```
index.html          单页骨架：所有界面区块 + 脚本加载顺序
css/style.css       全部样式（CSS 变量 + 主题）
js/providers.js     适配器层：ChatProviders / ImageProviders / VideoProviders['minimax-video']
js/context.js       上下文组装与压缩：assembleAI1 / assemblePainter / compressStory
js/storage.js       IndexedDB 适配器（唯一碰 IndexedDB 的地方，无 IndexedDB 时退回 localStorage）
js/store.js         存档层（唯一出口）：内存优先 + 异步落盘、schema 迁移、书架、存档点
js/modelCapabilities.js  模型参数登记表（默认留空）
js/roleCard.js      SillyTavern V2/V3 PNG 角色卡解析
js/demo.js          离线演示（?demo=1）：内置剧本 + 本地占位图两个适配器
js/zip.js           零依赖手写 ZIP：带原图的全量备份打包 / 解包
js/sidecar.js       可选本地服务客户端：/health 探测、token、SSE 退避重连
js/features.js      主动触达的去重与排队（投递回调由 app.js 注册）
js/app.js           状态机与 UI：回合编排、设置、导入导出（业务模块拆在 js/app/*.js）
eval/run.js         离线评测（零依赖、不花 API）
eval/mock-story.js  评测用的 32 回合长局剧本
eval/demo-smoke.js  演示模式冒烟测试（不开浏览器，验证适配器契约）
eval/zip-smoke.js   ZIP 读写冒烟（第二套 CRC32 复算 + 手工解析中央目录）
eval/scheduler-test.js / email-test.js / payment-test.js / sidecar-smoke.js / frontend-smoke.js  侧车与前端特性测试（接入 npm test）
sidecar/            可选本地服务（Node 进程，零第三方依赖）：server / scheduler / cron / email / payment
manifest.webmanifest / sw.js / js/pwa.js   PWA：清单、Service Worker、注册
icons/              应用图标（由 tools/make-icons.mjs 生成，产物随仓库提交）
Dockerfile / docker-compose.yml / docker/nginx.conf   自托管（纯静态 nginx）
启动.bat             Windows 一键启动（Python 优先，退回 tools/serve.ps1）
tools/              可选脚本（版本号同步、单文件打包、图标生成、本地服务器、生视频本地转发 video-proxy.mjs），不属于运行时代码
docs/               仓库截图（docs/screenshot.png）
```

架构与数据流的细节见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 三、动手前请先跑一遍自检

```bash
node eval/run.js                      # 离线评测：应全部 [命中]，总分不低于基线
node eval/demo-smoke.js               # 演示模式冒烟：契约检查全绿
node tools/sync-version.mjs --check   # 版本号一致性
```

`eval/run.js` 用固定剧本重放 32 回合，检查「上下文组装 / 压缩 / 启发式召回 / 角色卡 / 画像」是否被改坏。
它**不调用任何 API、不产生费用**，是我们防回归的第一道闸门——改记忆机制前尤其要先跑。
`eval/demo-smoke.js` 则盯着 `js/demo.js` 的两个假适配器：AI1 回包能不能被真实解析链路认出来、画师三套回包齐不齐、后台任务有没有老实交回空串。

## 三之二、不想配 Key 也能开发界面

在地址后面加 `?demo=1`（或点开始页的「🎬 离线演示」）会进入**离线演示模式**：
内置剧本 + canvas 本地占位图，不联网、不写盘，剧情 / 出图 / 画师工作台 / 存档全都能点。

调试 UI 布局时非常省事；但它走的是内置脚本，**验证真实模型行为时必须去掉这个参数**。
演示模式的实现原则是「换适配器、不改业务逻辑」——改功能时请保持这一点，否则演示会悄悄烂掉。

## 四、代码取向

- **零依赖**：不引入第三方 JS 库，不引入构建工具。需要什么就写什么，标准库优先。
- **不破坏 `file://`**：代码不得依赖模块系统或需要编译的语法，源码要能被 `<script src>` 直接加载。
- **模块写法**：IIFE + 往全局 `IR` 上挂命名空间（`IR.Context`、`IR.Store`…），新模块照抄现有文件的头尾即可。
- **加载顺序**：`index.html` 里脚本顺序是 `providers → … → storage → store → … → app → pwa`。`storage.js` 必须赶在 `store.js` 之前（`store.js` 启动时要拿 `IR.Storage`）；`app.js` 会立即读取前面所有模块，所以业务模块必须排在它之前；`pwa.js` 是唯一允许排在它之后的（只注册 Service Worker，不碰 `IR`）。完整顺序以 `ARCHITECTURE.md` §2 为准。
- **改了前端资源看不到变化**：先用 DevTools → Application → Service Workers 注销（`sw.js` 会缓存静态资源），别怀疑人生。
- **渲染安全**：AI 返回的文本一律走 `textContent` / `createTextNode`，**不要**把模型输出拼进 `innerHTML`。
- **文案**：界面与注释用简体中文，术语保持一致（如「世界状态卡」「画师子代理」「存档点」）。
- **数据兼容**：改动 `story` 结构必须走 `js/store.js` 的 `migrateStory` / `SCHEMA` 升级，老存档要能继续打开。

## 五、版本号

`VERSION` 是唯一真源，不要手改 `index.html` 里的 `?v=` 或 `package.json` 的 `version`：

```bash
echo 0.3.1 > VERSION        # 1) 改真源
node tools/sync-version.mjs # 2) 同步到 index.html / package.json
```

## 六、许可红线（重要）

本项目是 **MIT**，所以只能吸收同样是宽松许可（MIT / Apache-2.0 / BSD / OFL）的东西：

- ❌ **不要**粘贴 AGPL-3.0 项目的代码，例如 SillyTavern、InfiPlot——借鉴思路可以，抄代码不行。
- ✅ 新增第三方资源（字体、图标、数据表）时，**必须**在本文末尾「[十一、第三方资源与许可](#十一第三方资源与许可)」一节登记来源与许可，并确认许可与本项目兼容。
- ❌ 提交里不要包含真实 API Key、带 Key 的截图、他人隐私数据。

## 七、提交与 PR

1. Fork → 建分支（`feat/xxx`、`fix/xxx`）→ 改代码 → 本地自检 → 提 PR。
2. 一个 PR 只做一件事。提交信息用 `feat:` / `fix:` / `docs:` / `refactor:` / `chore:` 前缀，一句话说清「改了什么、为什么」。
3. PR 里请写：**改了什么**、**为什么**、**怎么验证的**（贴 `npm test` 的结果最好）。
4. CI 会跑 `node eval/run.js` + 版本号检查 + JS 语法检查，红了请先修再请人 review。
5. 新增用户可见功能请同步更新 `README.md`。

## 八、想帮忙但不知道从哪下手

- README 末尾的 Backlog 就是任务池；挑一个开着 Issue 的来。
- 内容也是贡献：`.irstory.json` 故事、`.irstyle.json` 画风包、角色卡、开局包——不需要写代码。
- 文档纠错、错误提示「人话化」、README 翻译，同样有价值。

---

## 九、行为准则（贡献者公约）

本节改编自 [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)。

### 我们的承诺

为了营造开放、友好的环境，我们作为贡献者与维护者承诺：参与本项目的每个人都不受年龄、体型、可见或不可见的残障、族裔、性别特征、性别认同与表达、经验水平、教育程度、社会经济状况、国籍、个人外貌、种族、宗教或性取向的影响。

我们承诺以促进开放、包容、健康社区的方式行动与互动。

### 我们的准则

有助于营造积极环境的行为：

- 对他人表现出同理心与善意
- 尊重不同的观点、看法与经验
- 给出并优雅地接受建设性反馈
- 承担责任，向受我们错误影响的人道歉，并从中吸取教训
- 关注整体社区的利益，而非只关注个人

不可接受的行为：

- 使用性化语言或意象、性关注或性挑逗
- 挑衅、侮辱或贬损性评论，以及人身攻击或政治攻击
- 公开或私下的骚扰
- 未经明确许可，公布他人的私人信息（如住址、电子邮箱）
- 其他在专业环境中可被合理认为不当的行为

### 适用范围

本公约适用于所有项目空间（Issue、PR、Discussion、提交信息、代码注释等），也适用于个人在公开场合代表本项目时的行为。

### 执行

如遇滥用、骚扰或其他不可接受的行为，请通过项目的**私密渠道**（GitHub 的 Security Advisory，或维护者个人主页上的联系方式）向维护者报告。所有投诉都会被及时、公正地审阅与处理，维护者有义务对报告者身份保密。

维护者有权删除、编辑或拒绝不符合本公约的评论、提交、代码、Issue 及其他贡献，并在必要时说明理由。

### 处理梯度

1. **纠正**：私下提醒，说明为何该行为不当，可能要求公开道歉。
2. **警告**：明确警告，并在指定期限内不得与相关人员互动。
3. **临时封禁**：在一定期限内禁止任何形式的互动。
4. **永久封禁**：对屡教不改或严重违规者，永久禁止参与本项目。

### 来源

本公约改编自 Contributor Covenant 2.1 版，原文以 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 授权发布。

---

## 十、安全说明

### 支持的版本

只有最新发布版本（见 `VERSION`）会收到安全修复，请先把项目更新到最新版再报告问题。

### 报告漏洞

请**不要**在公开 Issue 里贴出可直接利用的细节。推荐用 GitHub 的私密报告入口：

> 仓库页 → **Security** → **Report a vulnerability**（Security Advisories）

直达链接：<https://github.com/LiSheng5/infinite-reading/security/advisories/new>

报告里请包含：影响版本、复现步骤、预期与实际结果、可能的后果。我们会在力所能及的范围内尽快回复；这是一个业余时间维护的项目，请给我们一点时间。

### 威胁模型：先讲清楚它「没有」什么

- **前端没有服务端**：前端本体是纯静态文件，没有后端、没有账号、没有数据库，也就没有「服务器被打穿」这一类问题。
- **没有上传**：故事、设置、Key 都只存在你自己浏览器的 `IndexedDB` 里（旧版本数据在 `localStorage`，升级后只读保留），不会随项目发出去。
- **不代理请求**：浏览器直接请求你在设置里填的第三方 API 地址。
- **有一个「可选的」本地服务**（`sidecar/`，见下一节）：它只在你手动启动时存在，只监听 `127.0.0.1`，不接收任何来自外部的连接。

因此，真正的风险集中在**你的浏览器本地**、**你手动启动的本地服务**和**你连接的第三方服务**上。

### 本地服务（sidecar）的安全边界

| 事项 | 说明 | 应对 |
|---|---|---|
| 只绑回环地址 | 服务只监听 `127.0.0.1:4319`，局域网 / 外网都访问不到 | 不要把绑定地址改成 `0.0.0.0`——那是另一个风险等级，本项目不做 |
| 本地 token | 除 `/health` 外所有接口都要求 `Authorization: Bearer <token>`；token 首启随机生成在 `sidecar/data/config.json` | 防的是「本机其它进程 / 网页乱调你的服务」（DNS rebinding 是 127.0.0.1 上真实存在的攻击面）。别把 token 贴到公开地方 |
| 配置与库是明文 | `config.json`（含 token、邮件密钥）与 SQLite 库都是本地明文文件，权限 `600`，`sidecar/data/` 已加入 `.gitignore` | 与「API Key 明文存 IndexedDB」同等级的取舍；共享设备上别填密钥 |
| SSE 的 token 走查询参数 | `EventSource` 不能自定义请求头，所以 `/api/events?token=…` | 仅在回环地址下可接受；服务端日志**不记录 token、不记录邮件正文** |
| 支付策略不是「防你自己」 | 策略在**代码层**强制执行（单笔 / 每日 / 每月上限、商户与品类名单、冷静期、agent 预算隔离），且 AI 拿不到任何支付凭证 | 你拥有本机文件，理论上可以改配置或改代码绕过。它的价值是**防误操作 + 可审计**，不是防用户自己。**AI 可能出错，请设置合理额度** |
| 不做支付 App 自动化 | 本期只有「模拟支付」与「仅生成订单，由你在微信 / 支付宝里手动付款」两种模式 | 绝不对任何支付 App 做自动化或绕过，绝不保存支付密码；不接真实支付回调 |
| 邮件白名单是后端硬校验 | 不在白名单里的收件人只能落成草稿，必须由你确认后才发出 | 每次发送 / 建草稿 / 被拒都写审计（只记事实，不记正文全文） |

### 已知取舍（不是漏洞，但你需要知道）

| 事项 | 说明 | 应对 |
|---|---|---|
| API Key 明文存 `IndexedDB` | 网页版没有系统凭据库可用，这是刻意的取舍 | 共享设备上别填 Key；导出备份默认不含 Key |
| 数据可能被浏览器清掉 | 清「Cookie 和网站数据」、无痕关窗、Safari 7 天未交互都会丢 | 定期「一键导出全部备份」（想把原图一起留，勾上「带上原图」导出 `.zip`）；应用启动时会申请持久化存储 |
| 字体与图标走 CDN | 字体从 jsDelivr / Google Fonts 加载，理论上存在供应链与隐私（外链请求）问题 | 离线或强隐私场景请自备字体文件本地化；应用图标是本地生成的，不走 CDN |
| Service Worker 会缓存本站静态资源 | 便于离线打开；但**跨域请求一律不拦截、不缓存** | 改完前端看不到变化时，先注销 SW（DevTools → Application）；详见 `sw.js` 顶部注释 |
| `file://` 与 `http://localhost` 数据不通 | 两个 origin 各自独立 | 用导入导出迁移 |
| CORS 被拦 | 部分服务商不允许浏览器直连 | 改用本地静态服务；生视频可用 `tools/video-proxy.mjs` 本地转发。这是服务商策略，不是本项目能修的 |

### 代码里的安全底线（贡献者请注意）

- **模型输出不拼 HTML**：AI 返回的文本一律经 `textContent` / `createTextNode` 渲染，禁止把模型输出或导入文件内容写进 `innerHTML`。新增渲染代码请沿用这条规则。
- **导入文件要校验**：`.irstory.json` / `.irbackup.json` / `.irbackup.zip` 先检查 `format`、`schema` 与包内清单再落库（见 `js/store.js`、`js/app.js` 的 `applyImport` / `applyBackupImport`）。只导入你自己信任来源的文件。
- **ZIP 解包不写磁盘**：`js/zip.js` 只把字节切片还原成 Blob 交给上层，不接受也不生成任何文件路径，因此没有 zip slip（路径穿越）问题；另设条目数 / 解出总长上限，畸形包一律「拒绝处理」而不是硬解。它只读调用方按清单指定的条目，不遍历整包。
- **接口地址是用户自填的**：不要假设 Base URL 可信，也不要往请求里塞除必要字段以外的信息。
- **不要提交密钥**：提交前检查 `git diff` 与截图里没有真实 API Key；`sidecar/data/` 已在 `.gitignore` 里，别把它挪出忽略清单。
- **侧车接口一律鉴权**：新增侧车路由时，除 `/health`（只回布尔能力位）外都必须走 token 校验；请求日志不得输出 token 或邮件正文。
- **安全项真源只在侧车**：额度 / 白名单 / 每日上限 / 免打扰时段不得回存到前端本地，也不得暴露成模型可写的东西。

### 依赖与第三方资源

运行时代码**没有任何第三方 JS 依赖**，第三方资源只有字体，清单与许可见本文「[十一、第三方资源与许可](#十一第三方资源与许可)」。若发现某处引入了带已知漏洞的资源，请按上面的渠道告知我们。

---

## 十一、第三方资源与许可

本项目的**运行时代码没有任何第三方 JavaScript 依赖**：`js/` 下的代码均为本项目原创，只依赖浏览器原生 API（`fetch`、`localStorage`、`FileReader`、`createImageBitmap` 等）。**可选本地服务（`sidecar/`）同样零第三方依赖**，只用 Node 内置能力（`node:http`、`node:sqlite`、`node:fs`、`node:crypto`）。

唯一的第三方资源是**字体**。下面是完整清单，以及分发时需要随附的许可。

### 字体

字体目前以**外链**方式从 CDN 加载（见 `index.html` 的 `<link>` 标签），仓库内**未包含字体文件**。若后续做本地化 / 打包分发，请把字体文件与对应许可文本（OFL 全文）一并放入仓库并在本节补充路径。

| 字体 | 用途 | 来源 | 许可 |
|---|---|---|---|
| 霞鹜文楷 LXGW WenKai | 正文 / 旁白 | npm `lxgw-wenkai-webfont@1.7.0`，经 jsDelivr 分发 | SIL Open Font License 1.1 |
| Noto Serif SC（思源宋体） | 标题 / 正文本 | Google Fonts | SIL Open Font License 1.1 |
| Liu Jian Mao Cao（刘建毛草） | 装饰字 | Google Fonts | SIL Open Font License 1.1 |
| Ma Shan Zheng（马善政毛笔楷书） | 装饰字 | Google Fonts | SIL Open Font License 1.1 |
| Long Cang（龙藏） | 装饰字 | Google Fonts | SIL Open Font License 1.1 |
| ZCOOL XiaoWei（站酷小薇） | 装饰字 | Google Fonts | SIL Open Font License 1.1 |
| Cormorant Garamond | 西文衬线 | Google Fonts | SIL Open Font License 1.1 |
| IM Fell English | 西文复古 | Google Fonts | SIL Open Font License 1.1 |

> Google Fonts 上架的字体一律以 OFL-1.1 或同类自由许可发布；上表的许可类别以各字体官方仓库 / Google Fonts 页面声明为准。

**OFL-1.1 的要点**（完整条款以 [OFL-1.1 原文](https://openfontlicense.org/) 为准）：

- 允许免费使用、修改、再分发，包括用于商业项目；
- 再分发字体文件时必须随附 OFL 全文，并保留字体名称与版权声明；
- 修改后的字体**不得**继续使用原「保留字体名称」；
- 不得单独售卖字体文件本身。

### 外部服务（非本项目代码，仅作默认值提示）

`index.html` 的 Base URL 下拉框里预置了一批服务商地址（智谱、阿里云百炼、DeepSeek、OpenAI、Ollama…），仅为**填表方便**，不构成任何推荐或合作：

- 不预置模型名，不需要任何服务商 SDK；
- 用哪个服务、是否收费、数据如何处理，由使用者与该服务商的条款决定；
- 使用时请自行注意各服务商的 API 速率、计费与内容政策。

### 格式兼容性声明

- **SillyTavern 角色卡 V2/V3**：本项目只实现对 PNG 内嵌 JSON 元数据（`tEXt: chara` / `iTXt: ccv3`）的**格式兼容解析**，未复制其任何代码（SillyTavern 为 AGPL-3.0）。
- 竞品（SillyTavern、InfiPlot、Open Dungeon、NeverEndingQuest 等）仅作**思路参考**，未引入其源码。

### 可选本地服务（sidecar）

`sidecar/` 是**可选**的本地伴侣进程，**本期零第三方依赖**，只使用 Node 内置模块：

| 用途 | 使用的东西 | 位置 |
|---|---|---|
| HTTP 服务 | `node:http`（内置） | `sidecar/server.mjs` |
| 存储 | `node:sqlite`（内置，Node ≥ 22.5） | `sidecar/db.mjs` |
| 文件 / 随机数 / 哈希比较 | `node:fs` / `node:crypto`（内置） | `sidecar/config.mjs` 等 |
| 时区与夏令时 | `Intl.DateTimeFormat`（内置） | `sidecar/cron.mjs` |
| 邮件渠道 | 本期只实现 `mock` 与 `resend`（用内置 `fetch` 调 Resend 的 HTTP API） | `sidecar/email.mjs` |

**计划中、尚未引入**的依赖（引入前会先在此登记并征求确认）：

| 依赖 | 用途 | 许可 | 状态 |
|---|---|---|---|
| `nodemailer` | SMTP 发信（浏览器与 `fetch` 都做不到） | MIT | 计划中（邮件二期） |

如上表所示，本项目刻意**不引入** `express`、`croner` 等常见库：HTTP 路由只有十几个、cron 解析只有几十行，自写更符合本项目的零依赖取舍。

如你认为本清单有遗漏或不准确之处，欢迎提 Issue 指出。
