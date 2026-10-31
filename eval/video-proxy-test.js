#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 生视频/生图本地转发门禁（tools/video-proxy.mjs）
 *
 * 这个脚本平时只被人手工 `node tools/video-proxy.mjs` 拉起，出问题最常见的是三类：
 * 参数解析吃掉用户填的地址、端口被占用时裸堆栈崩溃、转发没有超时与断开清理。
 * 这里把三类都钉住（全离线，上游用本进程里的桩服务器顶替）：
 *   1. parseArgs：支持「只给上游 URL」（第一个参数不是端口数字就按上游解析）；
 *      显式给了非法端口要报错，不再静默回落 4320；白名单与协议校验照旧。
 *   2. 端口被占用（EADDRINUSE）：真起子进程验——退出码 1 + 可读提示，不许裸堆栈。
 *   3. 主入口接线：真起子进程验启动横幅里的端口与上游（4320 被占时换空闲端口）。
 *   4. 客户端中途断开：在途的上游请求要被掐掉（桩服务器能看到连接收尾）；
 *      上游响应中途断流要接住，不许把进程整个带崩（pipe 不转发错误，必须自己接）。
 *   5. 静态：空闲超时与 error 兜底在位；主入口判据保证 import 本模块不起服务。
 *
 * 跑法：node eval/video-proxy-test.js（任一不过 → 退出码 1）
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const H = require('./_harness.js');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'tools', 'video-proxy.mjs');
const SRC = fs.readFileSync(SCRIPT, 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}
function withTimeout(p, ms, what) {
  return Promise.race([p, sleep(ms).then(() => { throw new Error('等不到：' + what); })]);
}
function readStream(stream) {
  let buf = '';
  stream.on('data', d => { buf += String(d); });
  return () => buf;
}
function listen(server, port) {
  return withTimeout(new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', rej); res(); });
  }), 5000, 'listen ' + port);
}
function closeServer(server) {
  return new Promise(res => {
    server.close(res);
    // 清理段的用例可能遗留 keep-alive 连接（比如中途抛错的客户端），close 的回调要等
    // 连接全断才来——强制掐掉，别让门禁本身悬挂
    if (server.closeAllConnections) server.closeAllConnections();
  });
}

/* 1. parseArgs：只给 URL / 都给 / 都不给 / 非法输入 ---------------- */
async function testParseArgs(P) {
  const only = P(['node', 'video-proxy.mjs', 'https://api.minimaxi.com']);
  H.check('parseArgs：只给上游 URL → 上游生效（旧实现静默丢成默认域名）',
    only.upstream.hostname === 'api.minimaxi.com', only.upstream && only.upstream.hostname);
  H.check('parseArgs：只给上游 URL → 端口用默认 4320', only.port === 4320, only.port);

  const both = P(['node', 'video-proxy.mjs', '5000', 'https://api.minimaxi.com']);
  H.check('parseArgs：端口 + 上游照旧', both.port === 5000 && both.upstream.hostname === 'api.minimaxi.com',
    both.port + ' ' + (both.upstream && both.upstream.hostname));

  const none = P(['node', 'video-proxy.mjs']);
  H.check('parseArgs：不给参数 → 默认端口 + 默认上游',
    none.port === 4320 && none.upstream.hostname === 'api.minimax.io',
    none.port + ' ' + (none.upstream && none.upstream.hostname));

  const envSaved = process.env.VIDEO_PROXY_UPSTREAM;
  try {
    process.env.VIDEO_PROXY_UPSTREAM = 'https://api.minimaxi.com';
    const viaEnv = P(['node', 'video-proxy.mjs', '5001']);
    H.check('parseArgs：环境变量指定上游仍然可用',
      viaEnv.port === 5001 && viaEnv.upstream.hostname === 'api.minimaxi.com');
  } finally {
    if (envSaved === undefined) delete process.env.VIDEO_PROXY_UPSTREAM;
    else process.env.VIDEO_PROXY_UPSTREAM = envSaved;
  }

  const boom = argv => {
    try { P(argv); return ''; } catch (e) { return e.message; }
  };
  H.check('parseArgs：显式非法端口报错（不再静默回落 4320）',
    /端口不合法/.test(boom(['node', 'x', '0'])) && /端口不合法/.test(boom(['node', 'x', '99999']))
    && /端口不合法/.test(boom(['node', 'x', '-1'])),
    boom(['node', 'x', '0']) + ' / ' + boom(['node', 'x', '99999']));
  H.check('parseArgs：上游不在白名单照旧拒绝', /只放行/.test(boom(['node', 'x', 'https://evil.com'])),
    boom(['node', 'x', 'https://evil.com']));
  H.check('parseArgs：非 URL 的第一参数报错而不是被当端口吞掉', /合法 URL/.test(boom(['node', 'x', 'abc'])),
    boom(['node', 'x', 'abc']));
}

