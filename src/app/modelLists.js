/*
 * src/app/modelLists.js —— 模型列表自动拉取与回填（GET /models，只读、免费）
 *
 * 用途两处：
 *   1. 设置页：把每个「模型」输入框挂上 datalist，按对应 Base URL + Key 拉一次 /models 回填；
 *   2. 接入向导（src/app/connect.js）：经 A.fetchModelList / A.fillDatalist 自己填下拉
 *      （app 模块间调用统一走 A 注册表；本文件不导出 ES 绑定）。
 *
 * 两条既定口径：
 *   · **不硬编码模型名**：列表只来自服务商的 /models 接口或用户手填，预设永远不带模型名；
 *   · **拉取失败不阻塞**：datalist 留空、输入框照常可手填（手填是永久兜底），错误原因只进提示。
 *
 * 同一 Base URL + Key 5 分钟内只拉一次（缓存），并发去重（inflight），
 * 所以 syncSettingsToForm 每次打开设置都调 refreshModelDatalists 也不会打一堆请求。
 */
import { probeModels } from '../core/providers.ts';
import { A } from './core.js';

  const { $ } = A;

  const CACHE_TTL_MS = 5 * 60 * 1000;
  const cache = new Map();      // baseUrl|apiKey → { ok, models, message, at }
  const inflight = new Map();   // 同上 → Promise（并发去重）

  // 拉一次模型列表：永不抛错，失败返回 { ok:false, models:[], message }（人话原因）
  function fetchModelList(baseUrl, apiKey) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    const key = String(apiKey || '').trim();
    if (!base) return Promise.resolve({ ok: false, models: [], message: '还没填 Base URL' });
    const ck = base + '|' + key;
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit);
    if (inflight.has(ck)) return inflight.get(ck);
    const p = probeModels({ baseUrl: base, apiKey: key })
      .then(r => {
        const out = r.ok
          ? { ok: true, models: Array.isArray(r.models) ? r.models : [], message: '' }
          : { ok: false, models: [], message: describeProbeFailure(r) };
        cache.set(ck, Object.assign({ at: Date.now() }, out));
        return out;
      })
      // 网络 / 跨域失败：把原因带回给界面（退回手填即可），不打断任何流程
      .catch(e => ({ ok: false, models: [], message: ((e && e.message) ? e.message : String(e)) }))
      .finally(() => inflight.delete(ck));
    inflight.set(ck, p);
    return p;
  }

  function describeProbeFailure(r) {
    if (r && r.noEndpoint) return '这个接口没有 /models 列表';
    return 'HTTP ' + ((r && r.status) || '?') + ' 拉取失败' + (r && r.detail ? '（' + String(r.detail).replace(/\s+/g, ' ').slice(0, 80) + '）' : '');
  }

  /* ---------------- 设置页回填 ----------------
   * 每个模型输入框一个 datalist：留空项沿用「剧情对话模型」的地址 / Key（与测试连接同口径）。 */
  const TARGETS = [
    { list: 'dl-model-chat', base: '#s-chat-base', key: '#s-chat-key' },
    { list: 'dl-model-painter', base: '#s-painter-base', key: '#s-painter-key', inherit: true },
    { list: 'dl-model-scribe', base: '#s-scribe-base', key: '#s-scribe-key', inherit: true },
    { list: 'dl-model-draft', base: '#s-draft-base', key: '#s-draft-key', inherit: true },
    { list: 'dl-model-mp', base: '#mp-base', key: '#mp-key', inherit: true },
    { list: 'dl-model-image', base: '#s-image-base', key: '#s-image-key' },
    { list: 'dl-model-video', base: '#s-video-base', key: '#s-video-key' },
  ];

  function val(sel) {
    const el = $(sel);
    return el ? String(el.value || '').trim() : '';
  }

  function fillDatalist(listId, models) {
    const dl = document.getElementById(listId);
    if (!dl) return;
    dl.replaceChildren();
    (models || []).forEach(m => {
      const o = document.createElement('option');
      o.value = m;
      dl.appendChild(o);
    });
  }

  // 刷新全部 datalist（有缓存，调用便宜）：拉不到就清空对应下拉，手填兜底不受影响
  async function refreshModelDatalists() {
    await Promise.all(TARGETS.map(async t => {
      const base = val(t.base) || (t.inherit ? val('#s-chat-base') : '');
      const key = val(t.key) || (t.inherit ? val('#s-chat-key') : '');
      if (!base) { fillDatalist(t.list, []); return; }
      const r = await fetchModelList(base, key);
      fillDatalist(t.list, r.models);
    }));
  }

  // 地址 / Key 改了就重新拉（防抖 500ms）：一次绑定，之后设置页每次打开自动生效
  let bound = false;
  function bindModelLists() {
    if (bound) return;
    bound = true;
    let timer = null;
    const kick = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { refreshModelDatalists(); }, 500);
    };
    TARGETS.forEach(t => {
      [t.base, t.key].forEach(sel => {
        const el = $(sel);
        if (el) el.addEventListener('change', kick);
      });
    });
  }

  A.reg({ fetchModelList, refreshModelDatalists, bindModelLists, fillDatalist });
