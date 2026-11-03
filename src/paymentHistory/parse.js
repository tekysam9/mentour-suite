// Reads the supplier-payment history workbook the way a person would, without guessing silently.
//   * "matrix" sheets: one row per consultant (Client | Supplier | Consultant), one column per HOURS month;
//     a cell says when and how much was paid for that month ("May13(2600)", "Dec 17-10920", "Feb 24=2400-216.55bgv").
//   * "ar_ap" sheets: the 2017-18 monthly receivable/payable sheets (one block per corporation).
// Pure functions, no database: every uncertain reading is returned as a flag so the review screen can ask.

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const TYPO = { juy: 7, jul: 7, mat: 3, apri: 4, appr: 4, aui: 8, au: 8, oc: 10, sept: 9 };
function monthOf(w) {
  const t = String(w || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return null;
  if (MON[t.slice(0, 3)] && FULL[MON[t.slice(0, 3)] - 1].startsWith(t.slice(0, 3)) && t.length >= 3 && (FULL[MON[t.slice(0, 3)] - 1].startsWith(t) || t === 'sept')) return MON[t.slice(0, 3)];
  return TYPO[t] || null;
}
const pad = (n) => String(n).padStart(2, '0');
const clean = (v) => String(v == null ? '' : v).replace(/[ ​]/g, ' ').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
const num = (s) => { const n = Number(String(s).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const validDay = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const monthsBetween = (y1, m1, y2, m2) => (y2 - y1) * 12 + (m2 - m1);

// ---- column headers -> (year, month) ----------------------------------------
// Headers are month names with no year, except a few like "Jan'25". Years are carried from an anchor:
// a month name that is earlier in the year than the previous column means a new year started.
function assignColumnMonths(headerRow, firstCol) {
  const cols = [];
  for (let c = firstCol; c < headerRow.length; c++) {
    const raw = clean(headerRow[c]);
    if (!raw) continue;
    const m = monthOf(raw);
    if (!m) continue;
    const yy = /['’](\d{2})\b/.exec(raw);
    cols.push({ col: c, label: raw, month: m, year: yy ? 2000 + Number(yy[1]) : null, explicit: !!yy });
  }
  const anchor = cols.findIndex((c) => c.explicit);
  if (anchor < 0) return { cols, anchorLabel: null, noAnchor: true, gaps: [], explicitCount: 0 };
  // Going left from the anchor, the year drops by one whenever the month number goes UP (Jan <- Dec).
  for (let i = anchor - 1; i >= 0; i--) cols[i].year = cols[i + 1].year - (cols[i].month > cols[i + 1].month ? 1 : 0);
  for (let i = anchor + 1; i < cols.length; i++) {
    if (cols[i].explicit) continue;
    cols[i].year = cols[i - 1].year + (cols[i].month < cols[i - 1].month ? 1 : 0);
  }
  // Sanity: consecutive columns should step one month at a time.
  const gaps = [];
  for (let i = 1; i < cols.length; i++) {
    const step = monthsBetween(cols[i - 1].year, cols[i - 1].month, cols[i].year, cols[i].month);
    if (step !== 1) gaps.push({ after: cols[i - 1].label, before: cols[i].label, step });
  }
  const explicitDisagree = cols.filter((c) => c.explicit).length;
  return { cols, anchorLabel: cols[anchor].label, gaps, explicitCount: explicitDisagree };
}

// ---- one cell -> payments --------------------------------------------------
const STATUS_WORDS = [
  [/^(done|finished|completed|closed)\b/i, 'finished'],
  [/^(salary|w-?2)\b/i, 'w2'],
  [/\b(no invoice|no hours|no ts|no timesheet|no tms|no pmnt|no pmt|no payment|on leave|on hold)\b/i, 'no_payment'],
  [/\b(written off|write off|wrote off)\b/i, 'written_off'],
  [/^settled\b/i, 'settled'],
];
const AMT = '\\$?\\s*[\\d,]+(?:\\.\\d+)?';

function parsePart(partRaw) {
  const s = clean(partRaw);
  const m = /^([A-Za-z]{2,9})\.?[\s\-]*(\d{1,2})(?:\s*[,\/\s]\s*(\d{4}|\d{2})(?=\s*[-=(]))?\s*(.*)$/.exec(s);
  if (!m || !monthOf(m[1])) return null;
  const out = { mon: monthOf(m[1]), day: Number(m[2]), year: m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null, flags: [], note: '', amount: null, deduction: null, second: null };
  let rest = m[4];
  const yr = /^(20\d{2})\s*(?=[-=(])/.exec(rest); // "Oct182021-9576": the year runs straight on from the day
  if (!out.year && yr) { out.year = Number(yr[1]); rest = rest.slice(yr[0].length); out.flags.push('year_run_on'); }
  const trail = (t) => { const x = clean(t).replace(/^[-–\/,;:()]+\s*/, ''); if (x) out.note = out.note ? out.note + ' ' + x : x; };

  // gross=deduction  (also "(=gross-deduction)" and "gross-deduction bgv")
  let g = new RegExp('^[-\\(]*\\s*=\\s*(' + AMT + ')\\s*-\\s*(' + AMT + ')\\s*\\)?\\s*(.*)$').exec(rest);
  if (g) { out.amount = num(g[1]); out.deduction = num(g[2]); trail(g[3]); out.flags.push('deduction'); return out; }
  g = new RegExp('^-\\s*(' + AMT + ')\\s*-\\s*(' + AMT + ')\\s*([A-Za-z].*)?$').exec(rest);
  if (g && /bgv/i.test(rest)) { out.amount = num(g[1]); out.deduction = num(g[2]); trail(g[3] || ''); out.flags.push('deduction'); return out; }
  // (amount) with optional following number
  g = new RegExp('^\\(\\s*(' + AMT + ')\\s*\\)?\\s*(?:-\\s*(' + AMT + '))?\\s*(.*)$').exec(rest);
  if (g) {
    out.amount = num(g[1]);
    if (g[2]) { out.second = num(g[2]); out.flags.push('two_amounts'); }
    trail(g[3]);
    if (!/\)/.test(rest)) out.flags.push('open_bracket');
    return out;
  }
  // - amount (optional second number in brackets)
  g = new RegExp('^[-–]+\\s*(' + AMT + ')\\s*(?:\\(\\s*(' + AMT + ')\\s*\\))?\\s*(.*)$').exec(rest);
  if (g) {
    out.amount = num(g[1]);
    if (g[2]) { out.second = num(g[2]); out.flags.push('two_amounts'); }
    trail(g[3]); return out;
  }
  // no separator at all: "May121600"
  g = /^(\d{3,})\b\s*(.*)$/.exec(rest);
  if (g) { out.amount = num(g[1]); trail(g[2]); out.flags.push('no_separator'); return out; }
  return null;
}

// hoursYM = { year, month }. Returns { kind: 'payment'|'status'|'unreadable'|'blank', ... }
function parseCell(value, hoursYM) {
  if (value === null || value === undefined || value === '') return { kind: 'blank' };
  if (value instanceof Date) return { kind: 'unreadable', text: value.toISOString().slice(0, 10), why: 'A date with no amount.' };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value === 0) return { kind: 'blank' };
    return { kind: 'payment', raw: String(value), parts: [{ mon: null, day: null, year: null, amount: value, deduction: null, second: null, flags: ['no_date'], note: '' }] };
  }
  const text = clean(value);
  if (!text) return { kind: 'blank' };
  if (/^[\d,.$\s]+$/.test(text)) {
    const n = num(text);
    if (n) return { kind: 'payment', raw: text, parts: [{ mon: null, day: null, year: null, amount: n, deduction: null, second: null, flags: ['no_date'], note: '' }] };
    return { kind: 'blank' };
  }
  const pd = new RegExp('^paid\\s*\\(?\\s*(' + AMT + ')\\s*\\)?\\s*(.*)$', 'i').exec(text);
  if (pd) return { kind: 'payment', raw: text, parts: [{ mon: null, day: null, year: null, amount: num(pd[1]), deduction: null, second: null, flags: ['no_date'], note: clean(pd[2]) }] };
  const pt = /^paid to ([A-Za-z .]+?)\s*[-–]\s*(\d[\d,.]*)\s*(.*)$/i.exec(text);
  if (pt) return { kind: 'payment', raw: text, parts: [{ mon: null, day: null, year: null, amount: num(pt[2]), deduction: null, second: null, flags: ['no_date', 'paid_direct'], note: ('paid to ' + pt[1] + ' ' + pt[3]).trim() }] };
  const pieces = text.split(/\s*\+\s*(?=[A-Za-z]{3})/);
  const parts = [];
  for (const p of pieces) { const r = parsePart(p); if (r) parts.push(r); else { parts.length = 0; break; } }
  if (parts.length) {
    for (const p of parts) {
      if (p.amount === null) continue;
      if (p.mon) {
        let y = p.year;
        if (!y && hoursYM) y = hoursYM.year + (p.mon < hoursYM.month ? 1 : 0);
        if (y && validDay(y, p.mon, p.day)) {
          p.paidDate = iso(y, p.mon, p.day);
          if (hoursYM) {
            p.lag = monthsBetween(hoursYM.year, hoursYM.month, y, p.mon);
            if (p.lag < 0) p.flags.push('paid_before_hours');
            else if (p.lag > 9) p.flags.push('long_lag');
          }
          if (!p.year) p.flags.push('year_inferred');
        } else { p.paidDate = null; p.flags.push('bad_date'); }
      }
    }
    return { kind: 'payment', raw: text, parts };
  }
  for (const [re, tag] of STATUS_WORDS) if (re.test(text)) return { kind: 'status', tag, text };
  return { kind: 'unreadable', text, why: 'This cell did not look like a date and an amount.' };
}

// ---- supplier / client / consultant cell text ---------------------------------
const FROM_RE = /^(.*?)\s+from\s+([A-Za-z]{3,9}\.?\s*\d{1,2}|[A-Za-z]{3,9}\.?|\d{1,2}\/\d{1,2}\/\d{2,4})\s*\/\s*(.+)$/i;
const DATE_NAME_RE = /^(.*?)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s*\/\s*(.+)$/;
function parseFromDate(t, fallbackYear) {
  const a = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (a) { const y = a[3].length === 2 ? 2000 + Number(a[3]) : Number(a[3]); return { year: y, month: Number(a[1]), day: Number(a[2]) }; }
  const b = /^([A-Za-z]{3,9})\.?\s*(\d{1,2})$/.exec(t);
  if (b && monthOf(b[1])) return { year: fallbackYear || null, month: monthOf(b[1]), day: Number(b[2]) };
  const c = /^([A-Za-z]{3,9})\.?$/.exec(t); // "from Jan": month only, the 1st
  if (c && monthOf(c[1])) return { year: fallbackYear || null, month: monthOf(c[1]), day: 1 };
  return null;
}
// "Creta Logic from 9/1/24/Magicforce"  -> { names: ['Creta Logic','Magicforce'], from: {2024,9,1}, kind: 'switch' }
// "PreciseSoft/Busitants Incorporated"  -> { names: [...], kind: 'slash' }
function parseSupplierCell(raw) {
  const text = clean(raw);
  const out = { raw: text, names: [], kind: 'single', from: null, flags: [] };
  if (!text) return out;
  // "Cyber Trex(from 8/28/22)": one supplier that started on a date, not two suppliers
  const paren = /^(.*?)\s*\(\s*from\s+[^)]*\)\s*$/i.exec(text);
  if (paren && clean(paren[1])) { out.names = [clean(paren[1])]; out.flags.push('started_date'); return out; }
  let m = FROM_RE.exec(text);
  // "Agile Vision from 4/1/2023/ 1099": one supplier; the last bit is only a tax tag
  if (m && /^(1099|w-?2)$/i.test(clean(m[3]))) { out.names = [clean(m[1])]; out.flags.push(clean(m[3]).toLowerCase()); return out; }
  if (m && !parseFromDate(clean(m[2]))) m = null; // "X from Y/Z" where Y is not a date: not a switch
  if (m) { out.names = [clean(m[1]), clean(m[3])]; out.from = parseFromDate(clean(m[2])); out.kind = 'switch'; out.fromIsOpenYear = !!(out.from && !out.from.year); return out; }
  m = DATE_NAME_RE.exec(text);
  if (m) { out.names = [clean(m[1]), clean(m[3])]; out.from = parseFromDate(clean(m[2])); out.kind = 'switch_date_first'; return out; }
  const tail = /\s+\/\s*(1099|w2)\s*$/i.exec(text) || /\s*\/\s*(1099)\s*$/i.exec(text);
  let base = text;
  if (/\/\s*1099\s*$/i.test(text)) { out.flags.push('1099'); base = text.replace(/\s*\/\s*1099\s*$/i, ''); }
  const bits = base.split('/').map(clean).filter(Boolean);
  if (bits.length > 1) { out.names = bits; out.kind = 'slash'; }
  else out.names = [base];
  return out;
}

const COMPANY_WORDS = /\b(inc\.?|llc|l\.l\.c|ltd\.?|corp\.?|corporation|technologies|technology|solutions|consulting|systems|services|software|group|infotech|infosoft|tech|labs|global)\b/i;
function titleCase(s) {
  const t = clean(s);
  if (t && t === t.toUpperCase() && /[A-Z]/.test(t)) return t.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (x, a, b) => a + b.toUpperCase());
  return t;
}

// ---- the matrix sheets ----------------------------------------------------
// rows = array of arrays (sheet_to_json header:1). Header row = first row with a month name in col >= 3.
// borrow: Map(col index -> { year, month }) from another sheet whose headings DO carry a year. A sheet with no
// year of its own is lined up with it column for column, and only when every month name agrees.
function parseMatrixSheet(rows, sheetName, borrow, borrowedFrom) {
  let h = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) if ((rows[i] || []).slice(3).filter((c) => monthOf(clean(c))).length >= 6) { h = i; break; }
  if (h < 0) return { sheet: sheetName, layout: 'unknown', rows: [], payments: [], statuses: [], unreadable: [], columns: null };
  const colInfo = assignColumnMonths(rows[h], 3);
  if (colInfo.noAnchor) {
    const ok = borrow && colInfo.cols.length && colInfo.cols.every((c) => borrow.get(c.col) && borrow.get(c.col).month === c.month);
    if (ok) { colInfo.cols.forEach((c) => { c.year = borrow.get(c.col).year; }); colInfo.borrowedFrom = borrowedFrom; colInfo.anchorLabel = null; }
    else { colInfo.cols = []; colInfo.error = 'None of this sheet\'s column headings carries a year, and it does not line up with another sheet, so its years cannot be worked out.'; }
  }
  const byCol = new Map(colInfo.cols.map((c) => [c.col, c]));
  const out = { sheet: sheetName, layout: 'matrix', columns: colInfo, rows: [], payments: [], statuses: [], unreadable: [] };
  for (let r = h + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const consultant = clean(row[2]);
    const supplier = clean(row[1]);
    const client = clean(row[0]);
    const hasAny = row.slice(3).some((c) => c !== null && c !== undefined && clean(c) !== '');
    if (!consultant) { if (hasAny || supplier || client) out.unreadable.push({ sheet: sheetName, row: r + 1, text: [client, supplier].filter(Boolean).join(' / '), why: 'This row has no consultant name.' }); continue; }
    const rec = { sheet: sheetName, row: r + 1, client, supplierRaw: supplier, consultantRaw: consultant, cells: 0 };
    out.rows.push(rec);
    for (let c = 3; c < row.length; c++) {
      const col = byCol.get(c);
      const v = row[c];
      if (v === null || v === undefined || clean(v) === '') continue;
      if (!col) { out.unreadable.push({ sheet: sheetName, row: r + 1, consultant, text: clean(v), why: 'No month heading above this column.' }); continue; }
      const cell = parseCell(v, { year: col.year, month: col.month });
      const where = { sheet: sheetName, row: r + 1, col: c + 1, id: sheetName + '!' + (r + 1) + ':' + (c + 1) };
      if (cell.kind === 'payment') {
        rec.cells++;
        cell.parts.forEach((p, i) => out.payments.push({ ...where, id: where.id + (cell.parts.length > 1 ? '#' + (i + 1) : ''), hoursMonth: col.year + '-' + pad(col.month), hoursLabel: col.label, client, supplierRaw: supplier, consultantRaw: consultant, raw: cell.raw, part: p }));
      } else if (cell.kind === 'status') out.statuses.push({ ...where, consultant, supplierRaw: supplier, hoursMonth: col.year + '-' + pad(col.month), tag: cell.tag, text: cell.text });
      else if (cell.kind === 'unreadable') out.unreadable.push({ ...where, consultant, supplier, hoursMonth: col.year + '-' + pad(col.month), text: cell.text, why: cell.why });
    }
  }
  return out;
}

