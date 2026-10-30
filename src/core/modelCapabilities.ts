/*
 * 无限阅读 · 模型参数「预填参考」表（可选）
 *
 * 定位：厂商模型与参数更新极快，本项目**不追同步**，**也不预置任何厂商 / 模型数据**——
 * 上下文窗口（70% 压缩阈值要用到它）、思考档位、图片尺寸、视频参数、额外字段等
 * 全部由用户在「模型设置」里手填，功能一样完整。
 *
 * 真正稳定的硬约定是适配器接口（src/core/providers.ts）：
 *   ChatProviders[provider].chat(cfg, messages, hooks)
 *   ImageProviders[provider].generate(cfg, prompt)
 * 手填通道（providers.ts 支持）：
 *   cfg.model / baseUrl / apiKey / temperature
 *   cfg.contextWindow   上下文窗口（0 = 未知，压缩退回条数兜底）
 *   cfg.thinking        思考档位（'default' | 'on' | 'off' | 厂商档位值）
 *   cfg.extraParams     任意厂商参数，原样并入请求体；"a=b, c.d=e" 或对象均可
 *                       （如 reasoning_effort=high、thinking.type=disabled、steps=30）
 *   cfg.size / quality  生图尺寸与质量；size 不在预填列表时用 customSize 强制下发
 *
 * 需要临时预填：在下面按 { provider, model, contextWindow } 结构加一行即可，逻辑不用动
 * （image / video 也支持同样结构）——但默认留空，避免跟着厂商模型变动一直维护。
 */

/* ↑ 阶段 2 搬迁自 src/core/modelCapabilities.ts（IIFE → ES module，函数体逐字未动）。
 * 阶段 6：模块间依赖改为静态 import（全局 IR 兼容层已删除）。 */

  const VERSION = '0.2.0';
  const RECORDED_AT = '2026-10-04';

  /* ---------------- 对话模型：不预置（需要时按上面的字段格式加一条） ---------------- */

  const CHAT = [];

  /* ---------------- 生图 / 生视频：不预置（需要时按上面的字段格式加一条） ---------------- */

  const IMAGE = [];
  const VIDEO = [];

  /* ---------------- 查询 ---------------- */

  const TABLES = { chat: CHAT, image: IMAGE, video: VIDEO };

  function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

  // 模型名精确匹配（服务商优先）→ 服务商兜底条目（model === '*'）→ null
  // 注：运行时 provider 常为通用的 'openai-compatible'，此时按模型名匹配即可
  function find(kind, model, provider) {
    const table = TABLES[kind] || [];
    const m = norm(model);
    const p = norm(provider);
    if (m) {
      for (const e of table) {
        if (e.model === '*' || e.deprecated) continue;
        if (norm(e.model) === m && p && norm(e.provider) === p) return e;
      }
      for (const e of table) {
        if (e.model === '*' || e.deprecated) continue;
        if (norm(e.model) === m) return e;
      }
    }
    for (const e of table) {
      if (e.model === '*' && (!p || norm(e.provider) === p)) return e;
    }
    return null;
  }

  // 兼容旧模型名的降级查询（仅当精确匹配失败时）
  function findAny(kind, model, provider) {
    const exact = find(kind, model, provider);
    if (exact) return exact;
    const table = TABLES[kind] || [];
    const m = norm(model), p = norm(provider);
    for (const e of table) {
      if (norm(e.model) === m && (!p || norm(e.provider) === p)) return e;
    }
    return null;
  }

  // 上下文窗口：命中返回容量；未命中/未填返回 null（调用方让用户手填）
  function contextWindowOf(model, provider) {
    const e = find('chat', model, provider);
    return (e && Number.isFinite(+e.contextWindow) && +e.contextWindow > 0) ? +e.contextWindow : null;
  }

  // 供 UI 展示的一行摘要（如「上下文 1M」）
  function summarize(kind, entry) {
    if (!entry) return '';
    const parts = [];
    if (Number.isFinite(+entry.contextWindow) && +entry.contextWindow > 0) {
      parts.push('上下文 ' + formatWindow(+entry.contextWindow));
    } else if (kind === 'chat' && entry.model) parts.push('上下文未预填（可手填）');
    const t = entry.thinking || {};
    if (t.kind === 'levels' && t.values) parts.push('思考 ' + t.values.join('/') + (t.alwaysOn ? '（常开）' : ''));
    else if (t.kind === 'toggle' && t.values) parts.push('思考可开关');
    if (entry.image && entry.image.sizes && entry.image.sizes.length) parts.push('尺寸 ' + entry.image.sizes.length + ' 档');
    if (entry.video) {
      const d = entry.video.durations;
      if (d) parts.push('时长 ' + (Array.isArray(d) ? d.join('/') + 's' : (d.min + '–' + d.max + 's')));
    }
    if (entry.deprecated) parts.push('可能已弃用');
    return parts.join(' · ');
  }

  function formatWindow(n) {
    if (n >= 1000000) return (n / 1000000) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
  }

  const ModelCapabilities = {
    VERSION, RECORDED_AT,
    chat: CHAT, image: IMAGE, video: VIDEO,
    find, findAny, contextWindowOf, summarize, formatWindow,
  };
  export { ModelCapabilities };