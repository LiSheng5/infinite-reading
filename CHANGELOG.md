# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 与 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的写法。
版本号真源是根目录的 `VERSION` 文件，发布时打同名 tag（如 `v0.2.0`）。

## [Unreleased]

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
- 版本号 0.2.0 → 0.3.0（Service Worker 缓存名随之更换，旧资源整批淘汰）
- 设置落盘收敛到单一出口 `persistSettings()`：演示模式下自动跳过写盘
- 单文件打包跳过 `js/pwa.js`（单文件版旁边没有 `sw.js`）
- Pages 工作流补上 `icons` / `manifest.webmanifest` / `sw.js`
- CI 增加「单文件打包冒烟」「演示模式冒烟」「ZIP 读写冒烟」「PWA 清单与图标自检」四个步骤
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
