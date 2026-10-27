/*
 * 无限阅读 · Service Worker（开源路线图 W3 / L2「可安装」）
 *
 * 只做「离线可用 + 可安装」，不改写任何请求：
 *   - install 时预缓存「外壳」：CORE（入口三件套）+ PRECACHE（构建期注入的产物清单）
 *     0.12.1 的做法是从 index.html 里正则解析 `(css|js|icons)/…` 的资源链接——阶段 1 接入
 *     Vite 后产物文件名带内容 hash（assets/index-xxxx.js），正则与真实文件名脱节，任务书 §4
 *     点名这个坑：预缓存清单改为**构建期生成**（vite.config.mjs 的 irSiteShell 在产出 dist/site
 *     后按磁盘真实文件名注入 PRECACHE），不再是运行时猜测。
 *   - 导航请求（打开页面）：网络优先，断网回退到预缓存的 index.html
 *     （网络优先是为了让更新永远不被缓存卡住——这类项目最容易死在「改了没生效」上）
 *   - 同源静态资源：缓存优先 + 后台静默更新（stale-while-revalidate）
 *   - 跨域请求（对话 / 生图 API、字体 CDN）：一律不缓存、直接放行 —— 密钥与剧情绝不进缓存
 *   - 非 GET 请求：不碰
 *
 * 缓存策略定案（阶段 1c）：四条语义与 0.12.1 **完全一致**，唯一变化是预缓存清单的来源。
 * 「用户卡旧版」的风险全在导航请求上——导航保持网络优先、绝不缓存优先；hash 文件名本身
 * 就是失效开关（内容变 → 文件名变 → 老缓存自然不再被引用），SWR 对它无害。
 * 本变更为 Service Worker 唯一改动点，随本版本**单独上线、观察一个版本周期**后再继续阶段 2（任务书 §11）。
 *
 * CACHE 名里的版本号由 tools/sync-version.mjs 从根目录 VERSION 注入（别手改）：
 * 版本一变 → 新缓存 → 旧的整批删掉，等价于「跟着发布节奏清缓存」。
 */
const CACHE = 'ir-v0.12.1';

const CORE = ['./', './index.html', './manifest.webmanifest'];

// 预缓存清单：构建期由 vite.config.mjs 用 dist/site 的真实产物文件名注入（含内容 hash）。
// 未注入的源码形态（直接拿仓库根起服务）就只预缓存 CORE 外壳，其余靠 SWR 慢慢攒。
const PRECACHE = [];

async function precache(cache) {
  for (const url of CORE.concat(PRECACHE)) {
    await cache.add(url).catch(() => {});            // 单个失败不影响整体
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await precache(await caches.open(CACHE));
    await self.skipWaiting();                        // 预缓存完再接管，别让旧 SW 卡住新版本
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();                      // 已打开的页面也归新 SW 管
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) {
    fetch(request).then(res => { if (res && res.ok) cache.put(request, res.clone()); }).catch(() => {});
    return hit;
  }
  const res = await fetch(request);
  if (res && res.ok && res.type === 'basic') cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;   // 跨域（API / 字体）：放行，不缓存

  event.respondWith(req.mode === 'navigate' ? networkFirst(req) : cacheFirst(req));
});
