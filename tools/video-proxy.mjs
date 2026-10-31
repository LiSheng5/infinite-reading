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
 * 用法（端口 / 上游都可省，也可以只给上游 URL）：
 *   node tools/video-proxy.mjs                               # 端口 4320 + 上游 api.minimax.io
 *   node tools/video-proxy.mjs 5000                          # 换端口
 *   node tools/video-proxy.mjs https://api.minimaxi.com      # 只给上游（国内域名）
 *   node tools/video-proxy.mjs 5000 https://api.minimaxi.com # 都给
 *   上游也可用环境变量 VIDEO_PROXY_UPSTREAM 指定（命令行参数优先）。
 *
 * 导出面（parseArgs / createProxyServer）只供 eval/video-proxy-test.js 在本进程内起
 * 真实服务用：主入口判据保证被 import 时不会顺带起服务；ALLOWED_HOSTS 是防 SSRF 的
 * 唯一闸门，只在 parseArgs 里校验、不导出（生产与测试路径都不改它）。
 */
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

const ALLOWED_HOSTS = new Set(['api.minimax.io', 'api.minimaxi.com']);
const DEFAULT_PORT = 4320;
const DEFAULT_UPSTREAM = 'https://api.minimax.io';
// 上游空闲超时：出图 / 生视频的等待可能要几分钟，取 5 分钟，且只掐「这么久一个字节都没有」
// 的死连接（socket 有数据流动就一直重置、不触发）；别比应用侧的请求超时（生图 3 分钟 /
// 视频下载 5 分钟）还短，否则代理会先把客户端还在等的请求掐掉。
const UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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
  // 两种用法：[端口] [上游] / [上游]（只给上游时端口用默认值）。
  // 第一个参数不是端口数字就按上游 URL 解析——以前 parseInt 把 URL 读成 NaN 后静默回落
  // 4320，argv[3] 又是空 → 上游也被静默丢成默认域名，用户填的地址完全没生效还不报错。
  let portRaw = argv[2];
  let upstreamRaw = argv[3] || process.env.VIDEO_PROXY_UPSTREAM || '';
  if (portRaw !== undefined && !/^[-+]?\d+$/.test(String(portRaw))) {
    upstreamRaw = String(portRaw);
    portRaw = undefined;
  }
  if (!upstreamRaw) upstreamRaw = DEFAULT_UPSTREAM;

  let port = DEFAULT_PORT;
  if (portRaw !== undefined) {
    port = parseInt(portRaw, 10);
    // 显式给了端口就别再静默回落默认值：想要的端口起不上，宁可不启动
    if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
      throw new Error('端口不合法（1-65535）：' + portRaw);
    }
  }

  let upstream = null;
  try { upstream = new URL(upstreamRaw); } catch (_) {
    throw new Error('上游地址不是合法 URL：' + upstreamRaw);
  }
  if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
    throw new Error('上游只支持 http / https：' + upstreamRaw);
  }
  if (!ALLOWED_HOSTS.has(upstream.hostname)) {
    throw new Error('上游只放行 MiniMax 两个域名（api.minimax.io / api.minimaxi.com）：' + upstream.hostname);
  }
  return { port: port, upstream: upstream };
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

  // 这条转发是否已收尾（上游响应交还完毕 / 已失败 / 任一侧断开）：收尾后不再重复清理。
  // res 的 'close' 在正常交还完毕后也会触发，那时 settled 已置位、清理分支不会进。
  let settled = false;
  let failStatus = 502;

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
    upstreamRes.on('end', () => { settled = true; });
    // pipe 不转发错误：上游中途断流不接住就是整个进程崩掉（unhandled 'error' event）
    upstreamRes.on('error', () => {
      settled = true;
      try { res.destroy(); } catch (_) { /* 连接已经没了 */ }
    });
  });

  upstreamReq.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
    failStatus = 504;
    upstreamReq.destroy(new Error('上游 ' + (UPSTREAM_IDLE_TIMEOUT_MS / 60000) + ' 分钟没有任何数据'));
  });

  upstreamReq.on('error', (err) => {
    settled = true;
    try {
      if (!res.headersSent) res.writeHead(failStatus, cors);
      res.end('转发失败：' + err.message);
    } catch (_) { /* 客户端连接已经没了，无从回包 */ }
  });

  // 浏览器先断了（关页 / 取消 / 前端超时）：掐掉在途的上游请求，别让它空跑占住连接
  res.on('close', () => {
    if (!settled) {
      settled = true;
      upstreamReq.destroy(new Error('客户端已断开'));
    }
  });
  req.on('error', () => {
    if (!settled) {
      settled = true;
      upstreamReq.destroy(new Error('客户端请求出错'));
    }
  });

  req.pipe(upstreamReq);
}

function createProxyServer(upstream) {
  return http.createServer((req, res) => {
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
}

function runningAsMain() {
  if (!process.argv[1]) return false;
  let href = null;
  try { href = pathToFileURL(process.argv[1]).href; } catch (_) { return false; }
  if (import.meta.url === href) return true;
  // Windows 的盘符 / 目录大小写随敲法变，路径按大小写折叠后再对一次
  return /^file:/i.test(import.meta.url) && import.meta.url.toLowerCase() === href.toLowerCase();
}

function main() {
  let cfg = null;
  try {
    cfg = parseArgs(process.argv);
  } catch (e) {
    console.error(e.message);
    console.error('用法：node tools/video-proxy.mjs [端口=4320] [上游=https://api.minimax.io]，也可以只给上游 URL');
    process.exit(1);
  }
  const server = createProxyServer(cfg.upstream);
  // 没有这条兜底：端口被占用（EADDRINUSE）会带着整段堆栈崩掉，看起来像程序坏了
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('端口 ' + cfg.port + ' 已被占用——多半已经开着一个转发进程，先关掉它或者换一个端口。');
    } else {
      console.error('转发服务出错：' + ((err && err.stack) || err));
    }
    process.exit(1);
  });
  server.listen(cfg.port, '127.0.0.1', () => {
    console.log('MiniMax 本地转发已启动（生图 / 生视频共用 · 零依赖 · 只监听 127.0.0.1）');
    console.log('  本机入口：  http://127.0.0.1:' + cfg.port);
    console.log('  上游：      ' + cfg.upstream.origin + '（只放行 MiniMax 两个域名）');
    console.log('  使用：      「设置 → 生图 / 生视频模型 → 接口地址」填 http://127.0.0.1:' + cfg.port + '，模型名 / API Key 照旧');
    console.log('  下载 mp4：  不走这里（浏览器拿 content.url，失败走 remoteUrl 限时链接降级）');
    console.log('  Ctrl+C 停止');
  });
}

export { parseArgs, createProxyServer };

if (runningAsMain()) main();
