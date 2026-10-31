// 搬家回归护栏（阶段 4 屏 2）：设置控件 id 清单。
// 两份冻结清单（v0.8.0 冻结、只许平移不许丢，改名必须同步更新清单并在报告说明）：
//   GLOBAL_SETTINGS_IDS —— #modal-settings 里的全局设置控件；
//   STORY_PANEL_IDS     —— 「本对话设置」面板 #prefs-story 里的当前故事控件
//     （阶段 4 屏 2 自全局设置「当前故事」组迁入，见当时的迁移方案；
//      其中 btn-w-char-add 是迁移时随行卡控件一并补进清单的）。
// 取样边界按两个容器各自收紧（旧口径到「通用确认」才截断，#prefs-story 恰好落在区间里，
// 搬不搬家测试都绿——所以必须双向断言：在自己的段里出现、在对方的段里不出现）。
// v0.13.0：能力位控件（思考档位 / 尺寸档位 / 质量）随参考表收窄下线，清单同步收缩（130 → 123），
// 下线的 7 个 id 进 RETIRED_SETTINGS_IDS，回来即红。
// 用法：node eval/settings-ids-test.js        // 校验
//       node eval/settings-ids-test.js --dump // 打印两个段里当前的 id（用于更新清单）
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'index.html');

// === 冻结清单 A：#modal-settings 全局设置（123 个 id，含控件 / 按钮 / 提示位 / 面板） ===
const GLOBAL_SETTINGS_IDS = [
  'modal-settings',
  'dl-base-url',
  'btn-close-settings',
  's-chat-base', 's-chat-model', 's-chat-key', 's-chat-temp',
  's-chat-ctx', 's-chat-params',
  's-chat-cap', 'btn-test-chat', 'test-chat-state',
  's-painter-base', 's-painter-model', 's-painter-key', 'btn-test-painter', 'test-painter-state',
  's-scribe-enabled', 's-scribe-ai', 's-scribe-every', 's-scribe-base', 's-scribe-model', 's-scribe-key',
  'btn-test-scribe', 'test-scribe-state',
  's-profile-choice', 's-profile-chat', 's-profile-rp', 'btn-profile-all', 'btn-profile-none',
  's-profile-scope', 'profile-state', 'profile-list', 'btn-profile-clear',
  's-draft-base', 's-draft-model', 's-draft-key', 'btn-test-draft', 'test-draft-state',
  's-image-aspect', 'row-image-wh', 's-image-width', 's-image-height',
  's-image-base', 's-image-model', 's-image-key', 's-image-params',
  // v0.12.1：生图适配器（OpenAI 兼容 / MiniMax 原生）与参考图（subject_reference）开关
  's-image-provider', 's-image-ref',
  'btn-test-image', 'test-image-state',
  // v0.12.0：生视频模型面板（地址 / 模型 / Key / 自定义参数 + 只读测试连接）
  // 后补：时长 / 分辨率 / 比例的独立控件（用户要求加回；自定义参数改为高级覆盖）
  's-video-base', 's-video-model', 's-video-key', 's-video-params',
  's-video-duration', 's-video-resolution', 's-video-ratio',
  'btn-test-video', 'test-video-state',
  's-style-preset', 's-style-custom', 'style-card-state', 'style-card-view', 'style-card-text',
  // v0.12.1：画风备注就地改（不必重画 4 张候选）
  's-card-note', 'btn-save-card-note',
  'btn-anchor-rerun', 'rolling-style-text',
  's-ui-layout', 's-ui-choices', 's-ui-motion', 'ui-layout-hint',
  's-show-reasoning', 's-tools-enabled', 's-notools-hint', 'btn-clear-notools',
  'fs-sidecar', 'sidecar-state', 's-sidecar-port', 's-sidecar-token', 'btn-sidecar-probe',
  'fs-email', 's-email-enabled', 's-email-provider', 's-email-dailylimit', 's-email-from',
  's-email-resendkey', 's-email-allowlist', 'email-audit',
  'fs-schedule', 's-sched-enabled', 's-sched-paused', 's-sched-dailycap', 's-sched-missed',
  's-sched-quiet', 'btn-trigger-refresh', 'trigger-summary', 'trigger-list',
  'fs-payment', 's-pay-enabled', 's-pay-provider', 's-pay-currency', 's-pay-pertx',
  's-pay-daily', 's-pay-monthly', 's-pay-autoapprove', 's-pay-cooldown', 's-pay-merchants',
  's-pay-categories', 'btn-pay-refresh', 'pay-summary', 'pay-ledger',
  'storage-state', 'storage-usage', 'btn-backup-all', 'btn-clean-images', 'backup-at',
  'backup-with-keys', 'backup-with-src', 'storage-persist',
  'btn-clear-save', 'btn-save-settings',
];

// === 冻结清单 B：#story-prefs 的 #prefs-story「当前故事」组（阶段 4 屏 2 迁入） ===
const STORY_PANEL_IDS = [
  's-story-mode',
  'sp-empty', 'sp-panel', 'btn-add-savepoint', 'sp-list',
  'memory-empty', 'memory-panels', 'btn-inject-memory', 'inject-state',
  'w-place', 'w-time', 'w-scene', 'w-threads', 'w-characters',
  'w-rel-stage', 'w-rel-bonds', 'w-rel-notes', 'btn-save-world', 'world-scribe-at',
  'rc-status', 'btn-edit-card', 'sum-count', 'summary-list', 'tool-list',
  // 阶段 4 屏 2 随迁移补进清单（人物行编辑的「+ 添加人物」）
  'btn-w-char-add',
];

