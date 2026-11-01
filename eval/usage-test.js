#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 每回合 token 用量门禁（不联网、不开浏览器）
 *
 * 守四件事：
 *   1. normalizeUsage：各家字段名都能认；没上报 → null（不拿 0 冒充）；
 *   2. mergeUsage：一回合多次请求逐项相加；
 *   3. 适配器：非流式读 data.usage；流式请求带 stream_options.include_usage，并取末尾那包 usage；
 *   4. 不认 stream_options 的服务商（400 点名它）→ 去掉后重发一次，回合照常；
 *      用户在自定义参数里自己写了 stream_options 则不覆盖。
 *
 * 用法：node eval/usage-test.js
 */
const path = require('path');
const H = require('./_harness.js');
const ROOT = path.join(__dirname, '..');
const { ChatProviders, normalizeUsage, mergeUsage } = require(path.join(ROOT, 'src', 'core', 'providers.ts'));
const chat = ChatProviders['openai-compatible'].chat;
const CFG = { baseUrl: 'https://api.invalid/v1', apiKey: 'k', model: 'm', temperature: 0.7 };

function sse(lines) {
  const enc = new TextEncoder();
  const body = lines.map(l => 'data: ' + (typeof l === 'string' ? l : JSON.stringify(l)) + '\n\n').join('');
  return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(body)); c.close(); } }), { status: 200 });
}
const delta = (t) => ({ choices: [{ delta: { content: t } }] });

async function main() {
  // 1. 归一
  let u = normalizeUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
  H.check('OpenAI 字段名', u && u.prompt === 120 && u.completion === 30 && u.total === 150, JSON.stringify(u));
  u = normalizeUsage({ input_tokens: 7, output_tokens: 3 });
  H.check('input/output 字段名；total 缺省 = 相加', u && u.prompt === 7 && u.completion === 3 && u.total === 10, JSON.stringify(u));
  u = normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 64,
    completion_tokens_details: { reasoning_tokens: 12 } });
  H.check('缓存命中（DeepSeek 口径）与思考 token', u && u.cached === 64 && u.reasoning === 12, JSON.stringify(u));
  u = normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } });
  H.check('缓存为 0 不带字段', u && !('cached' in u), JSON.stringify(u));
  H.check('没上报 → null', normalizeUsage(null) === null && normalizeUsage({}) === null && normalizeUsage('x') === null);
  H.check('非法数值不收（负数 / 字符串垃圾）', normalizeUsage({ prompt_tokens: -1, completion_tokens: 'abc' }) === null);

  // 2. 合并
  const m = mergeUsage({ prompt: 100, completion: 10, total: 110, cached: 50 }, { prompt: 40, completion: 5, total: 45, reasoning: 2 });
  H.check('逐项相加', m.prompt === 140 && m.completion === 15 && m.total === 155 && m.cached === 50 && m.reasoning === 2, JSON.stringify(m));
  H.check('一方为空取另一方', mergeUsage(null, m) === m && mergeUsage(m, null) === m && mergeUsage(null, null) === null);

  // 3a. 非流式
  const realFetch = global.fetch;
  try {
    let got = null;
    global.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const text = await chat(CFG, [{ role: 'user', content: 'x' }], { onUsage: (x) => { got = x; } });
    H.check('非流式：读 data.usage', text === 'hi' && got && got.total === 13, JSON.stringify(got));

    // 3b. 流式：请求体带 include_usage，末尾包解析
    let sentBody = null; got = null;
    global.fetch = async (url, init) => {
      sentBody = JSON.parse(init.body);
      return sse([delta('你'), delta('好'), { choices: [], usage: { prompt_tokens: 50, completion_tokens: 4 } }, '[DONE]']);
    };
    let shown = '';
    const t2 = await chat(CFG, [{ role: 'user', content: 'x' }], { onDelta: (p) => { shown += p; }, onUsage: (x) => { got = x; } });
    H.check('流式：请求体带 stream_options.include_usage',
      sentBody.stream === true && sentBody.stream_options && sentBody.stream_options.include_usage === true, JSON.stringify(sentBody.stream_options));
    H.check('流式：正文不受影响', t2 === '你好' && shown === '你好', t2);
    H.check('流式：取末尾 usage 包', got && got.prompt === 50 && got.completion === 4 && got.total === 54, JSON.stringify(got));

    // 3c. 流式但服务商不回 usage：不报错、不触发 onUsage
    got = 'untouched';
    global.fetch = async () => sse([delta('a'), '[DONE]']);
    const t3 = await chat(CFG, [], { onDelta() {}, onUsage: (x) => { got = x; } });
    H.check('服务商不上报 → onUsage 不被调用', t3 === 'a' && got === 'untouched', String(got));

    // 4a. 不认 stream_options → 去掉重发一次
    const bodies = [];
    global.fetch = async (url, init) => {
      const b = JSON.parse(init.body); bodies.push(b);
      if (b.stream_options) return new Response('{"error":{"message":"Unknown parameter: stream_options"}}', { status: 400 });
      return sse([delta('ok'), '[DONE]']);
    };
    const t4 = await chat(CFG, [], { onDelta() {} });
    H.check('400 点名 stream_options → 去掉后重发成功', t4 === 'ok' && bodies.length === 2 && !bodies[1].stream_options, JSON.stringify(bodies.map(b => !!b.stream_options)));

    // 4b. 与 stream_options 无关的 400 → 照常抛错，不重发
    bodies.length = 0;
    global.fetch = async (url, init) => { bodies.push(1); return new Response('{"error":{"message":"invalid model"}}', { status: 400 }); };
    let err = null;
    try { await chat(CFG, [], { onDelta() {} }); } catch (e) { err = e; }
    H.check('无关 400 不重发、照常报错', err && /400/.test(err.message) && bodies.length === 1, err && err.message);

    // 4c. 用户自己写了 stream_options → 不覆盖
    sentBody = null;
    global.fetch = async (url, init) => { sentBody = JSON.parse(init.body); return sse([delta('z'), '[DONE]']); };
    await chat(Object.assign({}, CFG, { extraParams: 'stream_options.include_usage=false' }), [], { onDelta() {} });
    H.check('自定义参数里的 stream_options 优先', sentBody.stream_options && sentBody.stream_options.include_usage === false, JSON.stringify(sentBody.stream_options));
  } finally {
    global.fetch = realFetch;
  }
}

H.run('每回合 token 用量', main);
