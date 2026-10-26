// 搬家回归护栏（UI-3 §6 + 阶段 4 屏 2）：设置控件 id 清单。
// 两份冻结清单（v0.8.0 冻结、只许平移不许丢，改名必须同步更新清单并在报告说明）：
//   GLOBAL_SETTINGS_IDS —— #modal-settings 里的全局设置控件；
//   STORY_PANEL_IDS     —— 「本对话设置」面板 #prefs-story 里的当前故事控件
//     （阶段 4 屏 2 自全局设置「当前故事」组迁入，见 docs/phase4-settings-plan.md §4；
//      其中 btn-w-char-add 是迁移时随行卡控件一并补进清单的）。
// 取样边界按两个容器各自收紧（旧口径到「通用确认」才截断，#prefs-story 恰好落在区间里，
// 搬不搬家测试都绿——所以必须双向断言：在自己的段里出现、在对方的段里不出现）。
// 用法：node eval/settings-ids-test.js        // 校验
//       node eval/settings-ids-test.js --dump // 打印两个段里当前的 id（用于更新清单）
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'index.html');

// === 冻结清单 A：#modal-settings 全局设置（130 个 id，含控件 / 按钮 / 提示位 / 面板） ===
const GLOBAL_SETTINGS_IDS = [
  'modal-settings',
  'dl-base-url',
  'btn-close-settings',
  's-chat-base', 's-chat-model', 's-chat-key', 's-chat-temp',
  'wrap-chat-thinking', 's-chat-thinking', 's-chat-ctx', 's-chat-params',
  's-chat-cap', 'btn-test-chat', 'test-chat-state',
  's-painter-base', 's-painter-model', 's-painter-key', 'btn-test-painter', 'test-painter-state',
  's-scribe-enabled', 's-scribe-ai', 's-scribe-every', 's-scribe-base', 's-scribe-model', 's-scribe-key',
  'btn-test-scribe', 'test-scribe-state',
  's-profile-choice', 's-profile-chat', 's-profile-rp', 'btn-profile-all', 'btn-profile-none',
  's-profile-scope', 'profile-state', 'profile-list', 'btn-profile-clear',
  's-draft-base', 's-draft-model', 's-draft-key', 'btn-test-draft', 'test-draft-state',
  'wrap-image-size', 's-image-size', 'wrap-image-aspect', 's-image-aspect',
  'wrap-image-quality', 's-image-quality', 'row-image-wh', 's-image-width', 's-image-height',
  's-image-base', 's-image-model', 's-image-key', 's-image-params',
  // v0.12.1：生图适配器（OpenAI 兼容 / MiniMax 原生）与参考图（subject_reference）开关
  's-image-provider', 's-image-ref',
  'btn-test-image', 'test-image-state',
  // v0.12.0（§9.5）：生视频模型面板（地址 / 模型 / Key / 自定义参数 + 只读测试连接）
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
// P-1（v0.11.0）：出图时机 radio 组（name="s-trigger"）随「时机出图下线」整体删除（任务书 §3.2），
// 清单里不再有它——剧情模式作画只剩 🎨 按钮触发，这里同步冻结清单变化。
const REQUIRED_NAMES = [];

// 取样段：设置段到「本对话设置」注释为止；面板段到「通用确认」注释为止（各自容器的边界）。
function sectionOf(html, fromId, toComment, label) {
  const start = html.indexOf('id="' + fromId + '"');
  if (start < 0) throw new Error('找不到 #' + fromId);
  const end = html.indexOf(toComment, start);
  if (end < 0) throw new Error('找不到 ' + label + ' 的收尾标记：' + toComment);
  return html.slice(start, end);
}

function extractIds(seg) {
  const out = new Set();
  const re = /id="([^"]+)"/g;
  let m;
  while ((m = re.exec(seg))) out.add(m[1]);
  return out;
}

function extractNames(seg) {
  const out = new Set();
  const re = /name="([^"]+)"/g;
  let m;
  while ((m = re.exec(seg))) out.add(m[1]);
  return out;
}

const html = fs.readFileSync(HTML_PATH, 'utf8');
const settingsSeg = sectionOf(html, 'modal-settings', '<!-- ========== 本对话设置', '全局设置段');
const storySeg = sectionOf(html, 'story-prefs', '<!-- ========== 通用确认', '本对话设置段');
const settingsIds = extractIds(settingsSeg);
const storyIds = extractIds(storySeg);
const settingsNames = extractNames(settingsSeg);
const storyNames = extractNames(storySeg);

if (process.argv.includes('--dump')) {
  console.log(JSON.stringify({
    settings: { ids: [...settingsIds].sort(), notInList: [...settingsIds].filter((id) => !GLOBAL_SETTINGS_IDS.includes(id)).sort() },
    story: { ids: [...storyIds].sort(), notInList: [...storyIds].filter((id) => !STORY_PANEL_IDS.includes(id)).sort() },
  }, null, 2));
  process.exit(0);
}

const problems = [];
const missingGlobal = GLOBAL_SETTINGS_IDS.filter((id) => !settingsIds.has(id));
const missingStory = STORY_PANEL_IDS.filter((id) => !storyIds.has(id));
// 双向：清单里的 id 不许出现在对方段里（搬漏会同时命中这两条）
const globalLeak = GLOBAL_SETTINGS_IDS.filter((id) => storyIds.has(id));
const storyLeak = STORY_PANEL_IDS.filter((id) => settingsIds.has(id));

if (missingGlobal.length) problems.push(['全局设置 id 丢失（搬家回归）', missingGlobal]);
if (missingStory.length) problems.push(['本对话设置 id 丢失（搬家回归）', missingStory]);
if (globalLeak.length) problems.push(['全局设置 id 泄漏进 #story-prefs（双份 id）', globalLeak]);
if (storyLeak.length) problems.push(['「当前故事」id 残留在 #modal-settings（搬漏）', storyLeak]);
const missingNames = REQUIRED_NAMES.filter((n) => !settingsNames.has(n) && !storyNames.has(n));
if (missingNames.length) problems.push(['radio 组丢失', missingNames]);

if (problems.length) {
  for (const [title, list] of problems) {
    console.error('❌ ' + title + '：');
    for (const id of list) console.error('   - ' + id);
  }
  console.error(`全局清单 ${GLOBAL_SETTINGS_IDS.length} 个 / 面板清单 ${STORY_PANEL_IDS.length} 个 / radio ${REQUIRED_NAMES.length} 个。`);
  process.exit(1);
}
console.log(`✅ settings-ids-test：全局 #${GLOBAL_SETTINGS_IDS.length} 个（#modal-settings）+ 本对话 #${STORY_PANEL_IDS.length} 个（#story-prefs）+ ${REQUIRED_NAMES.length} 个 radio 组全部就位，双向无泄漏`);
