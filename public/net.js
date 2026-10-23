// Makes the app steadier on a weak connection:
//  * reads (GET /api/...) retry quietly on a dropped connection and give up
//    after a time limit instead of hanging;
//  * saves are never retried or queued (that could double-save or lose data);
//    they fail with the app's normal "couldn't save" message;
//  * a small bar says when the device is offline;
//  * registers the service worker that keeps the pages available offline.
(function () {
  if (window.__msNet) return; window.__msNet = true;
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (method !== 'GET' || url.indexOf('/api/') === -1 || (init && init.signal)) return origFetch(input, init);
      var tries = 0;
      function attempt() {
        tries += 1;
        var ctl = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = ctl ? setTimeout(function () { ctl.abort(); }, 30000) : null;
        var opts = Object.assign({}, init || {}); if (ctl) opts.signal = ctl.signal;
        return origFetch(input, opts).then(function (r) { if (timer) clearTimeout(timer); return r; }, function (err) {
          if (timer) clearTimeout(timer);
          if (tries < 3) return new Promise(function (ok) { setTimeout(ok, 700 * tries); }).then(attempt);
          throw err;
        });
      }
      return attempt();
    };
  }

  // Called when a page's start-up sign-in check fails. A dropped connection must
  // not look like being signed out (and must not throw away what is on screen):
  // say so and retry; anything else goes to the sign-in page as before.
  window.__msAuthFail = function (err) {
    var msg = String((err && err.message) || '');
    var network = navigator.onLine === false || (err && err.name === 'AbortError') || /failed to fetch|network|load failed|fetch/i.test(msg);
    if (!network) { location.href = '/login.html'; return; }
    var box = document.getElementById('app') || document.body;
    box.innerHTML = '<div style="max-width:460px;margin:80px auto;padding:0 16px;font:15px Roboto,Arial,sans-serif;text-align:center">' +
      '<h2 style="margin:0 0 8px">Can’t reach the server</h2><p>The connection looks weak or offline. Nothing has been lost. This page will reload by itself when the connection is back.</p>' +
      '<button onclick="location.reload()" style="padding:8px 16px;font:600 14px Roboto,Arial,sans-serif;cursor:pointer">Try again</button></div>';
    window.addEventListener('online', function () { location.reload(); });
    setTimeout(function () { location.reload(); }, 20000);
  };

  var bar;
  function show(on) {
    if (!document.body) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.setAttribute('role', 'status');
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#7a2b00;color:#fff;font:600 13px Roboto,Arial,sans-serif;padding:8px 14px;text-align:center;display:none';
      bar.textContent = 'You’re offline. You can keep reading what’s on screen, but changes can’t be saved until the connection is back.';
      document.body.appendChild(bar);
    }
    bar.style.display = on ? 'block' : 'none';
  }
  window.addEventListener('offline', function () { show(true); });
  window.addEventListener('online', function () { show(false); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { show(navigator.onLine === false); });
  else show(navigator.onLine === false);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () { try { navigator.serviceWorker.register('/sw.js'); } catch (e) { /* optional */ } });
  }
})();
