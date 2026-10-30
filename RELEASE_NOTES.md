# 无限阅读 0.13.0 · 发布说明

发布日期：2026-10-29 ｜ 上一版：0.12.1 ｜ 目标平台：Chrome / Edge / Firefox / Safari（桌面）与 PWA

这一版把「纯前端零构建」迁到 **Vite 8 + Svelte 5**，逐屏重做了界面层，并保留了两种发布形态：

- `dist/single/index.html`：单文件，双击（`file://`）即可打开，JS / CSS / 图标全部内联（图标为 data URL，产物目录只有这一个 HTML；PWA 的 manifest 只随 `dist/site/`）
- `dist/site/`：多文件，供 GitHub Pages 与 Docker 使用，可安装为 PWA、断网可用

## 一、这次更新

- **架构**：应用层拆成 `src/app/` 的模块注册表（`A.reg` 晚绑定），核心逻辑收进 `src/core/`（TS 类型 + 纯模块）；全局 `IR` 命名空间与 `?ui=legacy` 逃生口已删除。
- **界面**：首页 / 设置 / 书架 / 阅读页 / 分支页 / 11 个弹窗全部换成 Svelte 组件，图标、文案、交互口径保持不变。
- **设置**：改为数据驱动的字段配置；「当前故事」组（推进模式 / 存档点 / 世界状态卡）按既定决策迁入「本对话设置」；154 个控件 id 全保留。
- **动效**：统一的 `off / standard / rich` 三档；切屏、换画、切兄弟、分支开合、弹窗开合走 View Transitions（不支持时淡入降级）；过渡期冻结底层循环、结束按同一相位复位。
- **构建**：版本号由 `VERSION` 在构建时注入，首页底部版本文字不再手写；Service Worker 预缓存清单改为构建期生成（不再靠正则解析 `index.html`）。
- **下线**：离线演示 `?demo=1`（无入口、无演示适配器、无内置剧本）；旧界面逃生口 `?ui=legacy`；组件库自查页 `?ui=1`。

## 二、对用户数据零影响（验证结果）

存档格式一个字段都没有改：IndexedDB 库结构、`.irstory.json`、`.irbackup.json`、带原图的 `.zip` 仍是 0.12.x 的形状。
验证方式与结果（可复跑：`node acceptance/tools/fixture.mjs roundtrip` / `selftest`）：

| 夹具 | 流程 | 结果 |
|---|---|---|
| `backup-plain.irbackup.json`（3 个故事） | 干净上下文 → 真实 UI 导入 → 还原 → 真实 UI 再导出 | **逐字段 0 差异**；3 个故事（剧情 / 智能体 / 扮演）全部还原 |
| `backup-with-src.zip`（带原图） | 同上 | **逐字段 0 差异**；2 张原图按 id 对齐后**逐字节一致** |
| `story-choice-full.irstory.json`（分支 + 图 + 视频条目 + 存档点） | 同上 | **逐字段 0 差异**；树干 8 节点、存档点、角色卡均还原 |
| `story-rp-full.irstory.json`（扮演 + 角色卡） | 同上 | **逐字段 0 差异**；角色卡「凌霜」还原 |

- 只放行「注定会变」的字段：导出时刻 `exportedAt`、版本串 `app`、导入落盘刷新的 `updatedAt`、导入标题的「（导入）」后缀、图片重建的 `ts`。其余任何字段不一致都算失败。
- 比对器自检（负测试）：改坏 `world.place`、删字段、加字段、数组条数变化、单故事标题真不一致，全部能被抓出；放行字段不误报。这保证「逐字段一致」不是空跑。
- API Key：默认导出与夹具文件**不含任何 Key / baseUrl**；带 Key 的导出只做内存校验，从不落盘。侧车的 `sidecar.token` 属本机凭据，任何模式都不进备份，导入时也不采信包里的值。
- 全量 `npm test` 通过（含 schema / store / tree / prefs / 设置 id / zip / 侧车 / 前端冒烟 / `tsc --noEmit`），旧版存档的迁移路径仍在测试覆盖内。
- `file://` 与 `localhost` 的存储隔离保持原样：升级不会合并、移动或重写任一边的存档。

## 三、发布前验收

- **截图**：25 张 390 / 1280 空态截图与阶段 6 入口基线（phase 5 收尾）对照——**23 张逐字节一致**；其余 2 张只差首页底部版本文字（`v0.12.1` → `v0.13.0`，98 px、20×9 的局部差异），**真回归 0**。与 0.12.1 原始基线的差异均为阶段 3–5 已记录的组件库 / 设置改版（明细见 `acceptance/phase6/SHOTS-REPORT.md`）。
- **产物冒烟**：`dist/single/index.html` 在 `file://` 下启动、四块屏齐全、可切屏、零外链、不注册 Service Worker；`dist/site` 装好 Service Worker 后断网 reload 仍能启动并切屏（`acceptance/phase6/pwa-offline/pwa-offline.json`，19 条断言全绿）。
- **动效**：`off` 无位移无循环、`standard` 无循环、`rich` 完整；过渡期循环冻结与结束复位自检 68 条断言全绿；系统「减少动态效果」时 `auto` 解析为 `off`。
- **零外联**：产物内联全部资源，运行时没有任何新增的远程请求（字体 / CDN / 统计均无）。

## 四、已知缺口与说明

- 未在真实 iOS Safari 上手动验证（0.12.1 起即为已知缺口）。
- 暗色主题不在本轮范围；颜色仍全部走令牌，未堵死后续立项。
- `ARCHITECTURE.md` 的图示未重画，文字已同步；README 截图由负责人之后替换为真实演示图。

## 五、升级方式

照旧打开即可：`file://` 双击单文件，或部署 `dist/site/`。不需要迁移脚本，也不会改动已有故事；如果你同时用 `file://` 和 `localhost` 两种方式打开，它们仍是两套彼此独立的本地存档。
