# 设置屏专项方案 · 「当前故事」组迁入「本对话设置」

归属：阶段 4 · 屏 2（设置）　状态：**待负责人确认 §3 交互方案后实施**
范围：只动界面归属与入口，故事数据（`world` / 存档点 / `prefs`）的存储结构与字段一个不改。

---

## 0. 一句话

把全局设置里依赖当前故事的三块（推进模式 / 存档点 / 世界状态卡与记忆）搬进「本对话设置」面板，全局设置不再保留入口；窄屏 76vh 底部弹层里用「面板内下钻」承载世界状态卡编辑器；`settings-ids-test` 拆成「全局设置 130 + 本对话设置 24」双清单、双向断言。

---

## 1. 现状（已核实，含出处）

**全局设置 `#modal-settings`**（[index.html](../index.html) L587–1210）7 组导航，分组靠 `legend` 文字正则（[prefsui.js](../js/app/prefsui.js) `GROUP_BY_LEGEND` L18–47），其中 `g-story`「当前故事」组是三个 fieldset：

| 块 | 位置 | 控件 id |
| --- | --- | --- |
| 推进模式 | index.html L1135–1145 | `s-story-mode` |
| 故事 · 存档点 | L1147–1157 | `sp-empty` `sp-panel` `btn-add-savepoint` `sp-list` |
| 故事记忆 · 世界状态卡 | L1159–1201 | `memory-empty` `memory-panels` `btn-inject-memory` `inject-state` `w-place` `w-time` `w-scene` `w-threads` `w-characters` `btn-w-char-add` `w-rel-stage` `w-rel-bonds` `w-rel-notes` `btn-save-world` `world-scribe-at` `rc-status` `btn-edit-card` `sum-count` `summary-list` `tool-list` |

- 渲染回填：[settings.js](../js/app/settings.js) `renderStoryPanels` L332–365；保存：`saveWorldFromForm`（L421）、`worldFormChanged` 判变（L394）；存档点渲染：[library.js](../js/app/library.js) `renderSavepoints` L297。
- **顺序敏感的既有逻辑**：主「保存」会顺带落盘世界卡与模式（settings.js L216–224：先读模式 → 再存世界卡 → 最后换模式），注释写明是为了防「保存后像恢复默认」。
- 对话进行中会按需重绘这几块：[turn.js](../js/app/turn.js) L218 / L249 / L582。

**「本对话设置」面板 `#story-prefs`**（index.html L1212–1220；样式 [style.css](../css/style.css) L1822–1892）：桌面右侧停靠 `min(360px, 92vw)`（`#screen-game.prefs-open` 让位），窄屏（≤720px）底部弹层 **max-height 76vh**。内容由 `renderStoryPrefs`（prefsui.js L709–739）按 `IR.Prefs.visibleFor(mode)` 渲染「跟随全局 / 本对话覆盖」行。

**既有重复（迁移时去重合并）**：面板里已有 `p-mode`（推进模式·本对话，prefsui.js `modeRow` L560）与 `p-card-open`（编辑角色卡，`characterCardRow` L637）；全局 `g-story` 里有 `s-story-mode` 与 `btn-edit-card`。两者是同一功能的双入口。

**人物行编辑器**：[core.js](../js/app/core.js) `charEditor` L420–490，一行 5 字段（姓名 / 在场或离场 / 性格 / 说话方式 / 备注）+ 表头 + 行删除；三处复用（wizard.js `wz-characters`、importer.js `it-characters`、settings.js `w-characters`）。

**settings-ids-test 的口径缺陷**：取样区间是 `id="modal-settings"` … `<!-- ========== 通用确认`（[settings-ids-test.js](../eval/settings-ids-test.js) L67–72），而 `#story-prefs` 恰好落在这个区间里——**现在把 id 搬不搬家测试都绿**。迁移测试时必须把区间收紧到两个容器各自的边界。

---

## 2. 目标形态

### 2.1 全局设置（6 组）

模型 / 辅助模型 / 生图与画风 / 工具与服务 / 数据 / 外观。导航删掉「当前故事」，`GROUP_BY_LEGEND` 与 `GROUP_TITLES` 的 `g-story` 条目删除。没有打开故事时打开设置与今天一致（其余 6 组全是全局项）。

### 2.2 本对话设置面板

自上而下：

