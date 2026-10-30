#!/usr/bin/env node
'use strict';
/*
 * eval/minimax-image-test.js —— MiniMax 生图适配器单测（src/core/providers.ts 的 ImageProviders['minimax-image']）
 *
 * 不开浏览器、不联网：用「假 fetch」验请求形状与回包解析（按 2026-10-22 官方文档）：
 *   - 接口地址：Base URL 带不带 /v1 都拼成 {base}/v1/image_generation；
 *   - body：model / prompt（截断 1500）/ aspect_ratio / response_format=base64 / n=1；
 *   - image-01-live：不认自定义宽高（下发也会被删），自定义宽高折成最接近的比例；
 *   - image-01：比例选「自定义」时下发 width/height（512–2048、8 的倍数才发）；
 *   - extraParams 最后合并、优先级最高（style 画风 / seed 等），但 live 的宽高与 n 会被收敛；
 *   - 回包：data.image_base64[] → dataURL；data.image_urls[] → 原样 URL；base_resp 非 0 → 抛错；
 *   - test()：只发 GET 探测，绝不出图（不 POST）。
 *
 * 用法：node eval/minimax-image-test.js
 */
const path = require('path');

global.window = global;
const P = require(path.join(__dirname, '..', 'src', 'core', 'providers.ts')).ImageProviders;
const mm = P && P['minimax-image'];
if (!mm) {
  console.error('加载失败：ImageProviders["minimax-image"] 缺失');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}

