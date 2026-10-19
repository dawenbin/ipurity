/*
 * sw.js —— 同源静态资源缓存（PWA）
 *
 * 只缓存本站文件：跨域请求（flagcdn、GitHub 星数、RDAP/DoH/ip-api）一律不拦截，
 * 这样离线时也不会把第三方响应当成本站数据。
 *
 * 缓存策略：
 *   - 导航：network-first，断网回退缓存的 index.html
 *   - 三个易变包的 meta（cloud-meta/blocklists/asn-disagree）：network-first，
 *     否则页面会一直用旧 meta、发现不了新包
 *   - 其余同源 GET：cache-first，命中后后台不刷新；带 ?v=<build> 的 URL 会随构建戳变化
 *
 * BUILD 由 tools/bump-build.mjs 自动改写，别手改。
 */
const BUILD = "20261019d";
const CACHE = "ipurity-" + BUILD;

const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "favicon.ico",
  "assets/icon.svg",
  "assets/icon-180.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/i18n.js?v=" + BUILD,
  "assets/core.js?v=" + BUILD,
  "assets/city.js?v=" + BUILD,
  "assets/online.js?v=" + BUILD,
  "assets/enrich.js?v=" + BUILD,
  "assets/report.js?v=" + BUILD,
  "assets/sources.js?v=" + BUILD,
  "assets/cloud.js?v=" + BUILD,
  "assets/blocklists.js?v=" + BUILD,
  "assets/asn-diff.js?v=" + BUILD,
  "assets/history.js?v=" + BUILD,
  "assets/share.js?v=" + BUILD,
  "assets/app.js?v=" + BUILD,
  "data/segments-data.js?v=" + BUILD
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key !== CACHE && key.indexOf("ipurity-") === 0 ? caches.delete(key) : Promise.resolve();
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isMetaPack(url) {
  return /\/data\/(cloud-meta|blocklists|asn-disagree)\.js$/.test(url.pathname);
}

self.addEventListener("fetch", function (event) {
  const req = event.request;
  if (req.method !== "GET") { return; }
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) { return; }   /* 跨域：不拦截、不缓存 */

  if (isMetaPack(url)) {
    event.respondWith(
      fetch(req, { cache: "no-store" })
        .then(function (res) {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        })
        .catch(function () { return caches.match(req); })
    );
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        })
        .catch(function () { return caches.match("index.html"); })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) { return hit; }
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      });
    })
  );
});