1. 头部「本对话设置」+ 关闭（不变）；
2. 当前对话头（不变）；
3. **对话覆盖设置**（不变）：模型 / 画风 / 推进模式 / 选项显示 / 思考链 / 工具 / 定时 / 角色卡 / 布局——保留「跟随全局 · 本对话覆盖」徽标与「重置」；
4. **故事数据**（新增小节标题，来自 `g-story`；这些是故事本身的数据，不是覆盖项，**不打徽标**）：
   - 推进模式 → 并入第 3 条同一行（见 §2.3）；
   - 存档点：摘要行（n 个存档点 · 退出自动存档）+「打一个存档点」+ 列表（`sp-*`）；
   - 世界状态卡：摘要行（地点 · 时间 · 人物 n 位 · 摘要 n 幕）+「编辑」→ 下钻二级视图（§3）；
5. 底注（不变）。

### 2.3 去重合并表

| 内容 | 现全局 id | 现面板 id | 迁移后 |
| --- | --- | --- | --- |
| 推进模式 | `s-story-mode` | `p-mode` | 只留 **`s-story-mode`**（`p-mode` 停用） |
| 角色卡入口 | `btn-edit-card` | `p-card-open` | 只留 **`btn-edit-card`**（`p-card-open` 停用） |

读写代码全按 id 取元素（`renderStoryPanels` / `saveWorldFromForm` / `renderSavepoints`），id 不改则逻辑一行不动，纯搬家。唯一要动的是 settings.js L216–224（主保存顺带落盘世界卡/模式）——见 §5.3。

---

## 3. 窄屏 76vh 底部弹层 · 世界状态卡编辑器交互（专项决策点）

### 3.1 约束

- 弹层 `max-height: 76vh` 不变（任务书给定，390×844 下约 640px 可用高）；
- 编辑器体量：12 个以上控件 + 人物行编辑（每人 5 字段，行数不定）+ 摘要栈 + 留痕；
- 触控目标 ≥40px；「保存世界卡」必须一眼可见、一点够着；
- 桌面停靠面板只有 360px 宽，比窄屏宽不了多少——**同一套交互两个宽度通用**，不做桌面特例。

### 3.2 推荐方案 A：面板内下钻（两级视图）

- **一级（列表）**：§2.2 的行清单。世界状态卡行只露摘要 +「编辑」。
- 点「编辑」→ 弹层内**二级视图**：头部换成「‹ 返回 · 世界状态卡」，正文是编辑器，底部 **sticky 保存栏**（`btn-save-world` + `world-scribe-at`）。窄屏弹层不长高、不换容器，与设置页窄屏「列表 → 下钻」的手势一致（UI-3 既有模式）。
- 摘要栈（`sum-count` / `summary-list`）与工具留痕（`tool-list`）收进二级视图底部 `<details>`，默认折叠（现状也是折叠）。
- **人物行改「行卡」**（`charEditor` 在本面板的响应式形态）：首行「名字 + 在场/离场」各占约一半，下方三个全宽输入（性格 / 说话方式 / 备注），右上角 40px 删除钮；取消表头行（字段已有 label / 占位）。`charEditor` 本体不动，加一个 `variant: 'card'` 渲染分支，向导 / 文本导入两处继续用表格形态。
- 滚动收在二级视图正文内；返回列表保留一级滚动位置。
- 细节：进二级视图焦点移到标题（`tabindex="-1"`）；Esc 先退二级、再关面板；`worldFormChanged` 为假时「保存世界卡」禁用（判变逻辑现成，L394）；对话进行中触发 `renderStoryPanels` 重绘时，**表单已改动（dirty）则跳过回填**，防止书记员校对回来把用户没保存的编辑冲掉（现状在弹窗里也偶发，这次顺手收口）。
- 动效：下钻切换 opacity + ≤160ms 短位移（standard 档），off 档纯透明度 ≤80ms，rich 档不加循环；共享元素过渡留给阶段 5。

### 3.3 备选

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| B 内嵌长滚动 | 二级内容直接铺在 76vh 弹层里滚 + sticky 保存栏 | 改动最小；但 40+ 控件要滚 3~4 屏，回到顶层麻烦，人物行卡化仍要做 |
| C 编辑时弹层升高 | 编辑世界卡时弹层升到 92vh 或全屏二级弹层 | 空间最好；但突破「76vh」给定，且与设置窄屏下钻模式不一致 |

