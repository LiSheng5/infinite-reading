/*
 * src/core/ctxusage.ts —— 上下文用量描述（指示器的纯逻辑层，只读零副作用）
 *
 * 估算与实发同源：tokens = estimateTokensOf(assembleAI1(story, '', opts))，
 * 阈值 = compressThreshold(window)（COMPRESS_RATIO × 窗口）——不另写一套估算、
 * 不硬编码 0.7，否则会和真实的压缩判定漂移。
 * playerAction 传空串：这是「下一轮基线」，不含用户还没输入的那一句，也不含召回 /
 * 实体命中注入（空串匹配不到实体词），所以界面上标「≈」。
 * 不走 buildAI1Request（src/app/round.js）：它会消费 🧠 一次性开关、写回合字段、
 * 超预算时真的改 story 压缩——指示器只读，一样都不能碰。
 *
 * 分层明细：同一次 assembleAI1 顺手拿 opts.trace 的层区间，token 用 estimateTokensOf 的
 * 前缀差分摊分（各层之和恒等于整体估算）；trace 只写本地数组，不往消息里塞任何字段。
 */
import { Context } from './context.ts';

/** 服务商实报的用量形状（normalizeUsage 的输出）；只用于说明文字，不参与 level */
export interface UsageReport {
  prompt: number;
  completion: number;
  total: number;
  cached?: number;
  reasoning?: number;
}

/** 一层上下文占用的估算（分层明细用）；layers 之和恒等于整体 tokens */
export interface CtxLayer {
  key: string;
  label: string;
  tokens: number;
}

export interface CtxUsage {
  /** 下一轮请求的估算 token（≈：不含用户还没输入的那一句与召回 / 实体命中注入） */
  tokens: number;
  /** 模型上下文窗口（token）；0 = 容量未知 */
  window: number;
  /** 自动压缩线 = compressThreshold(window)；容量未知为 0 */
  threshold: number;
  /** tokens / window；容量未知为 0（不画比例） */
  ratio: number;
  level: 'ok' | 'warn' | 'over' | 'unknown';
  /** 最近一条旁白条目上的实报用量；没有就 null */
  lastUsage: UsageReport | null;
  /** 分层明细（系统 / 常驻 / 摘要 / 工具 / 历史 / 本轮输入）；拿不到 trace 时为空数组 */
  layers: CtxLayer[];
}

/* warn 线取阈值的 85%：离自动压缩只剩一步（发送前会自动压一轮）之前先给一档预警，
 * 留出手动压缩的余地。比较写成 tokens×20 ≥ 阈值×17 的整数乘除——0.85 在浮点里不精确，
 * 阈值又恰好落在边界上时，浮点比较会把「恰好到线」抖成低一档。 */
const WARN_NUM = 17;
const WARN_DEN = 20;

/** 上下文用量描述（纯函数、零副作用）：opts = Context.assembleAI1 的组装选项 */
export function describeContextUsage(story: any, opts?: any): CtxUsage {
  const o = opts || {};
  // 同一次组装顺手拿分层区间：trace 只写调用方自己的数组，消息体不夹带私有字段
  const trace: Array<{ layer: string; from: number; to: number }> = [];
  const messages = Context.assembleAI1(story || {}, '', Object.assign({}, o, { trace: trace }));
  const tokens = Context.estimateTokensOf(messages);
  const cw = +o.contextWindow;
  const window = Number.isFinite(cw) && cw > 0 ? cw : 0;
  const threshold = Context.compressThreshold(window);
  const ratio = window > 0 ? tokens / window : 0;
  let level: CtxUsage['level'];
  if (window <= 0) level = 'unknown';
  else if (tokens >= threshold) level = 'over';
  else if (tokens * WARN_DEN >= threshold * WARN_NUM) level = 'warn';
  else level = 'ok';
  return {
    tokens: tokens, window: window, threshold: threshold, ratio: ratio, level: level,
    lastUsage: lastNarrationUsage(story),
    layers: layerBreakdown(messages, trace),
  };
}

const LAYER_LABEL: { [k: string]: string } = {
  system: '系统提示',
  persistent: '常驻设定',
  summary: '前情摘要',
  tools: '工具说明',
  history: '历史对话',
  user: '本轮输入',
};

/* 分层明细：对每层区间做 estimateTokensOf 的前缀差分（C(to) − C(from)）。
 * 相邻层首尾相接时逐层相加会 telescope 回 C(messages.length)，也就是整体 tokens——
 * 「各层之和 == 整体估算」是构造出来的，不靠四舍五入凑数；估算仍只有 estimateTokensOf 一套。
 * trace 缺失或有缺口时返回空数组：宁可没有明细，也不展示对不上的数。 */
function layerBreakdown(messages: any[], trace: any[]): CtxLayer[] {
  if (!Array.isArray(trace) || !trace.length) return [];
  let cursor = 0;
  for (const t of trace) {
    if (!t || t.from !== cursor || t.to <= t.from || t.to > messages.length) return [];
    cursor = t.to;
  }
  if (cursor !== messages.length) return [];
  const out: CtxLayer[] = [];
  let prev = 0;
  for (const t of trace) {
    const cum = Context.estimateTokensOf(messages.slice(0, t.to));
    const n = cum - prev;
    prev = cum;
    if (n > 0) out.push({ key: t.layer, label: LAYER_LABEL[t.layer] || t.layer, tokens: n });
  }
  return out;
}

// 最近一条旁白条目上的 usage（服务商实报）：旧档 / 服务商没上报就是 null，没有 0 冒充
function lastNarrationUsage(story: any): UsageReport | null {
  const log = (story && Array.isArray(story.log)) ? story.log : [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e && e.type === 'narration') return e.usage || null;
  }
  return null;
}

/* memo：指示器挂在 renderChat 的刷新路径上（键盘输入也会走到），key 没变就不重算。
 * key = 故事 id + head 节点 id + messages / summaries 条数 + contextWindow +
 * 工具与画像的注入签名（都从同一份组装选项取：开关变了、注入清单必变，key 必变）。
 * head 节点 id 由调用方传入（树在 app 层手里），这里不依赖 Tree。 */
export function usageMemoKey(story: any, headNodeId: string, opts?: any): string {
  const o = opts || {};
  const profile = Array.isArray(o.profile) ? o.profile : [];
  return [
    (story && story.id) || '',
    headNodeId || '',
    ((story && story.messages) || []).length,
    ((story && story.summaries) || []).length,
    +o.contextWindow || 0,
    (Array.isArray(o.tools) ? o.tools : []).join(','),
    profile.map((p: any) => (p && p.text) || p || '').join('|'),
  ].join('/');
}

// 单槽缓存：整个应用只有一块指示器，一次只缓存一个 key
let memoKey: string | null = null;
let memoValue: CtxUsage | null = null;

/** key 不变返回缓存（同一对象，不重算）；key 变了重算并换缓存 */
export function describeContextUsageCached(key: string, story: any, opts?: any): CtxUsage {
  if (memoValue && memoKey === key) return memoValue;
  const v = describeContextUsage(story, opts);
  memoKey = key;
  memoValue = v;
  return v;
}
