/* 對譯 service worker：有網路就拿最新的，沒網路才用上次存的，所以更新不會卡住。只管自己這個資料夾的靜態檔。
 * 每次都帶 cache: 'no-cache' 問網站「這個檔案有沒有新版」：GitHub Pages 會叫瀏覽器把檔案存 10 分鐘，
 * 不問的話剛更新完那 10 分鐘可能拿到「新畫面＋舊程式」，新按鈕按了沒反應。
 * 檔案沒變時網站只回「沒變」，幾乎不花流量。 */
'use strict';
var CACHE = 'taco-translate-v2';
var FILES = ['./', 'index.html', 'style.css', 'core.js', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

function fresh(req) {
  return new Request(req, { cache: 'no-cache' });
}

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES.map(fresh)); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('taco-translate-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf(new URL('./', self.location).pathname) !== 0) return;  // 翻譯 API 不經過這裡
  e.respondWith(fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache' }).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (hit) { return hit || caches.match('index.html'); });
  }));
});
