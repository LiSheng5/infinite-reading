#!/usr/bin/env node
'use strict';
/*
 * eval/comfyui-image-test.js —— ComfyUI 生图适配器单测（src/core/providers.ts 的 ImageProviders['comfyui']）
 *
 * 用「假 fetch」验请求形状与回包解析（按 ComfyUI HTTP API）：
 *   - 前置校验：地址 / 提示词 / workflow（缺失、非法 JSON、形状不对）都在发请求前拦下；
 *   - 节点自动定位：采样器 positive/negative 链接 → 文本编码节点；seed 在采样器；尺寸在空潜空间；
 *   - 注入口径：正向替换、负向保留原文、seed 默认随机（randomSeed=off 保持）、宽高折 8 的倍数；
 *   - 手动覆盖：positive=7 / randomSeed=off 等写进「节点定位」时优先于自动探测；
 *   - 提交：POST /prompt body { prompt: workflow, client_id }；node_errors 非空 → 人话报错；
 *   - 轮询：/history 空 {} 继续等、有 outputs 取 images；status_str=error → 报错；
 *   - 取图：/view?filename/subfolder/type → blob → dataURL（下游与云端 base64 同口径）；
 *   - 失败路径：总超时 / 连续网络错 3 次 / CORS TypeError / 外部取消（AbortError）；
 *   - test()：GET /system_stats 只读探测，绝不出图。
 *
 * 用法：node eval/comfyui-image-test.js
 */
const path = require('path');
const H = require('./_harness.js');

const P = require(path.join(__dirname, '..', 'src', 'core', 'providers.ts')).ImageProviders;
const cy = P && P['comfyui'];
if (!cy) {
  console.error('加载失败：ImageProviders["comfyui"] 缺失');
  process.exit(1);
}

const check = H.check;

function jsonRes(status, obj) {
  return {
    ok: status >= 200 && status < 300, status: status, statusText: 'S' + status,
    json: () => Promise.resolve(obj),
    text: () => Promise.resolve(JSON.stringify(obj)),
  };
}

function viewRes(bytes, type) {
  return {
    ok: true, status: 200, statusText: 'OK',
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    blob: () => Promise.resolve(new Blob([bytes], { type: type || 'image/png' })),
  };
}

const calls = [];
function installFetch(handler) {
  calls.length = 0;
  global.fetch = (url, init) => {
    const req = {
      url: String(url),
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {},
      body: init && init.body ? JSON.parse(init.body) : null,
    };
    calls.push(req);
    const out = handler(req);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  };
}

