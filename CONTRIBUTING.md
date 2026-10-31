# 贡献指南

先说最重要的一条：**这个项目需要构建，但不需要后端**。`npm ci` 之后用 `npm run dev` 起 Vite dev server 改代码；`npm test` 跑全量离线套件（39 个 `eval/*` 门禁 + 类型检查），**不联网、不花钱**。

感谢你愿意花时间。本文包含四部分：**贡献流程（一~八）**、**行为准则（九）**、**安全说明（十）**、**第三方资源与许可（十一）**；后三部分按需查阅。

---

## 一、本地跑起来

```bash
git clone <你的 fork 地址>
cd infinite-reading
npm ci          # 只装构建 / 测试依赖（Vite、Svelte、TypeScript、Playwright）
npm run dev     # 开发服务器（热更新）
```

需要 **Node ≥ 24**（与 CI 同版本：`eval/*` 直接 `require` `.ts` 靠内置类型剥离、侧车用内置 `node:sqlite`；`package.json` 的 `engines` 有记录）。

发布前请用**构建产物**验收（dev server 与产物行为可能不同，Service Worker、单文件内联都只在产物里）：

| 方式 | 命令 / 操作 | 说明 |
|---|---|---|
| 多文件产物 | `npm run build:site` → `npx serve dist/site` | 与 GitHub Pages / Docker 同一份产物，PWA 可安装 |
| 单文件产物 | `npm run build:single` → 双击 `dist/single/index.html` | `file://` 的真实形态（JS/CSS/图片全内联） |
| 二次打包 | `npm run bundle` → `dist/ir.html` | 把单文件产物复制成对外发布的名字 |
| 一键启动 | 双击 `启动.bat`（Windows） | 没有产物会先构建，再起本地服务（Python 优先，退回 `tools/serve.ps1`） |

> ⚠️ `file://` 和 `http://localhost` 是**两套独立的本地存储（IndexedDB / localStorage 都按 origin 隔离）**，开发时固定用其中一种，别来回切。

验收脚本（`acceptance/`）需要读 / 写内部状态时，给产物 URL 加 `?ir-test=1`：`src/main.js` 末尾会把当前模块的真实导出挂到 `window.__IR_TEST__`（`App / Store / Tree / Context / Motion / Nav / ModalHost / providers / Sidecar`）。不带该参数时这个对象不存在，产物与普通双击完全一致；**应用代码不得引用它**。

## 二、目录地图

```
index.html              单页骨架：只留挂载容器（旧 DOM 已删）+ 图标 sprite + 唯一入口 <script type="module" src="src/main.js">
src/main.js             唯一入口：应用层 → 各屏 → 组合根 → PWA（import 顺序即依赖顺序）
src/app/                界面行为层（21 个 ES module + 组合根 main.js）：事件绑定 / 回合编排 / 渲染推进 / 弹窗流程；A.state 共享状态 + A.reg 注册表
src/core/               核心逻辑（TS，Node 可 require）：providers / context / tree / treeLayout / storage / store / schema / prefs / motion / titles / search / roleCard / zip / sidecar / features / paintQueue / proposals / importText / backupPack / version
src/ui/                 基础组件库（Svelte 5）+ 动效 / 切屏 / 弹窗栈 / 视图过渡内核
src/screens/            7 个屏幕的组件与 $state 模块：home / settings / storyPrefs / shelf / read / branch / modal
css/tokens.css          设计令牌真源（颜色 / 时长 / 缓动 / 圆角 / 表单字号 --fs-field）；:root 之外不写颜色字面量
css/style.css           屏幕样式入口（只有 @import + 设计原则 / 断点标尺 / 按钮词汇）
css/{base,home,shelf,read,overlays,responsive,settings,branch,icons}.css   9 个分片：import 顺序 = 层叠顺序（M4）；某个屏的样式就改它那一片
css/motion.css          动效档位收口 + @keyframes 唯一定义点 + 暂停规则
eval/run.js             离线评测（不花 API）
eval/mock-story.js      评测用的 32 回合长局剧本
eval/_harness.js        门禁共用脚手架：check / finish / run / loadEsm / localMs（不单独跑，不算门禁）
eval/*-test.js          39 个门禁：tokens / css-structure / comments / error-policy / motion / settings-ids / capability-scope / schema / tree / prefs / backup-pack / store-images / platform / proposals / writeback / features / ui-state / reply-text / zip / 生视频转发 / 客户端重连 / 侧车 …
sidecar/                可选本地服务（Node 进程，零第三方依赖）：server / scheduler / cron / email / payment / payment-policy / config / db / events
manifest.webmanifest / sw.js / src/pwa.js   PWA：清单（颜色字段是 __IR_THEME_COLOR__ 占位，构建期从 --bg 展开）、Service Worker、注册
icons/                  应用图标（由 tools/make-icons.mjs 生成，产物随仓库提交）
Dockerfile / docker-compose.yml / docker/nginx.conf   自托管（纯静态 nginx 托管 dist/site）
启动.bat                Windows 一键启动（构建 + 本地服务）
tools/                  构建与验收脚本（版本号同步、单文件打包、图标生成、本地服务器、video-proxy.mjs），不属于运行时代码
```

