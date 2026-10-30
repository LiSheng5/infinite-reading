/* 统一 motion 模块 · 纯逻辑端（阶段 3）
 *
 * 这里是动效档位的**语义真源**：
 *
 *   Motion.resolve(pref, prefersReduced) → 'off' | 'standard' | 'rich'
 *     pref: 'auto' | 'off' | 'standard' | 'rich'（未知值当 'auto'）
 *     auto  → prefersReduced ? 'off' : 'rich'
 *     显式选择优先于系统偏好（用户知情地选了丰富就尊重）
 *
 *   Motion.TIERS —— 三档政策（off / standard / rich 各自允许什么，数字与 css/motion.css 收口一致）
 *   Motion.LOOP_BUDGET —— 同屏同时运行的循环动画上限（组数；错相多实例按 1 组计）
 *   Motion.ANIMATIONS —— 每个 @keyframes 三档行为的声明表（none | fade | shift | full | loop）
 *   Motion.TRANSITIONS —— 每个「过渡动作」三档 kind / 时长（阶段 5：切屏 / 舞台换画 / 分支切换 /
 *     分支页开合 / 弹窗开合的唯一声明处；DOM 端接线见 src/ui/viewTransition.js）
 *
 * 分工：
 *   · 本文件 = 纯逻辑与声明（Node 可 require，eval/motion-test.js / tokens-test.js 对账）
 *   · css/motion.css = 档位政策变量（--m-*）与动画名表（--an-*）的 CSS 镜像 + @keyframes 唯一定义点
 *     + ::view-transition-* 的时长收口
 *   · src/ui/motion.js = DOM 接线（data-motion / data-paused / 循环预算 / 子树暂停）
 *   · src/ui/viewTransition.js = 过渡内核（runTransition / supportsVT / ?vt=0 降级）
 * 由 eval/tokens-test.js 交叉对账：@keyframes 一条不多一条不少、--an-* 逐档可推导、
 * ::view-transition-* 的时长只走 --m-dur-vt-*。 */

