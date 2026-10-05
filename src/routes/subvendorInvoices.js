// Fin-Module "Subvendor payments" API: read-only invoices from subvendors to
// Mentour, one per (subvendor, consultant, month). Every route is scoped to
// req.user.organization_id.
//
// Two sources, merged into one list:
//   * kind 'paid'      -- months already paid, derived live from the latest
//                         Ledger upload's ledger_roster_entries (the "2026 sub
//                         vendor payments" file). Never copied anywhere, so it
//                         can't drift from the file; there's nothing to edit.
//   * kind 'generated' -- months from December 2026 onwards, created by POST
//                         /generate from the $/hr rate on the Ledger file, or
//                         (no Ledger rate for the pairing) the Margin file's
//                         cost rate. Stored in subvendor_invoices.
// There is intentionally no PATCH/DELETE: these invoices are uneditable.
// See the subvendor_invoices comment in db/schema.sql.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { maxBillableHours } = require('./invoices');

const router = express.Router();
router.use(requireAuth);

const GENERATION_START = '2026-12-01';
const NET_TERMS_RE = /^NET\d{1,3}$/i;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_LABEL_RE = /^\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s\-_']*((?:19|20)\d{2}|\d{2})?\s*$/i;

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
function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  return String(v).slice(0, 10);
}

// A Ledger sheet name ("Jan", "January 2026", "Jan-26") -> 'YYYY-MM-01', or
// null for anything that isn't a month ("Left", "Sheet1"). A label with no
// year takes the year in the file name ("2026 Sub Vendor Payments.xlsx"),
// else the year the file was uploaded.
function parseMonthLabel(label, fallbackYear) {
  const m = MONTH_LABEL_RE.exec(String(label || ''));
  if (!m) return null;
  let year = fallbackYear;
  if (m[2]) year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return year + '-' + pad2(MONTHS[m[1].toLowerCase()]) + '-01';
}

async function latestImport(conn, table, organizationId) {
  const [rows] = await conn.query(
    `SELECT id, file_name, imported_at FROM ${table} WHERE organization_id = ? ORDER BY imported_at DESC, id DESC LIMIT 1`,
    [organizationId]
  );
  if (!rows.length) return null;
  const imp = rows[0];
  const fileYear = /(20\d{2})/.exec(imp.file_name || '');
  imp.year = fileYear ? Number(fileYear[1]) : new Date(imp.imported_at).getFullYear();
  return imp;
}

// The latest Ledger upload as one record per (subvendor, consultant, month):
// amounts and hours summed across that month's lines, rate = the last
// non-null one in file order.
async function ledgerMonthlyRecords(conn, organizationId) {
  const imp = await latestImport(conn, 'ledger_imports', organizationId);
  if (!imp) return { imp: null, records: [] };

  const [rows] = await conn.query(
    `SELECT l.id, l.consultant_id, l.subvendor_id, l.name, l.subvendor_text, l.month_label,
            l.amount, l.rate, l.hours, l.paid_date,
            c.name AS consultant_name, c.status AS consultant_status, s.name AS subvendor_name
     FROM ledger_roster_entries l
     LEFT JOIN consultants c ON c.id = l.consultant_id
     LEFT JOIN subvendors s ON s.id = l.subvendor_id
     WHERE l.import_id = ? AND l.organization_id = ?
     ORDER BY l.id`,
    [imp.id, organizationId]
  );

  const byKey = new Map();
  for (const r of rows) {
    const period = parseMonthLabel(r.month_label, imp.year);
    if (!period) continue;
    const subKey = r.subvendor_id ? 'id' + r.subvendor_id : 'txt:' + String(r.subvendor_text || '').trim().toLowerCase();
    const conKey = r.consultant_id ? 'id' + r.consultant_id : 'txt:' + String(r.name || '').trim().toLowerCase();
    const key = subKey + '|' + conKey + '|' + period;
    let rec = byKey.get(key);
    if (!rec) {
      rec = {
        key, period_month: period,
        subvendor_id: r.subvendor_id, subvendor_name: r.subvendor_name || r.subvendor_text || '(unspecified)',
        consultant_id: r.consultant_id, consultant_name: r.consultant_name || r.name,
        consultant_status: r.consultant_status,
        rate: null, hours: null, amount: null, paid_date: null,
      };
      byKey.set(key, rec);
    }
    if (r.amount !== null) rec.amount = (rec.amount || 0) + Number(r.amount);
    if (r.hours !== null) rec.hours = (rec.hours || 0) + Number(r.hours);
    if (r.rate !== null) rec.rate = Number(r.rate);
    const pd = dateStr(r.paid_date);
    if (pd && (!rec.paid_date || pd > rec.paid_date)) rec.paid_date = pd;
  }
  return { imp, records: [...byKey.values()] };
}

