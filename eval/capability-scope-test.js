/* 参考表的职责边界 —— 纯静态扫描 + 一次 require，不开浏览器、不联网。
 *
 * 背景：`src/core/modelCapabilities.ts` 的三张表默认全空（本项目不预置厂商数据），
 * 而 `providers.ts` 曾按表换算「温度是否下发 / 思考档位参数 / 生图尺寸白名单 / 质量档位」——
 * 表恒空 = 这些分支从未执行。现在参考表只登记**上下文窗口**（压缩阈值 / 导入分段用到），
 * 厂商独有的形参（reasoning_effort、thinking.type、quality…）一律走 `extraParams`。
 *
 * 本门禁守四件事：
 *   1. providers.ts 不再读参考表（不 import、不 capOf），温度 / 尺寸照常下发；
 *   2. 参考表只剩 chat 一张表：没有 IMAGE / VIDEO / findAny / thinking / sizes / quality / durations；
 *   3. 消费面仍在：models.js / main.js 用 find、importer.js 用 contextWindowOf；
 *   4. 反向自检：喂进「按表换请求体」的片段必须报警（防扫描器退化成空转）。
 *
 * 用法：node eval/capability-scope-test.js（任一不过 → 退出码 1）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// 先去注释再扫：头部说明里本来就会出现「thinking / 尺寸」这些词，不该算违规
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL  ' + msg); fails++; }
};

/* ---------- 扫描器（纯函数：反向自检直接喂片段） ---------- */

