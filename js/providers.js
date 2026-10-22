/*
 * 无限阅读 · 适配器层
 * - ChatProviders：剧情对话（AI1）与画师提示词（AI2）共用的对话适配器
 * - ImageProviders：生图适配器（OpenAI 兼容 /images/generations，通用；模型名由用户自填）
 * - VideoProviders：生视频适配器（MiniMax V2「minimax-video」：提交任务 → 轮询取 URL）
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

  /* ---------------- 「测试连接」：只读探测 ----------------
   * 原则：只发 GET /models（可选的兜底最小对话请求 max_tokens=1），
   * **绝不调用 /images/generations**，所以测试永远不会产生出图费用。
   * 所有探测都不抛异常，统一返回 { level: 'ok'|'warn'|'fail', message }，
   * 让界面层直接把 message 显示出来即可。 */

  const PROBE_TIMEOUT_MS = 15000;

  /* P0-1（2026-10-14 评审）：正式对话请求的超时参数。
   * 此前只有「测试连接」有 15s 超时，正式请求无 signal——SSE 挂起（服务端僵死、
   * 代理断流不关连接）会把上游的 busy 标志永久卡死，玩家只能刷新丢回合。
   * ① 流式：空闲超时，两个 chunk 之间最多 CHAT_IDLE_TIMEOUT_MS；
   * ② 两种形态都有总上限 CHAT_TOTAL_TIMEOUT_MS；
   * ③ AbortController 经 hooks.onAborter 交给调用方，「停止」按钮可随时中断。 */
  const CHAT_IDLE_TIMEOUT_MS = 60000;
  const CHAT_TOTAL_TIMEOUT_MS = 600000;

  function trimBase(cfg) { return String((cfg && cfg.baseUrl) || '').trim().replace(/\/+$/, ''); }

  // 配置格式自检（不联网）：返回人话描述，'' = 没问题
  function cfgProblem(cfg, needModel) {
    if (!cfg || !String(cfg.baseUrl || '').trim()) return '还没填 Base URL。';
    if (!/^https?:\/\//i.test(String(cfg.baseUrl).trim())) return 'Base URL 要以 http:// 或 https:// 开头（现在填的是「' + String(cfg.baseUrl).trim().slice(0, 40) + '」）。';
    if (needModel && !String(cfg.model || '').trim()) return '还没填模型名。';
    return '';
  }

  function friendlyStatus(status, detail) {
    const tail = detail ? '（接口原文：' + String(detail).replace(/\s+/g, ' ').slice(0, 160) + '）' : '';
    if (status === 400) return '接口返回 400：请求被拒绝，多半是模型名写错或该模型不支持这个调用方式。' + tail;
    if (status === 401 || status === 403) return 'API Key 被拒绝（HTTP ' + status + '）：检查 Key 是否复制完整、是否过期、是否有该模型的权限。' + tail;
    if (status === 404) return '地址找不到（HTTP 404）：Base URL 可能写错了，通常要以 /v1 结尾。' + tail;
    if (status === 429) return '被限流了（HTTP 429）：Key 本身是通的，稍后再试或换一个额度充足的 Key。' + tail;
    if (status >= 500) return '服务端错误（HTTP ' + status + '）：接口暂时不可用，稍后再试。' + tail;
    return 'HTTP ' + status + ' 请求失败。' + tail;
  }

  function friendlyNetwork(e) {
    const msg = (e && e.message) ? e.message : String(e || '');
    if (e && (e.name === 'AbortError' || /abort/i.test(msg))) return '连接超时（' + Math.round(PROBE_TIMEOUT_MS / 1000) + ' 秒）：地址不可达，或被网络 / 代理挡住了。';
    if (e instanceof TypeError) return '连不上这个地址：可能是 Base URL 写错、断网，或该接口不允许浏览器直连（CORS）。';
    return '请求失败：' + (msg || '未知错误');
  }

  async function fetchWithTimeout(url, init) {
    if (typeof AbortController === 'undefined') return fetch(url, init);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      return await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
    } finally { clearTimeout(timer); }
  }

  // GET /models：只读、免费。返回 { ok, status, detail, noEndpoint, models }
  async function probeModels(cfg) {
    const headers = {};
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    const res = await fetchWithTimeout(trimBase(cfg) + '/models', { method: 'GET', headers });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (_) {}
      return { ok: false, status: res.status, detail, noEndpoint: res.status === 404 || res.status === 405 };
    }
    let models = [];
    try {
      const data = await res.json();
      const arr = Array.isArray(data && data.data) ? data.data
        : (Array.isArray(data && data.models) ? data.models : []);
      models = arr.map(m => (typeof m === 'string' ? m : (m && (m.id || m.name)) || '')).filter(Boolean);
    } catch (_) { /* 有的接口返回非 JSON，也算连通 */ }
    return { ok: true, status: res.status, models };
  }

  // 兜底：一条 max_tokens=1 的最小对话请求（部分兼容接口没有 /models，费用可忽略）
  async function probeMinimalChat(cfg) {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    const res = await fetchWithTimeout(trimBase(cfg) + '/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (_) {}
      return { ok: false, status: res.status, detail };
    }
    return { ok: true };
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

      /* 「测试连接」：只探测，不生成内容。
       * 先 GET /models（免费）；服务商没有这个接口时，退回一条 max_tokens=1 的最小对话请求。 */
      async test(cfg) {
        const bad = cfgProblem(cfg, true);
        if (bad) return { level: 'fail', message: bad };

        let r;
        try { r = await probeModels(cfg); }
        catch (e) { return { level: 'fail', message: friendlyNetwork(e) }; }

        if (r.ok) {
          const n = r.models.length;
          const want = String(cfg.model).trim().toLowerCase();
          const hit = n ? r.models.some(m => String(m).toLowerCase() === want) : false;
          const extra = n
            ? (hit ? '，列表里有你填的「' + cfg.model + '」' : '，但列表里没看到「' + cfg.model + '」（有些服务商不列全，注意大小写）')
            : '（该接口没有返回模型清单）';
          return { level: 'ok', message: '连接成功：接口可达，返回 ' + n + ' 个模型' + extra + '。' };
        }

        if (r.noEndpoint) {
          // 没有 /models：用一条最小对话请求验证（max_tokens=1）
          try {
            const m = await probeMinimalChat(cfg);
            if (m.ok) return { level: 'ok', message: '连接成功：接口可达并接受了请求（该服务商没有 /models 列表，已用一条最小请求验证）。' };
            return { level: 'fail', message: friendlyStatus(m.status, m.detail) };
          } catch (e) { return { level: 'fail', message: friendlyNetwork(e) }; }
        }

        return { level: 'fail', message: friendlyStatus(r.status, r.detail) };
      },

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

        // P0-1（2026-10-14）：正式请求的超时与中断（参数注释见文件顶部）。
        // AbortController 经 hooks.onAborter 交给调用方（app.js 的「停止」按钮）；
        // 流式每收到一个 chunk 重置空闲计时；两种形态都有总上限兜底。
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        if (ctrl && hooks && typeof hooks.onAborter === 'function') {
          try { hooks.onAborter(ctrl); } catch (_) {}
        }
        let idleTimer = null, totalTimer = null;
        const bumpIdle = () => {
          if (!ctrl || !wantStream) return;
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => ctrl.abort(), CHAT_IDLE_TIMEOUT_MS);
        };
        if (ctrl) {
          totalTimer = setTimeout(() => ctrl.abort(), CHAT_TOTAL_TIMEOUT_MS);
          bumpIdle();
        }
        let res;
        try {
          res = await fetch(url, {
            method: 'POST', headers, body: JSON.stringify(body),
            signal: ctrl ? ctrl.signal : undefined,
          });
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
            bumpIdle();   // P0-1：收到 chunk，重置空闲计时
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
        } finally {
          if (ctrl) { clearTimeout(idleTimer); clearTimeout(totalTimer); }
        }
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

      /* 「测试连接」：只探测，**绝不出图**（出图一定会花钱）。
       * 因此这里只能确认「地址填对了、格式没问题」，确认不了 Key 对生图接口是否有效——
       * 真正的验证只能靠点一次「作画」。 */
      async test(cfg) {
        const bad = cfgProblem(cfg, true);
        if (bad) return { level: 'fail', message: bad };

        let r;
        try { r = await probeModels(cfg); }
        catch (e) { return { level: 'fail', message: friendlyNetwork(e) }; }

        if (r.ok) {
          const n = r.models.length;
          return { level: 'ok', message: '连接成功：接口可达' + (n ? '，返回 ' + n + ' 个模型' : '') + '，配置格式正确。注意：这里不会真的出图，出图能力要在「作画」时才会用到。' };
        }
        if (r.status === 401 || r.status === 403) {
          return { level: 'warn', message: '地址可达，但 /models 拒绝了这次请求（HTTP ' + r.status + '）：有些服务商的 Key 只能调生图、不能列模型，所以这不一定是错。建议直接用最小尺寸试一张确认。' };
        }
        if (r.noEndpoint) {
          return { level: 'warn', message: '地址可达，但该服务商不提供 /models 探测接口（HTTP ' + r.status + '）。配置格式本身没问题；能否出图只能在「作画」时验证。' };
        }
        return { level: 'warn', message: '地址可达，但探测请求没通过：' + friendlyStatus(r.status, r.detail) };
      },

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

  /* ---------------- 生视频适配器（MiniMax V2，任务书 v0.12.0 §2/§4） ----------------
   * 异步任务型，分步接口（恢复轮询要用）：
   *   submit(cfg, { prompt, image?, mode }) → { taskId }
   *   poll(cfg, taskId)                      → { status, url?, error? }
   *     status ∈ queued | running | succeeded | failed | cancelled | expired
   *   generate(cfg, req, hooks)              → { url, taskId, params }
   *     = submit + 每 10 秒 poll；hooks.onTaskId(id)（提交成功立刻回调，用于落盘）、
   *       hooks.onStatus(s)、hooks.signal（本地取消）。旧约定 generate(cfg, {prompt, image}) → {url} 保留。
   * V1 旧接口（Hailuo-02 / video-01，/v1/video_generation + files/retrieve）是本期非目标，不实现。 */

  const VIDEO_POLL_MS = 10000;                  // 官方示例轮询间隔 10 秒
  const VIDEO_TOTAL_TIMEOUT_MS = 15 * 60 * 1000; // 总超时（一处可调）：默认 15 分钟
  const VIDEO_POLL_MAX_NETFAIL = 3;             // 轮询连续网络错误上限（单次容忍）
  const VIDEO_PROMPT_MAX = 7000;                // 提示词长度上限（字符）

  function clampInt(v, min, max, dflt) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  }

  function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* 图片入参：先缩到长边 ≤ 1280、JPEG 0.9，再转 data URL（控制体积，避开 64 MB 上限）。
   * Node（单测）里没有 document / Image：原样返回，不影响请求形状断言。 */
  async function shrinkImageForUpload(dataUrl) {
    const src = String(dataUrl || '');
    if (!src) return '';
    if (typeof document === 'undefined' || typeof Image === 'undefined') return src;
    if (/^https?:\/\//i.test(src)) return src;   // 公网 URL 原样交服务端取
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('图片解码失败'));
        im.src = src;
      });
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (!w || !h) return src;
      const scale = Math.max(w, h) > 1280 ? 1280 / Math.max(w, h) : 1;
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(w * scale));
      cv.height = Math.max(1, Math.round(h * scale));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/jpeg', 0.9) || src;
    } catch (_) { return src; }
  }

  function videoHeaders(cfg, json) {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    return headers;
  }

  // 提交前的生效参数（默认 + 用户 extraParams 合并；供确认弹窗与留痕用，与 submit 同一套规则）
  function videoEffectiveParams(cfg, mode) {
    const body = {
      model: String((cfg && cfg.model) || ''),
      duration: clampInt(cfg && cfg.duration, 4, 15, 5),
      resolution: String((cfg && cfg.resolution) || '768P'),
      ratio: String((cfg && cfg.ratio) || '16:9'),
    };
    mergeExtraParams(body, cfg && cfg.extraParams);
    body.duration = clampInt(body.duration, 4, 15, 5);
    if (mode === 'i2v') body.ratio = 'adaptive';
    else if (!body.ratio || body.ratio === 'adaptive') body.ratio = '16:9';
    return { model: body.model, duration: body.duration, resolution: body.resolution, ratio: body.ratio };
  }

  const MiniMaxVideo = {
    label: 'MiniMax 生视频（V2）',
    // 总超时暴露一份（一处可调的常量；generate 另收 hooks.totalTimeoutMs 供测试收紧）
    VIDEO_TOTAL_TIMEOUT_MS,

    /* 「测试连接」（§2 只读探测）：GET /v2/query/video_generation?page_num=1&page_size=1 列任务，
     * 绝不提交生成任务——所以不花钱。 */
    async test(cfg) {
      const bad = cfgProblem(cfg, true);
      if (bad) return { level: 'fail', message: bad.replace('Base URL', '生视频接口地址').replace('模型名', '生视频模型名') };
      if (!String(cfg.apiKey || '').trim()) return { level: 'fail', message: '还没填生视频 API Key。' };
      let res;
      try {
        res = await fetchWithTimeout(
          trimBase(cfg) + '/v2/query/video_generation?page_num=1&page_size=1',
          { method: 'GET', headers: videoHeaders(cfg, false) }
        );
      } catch (e) {
        // MiniMax 不对浏览器开放跨域（响应不带 CORS 头）：提示走本地转发，别让人干猜
        return {
          level: 'fail',
          message: friendlyNetwork(e)
            + (e instanceof TypeError
              ? '（MiniMax 不允许浏览器直连：先起本地转发 node tools/video-proxy.mjs，接口地址改填 http://127.0.0.1:4320）'
              : ''),
        };
      }
      if (res.ok) {
        return { level: 'ok', message: '连接成功：接口可达，Key 被接受。这里只读列任务，不会提交任务，所以不花钱。能否出视频要在第一次「🎬 出视频」时才算真正验证。' };
      }
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (_) {}
      if (res.status === 401 || res.status === 403) {
        return { level: 'fail', message: 'Key 被拒绝（HTTP ' + res.status + '）：检查 Key 是否复制完整、是否过期、是否有生视频权限。（接口原文：' + detail.slice(0, 120) + '）' };
      }
      return { level: 'warn', message: '地址可达，但探测请求没通过：' + friendlyStatus(res.status, detail) };
    },

    // 生效参数（确认弹窗写明「模型 / 时长 / 分辨率」用；与 submit 的合并规则同源）
    params(cfg, mode) { return videoEffectiveParams(cfg, mode); },

    async submit(cfg, opts) {
      const bad = cfgProblem(cfg, true);
      if (bad) throw new Error(bad.replace('Base URL', '生视频接口地址').replace('模型名', '生视频模型名'));
      if (!String(cfg.apiKey || '').trim()) throw new Error('还没填生视频 API Key。');
      const prompt = String((opts && opts.prompt) || '').trim();
      if (!prompt) throw new Error('视频提示词是空的：先生成一幅画，或先写一句画面描述。');
      const mode = (opts && opts.mode === 'i2v') ? 'i2v' : ((opts && opts.image) ? 'i2v' : 't2v');
      const image = mode === 'i2v' ? await shrinkImageForUpload(String((opts && opts.image) || '')) : '';
      if (mode === 'i2v' && !image) throw new Error('图生视频没有拿到首帧图。');

      const p = videoEffectiveParams(cfg, mode);
      const content = [{ type: 'text', text: prompt.slice(0, VIDEO_PROMPT_MAX) }];
      if (image) content.push({ type: 'image_url', image_url: { url: image }, role: 'first_frame' });
      const body = {
        model: p.model,
        content,
        duration: p.duration,
        resolution: p.resolution,
        ratio: p.ratio,
      };
      // 手填参数最后合并、优先（§4）；随后强制执行协议硬规则：
      // 图生一律 ratio:'adaptive'（忽略用户参数里的 ratio）；文生 ratio 必填且不能是 adaptive。
      mergeExtraParams(body, cfg.extraParams);
      body.duration = clampInt(body.duration, 4, 15, 5);
      if (mode === 'i2v') body.ratio = 'adaptive';
      else if (!body.ratio || body.ratio === 'adaptive') body.ratio = '16:9';

      let res;
      try {
        res = await fetch(trimBase(cfg) + '/v2/video_generation', {
          method: 'POST', headers: videoHeaders(cfg, true), body: JSON.stringify(body),
        });
      } catch (e) {
        // 提交阶段 TypeError → 大概率是 CORS 预检被拦：明确提示，不重试（§4）
        if (e instanceof TypeError) {
          throw new Error('该接口不允许浏览器直连（CORS）：提交请求被浏览器拦下了，这次没有产生费用。可起本地转发 node tools/video-proxy.mjs（接口地址改填 http://127.0.0.1:4320）后重试。');
        }
        throw e;
      }
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      const br = data.base_resp || {};
      if (br.status_code && +br.status_code !== 0) {
        throw new Error('MiniMax 拒绝了这次提交（' + br.status_code + '）：' + (br.status_msg || '没有说明'));
      }
      const taskId = data.task_id || (data.task && (data.task.id || data.task.task_id)) || '';
      if (!taskId) throw new Error('MiniMax 没返回 task_id：' + JSON.stringify(data).slice(0, 200));
      return { taskId: String(taskId) };
    },

    async poll(cfg, taskId) {
      const headers = videoHeaders(cfg, false);
      const res = await fetch(
        trimBase(cfg) + '/v2/query/video_generation/' + encodeURIComponent(String(taskId)),
        { method: 'GET', headers }
      );
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      const br = data.base_resp || {};
      if (br.status_code && +br.status_code !== 0) {
        throw new Error('MiniMax 查询被拒（' + br.status_code + '）：' + (br.status_msg || '没有说明'));
      }
      const t = data.task || {};
      const st = String(t.status || '').toLowerCase();
      if (st === 'succeeded') {
        const u = (t.content && t.content.url) || '';
        if (!u) throw new Error('任务成功但没给视频地址。');
        return { status: 'succeeded', url: u };
      }
      if (st === 'failed' || st === 'cancelled' || st === 'expired') {
        const err = t.error || {};
        const msg = String(err.message || '');
        const code = (err.code != null && err.code !== '') ? String(err.code) : '';
        // 带 task.error 原文（含 code / message，如 1026 = 内容敏感）
        return {
          status: st,
          error: (msg || '任务' + st) + (code ? '（code ' + code + '）' : ''),
        };
      }
      return { status: st || 'running' };   // queued / running
    },

    async generate(cfg, req, hooks) {
      hooks = hooks || {};
      const totalMs = Number(hooks.totalTimeoutMs) > 0 ? Number(hooks.totalTimeoutMs) : VIDEO_TOTAL_TIMEOUT_MS;
      const pollMs = Number(hooks.pollMs) > 0 ? Number(hooks.pollMs) : VIDEO_POLL_MS;
      const started = Date.now();
      const aborted = () => !!(hooks.signal && hooks.signal.aborted);

      const { taskId } = await this.submit(cfg, req);   // 提交失败不重试（TypeError 已带 CORS 提示）
      if (hooks.onTaskId) { try { hooks.onTaskId(taskId); } catch (_) {} }

      let netFails = 0;
      for (;;) {
        if (aborted()) {
          const e = new Error('已停止本地等待（云端任务可能仍在计费）');
          e.name = 'AbortError';
          throw e;
        }
        if (Date.now() - started > totalMs) {
          throw new Error('等了 ' + Math.round(totalMs / 60000) + ' 分钟还没出结果：任务可能还在跑（task_id ' + taskId + '），可在 MiniMax 控制台查看。');
        }
        let q;
        try {
          q = await this.poll(cfg, taskId);
          netFails = 0;
        } catch (e) {
          // 轮询阶段：单次网络错误容忍，连续 3 次才判失败（§4）
          netFails += 1;
          if (netFails >= VIDEO_POLL_MAX_NETFAIL) throw e;
          await sleepMs(pollMs);
          continue;
        }
        if (hooks.onStatus) { try { hooks.onStatus(q.status, q); } catch (_) {} }
        if (q.status === 'succeeded') {
          return { url: q.url, taskId: taskId, params: videoEffectiveParams(cfg, (req && req.mode) || (req && req.image ? 'i2v' : 't2v')) };
        }
        if (q.status === 'failed' || q.status === 'cancelled' || q.status === 'expired') {
          throw new Error(q.error || ('任务' + q.status));
        }
        await sleepMs(pollMs);
      }
    },
  };

  const VideoProviders = {
    'minimax-video': MiniMaxVideo,
    minimax: MiniMaxVideo,          // 旧值别名（migrateSettings 会迁成 minimax-video）
    'openai-videos': MiniMaxVideo,  // 旧值别名（同上）
  };

  global.IR = Object.assign(global.IR || {}, {
    ChatProviders,
    ImageProviders,
    VideoProviders,
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
