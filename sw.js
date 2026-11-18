/**
 * 津电云 · Service Worker 离线缓存
 * ------------------------------------------------------------------
 * 提供北洋园校区离线底图、站点数据与前端静态资源的离线运行支持。
 */

const CACHE_NAME = 'jindianyun-v3';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './icon.svg',
  './manifest.webmanifest',
  './data/basemap.json',
  './data/stations.json',
  './js/app.js',
  './js/map.js',
  './js/basemap.js',
  './js/panel.js',
  './js/format.js',
  './js/recommend.js',
  './js/chat.js',
  './js/mock-adapter.js',
  './js/http-adapter.js',
  './js/adapter.js',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 只拦截同源请求
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((networkResp) => {
        if (networkResp && networkResp.status === 200) {
          const toCache = networkResp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, toCache));
        }
        return networkResp;
      }).catch(() => cached);

      // 若已有缓存直接秒开（Stale-While-Revalidate），没有缓存则走网络
      return cached || fetchPromise;
    })
  );
});
