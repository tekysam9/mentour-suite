// Fin-Module "Subvendor payments" API: read-only invoices from subvendors to
// Mentour, one per (subvendor, consultant, month). Every route is scoped to
// req.user.organization_id.
//
// A paid month is the HOURS month named in the Subvendor label plus the
// file's Year column (the sheet name is only when it was paid). Rows with a
// red Amount (unpaid) are ignored.
//
// Two sources, merged into one list:
//   * kind 'paid'      -- months already paid, derived live from the latest
//                         Ledger upload's ledger_roster_entries (the "2026 sub
//                         vendor payments" file). Never copied anywhere, so it
//                         can't drift from the file. To edit one, POST /from-ledger
//                         makes an editable override copy that replaces it in the list
//                         (deleting the copy brings the file's row back).
//   * kind 'generated' -- months after a consultant's last month on the payments file, created
//                         by POST /generate from the $/hr rate on the Ledger
//                         file, or (no Ledger rate for the pairing) the Margin
//                         file's cost rate. Stored in subvendor_invoices, and
//                         editable like client invoices (hours/amount, NET
//                         terms, due date, paid/unpaid, timesheet, notes).
// Only the 'paid' rows are read-only: they have no id of their own, so
// nothing here can change them. See subvendor_invoices in db/schema.sql.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { maxBillableHours } = require('./invoices');

const { findOrCreateDirectoryRecord } = require('./directoryUpsert');
const router = express.Router();
router.use(requireAuth);

const NET_TERMS_RE = /^NET\d{1,3}$/i;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function isTruthyFlag(value) {
  return value === true || value === 1 || ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function pad2(n) { return String(n).padStart(2, '0'); }
function toDateOnly(d) { return d.toISOString().slice(0, 10); }
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days));
  return toDateOnly(d);
}
function lastDayOfMonth(periodMonth) {
  const y = Number(periodMonth.slice(0, 4));
  const m = Number(periodMonth.slice(5, 7));
  return toDateOnly(new Date(Date.UTC(y, m, 0)));
}
function normalizePeriodMonth(value) {
  const m = /^(\d{4})-(\d{2})/.exec(String(value || ''));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return m[1] + '-' + m[2] + '-01';
}
function normalizeNetTerms(value) {
  if (value === undefined || value === null || value === '') return 'NET30';
  const s = String(value).trim().toUpperCase();
  return NET_TERMS_RE.test(s) ? s : null;
}
function nextMonth(periodMonth) {
  const y = Number(periodMonth.slice(0, 4));
  const m = Number(periodMonth.slice(5, 7));
  return m === 12 ? (y + 1) + '-01-01' : y + '-' + pad2(m + 1) + '-01';
}
// Earliest month generation is open for: the month after the earliest
// "last hours month" among active consultants' pairings (all pairings when
// none is active), or null with no usable file rows.
function generationStartMonth(records) {
  const active = pairLastMonths(records.filter((r) => r.consultant_status === 'active'));
  const last = active.size ? active : pairLastMonths(records);
  const months = [...last.values()];
  return months.length ? nextMonth(months.reduce((a, b) => (a < b ? a : b))).slice(0, 7) : null;
}
function monthName(periodMonth) {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names[Number(periodMonth.slice(5, 7)) - 1] + ' ' + periodMonth.slice(0, 4);
}
function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  return String(v).slice(0, 10);
}

