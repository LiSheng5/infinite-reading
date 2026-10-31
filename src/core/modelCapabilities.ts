/*
 * 无限阅读 · 上下文窗口「参考值」表（可选）
 *
 * 定位：厂商模型更新极快，本项目**不追同步**，**也不预置任何厂商 / 模型数据**。
 * 这张表只放一样东西——**上下文窗口**（token 数）：
 *   · 70% 压缩阈值（`Context.compressThreshold` / `planCompression`）要用到它；
 *   · 导入长文时的分段（`Context.planImport`）也要用到它。
 * 两者都只认一个数字，与厂商协议无关，所以可以安全地「预填参考」。
 *
 * 厂商独有的**形参**（思考档位的 reasoning_effort / thinking.type / enable_thinking、
 * 采样参数、生图质量档位、画风…）一律不进这张表：每种模型怎么写没有通用协议，
 * 写错了请求会被服务商直接拒绝。它们统一走「自定义请求参数」
 * （`cfg.extraParams`，形如 reasoning_effort=high、thinking.type=disabled、quality=hd），
 * 在 `src/core/providers.ts` 里最后并入请求体，同名键优先级最高。
 *
 * 用户自己填的窗口永远优先（`cfg.contextWindow > 0` 时直接用它，不查表）；表里没有就返回 0，
 * 上层按条数兜底压缩，功能一样完整。
 *
 * 需要预填：在下面按 `{ provider, model, contextWindow }` 加一行即可，逻辑不用动——
 * 但默认留空，避免跟着厂商模型变动一直维护。
 */

/* ↑ 阶段 2 搬迁自 src/core/modelCapabilities.ts（IIFE → ES module）。
 * 阶段 6：模块间依赖改为静态 import（全局 IR 兼容层已删除）。
 * v0.13.0：表原本还描述思考档位 / 生图尺寸 / 视频参数，但表恒空 → `providers.ts` 里
 * 按表换算请求体的分支从未执行；这些协议字段已下线（改走 extraParams），表只留上下文窗口。 */

  const VERSION = '0.3.0';
  const RECORDED_AT = '2026-10-04';

  /* ---------------- 对话模型：不预置（需要时按上面的字段格式加一条） ---------------- */

  const CHAT = [];

  /* ---------------- 查询 ---------------- */

  function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

  // 模型名精确匹配（服务商优先）→ 服务商兜底条目（model === '*'）→ null
  // 注：运行时 provider 常为通用的 'openai-compatible'，此时按模型名匹配即可
  function find(model, provider) {
    const m = norm(model);
    const p = norm(provider);
    if (m) {
      for (const e of CHAT) {
        if (e.model === '*' || e.deprecated) continue;
        if (norm(e.model) === m && p && norm(e.provider) === p) return e;
      }
      for (const e of CHAT) {
        if (e.model === '*' || e.deprecated) continue;
        if (norm(e.model) === m) return e;
      }
    }
    for (const e of CHAT) {
      if (e.model === '*' && (!p || norm(e.provider) === p)) return e;
    }
    return null;
  }

  // 上下文窗口：命中返回容量；未命中/未填返回 null（调用方让用户手填）
  function contextWindowOf(model, provider) {
    const e = find(model, provider);
    return (e && Number.isFinite(+e.contextWindow) && +e.contextWindow > 0) ? +e.contextWindow : null;
  }

  // 供 UI 展示的一行摘要（如「上下文 1M」）
  function summarize(entry) {
    if (!entry) return '';
    if (Number.isFinite(+entry.contextWindow) && +entry.contextWindow > 0) {
      return '上下文 ' + formatWindow(+entry.contextWindow);
    }
    return '上下文未预填（可手填）';
  }

  function formatWindow(n) {
    if (n >= 1000000) return (n / 1000000) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
  }

  const ModelCapabilities = {
    VERSION, RECORDED_AT,
    chat: CHAT,
    find, contextWindowOf, summarize, formatWindow,
  };
  export { ModelCapabilities };
