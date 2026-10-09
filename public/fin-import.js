/* Fin-Module, "Import hours" tab: reads the multi-year "New hire hours by month"
   workbook in the browser and sends one row per consultant / client / month to
   POST /api/invoices/import-workbook (preview first, then apply).
   Uses the page's globals: state, render, escapeHtml, money, monthLabel, XLSX. */

var HX_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
var HX_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function hxClean(v) {
  return v === null || v === undefined ? '' : String(v).replace(/[ \s]+/g, ' ').trim();
}

// "March2020", "Februrary 2026", "July 2019" -> { year, month }; null when the
// sheet is not a single month ("Total July-Dec 2019", "2020 review").
function hxSheetPeriod(sheetName) {
  var t = hxClean(sheetName).toLowerCase();
  if (/^total\b/.test(t)) return null;
  var months = {};
  (t.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/g) || []).forEach(function (m) { months[HX_MONTHS[m]] = true; });
  var keys = Object.keys(months);
  var y = /(20\d{2})/.exec(t);
  if (keys.length !== 1 || !y) return null;
  return { year: Number(y[1]), month: Number(keys[0]) };
}

function hxIso(y, m, d) {
  if (y < 100) y += 2000;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// Excel date cell (a Date, because the workbook is read with cellDates) or "m/d/yy" text -> "YYYY-MM-DD"; anything else -> null.
function hxDate(v) {
  if (v instanceof Date && !isNaN(v)) {
    var d = new Date(v.getTime() + 12 * 3600 * 1000); // SheetJS dates can be a few minutes off midnight
    return hxIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  if (typeof v === 'string') {
    var m = /^\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})\s*$/.exec(v);
    if (m) return hxIso(Number(m[3]), Number(m[1]), Number(m[2]));
  }
  return null;
}

