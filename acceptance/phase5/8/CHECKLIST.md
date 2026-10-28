# 阶段 5 · 第 8 步 · 收尾 · 验收清单

前置：第 1~7 步已落地（`3c95dd6` … `0e48d76`）。本步只做三件事：

1. **过渡期与循环预算的冲突处理**（任务书第 8 步的「做什么」）：过渡中冻结循环、结束后复位，过渡期间不重排预算；
2. **全量验收**：`npm test`、`npm run build` 两份产物、探针三档、`shoot.mjs` 逐字节、`file://` 双击、PWA 断网；
3. **把过渡名单 / 三档表 / 降级策略 / 循环上限写进现有动效说明**：`ARCHITECTURE.md` §5.1（`CONTRIBUTING.md` 的目录地图同步修正一条过期路径）。

## 一、改了什么

| 文件 | 改动 |
|---|---|
| `src/ui/motion.js` | 新增 `holdLoops()`：暂停所有正在跑的真实 DOM 循环，返回计数式解冻函数；`resumeFrozenLoops()` 只恢复自己暂停的那些；`reconcileLoops()` 在 hold 期间只记账、解冻时统一收敛（循环预算不抖） |
| `src/ui/viewTransition.js` | VT 的 update 回调里（`mutate` 之后、新快照拍摄之前）调 `holdLoops()`；`finished` / `ready`（含 `skipTransition` / 被下一段顶掉）统一解冻 |
| `ARCHITECTURE.md` | §5.1 补「过渡（阶段 5）」名单 / 三档表 / 降级策略 / `view-transition-name` 收窄规则 / 过渡期循环；模块表补 `viewTransition` / `navigation` / `modalHost` 三行、`motion.ts` 补 `TRANSITIONS` |
| `CONTRIBUTING.md` | 目录地图 `js/motion.js` → `src/core/motion.ts`（路径早已随阶段 2 搬迁，属过期项） |

`css/motion.css`、`css/style.css`、`js/**`、数据层**零改动**；`@keyframes` 一条没加。

## 二、过渡名单与三档表（真源 = `Motion.TRANSITIONS`）

| 动作 | 声明 name | off | standard | rich | 降级（`?vt=0` / 不支持 VT） |
|---|---|---|---|---|---|
| 切屏 | `screen` | 即时（同步换 DOM） | 交叉淡入 160ms | 淡入 + 8px 位移 220ms | 对目标屏整块淡入（≤160ms / rich 220ms） |
| 舞台换画 | `stageArt` | 即时替换 | 淡入 160ms | 共享元素 `stage-art` 220ms | 淡入 |
| 分支切换 | `sibling` | 即时 | 交叉淡入 160ms | 方向性短位移 220ms | 淡入（旧 WAAPI 留作降级） |
| 分支页开合 | `branchPage` | 即时 | 淡入 160ms | 淡入 + 位移 220ms | 对分支页 / 阅读页整块淡入 |
| 弹窗开合 | `modal` | 即时、焦点仍正确 | 遮罩淡入 160ms | 缩放 / 位移 + 背景渐隐 220ms | 开窗淡入；关窗同步隐藏（焦点语义优先） |

降级策略（三层，逐层兜底）：

1. `html[data-motion="off"]` → `runTransition` 同步执行 `mutate`（绝不 `await` 后再改 DOM：焦点 / 滚动位置不跳）；CSS 侧另有 `animation-name: none` 兜底，误开 VT 也不动。
2. `?vt=0` 或浏览器没有 `document.startViewTransition`（含 `file://` 下的老引擎）→ 只对 `scope` 做整块淡入，时长取「声明值」与「该档透明度上限」的较小者；位移不外溢到降级路径。
3. 过渡调用本身抛错（文档不可见 / 上一段还没收干净）→ 退回同一淡入路径；`ready` / `finished` 的拒绝都被接住，不产生 unhandledrejection。

循环上限：`Motion.LOOP_BUDGET = 3` 组（rich；off / standard 为 0）。登记走 `registerLoop`，超出者挂 `data-loop="wait"` 暂停；页面不可见 `html[data-paused]` 全局暂停；分支页打开时 `suspendLoops` 暂停底下阅读页。