/* 2. EADDRINUSE：真起子进程，端口先被占住 ---------------- */
function spawnProxy(args) {
  return spawn(process.execPath, [SCRIPT].concat(args), { cwd: ROOT });
}

async function testPortInUse() {
  const occupier = net.createServer(() => {});
  await listen(occupier, 0);
  const port = occupier.address().port;
  try {
    const child = spawnProxy([String(port)]);
    const getErr = readStream(child.stderr);
    const code = await withTimeout(new Promise(res => child.on('exit', res)), 10000, '子进程退出');
    const err = getErr();
    H.check('占用端口：退出码 1', code === 1, 'exit=' + code);
    H.check('占用端口：给的是可读提示，不是裸堆栈',
      err.indexOf('已被占用') >= 0 && err.indexOf('EADDRINUSE') < 0, err.slice(0, 200));
  } finally {
    await closeServer(occupier);
  }
}

/* 3. 主入口接线：横幅里必须是用户填的上游 ---------------- */
async function testMainBanner() {
  // 4320 被占（比如用户自己开着转发）时换空闲端口、走「端口 + 上游」形态验同样的接线；
  // 「只给 URL」的解析本身已由 parseArgs 用例钉住
  let args = ['https://api.minimaxi.com'];
  let wantPort = '4320';
  const probe = net.createServer(() => {});
  const port4320Free = await listen(probe, 4320).then(() => true, () => false);
  await closeServer(probe);
  if (!port4320Free) { args = ['4555', 'https://api.minimaxi.com']; wantPort = '4555'; }

  const child = spawnProxy(args);
  const getOut = readStream(child.stdout);
  const getErr = readStream(child.stderr);
  const bannerInTime = await waitFor(() => getOut().indexOf('本机入口') >= 0, 5000);
  H.check('主入口：服务照常起来（横幅出现）', bannerInTime, getErr().slice(0, 200));
  if (bannerInTime) {
    H.check('主入口：横幅上游 = 用户填的域名（旧实现会静默变成默认域名）',
      getOut().indexOf('https://api.minimaxi.com') >= 0, getOut());
    H.check('主入口：横幅端口 = 期望值', getOut().indexOf('http://127.0.0.1:' + wantPort) >= 0, getOut());
  }
  child.kill();
  await withTimeout(new Promise(res => child.on('exit', res)), 5000, '子进程退出');
}