// The hours month a payment covers, from the text after the "/" in the
// Subvendor column ("May 2024-2nd invoice", "Oct + bal Sept", "Dec+Feb bal")
// plus the file's "Year" column. The FIRST month named is the invoice month;
// when several are named the row is flagged multi_month. The year comes from
// the Year column ("2025 and 2026" -> the first year), else a year written in
// the label itself (May 2024, Oct'23). Returns null when there's no month or
// no year to go with it -- those rows are listed as unreadable, never guessed.
const MONTH_TOKEN_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;
function parseHoursMonth(periodText, yearText) {
  const text = String(periodText || '');
  const tokens = [...text.matchAll(MONTH_TOKEN_RE)].map((m) => MONTHS[m[1].toLowerCase()]);
  if (!tokens.length) return null;
  let year = null;
  const y = /\b(20\d{2}|19\d{2})\b/.exec(String(yearText || ''));
  if (y) year = Number(y[1]);
  else {
    const inLabel = /(?:\b|')(20\d{2}|\d{2})\b(?!\s*(?:st|nd|rd|th|hr))/i.exec(text.replace(MONTH_TOKEN_RE, ' '));
    if (inLabel) year = inLabel[1].length === 2 ? 2000 + Number(inLabel[1]) : Number(inLabel[1]);
  }
  if (!year) return null;
  return {
    period_month: year + '-' + pad2(tokens[0]) + '-01',
    multi_month: new Set(tokens).size > 1 || /\+/.test(text),
  };
}

async function latestImport(conn, table, organizationId) {
  const [rows] = await conn.query(
    `SELECT id, file_name, imported_at FROM ${table} WHERE organization_id = ? ORDER BY imported_at DESC, id DESC LIMIT 1`,
    [organizationId]
  );
  return rows.length ? rows[0] : null;
}

// The latest Ledger upload as one record per paid file row. Month = the hours
// month (label + Year column), NOT the sheet name -- the sheet is only when
// it was paid ("paid_in"). Rows with a red (unpaid) Amount are ignored, rows
// with no readable month/year are returned in `unreadable`.
async function ledgerMonthlyRecords(conn, organizationId) {
  const imp = await latestImport(conn, 'ledger_imports', organizationId);
  if (!imp) return { imp: null, records: [], unreadable: [] };

  const [rows] = await conn.query(
    `SELECT l.id, l.consultant_id, l.subvendor_id, l.name, l.subvendor_text, l.month_label,
            l.period_text, l.year_text, l.client_tag, l.unpaid, l.amount, l.rate, l.hours, l.paid_date,
            c.name AS consultant_name, c.status AS consultant_status, s.name AS subvendor_name
     FROM ledger_roster_entries l
     LEFT JOIN consultants c ON c.id = l.consultant_id
     LEFT JOIN subvendors s ON s.id = l.subvendor_id
     WHERE l.import_id = ? AND l.organization_id = ?
     ORDER BY l.id`,
    [imp.id, organizationId]
  );

  const records = [];
  const unreadable = [];
  for (const r of rows) {
    if (r.unpaid) continue;
    if (String(r.month_label || '').trim().toLowerCase() === 'left') continue;
    const parsed = parseHoursMonth(r.period_text, r.year_text);
    if (!parsed) {
      unreadable.push({
        subvendor: r.subvendor_text, consultant: r.name, sheet: r.month_label,
        label: r.period_text, year: r.year_text, amount: r.amount === null ? null : Number(r.amount),
      });
      continue;
    }
    records.push({
      key: 'row' + r.id, row_id: r.id, period_month: parsed.period_month, multi_month: parsed.multi_month,
      paid_in: r.month_label, label: r.period_text,
      subvendor_id: r.subvendor_id, subvendor_name: r.subvendor_name || r.subvendor_text || '(unspecified)',
      consultant_id: r.consultant_id, consultant_name: r.consultant_name || r.name,
      consultant_status: r.consultant_status, client_tag: r.client_tag,
      rate: r.rate === null ? null : Number(r.rate),
      hours: r.hours === null ? null : Number(r.hours),
      amount: r.amount === null ? null : Number(r.amount),
      paid_date: dateStr(r.paid_date),
    });
  }
  return { imp, records, unreadable };
}

// Per (subvendor, consultant): the last hours month on the file.
function pairLastMonths(records) {
  const last = new Map();
  for (const r of records) {
    if (!r.subvendor_id || !r.consultant_id) continue;
    const key = r.subvendor_id + '|' + r.consultant_id;
    if (!last.get(key) || r.period_month > last.get(key)) last.set(key, r.period_month);
  }
  return last;
}

function paidInvoice(rec) {
  const ym = rec.period_month.slice(0, 7).replace('-', '');
  return {
    kind: 'paid',
    invoice_number: 'SVP-' + ym + '-' + (rec.subvendor_id || 'x') + '-' + (rec.consultant_id || 'x') + '-' + rec.row_id,
    paid_in: rec.paid_in, multi_month: rec.multi_month, label: rec.label,
    period_month: rec.period_month,
    subvendor_id: rec.subvendor_id, subvendor_name: rec.subvendor_name,
    consultant_id: rec.consultant_id, consultant_name: rec.consultant_name,
    rate: rec.rate, hours: rec.hours, amount: rec.amount,
    rate_source: 'ledger', net_terms: null, issue_date: null, due_date: null,
    client_tag: rec.client_tag || null, project: null,
    paid_date: rec.paid_date, status: 'paid', payment_status: 'paid', timesheet_submitted: null, notes: null,
  };
}

// GET /api/subvendor-invoices?periodMonth=YYYY-MM&subvendorId=&kind=paid|generated
router.get('/', async (req, res, next) => {
  try {
    const organizationId = req.user.organization_id;
    let periodMonth = null;
    if (req.query.periodMonth) {
      periodMonth = normalizePeriodMonth(req.query.periodMonth);
      if (!periodMonth) return res.status(400).json({ error: 'periodMonth must look like YYYY-MM.' });
    }
    if (req.query.kind && !['paid', 'generated'].includes(req.query.kind)) {
      return res.status(400).json({ error: 'kind must be paid or generated.' });
    }
    const subvendorId = req.query.subvendorId ? Number(req.query.subvendorId) : null;

    const { imp, records, unreadable } = await ledgerMonthlyRecords(pool, organizationId);
    const paidKeys = new Set(records.filter((r) => r.subvendor_id && r.consultant_id)
      .map((r) => r.subvendor_id + '|' + r.consultant_id + '|' + r.period_month));

    const [genRows] = await pool.query(
      `SELECT i.*, c.name AS consultant_name, c.status AS consultant_status, s.name AS subvendor_name,
              cl.name AS project_client, pr.name AS project_vendor
       FROM subvendor_invoices i
       JOIN consultants c ON c.id = i.consultant_id
       JOIN subvendors s ON s.id = i.subvendor_id
       LEFT JOIN consultant_assignments ca ON ca.id = i.assignment_id
       LEFT JOIN clients cl ON cl.id = ca.client_id
       LEFT JOIN programs pr ON pr.id = ca.program_id
       WHERE i.organization_id = ?`,
      [organizationId]
    );
    // Once the real payment for a generated month shows up on the Ledger
    // file, that payment replaces the projection.
    const keyOf = (sv, co, pm) => sv + '|' + co + '|' + pm;
    // A payments-file row the user edited is stored as an override and replaces the file's row.
    const overrideKeys = new Set(genRows.filter((g) => g.overrides_ledger).map((g) => keyOf(g.subvendor_id, g.consultant_id, dateStr(g.period_month))));
    const paid = records.map(paidInvoice).filter((p) => !overrideKeys.has(keyOf(p.subvendor_id, p.consultant_id, p.period_month)));
    const generated = genRows
      .map((g) => ({
        kind: 'generated', id: g.id, invoice_number: g.invoice_number,
        period_month: dateStr(g.period_month),
        subvendor_id: g.subvendor_id, subvendor_name: g.subvendor_name,
        consultant_id: g.consultant_id, consultant_name: g.consultant_name, consultant_status: g.consultant_status,
        rate: Number(g.rate), hours: Number(g.hours), amount: Number(g.amount),
        rate_source: g.rate_source, net_terms: g.net_terms,
        issue_date: dateStr(g.issue_date), due_date: dateStr(g.due_date),
        paid_date: g.paid_date ? dateStr(g.paid_date) : null, overrides_ledger: !!g.overrides_ledger,
        status: g.payment_status, payment_status: g.payment_status,
        timesheet_submitted: g.timesheet_submitted, notes: g.notes,
        assignment_id: g.assignment_id, project: g.project_client ? (g.project_vendor ? g.project_client + ' / ' + g.project_vendor : g.project_client) : null,
        client_tag: g.project_client || null,
      }))
      .filter((g) => g.overrides_ledger || !paidKeys.has(keyOf(g.subvendor_id, g.consultant_id, g.period_month)));

    let invoices = paid.concat(generated);
    if (periodMonth) invoices = invoices.filter((i) => i.period_month === periodMonth);
    if (subvendorId) invoices = invoices.filter((i) => i.subvendor_id === subvendorId);
    if (req.query.kind) invoices = invoices.filter((i) => i.kind === req.query.kind);

    invoices.sort((a, b) =>
      b.period_month.localeCompare(a.period_month) ||
      String(a.subvendor_name).localeCompare(String(b.subvendor_name)) ||
      String(a.consultant_name).localeCompare(String(b.consultant_name)));

    const subvendors = [...new Map(paid.concat(generated)
      .filter((i) => i.subvendor_id).map((i) => [i.subvendor_id, i.subvendor_name])).entries()]
      .map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      invoices,
      subvendors,
      generationStart: generationStartMonth(records),
      unreadable,
      ledgerFile: imp ? { file_name: imp.file_name, imported_at: imp.imported_at } : null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/subvendor-invoices/generate
// body: { periodMonth: 'YYYY-MM' (after the payments file's last month), netTerms: 'NET30',
//         issueDate: 'YYYY-MM-DD' (default: last day of the month), includeInactive: false }
// One invoice per (subvendor, consultant) pairing found on the latest Ledger
// file or, for Subvendor-employment rows, the latest Margin file. Rate =
// the pairing's most recent Ledger rate, else its Margin cost rate. Hours =
// the month's maximum billable hours, amount = rate x hours (both editable
// afterwards). Only Active consultants unless includeInactive. Idempotent
// per month.
router.post('/generate', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const body = req.body || {};
    const periodMonth = normalizePeriodMonth(body.periodMonth);
    if (!periodMonth) return res.status(400).json({ error: 'periodMonth must look like YYYY-MM.' });
    const netTerms = normalizeNetTerms(body.netTerms);
    if (!netTerms) return res.status(400).json({ error: 'netTerms must look like NET30.' });
    const issueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.issueDate || '')) ? body.issueDate : lastDayOfMonth(periodMonth);
    const dueDate = addDays(issueDate, Number(/\d+/.exec(netTerms)[0]));
    const includeInactive = isTruthyFlag(body.includeInactive);
    const organizationId = req.user.organization_id;
    const billable = maxBillableHours(periodMonth);

    // pairing key -> { subvendor_id, consultant_id, rate, source, ratePeriod }
    const pairs = new Map();
    const { records } = await ledgerMonthlyRecords(conn, organizationId);
    const lastByPair = pairLastMonths(records);
    for (const r of records) {
      if (!r.subvendor_id || !r.consultant_id) continue;
      const key = r.subvendor_id + '|' + r.consultant_id;
      let p = pairs.get(key);
      if (!p) { p = { subvendor_id: r.subvendor_id, consultant_id: r.consultant_id, rate: null, source: null, ratePeriod: '' }; pairs.set(key, p); }
      if (r.rate !== null && r.period_month >= p.ratePeriod) { p.rate = r.rate; p.source = 'ledger'; p.ratePeriod = r.period_month; }
    }
    const marginImp = await latestImport(conn, 'margin_imports', organizationId);
    if (marginImp) {
      const [marginRows] = await conn.query(
        `SELECT subvendor_id, consultant_id, cost FROM margin_roster_entries
         WHERE import_id = ? AND organization_id = ? AND employment_type = 'Subvendor'
           AND subvendor_id IS NOT NULL AND consultant_id IS NOT NULL`,
        [marginImp.id, organizationId]
      );
      for (const m of marginRows) {
        const key = m.subvendor_id + '|' + m.consultant_id;
        let p = pairs.get(key);
        if (!p) { p = { subvendor_id: m.subvendor_id, consultant_id: m.consultant_id, rate: null, source: null, ratePeriod: '' }; pairs.set(key, p); }
        if (p.rate === null && m.cost !== null) { p.rate = Number(m.cost); p.source = 'margin'; }
      }
    }

    // Placements are the source of truth: every active placement with a supplier and a pay rate gets
    // its own line each month at that placement's pay rate (a consultant on several projects through
    // one supplier gets one line per project). Older file-derived pairs only fill in for pairs that
    // have no placement.
    const [placementRows] = await conn.query(
      `SELECT a.id, a.consultant_id, a.supplier_id, a.pay_rate, a.source FROM consultant_assignments a
       WHERE a.organization_id = ? AND a.supplier_id IS NOT NULL AND a.pay_rate IS NOT NULL AND a.status = 'active'`, [organizationId]);
    const placementPairKeys = new Set(placementRows.map((a) => a.supplier_id + '|' + a.consultant_id));
    // A placement a person entered or edited in the app uses its own pay rate. A placement seeded from a
    // file keeps using the pair's latest Ledger rate when there is one (the file's newer rate wins over
    // the Margin cost), else its pay rate.
    const placementEntries = placementRows.map((a) => {
      const legacy = pairs.get(a.supplier_id + '|' + a.consultant_id);
      if (a.source !== 'manual' && legacy && legacy.source === 'ledger' && legacy.rate !== null) {
        return { subvendor_id: a.supplier_id, consultant_id: a.consultant_id, rate: legacy.rate, source: 'ledger', assignmentId: a.id };
      }
      return { subvendor_id: a.supplier_id, consultant_id: a.consultant_id, rate: Number(a.pay_rate), source: a.source === 'manual' ? 'placement' : 'margin', assignmentId: a.id };
    });
    for (const k of [...pairs.keys()]) if (placementPairKeys.has(k)) pairs.delete(k);
    const ids = [...pairs.values()].map((x) => Object.assign({ assignmentId: 0 }, x)).concat(placementEntries);
    const names = { c: new Map(), s: new Map() };
    if (ids.length) {
      const [cRows] = await conn.query('SELECT id, name, status FROM consultants WHERE organization_id = ? AND id IN (?)', [organizationId, [...new Set(ids.map((p) => p.consultant_id))]]);
      cRows.forEach((c) => names.c.set(c.id, c));
      const [sRows] = await conn.query('SELECT id, name FROM subvendors WHERE organization_id = ? AND id IN (?)', [organizationId, [...new Set(ids.map((p) => p.subvendor_id))]]);
      sRows.forEach((s) => names.s.set(s.id, s));
    }

    const created = [];
    const skipped = [];
    await conn.beginTransaction();
    for (const p of ids) {
      const cons = names.c.get(p.consultant_id);
      const label = (cons ? cons.name : 'Unknown') + ' (' + (names.s.get(p.subvendor_id) ? names.s.get(p.subvendor_id).name : 'unknown subvendor') + ')';
      if (!cons) continue;
      if (!includeInactive && cons.status !== 'active') {
        skipped.push({ consultant: label, reason: cons.status === 'inactive' ? 'consultant is inactive' : 'consultant status not set', inactive: true });
        continue;
      }
      const lastMonth = lastByPair.get(p.subvendor_id + '|' + p.consultant_id);
      if (lastMonth && periodMonth <= lastMonth) {
        skipped.push({ consultant: label, reason: 'already on the payments file through ' + monthName(lastMonth) });
        continue;
      }
      if (p.rate === null) {
        skipped.push({ consultant: label, reason: 'no pay rate set' });
        continue;
      }
      const [existing] = await conn.query(
        `SELECT id FROM subvendor_invoices WHERE organization_id = ? AND subvendor_id = ? AND consultant_id = ? AND period_month = ?
           AND (assignment_key = ? OR assignment_key = 0)`,
        [organizationId, p.subvendor_id, p.consultant_id, periodMonth, p.assignmentId]
      );
      if (existing.length) {
        skipped.push({ consultant: label, reason: 'already generated for this month' });
        continue;
      }
      const amount = Math.round(p.rate * billable.hours * 100) / 100;
      const [result] = await conn.query(
        `INSERT INTO subvendor_invoices
           (organization_id, invoice_number, subvendor_id, consultant_id, period_month, rate, hours, amount,
            rate_source, net_terms, issue_date, due_date, assignment_id, assignment_key)
         VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [organizationId, p.subvendor_id, p.consultant_id, periodMonth, p.rate, billable.hours, amount, p.source, netTerms, issueDate, dueDate, p.assignmentId || null, p.assignmentId]
      );
      await conn.query('UPDATE subvendor_invoices SET invoice_number = ? WHERE id = ?',
        ['SVI-' + periodMonth.slice(0, 7).replace('-', '') + '-' + String(result.insertId).padStart(5, '0'), result.insertId]);
      created.push(result.insertId);
    }
    await conn.commit();

    const createdInvoices = created.length
      ? (await conn.query('SELECT * FROM subvendor_invoices WHERE id IN (?)', [created]))[0] : [];
    res.status(201).json({
      created: createdInvoices, skipped,
      skippedInactive: skipped.filter((s) => s.inactive).length,
      includeInactive, defaultHours: billable.hours, billableDays: billable.billableDays, holidays: billable.holidays,
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* no-op */ }
    next(err);
  } finally {
    conn.release();
  }
});

// PATCH /api/subvendor-invoices/:id -- generated invoices only (file-sourced
// paid months have no id). Editable: hours, amount, netTerms, dueDate,
// issueDate, paymentStatus, timesheetSubmitted, notes. Same rules as client
// invoices: sending hours without amount recomputes amount = rate x hours; an
// explicit amount always wins.
router.patch('/:id', async (req, res, next) => {
  try {
    const [existingRows] = await pool.query(
      'SELECT * FROM subvendor_invoices WHERE id = ? AND organization_id = ?',
      [req.params.id, req.user.organization_id]
    );
    if (!existingRows.length) return res.status(404).json({ error: 'Not found.' });
    const existing = existingRows[0];
    const body = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const sets = [];
    const params = [];

    let hours = existing.hours;
    if (has('hours')) {
      hours = toNullableNumber(body.hours);
      if (body.hours !== null && body.hours !== undefined && body.hours !== '' && hours === null) {
        return res.status(400).json({ error: 'hours must be a number.' });
      }
      sets.push('hours = ?'); params.push(hours);
    }
    if (has('amount')) {
      const amount = toNullableNumber(body.amount);
      if (body.amount !== null && body.amount !== undefined && body.amount !== '' && amount === null) {
        return res.status(400).json({ error: 'amount must be a number.' });
      }
      sets.push('amount = ?'); params.push(amount);
    } else if (has('hours')) {
      sets.push('amount = ?');
      params.push(hours !== null ? Math.round(Number(existing.rate) * hours * 100) / 100 : null);
    }
    if (has('rate')) {
      const rate = toNullableNumber(body.rate);
      if (rate === null || rate < 0) return res.status(400).json({ error: 'rate must be a number.' });
      sets.push('rate = ?'); params.push(rate);
      // A new rate re-prices the hours unless an amount was typed in the same change.
      if (!has('amount') && !has('hours') && existing.hours !== null) {
        sets.push('amount = ?'); params.push(Math.round(rate * Number(existing.hours) * 100) / 100);
      }
    }
    if (has('subvendorId')) {
      const [sv] = await pool.query('SELECT id FROM subvendors WHERE id = ? AND organization_id = ?', [body.subvendorId, req.user.organization_id]);
      if (!sv.length) return res.status(400).json({ error: 'Unknown supplier company.' });
      sets.push('subvendor_id = ?'); params.push(sv[0].id);
    }
    if (has('periodMonth')) {
      const pm = normalizePeriodMonth(body.periodMonth);
      if (!pm) return res.status(400).json({ error: 'periodMonth must look like YYYY-MM.' });
      sets.push('period_month = ?'); params.push(pm);
    }
    if (has('invoiceNumber')) {
      const no = String(body.invoiceNumber || '').trim();
      if (!no || no.length > 64) return res.status(400).json({ error: 'Invoice number is required (64 characters at most).' });
      sets.push('invoice_number = ?'); params.push(no);
    }
    if (has('paidDate')) {
      if (body.paidDate !== null && body.paidDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.paidDate))) return res.status(400).json({ error: 'paidDate must look like YYYY-MM-DD.' });
      sets.push('paid_date = ?'); params.push(body.paidDate || null);
    }
    if (has('netTerms')) {
      const netTerms = normalizeNetTerms(body.netTerms);
      if (!netTerms) return res.status(400).json({ error: 'netTerms must look like NET30.' });
      sets.push('net_terms = ?'); params.push(netTerms);
    }
    for (const [key, col] of [['issueDate', 'issue_date'], ['dueDate', 'due_date']]) {
      if (has(key)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body[key] || ''))) return res.status(400).json({ error: key + ' must look like YYYY-MM-DD.' });
        sets.push(col + ' = ?'); params.push(body[key]);
      }
    }
    if (has('paymentStatus')) {
      if (!['paid', 'unpaid'].includes(body.paymentStatus)) return res.status(400).json({ error: 'paymentStatus must be paid or unpaid.' });
      sets.push('payment_status = ?'); params.push(body.paymentStatus);
      if (!has('paidDate')) { sets.push('paid_date = ?'); params.push(body.paymentStatus === 'paid' ? (existing.paid_date || toDateOnly(new Date())) : null); }
    }
    if (has('timesheetSubmitted')) {
      if (!['yes', 'no'].includes(body.timesheetSubmitted)) return res.status(400).json({ error: 'timesheetSubmitted must be yes or no.' });
      sets.push('timesheet_submitted = ?'); params.push(body.timesheetSubmitted);
    }
    if (has('notes')) {
      sets.push('notes = ?');
      params.push(body.notes === null || body.notes === undefined ? null : String(body.notes).slice(0, 1000));
    }
    if (!sets.length) return res.json({ invoice: existing });

    params.push(req.params.id, req.user.organization_id);
    try {
      await pool.query(`UPDATE subvendor_invoices SET ${sets.join(', ')} WHERE id = ? AND organization_id = ?`, params);
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Another payment already exists for that supplier, consultant and month (or that invoice number is taken).' });
      throw err;
    }
    const [rows] = await pool.query('SELECT i.*, s.name AS subvendor_name FROM subvendor_invoices i JOIN subvendors s ON s.id = i.subvendor_id WHERE i.id = ?', [req.params.id]);
    res.json({ invoice: rows[0] });
  } catch (err) {
    next(err);
  }
});


// POST /api/subvendor-invoices -- add a supplier payment by hand.
// body: { subvendorId, consultantId, periodMonth 'YYYY-MM', rate, hours?, amount?, netTerms?, issueDate?, dueDate?, paymentStatus?, notes? }
router.post('/', async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const b = req.body || {};
    const periodMonth = normalizePeriodMonth(b.periodMonth);
    if (!periodMonth) return res.status(400).json({ error: 'Choose the month.' });
    const rate = toNullableNumber(b.rate);
    if (rate === null || rate < 0) return res.status(400).json({ error: 'Enter the $/hr rate.' });
    const hours = b.hours === undefined || b.hours === null || b.hours === '' ? null : toNullableNumber(b.hours);
    if (b.hours !== undefined && b.hours !== null && b.hours !== '' && hours === null) return res.status(400).json({ error: 'hours must be a number.' });
    let amount = b.amount === undefined || b.amount === null || b.amount === '' ? null : toNullableNumber(b.amount);
    if (b.amount !== undefined && b.amount !== null && b.amount !== '' && amount === null) return res.status(400).json({ error: 'amount must be a number.' });
    if (amount === null && hours !== null) amount = Math.round(rate * hours * 100) / 100;
    const netTerms = normalizeNetTerms(b.netTerms);
    if (!netTerms) return res.status(400).json({ error: 'netTerms must look like NET30.' });
    const issueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.issueDate || '')) ? b.issueDate : lastDayOfMonth(periodMonth);
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.dueDate || '')) ? b.dueDate : addDays(issueDate, Number(netTerms.slice(3)));
    const status = b.paymentStatus === 'paid' ? 'paid' : 'unpaid';
    // Names work too (the Ledger page types them): found by exact name, created when new.
    let svId = b.subvendorId; let coId = b.consultantId;
    if (!svId && b.subvendorName) { const r = await findOrCreateDirectoryRecord(pool, 'subvendors', { organizationId: orgId, name: b.subvendorName, status: 'active' }); svId = r && r.id; }
    if (!coId && b.consultantName) { const r = await findOrCreateDirectoryRecord(pool, 'consultants', { organizationId: orgId, name: b.consultantName, status: 'active' }); coId = r && r.id; }
    const [sv] = await pool.query('SELECT id FROM subvendors WHERE id = ? AND organization_id = ?', [svId, orgId]);
    if (!sv.length) return res.status(400).json({ error: 'Choose a supplier company.' });
    const [co] = await pool.query('SELECT id FROM consultants WHERE id = ? AND organization_id = ?', [coId, orgId]);
    if (!co.length) return res.status(400).json({ error: 'Choose a consultant.' });
    let assignmentId = 0;
    if (b.assignmentId) {
      const [as] = await pool.query('SELECT id FROM consultant_assignments WHERE id = ? AND organization_id = ? AND consultant_id = ?', [b.assignmentId, orgId, co[0].id]);
      if (!as.length) return res.status(400).json({ error: 'That project isn’t one of this consultant’s placements.' });
      assignmentId = as[0].id;
    }
    let result;
    try {
      [result] = await pool.query(
        `INSERT INTO subvendor_invoices (organization_id, invoice_number, subvendor_id, consultant_id, period_month, rate, hours, amount,
           rate_source, net_terms, issue_date, due_date, payment_status, paid_date, notes, assignment_id, assignment_key)
         VALUES (?, '', ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orgId, sv[0].id, co[0].id, periodMonth, rate, hours, amount, netTerms, issueDate, dueDate, status,
          status === 'paid' ? toDateOnly(new Date()) : null, b.notes ? String(b.notes).slice(0, 1000) : null, assignmentId || null, assignmentId]);
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A payment for that supplier, consultant and month already exists. Edit it instead.' });
      throw err;
    }
    await pool.query('UPDATE subvendor_invoices SET invoice_number = ? WHERE id = ?',
      ['SVI-' + periodMonth.slice(0, 7).replace('-', '') + '-' + String(result.insertId).padStart(5, '0'), result.insertId]);
    res.status(201).json({ id: result.insertId });
  } catch (err) { next(err); }
});

