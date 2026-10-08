/* Fin-Module "Import hours": work out which month AND year each
 * "Hours/<month>" column of an uploaded hours sheet is for.
 *
 * Shared by public/invoices.html (window.ImportHours) and the tests
 * (require('../public/import-hours.js')). No DOM, no dependencies.
 *
 * Rules (nothing is guessed beyond these):
 *  1. A heading with its own year ("Hours/Dec 2025", "Hours/Dec-25",
 *     "Hours/Dec'25") is that year.
 *  2. Otherwise the year comes from column order: reading the hours columns
 *     left to right, every time the month number goes DOWN (e.g. Dec -> Jan)
 *     the year moves forward by one. The chosen Year is the year of the LAST
 *     run of columns, so "Dec, Jan .. Sep" with Year 2026 is Dec 2025, then
 *     Jan .. Sep 2026. With no rollover every column is the chosen Year. If a
 *     heading carries a year, that column anchors the sequence instead.
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

  return {
    MONTH_NAMES: MONTH_NAMES,
    FUTURE_REASON: FUTURE_REASON,
    parseHoursHeader: parseHoursHeader,
    resolveHourColumns: resolveHourColumns,
    invoiceMonthKey: invoiceMonthKey,
    hoursMonthKey: hoursMonthKey,
    monthKeyLabel: monthKeyLabel,
    currentMonthKey: currentMonthKey,
    isFutureKey: isFutureKey,
  };
});
