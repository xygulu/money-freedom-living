// Service Worker（2026-11-14）：**只为满足浏览器「添加到主屏幕」的安装条件**。
//
// 铁律（产品侧：档案是敏感数据）：
// - **什么都不缓存**——导航请求一律走网络，绝不缓存 HTML/接口响应。
//   这个产品里有画像、日记、信件、对话全文；一旦缓存进设备缓存，退出登录也不会清掉。
// - 只放行静态图标/manifest 走缓存（无个人数据）。
// - 不做离线兜底：断网就是断网，不给假页面。
//
// 为什么还需要它：Chrome/Edge 的 PWA 安装条件要求有一个带 fetch 事件的 SW。
// 这个 SW 存在的唯一意义是「注册成功 + 什么都不拦」。
const STATIC_CACHE = 'mfl-static-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((c) => c.addAll(['/icons/icon-192.png', '/icons/icon-512.png'])).catch(() => null)
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 静态图标：缓存优先（无个人数据）
  if (url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(STATIC_CACHE).then((c) => c.put(req, copy)).catch(() => null);
        return res;
      }))
    );
    return;
  }

  // 其余一律直连网络——不缓存任何含个人内容的响应
  event.respondWith(fetch(req));
});
