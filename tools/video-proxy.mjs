#!/usr/bin/env node
'use strict';
/*
 * tools/video-proxy.mjs —— MiniMax 的最小本地转发（零依赖，只监听 127.0.0.1）
 *
 * 背景（2026-10-22 实测）：MiniMax 两个域名的响应都不带 Access-Control-Allow-*，
 * 浏览器直连被 CORS 拦（预检与查询都不通过）。这是用户拍板的最小绕行方案：
 *   浏览器把「设置 → 生视频模型 / 生图模型 → 接口地址」填成本机地址（默认 http://127.0.0.1:4320），
 *   请求经这里原样转发到 MiniMax，回包补上 CORS 头。
 * 转发是按路径原样转的纯管道，所以**生图（POST /v1/image_generation）与生视频走同一个进程**，
 * 不需要第二个服务；文件名沿用 video-proxy 以免打断已有的命令 / 文档 / 快捷方式。
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

// 只回显本机来源（file:// 的 Origin 是字面量 "null"；本地服务是 localhost / 127.0.0.1），
// 其它来源一律不给 CORS 头，浏览器自然拦截——防任意网页借本机代理读响应
function isLocalOrigin(origin) {
  if (!origin || origin === 'null') return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
}

function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-Requested-With',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (!origin) h['Access-Control-Allow-Origin'] = '*';
  else if (isLocalOrigin(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
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
  // 只按路径转发，请求目标一律钉死为启动时定死的上游。
  // 不能信任 req.url 的绝对形式（GET http://evil/x）或协议相对形式（//evil.com/x）——
  // URL 解析会把它们变成任意主机，那就是 SSRF / 开放代理；解析后强制校验与上游同源。
  let target = null;
  try { target = new URL(req.url, upstream.origin); } catch (_) {
    res.writeHead(400, cors);
    res.end('路径不合法');
    return;
  }
  if (target.origin !== upstream.origin) {
    res.writeHead(403, cors);
    res.end('只允许转发到启动时定死的上游');
    return;
  }
  const isHttps = upstream.protocol === 'https:';
  const lib = isHttps ? https : http;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = String(k).toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    headers[k] = v;
  }

  const upstreamReq = lib.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (isHttps ? 443 : 80),
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
  console.log('MiniMax 本地转发已启动（生图 / 生视频共用 · 零依赖 · 只监听 127.0.0.1）');
  console.log('  本机入口：  http://127.0.0.1:' + port);
  console.log('  上游：      ' + upstream.origin + '（只放行 MiniMax 两个域名）');
  console.log('  使用：      「设置 → 生图 / 生视频模型 → 接口地址」填 http://127.0.0.1:' + port + '，模型名 / API Key 照旧');
  console.log('  下载 mp4：  不走这里（浏览器拿 content.url，失败走 remoteUrl 限时链接降级）');
  console.log('  Ctrl+C 停止');
});
