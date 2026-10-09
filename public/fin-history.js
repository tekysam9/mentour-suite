/* Fin-Module, "Year & month view": every client invoice, browsable by year and
   month, with search, filters, sorting, paging, bulk paid/unpaid and CSV export.
   Backed by GET /api/invoices/history. Uses the page's globals: state, render, escapeHtml, money. */

var HIST_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
var histTimer = null;

function histFmt(n) { return Number(n || 0).toLocaleString('en-US'); }
function histMoney(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function histShort(n) {
  n = Number(n || 0);
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e4) return '$' + Math.round(n / 1e3) + 'K';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function histQuery(extra) {
  var h = state.hist, p = new URLSearchParams();
  ['year', 'month', 'q', 'category', 'paymentStatus', 'hours', 'rate', 'clientId'].forEach(function (k) { if (h[k]) p.set(k, h[k]); });
  if (extra) Object.keys(extra).forEach(function (k) { p.set(k, extra[k]); });
  return p;
}

function histLoad(keepFocusId) {
  var h = state.hist;
  h.loading = true; h.error = null;
  var wasLoaded = h.loaded;
  if (!wasLoaded) render();
  var p = histQuery({ sort: h.sort, dir: h.dir, page: h.page, pageSize: h.pageSize });
  return fetch('/api/invoices/history?' + p.toString())
    .then(function (res) { if (!res.ok) throw new Error('Could not load invoices.'); return res.json(); })
    .then(function (data) {
      h.data = data; h.loaded = true; h.loading = false;
      // First visit: open on the newest year that has invoices.
      if (!wasLoaded && h.year === '' && !h.autoYearDone && data.years.length) {
        h.autoYearDone = true;
        h.year = String(data.years[0].year);
        return histLoad(keepFocusId);
      }
      h.autoYearDone = true;
      render();
      if (keepFocusId) {
        var el = document.getElementById(keepFocusId);
        if (el) { el.focus(); if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); }
      }
    })
    .catch(function (err) { h.loading = false; h.error = err.message; render(); });
}

function histCard(label, value, sub) {
  return '<div class="hist-card"><div class="hist-card-label">' + label + '</div><div class="hist-card-value">' + value + '</div>' +
    (sub ? '<div class="hist-card-sub">' + sub + '</div>' : '') + '</div>';
}

function histSelect(id, label, value, options) {
  return '<label class="hist-field"><span>' + label + '</span><select id="' + id + '">' + options.map(function (o) {
    return '<option value="' + escapeHtml(o[0]) + '"' + (String(value) === String(o[0]) ? ' selected' : '') + '>' + escapeHtml(o[1]) + '</option>';
  }).join('') + '</select></label>';
}

function histSortTh(key, label, numeric) {
  var h = state.hist, active = h.sort === key;
  return '<th scope="col"' + (active ? ' aria-sort="' + (h.dir === 'asc' ? 'ascending' : 'descending') + '"' : '') + (numeric ? ' class="fin-num"' : '') + '>' +
    '<button type="button" class="hist-sort" data-hist-sort="' + key + '">' + label + (active ? (h.dir === 'asc' ? ' ▲' : ' ▼') : '') + '</button></th>';
}

function histCategoryTag(inv) {
  if (!inv.payment_category) return '<span class="fin-muted">—</span>';
  var cls = inv.payment_category === 'W2' ? 'hist-tag-w2' : inv.payment_category === '1099' ? 'hist-tag-1099' : 'hist-tag-sub';
  var detail = inv.payment_category === 'Subvendor' ? (inv.subvendor_name || inv.payment_terms || '') : (inv.payment_terms && inv.payment_terms !== inv.payment_category ? inv.payment_terms : '');
  return '<span class="hist-tag ' + cls + '">' + escapeHtml(inv.payment_category) + '</span>' + (detail ? ' <span class="fin-src" title="' + escapeHtml(inv.payment_terms || '') + '">' + escapeHtml(detail) + '</span>' : '');
}

