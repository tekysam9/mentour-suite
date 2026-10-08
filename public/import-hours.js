/* Fin-Module "Import hours": work out which month AND year each
 * "Hours/<month>" column of an uploaded hours sheet is for.
 *
 * Shared by public/invoices.html (window.ImportHours) and the tests
 * (require('../public/import-hours.js')). No DOM, no dependencies.
 *
 * Rules (nothing is guessed beyond these):
 *  0. EVERY sheet of the workbook is read (Sam's W2 Payroll file has one sheet
 *     per month: "December 2025", "January 2026", ...), and all hours columns
 *     are combined per consultant + client, keyed by hours month.
 *  1. A heading with its own year ("Hours/December 2025", "Hours/Dec 2025",
 *     "Hours/Dec-25", "Hours/Dec'25") is that year.
 *  1b. Otherwise, a sheet named "<Month> <Year>" ("December 2025") gives the
 *     year for a column of that same month.
 *  2. Otherwise the year comes from column order: reading the hours columns
 *     left to right, every time the month number goes DOWN (e.g. Dec -> Jan)
 *     the year moves forward by one. The chosen Year is the year of the LAST
 *     run of columns, so "Dec, Jan .. Sep" with Year 2026 is Dec 2025, then
 *     Jan .. Sep 2026. With no rollover every column is the chosen Year. If a
 *     heading (or sheet name) carries a year, that column anchors the sequence
 *     instead. This applies within each sheet.
 *  4. The same hours month twice for one consultant + client (two sheets or
 *     two columns) is not guessed: it is skipped and listed.
 *  3. An hours month after the current month can never be invoiced (it is
 *     reported as "month is in the future").
 *
 * Billing is one month in arrears: hours worked in a month go on the NEXT
 * month's invoice (Dec 2025 hours -> Jan 2026 invoice). invoiceMonthKey()
 * does that mapping; the server applies the same rule.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImportHours = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var FUTURE_REASON = 'month is in the future';

  // "Hours/Dec", "Hours - December", "Hours/Dec 2025", "Hours/Dec-25", "Hours/Dec'25",
  // "Hours/Dec’25", "Hours/Dec.2025", "Hours/Dec/2025" -> { month: 12, year: 2025|null }
  var HEADER_RE = /^hours?\s*[\/\-–]\s*([A-Za-z]{3,9})\.?\s*(?:(?:'|’|-|–|\/|_|\.|\s)\s*(\d{4}|\d{2}))?$/i;

  function parseHoursHeader(text) {
    if (typeof text !== 'string') return null;
    var t = text.replace(/\u00a0/g, ' ').trim();
    var m = HEADER_RE.exec(t);
    if (!m) return null;
    var word = m[1].toLowerCase();
    var month = MONTHS[word.slice(0, 3)];
    if (!month) return null;
    // "Sept"/"December" fine; reject words that only share a prefix ("Marching").
    var full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'][month - 1];
    if (word.length > 3 && full.indexOf(word) !== 0 && !(month === 9 && word === 'sept')) return null;
    var year = null;
    if (m[2]) year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    return { month: month, year: year };
  }

  // cols: [{ month, year|null }] in left-to-right sheet order.
  // Returns a new list: [{ month, year, explicit, key: 'YYYY-MM', label: 'Dec 2025',
  //   invoiceKey: 'YYYY-MM', invoiceLabel: 'Jan 2026' }]  (key/label = hours month).
  function resolveHourColumns(cols, chosenYear) {
    var y = Number(chosenYear);
    var seg = [];
    var s = 0;
    for (var i = 0; i < cols.length; i++) {
      if (i > 0 && cols[i].month < cols[i - 1].month) s++;
      seg.push(s);
    }
    var lastSeg = cols.length ? seg[cols.length - 1] : 0;
    // Anchor: the year of segment 0.
    var base = y - lastSeg;
    for (var j = 0; j < cols.length; j++) {
      if (cols[j].year) { base = cols[j].year - seg[j]; break; }
    }
    return cols.map(function (c, k) {
      var year = c.year ? c.year : base + seg[k];
      var key = year + '-' + String(c.month).padStart(2, '0');
      var invoiceKey = invoiceMonthKey(key);
      return {
        month: c.month, year: year, explicit: !!c.year,
        key: key, label: MONTH_NAMES[c.month - 1] + ' ' + year,           // the HOURS month
        invoiceKey: invoiceKey, invoiceLabel: monthKeyLabel(invoiceKey),   // the invoice it goes on
      };
    });
  }

  // Hours month 'YYYY-MM' -> invoice month 'YYYY-MM' (the month after).
  function invoiceMonthKey(hoursKey) {
    var y = Number(String(hoursKey).slice(0, 4));
    var m = Number(String(hoursKey).slice(5, 7));
    return m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
  }

  // Invoice month 'YYYY-MM' -> the hours month it bills ('YYYY-MM', the month before).
  function hoursMonthKey(invoiceKey) {
    var y = Number(String(invoiceKey).slice(0, 4));
    var m = Number(String(invoiceKey).slice(5, 7));
    return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
  }

  // 'YYYY-MM' -> 'Dec 2025'
  function monthKeyLabel(key) {
    var m = Number(String(key).slice(5, 7));
    return m >= 1 && m <= 12 ? MONTH_NAMES[m - 1] + ' ' + String(key).slice(0, 4) : '';
  }

  // 'YYYY-MM' of `now` (a Date; defaults to today, browser-local time).
  function currentMonthKey(now) {
    var d = now || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function isFutureKey(key, nowKey) {
    return String(key) > String(nowKey || currentMonthKey());
  }

  // Sheet name "December 2025" / "Dec 2025" / "Dec-25" -> { month: 12, year: 2025 }, else null.
  function parseSheetName(name) {
    if (typeof name !== 'string') return null;
    var m = /^\s*([A-Za-z]{3,9})\.?\s*(?:'|’|-|–|\/|_|\.|\s)\s*(\d{4}|\d{2})\s*$/.exec(name.replace(/\u00a0/g, ' '));
    if (!m) return null;
    var h = parseHoursHeader('Hours/' + m[1]);
    if (!h) return null;
    return { month: h.month, year: m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]) };
  }

  function cellText(v) {
    return v === null || v === undefined ? '' : String(v).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // One sheet as a grid (rows of cells, as XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })
  // returns it). Finds the header row (a Name column, a Client column and "Hours/<month>"
  // columns) in the first 25 rows. Returns null when the sheet has no such table.
  function findHoursTable(grid) {
    for (var hr = 0; hr < Math.min(grid.length, 25); hr++) {
      var head = grid[hr] || [];
      var nameCol = -1, clientCol = -1, cols = [];
      for (var c = 0; c < head.length; c++) {
        var t = typeof head[c] === 'string' ? cellText(head[c]) : '';
        if (!t) continue;
        var hm = parseHoursHeader(t);
        if (hm) cols.push({ col: c, month: hm.month, year: hm.year, heading: t });
        else if (nameCol < 0 && /^(name|consultant|resource)\b/i.test(t)) nameCol = c;
        else if (clientCol < 0 && /client|account/i.test(t)) clientCol = c;
      }
      if (nameCol >= 0 && clientCol >= 0 && cols.length) return { headerRow: hr, nameCol: nameCol, clientCol: clientCol, cols: cols };
    }
    return null;
  }

  // sheets: [{ name, grid }] in workbook order. Reads every sheet that has an hours table.
  // Returns { sheets: [{ name, headerRow, cols: [{ col, month, year|null, heading }] }],
  //           skippedSheets: [names without an hours table],
  //           rows: [{ sheetIndex, rowNumber (1-based, as in Excel), name, client, byCol: { col: hours } }] }
  // A table ends where a second "Name" header row starts (e.g. a pay batch listed below it).
  function parseHoursSheets(sheets) {
    var out = { sheets: [], skippedSheets: [], rows: [] };
    sheets.forEach(function (sh) {
      var grid = sh.grid || [];
      var t = findHoursTable(grid);
      if (!t) { out.skippedSheets.push(sh.name); return; }
      var si = out.sheets.length;
      out.sheets.push({ name: sh.name, headerRow: t.headerRow, cols: t.cols });
      for (var r = t.headerRow + 1; r < grid.length; r++) {
        var row = grid[r] || [];
        var name = cellText(row[t.nameCol]);
        if (/^name$/i.test(name)) break; // another table starts here
        if (!name || /^total/i.test(name)) continue;
        var byCol = {};
        var any = false;
        t.cols.forEach(function (hc) {
          var v = row[hc.col];
          var n = typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : NaN);
          if (isFinite(n) && n > 0) { byCol[hc.col] = n; any = true; }
        });
        if (!any) continue;
        out.rows.push({ sheetIndex: si, rowNumber: r + 1, name: name, client: cellText(row[t.clientCol]), byCol: byCol });
      }
    });
    return out;
  }

  // Case/space-insensitive key for combining one consultant + client across sheets.
  function personKey(name, client) {
    return cellText(name).toLowerCase() + '|' + cellText(client).toLowerCase().replace(/\s*\/\s*/g, '/');
  }

  // Resolve every column's hours month (heading year > sheet-name year > column order +
  // hoursYear), then combine rows per consultant + client keyed by hours month.
  // Returns {
  //   columns: [{ sheet, sheetIndex, col, heading, key, label, invoiceKey, invoiceLabel, source: 'heading'|'sheet'|'order', future }],
  //   allYearsKnown: true when no column needed the Hours year box,
  //   rows: [{ name, client, hours: { 'YYYY-MM': hours } }]   -> the import payload (future months left out),
  //   rowSources: ['December 2025 row 2, January 2026 row 2', ...]   (same order as rows),
  //   skipped: [{ row, name, client, hoursMonth, invoiceMonth, reason }]   (held back in the browser)
  // }
  function resolveHoursImport(parsed, hoursYear, nowKey) {
    nowKey = nowKey || currentMonthKey();
    var columns = [];
    var colIndex = {}; // sheetIndex|col -> column
    var allYearsKnown = true;
    parsed.sheets.forEach(function (sh, si) {
      var sheetYm = parseSheetName(sh.name);
      var input = sh.cols.map(function (c) {
        if (c.year) return { month: c.month, year: c.year, source: 'heading' };
        if (sheetYm && sheetYm.month === c.month) return { month: c.month, year: sheetYm.year, source: 'sheet' };
        return { month: c.month, year: null, source: 'order' };
      });
      resolveHourColumns(input, hoursYear).forEach(function (rc, k) {
        if (input[k].source === 'order') allYearsKnown = false;
        var col = {
          sheet: sh.name, sheetIndex: si, col: sh.cols[k].col, heading: sh.cols[k].heading,
          key: rc.key, label: rc.label, invoiceKey: rc.invoiceKey, invoiceLabel: rc.invoiceLabel,
          source: input[k].source, future: isFutureKey(rc.key, nowKey),
        };
        columns.push(col);
        colIndex[si + '|' + col.col] = col;
      });
    });

    var people = [];
    var byPerson = {};
    parsed.rows.forEach(function (r) {
      var pk = personKey(r.name, r.client);
      var p = byPerson[pk];
      if (!p) { p = byPerson[pk] = { name: r.name, client: r.client, entries: {}, sources: [] }; people.push(p); }
      p.sources.push(parsed.sheets[r.sheetIndex].name + ' row ' + r.rowNumber);
      Object.keys(r.byCol).forEach(function (c) {
        var col = colIndex[r.sheetIndex + '|' + c];
        if (!col) return;
        (p.entries[col.key] = p.entries[col.key] || []).push({ hours: r.byCol[c], col: col });
      });
    });

    var rows = [], rowSources = [], skipped = [];
    people.forEach(function (p, idx) {
      var hours = {};
      Object.keys(p.entries).sort().forEach(function (key) {
        var list = p.entries[key];
        var col = list[0].col;
        var base = { row: idx + 1, name: p.name, client: p.client, hoursMonth: key, invoiceMonth: col.invoiceKey };
        if (col.future) { skipped.push(Object.assign(base, { reason: FUTURE_REASON })); return; }
        if (list.length > 1) {
          skipped.push(Object.assign(base, { reason: 'this month appears more than once for this consultant/client (' +
            list.map(function (e) { return e.col.sheet + ': ' + e.hours + ' h'; }).join(', ') + ')' }));
          return;
        }
        hours[key] = list[0].hours;
      });
      rows.push({ name: p.name, client: p.client, hours: hours });
      rowSources.push(p.sources.join(', '));
    });
    return { columns: columns, allYearsKnown: allYearsKnown, rows: rows, rowSources: rowSources, skipped: skipped };
  }

  return {
    MONTH_NAMES: MONTH_NAMES,
    FUTURE_REASON: FUTURE_REASON,
    parseHoursHeader: parseHoursHeader,
    resolveHourColumns: resolveHourColumns,
    parseSheetName: parseSheetName,
    findHoursTable: findHoursTable,
    parseHoursSheets: parseHoursSheets,
    resolveHoursImport: resolveHoursImport,
    invoiceMonthKey: invoiceMonthKey,
    hoursMonthKey: hoursMonthKey,
    monthKeyLabel: monthKeyLabel,
    currentMonthKey: currentMonthKey,
    isFutureKey: isFutureKey,
  };
});
