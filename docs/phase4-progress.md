# 阶段 4 · 逐屏重写 · 进度

更新：2026-10-26。每屏一个 commit（前后截图与验收证据在 `acceptance/phase4/`，按仓库口径不入库）。

| # | 屏幕 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 首页 | ✅ 完成 | `e0270bb`：Svelte 5 落 `src/screens/home/`，默认挂新屏、`?ui=legacy` 回退；390/1280 × empty/seeded 四张截图与前态 **MD5 逐张一致**（零像素漂移）；入口链路 / 三档动效 / 全量测试绿 |
| 2 | 设置 | ✅ 完成 | commit 1 `c03944a`（行为迁移：「当前故事」三块迁入本对话设置）+ commit 2（设置屏 Svelte 数据驱动重写 + 本对话面板 / 世界状态卡编辑器组件化 + 面板内下钻二级视图）。详见下方「屏 2 · commit 2」 |
| 3 | 书架 | ⬜ 未开始 | |
| 4 | 阅读页 | ⬜ 未开始 | 聊天区 / 输入区 / 选项托盘 / 舞台 / 缩略图条 |
| 5 | 分支页 | ⬜ 未开始 | SVG 树 + `treeLayout` 算法不动 |
| 6 | 弹窗群 | ⬜ 未开始 | 新建 / 向导 / 文本导入 / 导出 / 画师 / 锚定 / 角色卡 / 邮件 / 支付 / 确认 / 提示 |

## 屏 2 · commit 1（行为迁移，已完成，`c03944a`）

「当前故事」组（推进模式 / 存档点 / 世界状态卡与记忆）自全局设置迁入「本对话设置」面板，
方案与决策记录见 [phase4-settings-plan.md](./phase4-settings-plan.md)（窄屏交互已确认：**面板内下钻**）。

- 全局设置 7 组 → 6 组，`g-story` 导航与分组删除；全局保存不再顺带落盘世界卡 / 模式（只管全局）
- 迁移 id 共 25 个（24 个冻结 id + `btn-w-char-add` 补录），与面板既有 `p-mode` / `p-card-open` 去重合并（保留 `s-story-mode` / `btn-edit-card`）
- `settings-ids-test` 拆「全局 130 + 本对话 25」双清单、**双向断言**（在己方容器、不入对方容器），取样边界收紧到两个容器各自注释
- 世界卡表单加「判变账本」（按 story id 记账）：改了没保存不被回合重绘 / 打开全局设置冲掉；换故事照常整画
- 验收证据：`acceptance/phase4/screen2/`（CHECKLIST.md + shots/）

## 屏 2 · commit 2（Svelte 重写 + 面板内下钻）

1. **设置屏 Svelte 重写（任务书 §7.2）**：字段配置真源 `src/screens/settings/settingsForm.js`
   （id / 标签 / 类型 / 分组 / 是否高级 / 自动展开规则）生成 6 组 18 块，取代 legend 文字正则归类；
   `SettingsScreen.svelte` + `Node.svelte` 只产标记，`js/app/*` 的读写行为零改动（仍按 id 绑定）。
   184 个控件 id 全量保留；`settings-ids-test` 升级**双真源**（index.html 两段 + Svelte 源码静态扫描），
   任一侧缺 id 即红、两侧互不串门（挂载容器 `modal-settings` / `story-prefs` 留在 index.html，豁免）。
2. **本对话面板 + 世界状态卡编辑器组件化**：`StoryPrefsPanel.svelte`（一级：覆盖行 + 故事数据）+
   `WorldCardEditor.svelte`（二级编辑器，独立组件、不进字段配置系统）；
   覆盖行（`#prefs-body` 的 p-* 动态行）仍由 `renderStoryPrefs` 渲染——§2.2「对话覆盖设置（不变）」项不搬。
3. **面板内下钻二级视图**（方案 A）：「编辑世界状态卡」→ 二级（正文内滚 + sticky 保存栏）；
   人物行卡化（`charEditor` 增 `variant: 'card'`，向导 / 文本导入仍表格形态）；
   判变禁用「保存世界卡」（`worldFormChanged` 经 `A.worldFormChanged` 共享真源）；
   Esc 层级（二级 → 一级 → 关面板）、进二级焦点移标题、返回还原一级滚动位置；
   下钻进场 `leafIn`（off 档纯透明度 / standard ≤160ms 短位移 / rich 全量，三档由 motion 模块收口）。
4. **截图定稿**：390/1280 前后对比在 `acceptance/phase4/screen2/commit2/`（不入库）；
   设置 6 组与前态**逐像素一致**，本对话面板的「故事数据」区与二级视图为**有意变化**；
   `shoot.mjs` 的 `settings-story` PLAN 空位原地复用为 `story-world-edit`（序号 10 不重排），
   另补 `story-savepoints` / `story-world-empty`。
5. 一处规格偏差待负责人确认：推进模式 / 角色卡入口保留在「故事数据」区（未并入覆盖行清单），
   理由与影响见 `acceptance/phase4/screen2/CHECKLIST.md`。

## 之后的屏幕（3~6）

按任务书顺序逐屏推进，每屏沿用屏 1 的做法：Svelte 组件落 `src/screens/`、默认挂新屏 + `?ui=legacy` 逃生口、
`shoot.mjs` 两宽度前后截图（可与 `acceptance/phase3/shots` 基线比对或经负责人认可）、功能验收清单、全量测试绿后提交。