// Hours cell -> { hours } or { note } (text that is not hours) or {} when blank.
function hxHours(v) {
  if (v === null || v === undefined || v === '') return {};
  if (typeof v === 'number') return isFinite(v) && v >= 0 ? { hours: v } : { note: String(v) };
  if (v instanceof Date) return { note: 'a date, not hours' };
  var s = hxClean(v);
  if (!s) return {};
  if (/^[\d,]+(\.\d+)?$/.test(s)) return { hours: parseFloat(s.replace(/,/g, '')) };
  var m = /^(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b(?:[\s,]*(?:and\s*)?(\d+)\s*(?:minutes?|mins?)\b)?\s*(\(.*\))?\s*$/i.exec(s);
  if (m) return { hours: Math.round((parseFloat(m[1]) + (m[2] ? Number(m[2]) / 60 : 0)) * 100) / 100 };
  return { note: s.slice(0, 80) };
}

// Reads every sheet. Returns { rows, sheets: [{name, year, month, count}], skipped: [{name, reason}], warnings }.
function hxParseWorkbook(wb) {
  var rows = [], sheets = [], skipped = [], warnings = [];
  wb.SheetNames.forEach(function (sheetName) {
    var period = hxSheetPeriod(sheetName);
    if (!period) { skipped.push({ name: sheetName, reason: 'not a single month sheet' }); return; }
    var grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
    var hr = -1, cols = null;
    for (var r = 0; r < Math.min(grid.length, 25) && hr < 0; r++) {
      var head = grid[r] || [];
      var c = { name: -1, start: -1, hours: -1, client: -1, terms: -1, left: -1 };
      var headingMonth = null;
      head.forEach(function (cell, i) {
        var t = hxClean(cell).toLowerCase();
        if (!t) return;
        if (c.name < 0 && /^(name|consultant|resource)\b/.test(t)) c.name = i;
        else if (c.hours < 0 && /^hours?\s*([\/\-–]|$)/.test(t)) {
          c.hours = i;
          var hm = /([a-z]{3})[a-z]*\.?\s*$/.exec(t);
          if (hm && HX_MONTHS[hm[1]]) headingMonth = HX_MONTHS[hm[1]];
        }
        else if (c.client < 0 && /^(client|account)\b/.test(t)) c.client = i;
        else if (c.terms < 0 && /^payment\s*terms?/.test(t)) c.terms = i;
        else if (c.left < 0 && /\bleft\b/.test(t)) c.left = i;
        else if (c.start < 0 && /^start/.test(t)) c.start = i;
      });
      if (c.name >= 0 && c.hours >= 0 && c.client >= 0) { hr = r; cols = c; cols.headingMonth = headingMonth; }
    }
    if (hr < 0) { skipped.push({ name: sheetName, reason: 'no Name / Hours / Client columns' }); return; }
    if (cols.headingMonth && cols.headingMonth !== period.month) {
      warnings.push(sheetName + ': the hours heading says ' + HX_MONTH_NAMES[cols.headingMonth - 1] + ' but the sheet name says ' + HX_MONTH_NAMES[period.month - 1] + ' — using the sheet name.');
    }
    var count = 0;
    for (var i = hr + 1; i < grid.length; i++) {
      var row = grid[i] || [];
      var name = hxClean(row[cols.name]);
      if (!name || /^(name|total)\b/i.test(name)) continue; // blank, repeated header, totals
      var h = hxHours(row[cols.hours]);
      rows.push({
        sheet: sheetName, name: name, client: hxClean(row[cols.client]), year: period.year, month: period.month,
        hours: h.hours === undefined ? null : h.hours, hoursNote: h.note || null,
        paymentTerms: cols.terms >= 0 ? hxClean(row[cols.terms]) : '',
        startDate: cols.start >= 0 ? hxDate(row[cols.start]) : null,
        leftDate: cols.left >= 0 ? hxDate(row[cols.left]) : null,
      });
      count++;
    }
    sheets.push({ name: sheetName, year: period.year, month: period.month, count: count });
  });
  sheets.sort(function (a, b) { return a.year - b.year || a.month - b.month; });
  return { rows: rows, sheets: sheets, skipped: skipped, warnings: warnings };
}

function hxMoney(n) {
  if (n === null || n === undefined) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function hxNum(n) { return Number(n || 0).toLocaleString('en-US'); }
function hxPeriodLabel(ym) { return HX_MONTH_NAMES[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4); }

function hxCall(apply) {
  var imp = state.hx;
  imp.busy = true; imp.error = null; render();
  var body = JSON.stringify({
    rows: imp.rows, netTerms: imp.netTerms, paymentStatus: imp.paymentStatus, timesheetSubmitted: imp.timesheet,
    createSubvendors: imp.createSubvendors, enforceDates: imp.enforceDates, arrears: imp.arrears, apply: apply,
  });
  return fetch('/api/invoices/import-workbook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
    .then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (b) {
        if (!res.ok) throw new Error(b.error || 'The import failed.');
        return b;
      });
    })
    .then(function (b) {
      imp.busy = false;
      if (apply) {
        imp.result = b; imp.preview = null;
        state.invoices = []; if (typeof loadInvoices === 'function') loadInvoices();
        if (state.hist) { state.hist.loaded = false; }
        if (state.sv) { state.sv.loaded = false; }
      } else { imp.preview = b; imp.result = null; }
      render();
    })
    .catch(function (err) { imp.busy = false; imp.error = err.message; render(); });
}

var HX_ISSUE_TITLES = {
  'hours-text': 'Hours cell is text, not a number — not invoiced',
  'outside-range': 'Hours outside the consultant’s Start Date / Date-if-left — not invoiced (check these dates: some look mistyped; untick “Skip hours outside…” to include them)',
  conflict: 'Same consultant and client listed twice in one month — not invoiced',
  consultant: 'Consultant could not be matched — not invoiced',
  client: 'Client could not be matched — not invoiced',
  sheet: 'Sheet has no readable month — not invoiced',
  future: 'Hours month is after the current month — held back',
};