架构与数据流的细节见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 三、动手前请先跑一遍自检

```bash
npm test        # = 版本号一致性 + 配色/令牌/动效护栏 + 39 个 eval 门禁 + 结构门禁 + tsc
```

它的组成与用途：

- `node eval/run.js`：用固定剧本重放 32 回合，检查「上下文组装 / 压缩 / 启发式召回 / 角色卡 / 画像」是否被改坏——**不调用任何 API、不产生费用**，改记忆机制前尤其要先跑。
- `node eval/tokens-test.js` / `node eval/motion-test.js`：`:root` 之外无颜色字面量、`@keyframes` 属性白名单、三档动效声明表与 CSS 逐项对齐。
- `node eval/css-structure-test.js`：样式分片与入口 `@import` 一一对应且顺序固定、断点只用标尺（480 / 640 / 720 / 721 / 900 / `hover: none`）、按钮只有 `.ui-btn` 一套词汇（旧类名一律拦下）。改 CSS 前先看它。
- `node eval/comments-test.js`：注释里不许出现仓库外的编号（任务书章节号、审查条目号、阶段号、轮次号）；要引用就引仓内文档（`ARCHITECTURE.md §4.2`）。约定见 §四「注释写什么」。
- `node eval/error-policy-test.js`：网络 / 模型 / 存储这类真实失败的 catch 不许静默吞掉（必须有上报出口或说明性注释）；同时单测 `errorText` / `shortError` / `failureEntry`。约定见 `ARCHITECTURE.md §2.2` 与 §四「失败处理」。
- `node eval/settings-ids-test.js`：148 个设置控件 id 一个不能少（唯一真源是 `src/screens/settings` 与 `src/screens/storyPrefs`）；已下线的能力位控件（思考档位 / 尺寸档位 / 质量）不许回来。
- `node eval/capability-scope-test.js`：模型参考表只登记上下文窗口——`providers.ts` 不许按表塑形请求体（温度 / 尺寸照发，厂商形参走「自定义请求参数」），表里也不许再出现 image / video / thinking / sizes / quality。
- `node eval/app-structure-test.js`：入口 import 顺序、模块行数上限、`A.reg` 键唯一、顶层解构白名单、高频入口（`renderChat` / `saveAll` / `toast`）必须是 `core.js` 的命名导出（调用方不再写 `A.xxx`）。
- `node eval/platform-test.js`：浏览器能力的两处边界——IndexedDB 开库被**别的标签页挡住**（`blocked`）是瞬时状态，必须能重试且不把会话判死，只有真错误才降级；Service Worker 的 `activate` 只清带 `ir-v` 前缀的旧缓存（同源还挂着别的项目）。
- `node eval/features-test.js`：主动消息编排（同 `fireId` 只送一次 / 忙时排队 / 条件满足按序投递）；`clear()` 撤回待送时连去重记忆一起清——只清队列会让被撤掉的触达在下次补跑时被静默丢弃。见 `ARCHITECTURE.md §2` 的 `src/core/features.ts` 行。
- 侧车相关的门禁（`scheduler-test` / `email-test` / `payment-test` / `sidecar-smoke` / `frontend-smoke`）共用 `eval/_harness.js`：断言、汇总、退出码、`loadEsm()`（动态 import 侧车模块）、`localMs()`（本地时区的日期构造）。新写门禁直接 `require('./_harness.js')` + `run('标题', main)`，不要再抄一份 `check()` 与汇总循环。
- `tsc --noEmit`：`src/core/*.ts` 的类型检查。

