# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 与 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的写法。
版本号真源是根目录的 `VERSION` 文件，发布时打同名 tag（如 `v0.2.0`）。

## [Unreleased]

### Added

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

- 设置落盘收敛到单一出口 `persistSettings()`：演示模式下自动跳过写盘
- 单文件打包跳过 `js/pwa.js`（单文件版旁边没有 `sw.js`）
- Pages 工作流补上 `icons` / `manifest.webmanifest` / `sw.js`
- CI 增加「单文件打包冒烟」「演示模式冒烟」「PWA 清单与图标自检」三个步骤
- 版本号统一为 `0.2.0`：原先 `css?v=0.5.0` 与 `js?v=0.2.x` 各自漂移，现全部由 `VERSION` 注入
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
