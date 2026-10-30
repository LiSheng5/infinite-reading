/*
 * src/core/errors.ts —— 失败处理策略的纯逻辑端
 *
 * 全应用的失败分三类，处理口径写在 ARCHITECTURE.md §2.2：
 *   ① 用户可行动的失败（发送 / 确认 / 重试按钮就在眼前）→ toast 7 秒 + 告知下一步，
 *      调用方保留原重试入口（app 侧 reportUserFailure）；
 *   ② 纯后台降级（书记员 / 画师 / 摘要 / 标题 / 视频转存）→ console.warn 留原因，
 *      需要故事内归因时再落一条 {type:'tool', error} 留痕（本模块的 failureEntry）；
 *   ③ 清理 / 探测 / 解析兜底（abort、focus、revokeObjectURL、坏 JSON）→ 允许吞，
 *      但 catch 里必须写清「为什么可以忽略」，不许空 catch。
 *
 * 本模块只做文本归一与留痕数据的拼装，不碰 DOM / toast / 存储：
 * app 侧的真实出口在 src/app/core.js，纯逻辑部分由 eval/error-policy-test.js 单测。
 */

/** 故事内留痕条目：与 src/app/*.js 手工写的 tool 条目同形，渲染侧按 type/tool/error 识别 */
interface FailureEntry {
  type: 'tool';
  tool: string;
  summary: string;
  error: string;
  ts: number;
}

/**
 * 任意抛错 → 可读的一行原因。
 * 常见形态：Error（message）、字符串、侧车错误对象（message / code）、其他对象的 JSON。
 * 空值不返回空串：调用方拿它拼 console.warn / toast，空原因会让用户以为是未知故障。
 */
function errorText(err: any): string {
  if (err == null) return '未知错误';
  if (typeof err === 'string') return err.trim() || '未知错误';
  if (err instanceof Error) return (err.message || String(err));
  if (typeof err.message === 'string' && err.message) return err.message;
  if (typeof err.code === 'string' && err.code) return err.code;
  try {
    const s = JSON.stringify(err);
    return (s && s !== '{}') ? s : String(err);
  } catch (_) {
    return String(err);
  }
}

/** 截短原因（默认 60 字，与既有 tool 留痕的省略口径一致）：留痕一行放得下，完整原因另存 error */
function shortError(err: any, max?: number): string {
  const text = errorText(err);
  const n = (typeof max === 'number' && max >= 4) ? Math.floor(max) : 60;
  return text.length > n ? text.slice(0, n) + '…' : text;
}

/**
 * 生成一条「后台任务失败（已降级）」留痕。
 * summary 可覆盖默认文案（各任务有自己的兜底说明）；error 始终保留完整原因，
 * 界面据此区分「未启用 / 网络失败 / 回包解析失败」。
 */
function failureEntry(tool: string, err: any, opts?: { summary?: string; ts?: number }): FailureEntry {
  const o = opts || {};
  const text = errorText(err);
  return {
    type: 'tool',
    tool: String(tool || 'task'),
    summary: o.summary || (String(tool || '任务') + '失败（已降级）：' + shortError(text)),
    error: text,
    ts: (typeof o.ts === 'number' && o.ts > 0) ? o.ts : Date.now(),
  };
}

// 导出面只留三个函数（调用方一律命名 import）；不再额外包一个同名命名空间对象
export { errorText, shortError, failureEntry };
export type { FailureEntry };