function jsonRes(status, obj) {
  return {
    ok: status >= 200 && status < 300, status: status, statusText: 'S' + status,
    json: () => Promise.resolve(obj),
    text: () => Promise.resolve(JSON.stringify(obj)),
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

const OK_B64 = () => jsonRes(200, {
  id: 'trace-1',
  data: { image_base64: ['AAAA'] },
  metadata: { success_count: '1', failed_count: '0' },
  base_resp: { status_code: 0, status_msg: 'success' },
});

// 默认配置：MiniMax 国内站 + image-01-live + 16:9
const CFG = { provider: 'minimax-image', baseUrl: 'https://api.minimaxi.com', apiKey: 'sk-test', model: 'image-01-live', aspect: '16:9', width: 1280, height: 720 };
const cfg = patch => Object.assign({}, CFG, patch || {});

(async () => {
  /* ---------- 1. 接口地址 ---------- */
  installFetch(OK_B64);
  await mm.generate(cfg({ baseUrl: 'https://api.minimaxi.com/' }), '一条雨巷');
  check('无 /v1 的 Base URL 自动补 /v1/image_generation',
    calls[0].url === 'https://api.minimaxi.com/v1/image_generation', calls[0].url);

  installFetch(OK_B64);
  await mm.generate(cfg({ baseUrl: 'http://127.0.0.1:4320/v1' }), '一条雨巷');
  check('已带 /v1 的 Base URL 不重复拼接',
    calls[0].url === 'http://127.0.0.1:4320/v1/image_generation', calls[0].url);

  /* ---------- 2. 默认 body ---------- */
  const req1 = calls[0];
  check('带 Bearer Key 与 JSON 头',
    req1.headers.Authorization === 'Bearer sk-test' && req1.headers['Content-Type'] === 'application/json',
    JSON.stringify(req1.headers));
  check('POST 提交', req1.method === 'POST', req1.method);
  check('model 原样下发', req1.body.model === 'image-01-live', req1.body.model);
  check('prompt 原样下发', req1.body.prompt === '一条雨巷', req1.body.prompt);
  check('预设比例直接下发 aspect_ratio', req1.body.aspect_ratio === '16:9', req1.body.aspect_ratio);
  check('回包要 base64（url 只有 24 小时有效期）', req1.body.response_format === 'base64', req1.body.response_format);
  check('n 固定 1（本项目一次只用一张）', req1.body.n === 1, req1.body.n);
  check('预设比例下不下发宽高', req1.body.width === undefined && req1.body.height === undefined,
    req1.body.width + '/' + req1.body.height);

  /* ---------- 3. 提示词截断（保留尾部画风词） ---------- */
  installFetch(OK_B64);
  const longPrompt = '主体描述'.repeat(400) + ', anime style, cel shading, soft glow, muted palette';
  await mm.generate(cfg(), longPrompt);
  const clipped = calls[0].body.prompt;
  check('prompt 截断到 1500 字以内', clipped.length <= 1500, clipped.length);
  check('截断保留尾部画风关键词', /anime style, cel shading, soft glow, muted palette$/.test(clipped),
    clipped.slice(-60));

  /* ---------- 4. live：自定义宽高折成比例 ---------- */
  installFetch(OK_B64);
  await mm.generate(cfg({ aspect: 'custom', width: 1920, height: 1080 }), 'x');
  check('live + 自定义 1920x1080 → aspect_ratio 16:9 且不发宽高',
    calls[0].body.aspect_ratio === '16:9' && calls[0].body.width === undefined,
    calls[0].body.aspect_ratio + ' / ' + calls[0].body.width);

  installFetch(OK_B64);
  await mm.generate(cfg({ aspect: 'custom', width: 1000, height: 1000 }), 'x');
  check('live + 自定义 1000x1000 → aspect_ratio 1:1', calls[0].body.aspect_ratio === '1:1', calls[0].body.aspect_ratio);

  /* ---------- 5. image-01：自定义宽高下发 ---------- */
  installFetch(OK_B64);
  await mm.generate(cfg({ model: 'image-01', aspect: 'custom', width: 1024, height: 768 }), 'x');
  check('image-01 + 自定义 1024x768 → 下发 width/height，不发比例',
    calls[0].body.width === 1024 && calls[0].body.height === 768 && calls[0].body.aspect_ratio === undefined,
    calls[0].body.width + 'x' + calls[0].body.height + ' / ' + calls[0].body.aspect_ratio);

  installFetch(OK_B64);
  await mm.generate(cfg({ model: 'image-01', aspect: 'custom', width: 1000, height: 700 }), 'x');
  check('image-01 + 非 8 倍数宽高 → 回退最接近的比例（3:2）',
    calls[0].body.width === undefined && calls[0].body.aspect_ratio === '3:2',
    calls[0].body.width + ' / ' + calls[0].body.aspect_ratio);

  /* ---------- 6. extraParams ---------- */
  installFetch(OK_B64);
  await mm.generate(cfg({ extraParams: 'style.style_type=漫画, style.style_weight=0.9, seed=12345, n=4, width=2048, height=2048' }), 'x');
  const b6 = calls[0].body;
  check('extraParams：style 折成嵌套对象',
    !!b6.style && b6.style.style_type === '漫画' && b6.style.style_weight === 0.9,
    JSON.stringify(b6.style));
  check('extraParams：seed 生效', b6.seed === 12345, b6.seed);
  check('extraParams 里的 n 被收敛回 1', b6.n === 1, b6.n);
  check('live 下 extraParams 的宽高被删掉', b6.width === undefined && b6.height === undefined,
    b6.width + '/' + b6.height);

  /* ---------- 6b. 参考图（subject_reference） ---------- */
  installFetch(OK_B64);
  await mm.generate(cfg({ referenceImage: 'data:image/jpeg;base64,AAAA' }), 'x');
  const sr = calls[0].body.subject_reference;
  check('referenceImage → subject_reference[0] = {type:"character", image_file:dataURL}',
    Array.isArray(sr) && sr.length === 1 && sr[0].type === 'character'
    && sr[0].image_file === 'data:image/jpeg;base64,AAAA',
    JSON.stringify(sr));

  installFetch(OK_B64);
  await mm.generate(cfg(), 'x');
  check('没开参考图 → 不带 subject_reference', calls[0].body.subject_reference === undefined,
    JSON.stringify(calls[0].body.subject_reference));

  installFetch(OK_B64);
  await mm.generate(cfg({ referenceImage: 'data:image/jpeg;base64,AAAA', extraParams: { subject_reference: [] } }), 'x');
  check('extraParams 可以覆盖 subject_reference（手填优先）', Array.isArray(calls[0].body.subject_reference)
    && calls[0].body.subject_reference.length === 0, JSON.stringify(calls[0].body.subject_reference));

  /* ---------- 7. 回包解析 ---------- */
  installFetch(OK_B64);
  const url1 = await mm.generate(cfg(), 'x');
  check('image_base64 → jpeg dataURL', url1 === 'data:image/jpeg;base64,AAAA', url1);

  installFetch(() => jsonRes(200, { data: { image_base64: ['iVBORw0KGgo='] }, base_resp: { status_code: 0 } }));
  const url2 = await mm.generate(cfg(), 'x');
  check('PNG 前缀 → image/png dataURL', url2 === 'data:image/png;base64,iVBORw0KGgo=', url2);

  installFetch(() => jsonRes(200, { data: { image_urls: ['https://cdn/x.jpg'] }, base_resp: { status_code: 0 } }));
  const url3 = await mm.generate(cfg(), 'x');
  check('image_urls → 原样返回 URL', url3 === 'https://cdn/x.jpg', url3);

  /* ---------- 8. 业务失败（HTTP 200 也要看 base_resp） ---------- */
  installFetch(() => jsonRes(200, { data: {}, base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }));
  let err = '';
  try { await mm.generate(cfg(), 'x'); } catch (e) { err = e.message; }
  check('base_resp 1008 → 提示余额不足', /1008/.test(err) && /余额不足/.test(err), err);

  installFetch(() => jsonRes(200, { data: {}, metadata: { failed_count: '1' }, base_resp: { status_code: 0 } }));
  err = '';
  try { await mm.generate(cfg(), 'x'); } catch (e) { err = e.message; }
  check('没返回图片 + failed_count → 提示内容安全拦截', /内容安全/.test(err), err);

  installFetch(() => jsonRes(500, { error: 'boom' }));
  err = '';
  try { await mm.generate(cfg(), 'x'); } catch (e) { err = e.message; }
  check('HTTP 500 → 抛错带上状态码', /HTTP 500/.test(err), err);

  installFetch(() => new TypeError('Failed to fetch'));
  err = '';
  try { await mm.generate(cfg(), 'x'); } catch (e) { err = e.message; }
  check('TypeError → 提示 CORS 与本地转发', /CORS/.test(err) && /video-proxy/.test(err), err);

  /* ---------- 9. 缺配置 ---------- */
  err = '';
  try { await mm.generate(cfg({ apiKey: '' }), 'x'); } catch (e) { err = e.message; }
  check('没填 Key → 直接拦下（不发请求）', /Key/.test(err), err);

  err = '';
  try { await mm.generate(cfg(), '   '); } catch (e) { err = e.message; }
  check('空提示词 → 直接拦下', /提示词/.test(err), err);

  /* ---------- 10. test()：只读探测，绝不出图 ---------- */
  installFetch(() => jsonRes(405, { base_resp: { status_code: 0 } }));
  const t1 = await mm.test(cfg());
  check('test 用 GET 探测 /v1/image_generation（不 POST）',
    calls.length === 1 && calls[0].method === 'GET' && calls[0].url === 'https://api.minimaxi.com/v1/image_generation',
    JSON.stringify(calls.map(c => c.method + ' ' + c.url)));
  check('test 探测 405 也算可达（warn，不报错）', t1.level === 'warn' && /可达/.test(t1.message), t1.message);

  installFetch(() => new TypeError('Failed to fetch'));
  const t2 = await mm.test(cfg());
  check('test 遇 CORS → fail 并提示本地转发',
    t2.level === 'fail' && /video-proxy/.test(t2.message), t2.message);

  installFetch(OK_B64);
  const t3 = await mm.test(cfg({ apiKey: '' }));
  check('test 没填 Key → fail 且不发请求', t3.level === 'fail' && calls.length === 0, t3.message);

  /* ---------- 汇总 ---------- */
  const fails = results.filter(r => !r.hit);
  for (const r of fails) console.error('❌ ' + r.name + (r.detail ? '（实际：' + r.detail + '）' : ''));
  if (fails.length) {
    console.error('minimax-image-test：' + fails.length + ' / ' + results.length + ' 项失败');
    process.exit(1);
  }
  console.log('✅ minimax-image-test：' + results.length + ' 项全部通过（MiniMax image-01 / image-01-live 适配器）');
})();
