<!-- 感谢贡献！请把下面的模板填完，信息不全的 PR 会被要求补充。 -->

## 改了什么

<!-- 一句话说清这个 PR 做了什么。一个 PR 只做一件事。 -->

## 为什么

<!-- 解决的问题 / 关联 Issue（fix #123）。 -->

## 怎么验证的

- [ ] 双击 `dist/single/index.html` 或本地服务里手动点过一遍，行为符合预期
- [ ] 跑了 `npm test`（全量离线套件：版本一致性 / 对比度 / 各模块单测 / 安全检查，清单见 `package.json`，不花 API），结果：<!-- 贴总分 / 是否全绿 -->
- [ ] 若改了适配器层：真实接口配置下对话 / 生图 / 生视频仍可用
- [ ] 若改了存储结构：老存档能正常打开（`Store.migrateStory` 已升级）
- [ ] 若改了版本号：只改了 `VERSION` 并跑过 `node tools/sync-version.mjs`

## 自查清单

- [ ] 没有引入运行时第三方 JS 依赖（构建期依赖按 `CONTRIBUTING.md` 第十一节登记）；构建入口仍只有 `vite.config.mjs`
- [ ] 新增 app 模块在 `src/app/` 用 `A.reg({...})` 注册，并在 `src/main.js` 的 app 段落 import（不新建全局命名空间）
- [ ] AI 输出 / 导入内容一律经 `textContent` 渲染，没有拼进 `innerHTML`
- [ ] 没有提交 API Key、带 Key 的截图或他人隐私数据
- [ ] 引用的第三方资源（字体、图标、数据）已登记到 `CONTRIBUTING.md` 的「第三方资源与许可」一节，且许可与 MIT 兼容
- [ ] 只借鉴思路、未复制 AGPL 项目（SillyTavern / InfiPlot 等）的代码
- [ ] 用户可见的改动已更新 `README.md` 与 `README.en.md`（中英两份）

## 截图 / 录屏（界面改动必填）

<!-- 拖进来即可。 -->
