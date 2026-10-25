/*
 * src/legacy.js —— legacy 入口（阶段 1：接入 Vite，行为零变化）
 *
 * 0.12.1 的旧脚本「原样」加载：一个文件都不改，只是把 index.html 里 <script src> 的
 * 加载顺序搬成 ES module 导入顺序（模块按导入顺序同步执行，与经典脚本的顺序语义一致）。
 * 每个文件都是 IIFE（内部 'use strict' + 挂 window.IR），作为模块执行与作为经典脚本执行等价；
 * 注释里「必须在 … 之前」的依赖约束照旧成立。
 *
 * 后续阶段（任务书 §5 阶段 2）把非界面逻辑拆进 src/core/ 时，从这里逐个换掉导入：
 * IR 先变薄兼容层，等所有屏幕迁完再删。这个文件是那条迁移路径的唯一入口。
 */

// —— 纯逻辑层（不碰 DOM，Node 亦可 require）——
import '../js/providers.js';       // 模型适配器（OpenAI 兼容 / MiniMax …）
import '../js/prefs.js';           // 本对话偏好清洗与解析（凭证剥离的唯一口径）
import '../js/context.js';         // 上下文组装 / 压缩 / 工具吸收（语义真源）
import '../js/tree.js';            // 分支树（story.tree 真源 + 投影）：必须在 store.js 之前
import '../js/treeLayout.js';      // 分支页画布几何（泳道 / 折叠 / 标签）
import '../js/storage.js';         // 存储适配器（IndexedDB 主库 + 回退）：必须在 store.js 之前
import '../js/store.js';           // 存档层（schema v3 + 旧档迁移 + 内存优先读写）
import '../js/modelCapabilities.js';
import '../js/roleCard.js';
import '../js/demo.js';            // 离线演示（?demo=1）：注册剧本与占位图两个适配器
import '../js/zip.js';             // 极简 ZIP 读写（带原图备份打包 / 解包）
import '../js/sidecar.js';         // 可选本地服务客户端（/health、token、api()、SSE）
import '../js/features.js';        // 功能编排内核（主动触达去重与排队）
import '../js/paintQueue.js';      // 作画串行队列
import '../js/proposals.js';       // 提案（模型发起的邮件 / 下单）
import '../js/motion.js';          // 动效强度解析（off / standard / rich / auto）
import '../js/titles.js';
import '../js/search.js';

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