/* ↑ 阶段 2 搬迁自 src/core/motion.ts（IIFE → ES module），阶段 3 扩展出声明表；
 * 函数体 resolve 逐字未动。阶段 6：模块间依赖改为静态 import。 */

  var LEVELS = ['off', 'standard', 'rich'];

  function resolve(pref, prefersReduced) {
    if (LEVELS.indexOf(pref) >= 0) return pref;
    return prefersReduced ? 'off' : 'rich';
  }

  /* 三档政策（的可执行形态；off/standard 的收口值同时落在 css/motion.css 的 --m-* 上）：
   *   maxOpacityMs  透明度变化的时长上限（off 最多 80ms）
   *   maxShiftMs    短位移的时长上限（standard ≤160ms；off 不许位移 = 0）
   *   maxColorMs    颜色类过渡的时长上限（off 不许 = 0）
   *   loops         该档是否允许循环动画
   *   loopBudget    该档同屏循环动画上限（组） */
  var TIERS = {
    off:      { maxOpacityMs: 80,  maxShiftMs: 0,   maxColorMs: 0,   loops: false, loopBudget: 0 },
    standard: { maxOpacityMs: 160, maxShiftMs: 160, maxColorMs: 220, loops: false, loopBudget: 0 },
    rich:     { maxOpacityMs: 420, maxShiftMs: 220, maxColorMs: 220, loops: true,  loopBudget: 3 },
  };

  /* 同屏同时运行的循环动画上限（rich 档）：#busy-line + Ken Burns + 环境光 / 分支页流光 + head 呼吸 + 选中脉冲。
   * 一组 = 同名 keyframes 的错相多实例（如首页符号逐字符波按 1 组计）。
   * 没有运行时登记队列：预算由设计固定，由 acceptance/tools/motion-probe.mjs 逐档实测校验。 */
  var LOOP_BUDGET = 3;

  /* 逐动画三档行为声明表（与 css/motion.css 的 @keyframes、--an-* 名表一一对应）：
   *   none  该档不跑
   *   fade  仅透明度、单次（off 档一切位移/滤镜动画的收容档）
   *   shift opacity + 短位移、单次（standard 的上限形态）
   *   full  完整合成层动画、单次（可含 filter / stroke-dash*，仅 rich）
   *   loop  循环（仅 rich；standard / off 一律收成单次或不跑）
   * 不变式（motion-test 校验）：off ⊆ {none,fade}；standard ⊆ {none,fade,shift}；
   * rich ⊆ {none,fade,shift,full,loop}；档次富度 off ≤ standard ≤ rich。 */
  var ANIMATIONS = {
    /* —— 单次 —— */
    fadeIn:       { off: 'fade',  standard: 'fade',  rich: 'fade'  },
    fadeOut:      { off: 'fade',  standard: 'fade',  rich: 'fade'  },
    titleSwap:    { off: 'fade',  standard: 'fade',  rich: 'fade'  },
    leafIn:       { off: 'fade',  standard: 'shift', rich: 'shift' },
    leafInX:      { off: 'fade',  standard: 'shift', rich: 'shift' },
    prefsIn:      { off: 'fade',  standard: 'shift', rich: 'shift' },
    prefsUp:      { off: 'fade',  standard: 'shift', rich: 'shift' },
    rowIn:        { off: 'none',  standard: 'none',  rich: 'shift' },  // 书架行错峰入场，rich 专档
    blurUp:       { off: 'fade',  standard: 'fade',  rich: 'full'  },  // 去模糊属滤镜，只在 rich；其余收成淡入
    /* —— 循环（rich 专档；standard/off 收成淡入或不跑） —— */
    busyFlow:     { off: 'none',  standard: 'fade',  rich: 'loop'  },  // 忙碌线：standard 单次淡入、rich 流动
    breathe:      { off: 'none',  standard: 'none',  rich: 'loop'  },  // head 呼吸
    kenBurns:     { off: 'none',  standard: 'none',  rich: 'loop'  },  // 舞台极缓推拉
    ambientDrift: { off: 'none',  standard: 'none',  rich: 'loop'  },  // 舞台环境光漂移
    infWave:      { off: 'none',  standard: 'none',  rich: 'loop'  },  // 首页符号色带（逐字符错相，按 1 组计）
    flowLight:    { off: 'none',  standard: 'none',  rich: 'loop'  },  // 分支页流光（只挂一条 path）
    nodePulse:    { off: 'none',  standard: 'none',  rich: 'loop'  },  // 选中节点脉冲
  };

  /* 过渡声明表（阶段 5；三档验收矩阵的可执行形态）：
   *   kind 语义
   *     instant  立即换（off 档唯一形态：不位移、不淡入，焦点与滚动位置都不动）
   *     fade     交叉淡入（standard 的上限形态：无位移）
   *     shift    淡入 + 短位移（rich 的方向性短位移）
   *     shared   共享元素（同 view-transition-name 的新旧快照做位置 / 尺寸补间；仅 rich）
   *   ms 该档这段过渡的时长上限——CSS 侧必须落在 --m-dur-vt-*（tokens-test 对账），
   *   JS 侧的降级淡入也按它收（src/ui/viewTransition.js）。
   * 不变式（motion-test 校验）：off 一律 instant/0；standard 只准 instant|fade；
   * rich 可到 shift|shared；时长 ≤ 该档 TIERS 上限；shared 只准 rich。 */
  var TRANSITIONS = {
    screen:     { off: { kind: 'instant', ms: 0 }, standard: { kind: 'fade',   ms: 160 }, rich: { kind: 'shift',  ms: 220 } },
    stageArt:   { off: { kind: 'instant', ms: 0 }, standard: { kind: 'fade',   ms: 160 }, rich: { kind: 'shared', ms: 220 } },
    sibling:    { off: { kind: 'instant', ms: 0 }, standard: { kind: 'fade',   ms: 160 }, rich: { kind: 'shift',  ms: 220 } },
    branchPage: { off: { kind: 'instant', ms: 0 }, standard: { kind: 'fade',   ms: 160 }, rich: { kind: 'shift',  ms: 220 } },
    modal:      { off: { kind: 'instant', ms: 0 }, standard: { kind: 'fade',   ms: 160 }, rich: { kind: 'shift',  ms: 220 } },
  };

  const Motion = {
    resolve: resolve,
    LEVELS: LEVELS.slice(),
    TIERS: TIERS,
    LOOP_BUDGET: LOOP_BUDGET,
    ANIMATIONS: ANIMATIONS,
    TRANSITIONS: TRANSITIONS,
  };
  export { Motion };
  export const TIERS_POLICY = TIERS;
  export const ANIMATION_SPECS = ANIMATIONS;
  export const TRANSITION_SPECS = TRANSITIONS;
