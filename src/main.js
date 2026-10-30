/*
 * src/main.js —— 唯一入口（index.html 只引这一个模块）
 *
 * 加载顺序即依赖顺序（ES module 求值顺序）：
 *   1. 应用层内核 core.js（建立注册表 A / 共享状态；静态 import 全部 core 模块）
 *   2. 其余 app 模块（只声明函数并入 A.reg；顶层不执行 DOM 操作）
 *   3. 各屏挂载（把 index.html 里的容器内容换成组件输出）
 *   4. 弹窗外壳（installShell() 把 11 个弹窗整块搬进 display:contents 壳层）
 *   5. 组合根 main.js → 事件绑定 + boot
 *   6. PWA 注册（不依赖应用层，装个帽子）
 *
 * 旧入口 src/legacy.js 已删（阶段 6）：不再有全局 IR 命名空间与 ?ui=legacy 逃生口。
 * 验收脚本需要的测试面只在 URL 带 ?ir-test=1 时挂到 window.__IR_TEST__（见文件末尾），
 * 应用代码零依赖；不带该参数时页面与普通产物完全一致。
 */

// —— 1/2：应用层（core.js 必须第一个求值：其余模块 import 它的 A）——
import './app/core.js';
import './app/branch.js';
import './app/models.js';
import './app/library.js';
import './app/shelf.js';
import './app/backup.js';
import './app/importer.js';
import './app/cards.js';
import './app/wizard.js';
import './app/sidecar.js';
import './app/features.js';
import './app/styleanchor.js';
import './app/painter.js';
import './app/video.js';
import './app/turn.js';
import './app/round.js';
import './app/render.js';
import './app/readmodel.js';
import './app/layout.js';
import './app/settings.js';
import './app/prefsui.js';

// —— 3：各屏（首页 / 设置 / 本对话设置 / 书架 / 阅读页 / 分支页 / 弹窗内容）——
import './screens/home/index.js';
import './screens/settings/index.js';
import './screens/storyPrefs/index.js';
import './screens/shelf/index.js';
import './screens/read/index.js';
import './screens/branch/index.js';
import './screens/modal/index.js';

// —— 4：组合根（启动时先安装弹窗外壳，再绑定事件 + boot）——
import './app/main.js';

// —— 6：PWA 注册（file:// 自动跳过）——
import './pwa.js';

// —— 验收测试钩子（仅 ?ir-test=1）——
// 阶段 6 删掉了全局 IR 兼容层，acceptance/* 仍需要一个稳定的观测面：这里把当前模块
// 的真实导出（不是副本）按旧 IR 的键名挂出来，脚本只读 / 驱动，应用代码不引用它。
// 不带 ?ir-test=1 时 window.__IR_TEST__ 不存在，产物行为与普通打开完全一致。
import { A } from './app/core.js';
import { Store } from './core/store.ts';
import { Tree, genId } from './core/tree.ts';
import { Context } from './core/context.ts';
import { Motion } from './core/motion.ts';
import { ChatProviders, ImageProviders } from './core/providers.ts';
import { Sidecar } from './core/sidecar.ts';
import { APP_VERSION } from './core/version.ts';
import * as ModalHost from './ui/modalHost.js';
import * as MotionDOM from './ui/motion.js';
import { Nav } from './ui/navigation.js';

if (new URLSearchParams(location.search).get('ir-test') === '1') {
  window.__IR_TEST__ = {
    App: A, Store, Tree, Context, Motion, MotionDOM: {
      loopsHeld: MotionDOM.loopsHeld,
      holdLoops: MotionDOM.holdLoops,
      suspendLoops: MotionDOM.suspendLoops,
      applyMotion: MotionDOM.applyMotion,
      applyPaused: MotionDOM.applyPaused,
    },
    Nav, ModalHost, ChatProviders, ImageProviders, Sidecar, genId,
    VERSION: APP_VERSION,
  };
}
