// Keeps the app's pages, scripts and styles available on a weak or dropped
// connection. Network first (so a deploy is picked up as soon as you are
// online) with a short timeout, falling back to the last copy seen. Account
// data (/api/...) is never stored here: it always comes live from the server.
var VERSION = 'ms-static-v1';
var SLOW_MS = 4000;

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function fromNetwork(req, ms) {
  return new Promise(function (resolve, reject) {
    var timer = ms ? setTimeout(function () { reject(new Error('slow')); }, ms) : null;
    fetch(req).then(function (res) { if (timer) clearTimeout(timer); resolve(res); }, function (err) { if (timer) clearTimeout(timer); reject(err); });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;                 // live data only
  if (url.pathname === '/vendor.html' || url.pathname === '/sw.js') return; // private link page / this file

  var immutable = /^\/(lib|fonts)\//.test(url.pathname);
  e.respondWith(caches.open(VERSION).then(function (cache) {
    var key = req.mode === 'navigate' ? new Request(url.origin + url.pathname) : req;
    if (immutable) {
      return cache.match(key).then(function (hit) {
        return hit || fetch(req).then(function (res) { if (res.ok) cache.put(key, res.clone()); return res; });
      });
    }
    // Wait for the network only as long as SLOW_MS when a saved copy exists.
    return cache.match(key).then(function (hit) {
      return fromNetwork(req, hit ? SLOW_MS : 0).then(function (res) {
        if (res.ok && res.type === 'basic') cache.put(key, res.clone());
        return res;
      }).catch(function () {
        if (hit) return hit;
        return new Response('You are offline and this page has not been opened on this device yet. Reconnect and try again.',
          { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      });
    });
  }));
});
