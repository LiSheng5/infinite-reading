/*
 * 无限阅读 · Service Worker（开源路线图 W3 / L2「可安装」）
 *
 * 只做「离线可用 + 可安装」，不改写任何请求：
 *   - install 时预缓存「外壳」：index.html 本身，加上从它里面解析出的带 ?v= 的 CSS / JS / 图标
 *     （不写死资源清单：版本串由 index.html 决定，改了自然跟上，也就不会出现清单与页面不一致）
 *   - 导航请求（打开页面，含 ?demo=1）：网络优先，断网回退到预缓存的 index.html
 *     （网络优先是为了让更新永远不被缓存卡住——这类项目最容易死在「改了没生效」上）
 *   - 同源静态资源：缓存优先 + 后台静默更新（stale-while-revalidate）
 *   - 跨域请求（对话 / 生图 API、字体 CDN）：一律不缓存、直接放行 —— 密钥与剧情绝不进缓存
 *   - 非 GET 请求：不碰
 *
 * CACHE 名里的版本号由 tools/sync-version.mjs 从根目录 VERSION 注入（别手改）：
 * 版本一变 → 新缓存 → 旧的整批删掉，等价于「跟着发布节奏清缓存」。
 */
const CACHE = 'ir-v0.5.0';

const CORE = ['./', './index.html', './manifest.webmanifest'];

// 从 index.html 里抽出所有本地资源（含 ?v=），照着缓存——清单就在页面里，不用维护第二份
async function precache(cache) {
  for (const url of CORE) {
    await cache.add(url).catch(() => {});            // 单个失败不影响整体
  }
  const shell = await cache.match('./index.html');
  if (!shell) return;
  const html = await shell.text();
  const urls = new Set();
  const re = /(?:src|href)="((?:css|js|icons)\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html))) urls.add('./' + m[1]);
  await Promise.all([...urls].map(u => cache.add(u).catch(() => {})));
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