function hxDetails(title, count, headers, rowsHtml, open) {
  if (!count) return '';
  return '<details class="hx-details"' + (open ? ' open' : '') + '><summary>' + title + ' <span class="fin-muted">(' + hxNum(count) + ')</span></summary>' +
    '<div class="fin-table-wrap"><table class="fin-table"><thead><tr>' + headers.map(function (h) { return '<th scope="col">' + h + '</th>'; }).join('') +
    '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div></details>';
}

function hxPairLabel(w) { return escapeHtml(w.program ? w.client + ' / ' + w.program : w.client || ''); }

function hxCard(label, value, sub) {
  return '<div class="hist-card"><div class="hist-card-label">' + label + '</div><div class="hist-card-value">' + value + '</div>' +
    (sub ? '<div class="hist-card-sub">' + sub + '</div>' : '') + '</div>';
}

function renderHxTab() {
  var imp = state.hx;
  var p = imp.preview || imp.result;
  var out = '';
  var first = imp.sheets.length ? imp.sheets[0] : null, last = imp.sheets.length ? imp.sheets[imp.sheets.length - 1] : null;

  if (imp.fileName && !imp.error) {
    out += '<p class="fin-copy" style="max-width:none"><strong>' + escapeHtml(imp.fileName) + '</strong> — read ' + imp.sheets.length + ' monthly sheet(s)' +
      (first ? ' from ' + HX_MONTH_NAMES[first.month - 1] + ' ' + first.year + ' to ' + HX_MONTH_NAMES[last.month - 1] + ' ' + last.year : '') +
      ', ' + hxNum(imp.rows.length) + ' consultant rows.' +
      (imp.skipped.length ? ' Not a monthly sheet, left out: ' + imp.skipped.map(function (s) { return escapeHtml(s.name); }).join(', ') + '.' : '') + '</p>';
    if (imp.warnings.length) out += '<div class="fin-readonly-note">' + imp.warnings.map(escapeHtml).join('<br>') + '</div>';
  }

  if (p) {
    var sm = p.summary;
    var done = imp.result ? imp.result.done : null;
    out += '<div class="fin-readonly-note" role="status">' + (done
      ? '<strong>Done — ' + hxNum(done.created) + ' client invoice(s) created, ' + hxNum(done.filled) + ' filled in' +
        (done.subvendorCreated ? ', ' + hxNum(done.subvendorCreated) + ' subvendor invoice(s) created' : '') + '.</strong> '
      : '<strong>Preview only — nothing has been created yet.</strong> ') +
      'Check the numbers below, then apply.</div>';
    out += '<div class="hist-cards">' +
      hxCard('Invoices to create', hxNum(sm.willCreate), hxMoney(sm.totalAmount) + ' · ' + hxNum(sm.totalHours) + ' hrs') +
      hxCard('0-hour invoices to fill', hxNum(sm.willFill), 'existing, no hours yet') +
      hxCard('Already have hours', hxNum(sm.skippedExisting), 'left untouched') +
      hxCard('Not invoiced', hxNum(sm.issues), 'see the lists below') +
      hxCard('New in Directory', hxNum(sm.newConsultants) + ' · ' + hxNum(sm.newClients), 'consultants · clients<br>' + hxNum(sm.newPrograms) + ' programs, ' + hxNum(sm.newPairings) + ' pairings') +
      hxCard('Subvendor invoices', hxNum(sm.subvendorInvoices), hxNum(sm.subvendorInvoicesSkipped) + ' already exist or are paid in Ledger') +
    '</div>';
    if (sm.noRate) out += '<div class="fin-readonly-note">' + hxNum(sm.noRate) + ' invoice(s) belong to a client/program pairing with <strong>no billing rate</strong> in Directory yet. They will be created at $0 and marked in their notes; upload the Margin file (or add the rate), then use “Apply Directory rates” in the Year &amp; month view.</div>';

    if (imp.preview) {
      out += '<div class="fin-controls" style="justify-content:flex-start"><button type="button" class="fin-btn fin-btn-primary" data-action="hx-apply"' +
        ((imp.busy || (!sm.willCreate && !sm.willFill && !sm.subvendorInvoices)) ? ' disabled' : '') + '>Apply: create ' + hxNum(sm.willCreate) + ' invoices' +
        (sm.willFill ? ', fill in ' + hxNum(sm.willFill) : '') + '</button></div>';
    } else if (imp.result) {
      out += '<div class="fin-controls" style="justify-content:flex-start"><button type="button" class="fin-btn fin-btn-primary" data-action="hx-view-history">View invoices by year and month</button></div>';
    }

    out += hxDetails('Invoices to create, by invoice year', p.byYear.length, ['Year', 'Invoices', 'Hours', 'Amount'], p.byYear.map(function (y) {
      return '<tr><td>' + y.year + '</td><td class="fin-num">' + hxNum(y.invoices) + '</td><td class="fin-num">' + hxNum(y.hours) + '</td><td class="fin-num">' + hxMoney(y.amount) + '</td></tr>';
    }).join(''), true);

    var notes = p.notes;
    if (notes.nameSuffixCount) {
      out += hxDetails('Names with a “-1 / -2” suffix, treated as the same person', notes.nameSuffixCount, ['In the file', 'Treated as'],
        notes.nameSuffixes.map(function (n) { return '<tr><td>' + escapeHtml(n.from) + '</td><td>' + escapeHtml(n.to) + '</td></tr>'; }).join(''), false);
    }
    if (notes.unrecognizedTerms.length) {
      out += hxDetails('Payment Terms text that is not a subvendor in Directory — invoice tagged “Subvendor”, no subvendor invoice',
        notes.unrecognizedTerms.length, ['Payment Terms', 'Rows'],
        notes.unrecognizedTerms.map(function (t) { return '<tr><td>' + escapeHtml(t.text) + '</td><td class="fin-num">' + hxNum(t.count) + '</td></tr>'; }).join(''), false);
    }
    if (notes.newConsultants.length) {
      out += hxDetails('New consultants that will be added to Directory', sm.newConsultants, ['Name'],
        notes.newConsultants.map(function (n) { return '<tr><td>' + escapeHtml(n) + '</td></tr>'; }).join(''), false);
    }
    if (notes.newClients.length) {
      out += hxDetails('New clients that will be added to Directory', sm.newClients, ['Client (lower case)'],
        notes.newClients.map(function (n) { return '<tr><td>' + escapeHtml(n) + '</td></tr>'; }).join(''), false);
    }

    var cap = p.listCap;
    var invHead = ['Consultant', 'Client / Program', 'Invoice month', 'Hours for', 'Hours', 'Rate', 'Amount', 'Paid via'];
    function invRows(list) {
      return list.map(function (w) {
        return '<tr><td>' + escapeHtml(w.consultant) + '</td><td>' + hxPairLabel(w) + '</td><td>' + hxPeriodLabel(w.periodMonth) + '</td><td class="fin-muted">' + hxPeriodLabel(w.hoursMonth) +
          '</td><td class="fin-num">' + w.hours + '</td><td class="fin-num">' + (w.rate === null ? '<span class="fin-muted">no rate</span>' : hxMoney(w.rate)) +
          '</td><td class="fin-num">' + hxMoney(w.amount) + '</td><td>' + escapeHtml(w.terms || '') + '</td></tr>';
      }).join('');
    }
    out += hxDetails('First ' + Math.min(cap, sm.willCreate) + ' of the invoices to create', Math.min(cap, sm.willCreate), invHead, invRows(p.willCreate), false);
    out += hxDetails('Existing invoices at 0 hours — will be filled in', Math.min(cap, sm.willFill), invHead, invRows(p.willFill), false);
    out += hxDetails('Already have hours — left as is', Math.min(cap, sm.skippedExisting), ['Consultant', 'Client / Program', 'Invoice month', 'File hours', 'Invoice hours'],
      p.skippedExisting.map(function (w) {
        return '<tr><td>' + escapeHtml(w.consultant) + '</td><td>' + hxPairLabel(w) + '</td><td>' + hxPeriodLabel(w.periodMonth) +
          '</td><td class="fin-num">' + w.hours + '</td><td class="fin-num">' + w.existingHours + '</td></tr>';
      }).join(''), false);

    if (p.issues.length) {
      out += '<div class="fin-controls" style="justify-content:flex-start;margin-top:14px"><button type="button" class="fin-btn fin-btn-small" data-action="hx-issues-csv">Download the not-invoiced list (CSV)</button></div>';
      Object.keys(HX_ISSUE_TITLES).forEach(function (kind) {
        var list = p.issues.filter(function (i) { return i.kind === kind; });
        out += hxDetails(HX_ISSUE_TITLES[kind], list.length, ['Sheet', 'Consultant', 'Client column', 'Hours', 'Why'],
          list.slice(0, 300).map(function (u) {
            return '<tr><td>' + escapeHtml(u.sheet || '') + '</td><td>' + escapeHtml(u.name) + '</td><td>' + escapeHtml(u.client) + '</td><td class="fin-num">' + (u.hours === undefined ? '' : u.hours) + '</td><td>' + escapeHtml(u.reason) + '</td></tr>';
          }).join('') + (list.length > 300 ? '<tr><td colspan="5" class="fin-muted">…and ' + (list.length - 300) + ' more — download the CSV for the full list.</td></tr>' : ''), false);
      });
    }
  }

  return (
    '<h2 class="fin-subtitle">Import history.</h2>' +
    '<p class="fin-copy">Upload the multi-year hours workbook — one sheet per month (sheet names like “March 2020”), any number of years. This is for loading history; for the regular recent upload use <strong>Import hours</strong>. For every consultant and month the app reads <strong>Name</strong>, <strong>Start Date</strong>, <strong>Hours/&lt;month&gt;</strong>, <strong>Client</strong>, <strong>Payment Terms</strong> and <strong>Date, if left</strong>, and creates one invoice at the billing rate already in Directory. You always get a preview first. Billing is one month in arrears, like the rest of Fin-Module (a month’s hours go on the next month’s invoice). Invoices that already have hours are never changed; missing consultants, clients, programs and pairings are added to Directory. Upload an updated file any time to add new months.</p>' +
    '<div class="fin-generate-card">' +
      '<label>Hours workbook<input type="file" id="hx-file" accept=".xlsx,.xls"></label>' +
      '<label>Net terms<select id="hx-net">' + ['NET15', 'NET30', 'NET45', 'NET60', 'NET90'].map(function (nt) {
        return '<option value="' + nt + '"' + (imp.netTerms === nt ? ' selected' : '') + '>' + nt + '</option>';
      }).join('') + '</select></label>' +
      '<label>Create invoices as<select id="hx-pay"><option value="unpaid"' + (imp.paymentStatus === 'unpaid' ? ' selected' : '') + '>Unpaid</option><option value="paid"' + (imp.paymentStatus === 'paid' ? ' selected' : '') + '>Paid</option></select></label>' +
      '<label>Timesheet<select id="hx-ts"><option value="yes"' + (imp.timesheet === 'yes' ? ' selected' : '') + '>Submitted</option><option value="no"' + (imp.timesheet === 'no' ? ' selected' : '') + '>Not yet</option></select></label>' +
      '<label class="fin-check"><input type="checkbox" id="hx-arrears"' + (imp.arrears ? ' checked' : '') + '> Bill one month in arrears (Jul hours → Aug invoice)</label>' +
      '<label class="fin-check"><input type="checkbox" id="hx-dates"' + (imp.enforceDates ? ' checked' : '') + '> Skip hours outside Start Date / Date-if-left</label>' +
      '<label class="fin-check"><input type="checkbox" id="hx-subs"' + (imp.createSubvendors ? ' checked' : '') + '> Also add subvendor companies that are not in Directory</label>' +
    '</div>' +
    (imp.busy ? '<p class="fin-copy" role="status">Working — this can take a few seconds for a large file…</p>' : '') +
    (imp.error ? '<div class="fin-readonly-note" role="alert" style="background:#F6E7E7;border-color:#E3BDBD;color:#8A2D2D">' + escapeHtml(imp.error) + '</div>' : '') +
    out
  );
}

