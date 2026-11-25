/* 统一 motion 模块 · 纯逻辑端
 *
 * 运行时只有一档动效：rich（完整动效）。系统「减少动态效果」是唯一的静默例外——
 * 它不出现在任何 UI、也不是一个档位，只由 JS 动画路径在 matchMedia 为真时跳过
 * （src/app/core.js 的 motionLevel()），CSS 侧另有 @media 兜底无条件生效。
 *
 *   Motion.TIERS —— rich 档政策（数字与 css/motion.css 收口一致）
 *   Motion.LOOP_BUDGET —— 同屏同时运行的循环动画上限（组数；错相多实例按 1 组计）
 *   Motion.ANIMATIONS —— 每个 @keyframes 的行为声明表（none | fade | shift | full | loop）
 * Motion.TRANSITIONS —— 每个「过渡动作」的 kind / 时长（切屏 / 舞台换画 / 分支切换 /
 *     分支页开合 / 弹窗开合的唯一声明处；DOM 端接线见 src/ui/viewTransition.js）
 *
 *   · 本文件 = 纯逻辑与声明（Node 可 require，eval/motion-test.js / tokens-test.js 对账）
 *   · css/motion.css = 政策变量（--m-*）与动画名表（--an-*）的 CSS 镜像 + @keyframes 唯一定义点
 *     + ::view-transition-* 的时长收口
 *   · src/ui/motion.js = DOM 接线（data-paused / 循环预算 / 子树暂停）
 *   · src/ui/viewTransition.js = 过渡内核（runTransition / supportsVT / ?vt=0 降级）
 * 由 eval/tokens-test.js 交叉对账：@keyframes 一条不多一条不少、--an-* 可推导、
 * ::view-transition-* 的时长只走 --m-dur-vt-*。 */


  /* 同屏同时运行的循环动画上限：#busy-line + Ken Burns + 环境光 / 分支页流光 + head 呼吸 + 选中脉冲。
   * 一组 = 同名 keyframes 的错相多实例。
   * 没有运行时登记队列：预算由设计固定，由 acceptance/tools/motion-probe.mjs 实测校验。
   * 这是唯一取值处：rich 档的 loopBudget 直接引用它，导出面也导它，不再各写一个 3。 */
  var LOOP_BUDGET = 3;

  /* rich 政策（的可执行形态；收口值同时落在 css/motion.css 的 --m-* 上）：
   *   maxOpacityMs  透明度变化的时长上限
   *   maxShiftMs    短位移的时长上限
   *   maxColorMs    颜色类过渡的时长上限
   *   loops         是否允许循环动画
   *   loopBudget    同屏循环动画上限（组） */
  var TIERS = {
    rich: { maxOpacityMs: 420, maxShiftMs: 220, maxColorMs: 220, loops: true, loopBudget: LOOP_BUDGET },
  };

  /* 逐动画行为声明表（与 css/motion.css 的 @keyframes、--an-* 名表一一对应）：
   *   none  不跑
   *   fade  仅透明度、单次
   *   shift opacity + 短位移、单次
   *   full  完整合成层动画、单次（可含 filter / stroke-dash*）
   *   loop  循环
   * 不变式（motion-test 校验）：值必须落在 none|fade|shift|full|loop 词表内。 */
  var ANIMATIONS = {
    /* —— 单次 —— */
    fadeIn: 'fade',
    fadeOut: 'fade',
    leafIn: 'shift',
    leafInX: 'shift',
    prefsIn: 'shift',
    prefsUp: 'shift',
    rowIn: 'shift',       // 书架行错峰入场
    blurUp: 'full',       // 去模糊属滤镜
    /* —— 循环 —— */
    busyFlow: 'loop',     // 忙碌线流动
    breathe: 'loop',      // head 呼吸
    kenBurns: 'loop',     // 舞台极缓推拉
    ambientDrift: 'loop', // 舞台环境光漂移
    flowLight: 'loop',    // 分支页流光（只挂一条 path）
    nodePulse: 'loop',    // 选中节点脉冲
  };

 /* 过渡声明表：
   *   kind 语义
   *     instant  立即换（焦点与滚动位置都不动）
   *     fade     交叉淡入（无位移）
   *     shift    淡入 + 短位移
   *     shared   共享元素（同 view-transition-name 的新旧快照做位置 / 尺寸补间）
   *   ms 这段过渡的时长——CSS 侧必须落在 --m-dur-vt-*（tokens-test 对账），
   *   JS 侧的降级淡入也按它收（src/ui/viewTransition.js）。
   * 不变式（motion-test 校验）：时长 ≤ rich 档 TIERS 上限（shift/shared 按 maxShiftMs，
   * fade 按 maxOpacityMs）。 */
  var TRANSITIONS = {
    screen:     { kind: 'shift',  ms: 220 },
    stageArt:   { kind: 'shared', ms: 220 },
    sibling:    { kind: 'shift',  ms: 220 },
    branchPage: { kind: 'shift',  ms: 220 },
    modal:      { kind: 'shift',  ms: 220 },
  };

  const Motion = {
    TIERS: TIERS,
    LOOP_BUDGET: LOOP_BUDGET,
    ANIMATIONS: ANIMATIONS,
    TRANSITIONS: TRANSITIONS,
  };
  export { Motion };
