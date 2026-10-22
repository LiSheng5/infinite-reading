#!/usr/bin/env node
'use strict';
/*
 * tools/video-proxy.mjs —— 生视频的最小本地转发（零依赖，只监听 127.0.0.1）
 *
 * 背景（2026-10-22 实测）：MiniMax 两个域名的响应都不带 Access-Control-Allow-*，
 * 浏览器直连被 CORS 拦（预检与查询都不通过）。这是用户拍板的最小绕行方案：
 *   浏览器把「设置 → 生视频模型 → 接口地址」填成本机地址（默认 http://127.0.0.1:4320），
 *   请求经这里原样转发到 MiniMax，回包补上 CORS 头。
 *
 * 边界（刻意做小）：
 *   - 不改 sidecar（可选本地服务照旧零改动）；
 *   - 只放行 MiniMax 两个域名（api.minimax.io / api.minimaxi.com），上游启动时定死，防 SSRF；
 *   - 下载 mp4 不走这里：仍按应用内「下载失败 → remoteUrl 限时链接 + 新标签页打开」降级；
 *   - 只监听 127.0.0.1；只放行 GET / POST / OPTIONS。
 *
 * 用法：
 *   node tools/video-proxy.mjs [端口=4320] [上游=https://api.minimax.io]
 *   npm 运行也行：node tools/video-proxy.mjs 4320 https://api.minimaxi.com
 */
import http from 'node:http';
import https from 'node:https';

const ALLOWED_HOSTS = new Set(['api.minimax.io', 'api.minimaxi.com']);
const DEFAULT_PORT = 4320;
const DEFAULT_UPSTREAM = 'https://api.minimax.io';

// 逐跳头（不转发）；host 单独处理：转发时换成上游的 host
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-Requested-With',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function parseArgs(argv) {
  const port = parseInt(argv[2], 10);
  const upstreamRaw = argv[3] || process.env.VIDEO_PROXY_UPSTREAM || DEFAULT_UPSTREAM;
  let upstream = null;
  try { upstream = new URL(upstreamRaw); } catch (_) {
    console.error('上游地址不是合法 URL：' + upstreamRaw);
    process.exit(1);
  }
  if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
    console.error('上游只支持 http / https：' + upstreamRaw);
    process.exit(1);
  }
  if (!ALLOWED_HOSTS.has(upstream.hostname)) {
    console.error('上游只放行 MiniMax 两个域名（api.minimax.io / api.minimaxi.com）：' + upstream.hostname);
    process.exit(1);
  }
  return {
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    upstream: upstream,
  };
}

function forward(req, res, upstream, cors) {
  // 路径原样转发；忽略客户端的绝对 URI / Host —— 只走启动时定死的上游
  let target = null;
  try { target = new URL(req.url, upstream.origin); } catch (_) {
    res.writeHead(400, cors);
    res.end('路径不合法');
    return;
  }
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = String(k).toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    headers[k] = v;
  }

  const upstreamReq = lib.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    method: req.method,
    path: target.pathname + target.search,
    headers: headers,
  }, (upstreamRes) => {
    const out = {};
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      const lk = String(k).toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      out[k] = v;
    }
    Object.assign(out, cors);   // 补 CORS 头（原样带上其它头，gzip 等透明）
    res.writeHead(upstreamRes.statusCode || 502, out);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, cors);
    res.end('转发失败：' + err.message);
  });
  req.pipe(upstreamReq);
}

const { port, upstream } = parseArgs(process.argv);

const server = http.createServer((req, res) => {
  const cors = corsHeaders(req.headers.origin || '');

  if (req.method === 'OPTIONS') {
    // 预检不转发，直接放行（浏览器关心的只是这些头）
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
    res.writeHead(405, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, cors));
    res.end('只放行 GET / POST / OPTIONS');
    return;
  }
  forward(req, res, upstream, cors);
});

server.listen(port, '127.0.0.1', () => {
  console.log('生视频本地转发已启动（零依赖 · 只监听 127.0.0.1）');
  console.log('  本机入口：  http://127.0.0.1:' + port);
  console.log('  上游：      ' + upstream.origin + '（只放行 MiniMax 两个域名）');
  console.log('  使用：      「设置 → 生视频模型 → 接口地址」填 http://127.0.0.1:' + port + '，模型名 / API Key 照旧');
  console.log('  下载 mp4：  不走这里（浏览器拿 content.url，失败走 remoteUrl 限时链接降级）');
  console.log('  Ctrl+C 停止');
});