function hxIssuesCsv() {
  var p = state.hx.preview || state.hx.result;
  if (!p) return;
  var q = function (v) { return '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"'; };
  var lines = [['Sheet', 'Row', 'Consultant', 'Client', 'Month', 'Hours', 'Reason'].join(',')];
  p.issues.forEach(function (i) { lines.push([i.sheet, i.row, i.name, i.client, i.period, i.hours, i.reason].map(q).join(',')); });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = 'hours-import-not-invoiced.csv';
  document.body.appendChild(a); a.click(); a.remove();
}

document.addEventListener('click', function (e) {
  if (e.target.closest('[data-action="hx-apply"]')) {
    if (state.hx.busy) return;
    var s = state.hx.preview && state.hx.preview.summary;
    if (s && !confirm('Create ' + s.willCreate + ' invoice(s)' + (s.newConsultants ? ', add ' + s.newConsultants + ' new consultant(s) and ' + s.newClients + ' new client(s) to Directory' : '') + '? Existing invoices with hours are not changed.')) return;
    hxCall(true);
  } else if (e.target.closest('[data-action="hx-issues-csv"]')) {
    hxIssuesCsv();
  } else if (e.target.closest('[data-action="hx-view-history"]')) {
    state.tab = 'history';
    if (typeof histLoad === 'function') histLoad(); else render();
  }
});