## 三、过渡期循环冻结（本步的核心）

- [x] 冻结时机：VT 的 **update 回调里、`mutate` 之后**——旧快照已拍完（不是暂停相位），新快照拍到的是暂停相位；撤快照时 live DOM 从同一相位继续，不跳。
- [x] 冻结范围：只认**循环**（`iterations` 无限或 >1）且 `playState === 'running'` 的真实 DOM 动画；跳过 `::view-transition-*` 伪元素自己的动画（暂停它们等于把过渡停住）。
- [x] 不复活的：本来因 `data-paused`（页面不可见）/ `data-loop="wait"`（预算排队）/ `data-loops-paused`（分支页挂起）/ 自身 `animation-play-state: paused` 停着的循环——`capture` 只收 `running` 的，恢复时也只 `play()` 自己收过的。
- [x] 解冻时机：`finished`（含被 `skipTransition()` 收掉、被下一段顶掉导致的 reject）与 `ready` 的拒绝分支都接住；解冻是**计数式**的，A 被 B 顶掉时 A 只减计数，最后一个解冻才真正 `play()`，不会把 B 刚停下的循环又放开。
- [x] 循环预算：hold 期间 `registerLoop` / 注销 / 子树挂起只记账，`reconcileLoops` 推迟到解冻，避免「过渡中途换屏 → 旧组刚释放、新组刚登记 → 同一帧重排两次」；解冻后统一收敛到 3 组。
- [x] `off` / `?vt=0` / 不支持 VT：没有快照，不冻结、不 hold、不干预循环（`?vt=0` 的淡入降级同样不冻结）。
- [x] 打断：开 → 60ms 关 → 40ms 再开，收尾后 0 个卡在 paused 的循环、`loopsHeld() === false`、0 条残留快照。

## 四、全量验收（都是本步实测）

### 4.1 `npm test`

- [x] 全量离线套件通过（退出码 0）：`motion-test` / `tokens-test`（`TRANSITIONS` 与 `::view-transition-*` 时长对账、`@keyframes` 一条不多一条不少）/ `settings-ids-test`（154 个控件 id）/ `app-structure-test` / `tsc --noEmit` 等全绿。
- [x] 产品代码零 API 变更：`IR.Motion` 的表没动；新加的 `IR.MotionDOM` 只是 DOM 侧函数的兼容桥（验收与 legacy 排障用，阶段 6 随 IR 一起删）。

### 4.2 `npm run build` 两份产物

- [x] `dist/single/index.html`（单文件，file:// 双击）：零外链、JS/CSS/图标全内联。
- [x] `dist/site/`（多文件，GitHub Pages / Docker）：`sw.js` 的 `PRECACHE` 由构建期注入（`./assets/…` 起头的真实文件名，含内容 hash）。

### 4.3 探针三档（`acceptance/tools/motion-probe.mjs`，产物在 `probe/`）

| 档 | 动作 | 动画采样 | 违规 | 循环组 | console error |
|---|---|---|---|---|---|
| off | 4 | 13 | 0 | 0 | 0 |
| standard | 4 | 150 | 0 | 0 | 0 |
| rich | 4 | 288 | 10 | screen 3 / stage 2 / sibling 2 / modal 2（≤3） | 0 |

- [x] 三档各跑一次都能结束、console error 为 0、`probe/manifest.json` 落地；快照伪动画的时长上限：standard 全部 ≤160ms，rich 全部 ≤220ms。
- [x] rich 的 10 条违规**全部是 `leafIn` 420ms**（`.start-card` / `.shelf-wrap` / `.story-card` / `.anchor-card` / `.chat-note` / `.reason-block` / `.thumb` 的通用入场动画），与第 1 步测量结果逐条相同（当时也是 10 条），不是阶段 5 的五个过渡动作，也不在本步改动面内——留作已知项，不为了让探针变绿去改既有手感。

### 4.4 `shoot.mjs` 逐字节（`shots-bytes.json`）