// POST /api/subvendor-invoices/from-ledger -- make an editable copy of a payments-file month.
// body: { subvendorId, consultantId, periodMonth }. The copy replaces the file's row(s) in the list;
// deleting it brings the file's row back. The uploaded file itself is never changed.
router.post('/from-ledger', async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const b = req.body || {};
    const periodMonth = normalizePeriodMonth(b.periodMonth);
    if (!periodMonth) return res.status(400).json({ error: 'periodMonth must look like YYYY-MM.' });
    const { records } = await ledgerMonthlyRecords(pool, orgId);
    const hits = records.filter((r) => String(r.subvendor_id) === String(b.subvendorId) && String(r.consultant_id) === String(b.consultantId) && r.period_month === periodMonth.slice(0, 7) + '-01');
    if (!hits.length) return res.status(404).json({ error: 'That month is not on the payments file.' });
    const [dup] = await pool.query(
      'SELECT id FROM subvendor_invoices WHERE organization_id = ? AND subvendor_id = ? AND consultant_id = ? AND period_month = ?',
      [orgId, hits[0].subvendor_id, hits[0].consultant_id, periodMonth]);
    const sum = (k) => hits.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    const hrs = hits.some((r) => r.hours !== null && r.hours !== undefined) ? Math.round(sum('hours') * 100) / 100 : null;
    const amt = Math.round(sum('amount') * 100) / 100;
    const issue = lastDayOfMonth(periodMonth);
    const paidDate = hits[0].paid_date ? String(hits[0].paid_date).slice(0, 10) : null;
    if (dup.length) {
      // A generated projection already sits on this month (the file's payment hides it): adopt the file's figures.
      await pool.query(
        `UPDATE subvendor_invoices SET overrides_ledger = 1, payment_status = 'paid', rate = ?, hours = ?, amount = ?, paid_date = ?, rate_source = 'ledger'
          WHERE id = ? AND organization_id = ?`, [Number(hits[0].rate) || 0, hrs, amt, paidDate, dup[0].id, orgId]);
      return res.json({ id: dup[0].id, existing: true });
    }
    const [result] = await pool.query(
      `INSERT INTO subvendor_invoices (organization_id, invoice_number, subvendor_id, consultant_id, period_month, rate, hours, amount,
         rate_source, net_terms, issue_date, due_date, payment_status, paid_date, notes, overrides_ledger)
       VALUES (?, '', ?, ?, ?, ?, ?, ?, 'ledger', 'NET30', ?, ?, 'paid', ?, ?, 1)`,
      [orgId, hits[0].subvendor_id, hits[0].consultant_id, periodMonth, Number(hits[0].rate) || 0, hrs, amt, issue, addDays(issue, 30), paidDate,
        hits.length > 1 ? `Edited copy of ${hits.length} payments-file rows (amounts and hours added together).` : 'Edited copy of the payments-file row.']);
    await pool.query('UPDATE subvendor_invoices SET invoice_number = ? WHERE id = ?',
      ['SVI-' + periodMonth.slice(0, 7).replace('-', '') + '-' + String(result.insertId).padStart(5, '0'), result.insertId]);
    res.status(201).json({ id: result.insertId });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM subvendor_invoices WHERE id = ? AND organization_id = ?',
      [req.params.id, req.user.organization_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.parseHoursMonth = parseHoursMonth;
module.exports.ledgerMonthlyRecords = ledgerMonthlyRecords;
module.exports.latestImport = latestImport;
