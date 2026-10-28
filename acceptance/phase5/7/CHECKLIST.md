# 阶段 5 · 第 7 步 · 弹窗开合 · 验收清单

前置：屏 6a~6c 已落地（`1119047` 外壳、`669a248` 轻弹窗、`39c9453` 重弹窗）。
对象：`src/ui/modalHost.js`（`openModal` / `closeModal` 接过渡内核；屏 6a 已把 `js/app/core.js:256/272`
的语义搬到这里，本步在收口点接线，调用方一行未改）。
方案：**只给两层命名**——`#modal-*` 容器（遮罩 + 卡片）= 弹窗 id，`.modal-card` = `id + '-card'`（仅 rich）；
过渡期间根节点挂 `view-transition-name: none` 让它**不参与快照**（任务书「坑」：根快照会曝光固定层与
弹窗内部滚动）；`css/motion.css` 本步 0 行改动。

## 三档行为（`acceptance/phase5/7/modal-smoke.mjs`，8 个场景 111 条断言全绿）

| 档 | 开 | 关 | 实测 |
|---|---|---|---|
| `off` | 同步改 DOM（调用返回时已可见 / 已隐藏），不挂名字、不开快照 | 同左 | 0 条 `::view-transition-*`、0 个 `view-transition-name` |
| `standard` | 遮罩层整体交叉淡入，只有 opacity、≤160ms；**卡片不命名**（不许位移） | `::view-transition-old(modal-confirm)` 淡出，≤160ms | 名字只有 `(modal-confirm)`，无 `-card`、无位移 |
| `rich` | 同上 + `::view-transition-new(modal-confirm-card)` `translateY(6px) scale(.96) → none` @220ms | `::view-transition-old(modal-confirm-card)` `none → translateY(-4px) scale(.98)` | 开 13 条 / 关 5 条快照动画，全部 ≤220ms、不循环 |
| 降级 `?vt=0` | `#modal-confirm` 整块淡入（≤220ms） | **即时**（同步隐藏，见下「为什么降级关窗不做淡出」） | 0 条快照 |

- [x] 所有 VT 场景：快照里**没有 `(root)`**，且过渡期间 `html.style.view-transition-name === 'none'`
      （根 opt-out 是临时的、计数式释放：切屏 / 分支页仍要用 root 快照做位移）
- [x] 收尾后 0 条残留快照、0 个残留 `view-transition-name`（含卡片名）
- [x] 每个场景 console error / pageerror 为 0（sidecar `/health` 探测按既有口径豁免）

## 时序与坑（都已按实测落定）

- [x] **开窗那一侧不把 DOM 变更推到下一帧**：第 7 步第一版把「取消 `.hidden`」放进 update 回调，
      结果 `irConfirm` 的 `#cf-input`、文本导入的 `#it-text`、「定时主动」入口的 `scrollIntoView`
      全部落空（实测 `activeElement` 停在触发按钮上）。改为**同步显示 + 旧态用 `opacity:0` 挡住**：
      旧快照是一张全透明图（淡出等于什么都不发生），新快照照常淡入，`focus` / 布局 / `scrollIntoView`
      与 0.12.1 同一时序
- [x] 自检里钉住三条：开窗返回时已可见、11 个弹窗逐个「开窗当帧卡片高度 > 0」、输入框拿到焦点并全选
- [x] **关窗侧仍是 update 回调里换 DOM**：退场动画要求旧态可见、新态消失，只能推迟一帧；
      栈（`modalStack`）在调用当下就撤（Esc / 遮罩点击 / 焦点判定读同一个数组实例），焦点还原跟着隐藏走
- [x] **卡片入场动画让位**：`.modal-card` 自己带 `--an-leafIn`（`opacity:0 + translateY(10px)` 起跑），
      不处理就会被拍进新快照第一帧 → 遮罩淡入时卡片是半透明的。过渡期挂 `animation-name:none`，
      关窗那一刻撤掉（元素正被隐藏，重挂动画看不见），`off` / 降级照旧跑原来那条动画
