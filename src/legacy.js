/*
 * src/legacy.js —— legacy 入口（阶段 1：接入 Vite；阶段 2：核心逻辑已模块化）
 *
 * 界面层（js/app/*.js、js/app.js）仍是 0.12.1 的 IIFE，一个文件都不改，
 * 只是把加载顺序搬成 ES module 导入顺序（模块按导入顺序同步执行，与经典脚本的顺序语义一致）。
 *
 * 阶段 2 起：纯逻辑层在 src/core/*.ts，是正经 ES module（各自 export 真实 API），
 * 经 src/core/ir.ts 把导出镜像进 IR 命名空间，界面层照旧 IR.Store / IR.Tree …… 访问。
 * 每个核心模块内部现存的 global.IR 惰性互访按铁律保留（可选依赖语义不变）。
 * 等所有屏幕迁完（阶段 4/6），界面改直连 import，IR 兼容层整体删除。
 */

// —— 核心逻辑层（src/core/*.ts，不碰 DOM，Node 亦可 require）——
import './core/providers.ts';       // 模型适配器（OpenAI 兼容 / MiniMax …）
import './core/prefs.ts';           // 本对话偏好清洗与解析（凭证剥离的唯一口径）
import './core/context.ts';         // 上下文组装 / 压缩 / 工具吸收（语义真源）
import './core/tree.ts';            // 分支树（story.tree 真源 + 投影）：必须在 store 之前
import './core/treeLayout.ts';      // 分支页画布几何（泳道 / 折叠 / 标签）
import './core/storage.ts';         // 存储适配器（IndexedDB 主库 + 回退）：必须在 store 之前
import './core/store.ts';           // 存档层（schema v3 + 旧档迁移 + 内存优先读写）
import './core/modelCapabilities.ts';
import './core/roleCard.ts';
import './core/demo.ts';            // 离线演示（?demo=1）：注册剧本与占位图两个适配器
import './core/zip.ts';             // 极简 ZIP 读写（带原图备份打包 / 解包）
import './core/sidecar.ts';         // 可选本地服务客户端（/health、token、api()、SSE）
import './core/features.ts';        // 功能编排内核（主动触达去重与排队）
import './core/paintQueue.ts';      // 作画串行队列
import './core/proposals.ts';       // 提案（模型发起的邮件 / 下单）
import './core/motion.ts';          // 动效强度解析（off / standard / rich / auto）
import './core/titles.ts';
import './core/search.ts';
import './core/backupPack.ts';      // 备份打包 / 还原的纯数据逻辑（阶段 2 自 js/app/backup.js 抽出）

// —— 界面逻辑（js/app/*.js）：core 先建 IR.App / A.state / A.reg，app.js 作组合根收尾 ——
import '../js/app/core.js';
import '../js/app/branch.js';
import '../js/app/models.js';
import '../js/app/library.js';
import '../js/app/shelf.js';
import '../js/app/backup.js';
import '../js/app/importer.js';
import '../js/app/cards.js';
import '../js/app/wizard.js';
import '../js/app/sidecar.js';
import '../js/app/features.js';
import '../js/app/styleanchor.js';
import '../js/app/painter.js';
import '../js/app/video.js';
import '../js/app/turn.js';
import '../js/app/round.js';
import '../js/app/render.js';
import '../js/app/layout.js';
import '../js/app/settings.js';
import '../js/app/prefsui.js';
import '../js/app.js';             // 组合根：事件绑定 + 启动，必须最后

// PWA 注册：只在 https / localhost 下起作用（file:// 自动跳过），不依赖 IR，放最后「装个帽子」
import '../js/pwa.js';

// 阶段 1 spike：Svelte 5 设置切片，仅在 ?spike=1 时挂载（默认形态零像素变化，铁律 3）
import './spike/index.js';

// 阶段 3：基础组件库展示页，仅在 ?ui=1 时挂载（组件库与动效模块的视觉 / 动效自查）
import './ui/gallery.js';

// 阶段 4 · 屏 1：首页 Svelte 重写（默认挂新屏；?ui=legacy 退回旧首页，阶段 6 删）
import './screens/home/index.js';

// 阶段 4 · 屏 2：设置屏 + 本对话设置面板 Svelte 重写（默认挂新屏；?ui=legacy 退回旧 DOM，阶段 6 删）
// 注意：必须在 js/app.js 之后引入——app.js 的组合根只登记异步 boot，bind() 在 Store.boot() 之后才跑，
// 这时两个新屏的 DOM 已就位，按 id 的旧绑定照常挂上（同屏 1 的装配顺序语义）。
import './screens/settings/index.js';
import './screens/storyPrefs/index.js';