function paidInvoice(rec) {
  const ym = rec.period_month.slice(0, 7).replace('-', '');
  return {
    kind: 'paid',
    invoice_number: 'SVP-' + ym + '-' + (rec.subvendor_id || 'x') + '-' + (rec.consultant_id || 'x'),
    period_month: rec.period_month,
    subvendor_id: rec.subvendor_id, subvendor_name: rec.subvendor_name,
    consultant_id: rec.consultant_id, consultant_name: rec.consultant_name,
    rate: rec.rate, hours: rec.hours, amount: rec.amount,
    rate_source: 'ledger', net_terms: null, issue_date: null, due_date: null,
    paid_date: rec.paid_date, status: 'paid',
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

    const { imp, records } = await ledgerMonthlyRecords(pool, organizationId);
    const paid = records.map(paidInvoice);
    const paidKeys = new Set(records.filter((r) => r.subvendor_id && r.consultant_id)
      .map((r) => r.subvendor_id + '|' + r.consultant_id + '|' + r.period_month));

    const [genRows] = await pool.query(
      `SELECT i.*, c.name AS consultant_name, c.status AS consultant_status, s.name AS subvendor_name
       FROM subvendor_invoices i
       JOIN consultants c ON c.id = i.consultant_id
       JOIN subvendors s ON s.id = i.subvendor_id
       WHERE i.organization_id = ?`,
      [organizationId]
    );
    // Once the real payment for a generated month shows up on the Ledger
    // file, that payment replaces the projection.
    const generated = genRows
      .map((g) => ({
        kind: 'generated', id: g.id, invoice_number: g.invoice_number,
        period_month: dateStr(g.period_month),
        subvendor_id: g.subvendor_id, subvendor_name: g.subvendor_name,
        consultant_id: g.consultant_id, consultant_name: g.consultant_name, consultant_status: g.consultant_status,
        rate: Number(g.rate), hours: Number(g.hours), amount: Number(g.amount),
        rate_source: g.rate_source, net_terms: g.net_terms,
        issue_date: dateStr(g.issue_date), due_date: dateStr(g.due_date),
        paid_date: null, status: 'scheduled',
      }))
      .filter((g) => !paidKeys.has(g.subvendor_id + '|' + g.consultant_id + '|' + g.period_month));

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
      generationStart: GENERATION_START.slice(0, 7),
      ledgerFile: imp ? { file_name: imp.file_name, imported_at: imp.imported_at } : null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/subvendor-invoices/generate
// body: { periodMonth: 'YYYY-MM' (December 2026 or later), netTerms: 'NET30',
//         issueDate: 'YYYY-MM-DD' (default: last day of the month), includeInactive: false }
// One invoice per (subvendor, consultant) pairing found on the latest Ledger
// file or, for Subvendor-employment rows, the latest Margin file. Rate =
// the pairing's most recent Ledger rate, else its Margin cost rate. Hours =
// the month's maximum billable hours, amount = rate x hours. Only Active
// consultants unless includeInactive. Idempotent per month.
router.post('/generate', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const body = req.body || {};
    const periodMonth = normalizePeriodMonth(body.periodMonth);
    if (!periodMonth) return res.status(400).json({ error: 'periodMonth must look like YYYY-MM.' });
    if (periodMonth < GENERATION_START) {
      return res.status(400).json({ error: 'Months before December 2026 come from the payments file and can’t be generated.' });
    }
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

    const ids = [...pairs.values()];
    const names = { c: new Map(), s: new Map() };
    if (ids.length) {
      const [cRows] = await conn.query('SELECT id, name, status FROM consultants WHERE organization_id = ? AND id IN (?)', [organizationId, [...new Set(ids.map((p) => p.consultant_id))]]);
      cRows.forEach((c) => names.c.set(c.id, c));
      const [sRows] = await conn.query('SELECT id, name FROM subvendors WHERE organization_id = ? AND id IN (?)', [organizationId, [...new Set(ids.map((p) => p.subvendor_id))]]);
      sRows.forEach((s) => names.s.set(s.id, s));
    }
    // A real payment already on the Ledger file for this month needs no invoice.
    const paidThisMonth = new Set(records.filter((r) => r.period_month === periodMonth && r.subvendor_id && r.consultant_id)
      .map((r) => r.subvendor_id + '|' + r.consultant_id));

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
      if (p.rate === null) {
        skipped.push({ consultant: label, reason: 'no rate on the Ledger or Margin file' });
        continue;
      }
      if (paidThisMonth.has(p.subvendor_id + '|' + p.consultant_id)) {
        skipped.push({ consultant: label, reason: 'already paid on the Ledger file for this month' });
        continue;
      }
      const [existing] = await conn.query(
        `SELECT id FROM subvendor_invoices WHERE organization_id = ? AND subvendor_id = ? AND consultant_id = ? AND period_month = ?`,
        [organizationId, p.subvendor_id, p.consultant_id, periodMonth]
      );
      if (existing.length) {
        skipped.push({ consultant: label, reason: 'already generated for this month' });
        continue;
      }
      const amount = Math.round(p.rate * billable.hours * 100) / 100;
      const [result] = await conn.query(
        `INSERT INTO subvendor_invoices
           (organization_id, invoice_number, subvendor_id, consultant_id, period_month, rate, hours, amount,
            rate_source, net_terms, issue_date, due_date)
         VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [organizationId, p.subvendor_id, p.consultant_id, periodMonth, p.rate, billable.hours, amount, p.source, netTerms, issueDate, dueDate]
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

module.exports = router;
module.exports.parseMonthLabel = parseMonthLabel;