- [x] **inline `opacity` 的三处兜底**：`paint()` 在 update 回调里清、`finished`（含被 skip 的 reject）
      再清一次、`hideNow()` 隐藏时也清 —— 否则打断序列（开 → 关 → 再开）会把 `opacity:0` 留给下一次开门
- [x] **打断**：开 → 60ms 关 → 40ms 再开，收尾后 0 条残留快照 / 0 个残留名字 / 无 `opacity` 残留，最终停在「开」
- [x] **连点 / 已开着**：`openModal` 对「栈里有它且没隐藏」只提到最上层，不重跑过渡（不出第二对快照）
- [x] **互斥关窗不排队**：`openModal` 内部关功能类弹窗时 `openDepth>0` → 走同步关窗，不排一串过渡
- [x] **为什么降级关窗不做淡出**：隐藏必须同步（焦点还原、栈、20 多处调用点「关完立刻判可见性」），
      淡出要求把隐藏延后一二百毫秒；按任务书「off 档不许 await 后再改 DOM」的同一条理由选同步，
      只在真有 View Transition 时才演出退场

## 嵌套与语义保留

- [x] 叠两层（设置 → 确认）：栈 = `['modal-settings','modal-confirm']`，z-index 31 / 32，
      确认层入场只拍它自己的两层名字，不带设置层
- [x] Esc / `closeTopModal` 只关最上层；关完按栈序重排（设置回到 31）
- [x] `irConfirm` → `closeConfirm`：Promise 仍收掉、resolve 值正确、焦点回到触发按钮
- [x] 11 个弹窗逐个开 / 关：可见 → 隐藏、`aria-hidden` 成对、栈起落、z-index 31、0 残留
- [x] 11 个容器与 `.modal-card` 都在（重写过的 10 个由 Svelte 产 `.modal-card`，与设置弹窗同一口径）

## 测试门禁

- [x] 全量 `npm test` 绿（退出码 0）：`eval/motion-test.js` 的 `TRANSITIONS.modal` 早在第 2 步按矩阵声明
      （off instant/0、standard fade/160、rich shift/220），`eval/tokens-test.js` 的 `--m-dur-vt-*` 对账照过，
      **两份 eval 零改动**
- [x] `eval/settings-ids-test.js` 154 个控件 id 全过（`npm test` 内）；重弹窗内容未动
- [x] `npm run build` 两份产物通过（`dist/single` 单文件 + `dist/site` 多文件）
- [x] 回跑前几步自检全绿：第 4 步 `stage-smoke` 全部通过、第 5 步 `sibling-smoke` 全部通过、
      第 6 步 `branch-smoke` 4 场景 51 条断言全绿（root 快照 + 位移未被本步的根 opt-out 影响）
- [x] `?ui=legacy` 实测（`legacy-ui` 场景）：弹窗仍是旧 DOM、开合走同一套名字与快照，console 0
- [ ] iOS Safari 真机手测（本机无设备；同屏 6c 的遗留项一起待办）

## 产物

```
acceptance/phase5/7/
  modal-smoke.mjs         自检脚本：off / standard / rich / 降级 + 嵌套 + 打断 + legacy-ui + 11 弹窗全量
  manifest.json           每场景的档位、采样动画（含卡片位移关键帧）、逐条断言
  open-rich-vt-mid.png    rich 开启中间帧（遮罩已起、卡片正在收进来）
  close-rich-vt-mid.png   rich 关闭中间帧
  open-rich-vt-390-mid.png  390 宽下的开启中间帧（卡片不溢出视口）
```

## 兼容 / 安全

- [x] 单文件产物 `file://` 双击形态实测（自检脚本即 `file://`）；除既有 sidecar `/health` 外无外联
- [x] `{@html}` / `innerHTML` 零使用（本步只碰 `classList` / `style` / 栈）
- [x] 数据零改动：IndexedDB 结构、`.irstory.json`、`.irbackup.json`、zip 备份一个字段没动
- [x] 焦点还原、滚动锁、遮罩点击语义原样：`rememberFocus` / `restoreFocus` / `modal-top` 未改