// providers.ts：请求体不许再按表塑形，但温度 / 尺寸必须照发
function providerProblems(src) {
  const code = stripComments(src);
  const out = [];
  if (/from\s*'\.\/modelCapabilities\.ts'/.test(code)) out.push('仍静态 import 参考表');
  if (/\bcapOf\s*\(/.test(code)) out.push('仍有 capOf（按表查能力）');
  if (!/body\.temperature\s*=/.test(code)) out.push('chat 请求体不再下发 temperature');
  if (!/body\.size\s*=\s*cfg\.size/.test(code)) out.push('生图请求体不再下发 size');
  return out;
}

// modelCapabilities.ts：只许剩上下文窗口
function capabilityProblems(src) {
  const code = stripComments(src);
  const out = [];
  if (/\bIMAGE\s*=\s*\[/.test(code)) out.push('IMAGE 表回来了（生图能力不走参考表）');
  if (/\bVIDEO\s*=\s*\[/.test(code)) out.push('VIDEO 表回来了');
  if (/\bfindAny\s*\(/.test(code)) out.push('findAny 回来了（全仓无消费者）');
  if (/\bimage\s*:/.test(code) || /\bvideo\s*:/.test(code)) out.push('导出面里又有 image / video 表');
  if (/\.thinking\b/.test(code)) out.push('仍在读表项的 thinking（思考档位改走 extraParams）');
  if (/\.sizes\b|\.quality\b|\.durations\b/.test(code)) out.push('仍在读表项的 sizes / quality / durations');
  if (/['"]思考 ['"]|['"]尺寸 ['"]|['"]时长 ['"]/.test(code)) out.push('summarize 还在拼思考 / 尺寸 / 时长摘要');
  return out;
}

/* ---------- 1. providers 不再按表塑形请求体 ---------- */
console.log('[1] providers.ts：请求体不再读参考表');
{
  const src = read('src/core/providers.ts');
  const bad = providerProblems(src);
  ok(bad.length === 0, '参考表已不参与请求体塑形' + (bad.length ? '：' + bad.join('；') : ''));
  ok(/body\.temperature\s*=\s*Number\.isFinite/.test(stripComments(src)),
    '温度一律按用户填的值下发（默认 0.8），不再看表');
  ok(/mergeExtraParams\(body, cfg\.extraParams\)/.test(stripComments(src)),
    '厂商形参统一走 mergeExtraParams（最后合并、优先级最高）');
}

/* ---------- 2. 参考表只剩上下文窗口 ---------- */
console.log('[2] modelCapabilities.ts：只剩 chat 一张表 + 上下文窗口');
{
  const src = read('src/core/modelCapabilities.ts');
  const bad = capabilityProblems(src);
  ok(bad.length === 0, '表里没有 image / video / thinking / sizes / quality 的残留'
    + (bad.length ? '：' + bad.join('；') : ''));
  const Cap = require('../src/core/modelCapabilities.ts').ModelCapabilities;
  const keys = Object.keys(Cap).sort();
  const allowed = ['RECORDED_AT', 'VERSION', 'chat', 'contextWindowOf', 'find', 'formatWindow', 'summarize'];
  ok(JSON.stringify(keys) === JSON.stringify(allowed), '导出面 = 上下文窗口那几项（实际：' + keys.join(', ') + '）');
  ok(Array.isArray(Cap.chat) && Cap.chat.length === 0, 'chat 表默认空（不预置厂商数据）');
  ok(Cap.contextWindowOf('不存在的模型') === null, '未登记 → null（调用方让用户手填）');
  ok(Cap.summarize(null) === '', 'summarize(null) = 空串（界面不显示参考值）');
  ok(Cap.summarize({ contextWindow: 128000 }) === '上下文 128K', 'summarize 只报上下文：' + Cap.summarize({ contextWindow: 128000 }));
}

/* ---------- 3. 消费面仍在（表不是死代码：上下文窗口真的被用着） ---------- */
console.log('[3] 消费面：上下文窗口仍被压缩 / 导入 / 设置面板使用');
{
  const models = read('src/app/models.js');
  const main = read('src/app/main.js');
  const importer = read('src/app/importer.js');
  const core = read('src/app/core.js');
  ok(/Cap\.find\(/.test(models) && /Cap\.summarize\(/.test(models),
    'models.js 用 find / summarize 填「上下文窗口」提示');
  ok(/Cap\.find\(/.test(main), 'main.js 换模型时按表刷新提示');
  ok(/Cap\.contextWindowOf\(/.test(importer), 'importer.js 用 contextWindowOf 做导入分段');
  ok(/provider:\s*c\.provider\s*\|\|\s*resolveSub\('draft'\)\.provider/.test(importer),
    'importer.js 跟随剧情模型时按配置取 provider（不写死某一渠道）');
  ok(!/provider:\s*'openai-compatible'/.test(importer),
    'importer.js 没有写死的 provider 字面量（适配器兜底走 ChatProviders[...]，不算配置）');
  ok(/ModelCapabilities as Cap/.test(core), 'core.js 仍然把参考表挂进 A（Cap）');
  ok(!/Cap\.find\(['"](?:image|video)['"]/.test(models + main),
    '没有按 image / video 查表（尺寸不再由表决定）');
}

/* ---------- 4. 反向自检：扫描器必须能失败 ---------- */
console.log('[4] 反向自检（扫描器能失败）');
{
  const badProvider = [
    "import { ModelCapabilities } from './modelCapabilities.ts';",
    'const cap = capOf("chat", cfg);',
    'if (!cap || cap.temperature !== false) body.temperature = 0.8;',
    "const sizes = cap && cap.image && Array.isArray(cap.image.sizes) ? cap.image.sizes : null;",
  ].join('\n');
  const badCaps = [
    'const CHAT = [], IMAGE = [], VIDEO = [];',
    'function findAny() {}',
    'if (t.kind === "levels") parts.push("思考 " + t.values.join("/"));',
    'if (entry.image && entry.image.sizes) parts.push("尺寸 " + entry.image.sizes.length + " 档");',
  ].join('\n');
  const goodProvider = [
    'const body = { model: cfg.model, messages };',
    'body.temperature = Number.isFinite(+cfg.temperature) ? +cfg.temperature : 0.8;',
    "if (cfg.size && cfg.size !== 'auto') body.size = cfg.size;",
    '// 思考档位 reasoning_effort 走 extraParams（注释里的词不算违规）',
  ].join('\n');

  ok(providerProblems(badProvider).length >= 3, '按表塑形请求体的片段被抓到：' + providerProblems(badProvider).join('；'));
  ok(capabilityProblems(badCaps).length >= 3, '多表 / 思考 / 尺寸摘要的片段被抓到：' + capabilityProblems(badCaps).join('；'));
  ok(providerProblems(goodProvider).length === 0, '合规片段不误报（注释里的 thinking 不算）');
  ok(capabilityProblems("const CHAT = [];\nfunction find() {}\nconst ModelCapabilities = { chat: CHAT, find };").length === 0,
    '只剩上下文窗口的片段不误报');
}

if (fails) {
  console.error('capability-scope-test：' + fails + ' 项未通过');
  process.exit(1);
}
console.log('capability-scope-test：全部通过');
