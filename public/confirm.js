// "Are you sure?" for every change. Wraps window.fetch: before any add / edit / delete / generate
// request to /api goes out, a dialog shows what is about to be saved and the person confirms or cancels.
// Cancelling sends nothing. Reads (GET), sign-in/out, previews (apply:false) and email parsing are not asked about.
(function () {
  if (window.__msConfirm) return;
  window.__msConfirm = true;
  var realFetch = window.fetch.bind(window);

  var NOUNS = [
    [/^\/api\/roster/, 'placement'],
    [/^\/api\/directory\/consultants\/\d+\/assignments/, 'billing pairing'],
    [/^\/api\/directory\/assignments/, 'billing pairing'],
    [/^\/api\/directory\/duplicates/, 'duplicate record'],
    [/^\/api\/directory\/consultants/, 'consultant'],
    [/^\/api\/directory\/clients/, 'client'],
    [/^\/api\/directory\/programs/, 'vendor'],
    [/^\/api\/directory\/subvendors/, 'supplier company'],
    [/^\/api\/directory/, 'directory record'],
    [/^\/api\/subvendor-invoices/, 'supplier payment'],
    [/^\/api\/invoices/, 'client invoice'],
    [/^\/api\/onboarding\/people/, 'person / role'],
    [/^\/api\/onboarding\/invites/, 'invite code'],
    [/^\/api\/onboarding/, 'onboarding request'],
    [/^\/api\/profiles/, 'profile'],
    [/^\/api\/forms/, 'form'],
    [/^\/api\/margin/, 'Margin file import'],
    [/^\/api\/ledger/, 'Ledger file import'],
  ];
  var ACTION_WORDS = /\/(generate|import-hours|import-workbook|bulk-status|fill-rates|from-ledger|status|create-records|merge|bulk|email|dismiss|checklist|submit|approve|return|reject)\b/;
  var SECRET = /pass(word)?|secret|token|ssn|tin\b|account_?(no|number)|routing|iban|swift/i;
  var SKIP_FIELDS = /^(_|id$|organization|csrf|apply$)/;

  function noun(path) { for (var i = 0; i < NOUNS.length; i++) if (NOUNS[i][0].test(path)) return NOUNS[i][1]; return 'record'; }
  function human(k) { return String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function flatten(obj, prefix, out, depth) {
    if (out.length >= 24 || obj === null || obj === undefined) return;
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (SKIP_FIELDS.test(k) || v === '' || v === null || v === undefined || typeof v === 'function') return;
      var label = (prefix ? prefix + ' › ' : '') + human(k);
      if (SECRET.test(k)) { out.push([label, '••••••']); return; }
      if (Array.isArray(v)) {
        if (!v.length) return;
        if (typeof v[0] === 'object' && depth < 1) { out.push([label, v.length + ' item' + (v.length === 1 ? '' : 's')]); v.slice(0, 3).forEach(function (x, i) { flatten(x, label + ' ' + (i + 1), out, depth + 1); }); }
        else out.push([label, v.join(', ')]);
      } else if (typeof v === 'object') { if (depth < 2) flatten(v, label, out, depth + 1); }
      else out.push([label, String(v).length > 140 ? String(v).slice(0, 140) + '…' : String(v)]);
    });
  }

  function parseBody(body) {
    if (!body) return {};
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      var o = {}; body.forEach(function (v, k) { o[k] = (v && v.name) ? 'file: ' + v.name : v; }); return o;
    }
    if (typeof body === 'string') { try { return JSON.parse(body); } catch (e) { return {}; } }
    return {};
  }

  function needsConfirm(url, method, data) {
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
    var path; try { path = new URL(url, location.href).pathname; } catch (e) { return false; }
    if (!/^\/api\//.test(path)) return false;
    if (/^\/api\/(auth|version)\b/.test(path)) return false;
    if (/parse-email|\/duplicates\/scan/.test(path)) return false;
    if (data && data.apply === false) return false; // preview only, nothing is saved
    return true;
  }

  function describe(url, method, data) {
    var path = new URL(url, location.href).pathname;
    var n = noun(path);
    var act = ACTION_WORDS.exec(path);
    var title, danger = false, confirmLabel;
    if (method === 'DELETE') { title = 'Delete this ' + n + '?'; danger = true; confirmLabel = 'Yes, delete'; }
    else if (act && method === 'POST') {
      var w = act[1].replace(/-/g, ' ');
      title = 'Confirm: ' + w + ' (' + n + ')'; confirmLabel = 'Yes, go ahead';
    }
    else if (method === 'POST') { title = 'Add this ' + n + '?'; confirmLabel = 'Yes, add'; }
    else { title = 'Save changes to this ' + n + '?'; confirmLabel = 'Yes, save'; }
    var rows = []; flatten(data || {}, '', rows, 0);
    return { title: title, rows: rows, danger: danger, confirmLabel: confirmLabel };
  }

  function ensureStyle() {
    if (document.getElementById('ms-confirm-style')) return;
    var st = document.createElement('style'); st.id = 'ms-confirm-style';
    st.textContent =
      '.msc-back{position:fixed;inset:0;background:rgba(30,39,46,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px}' +
      '.msc-box{background:#fff;border-radius:8px;max-width:520px;width:100%;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,30,70,.35);font-family:Roboto,Helvetica,Arial,sans-serif;color:#333D47}' +
      '.msc-head{padding:18px 22px 6px;font-size:18px;font-weight:500;color:#1E272E}' +
      '.msc-sub{padding:0 22px 10px;font-size:13px;color:#5E6A75}' +
      '.msc-body{padding:0 22px;overflow:auto}' +
      '.msc-body table{width:100%;border-collapse:collapse;font-size:13.5px}' +
      '.msc-body td{padding:6px 0;border-bottom:1px solid #EBEDEF;vertical-align:top}' +
      '.msc-body td:first-child{color:#5E6A75;width:42%;padding-right:12px}' +
      '.msc-body td:last-child{color:#1E272E;font-weight:500;word-break:break-word}' +
      '.msc-foot{display:flex;gap:10px;justify-content:flex-end;padding:16px 22px 20px}' +
      '.msc-btn{border-radius:999px;padding:8px 20px;font:500 14px Roboto,Arial,sans-serif;cursor:pointer;border:1px solid #0875E1;background:#fff;color:#0875E1}' +
      '.msc-btn:hover{background:#E3F1FD}' +
      '.msc-ok{background:#0875E1;color:#fff}.msc-ok:hover{background:#0B64C0}' +
      '.msc-danger{background:#C62F25;border-color:#C62F25;color:#fff}.msc-danger:hover{background:#A3261E}' +
      '.msc-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#1E272E;color:#fff;padding:10px 18px;border-radius:999px;font:14px Roboto,Arial,sans-serif;z-index:99999}';
    document.head.appendChild(st);
  }

  function toast(msg) {
    ensureStyle();
    var t = document.createElement('div'); t.className = 'msc-toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600);
  }

  var queue = Promise.resolve();
  function ask(info) {
    // One dialog at a time, in order.
    var p = queue.then(function () {
      return new Promise(function (resolve) {
        ensureStyle();
        var back = document.createElement('div'); back.className = 'msc-back';
        var rowsHtml = info.rows.length
          ? '<table>' + info.rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>'
          : '<div style="padding:6px 0 10px;font-size:13.5px">No further details.</div>';
        back.innerHTML = '<div class="msc-box" role="dialog" aria-modal="true" aria-label="Confirm">' +
          '<div class="msc-head">' + esc(info.title) + '</div>' +
          '<div class="msc-sub">' + (info.danger ? 'This can’t be undone. ' : '') + 'Please check the details before continuing.</div>' +
          '<div class="msc-body">' + rowsHtml + '</div>' +
          '<div class="msc-foot"><button class="msc-btn" data-c="no" type="button">Go back</button>' +
          '<button class="msc-btn ' + (info.danger ? 'msc-danger' : 'msc-ok') + '" data-c="yes" type="button">' + esc(info.confirmLabel) + '</button></div></div>';
        function done(v) { document.removeEventListener('keydown', onKey, true); back.remove(); resolve(v); }
        function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done(false); } }
        back.addEventListener('click', function (e) {
          var b = e.target.closest('[data-c]');
          if (b) done(b.getAttribute('data-c') === 'yes'); else if (e.target === back) done(false);
        });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(back);
        var yes = back.querySelector('[data-c="yes"]'); if (yes) yes.focus();
      });
    });
    queue = p.catch(function () {});
    return p;
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var data = init && init.body ? parseBody(init.body) : {};
    if (init && init.confirm === false) { var c = Object.assign({}, init); delete c.confirm; return realFetch(input, c); }
    if (!needsConfirm(url, method, data)) return realFetch(input, init);
    var inlineEl = document.activeElement && document.activeElement.closest && document.activeElement.closest('td') &&
      /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) ? document.activeElement : null;
    return ask(describe(url, method, data)).then(function (ok) {
      if (ok) return realFetch(input, init);
      toast('Cancelled — nothing was changed.');
      // A table cell that was edited in place shows the new value already: put the saved one back.
      if (inlineEl && method !== 'POST') setTimeout(function () { location.reload(); }, 700);
      return new Response(JSON.stringify({ error: 'Cancelled — nothing was changed.' }), { status: 499, headers: { 'Content-Type': 'application/json' } });
    });
  };
})();
