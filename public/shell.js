// Application shell: builds the left navigation + top bar around #app on every
// signed-in page. Pages keep rendering into #app exactly as before.
(function () {
  var appEl = document.getElementById('app');
  if (!appEl || document.body.classList.contains('has-shell')) return;

  var ICON = {
    home: '<path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/>',
    ledger: '<path d="M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3V4zM8 9h7M8 13h7"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
    building: '<path d="M4 21V5l8-2v18M12 9h8v12M4 21h18M8 8h.01M8 12h.01M8 16h.01M16 13h.01M16 17h.01"/>',
    vendor: '<path d="M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6"/>',
    truck: '<path d="M2 6h12v10H2zM14 10h4l3 3v3h-7M6.5 19a1.5 1.5 0 1 0 0-.01M17.5 19a1.5 1.5 0 1 0 0-.01"/>',
    doc: '<path d="M6 3h8l5 5v13H6zM14 3v5h5M9 13h7M9 17h7"/>',
    pay: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2"/>',
    clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'
  };
  function svg(name) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[name] + '</svg>'; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  var NAV = [
    { label: 'Home', href: '/', icon: 'home', page: ['/', '/index.html'] },
    { section: 'Dashboards' },
    { label: 'Ledger', href: '/ledger.html', icon: 'ledger', page: ['/ledger.html'], crumb: ['Dashboards', 'Ledger'] },
    { label: 'Margin', href: '/margin.html', icon: 'chart', page: ['/margin.html'], crumb: ['Dashboards', 'Margin'] },
    { section: 'People' },
    { label: 'Onboarding', href: '/onboarding.html', icon: 'clipboard', page: ['/onboarding.html'], crumb: ['People', 'Onboarding'], badgeKey: 'pending' },
    { section: 'Directory' },
    { label: 'Consultants', href: '/directory.html#consultants', icon: 'users', page: ['/directory.html'], tab: 'consultants', rec: 'consultants', crumb: ['Directory', 'Consultants'] },
    { label: 'Clients', href: '/directory.html#clients', icon: 'building', page: ['/directory.html'], tab: 'clients', rec: 'clients', crumb: ['Directory', 'Clients'] },
    { label: 'Vendors', href: '/directory.html#programs', icon: 'vendor', page: ['/directory.html'], tab: 'programs', rec: 'programs', crumb: ['Directory', 'Vendors'] },
    { label: 'Supplier companies', href: '/directory.html#subvendors', icon: 'truck', page: ['/directory.html'], tab: 'subvendors', rec: 'subvendors', crumb: ['Directory', 'Supplier companies'] },
    { section: 'Fin-Module' },
    { label: 'Client invoices', href: '/invoices.html#client', icon: 'doc', page: ['/invoices.html'], tab: 'client', crumb: ['Fin-Module', 'Client invoices'] },
    { label: 'Supplier payments', href: '/invoices.html#subvendor', icon: 'pay', page: ['/invoices.html'], tab: 'subvendor', crumb: ['Fin-Module', 'Supplier payments'] },
    { label: 'Year & month view', href: '/invoices.html#history', icon: 'calendar', page: ['/invoices.html'], tab: 'history', crumb: ['Fin-Module', 'Year & month view'] },
    { label: 'Import hours', href: '/invoices.html#import', icon: 'upload', page: ['/invoices.html'], tab: 'import', crumb: ['Fin-Module', 'Import hours'] },
    { label: 'Import history', href: '/invoices.html#hximport', icon: 'history', page: ['/invoices.html'], tab: 'hximport', crumb: ['Fin-Module', 'Import history'] }
  ];
  var BADGES = {};
  var ROLE = ls('ms-role'); // a recruiter login sees only the Onboarding module
  var DEFAULT_TAB = { '/directory.html': 'consultants', '/invoices.html': 'client' };

  function currentItem() {
    var path = location.pathname === '' ? '/' : location.pathname;
    var q = new URLSearchParams(location.search);
    var hash = location.hash.replace('#', '');
    if (path === '/record.html' || path === '/form.html') {
      var t = q.get('type');
      return NAV.filter(function (n) { return n.rec === t; })[0] || null;
    }
    var hits = NAV.filter(function (n) { return n.page && n.page.indexOf(path) !== -1; });
    if (hits.length > 1) {
      var want = hash || DEFAULT_TAB[path];
      return hits.filter(function (n) { return n.tab === want; })[0] || hits[0];
    }
    return hits[0] || null;
  }

  var html = '<aside class="app-side" id="app-side" aria-label="Main navigation">' +
    '<div class="app-side-head"><a class="app-brand" href="/"><i></i><span>Mentour Suite</span></a>' +
    '<button class="app-collapse" id="side-collapse" type="button" title="Collapse menu" aria-label="Collapse menu">' + svg('panel') + '</button></div>' +
    '<nav class="app-nav" id="app-nav"></nav>' +
    '<div class="app-side-foot"><div class="app-avatar" id="app-avatar">·</div><div class="app-user"><b id="app-uname">&nbsp;</b><span id="app-uorg">&nbsp;</span></div>' +
    '<button class="app-logout" id="app-logout" type="button">Log out</button></div></aside>' +
    '<div class="app-scrim" id="app-scrim"></div>' +
    '<div class="app-content"><header class="app-top"><button class="app-burger" id="app-burger" type="button" aria-label="Open menu">' + svg('menu') + '</button>' +
    '<div class="app-crumb" id="app-crumb"></div><div class="app-top-spacer"></div>' +
    '<button class="app-tool" id="density-btn" type="button" aria-pressed="false" title="Fit more columns on screen">Compact tables</button></header>' +
    '<main class="app-main" id="app-main"></main></div>';

  var shell = document.createElement('div');
  shell.className = 'app-shell';
  shell.innerHTML = html;
  appEl.parentNode.insertBefore(shell, appEl);
  document.getElementById('app-main').appendChild(appEl);
  document.body.classList.add('has-shell');
  if (ls('ms-collapsed') === '1') document.body.classList.add('side-collapsed');
  if (ls('ms-dense') === '1') document.body.classList.add('dense');

  function paintNav() {
    var cur = currentItem();
    var out = '';
    NAV.forEach(function (n) {
      if (ROLE === 'recruiter' && !(n.section === 'People' || n.badgeKey)) return;
      if (n.section) { out += '<div class="app-nav-label">' + esc(n.section) + '</div>'; return; }
      var child = n.href.indexOf('#') !== -1;
      out += '<a href="' + n.href + '" class="' + (child ? 'child' : '') + (n === cur ? ' active' : '') + '"' + (n === cur ? ' aria-current="page"' : '') + ' title="' + esc(n.label) + '">' + svg(n.icon) + '<span>' + esc(n.label) + '</span>' + (n.badgeKey && BADGES[n.badgeKey] ? '<em class="app-badge" title="Waiting for HR approval">' + BADGES[n.badgeKey] + '</em>' : '') + '</a>';
    });
    document.getElementById('app-nav').innerHTML = out;
    var crumb = document.getElementById('app-crumb');
    var onRec = location.pathname === '/record.html' || location.pathname === '/form.html';
    if (cur && cur.crumb) crumb.innerHTML = '<span>' + esc(cur.crumb[0]) + '</span><span class="sep">›</span>' + (onRec ? '<a href="' + cur.href + '" style="color:inherit;text-decoration:none">' + esc(cur.crumb[1]) + '</a><span class="sep">›</span><b>' + (location.pathname === '/form.html' ? 'Form' : 'Profile') + '</b>' : '<b>' + esc(cur.crumb[1]) + '</b>');
    else crumb.innerHTML = '<b>Home</b>';
    var base = document.title.replace(/ — Mentour Suite$/, '');
    if (cur && cur.crumb && !onRec) document.title = cur.crumb[1] + ' — Mentour Suite';
    else if (!cur) document.title = base || 'Mentour Suite';
  }
  paintNav();
  function loadBadges() {
    fetch('/api/onboarding/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) { BADGES.pending = d.pending || 0; paintNav(); } }).catch(function () {});
  }
  loadBadges();
  window.addEventListener('onboarding-changed', loadBadges);
  window.addEventListener('hashchange', paintNav);
  window.addEventListener('shell-nav', paintNav);

  document.getElementById('side-collapse').addEventListener('click', function () {
    var c = document.body.classList.toggle('side-collapsed'); ls('ms-collapsed', c ? '1' : '0');
  });
  document.getElementById('app-burger').addEventListener('click', function () { document.body.classList.add('side-open'); });
  document.getElementById('app-scrim').addEventListener('click', function () { document.body.classList.remove('side-open'); });
  document.getElementById('app-nav').addEventListener('click', function () { document.body.classList.remove('side-open'); });
  var dens = document.getElementById('density-btn');
  function paintDens() { dens.setAttribute('aria-pressed', document.body.classList.contains('dense') ? 'true' : 'false'); dens.textContent = document.body.classList.contains('dense') ? 'Compact tables: on' : 'Compact tables'; }
  paintDens();
  dens.addEventListener('click', function () { var d = document.body.classList.toggle('dense'); ls('ms-dense', d ? '1' : '0'); paintDens(); enhanceAll(); });
  document.getElementById('app-logout').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' }).then(function () { location.href = '/login.html'; });
  });

  fetch('/api/auth/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d || !d.user) return;
    var u = d.user, n = (u.name || u.email || '?').trim();
    document.getElementById('app-avatar').textContent = n.split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
    document.getElementById('app-uname').textContent = n;
    ls('ms-role', u.role);
    if (u.role !== ROLE) { ROLE = u.role; paintNav(); }
    if (u.role === 'recruiter' && location.pathname !== '/onboarding.html') location.replace('/onboarding.html');
    document.getElementById('app-uorg').textContent = (u.organization && u.organization.name) || '';
  }).catch(function () { /* the page itself redirects to login */ });

  // Tables wider than the screen get a second scrollbar on top, so every column is reachable.
  function enhance(wrap) {
    var prev = wrap.previousElementSibling;
    var has = prev && prev.classList && prev.classList.contains('tscroll-box');
    var over = wrap.scrollWidth > wrap.clientWidth + 4;
    if (!over) { if (has) prev.remove(); return; }
    if (has) { prev.querySelector('.tscroll > div').style.width = wrap.scrollWidth + 'px'; return; }
    var box = document.createElement('div');
    box.className = 'tscroll-box';
    box.innerHTML = '<div class="tscroll-hint"><span>↔ This table is wider than the screen — scroll sideways to see every column, or switch on “Compact tables”.</span></div><div class="tscroll"><div></div></div>';
    var bar = box.querySelector('.tscroll');
    bar.firstChild.style.width = wrap.scrollWidth + 'px';
    var lock = false;
    bar.addEventListener('scroll', function () { if (lock) { lock = false; return; } lock = true; wrap.scrollLeft = bar.scrollLeft; });
    wrap.addEventListener('scroll', function () { if (lock) { lock = false; return; } lock = true; bar.scrollLeft = wrap.scrollLeft; });
    wrap.parentNode.insertBefore(box, wrap);
  }
  function enhanceAll() {
    appEl.querySelectorAll('.fin-copy, .dir-copy').forEach(function (p) {
      if (p.classList.contains('copy-clamp') || p.textContent.length < 170) return;
      p.classList.add('copy-clamp');
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'copy-more'; b.textContent = 'More';
      b.addEventListener('click', function () { var o = p.classList.toggle('open'); b.textContent = o ? 'Less' : 'More'; });
      p.parentNode.insertBefore(b, p.nextSibling);
    });
    appEl.querySelectorAll('.fin-table-wrap, .dir-table-wrap').forEach(enhance);
  }
  var pending = false;
  new MutationObserver(function () {
    if (pending) return; pending = true;
    requestAnimationFrame(function () { pending = false; enhanceAll(); });
  }).observe(appEl, { childList: true, subtree: true });
  window.addEventListener('resize', enhanceAll);
})();