// radio 组用 name 标识（不是 id）；同样冻结。
// v0.11.0：出图时机 radio 组（name="s-trigger"）随「时机出图下线」整体删除，
// 清单里不再有它——剧情模式作画只剩 🎨 按钮触发，这里同步冻结清单变化。
const REQUIRED_NAMES = [];

// === 已下线的能力位控件（只许消失，不许回来） ===
// v0.13.0：参考表不再塑形请求体 —— 表里只有上下文窗口，思考档位 / 尺寸档位 / 质量
// 这些「按厂商能力显隐」的控件随之删除（厂商形参改走「自定义请求参数」）。
// 这几个 id 若又出现在设置屏源码里，说明有人给恒空的表重新接了一套假能力：此处直接红。
const RETIRED_SETTINGS_IDS = [
  'wrap-chat-thinking', 's-chat-thinking',
  'wrap-image-size', 's-image-size',
  'wrap-image-quality', 's-image-quality',
  'wrap-image-aspect',
];

// 阶段 6：legacy 侧 DOM 已删，唯一真源 = Svelte 源码（字段配置 + 组件模板）。
// index.html 只保留两个挂载容器（modal-settings / story-prefs），这里校验容器还在。
const MOUNT_IDS = ['modal-settings', 'story-prefs'];
const html = fs.readFileSync(HTML_PATH, 'utf8');
for (const id of MOUNT_IDS) {
  if (html.indexOf('id="' + id + '"') < 0) throw new Error('index.html 缺挂载容器 #' + id);
}

// id 的形态：模板 id="…" / 字段配置 id: '…'、wrapId: '…'、stateId: '…' / data-testid="…"
// / ModalCard 的 closeId="…"（组件里渲染成 id={closeId}，关闭钮走它）。
function svelteIdsOf(dir) {
  const out = new Set();
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!/\.(svelte|js|ts)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      const re = /\b(?:closeId|wrapId|stateId|id)\s*[:=]\s*["']([^"']+)["']|\bdata-testid\s*[:=]\s*["']([^"']+)["']/g;
      let m;
      while ((m = re.exec(src))) out.add(m[1] || m[2]);
    }
  }
  return out;
}
const svelteSettingsIds = svelteIdsOf(path.join(__dirname, '..', 'src', 'screens', 'settings'));
const svelteStoryIds = svelteIdsOf(path.join(__dirname, '..', 'src', 'screens', 'storyPrefs'));

if (process.argv.includes('--dump')) {
  console.log(JSON.stringify({
    svelteSettings: { ids: [...svelteSettingsIds].sort() },
    svelteStory: { ids: [...svelteStoryIds].sort() },
  }, null, 2));
  process.exit(0);
}

const problems = [];
const missingGlobal = GLOBAL_SETTINGS_IDS.filter((id) => !MOUNT_IDS.includes(id) && !svelteSettingsIds.has(id));
const missingStory = STORY_PANEL_IDS.filter((id) => !MOUNT_IDS.includes(id) && !svelteStoryIds.has(id));
// 双向：清单里的 id 不许出现在对方的屏幕源码里（搬漏会同时命中这两条）
const globalLeak = GLOBAL_SETTINGS_IDS.filter((id) => !MOUNT_IDS.includes(id) && svelteStoryIds.has(id));
const storyLeak = STORY_PANEL_IDS.filter((id) => !MOUNT_IDS.includes(id) && svelteSettingsIds.has(id));

// 已下线的能力位控件：源码里不许回来，也不许重新混进冻结清单（清单自己也要自洽）
const retiredBack = RETIRED_SETTINGS_IDS.filter((id) => svelteSettingsIds.has(id));
const retiredRelisted = RETIRED_SETTINGS_IDS.filter((id) => GLOBAL_SETTINGS_IDS.includes(id));

if (missingGlobal.length) problems.push(['全局设置 id 在设置屏源码里丢失', missingGlobal]);
if (missingStory.length) problems.push(['本对话设置 id 在面板源码里丢失', missingStory]);
if (globalLeak.length) problems.push(['全局设置 id 出现在本对话面板源码（串门）', globalLeak]);
if (storyLeak.length) problems.push(['「当前故事」id 出现在设置屏源码（串门）', storyLeak]);
if (retiredBack.length) problems.push(['已下线的能力位控件又出现在设置屏源码', retiredBack]);
if (retiredRelisted.length) problems.push(['已下线的控件 id 又进了冻结清单', retiredRelisted]);

if (problems.length) {
  for (const [title, list] of problems) {
    console.error('❌ ' + title + '：');
    for (const id of list) console.error('   - ' + id);
  }
  console.error(`全局清单 ${GLOBAL_SETTINGS_IDS.length} 个 / 面板清单 ${STORY_PANEL_IDS.length} 个。`);
  process.exit(1);
}
console.log(`✅ settings-ids-test：全局 #${GLOBAL_SETTINGS_IDS.length} 个 + 本对话 #${STORY_PANEL_IDS.length} 个 id 全部就位（唯一真源：src/screens/settings / src/screens/storyPrefs），双向无泄漏；`
  + `已下线 ${RETIRED_SETTINGS_IDS.length} 个能力位控件未回归；挂载容器保留 ${MOUNT_IDS.join(' / ')}`);
