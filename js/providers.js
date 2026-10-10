/*
 * 无限阅读 · 适配器层
 * - ChatProviders：剧情对话（AI1）与画师提示词（AI2）共用的对话适配器
 * - ImageProviders：生图适配器（OpenAI 兼容 /images/generations，通用；模型名由用户自填）
 *   TODO(video)：生视频适配器（可灵 / Vidu 等，提交任务 → 轮询取结果）留待 backlog
 *
 * 全部适配器只依赖浏览器原生 fetch，可在 file:// 或任意静态服务器下运行。
 */
(function (global) {
  'use strict';

  async function readError(res) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (_) {}
    return `HTTP ${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`;
  }

  /* ---------------- 对话适配器 ---------------- */

  // 思考链（R9 / §4.5）：DeepSeek 等厂商经 reasoning_content 下发；兼容个别只叫 reasoning 的实现
  function reasoningOf(obj) {
    if (!obj) return '';
    const r = obj.reasoning_content != null ? obj.reasoning_content : obj.reasoning;
    return typeof r === 'string' ? r : '';
  }
  function emitReasoning(hooks, piece) {
    if (piece && hooks && hooks.onReasoning) hooks.onReasoning(piece);
  }

  // 预填参考表（可选）：命中时用它填默认参数；未命中就不管，全部由 cfg 手填
  function capOf(kind, cfg) {
    const C = global.IR && global.IR.ModelCapabilities;
    if (!C || !cfg || !cfg.model) return null;
    try { return C.find(kind, cfg.model, cfg.provider); } catch (_) { return null; }
  }
  function setParam(body, path, value) {
    const parts = String(path || '').split('.');
    let o = body;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    if (parts[parts.length - 1]) o[parts[parts.length - 1]] = value;
  }
  function coerce(v) {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v !== '' && v != null && !isNaN(+v)) return +v;
    return v;
  }
  // 手填参数：对象，或 "a=b, c.d=e" 形式；原样并入请求体（支持 a.b 嵌套），优先级最高
  function mergeExtraParams(body, raw) {
    if (!raw) return body;
    let obj = raw;
    if (typeof raw === 'string') {
      obj = {};
      raw.split(/[,，\n;；]/).forEach(pair => {
        const i = pair.indexOf('=');
        if (i > 0) {
          const k = pair.slice(0, i).trim();
          if (k) obj[k] = coerce(pair.slice(i + 1).trim());
        }
      });
    }
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) setParam(body, k, obj[k]);
    }
    return body;
  }

  const ChatProviders = {

    // OpenAI 兼容 /chat/completions：覆盖所有提供该格式接口的服务商（云端 / 本地，模型名由用户自填）
    'openai-compatible': {
      label: 'OpenAI 兼容接口',
      async chat(cfg, messages, hooks) {
        const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
        const cap = capOf('chat', cfg);
        const body = { model: cfg.model, messages };
        // 采样温度：登记表声明不支持（如思考常开的推理模型）就不发
        if (!cap || cap.temperature !== false) {
          body.temperature = Number.isFinite(+cfg.temperature) ? +cfg.temperature : 0.8;
        }
        // 思考档位：按登记表换算成该厂商的参数（不支持则不查不发）
        const think = cap && cap.thinking;
        if (think && think.kind !== 'none' && cfg.thinking && cfg.thinking !== 'default') {
          const want = String(cfg.thinking);
          const yes = (want === 'on' || want === 'true' || want === 'enabled');
          if (think.kind === 'toggle') {
            const v = yes ? 'enabled' : 'disabled';
            if ((think.values || []).indexOf(v) >= 0) {
              setParam(body, think.param, (think.values.indexOf('true') >= 0) ? yes : v);
            }
          } else if (think.kind === 'levels') {
            // 显式「关思考」：若模型支持关闭（toggleParam），发关闭；常开模型则忽略
            if (!yes && want === 'off' && think.toggleParam) {
              setParam(body, think.toggleParam, 'disabled');
            } else if ((think.values || []).indexOf(want) >= 0) {
              body[think.param] = want;
            }
          }
        }
        // 工具：结构化下发（OpenAI 格式，§4.5）；调用时机写在系统提示词里
        if (Array.isArray(cfg.tools) && cfg.tools.length) {
          body.tools = cfg.tools;
          if (cfg.toolChoice) body.tool_choice = cfg.toolChoice;
        }
        // 手填参数最后合并：用户说了算（预填表只是省事，不是限制）
        mergeExtraParams(body, cfg.extraParams);
        const wantStream = !!(hooks && hooks.onDelta);
        if (wantStream) body.stream = true;

        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(await readError(res));

        // 非流式
        if (!wantStream || !res.body) {
          const data = await res.json();
          const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
          const text = msg.content || '';
          emitReasoning(hooks, reasoningOf(msg));   // 思考链：非流式一次性给全
          const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
          if (calls.length && hooks && hooks.onToolCalls) hooks.onToolCalls(calls);
          if (hooks && hooks.onDelta) hooks.onDelta(text);
          return text;
        }

        // 流式（SSE）：思考链 delta.reasoning_content → 正文 delta.content → 工具 delta.tool_calls 依次显示（§4.5）
        let full = '';
        const callBuf = [];
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const handleLine = line => {
          const t = line.trim();
          if (!t.startsWith('data:')) return;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') return;
          try {
            const j = JSON.parse(payload);
            const delta = j.choices && j.choices[0] && j.choices[0].delta;
            const rpiece = reasoningOf(delta);
            if (rpiece) emitReasoning(hooks, rpiece);
            const piece = delta && delta.content ? delta.content : '';
            if (piece) { full += piece; hooks.onDelta(piece); }
            const calls = delta && delta.tool_calls;
            if (Array.isArray(calls)) {
              for (const c of calls) {
                const i = Number.isInteger(c.index) ? c.index : 0;
                const acc = callBuf[i] || (callBuf[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
                if (c.id) acc.id = c.id;
                if (c.function) {
                  if (c.function.name) acc.function.name += c.function.name;
                  if (c.function.arguments) acc.function.arguments += c.function.arguments;
                }
              }
            }
          } catch (_) { /* 忽略无法解析的行 */ }
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) handleLine(line);
        }
        // 收尾：多字节残留 decode 冲掉；最后一行没带换行也要处理（否则尾部 JSON 被吃掉 → 解析失败）
        buf += decoder.decode();
        if (buf.trim()) handleLine(buf);
        const done_calls = callBuf.filter(Boolean);
        if (done_calls.length && hooks && hooks.onToolCalls) hooks.onToolCalls(done_calls);
        return full;
      },
    },
  };

  /* ---------------- 生图适配器 ---------------- */

  const ImageProviders = {

    // OpenAI 兼容 /images/generations：
    //  返回形态不一：有的给 b64_json（直接转 dataURL），有的给 url；
    //  两种形态都在这里归一成 dataURL 或 URL，用户无需关心。
    'openai-images': {
      label: 'OpenAI 兼容生图',
      async generate(cfg, prompt) {
        const url = cfg.baseUrl.replace(/\/+$/, '') + '/images/generations';
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
        const body = { model: cfg.model, prompt, n: 1 };
        // 尺寸：预填表命中的模型默认只发列表内的档位；用户选了「自定义尺寸」则强制下发
        const cap = capOf('image', cfg);
        const sizes = cap && cap.image && Array.isArray(cap.image.sizes) ? cap.image.sizes : null;
        const sizeOk = !sizes || !sizes.length || sizes.indexOf(cfg.size) >= 0 || cfg.customSize;
        if (cfg.size && cfg.size !== 'auto' && sizeOk) body.size = cfg.size;
        const qualities = cap && cap.image && Array.isArray(cap.image.quality) ? cap.image.quality : null;
        if (cfg.quality && qualities && qualities.indexOf(cfg.quality) >= 0) body.quality = cfg.quality;
        // 手填参数最后合并（如 steps=30、negative_prompt=…）
        mergeExtraParams(body, cfg.extraParams);

        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(await readError(res));
        const data = await res.json();
        const item = data.data && data.data[0];
        if (!item) throw new Error('生图接口返回为空：' + JSON.stringify(data).slice(0, 200));
        if (item.b64_json) return 'data:image/png;base64,' + item.b64_json;
        if (item.url) return item.url;
        throw new Error('生图接口返回里既没有 url 也没有 b64_json');
      },
    },
  };

  /* ---------------- 生视频适配器（预留） ----------------
   * 真实服务商（可灵 / Vidu 等，提交任务 → 轮询取结果）留待 backlog；
   * 约定接口：generate(cfg, { prompt, image }) -> { url }。 */
  const VideoProviders = {};

  global.IR = Object.assign(global.IR || {}, {
    ChatProviders,
    ImageProviders,
    VideoProviders,
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
