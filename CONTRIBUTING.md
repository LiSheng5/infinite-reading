# 贡献指南

先说最重要的一条：**这个项目不需要 `npm install`**。
改 `js/*.js` 或 `css/style.css`，刷新浏览器就能看到效果——没有构建、没有打包、没有编译步骤。

感谢你愿意花时间。下面的规则都很短，读完大概两分钟。

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

> ⚠️ `file://` 和 `http://localhost` 是**两套独立的 localStorage**，开发时固定用其中一种，别来回切。

Node 只在两处用到（都不是必须的）：跑离线评测 `node eval/run.js`、同步版本号 `node tools/sync-version.mjs`。要求 Node ≥ 18。

## 二、目录地图

```
index.html          单页骨架：所有界面区块 + 脚本加载顺序
css/style.css       全部样式（CSS 变量 + 主题）
js/providers.js     适配器层：ChatProviders / ImageProviders / VideoProviders(预留)
js/context.js       上下文组装与压缩：assembleAI1 / assemblePainter / compressStory
js/store.js         存档层：localStorage 唯一出口、schema 迁移、书架
js/roleCard.js      SillyTavern V2/V3 PNG 角色卡解析
js/modelCapabilities.js  模型参数登记表（默认留空）
js/demo.js          离线演示（?demo=1）：内置剧本 + 本地占位图两个适配器
js/app.js           状态机与 UI：回合编排、出图时机、设置、导入导出
eval/run.js         离线评测（零依赖、不花 API）
eval/mock-story.js  评测用的 32 回合长局剧本
eval/demo-smoke.js  演示模式冒烟测试（不开浏览器，验证适配器契约）
manifest.webmanifest / sw.js / js/pwa.js   PWA：清单、Service Worker、注册
icons/              应用图标（由 tools/make-icons.mjs 生成，产物随仓库提交）
Dockerfile / docker-compose.yml / docker/nginx.conf   自托管（纯静态 nginx）
启动.bat             Windows 一键启动（Python 优先，退回 tools/serve.ps1）
tools/              可选脚本（版本号同步、单文件打包、图标生成、本地服务器），不属于运行时代码
docs/               设计稿 DESIGN.md、调研与规划 NOTES.md
```

架构与数据流的细节见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 三、动手前请先跑一遍自检

```bash
node eval/run.js                      # 离线评测：应全部 [命中]，总分不低于基线
node eval/demo-smoke.js               # 演示模式冒烟：18 项契约检查全绿
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
- **加载顺序**：`index.html` 里脚本顺序是 `providers → context → store → modelCapabilities → roleCard → demo → app → pwa`。`app.js` 会立即读取前面所有模块，所以业务模块必须排在它之前；`pwa.js` 是唯一允许排在它之后的（只注册 Service Worker，不碰 `IR`）。
- **改了前端资源看不到变化**：先用 DevTools → Application → Service Workers 注销（`sw.js` 会缓存静态资源），别怀疑人生。
- **渲染安全**：AI 返回的文本一律走 `textContent` / `createTextNode`，**不要**把模型输出拼进 `innerHTML`。
- **文案**：界面与注释用简体中文，术语保持一致（如「世界状态卡」「画师子代理」「存档点」）。
- **数据兼容**：改动 `story` 结构必须走 `js/store.js` 的 `migrateStory` / `SCHEMA` 升级，老存档要能继续打开。

## 五、版本号

`VERSION` 是唯一真源，不要手改 `index.html` 里的 `?v=` 或 `package.json` 的 `version`：

```bash
echo 0.2.1 > VERSION        # 1) 改真源
node tools/sync-version.mjs # 2) 同步到 index.html / package.json
```

## 六、许可红线（重要）

本项目是 **MIT**，所以只能吸收同样是宽松许可（MIT / Apache-2.0 / BSD / OFL）的东西：

- ❌ **不要**粘贴 AGPL-3.0 项目的代码，例如 SillyTavern、InfiPlot——借鉴思路可以，抄代码不行。
- ✅ 新增第三方资源（字体、图标、数据表）时，**必须**在 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) 里登记来源与许可，并确认许可与本项目兼容。
- ❌ 提交里不要包含真实 API Key、带 Key 的截图、他人隐私数据。

## 七、提交与 PR

1. Fork → 建分支（`feat/xxx`、`fix/xxx`）→ 改代码 → 本地自检 → 提 PR。
2. 一个 PR 只做一件事。提交信息用 `feat:` / `fix:` / `docs:` / `refactor:` / `chore:` 前缀，一句话说清「改了什么、为什么」。
3. PR 里请写：**改了什么**、**为什么**、**怎么验证的**（贴 `npm test` 的结果最好）。
4. CI 会跑 `node eval/run.js` + 版本号检查 + JS 语法检查，红了请先修再请人 review。
5. 新增用户可见功能请同步更新 `README.md` 与 `CHANGELOG.md` 的 `[Unreleased]` 段。

## 八、想帮忙但不知道从哪下手

- README 末尾的 Backlog 与 `docs/NOTES.md` 的路线图就是任务池；挑一个开着 Issue 的来。
- 内容也是贡献：`.irstory.json` 故事、`.irstyle.json` 画风包、角色卡、开局包——不需要写代码。
- 文档纠错、错误提示「人话化」、README 翻译，同样有价值。