function renderHistoryTab() {
  var h = state.hist, d = h.data;
  var intro = '<h2 class="fin-subtitle">Invoices by year and month.</h2>' +
    '<p class="fin-copy">Every client invoice, grouped the way you work: pick a year, then a month, and narrow down with search or the filters. Click a column heading to sort. Months are invoice months (one month in arrears: the invoice for August bills July’s hours). Invoices come from Generate, Import hours, Import history, or all of them.</p>';
  if (h.loading && !d) return intro + '<div class="fin-loading" role="status">Loading invoices…</div>';
  if (h.error && !d) return intro + '<div class="fin-readonly-note" role="alert">' + escapeHtml(h.error) + '</div>';
  if (!d) return intro;

  var out = intro;
  if (h.flash) out += '<div class="fin-result" role="status">' + escapeHtml(h.flash) + '</div>';
  if (h.error) out += '<div class="fin-readonly-note" role="alert">' + escapeHtml(h.error) + '</div>';

  // Year chips
  var allCount = d.years.reduce(function (t, y) { return t + y.invoices; }, 0);
  out += '<div class="hist-section-label" id="hist-year-label">Invoice year</div><div class="hist-chips" role="group" aria-labelledby="hist-year-label">' +
    '<button type="button" class="hist-chip' + (h.year === '' ? ' on' : '') + '" aria-pressed="' + (h.year === '') + '" data-hist-year="">All years<span>' + histFmt(allCount) + '</span></button>' +
    d.years.map(function (y) {
      var on = String(y.year) === String(h.year);
      return '<button type="button" class="hist-chip' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-hist-year="' + y.year + '">' + y.year +
        '<span>' + histFmt(y.invoices) + ' · ' + histShort(y.amount) + '</span></button>';
    }).join('') + '</div>';

  // Month tiles
  var byMonth = {};
  d.months.forEach(function (m) { byMonth[m.month] = m; });
  out += '<div class="hist-section-label" id="hist-month-label">Invoice month' + (h.year === '' ? ' <span class="fin-muted">(same month of every year combined)</span>' : ' of ' + escapeHtml(h.year)) + '</div>' +
    '<div class="hist-months" role="group" aria-labelledby="hist-month-label">' +
    '<button type="button" class="hist-month' + (h.month === '' ? ' on' : '') + '" aria-pressed="' + (h.month === '') + '" data-hist-month=""><b>All months</b><span>' +
      histFmt(d.months.reduce(function (t, m) { return t + m.invoices; }, 0)) + ' invoices</span></button>' +
    HIST_MONTHS.map(function (name, i) {
      var m = byMonth[i + 1], on = String(h.month) === String(i + 1);
      return '<button type="button" class="hist-month' + (on ? ' on' : '') + (m ? '' : ' empty') + '" aria-pressed="' + on + '" data-hist-month="' + (i + 1) + '">' +
        '<b>' + name.slice(0, 3) + '</b>' + (m ? '<span>' + histFmt(m.invoices) + ' · ' + histShort(m.amount) + '</span>' : '<span>none</span>') + '</button>';
    }).join('') + '</div>';

  // Filters
  var clientOptions = [['', 'All clients']].concat(d.clients.map(function (c) { return [String(c.id), c.name]; }));
  out += '<div class="hist-filters">' +
    '<label class="hist-field hist-search"><span>Search</span><input type="search" id="hist-q" placeholder="Consultant, client, program, invoice no., payment terms" value="' + escapeHtml(h.q) + '"></label>' +
    histSelect('hist-category', 'Paid via', h.category, [['', 'All'], ['W2', 'W2'], ['1099', '1099'], ['Subvendor', 'Subvendor'], ['none', 'Not tagged']]) +
    histSelect('hist-status', 'Status', h.paymentStatus, [['', 'All'], ['unpaid', 'Unpaid'], ['paid', 'Paid']]) +
    histSelect('hist-hours', 'Hours', h.hours, [['', 'All'], ['with', 'With hours'], ['zero', 'No hours yet']]) +
    histSelect('hist-rate', 'Rate', h.rate, [['', 'All'], ['missing', 'No billing rate']]) +
    histSelect('hist-client', 'Client', h.clientId, clientOptions) +
    '<button type="button" class="fin-btn fin-btn-small" data-hist-clear>Clear filters</button>' +
  '</div>';

  // Summary
  var s = d.summary;
  var scope = (h.month ? HIST_MONTHS[Number(h.month) - 1] + ' ' : '') + (h.year || (h.month ? 'of every year' : 'all years'));
  out += '<div class="hist-cards" aria-label="Totals for ' + escapeHtml(scope) + '">' +
    histCard('Invoices', histFmt(s.invoices), escapeHtml(scope)) +
    histCard('Consultants', histFmt(s.consultants), 'with an invoice') +
    histCard('Hours', histFmt(Math.round(s.hours * 100) / 100), '') +
    histCard('Billed', histMoney(s.amount), '') +
    histCard('Unpaid', histMoney(s.unpaidAmount), s.amount ? Math.round(s.unpaidAmount / s.amount * 100) + '% of billed' : '') +
  '</div>';

  // Actions
  var canBulk = h.year !== '' && s.invoices > 0;
  out += '<div class="hist-actions">' +
    '<button type="button" class="fin-btn fin-btn-small" data-hist-bulk="paid"' + (canBulk ? '' : ' disabled title="Pick a year first"') + '>Mark these ' + histFmt(s.invoices) + ' as paid</button>' +
    '<button type="button" class="fin-btn fin-btn-small" data-hist-bulk="unpaid"' + (canBulk ? '' : ' disabled title="Pick a year first"') + '>Mark these as unpaid</button>' +
    '<button type="button" class="fin-btn fin-btn-small" data-hist-fill-rates title="Invoices imported without a rate pick up the rate now on their client/program pairing">Apply Directory rates</button>' +
    '<a class="fin-btn fin-btn-small" href="/api/invoices/history/export?' + histQuery().toString() + '" download>Download CSV</a>' +
  '</div>';

  // Table
  if (!d.invoices.length) {
    out += '<div class="fin-empty-state">No invoices match' + (allCount ? ' these filters.' : ' yet. Use the Import history tab to bring in your hours workbook.') + '</div>';
    return out;
  }
  var from = (d.page - 1) * d.pageSize + 1, to = Math.min(d.total, d.page * d.pageSize), pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  out += '<div class="fin-table-wrap"><table class="fin-table hist-table"><caption class="sr-only">Invoices for ' + escapeHtml(scope) + ', showing ' + from + ' to ' + to + ' of ' + d.total + '</caption><thead><tr>' +
    histSortTh('period', 'Invoice month') + '<th scope="col">Hours for</th>' + histSortTh('invoice', 'Invoice no.') + histSortTh('consultant', 'Consultant') + histSortTh('client', 'Client / Program') +
    histSortTh('category', 'Paid via') + histSortTh('hours', 'Hours', true) + histSortTh('rate', 'Rate', true) + histSortTh('amount', 'Amount', true) + histSortTh('status', 'Status') +
    '</tr></thead><tbody>' +
    d.invoices.map(function (inv) {
      var cp = inv.program_name ? inv.client_name + ' / ' + inv.program_name : (inv.client_name || '');
      var ym = String(inv.period_month).slice(0, 7);
      var hy = Number(ym.slice(0, 4)), hm = Number(ym.slice(5, 7)) - 1;
      if (hm < 1) { hm = 12; hy--; }
      return '<tr data-hist-id="' + inv.id + '"><td>' + HIST_MONTHS[Number(ym.slice(5, 7)) - 1].slice(0, 3) + ' ' + ym.slice(0, 4) + '</td>' +
        '<td class="fin-muted">' + HIST_MONTHS[hm - 1].slice(0, 3) + ' ' + hy + '</td>' +
        '<td class="fin-invoice-no">' + escapeHtml(inv.invoice_number) + '</td>' +
        '<td class="fin-consultant">' + escapeHtml(inv.consultant_name) + '</td>' +
        '<td>' + (cp ? escapeHtml(cp) : '<span class="fin-muted">—</span>') + '</td>' +
        '<td>' + histCategoryTag(inv) + '</td>' +
        '<td class="fin-num">' + (inv.hours === null ? '<span class="fin-muted">—</span>' : Number(inv.hours)) + '</td>' +
        '<td class="fin-num">' + (inv.rate === null ? '<span class="hist-norate" title="' + escapeHtml(inv.notes || 'No billing rate yet') + '">no rate</span>' : '$' + money(inv.rate)) + '</td>' +
        '<td class="fin-num">' + (inv.amount === null ? '<span class="fin-muted">—</span>' : '$' + money(inv.amount)) + '</td>' +
        '<td><button type="button" class="fin-status-badge fin-status-' + inv.payment_status + '" data-hist-toggle aria-label="' + inv.payment_status + ' — click to mark ' + (inv.payment_status === 'paid' ? 'unpaid' : 'paid') + '">' +
          (inv.payment_status === 'paid' ? 'Paid' : 'Unpaid') + '</button></td></tr>';
    }).join('') + '</tbody></table></div>';

  out += '<div class="hist-pager" role="navigation" aria-label="Pages">' +
    '<span role="status" aria-live="polite">Showing ' + histFmt(from) + '–' + histFmt(to) + ' of ' + histFmt(d.total) + '</span>' +
    '<span class="hist-pager-btns"><button type="button" class="fin-btn fin-btn-small" data-hist-page="' + (d.page - 1) + '"' + (d.page <= 1 ? ' disabled' : '') + '>← Previous</button>' +
    '<span>Page ' + d.page + ' of ' + histFmt(pages) + '</span>' +
    '<button type="button" class="fin-btn fin-btn-small" data-hist-page="' + (d.page + 1) + '"' + (d.page >= pages ? ' disabled' : '') + '>Next →</button>' +
    histSelect('hist-pagesize', 'Per page', h.pageSize, [[25, '25'], [50, '50'], [100, '100'], [200, '200']]).replace('hist-field', 'hist-field hist-inline') + '</span></div>';
  return out;
}

