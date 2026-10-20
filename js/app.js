/*
 * 无限阅读 · 主逻辑（v0.4）
 *
 * 结构：
 *  书架（应用入口，§7/T-P2-1）→ 新故事（选模式 → 剧情走向导 / 对话直接开聊 / 扮演暂自由扮演）
 *  → 阅读页（聊天记录 : 画面 双栏，§4.6）→ AI1 回合（上下文走 IR.Context，与评测同源）
 *  → 画师子代理 + 生图（§3.2/§4.7）→ 书记员 / 压缩（§4.1/§4.10）→ 存档点 / 导出导入（§4.11）
 * 存档：统一走 IR.Store（schema v2）；图片只存缩略图以控制体积。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, Store, Cap, DEMO, STYLE_PRESETS, MODE_LABELS, KIND_LABELS, DEFAULT_TOPIC, DEFAULT_SETUP, CHAT_PREMISE, rpPremise, SCRIBE_SYSTEM, SCRIBE_COMPRESS_SYSTEM, SCRIBE_ROLLING_SYSTEM, DRAFT_SYSTEM, IMAGE_ASPECTS, requestChatStop, isStopError, setSendButtonsBusy, motionMQ, motionLevel, applyMotion, applyPaused, motionMs, toast, hideToast, irConfirm, closeConfirm, confirmValue, MODAL_IDS, modalStack, openModal, closeModal, dismissModal, closeTopModal, netErrHint, offlineBlocked, sleep, clone, fmtTime, fmtMB, persistSettings, saveAll, resolveSub, imageCfg, miniBtn } = A;

  /* 离线演示模式（?demo=1，见 js/demo.js）：内置剧本 + 本地占位图，不联网、不需要 Key。
     只覆盖内存里的 settings，绝不写回 localStorage —— 真实配置不会被演示污染。 */

  /* ================= 默认值与提示词 ================= */

  // 做 / 说 / 导演：玩家回合的三种输入语义（旧存档缺 kind 时按「做」处理）

  // 开始页「故事设定」框的默认文字（v0.1 原样保留）
  // R13 rp：premise 与角色卡绑定（卡常驻系统提示词；开场白由卡写、直接进日志，§4.12）

  // 画师子代理（原 AI2）：把剧情写成绘画提示词。P3 会搬进画师工作台。

  // 书记员 C-B 双职（§4.10 C-B）：一次调用同时「压缩旧回合 → 场景摘要」+「重写世界状态卡」

  // 滚动风格摘要（§4.10 C-F）：书记员顺手更新（真实模式）

  /* ================= 状态 ================= */

  /* ---------- P0-1（2026-10-14 评审）：请求中断 ----------
   * providers.chat 经 hooks.onAborter 回填当前请求的 AbortController；
   * 发送按钮在 busy 期间变成「停止」，点了就 abort 当前请求并跳过所有自动重试。 */

  // 用户主动停止导致的请求失败：跳过「流式失败转非流式」「tools 400 降级」等自动重试
  // busy 期间发送按钮变身「停止」：按钮保持可点，点击即中断当前回合
  // 顶栏忙碌进度线 #busy-line 跟着同一状态显隐（UI-1 §4.3）

  /* ================= 动效基座（UI-1） ================= */

  // 当前动效强度：settings.ui.motion + 系统「减少动态效果」→ IR.Motion.resolve

  // 页面不可见 → html[data-paused]（CSS 暂停一切循环动画）

  // 动效令牌里的时长（毫秒）：JS 侧的 WAAPI 与 CSS 共用同一个真源

  /* ================= 小工具 ================= */

  // 同一时刻只保留一条提示（后来者替换前者）：文本写进 #toast-text，
  // 错误提示额外给一个关闭按钮，其余情况不吃鼠标事件（pointer-events: none）。

  /* 自建 confirm / prompt（内嵌预览是沙箱 iframe，原生弹窗被静默忽略 →
     直接返回 false / null，表现为「点了没反应」，故不使用原生 confirm / prompt）。
     irConfirm(msg, { title, okText, input, value, placeholder }) → Promise
       无输入：确定 resolve(true)，取消 / 关闭 resolve(null)
       有输入：确定 resolve(字符串)，取消 / 关闭 resolve(null) */

  /* ---------- 弹窗栈（P0-3） ----------
   * 十余个弹窗各自独立，演示图里「写邮件」和「代为下单」会叠在一起。
   * 这里做一个最小的统一入口：
   *   - openModal(id) / closeModal(id) 维护一个栈，后开的总在上面（z-index 由栈序决定）；
   *   - 功能类弹窗（邮件 / 支付 / 设置里的定时主动）互斥：开一个先关掉其它功能类；
   *   - 确认弹窗（#modal-confirm）不参与互斥，可以叠在任意弹窗上；
   *   - Esc 只关最上层（confirm 要走 closeConfirm，才能把 Promise 收掉）。
   * 现有 id 与 DOM 全部保持不变。 */

  // Esc / 点遮罩：按弹窗自己的关闭函数收尾（有的要清状态、有的要 resolve Promise）

  /* 断网守卫：离线时【不发请求、也不排队】，直接告诉用户「这次点了不算」。
   * 不排队是刻意的：出图时机有「每轮 / 选择后」的自动触发，若排队等联网后补发，
   * 用户会在毫不知情的情况下被扣一笔额度。 */

  // 体积显示：1 MB 以下按 KB 显示 —— 否则「68 KB 的备份」会显示成 0.0 MB，看着像没内容

  // 设置落盘的唯一出口：演示模式只改内存，不写盘

  // 子模型（画师/书记员/起草）配置：留空即沿用剧情模型

  // 生图配置：预填档位优先；'__custom__' 或未登记时按比例 + 宽高算 size（R8）
  // override 供画师工作台传入本图的出图参数（比例 / 宽高）

  /* ---------------- 模型能力（T-M-1 / §4.13） ---------------- */

  // 有效上下文窗口：用户手填优先，其次登记表；0 = 未知（压缩退回条数兜底）

  // 手填尺寸时显示宽/高输入（预填档位模式下由档位决定，隐藏）

  // 设置面板：按模型能力显隐参数（思考档位 / 尺寸 / 质量 / 上下文窗口提示）

  // 背景图只作用于右栏舞台：底层是当前图的模糊放大副本（CSS 负责模糊 / 压暗）。
  // 全页背景图已取消——阅读面必须是纯 --bg，图不能透到文字后面。

  /* ---------------- 原图（Blob）：存 IndexedDB，取显示地址 ---------------- */

  // 把生成的图转成 Blob：先试 fetch（dataURL / 同源 / 允许 CORS 的 URL 都能成），
  // 被 CORS 挡住时退回「画进 canvas 再导出」。都失败就返回 null（只留缩略图）。

  // 存原图；返回 imageId（没有 IndexedDB / 存不下时返回 undefined，退回只留缩略图）

  // 一张图该显示什么：优先原图（IndexedDB 里的 Blob → objectURL），没有就退回缩略图

  // 打字机（流式失败 / 非流式时的兜底观感）；返回 Promise

  /* ================= 存档点（T-P2-1 / §7） ================= */

  /* ================= 书架（T-P2-1 / §7） ================= */

  // 开始页（应用入口）：三个模式先看介绍、点一张选中，再按「开始」

  // 阅读页「＋ 新故事」：先把当前这一幕落盘，再开「新故事」选模式弹窗（三个模式共用同一入口）

  // 开始页三模式（§4.8）：三张卡即三个开局入口，点哪张就按哪种模式开局（没有单独的开始按钮）
  //   剧情 = 设定框快通道；对话 = 直接开聊；扮演 = 先建角色卡

  // 剧情模式：用设定框里的文字直接开一局（v0.1 的快通道）

  /* 离线演示（?demo=1）：内置剧本 + 本地占位图，直接开局。
     不联网、不需要 Key、配置不写盘；画风锚定 / 画师工作台 / 出图 / 存档等链路与真实模式完全一致。 */

  // 「↶ 继续上次」

  /* ================= 导入 / 导出（T-P2-4 / §4.11） ================= */

  /* ================= 本地存储与备份（P0 数据安全） =================
   * 全部数据只在浏览器 localStorage（每站点约 5MB），没有任何服务端。这里做三件事：
   *  1) 申请持久化存储 navigator.storage.persist()：磁盘压力下的 LRU 淘汰会跳过本站
   *     （Safari 的 7 天无交互清除仍会生效，只能靠交互 / 加到主屏缓解）
   *  2) 算清本应用占用量，到 70% 提前预警（原来的提示只在写入失败之后才出现，已经晚了）
   *  3) 「一键导出全部备份」(.irbackup.json，可整体还原) + 超过 7 天没备份就提醒一次
   */

  // 只统计本应用的键（ir: 前缀）：localStorage 上限是所有键共享的，这里的占用才是我们能控的

  // 真实占用：navigator.storage.estimate()（把 IndexedDB / Cache 等一起算在内，比数键位准得多）

  // 导出包：默认剥掉 API Key（备份文件常被放进网盘，带 Key 等于把钱包一起备份）

  /* 「带原图备份」= 一个 zip 里放两样东西：
   *   ir-backup.json      与普通备份完全同款（schema 2 只多一份 images 清单）
   *   images/0001.png …   原图按二进制原样存放
   * 为什么不把原图 base64 塞进 JSON：大图转 base64 体积涨约 1/3，还会在内存里堆成巨型字符串；
   * zip 装的是原始字节，体积最省，导出 / 导入都不容易把内存打爆。代价是 .zip 不能直接肉眼查看。 */

  // 超过 7 天没备份（且确实有故事）→ 启动后提醒一次；提醒本身每天最多一次，不刷屏

  // 从一个 zip 里找备份正文：优先根目录，也接受「被塞进一层文件夹」的情况

  // 带原图的全量备份（.zip）：解出 ir-backup.json 走同一套还原流程，原图另走 images/*

  /* ================= 剧情文本导入（R12 路径② / §4.11 / T-P6-1） =================
   * 粘贴任意剧情文本 → 整理向导（用「起草模型」；只有装不下才 map-reduce）→
   * premise + world 草稿 + 画风关键词 → 用户确认修改（不可跳过）→ 建新档 → 试画锚定 → 开场。
   * 调用失败退回本地规则。 */

  // 整理模型：弹窗里可选（默认跟随剧情模型；也能用单独配置的起草模型）

  // 「这次用谁整理」的一行字（显示在提示与确认页上；避免只写模型名让人误以为是硬编码的）

  // 整理模型的有效窗口：跟随剧情模型 → 用剧情模型的；起草模型 → 单独配了才查登记表

  // 粘贴框下方的一行提示：整理模型 + 窗口 + 这次会一次调用还是 map-reduce（返回 plan 供调用方复用）

  // 本地兜底整理：只截取原文开头并结构化（调用失败时用；标「本地规则」，等用户改）

  // 分段摘要合并（§4.11：分段各出摘要，再一次合并成开局材料）

  /* ================= 角色卡（R13 / §4.12 / T-P7-1） =================
   * 统一编辑器：自建 = 空白表单；导入 = SillyTavern V2/V3 PNG（只兼容格式，不复制内容）；改完即生效。
   * rp 开局 = 选（建 / 导入）一张角色卡；开场白作为首条旁白；示例对话喂给模型学口吻。 */

  // 卡 → 世界卡人物条目（personality / speech 对接，§4.12）；用户手改过的字段按 mergeWorld 规则保护

  // 开场白 = rp 首条旁白（不花一次 AI 调用；§4.12）

  /* ---------------- 用户画像（R13 / §4.12 / T-P7-2） ----------------
   * 开关默认全关、可按模式单独开或全开；范围 global（ir:user-profile）/ per-story 用户自选。
   * 收集：真实模式由书记员校对时顺手提取；失败退回本地确定性规则（只认「我…」句式）。
   * 注入：每轮只带与当前话题相关的 Top-N + 常驻一行摘要（assembleAI1 的 opts.profile，见 callAI1）。 */

  // 当前生效的画像条目（按 scope 取全局或本档）；关开关 / 没故事 → 空

  // 写入画像：关开关即停止收集；合并去重（同文只留最新），不设条数上限（§4.12 存储无上限）

  // 失败兜底：只看玩家最后说的一句（确定性规则）

  // 书记员输入里的画像指示：开没开都说清楚，省得模型乱输出

  /* ================= 开局向导（T-P2-3 / §4.8） ================= */

  /* ================= AI1：剧情回合 ================= */

  // 书记员是否可用于「模型任务」（压缩摘要 / 滚动风格摘要）：
  // 开关开启 + 书记员已启用 + 配了模型与适配器

  // 书记员（C-B）：每 N 回合校对世界卡（压缩触发时由 runSmartCompress 顺带完成）；失败时用本地规则兜底

  /* ---------------- 书记员模型任务（压缩 / 滚动风格摘要） ----------------
   * 真实模式：书记员一次调用同时「压缩 + 校对」（§4.10 C-B）、出图后顺手更新滚动风格摘要（C-F）；
   * 开关关闭、调用失败 → 一律退回本地确定性规则。 */

  // 待压缩原回合 → 书记员输入（按幕分组，越靠前越旧）

  // 模型压缩（C-B 双职）：返回 null 表示「未触发 / 不可用 / 失败」→ 调用方走本地兜底

  // 出图后：真实模式让书记员顺手更新滚动风格摘要（§4.10 C-F）；失败保留本地规则结果，不打断流程

  // 每回合收尾：压缩链（C-A/C-C）+ 书记员（C-B）

  // 思考链入库前截断（长链只留前 4000 字，控住 localStorage 体积；渲染照常可折叠）

  // 旁白条目（versions = 版本栈）；思考链随条目一起存，供折叠块渲染与以后带 tools 回传

  // AI1 原始对话里的 assistant 条目：reasoning 一并存档（不进请求体，§4.5）

  // 流式清洗：从累积的 JSON 文本里抠出旁白可读部分

  /* ---------- 流式文字逐段淡入（UI-1 §4.2） ----------
   * 只对「可见文字的增量」动（cleanStream 之后），不给原始 JSON 碎片做动画：
   * 新增文字包进 span.delta（createElement + textContent）套 fadeIn；
   * 存活 span 超过 DELTA_MAX_SPANS 时把更早的合并进一个前缀文本节点；
   * 流结束（finishNarration）整体合并成单个文本节点。
   * standard 档只对整个气泡做一次淡入（见 style.css 的 .bubble-live）；off 档无。 */

  // 超额的 span 合并进前缀文本节点：DOM 里始终最多约 DELTA_MAX_SPANS 个 span

  // 流结束：整体合并成单个文本节点

  // 流式思考链（方案 B）：写进固定小窗，并始终滚到最新——点开看全量也不暂停

  /* ---------- P5-1 工具护栏：显式 400 拒绝 tools 的模型记住后不再下发（§4.5） ---------- */

  // 「模型不接受 tools」判定：必须排除参数用法类 400（如 DeepSeek 思考模式不支持 tool_choice）
  // 归一化成 [{ name, args }]（流式 tool_calls 与回包内嵌的同名字段都算）

  // 单次请求（流式写进 live 气泡）：带 tools 被显式 400 拒绝 → 记住该 baseUrl+model 并降级重发一次

  // 本回合是否已由工具出图（用于「工具已出图则跳过本轮时机出图」去重，§4.7）。
  // v0.5.1 起在**提交任务时**置位（原来是出图完成后），消费点（maybeEnqueueImage、开局路径）不变。

  // 回合锚点（§3.A.4）：request_image 在 commit 之前提交、节点还没创建——任务提交时带上它；
  // 回合 commit 成功后补 nodeId，失败 / 主动停止置 dead；任务开跑前与写回前各核一次。

  /* ================= 可选本地服务（sidecar）：调度工具与主动消息 ================= */

  // 调度工具只在「对话 / 扮演」+ 本地服务在线 + 后端已开启调度时才下发

  // 邮件 / 下单工具同样只在「本地服务在线 + 对应 feature 开启 + 有 token」时下发；
  // 另外 toolsForMode 只在 chat（智能体）模式放行（红线 7）。

  // 接受 ISO 8601 字符串或时间戳（秒 / 毫秒）；解析不出来返回 0

  // 执行调度工具：一律提交给侧车，且一律是「待确认」——模型可以安排，但不能让主动行为自己生效

  /* ---- 侧车连接状态与主动消息投递 ---- */

  // 邮件 / 定时主动 / 代下单只在「对话 / 扮演」模式可用：剧情模式里既不能出现，
  // 也不能被触发（入口函数自己也再挡一次，不依赖界面是否渲染）。

  // 局内功能入口：只有「对话 / 扮演」模式才有「＋」菜单；本地服务没启动时菜单项灰显

  /* ---------- 下拉菜单（顶栏「⋯」/ 输入区「＋」） ---------- */

  // 页面打开 / 重新上线时补跑：把侧车里排队的触达捞回来（页面关着时侧车只入队，不打扰）

  /* ---- 设置分区：安全项读写（真源在侧车 config.json，这里只是编辑界面） ---- */

  /* ---- 主动联系安排 ---- */

  /* ---- 邮件 ---- */

  /* ---- 购物支付 ---- */

  // 执行一轮里的工具调用：留痕 + 副作用（写记忆 / 出图排队）；返回给重发用的回传块

  // email_propose / payment_propose → 建提案（红线 1/2/3）：
  // 提案路径只走 IR.Proposals.create（不碰任何 send / purchase / approve），失败给模型可读原因让它圆场，
  // 成功 pushLog({type:'proposal'})（回合内、commit 之前，由 logMark 切片收进节点），并回一条「待确认」提示。

  // 调 AI1；带工具时：工具调用 → 留痕 + 副作用 + 单次重发（§4.5）

  // 输入类型（做 / 说 / 导演）：状态按故事记在 story.ui.kind，旧存档缺省 = 做
  // 外层前缀 [玩家行动] 保持不变（demo.js 靠它分派），类型标记作为内层前缀。
  // v0.6.0：chat（智能体）不做 / 说 / 导演——内层标记直接不加（组装历史时另有 stripKindMarker 兼容旧档）。

  // meta.kind === 'agent'：这条是「模型主动找你」（来自调度触发），不是玩家输入

  // 旁白已进 log：流式就直接落定；非流式用打字机补观感

  // 开局第一幕：让 AI1 主动给出开场旁白与选项（不记录为玩家行动）
  // P2-11（2026-10-14）：实际请求与存档此前是两句不同的话，retryLast 会以存档版重发、与首发不一致——统一成常量

  /* ================= 重试与分支（R1 / §4.2、§4.3） ================= */

  // 选项只随 assistantMsg 存档（slimReply 的 JSON）：切分支 / 载入后从 head 的 assistantMsg 恢复（§4.3）
  // 这个 log 条目属于哪个节点（§4.4 锚点）：node.entries 与 story.log 是同一批对象（project 按引用共享）
  // 图所属的节点：条目可能已滑出可见 log 窗口（末 120 条），按 node.scenes 里的 scene id 再找一遍

  /* ================= 重试 = 新增兄弟（§4.2） / 兄弟切换（§4.3） ================= */

  // §4.3 兄弟切换：切到相邻兄弟，沿 active 下探到叶子（续写过的支线会回到它的末端）；不发任何请求

  /* 切兄弟滑动（UI-1 §4.1）：聊天内容区按方向横向滑入（±24px + 透明度，--dur-base）。
   * 顺序必须是「数据切换 + 重新渲染 → 再播入场」，不能闪出旧内容；
   * 动画未结束时再次切换要能正确打断（cancel 上一段，最终态由最新一次渲染决定）；
   * off 档（含系统减少动态）直接切换。WAAPI 只动 transform / opacity。 */

  /* ================= 画师子代理 + 生图（§3.2/§4.3，T-P3-1） =================
   * v0.5.1（§3.B）：时机出图 / 工具出图 / 手动 / 工作台重画全走同一条串行队列 IR.PaintQueue，
   * 画师构思也在队列里跑（不与队列外的构思并发）；request_image 已异步化、不卡回合（§3.A）。 */

  // —— 作画胶囊 #gen-status（§3.B）：显示「构思中 / 作画中」并带上队列长度；队列清空才隐藏 ——

  // request_image 的一句话画面说明（feedback 用）：alt 优先，退回 subject / prompt

  // 后台作画失败要可见（§3.A.5）：toast + 往它所属的节点留一条 tool 留痕

  // 留痕落位与 runPaint 同口径（§4.4）：节点没了丢弃；已 sealed 走 pushLate；否则写 story.log（由 commit 切片收进节点）

  // 统一提交：失败在这里变可见（toast + 留痕），调用方拿场景或 null，不再抛异常

  // request_image 入队（§3.A）：立刻返回、不等图；任务带回合锚点，完成后落回「它所属的回合」

  // 作画任务体（§3.B）：合并原 runToolPaint / generateScene 的重复流程——
  //   构思（directPrompt 缺省时走画师；画师不可用 / 失败用场景描述兜底）→ 组 prompt → runPaint 出图写回
  // opts: { storyId, nodeId, anchor, directPrompt, promptRaw, sceneRef, altHint, supersedesEntry, supersedesScene, params }

  // 时机出图（§4.7）：节点在任务创建时记下（§4.4），同一条队列串行

  // 提示词已就绪的出图（工作台「按此重画」/「按设定卡强制重画」）：跳过构思直接出图

  // 画风兜底后缀（未锚定视觉设定卡时用 settings 画风预设）

  // P4：出图携带的画风后缀——已锚定用视觉设定卡关键词（卡优先），未锚定回退画风预设

  // 滚动风格摘要（§4.10 C-F）：每次出图后自动更新——风格倾向 / 常见场景 / 服饰元素

  // 画师子代理：隔离上下文、用完即弃（§3.2）；命中 recall_recent_plot 时带记录重发一次

  // 出一张图：调生图适配器 → 落 scene / log（可标记被替代的旧图，§2 supersededBy）

  // （generateScene 已并入 runPaintTask：构思 → 组 prompt → 出图三处共用一个任务体，§3.B）

  /* ================= 画师工作台（§4.3，T-P3-1） ================= */

  // 出图参数与「模型设置 · 生图模型」共用同一份 settings.image

  // 工作台「按此重画」：同 prompt 重画，旧图保留并标 supersededBy（R1/§4.2）

  // 视觉设定卡的「强制」后缀：画风 + 媒介 + 色板 +（画面里出现的人物 → 英文外貌 / 服饰 / 特征）

  // 「按设定卡强制重画」（§4.4 手动层 · 图片侧）：不重走画师自由发挥，直接把卡压进这张图

  /* ================= 画风锚定（R3 / §5，T-P4-1） =================
   * 开局试画 4 张候选（按用户比例）→（可「再试一批」）→ 选定一张
   * → 画师起草视觉设定卡（可改字段 / 跟画师说着改）→ 锁定并记版本；
   * 跳过 = 无卡自由发挥（靠滚动风格摘要）；「锚定画风」按钮随时重走。 */

  // 关闭 = 结束锚定（锁定 / 跳过 / ✕ / Esc 都走这里）；开局场景下继续开场

  // 试画一张候选：按用户设置的比例出图；不落档、不进剧情记录

  // 锚定调用：同样走画师子代理（隔离上下文、用完即弃）

  /* ================= 渲染：聊天记录窗口（§4.6） ================= */

  // 思考链块（R9 / §4.5）：回答上的可折叠块；点击标题展开/收起，高度带过渡

  // 流式思考窗（方案 B）：固定上限高度的滚动小窗，思考在窗里滚动跟随；
  // 正文一开始流式就卷成一行；用户点开看全量后仍继续跟随（不暂停）。

  // 图片 src 只放行 data: / blob: / https:（chat / rp 内联图与灯箱用；javascript: 等一律拒绝）

  // 大图优先取原图（imageURL，IndexedDB），没有就用缩略图

  /* ---- 灯箱（chat / rp 的最小看图方案：固定遮罩 + 大图，点遮罩 / Esc 关闭） ---- */

  // chat / rp 的内联图气泡（v0.6.0：舞台没了，图直接排在聊天流里）；剧情模式仍走缩略图 + 舞台

  /* ---- 提案卡（✉ 邮件提案 / 🛒 下单提案）：参数原值用 textContent 渲染（红线 4），未确认不可执行 ---- */

  // 确认 = 一次用户点击 → 最多一次执行（Proposals.confirm 同步抢占状态，连点不会二次执行）

  // 拒绝：不执行任何发送 / 扣款；已有 intent / 草稿时由 Proposals.deny 负责清理

  /* ================= 渲染：画面面板 ================= */

  // 舞台当前图（UI-1 §4.4）：换画交叉淡入、缩略图 → 原图 blur-up、rich 档 Ken Burns

  // Ken Burns 离屏暂停（data-paused 由 CSS 统一管）：图片不可见时停掉循环

  /* ================= 渲染：布局状态（P2 的统一入口） =================
   * 所有排版只由 #screen-game 的 data-layout 决定：
   *   auto → 宽度 ≥ 900px 用 split，否则 stack；immersive 只能由用户进入。
   * 比例 / 收起 / 选项显示都存在 settings.ui（全局），story.ui 只记输入类型。 */

  // 设置里的布局项：chat / rp 下给一行灰字说明（布局选项本身不动，切回剧情模式照常生效）

  // 画面（收起 / 展开舞台）：沉浸态下等同于退出沉浸

  // Esc / ✕ 退出沉浸态：回到「自动」布局

  /* ================= 进入 / 离开故事 ================= */

  /* ================= 设置界面 ================= */

  /* ---- 「测试连接」：只读当前输入框的值 ----
   * 三个原则：① 不保存设置、② 不生成内容、③ 生图绝不出图（不花钱）。
   * 子模型（画师 / 书记员 / 起草）留空的项按「沿用剧情模型」代入，测的就是实际会用到的那套配置。 */

  // 不内置任何服务商预设：Base URL / 模型名 / 参数全部由用户手填，
  // 避免厂商与模型名每天变动、项目疲于维护（通用 OpenAI 兼容适配器已覆盖所有接口）。

  /* ================= 故事记忆面板（世界卡 / 摘要栈 / 留痕 / 模式） ================= */

  // P4「画风」区域：视觉设定卡状态 + 滚动风格摘要 + 重走锚定入口

  // 角色卡状态（R13）：rp 常驻；切出 rp 时卡保留在存档里只是停用（§4.8）

  /* ---------- 🧠 注入记忆（§4.4 手动层；第十六轮定案：不用 tool_choice） ---------- */

  // 按钮在「模型设置 · 故事记忆」里：点一下排定下一回合强制注入完整世界卡 + 设定 + 视觉设定卡

  /* ---------- 用户画像面板（R13 / §4.12：面板在模型设置里，每条可删、可清空） ---------- */

  /* ================= 事件绑定 ================= */

  function bind() {
    // —— 书架 ——
    $('#btn-new-story').onclick = () => openModal('modal-new');
    $('#btn-close-new').onclick = () => closeModal('modal-new');
    document.querySelectorAll('#modal-new .mode-card').forEach(b => {
      b.onclick = () => {
        const mode = b.dataset.mode;
        closeModal('modal-new');
        if (mode === 'choice') A.openWizard(null);
        else A.createStoryImmediate(mode);
      };
    });
    $('#btn-shelf-settings').onclick = A.openSettings;
    $('#btn-shelf-home').onclick = A.showStart;
    $('#btn-import').onclick = () => $('#file-import').click();
    $('#file-import').onchange = e => { handleImportFile(e.target.files && e.target.files[0]); e.target.value = ''; };

    // —— 剧情文本导入（R12 路径②，§4.11 / T-P6-1） ——
    $('#btn-import-text').onclick = A.openImportText;
    $('#btn-start-import').onclick = A.openImportText;
    $('#btn-close-import-text').onclick = A.closeImportText;
    $('#btn-it-cancel').onclick = A.closeImportText;
    $('#btn-it-run').onclick = A.runImportText;
    $('#it-text').addEventListener('input', A.importPlanHint);
    $('#it-model-mode').addEventListener('change', e => {
      S.importModelMode = e.target.value === 'draft' ? 'draft' : 'follow';
      A.importPlanHint();
    });
    $('#btn-it-back').onclick = () => {
      if (S.importJob && S.importJob.busy) return;
      $('#it-step-confirm').classList.add('hidden');
      $('#it-step-run').classList.add('hidden');
      $('#it-step-paste').classList.remove('hidden');
      A.importPlanHint();
    };
    $('#btn-it-start').onclick = A.startFromImport;

    // —— 开始页：三张模式卡即三个开局入口，点哪张就按哪种模式开局（无「开始」按钮）——
    document.querySelectorAll('#start-modes .mode-card').forEach(b => {
      b.onclick = () => A.startFromStart(b.dataset.mode);
    });
    $('#btn-start-shelf').onclick = A.showShelf;
    $('#btn-open-settings').onclick = A.openSettings;
    $('#btn-continue').onclick = A.continueLast;
    // 「🎬 离线演示」：带上 ?demo=1 重开一次（演示模式靠查询参数判定，刷新即回到普通模式）
    $('#btn-start-demo').onclick = () => { location.href = '?demo=1'; };

    // 拖进窗口即可导入（书架与开始页都支持）
    [$('#screen-shelf'), $('#screen-start')].forEach(scr => {
      scr.addEventListener('dragover', e => { e.preventDefault(); scr.classList.add('dragover'); });
      scr.addEventListener('dragleave', () => scr.classList.remove('dragover'));
      scr.addEventListener('drop', e => {
        e.preventDefault();
        scr.classList.remove('dragover');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        A.handleImportFile(f);
      });
    });

    // —— 阅读页 HUD ——
    // 左上「←」退出故事回首页；书架、标题与模式留在顶栏，其余收进「⋯」。
    $('#btn-back-home').onclick = A.showStart;
    $('#btn-hud-shelf').onclick = A.showShelf;
    $('#btn-hud-new').onclick = () => { closeMenus(); A.newStoryFromGame(); };
    $('#btn-settings').onclick = () => { closeMenus(); A.openSettings(); };
    $('#btn-savepoint').onclick = async () => {
      closeMenus();
      if (!S.story) return;
      const name = await irConfirm('给这个存档点起个名字', {
        title: '存档点', input: true, okText: '保存',
        value: '第 ' + (S.story.turn || 0) + ' 回合 · ' + new Date().toLocaleTimeString('zh-CN'),
      });
      if (name == null) return;
      A.addSavepoint(String(name).trim() || undefined);
      toast('已打存档点');
    };
    const manualGenerate = () => {
      closeMenus();
      if (!S.story) { toast('先打开一个故事吧'); return; }
      if (S.busy) { toast('回复生成中，这一幕写完再作画'); return; }   // §3.C：回复生成中不入队
      if (offlineBlocked('这次作画')) return;   // 离线：不排进队列，也不花额度
      const key = 'manual:' + A.treeHeadNodeId();   // §3.C：同一幕不重复入队
      if (A.paintQ.has(key)) { toast('这一幕已在作画队列里'); return; }
      // 场景描述读当前 head 的 lastSceneSummary（投影后即 story.lastSceneSummary）
      A.enqueueImage(S.story.lastSceneSummary, treeHeadNodeId(), key);
      toast('已加入作画队列');
    };
    $('#btn-manual-gen').onclick = manualGenerate;
    $('#btn-stage-gen').onclick = e => { if (e) e.stopPropagation(); manualGenerate(); };
    $('#btn-toggle-image').onclick = A.toggleStagePanel;
    $('#btn-stage-painter').onclick = e => { if (e) e.stopPropagation(); A.openWorkbench(null); };
    $('#btn-immersive').onclick = e => {
      if (e) e.stopPropagation();
      if (!S.story) return;
      if (A.isImmersive()) A.exitImmersive(); else A.enterImmersive();
    };
    $('#btn-immersive-exit').onclick = e => { if (e) e.stopPropagation(); A.exitImmersive(); };

    // 顶栏「⋯」/ 输入区「＋」：打开前先刷新菜单项状态
    $('#btn-hud-more').onclick = e => { e.stopPropagation(); A.toggleMenu($('#btn-hud-more'), $('#hud-more-menu')); };
    $('#btn-more-actions').onclick = e => { e.stopPropagation(); A.toggleMenu($('#btn-more-actions'), $('#feature-menu')); };
    document.addEventListener('click', e => {
      if (e.target.closest && e.target.closest('.menu-item')) { closeMenus(); return; }
      if (e.target.closest && e.target.closest('.menu, .hud-more, .menu-wrap')) return;
      A.closeMenus();
    });

    // 舞台点击：沉浸态显示 / 隐藏文字；堆叠态收起 / 展开成细条
    $('#stage-wrap').addEventListener('click', e => {
      if (e.target.closest && e.target.closest('button')) return;
      const layout = A.effectiveLayout();
      if (layout === 'immersive') {
        S.immersiveTextHidden = !S.immersiveTextHidden;
        $('#screen-game').classList.toggle('text-hidden', S.immersiveTextHidden);
      } else if (layout === 'stack') {
        $('#screen-game').classList.toggle('stage-strip');
      }
    });

    // —— 输入 ——
    const doSend = (opts) => {
      // P0-1：busy 期间只有点「停止」按钮才中断；Enter / 输入不触发（玩家可能只是提前打字）
      if (S.busy) { if (opts && opts.allowStop) requestChatStop(); return; }
      const v = $('#player-input').value.trim();
      if (!v) return;
      $('#player-input').value = '';
      A.sendPlayerAction(v, false);
    };
    $('#btn-send').onclick = () => doSend({ allowStop: true });
    $('#player-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSend(); });

    // 做 / 说 / 导演：状态按故事记住
    document.querySelectorAll('#kind-switch .seg-btn').forEach(b => {
      b.onclick = () => {
        if (!S.story) return;
        const k = b.dataset.kind;
        S.story.ui.kind = (k === 'say' || k === 'direct') ? k : 'do';
        A.syncKindSwitch();
        saveAll();
        $('#player-input').focus();
      };
    });

    // 💡 灵感：展开 / 收起这一轮的选项
    $('#btn-inspiration').onclick = () => {
      if (!S.currentChoices.length || S.busy || S.live) return;
      S.choicesTrayOpen = !S.choicesTrayOpen;
      A.renderChat();
      if (S.choicesTrayOpen) {
        const tray = $('#choice-tray');
        if (tray) tray.scrollLeft = 0;
      }
    };

    // 虚拟键盘：visualViewport 变矮（弹出键盘）时，堆叠态自动把图收成细条
    const vv = window.visualViewport;
    const onViewportChange = () => {
      const game = $('#screen-game');
      if (!game) return;
      const shrunk = !!vv && vv.height < Math.max(300, window.innerHeight * 0.72);
      game.classList.toggle('kb-open', shrunk);
    };
    if (vv) {
      vv.addEventListener('resize', onViewportChange);
      vv.addEventListener('scroll', onViewportChange);
    }
    $('#player-input').addEventListener('focus', () => setTimeout(onViewportChange, 260));
    $('#player-input').addEventListener('blur', () => setTimeout(onViewportChange, 260));

    A.bindSplitter();

    // —— 向导 ——
    $('#btn-close-wizard').onclick = () => $('#modal-wizard').classList.add('hidden');
    $('#btn-wz-cancel').onclick = () => $('#modal-wizard').classList.add('hidden');
    $('#btn-wz-draft').onclick = A.draftWizard;
    $('#btn-wz-start').onclick = A.startFromWizard;

    // —— 导出 / 设置 ——
    $('#btn-close-export').onclick = () => $('#modal-export').classList.add('hidden');
    $('#btn-do-export').onclick = A.doExport;
    // —— 画师工作台（T-P3-1） ——
    $('#btn-close-painter').onclick = A.closeWorkbench;
    $('#btn-pw-close').onclick = A.closeWorkbench;
    $('#modal-painter').addEventListener('click', e => {
      if (e.target === $('#modal-painter')) A.closeWorkbench();
    });
    $('#btn-pw-redraw').onclick = A.redrawFromWorkbench;
    $('#btn-pw-force').onclick = A.forceRedrawByCard;
    $('#btn-pw-send').onclick = A.painterThreadSend;
    $('#pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') A.painterThreadSend(); });
    $('#btn-pw-reset').onclick = () => {
      if (!S.pw) return;
      const sc = A.imageSceneById(S.pw.sceneId);
      const raw = (sc && sc.promptRaw) || S.pw.promptRaw || '';
      if (!raw) { toast('没有存下画师原稿'); return; }
      S.pw.prompt = A.composePrompt(raw, styleSuffixText());
      $('#pw-prompt').value = S.pw.prompt;
      toast('已回到画师原稿');
    };
    $('#pw-aspect').onchange = A.pwShowWh;
    $('#pw-width').oninput = A.pwShowWh;
    $('#pw-height').oninput = A.pwShowWh;

    // —— 画风锚定（T-P4-1） ——
    $('#btn-close-anchor').onclick = A.closeAnchor;
    $('#btn-anchor-more').onclick = A.runAnchorBatch;
    $('#btn-anchor-skip').onclick = A.closeAnchor;
    $('#btn-anchor-use').onclick = A.anchorDraftCard;
    $('#btn-anchor-back').onclick = () => {
      if (!S.anchor || S.anchor.busy) return;
      $('#anchor-step-card').classList.add('hidden');
      $('#anchor-step-pick').classList.remove('hidden');
      $('#btn-anchor-use').disabled = S.anchor.pickedIdx < 0;
    };
    $('#btn-anchor-lock').onclick = A.anchorLock;
    $('#btn-anchor-chat').onclick = A.anchorCardChat;
    $('#ac-chat').addEventListener('keydown', e => { if (e.key === 'Enter') A.anchorCardChat(); });
    $('#btn-anchor-rerun').onclick = () => { closeModal('modal-settings'); A.openAnchor({}); };
    $('#btn-pw-anchor').onclick = () => { closeWorkbench(); A.openAnchor({}); };

    $('#btn-close-settings').onclick = () => closeModal('modal-settings');
    $('#modal-settings').addEventListener('click', e => {
      if (e.target === $('#modal-settings')) closeModal('modal-settings');
    });
    $('#btn-add-savepoint').onclick = () => {
      if (!S.story) return;
      A.addSavepoint();
      toast('已打存档点');
    };
    $('#btn-clear-notools').onclick = () => {
      S.settings.noTools = [];
      saveAll();
      A.renderNoToolsHint();
      toast('已清空「不接受工具」的模型记录，下次会重新尝试下发工具');
    };
    $('#s-image-aspect').onchange = A.applyAspectToFields;
    $('#s-story-mode').onchange = A.onModeChange;
    $('#btn-save-world').onclick = A.saveWorldFromForm;
    $('#btn-inject-memory').onclick = A.toggleInjectMemory;

    // —— 角色卡（R13 / T-P7-1） ——
    $('#btn-edit-card').onclick = () => { if (!S.story) { toast('先打开一个故事'); return; } A.openCardEditor({ mode: 'edit' }); };
    $('#btn-close-card').onclick = () => A.closeCardEditor(true);
    $('#btn-rc-cancel').onclick = () => A.closeCardEditor(true);
    $('#btn-rc-save').onclick = A.saveCardFromEditor;
    $('#btn-rc-import').onclick = () => $('#file-card').click();
    $('#file-card').onchange = e => {
      importCardFile(e.target.files && e.target.files[0]);
      e.target.value = '';
    };
    $('#modal-card').addEventListener('click', e => {
      if (e.target === $('#modal-card')) A.closeCardEditor(true);
    });

    // —— 用户画像（R13 / T-P7-2） ——
    $('#btn-profile-all').onclick = () => {
      ['#s-profile-choice', '#s-profile-chat', '#s-profile-rp'].forEach(s => { $(s).checked = true; });
    };
    $('#btn-profile-none').onclick = () => {
      ['#s-profile-choice', '#s-profile-chat', '#s-profile-rp'].forEach(s => { $(s).checked = false; });
    };
    $('#btn-profile-clear').onclick = A.clearProfile;
    // —— 测试连接（只探测，不保存、不出图） ——
    Object.keys(A.TEST_TARGETS).forEach(key => {
      const btn = $('#btn-test-' + key);
      if (btn) btn.onclick = () => A.testConnection(key, btn);
    });
    $('#btn-save-settings').onclick = () => {
      applyFormToSettings();
      closeModal('modal-settings');
      toast('设置已保存');
      if (A.sidecarReady()) A.saveFeatureConfig();    // 安全项真源在侧车：单独同步一次
    };

    // —— 可选本地服务：探测 / 功能入口 / 安排与台账 ——
    const probeBtn = $('#btn-sidecar-probe');
    if (probeBtn) probeBtn.onclick = () => {
      const S = IR.Sidecar;
      if (!SC) return;
      S.settings.sidecar = {
        port: Number(($('#s-sidecar-port') || {}).value) || 4319,
        token: (($('#s-sidecar-token') || {}).value || '').trim(),
      };
      persistSettings();
      SC.configure(S.settings.sidecar);
      SC.probe().then(ok => {
        renderSidecarStatus();
        if (ok) { toast('本地服务在线'); A.loadFeatureConfig(); }
        else toast('还是连不上：确认已经运行 node sidecar/server.mjs，且端口、token 与配置一致', true, true);
      });
    };
    const triggerBtn = $('#btn-trigger-refresh');
    if (triggerBtn) triggerBtn.onclick = () => A.renderTriggerList();
    const payBtn = $('#btn-pay-refresh');
    if (payBtn) payBtn.onclick = () => A.renderPayLedger();

    const featEmail = $('#btn-feat-email');
    if (featEmail) featEmail.onclick = A.openEmailModal;
    const featPay = $('#btn-feat-payment');
    if (featPay) featPay.onclick = A.openPaymentModal;
    const featSched = $('#btn-feat-schedule');
    if (featSched) featSched.onclick = () => {
      if (!A.featuresAllowed()) { toast('剧情模式里没有定时主动：切到智能体 / 扮演模式再用', true); return; }
      openModal('modal-settings');
      if (A.sidecarReady()) A.loadFeatureConfig();
      const fs = $('#fs-schedule');
      if (fs && fs.scrollIntoView) fs.scrollIntoView({ block: 'start' });
    };
    const closeEmail = $('#btn-close-email');
    if (closeEmail) closeEmail.onclick = () => closeModal('modal-email');
    const closePay = $('#btn-close-payment');
    if (closePay) closePay.onclick = () => closeModal('modal-payment');
    const emSend = $('#btn-em-send');
    if (emSend) emSend.onclick = A.doEmailSend;
    const pmSubmit = $('#btn-pm-submit');
    if (pmSubmit) pmSubmit.onclick = A.doPaymentSubmit;
    $('#btn-backup-all').onclick = () => {
      doBackupAll().catch(e => toast('导出备份失败：' + ((e && e.message) || e), true, true));
    };
    // 清理孤儿原图：只删「没有任何故事引用」的 Blob，剧情 / 缩略图 / 提示词都不动
    $('#btn-clean-images').onclick = async () => {
      const keys = await Store.listImageKeys();
      const keep = Store.knownImageIds();
      const orphans = keys.filter(k => !keep.has(k));
      if (!orphans.length) { toast('没有可清理的原图（现存 ' + keys.length + ' 张，都有故事引用）'); return; }
      if (!await irConfirm('清理 ' + orphans.length + ' 张没有故事引用的原图？剧情、缩略图、提示词都不受影响。', { title: '清理孤儿原图', okText: '清理' })) return;
      orphans.forEach(k => Store.releaseImage(k));
      await Store.flush();
      A.renderStoragePanel();
      toast('已清理 ' + orphans.length + ' 张孤儿原图', false, true);
    };
    $('#btn-clear-save').onclick = async () => {
      if (!await irConfirm('清空本地存档与全部设置？此操作不可恢复。', { title: '危险操作', okText: '清空' })) return;
      Store.clearAll();
      S.settings = Store.defaultSettings();
      S.story = null;
      A.syncSettingsToForm();
      A.showStart();
      toast('已清空');
    };
    // 模型名变化 → 按能力重排参数字段（T-M-1）
    $('#s-chat-model').addEventListener('change', () => {
      const cap = Cap.find('chat', $('#s-chat-model').value.trim());
      S.settings.chat.model = $('#s-chat-model').value.trim();
      if (cap && +cap.contextWindow > 0) S.settings.chat.contextWindow = 0; // 交回登记表自动值
      if (!cap || !cap.thinking || cap.thinking.kind === 'none') S.settings.chat.thinking = 'default';
      A.renderCapabilityFields();
    });
    $('#s-image-model').addEventListener('change', () => {
      S.settings.image.model = $('#s-image-model').value.trim();
      A.renderCapabilityFields();
    });
    // 选了「自定义尺寸…」就亮出宽高输入（预填档位模式下隐藏）
    $('#s-image-size').addEventListener('change', () => {
      S.settings.image.size = $('#s-image-size').value;
      A.showImageWh(S.settings.image.size === '__custom__');
    });
    // 自建确认弹窗（irConfirm）：确定 / 取消 / 关闭 / 回车
    $('#cf-ok').onclick = () => closeConfirm(confirmValue());
    $('#cf-cancel').onclick = () => closeConfirm(null);
    $('#btn-close-confirm').onclick = () => closeConfirm(null);
    $('#modal-confirm').addEventListener('click', e => { if (e.target === $('#modal-confirm')) closeConfirm(null); });
    $('#cf-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); closeConfirm(confirmValue()); }
    });

    // 图片灯箱：点遮罩 / 点图都关（Esc 见下面的全局按键）
    const lightbox = $('#lightbox');
    if (lightbox) lightbox.onclick = () => A.closeLightbox();

    // Esc：只关最上层弹窗（确认弹窗要走 closeConfirm 才能收掉 Promise）；
    // 没有弹窗时才退出沉浸态（P2）。
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (A.closeLightbox()) return;   // 灯箱最先关（点遮罩也能关）
      if (closeTopModal()) return;
      const openMenu = document.querySelector('.menu:not(.hidden)');
      if (openMenu) { closeMenus(); return; }
      A.exitImmersive();
    });

    // 点弹窗遮罩关闭：只处理最上层，避免误关底下那层
    MODAL_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el || id === 'modal-confirm') return;
      el.addEventListener('click', ev => {
        if (ev.target !== el) return;
        if (modalStack[modalStack.length - 1] !== id) return;
        // 功能类弹窗（尤其设置 / 邮件 / 支付）里填了一半的内容，误点遮罩不该丢
        if (id === 'modal-settings' || id === 'modal-email' || id === 'modal-payment' || id === 'modal-wizard') return;
        dismissModal(id);
      });
    });

    // 提示条关闭按钮（只有错误提示才显示）
    const toastClose = $('#toast-close');
    if (toastClose) toastClose.onclick = hideToast;

    // 断网 / 恢复：只是提示，绝不排队、不补发（离线是「这次点了不算」）
    window.addEventListener('offline', () => toast('已断网：聊天与作画暂时用不了，已存的故事照常能看。联网后重新点一次即可（离线期间不会排队、不会事后偷偷扣额度）。', true, true));
    window.addEventListener('online', () => toast('网络回来了：可以继续聊、继续作画。', false, true));

    // 退出即自动存档；页面不可见时暂停循环动画（html[data-paused]）
    window.addEventListener('beforeunload', () => { if (S.story) saveAll(); });
    document.addEventListener('visibilitychange', () => {
      applyPaused();
      if (document.hidden && S.story) saveAll();
    });
  }

  /* ================= 启动 ================= */

  function init() {
    // 后台落盘失败（最常见：本地空间满）不再静默：10 秒节流提示一次导出备份
    Store.setPersistErrorHandler(() => {
      if (Date.now() - S.lastSaveWarnAt < 10000) return;
      S.lastSaveWarnAt = Date.now();
      toast('存档写入失败（本地空间可能已满）：请「一键导出全部备份」，或删掉不用的故事 / 原图腾出空间', true, true);
    });
    // 原图是 Blob、异步取的：取到后把画面与缩略图重画一遍
    Store.setImageReadyHandler(() => { renderStage(); A.renderThumbs(); });

    Store.migrateLegacy();            // v0.1 旧档 → v0.2（幂等）
    S.settings = Store.loadSettings();  // 迁移后重新读取
    if (DEMO) S.settings = IR.Demo.applyTo(S.settings);   // 只改内存：演示适配器生效，配置不落盘
    // 动效强度（UI-1）：启动写 data-motion；系统「减少动态效果」变化时跟随（显式选择优先）
    applyMotion();
    if (motionMQ) {
      if (motionMQ.addEventListener) motionMQ.addEventListener('change', applyMotion);
      else if (motionMQ.addListener) motionMQ.addListener(applyMotion);
    }
    A.watchStageVisibility();           // Ken Burns 离屏暂停
    bind();
    A.syncSettingsToForm();
    A.initFeatures();                   // 主动消息编排：去重 + 排队（投递走 sendPlayerAction）
    if (DEMO) {
      // 演示模式保持零外联：把本地服务换成一整套内存 mock，界面链路照样跑通
      if (IR.Demo && IR.Demo.installSidecarMock) IR.Demo.installSidecarMock();
    }
    A.initSidecar();                    // 探测本地服务；离线则三功能保持禁用
    if (DEMO) A.startDemo();            // 演示模式直接开演（跳过开始页与试画锚定）
    else A.showStart();                 // 入口 = 开始页（v0.1 原样）
    A.renderShelf();
    A.initStorageGuard().then(A.renderStoragePanel);   // P0：申请持久化 + 刷新存储面板
    A.remindBackupIfNeeded();                        // P0：7 天没备份就提醒一次
  }

  // 先进 boot（装载 IndexedDB / 把 localStorage 旧数据迁过来），再进界面。
  // boot 失败会自己退回 localStorage 模式：功能一样，只是容量仍是约 5MB —— 数据不会丢。
  (async () => {
    let info = null;
    try { info = await Store.boot(); } catch (e) { console.warn('存储初始化失败：', e); }
    init();
    if (info && info.error) {
      toast('本地存储升级未完成（IndexedDB 用不了），已退回原来的存储方式：数据没丢，但容量仍是约 5MB。', true, true);
    } else if (info && info.backend === 'indexeddb' && info.migrated && !info.migrated.skipped && info.migrated.stories) {
      toast('已把 ' + info.migrated.stories + ' 个故事迁移到 IndexedDB：容量不再受 5MB 限制。旧数据仍原样保留在本机，可随时回退。', false, true);
    }
  })();
})();