/* 4. 客户端断开 / 上游断流的清理（桩上游，进程内真服务） ---------------- */
async function testForwardCleanup(createServer) {
  // 桩上游：默认发一个头 + 一块数据后挂住不结束；stubResetNext 置位时回完头再掐 socket
  //（先 flushHeaders 并留出余量，保证代理侧已经建起响应流、断流走的是响应的 error）
  let stubClosed = false, stubEnded = true, stubResetNext = false;
  const stub = http.createServer((req, res) => {
    stubClosed = false; stubEnded = false;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('x');
    if (stubResetNext) {
      stubResetNext = false;
      res.flushHeaders();
      setTimeout(() => res.socket.destroy(), 150);
      return;
    }
    req.on('close', () => { stubClosed = true; stubEnded = res.writableEnded; });
  });
  await listen(stub, 0);
  const stubPort = stub.address().port;

  const proxy = createServer({
    protocol: 'http:', hostname: '127.0.0.1', port: String(stubPort),
    origin: 'http://127.0.0.1:' + stubPort,
  });
  let proxyCrashed = null;
  proxy.on('error', e => { proxyCrashed = e; });   // 只是兜住意外，正常路径不该触发
  await listen(proxy, 0);
  const proxyPort = proxy.address().port;

  try {
    // ① 客户端拿到第一块数据后立刻断开：转发必须掐掉在途的上游请求
    const clientReq = http.get('http://127.0.0.1:' + proxyPort + '/v1/test?x=1');
    clientReq.on('error', () => {});   // 客户端主动 destroy 的那次报错不用管
    const resp = await withTimeout(new Promise(res => clientReq.on('response', res)), 5000, '上游响应头');
    await withTimeout(new Promise(res => resp.on('data', res)), 5000, '上游数据');
    clientReq.destroy();
    const cleaned = await waitFor(() => stubClosed, 2000);
    H.check('断开清理：客户端断开后上游请求被掐掉', cleaned,
      cleaned ? '' : '桩上游 2s 内没看到连接收尾（旧实现会一直挂着）');
    H.check('断开清理：掐的是在途请求（桩的响应没交还完）', !stubEnded, 'writableEnded=' + stubEnded);
    H.check('断开清理：转发进程没被带崩', proxyCrashed === null, proxyCrashed && proxyCrashed.message);

    // ② 上游中途断流：要接住并以错误收尾，不许把进程整个带崩
    //（实测断流错误发在响应对象上，请求对象上也要挂——两条路都算收尾）
    stubResetNext = true;
    let sawClientError = false;
    const seeError = () => { sawClientError = true; };
    const c2 = http.get('http://127.0.0.1:' + proxyPort + '/v1/test');
    c2.on('error', seeError);
    c2.on('aborted', seeError);
    c2.on('response', r => { r.on('error', seeError); r.on('aborted', seeError); });
    H.check('上游断流：客户端侧请求以错误收尾', await waitFor(() => sawClientError, 3000));
    H.check('上游断流：转发进程没崩（pipe 的错误必须自己接）',
      proxyCrashed === null, proxyCrashed && proxyCrashed.message);
  } finally {
    await closeServer(proxy);
    await closeServer(stub);
  }
}

async function main() {
  /* 5. 静态：清理三件套与主入口判据在位 */
  H.check('静态：上游空闲超时在位（upstreamReq.setTimeout）',
    SRC.indexOf('upstreamReq.setTimeout(') >= 0 && SRC.indexOf('UPSTREAM_IDLE_TIMEOUT_MS') >= 0);
  H.check('静态：客户端断开 / 上游断流的清理在位',
    SRC.indexOf("res.on('close'") >= 0 && SRC.indexOf("upstreamRes.on('error'") >= 0);
  H.check('静态：listen 有 error 兜底（EADDRINUSE 不裸崩）', SRC.indexOf("server.on('error'") >= 0);
  H.check('静态：主入口判据在位（被 import 时不起服务）',
    SRC.indexOf('runningAsMain') >= 0 && SRC.indexOf('if (runningAsMain()) main()') >= 0);

  /* import 本模块：主入口判据生效时这是无副作用的（起服务的话进程会一直挂着、端口被占） */
  const mod = await import(pathToFileURL(SCRIPT).href);
  H.check('模块：导出面可用（parseArgs / createProxyServer）',
    typeof mod.parseArgs === 'function' && typeof mod.createProxyServer === 'function');

  await testParseArgs(mod.parseArgs);
  await testPortInUse();
  await testMainBanner();
  await testForwardCleanup(mod.createProxyServer);
}

H.run('生视频本地转发门禁', main);