// ComfyUI 默认 workflow（API 格式）的等价形状：KSampler + 两个 CLIPTextEncode + EmptyLatentImage + SaveImage
const WF = () => ({
  '3': { class_type: 'KSampler', inputs: {
    seed: 42, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
    model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
  } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'old positive', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'old negative', clip: ['4', 1] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
});

const PROMPT_OK = () => jsonRes(200, { prompt_id: 'p1', number: 1, node_errors: {} });
// 全链路 mock：POST /prompt 成功 → /history 第一次空（在跑）→ 第二次有图 → /view 回二进制
function fullFlow(viewBytes) {
  let histCalls = 0;
  return req => {
    if (req.method === 'POST') return PROMPT_OK();
    if (req.url.indexOf('/history/') >= 0) {
      histCalls += 1;
      if (histCalls === 1) return jsonRes(200, {});
      return jsonRes(200, {
        p1: {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: { '9': { images: [{ filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' }] } },
        },
      });
    }
    if (req.url.indexOf('/view') === 0 || req.url.indexOf('/view?') >= 0) return viewRes(viewBytes || 'fakepng');
    return jsonRes(404, {});
  };
}

// 默认配置：本地 ComfyUI + 标准宽高
const CFG = { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: '', aspect: '16:9', width: 1280, height: 720, workflow: JSON.stringify(WF()), nodes: '' };
const cfg = patch => Object.assign({}, CFG, patch || {});
const FAST = { totalTimeoutMs: 5000, pollMs: 1 };   // 缩短轮询等待（只影响测试）

(async () => {
  /* ---------- 1. 前置校验（不发请求） ---------- */
  installFetch(fullFlow());
  let err = '';
  try { await cy.generate(cfg({ baseUrl: '' }), 'x', FAST); } catch (e) { err = e.message; }
  check('没填地址 → 直接拦下', /接口地址/.test(err) && calls.length === 0, err);

  err = '';
  try { await cy.generate(cfg(), '   ', FAST); } catch (e) { err = e.message; }
  check('空提示词 → 直接拦下', /提示词/.test(err) && calls.length === 0, err);

  err = '';
  try { await cy.generate(cfg({ workflow: '' }), 'x', FAST); } catch (e) { err = e.message; }
  check('没填 workflow → 直接拦下并指引设置入口', /Workflow/.test(err) && calls.length === 0, err);

  err = '';
  try { await cy.generate(cfg({ workflow: '{oops' }), 'x', FAST); } catch (e) { err = e.message; }
  check('workflow 非法 JSON → 提示用「导出（API 格式）」', /合法 JSON/.test(err) && calls.length === 0, err);

  err = '';
  try { await cy.generate(cfg({ workflow: '[1,2,3]' }), 'x', FAST); } catch (e) { err = e.message; }
  check('workflow 形状不对（数组）→ 拦下', /形状不对/.test(err) && calls.length === 0, err);

  /* ---------- 2. 自动定位 + 注入口径 ---------- */
  installFetch(fullFlow());
  const r2 = await cy.generate(cfg(), '一条雨巷，暖光', FAST);
  const posted = calls[0] && calls[0].method === 'POST' ? calls[0].body.prompt : null;
  check('正向提示词注入采样器 positive 链接的节点（#6）',
    posted && posted['6'] && posted['6'].inputs.text === '一条雨巷，暖光',
    posted && JSON.stringify(posted['6'].inputs.text));
  check('负向提示词保留 workflow 原文（不被替换）',
    posted && posted['7'] && posted['7'].inputs.text === 'old negative',
    posted && JSON.stringify(posted['7'].inputs.text));
  check('seed 默认随机化（不等于原值 42）',
    posted && posted['3'] && posted['3'].inputs.seed !== 42 && Number.isInteger(posted['3'].inputs.seed),
    posted && String(posted['3'].inputs.seed));
  check('宽高注入空潜空间节点（#5，1280x720）',
    posted && posted['5'] && posted['5'].inputs.width === 1280 && posted['5'].inputs.height === 720,
    posted && posted['5'] && (posted['5'].inputs.width + 'x' + posted['5'].inputs.height));
  check('步数 / CFG / 模型名等 workflow 原值不动',
    posted && posted['3'].inputs.steps === 20 && posted['3'].inputs.cfg === 8
      && posted['4'].inputs.ckpt_name === 'sd_xl.safetensors',
    'ok');
  check('取图 → dataURL（与云端 base64 同口径）',
    typeof r2 === 'string' && r2.indexOf('data:image/png;base64,') === 0, r2 && r2.slice(0, 30));

  installFetch(fullFlow());
  await cy.generate(cfg({ width: 777, height: 555 }), 'x', FAST);
  const w3 = calls[0].body.prompt['5'].inputs;
  check('非 8 倍数宽高折整（777x555 → 776x552）',
    w3.width === 776 && w3.height === 552, w3.width + 'x' + w3.height);

  /* ---------- 3. 手动覆盖（节点定位） ---------- */
  installFetch(fullFlow());
  await cy.generate(cfg({ nodes: 'positive=7, randomSeed=off' }), '手动指定', FAST);
  const p4 = calls[0].body.prompt;
  check('节点定位 positive=7 → 注入 #7，#6 保留原文',
    p4['7'].inputs.text === '手动指定' && p4['6'].inputs.text === 'old positive',
    p4['7'].inputs.text + ' / ' + p4['6'].inputs.text);
  check('randomSeed=off → seed 保持原值 42',
    p4['3'].inputs.seed === 42, String(p4['3'].inputs.seed));

  installFetch(fullFlow());
  await cy.generate(cfg({ nodes: 'seed=3' }), 'x', FAST);
  check('节点定位 seed=3 指向采样器自身（与自动结果一致，seed 仍随机）',
    calls[0].body.prompt['3'].inputs.seed !== 42, 'ok');

  /* ---------- 4. 提交形状与错误 ---------- */
  const req0 = calls[0];
  check('POST /prompt，body 带完整 workflow 与 client_id',
    req0.url === 'http://127.0.0.1:8188/prompt' && req0.method === 'POST'
      && !!req0.body.prompt && typeof req0.body.client_id === 'string' && req0.body.client_id.length > 0,
    req0.url);
  check('JSON 头', req0.headers['Content-Type'] === 'application/json', JSON.stringify(req0.headers));

  installFetch(() => jsonRes(200, { prompt_id: 'p1', node_errors: { '4': { errors: [{ type: 'value-not-int', details: 'ckpt_name' }] } } }));
  err = '';
  try { await cy.generate(cfg(), 'x', FAST); } catch (e) { err = e.message; }
  check('node_errors 非空 → 人话报错（带节点 id）', /节点 #4/.test(err) && /ckpt_name/.test(err), err);

  /* ---------- 4b. 鉴权头与 403（新版 origin 校验） ---------- */
  installFetch(fullFlow());
  await cy.generate(cfg({ apiKey: 'psk-123' }), 'x', FAST);
  const authHdrs = calls.map(c => c.headers.Authorization);
  check('填了 Key → 提交 / 轮询 / 取图都带 Bearer', authHdrs.length >= 3 && authHdrs.every(h => h === 'Bearer psk-123'),
    JSON.stringify(authHdrs));

  installFetch(fullFlow());
  await cy.generate(cfg(), 'x', FAST);
  check('没填 Key → 不带 Authorization（本地默认无鉴权）', calls.every(c => !c.headers.Authorization), 'ok');

  installFetch(() => jsonRes(403, { error: 'request with non matching host and origin' }));
  err = '';
  try { await cy.generate(cfg(), 'x', FAST); } catch (e) { err = e.message; }
  check('提交 403 → 提示 origin 校验与 --enable-cors-header "*"',
    /403/.test(err) && /enable-cors-header/.test(err) && /"\*"/.test(err), err);

  /* ---------- 5. 轮询与取图 ---------- */
  installFetch(fullFlow());
  await cy.generate(cfg(), 'x', FAST);
  const histUrl = calls.find(c => c.url.indexOf('/history/') >= 0);
  const viewUrl = calls.find(c => c.url.indexOf('/view') >= 0);
  check('轮询 /history/{prompt_id}', histUrl && histUrl.url === 'http://127.0.0.1:8188/history/p1', histUrl && histUrl.url);
  check('取图 /view 带 filename / type=output',
    viewUrl && viewUrl.url.indexOf('/view?filename=ComfyUI_00001_.png') > 0 && viewUrl.url.indexOf('type=output') > 0,
    viewUrl && viewUrl.url);

  installFetch(req => {
    if (req.method === 'POST') return PROMPT_OK();
    return jsonRes(200, {
      p1: { status: { status_str: 'error', messages: [['execution_error', 'OOM']] }, outputs: {} },
    });
  });
  err = '';
  try { await cy.generate(cfg(), 'x', FAST); } catch (e) { err = e.message; }
  check('status_str=error → 报执行出错（带消息）', /执行出错/.test(err) && /OOM/.test(err), err);

  /* ---------- 6. 失败路径 ---------- */
  installFetch(req => {
    if (req.method === 'POST') return PROMPT_OK();
    return jsonRes(200, {});   // 一直空：任务永远在跑
  });
  err = '';
  try { await cy.generate(cfg(), 'x', { totalTimeoutMs: 5, pollMs: 1 }); } catch (e) { err = e.message; }
  check('总超时 → 报「还没出图」（本地可调超时生效）', /还没出图/.test(err), err);

  let hist500 = 0;
  installFetch(req => {
    if (req.method === 'POST') return PROMPT_OK();
    hist500 += 1;
    return new Error('ECONNRESET ' + hist500);   // 连续网络错
  });
  err = '';
  try { await cy.generate(cfg(), 'x', { totalTimeoutMs: 60000, pollMs: 1 }); } catch (e) { err = e.message; }
  check('连续 3 次网络错 → 判连接断开（不再等满总超时）', /连接断了/.test(err) && /ECONNRESET/.test(err), err);

  installFetch(() => new TypeError('Failed to fetch'));
  err = '';
  try { await cy.generate(cfg(), 'x', FAST); } catch (e) { err = e.message; }
  check('TypeError（提交阶段）→ 提示 --enable-cors-header', /CORS/.test(err) && /enable-cors-header/.test(err), err);

  installFetch(req => {
    if (req.method === 'POST') return PROMPT_OK();
    if (req.url.indexOf('/view') >= 0) return viewRes('x');
    const e = new Error('This operation was aborted');
    e.name = 'AbortError';
    return Promise.reject(e);   // 模拟外部取消：轮询请求被 abort
  });
  err = '';
  let errName = '';
  try { await cy.generate(cfg(), 'x', { totalTimeoutMs: 60000, pollMs: 1, signal: { aborted: true } }); } catch (e) { err = e.message; errName = e.name; }
  check('外部取消 → AbortError（不当成失败留痕）', errName === 'AbortError', errName + ' / ' + err);

  /* ---------- 7. 特殊 workflow ---------- */
  const noSampler = { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['4', 1] } } };
  installFetch(fullFlow());
  err = '';
  try { await cy.generate(cfg({ workflow: JSON.stringify(noSampler) }), 'x', FAST); } catch (e) { err = e.message; }
  check('无采样器 → 找不到正向节点，指引手动指定', /正向提示词节点/.test(err) && /positive=/.test(err), err);

  const combine = WF();
  combine['3'].inputs.positive = ['10', 0];
  combine['10'] = { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['6', 0], conditioning_2: ['7', 0] } };
  installFetch(fullFlow());
  err = '';
  try { await cy.generate(cfg({ workflow: JSON.stringify(combine) }), 'x', FAST); } catch (e) { err = e.message; }
  check('positive 链到中转节点（无 text）→ 指引手动指定', /text 输入/.test(err) && /节点定位/.test(err), err);

  /* ---------- 8. test()：只读探测，绝不出图 ---------- */
  installFetch(() => jsonRes(200, { system: { os: 'win32' }, devices: [{ name: 'NVIDIA GeForce RTX 3060', type: 'cuda', vram_total: 12 } ] }));
  const t1 = await cy.test(cfg());
  check('test 用 GET /system_stats（不 POST /prompt）',
    calls.length === 1 && calls[0].method === 'GET' && calls[0].url === 'http://127.0.0.1:8188/system_stats',
    JSON.stringify(calls.map(c => c.method + ' ' + c.url)));
  check('test 成功 → ok 且显示检测到的设备', t1.level === 'ok' && /RTX 3060/.test(t1.message), t1.message);

  installFetch(() => jsonRes(404, {}));
  const t2 = await cy.test(cfg());
  check('test 404 → warn（不是标准 ComfyUI）', t2.level === 'warn' && /404/.test(t2.message), t2.message);

  installFetch(() => new TypeError('Failed to fetch'));
  const t3 = await cy.test(cfg());
  check('test 遇 CORS → fail 并提示 --enable-cors-header',
    t3.level === 'fail' && /enable-cors-header/.test(t3.message), t3.message);

  installFetch(() => jsonRes(403, {}));
  const t5 = await cy.test(cfg());
  check('test 403 → fail 并提示 origin 校验', t5.level === 'fail' && /403/.test(t5.message) && /enable-cors-header/.test(t5.message), t5.message);

  installFetch(() => jsonRes(200, {}));
  const t4 = await cy.test(cfg({ baseUrl: '' }));
  check('test 没填地址 → fail 且不发请求', t4.level === 'fail' && calls.length === 0, t4.message);

  H.finish('ComfyUI 生图适配器单测');
})();