function histResetPaging() { state.hist.page = 1; }

document.addEventListener('click', function (e) {
  var h = state.hist;
  if (!h || state.tab !== 'history') return;
  var el;
  if ((el = e.target.closest('[data-hist-year]'))) {
    h.year = el.getAttribute('data-hist-year'); h.month = ''; histResetPaging(); h.flash = null; histLoad();
  } else if ((el = e.target.closest('[data-hist-month]'))) {
    h.month = el.getAttribute('data-hist-month'); histResetPaging(); h.flash = null; histLoad();
  } else if ((el = e.target.closest('[data-hist-sort]'))) {
    var k = el.getAttribute('data-hist-sort');
    if (h.sort === k) h.dir = h.dir === 'asc' ? 'desc' : 'asc'; else { h.sort = k; h.dir = (k === 'consultant' || k === 'client' || k === 'invoice') ? 'asc' : 'desc'; }
    histResetPaging(); histLoad();
  } else if ((el = e.target.closest('[data-hist-page]'))) {
    if (el.disabled) return;
    h.page = Number(el.getAttribute('data-hist-page')); histLoad();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (e.target.closest('[data-hist-clear]')) {
    h.q = ''; h.category = ''; h.paymentStatus = ''; h.hours = ''; h.rate = ''; h.clientId = ''; histResetPaging(); histLoad();
  } else if ((el = e.target.closest('[data-hist-bulk]'))) {
    if (el.disabled) return;
    var status = el.getAttribute('data-hist-bulk');
    var n = h.data.summary.invoices;
    var what = (h.month ? HIST_MONTHS[Number(h.month) - 1] + ' ' : '') + h.year;
    if (!confirm('Mark all ' + n + ' invoice(s) shown for ' + what + (h.q || h.category || h.paymentStatus || h.hours || h.rate || h.clientId ? ' (with your filters)' : '') + ' as ' + status + '?')) return;
    var body = {}; ['year', 'month', 'q', 'category', 'paymentStatus', 'hours', 'rate', 'clientId'].forEach(function (key) { if (h[key]) body[key] = h[key]; });
    body.paymentStatus = status; // the new status (the filter of the same name is sent as `filterStatus` below)
    if (h.paymentStatus) body.filterStatus = h.paymentStatus;
    fetch('/api/invoices/bulk-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().then(function (b) { if (!res.ok) throw new Error(b.error || 'Could not update.'); return b; }); })
      .then(function (b) { h.flash = b.updated + ' invoice(s) marked ' + status + '.'; histLoad(); })
      .catch(function (err) { h.error = err.message; render(); });
  } else if (e.target.closest('[data-hist-fill-rates]')) {
    fetch('/api/invoices/fill-rates', { method: 'POST' })
      .then(function (res) { if (!res.ok) throw new Error('Could not apply rates.'); return res.json(); })
      .then(function (b) { h.flash = b.updated ? b.updated + ' invoice(s) now have the rate from Directory.' : 'No invoice without a rate has a Directory rate yet.'; histLoad(); })
      .catch(function (err) { h.error = err.message; render(); });
  } else if ((el = e.target.closest('[data-hist-toggle]'))) {
    var row = el.closest('[data-hist-id]'), id = Number(row.getAttribute('data-hist-id'));
    var inv = h.data.invoices.filter(function (i) { return i.id === id; })[0];
    if (!inv) return;
    fetch('/api/invoices/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentStatus: inv.payment_status === 'paid' ? 'unpaid' : 'paid' }) })
      .then(function (res) { if (!res.ok) throw new Error('Could not save that change.'); return histLoad(); })
      .catch(function (err) { h.error = err.message; render(); });
  }
});

document.addEventListener('input', function (e) {
  var h = state.hist;
  if (!h || state.tab !== 'history') return;
  if (e.target.id === 'hist-q') {
    clearTimeout(histTimer);
    var v = e.target.value;
    histTimer = setTimeout(function () { h.q = v.trim(); histResetPaging(); histLoad('hist-q'); }, 350);
  }
});

document.addEventListener('change', function (e) {
  var h = state.hist;
  if (!h || state.tab !== 'history') return;
  var map = { 'hist-category': 'category', 'hist-status': 'paymentStatus', 'hist-hours': 'hours', 'hist-rate': 'rate', 'hist-client': 'clientId' };
  if (map[e.target.id]) { h[map[e.target.id]] = e.target.value; histResetPaging(); histLoad(e.target.id); }
  else if (e.target.id === 'hist-pagesize') { h.pageSize = Number(e.target.value); histResetPaging(); histLoad('hist-pagesize'); }
});