// ---- the 2017-18 receivable/payable sheets ---------------------------------
function toDate(v) {
  if (v instanceof Date) return iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  const t = clean(v); const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  const u = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t); if (u) return iso(u[3].length === 2 ? 2000 + Number(u[3]) : Number(u[3]), Number(u[1]), Number(u[2]));
  return null;
}
function parseArApSheet(rows, sheetName) {
  const out = { sheet: sheetName, layout: 'ar_ap', rows: [], payments: [], statuses: [], unreadable: [] };
  let corp = null; let cols = null;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || []; const a = clean(row[0]);
    if (a && !clean(row[1]) && /corporation/i.test(a)) { corp = a.replace(/\s*-?\s*(recievables|receivables)\s*\/?\s*payables\s*$/i, '').replace(/\s*-\s*$/, '').trim(); cols = null; continue; }
    if (/^employee$/i.test(a) || /^name$/i.test(clean(row[1]))) {
      if (/^name$/i.test(clean(row[1]))) { cols = {}; row.forEach((c, i) => { const k = clean(c).toLowerCase(); if (k) (cols[k] = cols[k] || []).push(i); }); }
      continue;
    }
    if (!a || !cols) continue;
    const paidCol = (cols['$ paid'] || [12])[0];
    const amount = row[paidCol];
    out.rows.push({ sheet: sheetName, row: r + 1, corp, consultantRaw: a });
    if (typeof amount !== 'number' || !amount) continue;
    const monthCol = paidCol + 1, dateCol = paidCol + 2, methodCol = paidCol + 3;
    const paidDate = toDate(row[dateCol]);
    const monthText = clean(row[monthCol]);
    const where = { sheet: sheetName, row: r + 1, col: paidCol + 1, id: sheetName + '!' + (r + 1) + ':' + (paidCol + 1) };
    let hm = null; const flags = [];
    const mm = monthOf(monthText);
    if (mm && paidDate) { const py = Number(paidDate.slice(0, 4)), pm = Number(paidDate.slice(5, 7)); hm = (py - (mm > pm ? 1 : 0)) + '-' + pad(mm); }
    if (!mm) flags.push('month_unreadable'); else if (/[\/&+]|\band\b/i.test(monthText)) flags.push('multi_month');
    if (!paidDate) flags.push('no_date');
    out.payments.push({ ...where, hoursMonth: hm, hoursLabel: monthText, client: clean(row[1]), supplierRaw: clean(row[5]), consultantRaw: a, corp, raw: String(amount), payRate: typeof row[6] === 'number' ? row[6] : num(row[6]), billRate: typeof row[2] === 'number' ? row[2] : num(row[2]),
      part: { mon: null, day: null, year: null, amount, deduction: null, second: null, paidDate, method: clean(row[methodCol]) || null, flags, note: '' } });
  }
  return out;
}