document.addEventListener('change', function (e) {
  var hxFile = e.target.closest('#hx-file');
  if (hxFile) {
    var f = hxFile.files && hxFile.files[0];
    if (!f) return;
    var imp = state.hx;
    imp.error = null; imp.preview = null; imp.result = null; imp.busy = true; render();
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var parsed = hxParseWorkbook(XLSX.read(new Uint8Array(ev.target.result), { type: 'array', cellDates: true }));
        if (!parsed.rows.length) throw new Error('No monthly sheets with Name, Hours/<month> and Client columns were found in this file.');
        imp.fileName = f.name; imp.rows = parsed.rows; imp.sheets = parsed.sheets; imp.skipped = parsed.skipped; imp.warnings = parsed.warnings;
        imp.busy = false;
        hxCall(false);
      } catch (err) { imp.busy = false; imp.fileName = null; imp.rows = []; imp.sheets = []; imp.error = err.message; render(); }
    };
    reader.onerror = function () { imp.busy = false; imp.error = 'Could not read the file.'; render(); };
    reader.readAsArrayBuffer(f);
    return;
  }
  if (e.target.closest('#hx-net, #hx-pay, #hx-ts, #hx-subs, #hx-dates, #hx-arrears')) {
    var im = state.hx;
    im.netTerms = document.getElementById('hx-net').value; im.paymentStatus = document.getElementById('hx-pay').value;
    im.timesheet = document.getElementById('hx-ts').value; im.createSubvendors = document.getElementById('hx-subs').checked; im.enforceDates = document.getElementById('hx-dates').checked; im.arrears = document.getElementById('hx-arrears').checked;
    if (im.rows.length && !im.busy) hxCall(false);
  }
});