**推荐 A**。若负责人选 B / C，§2、§4、§5 不变，只换 §3 的实现描述。

---

## 4. settings-ids-test 迁移

1. 154 个冻结 id 拆两份：
   - `GLOBAL_SETTINGS_IDS`（130 个，留在 `#modal-settings`）；
   - `STORY_PANEL_IDS`（24 个）：`s-story-mode` `sp-empty` `sp-panel` `btn-add-savepoint` `sp-list` `memory-empty` `memory-panels` `btn-inject-memory` `inject-state` `w-place` `w-time` `w-scene` `w-threads` `w-characters` `w-rel-stage` `w-rel-bonds` `w-rel-notes` `btn-save-world` `world-scribe-at` `rc-status` `btn-edit-card` `sum-count` `summary-list` `tool-list`。
2. **取样收紧**：设置段 = `id="modal-settings"` … `<!-- ========== 本对话设置`；面板段 = `id="story-prefs"` … `<!-- ========== 通用确认`。
3. **双向断言**：24 个必须在面板段、且不得再出现在设置段（防搬漏 / 双份 id）；130 个必须在设置段。
4. `btn-w-char-add`（+ 添加人物）现在不在冻结清单：随行卡改版一并补进 `STORY_PANEL_IDS`（新增不削弱断言）。
5. 过渡期（新旧屏幕开关共存）：legacy 侧继续按 index.html 断言；Svelte 侧按组件源码的 `id` / `data-testid` 断言（测试加第二真源扫描，任一侧缺 id 即红）。动态生成的 `p-*` id 不入清单（与现状一致）。

---

## 5. 用户可见的行为变化（PR 说明里单列）

1. 全局设置少一组「当前故事」；在设置里不再能看 / 改当前故事的世界卡与存档点。
2. 这三块只在「本对话设置」里（阅读页 HUD 的「本对话设置」入口）；**没有打开故事时没有入口**（原「进入一个故事后……」提示文字随之取消）。全局设置弹窗从书架 / 首页也能开，开完看不到故事块——这是本次决策的既定结果。
3. 主「保存」不再顺带落盘世界卡 / 模式（settings.js L216–224 移除）；模式切换与覆盖项即时生效，世界卡走「保存世界卡」。语义变干净：**全局保存只管全局**。
4. 数据零变化：`world`、`prefs`、存档点、摘要栈、留痕的结构与字段不动；`file://` 与 `localhost` 两套存储不混。

---

## 6. 实施与验收（屏 2 一个 PR，内部三个 commit）

1. **行为迁移**（legacy DOM 上先做）：搬组 + §2.3 去重合并 + settings-ids-test 双清单双向断言 + L216–224 收口；
2. **Svelte 重写**：设置屏按任务书 §7.2 数据驱动字段配置（id / 标签 / 类型 / 分组 / 是否高级 / 自动展开规则）生成；本对话设置面板与世界状态卡编辑器组件化（编辑器是独立组件，不进字段配置系统）；
3. **截图与验收单**：390 / 1280 两宽度，前后对比或经负责人认可。

**截图清单**：设置 6 组（原 7 组）、无故事时打开设置、有故事的本对话设置一级列表、世界卡二级视图（空世界 / 有世界各一）、存档点列表 n 个、窄屏 76vh 弹层下钻与返回。

**验收清单**：

- [ ] 24 个迁移 id 全部在面板段、130 个全局 id 不动；settings-ids-test 双向断言绿
- [ ] 世界卡：改动 → 保存世界卡 → 刷新读回一致；未改动时保存钮禁用；主保存不再误写世界卡；dirty 时不被回合重绘冲掉
- [ ] 存档点：打点 / 回退 / 退出自动存档逻辑不变
- [ ] 模式：三种模式下 `visibleFor` 渲染正确；切换即时生效；记忆数据不随切换清空
- [ ] 角色卡入口（`btn-edit-card`）打开编辑器 / 导入 PNG 正常
- [ ] 76vh 弹层：下钻 / 返回、滚动位置、sticky 保存栏、Esc 层级、焦点管理
- [ ] 窄屏可点目标 ≥40px；三档动效下钻切换符合 off / standard / rich 规则
- [ ] 全量 `npm test` 绿；回归夹具导入 → 还原 → 导出逐字段一致（数据层没动，仍要跑）