## 四、代码取向

- **构建期依赖可以有，运行时第三方依赖不行**：不引入运行时 JS 库；不新增任何远程请求（字体、CDN、统计）。项目承诺「纯本地运行」。
- **数据层不许动**：`story` 结构 / `.irstory.json` / `.irbackup.json` / `.zip` 备份一个字段都不许改；改动结构必须走 `src/core/store.ts` 的 `migrateStory` / `SCHEMA` 升级，老存档要能继续打开（`eval/schema-test.js` + 回归夹具守着）。
- **模块写法**：核心逻辑是 ES module（`src/core/*.ts`，各自 export 真实 API、模块间静态 import）；界面行为层是 ES module + `src/app/core.js` 的注册表 `A`——**不要**新建全局命名空间（旧的 `window.IR` 已删）。跨模块调用写 `A.xxx()`，只在顶部解构 core 的导出；高频入口（`renderChat` / `saveAll` / `toast`）例外，从 `./core.js` 命名 import（IDE 能 Ctrl+Click），口径与门槛见 `ARCHITECTURE.md §2.1` 第 2 条。
- **界面写法**：屏幕用 Svelte 5（`$state` / `$props`），状态模块与组件分离；容器只替换内容，屏幕可见性仍归 `src/ui/navigation.js` 的 `Nav.showScreen`。安全红线：用户 / 模型产出**一律文本插值**，禁止 `{@html}` 与 `innerHTML`（`eval/ui-lib-test.js` 会拦）。
- **动效**：任何新动画都要在 `src/core/motion.ts` 的 `ANIMATIONS` / `TRANSITIONS` 声明三档行为；`@keyframes` 只写在 `css/motion.css`；`off` 档不许有位移与循环。
- **改了前端资源看不到变化**：先用 DevTools → Application → Service Workers 注销（`sw.js` 会缓存静态资源），别怀疑人生。
- **文案**：界面与注释用简体中文，术语保持一致（如「世界状态卡」「画师子代理」「存档点」）。
- **失败处理**：用户可行动的失败 → `A.reportUserFailure`（错误 toast 7 秒 + 调用方保留重试入口）；纯后台降级 → `A.reportBackgroundFailure`（`console.warn`，影响故事状态时用 `A.failureEntry` 在 `WriteBack` 闸内落 tool 留痕）；清理 / 探测 / 解析兜底可以吞，但 catch 里要写清为什么。**真实失败绝不允许空 catch**，`eval/error-policy-test.js` 会逐个拦下。完整口径见 `ARCHITECTURE.md §2.2`。
- **注释写什么**：写**为什么**，不写「见某某任务书 §x」「审查 D5」——那些文档不在仓库里，编号半年后没人能追溯。要引用就引仓内文件（`ARCHITECTURE.md §4.2`、`eval/xxx-test.js`），并且让读者点得开；一句话能说清的约束就别只留编号。`eval/comments-test.js` 会把外部编号（任务书章节号 / 审查条目号 / 屏号 / 阶段号 / 轮次号）与「删编号留下的空括号、连续标点」一起拦下。

## 五、版本号

`VERSION` 是唯一真源；**运行时版本号全部构建注入**，源码里不许写 `vX.Y.Z`：