function detectLayout(rows) {
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const r = rows[i] || [];
    if (r.slice(3).filter((c) => monthOf(clean(c))).length >= 6 && /vendor|supplier/i.test(clean(r[1])) && /consultant/i.test(clean(r[2]))) return 'matrix';
  }
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const r = rows[i] || [];
    if (/^employee$/i.test(clean(r[0])) && /client/i.test(clean(r[1]))) return 'ar_ap';
  }
  return null;
}

function parseWorkbook(sheets) { // { sheetName: rows[][] }
  const out = { sheets: [], skipped: [] };
  // First find a matrix sheet whose headings carry a year, so a sheet without one can be lined up with it.
  let borrow = null; let borrowedFrom = null;
  for (const [name, rows] of Object.entries(sheets || {})) {
    if (detectLayout(rows || []) !== 'matrix') continue;
    let h = 0; while (h < 5 && (rows[h] || []).slice(3).filter((c) => monthOf(clean(c))).length < 6) h++;
    const info = assignColumnMonths(rows[h] || [], 3);
    if (!info.noAnchor && info.cols.length) { borrow = new Map(info.cols.map((c) => [c.col, { year: c.year, month: c.month }])); borrowedFrom = name; break; }
  }
  for (const [name, rows] of Object.entries(sheets || {})) {
    const lay = detectLayout(rows || []);
    if (lay === 'matrix') out.sheets.push(parseMatrixSheet(rows, name, borrow, borrowedFrom));
    else if (lay === 'ar_ap') out.sheets.push(parseArApSheet(rows, name));
    else out.skipped.push({ sheet: name, rows: (rows || []).length, why: /hours/i.test(name) ? 'Hours sheet: it lists hours and rates, not payments, so nothing is read from it.' : 'This sheet does not look like a payments sheet.' });
  }
  return out;
}

module.exports = { MON, monthOf, clean, titleCase, num, assignColumnMonths, parseCell, parsePart, parseSupplierCell, parseMatrixSheet, parseArApSheet, detectLayout, parseWorkbook, COMPANY_WORDS, iso, pad, monthsBetween };
