// 搬家回归护栏（UI-3 §6）：设置控件 id 清单。
// 清单在「设置分层」改动之前从旧 index.html 的 #modal-settings 里抽取并冻结。
// 断言：新 index.html 的 #modal-settings 里这些 id 一个不少（改名必须同步更新本清单并在报告说明）。
// 用法：node eval/settings-ids-test.js        // 校验
//       node eval/settings-ids-test.js --dump // 打印当前 index.html 里的 id（用于更新清单）
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'index.html');

// === 冻结清单（v0.8.0 的 #modal-settings 全部 id，含控件 / 按钮 / 提示位 / 面板） ===
const REQUIRED_IDS = [
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
  's-story-mode',
  'sp-empty', 'sp-panel', 'btn-add-savepoint', 'sp-list',
  'memory-empty', 'memory-panels', 'btn-inject-memory', 'inject-state',
  'w-place', 'w-time', 'w-scene', 'w-threads', 'w-characters',
  'w-rel-stage', 'w-rel-bonds', 'w-rel-notes', 'btn-save-world', 'world-scribe-at',
  'rc-status', 'btn-edit-card', 'sum-count', 'summary-list', 'tool-list',
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

// radio 组用 name 标识（不是 id）；同样冻结。
// P-1（v0.11.0）：出图时机 radio 组（name="s-trigger"）随「时机出图下线」整体删除（任务书 §3.2），
// 清单里不再有它——剧情模式作画只剩 🎨 按钮触发，这里同步冻结清单变化。
const REQUIRED_NAMES = [];

function settingsSection(html) {
  const start = html.indexOf('id="modal-settings"');
  if (start < 0) throw new Error('找不到 #modal-settings');
  const end = html.indexOf('<!-- ========== 通用确认', start);
  return html.slice(start, end < 0 ? html.length : end);
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
const seg = settingsSection(html);
const ids = extractIds(seg);
const names = extractNames(seg);

if (process.argv.includes('--dump')) {
  const notInList = [...ids].filter((id) => !REQUIRED_IDS.includes(id)).sort();
  console.log(JSON.stringify({ ids: [...ids].sort(), names: [...names].sort(), notInList }, null, 2));
  process.exit(0);
}

const missingIds = REQUIRED_IDS.filter((id) => !ids.has(id));
const missingNames = REQUIRED_NAMES.filter((n) => !names.has(n));

let failed = false;
if (missingIds.length) {
  failed = true;
  console.error('❌ 设置控件 id 丢失（搬家回归）：');
  for (const id of missingIds) console.error('   - ' + id);
}
if (missingNames.length) {
  failed = true;
  console.error('❌ 设置控件 radio 组丢失：');
  for (const n of missingNames) console.error('   - ' + n);
}

if (failed) {
  console.error(`清单 ${REQUIRED_IDS.length} 个 id / ${REQUIRED_NAMES.length} 个 name；缺失 ${missingIds.length} / ${missingNames.length}。`);
  process.exit(1);
}
console.log(`✅ settings-ids-test：#${REQUIRED_IDS.length} 个设置控件 id 与 ${REQUIRED_NAMES.length} 个 radio 组全部保留`);