- 首页版本文字：`src/screens/home/HomeScreen.svelte` 的 `__IR_VERSION__`（vite `define`）
- 导出包 / 备份包戳：`src/core/version.ts` 的 `APP_VERSION`（同一占位）
- Service Worker 缓存名：`sw.js` 的 `'ir-v' + '__IR_VERSION__'`，构建期替换
- HTML 版本戳：`index.html` 的 `<meta name="ir-version" content="__IR_VERSION__">`，构建期由 `vite.config.mjs` 替换

```bash
echo 0.13.0 > VERSION      # 1) 改真源
npm run sync:version       # 2) 同步 package.json / package-lock.json 与 README 徽章/「当前版本」行
```

`node tools/sync-version.mjs --check`（`npm test` 第一步）会守三条红线：占位符不许丢（`sw.js` / 首页 / `version.ts` / `index.html` 四处）、`?v=` 不许回来、`src/` 与 `sw.js` 里不许出现当前版本的字面量；同步目标文件缺失或命中数不对一律报错，不算通过。

## 六、许可红线（重要）

本项目是 **MIT**，所以只能吸收同样是宽松许可（MIT / Apache-2.0 / BSD / OFL）的东西：

- ❌ **不要**粘贴 AGPL-3.0 项目的代码，例如 SillyTavern、InfiPlot——借鉴思路可以，抄代码不行。
- ✅ 新增第三方资源（字体、图标、数据表）时，**必须**在本文末尾「[十一、第三方资源与许可](#十一第三方资源与许可)」一节登记来源与许可，并确认许可与本项目兼容。
- ❌ 提交里不要包含真实 API Key、带 Key 的截图、他人隐私数据。

## 七、提交与 PR

1. Fork → 建分支（`feat/xxx`、`fix/xxx`）→ 改代码 → `npm test` + `npm run build` 本地自检 → 提 PR。
2. 一个 PR 只做一件事。提交信息用 `feat:` / `fix:` / `docs:` / `refactor:` / `chore:` 前缀，一句话说清「改了什么、为什么」。
3. PR 里请写：**改了什么**、**为什么**、**怎么验证的**（贴 `npm test` 的结果最好；界面改动请附 390 / 1280 两个宽度的前后截图）。
4. CI 会跑语法检查、结构门禁、版本号、离线评测、构建与产物自检；红了请先修再请人 review。
5. 新增用户可见功能请同步更新 `README.md` 与（必要时）`ARCHITECTURE.md`。

## 八、想帮忙但不知道从哪下手

- README 末尾的 Backlog 就是任务池；挑一个开着 Issue 的来。
- 内容也是贡献：`.irstory.json` 故事、角色卡、开局包——不需要写代码。
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
| 本地 token | 除 `/health` 外所有接口都要求 `Authorization: Bearer <token>`；token 首启随机生成在 `sidecar/data/config.json`，**导出备份时无条件剥离**（即使勾选带上 API Key 也不带它） | 防的是「本机其它进程 / 网页乱调你的服务」（DNS rebinding 是 127.0.0.1 上真实存在的攻击面）。别把 token 贴到公开地方 |
| 只认本机来源（Host + Origin） | 每个请求先校验 `Host` 只接受 `127.0.0.1 / localhost / [::1]`（否则 403 `BAD_HOST`），再校验 `Origin` 只接受本机页面（别的站点 403 `ORIGIN_NOT_ALLOWED`）；`file://` 的字面量 `null` 只对**带 token / SSE ticket** 的请求回显 CORS，`/health` 与预检例外 | Host 是 DNS rebinding 的**唯一识别点**：攻击页在浏览器侧与本机同源，连 CORS 都不触发，只靠 CORS 兜是兜不住的。`Origin: null` 与任意站点的沙箱 iframe 在浏览器侧完全一样（实测都是 `Origin: null` + `Sec-Fetch-Site: cross-site`），所以它不再「一律放行」——没有 token 的页面读不到任何响应。机器名 / 局域网 IP 打开的页面用不了侧车三件套，请用 localhost 打开 |
| 配置与库是明文 | `config.json`（含 token、邮件密钥）与 SQLite 库都是本地明文文件，权限 `600`（Windows 上 `mode:0o600` 无效，启动写盘时会用 `icacls` 把 `config.json` 收紧为仅当前用户可读写，失败不阻断），`sidecar/data/` 已加入 `.gitignore`；仓库自带的静态服务（`启动.bat` / `tools/serve.py` / `tools/serve.ps1`）对 `sidecar/data/` 与 `.git/` 统一拒绝 | 与「API Key 明文存 IndexedDB」同等级的取舍；共享设备上别填密钥；自己起别的静态服务时也要排除这两个目录 |
| SSE 走短时效一次性 ticket | `EventSource` 不能自定义请求头，token 也**不进 URL**（会进代理 / 访问日志 / Referer）：先 `POST /api/events/ticket`（Bearer）换一张 30 秒有效、一次性 ticket，再以 `/api/events?ticket=…` 连接 | 服务端日志**不记录 token、不记录邮件正文**；ticket 用掉即删，连接数有上限（超限 429） |
| 支付策略不是「防你自己」 | 策略在**代码层**强制执行（单笔 / 每日 / 每月上限、商户与品类名单、冷静期、agent 预算隔离、**长期授权范围 mandate 强制**：下单必须挂在用户签发的授权上，agent 与币种由服务端按授权 / 配置映射，不采信请求体自报），且 AI 拿不到任何支付凭证 | 你拥有本机文件，理论上可以改配置或改代码绕过。它的价值是**防误操作 + 可审计**，不是防用户自己。**AI 可能出错，请设置合理额度** |
| 不做支付 App 自动化 | 本期只有「模拟支付」与「仅生成订单，由你在微信 / 支付宝里手动付款」两种模式 | 绝不对任何支付 App 做自动化或绕过，绝不保存支付密码；不接真实支付回调 |
| 邮件白名单是后端硬校验 | 不在白名单里的收件人只能落成草稿，必须由你确认后才发出 | 每次发送 / 建草稿 / 被拒都写审计（只记事实，不记正文全文） |

### 已知取舍（不是漏洞，但你需要知道）

| 事项 | 说明 | 应对 |
|---|---|---|
| API Key 明文存 `IndexedDB` | 网页版没有系统凭据库可用，这是刻意的取舍 | 共享设备上别填 Key；导出备份默认不含 Key |
| 数据可能被浏览器清掉 | 清「Cookie 和网站数据」、无痕关窗、Safari 7 天未交互都会丢 | 定期「一键导出全部备份」（想把原图一起留，勾上「带上原图」导出 `.zip`）；应用启动时会申请持久化存储 |
| 不加载远程字体 / 图标 | 字体走系统自带栈（旁白衬线 / 界面无衬线 / 提示词等宽），图标是本地 sprite 与本地生成的 PNG——运行时**没有任何外链请求** | 断网也能用；想换字体请自备本地字体文件并登记许可见 §十一 |
| Service Worker 会缓存本站静态资源 | 便于离线打开；但**跨域请求一律不拦截、不缓存** | 改完前端看不到变化时，先注销 SW（DevTools → Application）；详见 `sw.js` 顶部注释 |
| `file://` 与 `http://localhost` 数据不通 | 两个 origin 各自独立 | 用导入导出迁移 |
| CORS 被拦 | 部分服务商不允许浏览器直连 | 改用本地静态服务；生视频可用 `tools/video-proxy.mjs` 本地转发。这是服务商策略，不是本项目能修的 |

### 代码里的安全底线（贡献者请注意）

- **模型输出不拼 HTML**：AI 返回的文本一律经 `textContent` / `createTextNode` 渲染，禁止把模型输出或导入文件内容写进 `innerHTML`。新增渲染代码请沿用这条规则。
- **导入文件要校验**：`.irstory.json` / `.irbackup.json` / `.irbackup.zip` 先检查 `format`、`schema` 与包内清单再落库（见 `src/core/store.ts` 与 `src/app/backup.js` 的 `applyImport` / `applyBackupImport`）。只导入你自己信任来源的文件。
- **ZIP 解包不写磁盘**：`src/core/zip.ts` 只把字节切片还原成 Blob 交给上层，不接受也不生成任何文件路径，因此没有 zip slip（路径穿越）问题；另设条目数 / 解出总长上限，畸形包一律「拒绝处理」而不是硬解。它只读调用方按清单指定的条目，不遍历整包。
- **接口地址是用户自填的**：不要假设 Base URL 可信，也不要往请求里塞除必要字段以外的信息。
- **不要提交密钥**：提交前检查 `git diff` 与截图里没有真实 API Key；`sidecar/data/` 已在 `.gitignore` 里，别把它挪出忽略清单。
- **侧车接口一律鉴权**：新增侧车路由时，除 `/health`（只回布尔能力位）外都必须走 token 校验；请求日志不得输出 token 或邮件正文。
- **安全项真源只在侧车**：额度 / 白名单 / 每日上限 / 免打扰时段不得回存到前端本地，也不得暴露成模型可写的东西。

### 依赖与第三方资源

运行时代码**没有任何第三方 JS 依赖**，也没有远程字体 / 图标；构建与测试依赖（Vite / Svelte / TypeScript / Playwright）的清单与许可见本文「[十一、第三方资源与许可](#十一第三方资源与许可)」。若发现某处引入了带已知漏洞的资源，请按上面的渠道告知我们。

---

## 十一、第三方资源与许可

本项目的**运行时代码没有任何第三方 JavaScript 依赖**：`src/` 下的代码均为本项目原创（Svelte 运行时会被编译进产物，见下表），只依赖浏览器原生 API（`fetch`、`localStorage`、`FileReader`、`createImageBitmap` 等）。**可选本地服务（`sidecar/`）同样零第三方依赖**，只用 Node 内置能力（`node:http`、`node:sqlite`、`node:fs`、`node:crypto`）。

运行时不加载任何第三方字体或图标：字体走系统自带栈（没有远程 `<link>`），图标是本地 sprite 与 `tools/make-icons.mjs` 生成的 PNG。若将来引入字体文件，请把文件与对应许可文本一并放入仓库并在本节登记。

### 构建与测试依赖（不进入运行时，Svelte 运行时会编译进产物）

| 依赖 | 用途 | 许可 |
|---|---|---|
| `vite` / `vite-plugin-singlefile` | 构建、单文件内联 | MIT |
| `svelte`（含运行时） | 界面组件与编译产物 | MIT |
| `@sveltejs/vite-plugin-svelte` | Svelte 的 Vite 插件 | MIT |
| `typescript` / `tsc` | `src/core/*.ts` 类型检查 | Apache-2.0 |
| `playwright` | 验收脚本（截图 / 夹具 / 冒烟），只在本地跑 | Apache-2.0 |

### 外部服务（非本项目代码，仅作默认值提示）

设置页的 Base URL 下拉框里预置了一批服务商地址（智谱、阿里云百炼、DeepSeek、OpenAI、Ollama…，见 `src/screens/settings/settingsForm.js`），仅为**填表方便**，不构成任何推荐或合作：

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
| 存储 | `node:sqlite`（内置，Node ≥ 24） | `sidecar/db.mjs` |
| 文件 / 随机数 / 哈希比较 | `node:fs` / `node:crypto`（内置） | `sidecar/config.mjs` 等 |
| 时区与夏令时 | `Intl.DateTimeFormat`（内置） | `sidecar/cron.mjs` |
| 邮件渠道 | 本期只实现 `mock` 与 `resend`（用内置 `fetch` 调 Resend 的 HTTP API） | `sidecar/email.mjs` |

**计划中、尚未引入**的依赖（引入前会先在此登记并征求确认）：

| 依赖 | 用途 | 许可 | 状态 |
|---|---|---|---|
| `nodemailer` | SMTP 发信（浏览器与 `fetch` 都做不到） | MIT | 计划中（邮件二期） |

如上表所示，本项目刻意**不引入** `express`、`croner` 等常见库：HTTP 路由只有十几个、cron 解析只有几十行，自写更符合本项目的零依赖取舍。

如你认为本清单有遗漏或不准确之处，欢迎提 Issue 指出。