做法：改动前在 HEAD 上构建并跑一遍全量截图（存临时目录，不进仓库）→ 本步改完重新构建再跑一遍 → 用同一份代码再跑第三遍区分「天然抖动」。

- [x] 63 张同名图：**52 张逐字节一致**。
- [x] 11 张不一致的全部落在「同一份代码跑两遍也不一致」的抖动集（`19-seeded-branch` / `20-seeded-painter` / `22-seeded-card` / `23-seeded-story-prefs` / `24-seeded-modal-confirm` / `31-seeded-story-savepoints` 两个宽度）——这些界面带运行时时间（存档点名、相对时间、节点标签），属既有特性。
- [x] **真回归 0 张**、缺图 0、多图 0（`shots-bytes.json` 的 `regressed: []` / `onlyBefore: []` / `onlyAfter: []`）。

### 4.5 `file://` 双击 + PWA 断网（`pwa-offline.mjs`，产物 `pwa-offline.json`）

- [x] `file://` 双击 `dist/single/index.html`：应用启动、四块屏齐全、首页可见、档位落定、切屏可用、零外链、不注册 SW、console error 0（8 条断言）。
- [x] PWA：本地静态服务器指向 `dist/site` → SW 注册并接管 → 预缓存建立 → **断网 reload** 仍能启动、`navigator.onLine === false`、页面仍由 SW 控制、断网下切屏可用、console error 0（9 条断言）。
- [x] 17 条断言全过、console error 0。

### 4.6 循环冻结自检（`loop-freeze-smoke.mjs`，产物 `manifest.json`）

- [x] 8 个场景 75 条断言全绿：
      `off`（不冻结 / 无快照）/ `standard-vt`（冻结 + 复位）/ `rich-vt-screen`（root 快照路径）/
      `rich-vt-modal`（两层命名 + 根 opt-out 路径）/ `rich-fallback`（?vt=0 不冻结）/
      `rich-interrupt`（打断后无卡死）/ `paused-probe`（本来停着的不复活）/ `budget-hold`（hold 期间预算不重排、解冻后收敛）。
- [x] 全部场景 console error 0。

## 五、已知遗留 / 说明

- [ ] iOS Safari 真机手测：本机无设备，与屏 6c / 第 7 步的遗留项一起待办（`acceptance/phase4/screen6/6c/CHECKLIST.md`、`acceptance/phase5/7/CHECKLIST.md`）。
- [ ] 探针 rich 档的 10 条 `leafIn` 违规：既有通用入场动画（420ms），不是阶段 5 过渡动作；本步不为了让探针 strict 变绿改手感。
- 说明：`shoot.mjs` 的时间戳类界面天然抖动（见 4.4），所以「逐字节」的判定口径是「先扣掉同代码重复运行的抖动集，再看有没有真回归」；`bytes-compare.mjs` 把这条写成了可复跑的命令。
- `budget-hold` 场景用 `IR.MotionDOM.registerLoop` 直接登记 5 组测速循环；`IR.MotionDOM` 是本步新增的兼容桥，只在验收 / legacy 排障里用。

## 六、产物

```
acceptance/phase5/8/
  loop-freeze-smoke.mjs   过渡期循环冻结自检（8 场景 75 条断言）
  pwa-offline.mjs         file:// 双击 + PWA 断网（17 条断言）
  bytes-compare.mjs       截图逐字节对比（支持 --repeat 扣掉天然抖动）
  manifest.json           循环冻结自检结果（含逐帧采样，约 90KB）
  pwa-offline.json        产物形态验收结果
  shots-bytes.json        63 张截图的 SHA-256 对比结果（before/after 目录为临时目录，见 4.4）
  CHECKLIST.md            本文件
```

本地产物（不入库，按 4.3 / 4.4 的命令可复跑）：`probe/`（探针三档 `manifest.json` 约 284KB + 51 张中间帧）、
截图前后的临时目录（`%TEMP%/ir-shoot-before` / `ir-shoot-after` / `ir-shoot-after2`）。验收目录里的
PNG 一律按 `.gitignore` 的「手动验收证据」口径留在本地，仓库只收脚本、逐条断言结果与本文。
