// Fin-Module API: generate and manage monthly invoices from each
// consultant's billing assignments (consultant_assignments -- see
// assignmentUpsert.js and db/schema.sql). Every route is scoped to
// req.user.organization_id, exactly like directory.js.
//
// One invoice per (consultant, client, program) pairing per calendar month
// -- see the comment on the invoices table in db/schema.sql for the full
// design (bill-to fallback, hours/amount editing, idempotent generation).

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { normalizeName } = require('./directoryUpsert');

const router = express.Router();
router.use(requireAuth);

const NET_TERMS_RE = /^NET\d{1,3}$/i;

function netTermsDays(netTerms) {
  const m = /^NET(\d{1,3})$/i.exec(String(netTerms || '').trim());
  return m ? Number(m[1]) : 30;
}

function normalizeNetTerms(value) {
  if (value === undefined || value === null || value === '') return 'NET30';
  const s = String(value).trim().toUpperCase();
  return NET_TERMS_RE.test(s) ? s : null;
}

// First-of-month DATE string from a "YYYY-MM" or "YYYY-MM-DD" input (or the
// current month when omitted).
function normalizePeriodMonth(value) {
  let y, mo;
  if (value) {
    const m = /^(\d{4})-(\d{2})/.exec(String(value));
    if (!m) return null;
    y = Number(m[1]);
    mo = Number(m[2]);
  } else {
    const now = new Date();
    y = now.getUTCFullYear();
    mo = now.getUTCMonth() + 1;
  }
  if (mo < 1 || mo > 12) return null;
  return y + '-' + String(mo).padStart(2, '0') + '-01';
}

function toDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days));
  return toDateOnly(d);
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---- Maximum billable hours -------------------------------------------
// Default hours on a newly generated invoice = (weekdays in the month minus
// US federal holidays observed on a weekday that month) x 8. Holidays are
// computed for any year -- no hardcoded list -- using OPM's observed-date
// rule: a holiday on a Saturday is observed the Friday before, one on a
// Sunday the Monday after. The 11 federal holidays:
//   New Year's Day (Jan 1), MLK Day (3rd Mon Jan), Presidents' Day (3rd Mon
//   Feb), Memorial Day (last Mon May), Juneteenth (Jun 19), Independence Day
//   (Jul 4), Labor Day (1st Mon Sep), Columbus Day (2nd Mon Oct), Veterans
//   Day (Nov 11), Thanksgiving (4th Thu Nov), Christmas (Dec 25).
const HOURS_PER_DAY = 8;

function ymd(y, m, d) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// nth (1-based) given weekday (0=Sun..6=Sat) of month m (1-12); n = -1 = last.
function nthWeekday(y, m, weekday, n) {
  if (n === -1) {
    const last = new Date(Date.UTC(y, m, 0));
    const back = (last.getUTCDay() - weekday + 7) % 7;
    return toDateOnly(new Date(Date.UTC(y, m - 1, last.getUTCDate() - back)));
  }
  const first = new Date(Date.UTC(y, m - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return toDateOnly(new Date(Date.UTC(y, m - 1, 1 + offset + (n - 1) * 7)));
}

function observed(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  if (dow === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  else if (dow === 0) dt.setUTCDate(dt.getUTCDate() + 1);
  return toDateOnly(dt);
}

// Observed dates (YYYY-MM-DD) of the 11 US federal holidays for year y.
// Note an observed date can fall in the neighbouring year (e.g. Jan 1 2022,
// a Saturday, was observed Fri Dec 31 2021).
function usFederalHolidays(y) {
  return [
    { name: "New Year's Day", date: observed(y, 1, 1) },
    { name: 'Martin Luther King Jr. Day', date: nthWeekday(y, 1, 1, 3) },
    { name: "Presidents' Day", date: nthWeekday(y, 2, 1, 3) },
    { name: 'Memorial Day', date: nthWeekday(y, 5, 1, -1) },
    { name: 'Juneteenth', date: observed(y, 6, 19) },
    { name: 'Independence Day', date: observed(y, 7, 4) },
    { name: 'Labor Day', date: nthWeekday(y, 9, 1, 1) },
    { name: 'Columbus Day', date: nthWeekday(y, 10, 1, 2) },
    { name: 'Veterans Day', date: observed(y, 11, 11) },
    { name: 'Thanksgiving Day', date: nthWeekday(y, 11, 4, 4) },
    { name: 'Christmas Day', date: observed(y, 12, 25) },
  ];
}

// periodMonth: 'YYYY-MM-01'. Returns { weekdays, holidays: [...], billableDays, hours }.
function maxBillableHours(periodMonth) {
  const y = Number(String(periodMonth).slice(0, 4));
  const m = Number(String(periodMonth).slice(5, 7));
  const prefix = ymd(y, m, 1).slice(0, 8);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let weekdays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) weekdays++;
  }
  // Check y-1..y+1 so a cross-year observed date (Dec 31 for a Saturday
  // New Year's Day) lands in the right month.
  const holidays = [y - 1, y, y + 1]
    .flatMap(usFederalHolidays)
    .filter((h) => h.date.startsWith(prefix));
  const billableDays = weekdays - holidays.length; // observed dates are always weekdays
  return { weekdays, holidays, billableDays, hours: billableDays * HOURS_PER_DAY };
}

function isTruthyFlag(value) {
  return value === true || value === 1 || ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

async function nextInvoiceNumber(conn, organizationId, periodMonth, insertId) {
  const ym = String(periodMonth).slice(0, 7).replace('-', '');
  return 'INV-' + ym + '-' + String(insertId).padStart(5, '0');
}

// POST /api/invoices/generate
// body: { periodMonth: 'YYYY-MM' (default: current month), netTerms: 'NET30' (default),
//         issueDate: 'YYYY-MM-DD' (default: today), includeInactive: false (default) }
// Creates one invoice per (consultant, client, program) billing pairing that
// doesn't already have one for this period -- skipping pairings with no
// billing rate and pairings with neither a client nor a program (nothing to
// bill). Only consultants whose Directory status is Active are invoiced by
// default; includeInactive: true also invoices Inactive and not-yet-set
// (NULL) consultants. New invoices start at 0 hours / $0 (hours come from
// the person or the Import hours file); both stay
// editable. Safe to re-run for the same month: existing invoices -- and any
// hours/amount edited on them -- are left untouched.
router.post('/generate', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const body = req.body || {};
    const periodMonth = normalizePeriodMonth(body.periodMonth);
    if (!periodMonth) return res.status(400).json({ error: 'periodMonth must look like YYYY-MM.' });

    const netTerms = normalizeNetTerms(body.netTerms);
    if (!netTerms) return res.status(400).json({ error: 'netTerms must look like NET30.' });

    const issueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.issueDate || '')) ? body.issueDate : toDateOnly(new Date());
    const dueDate = addDays(issueDate, netTermsDays(netTerms));
    const organizationId = req.user.organization_id;
    const includeInactive = isTruthyFlag(body.includeInactive);
    // New invoices start at 0 hours / $0 until hours are typed in or imported from
    // an hours file (Import hours tab) -- no hours are assumed.
    const defaultHours = 0;

    const [assignments] = await conn.query(
      `SELECT a.id AS assignment_id, a.consultant_id, a.client_id, a.program_id, a.billing, a.status AS assignment_status, a.left_date,
         c.name AS consultant_name, c.status AS consultant_status,
         cl.name AS client_name, cl.email AS client_email, cl.phone AS client_phone, cl.address AS client_address,
         p.name AS program_name, p.email AS program_email, p.phone AS program_phone, p.address AS program_address
       FROM consultant_assignments a
       JOIN consultants c ON c.id = a.consultant_id
       LEFT JOIN clients cl ON cl.id = a.client_id
       LEFT JOIN programs p ON p.id = a.program_id
       WHERE a.organization_id = ?`,
      [organizationId]
    );

    const created = [];
    const skipped = [];

    await conn.beginTransaction();
    for (const a of assignments) {
      if (!includeInactive && a.consultant_status !== 'active') {
        skipped.push({
          assignmentId: a.assignment_id, consultant: a.consultant_name,
          reason: a.consultant_status === 'inactive' ? 'consultant is inactive' : 'consultant status not set',
          inactive: true,
        });
        continue;
      }
      if (a.assignment_status === 'left' && !includeInactive) {
        skipped.push({ assignmentId: a.assignment_id, consultant: a.consultant_name, reason: 'consultant left this client/program' });
        continue;
      }
      if (!a.client_id && !a.program_id) {
        skipped.push({ assignmentId: a.assignment_id, consultant: a.consultant_name, reason: 'no client or program to bill' });
        continue;
      }
      if (a.billing === null || a.billing === undefined) {
        skipped.push({ assignmentId: a.assignment_id, consultant: a.consultant_name, reason: 'no billing rate set' });
        continue;
      }

      const [existing] = await conn.query(
        `SELECT id FROM invoices
         WHERE organization_id = ? AND consultant_id = ? AND client_id <=> ? AND program_id <=> ? AND period_month = ?`,
        [organizationId, a.consultant_id, a.client_id, a.program_id, periodMonth]
      );
      if (existing.length) {
        skipped.push({ assignmentId: a.assignment_id, consultant: a.consultant_name, reason: 'already invoiced for this month', invoiceId: existing[0].id });
        continue;
      }

      // Bill to the Program; fall back to the Client when this pairing has
      // no program (see the invoices table comment in db/schema.sql).
      const billTo = a.program_id
        ? { name: a.program_name, email: a.program_email, phone: a.program_phone, address: a.program_address }
        : { name: a.client_name, email: a.client_email, phone: a.client_phone, address: a.client_address };

      const [result] = await conn.query(
        `INSERT INTO invoices
           (organization_id, invoice_number, consultant_id, client_id, program_id, assignment_id,
            period_month, rate, hours, amount, bill_to_name, bill_to_email, bill_to_phone, bill_to_address,
            net_terms, issue_date, due_date, payment_status, timesheet_submitted)
         VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', 'no')`,
        [
          organizationId, a.consultant_id, a.client_id, a.program_id, a.assignment_id,
          periodMonth, a.billing, defaultHours, Math.round(Number(a.billing) * defaultHours * 100) / 100,
          billTo.name, billTo.email, billTo.phone, billTo.address,
          netTerms, issueDate, dueDate,
        ]
      );
      const invoiceNumber = await nextInvoiceNumber(conn, organizationId, periodMonth, result.insertId);
      await conn.query('UPDATE invoices SET invoice_number = ? WHERE id = ?', [invoiceNumber, result.insertId]);
      created.push(result.insertId);
    }
    await conn.commit();

    const createdInvoices = created.length
      ? (await conn.query(`SELECT * FROM invoices WHERE id IN (?)`, [created]))[0]
      : [];

    const skippedInactive = skipped.filter((s) => s.inactive).length;
    res.status(201).json({
      created: createdInvoices,
      skipped,
      skippedInactive,
      includeInactive,
      defaultHours,
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* no-op */ }
    next(err);
  } finally {
    conn.release();
  }
});


// POST /api/invoices/import-hours
// Past (or periodic) invoices from an uploaded hours sheet. The browser reads
// the workbook and sends one row per consultant:
//   rows: [{ name, client, hours: { "1": 160, "2": 152, ... } }]   (month number -> hours)
//   year, netTerms (default NET30), paymentStatus ('paid'|'unpaid'), timesheetSubmitted ('yes'|'no'),
//   apply: false (default) previews, true creates.
// Each row is matched to a Directory consultant by name and to one of that
// consultant's billing pairings by the Client column ("Program/Client" like the
// Margin file, or just the client). Invoice = pairing's billing rate x the
// month's hours, issued on the last day of the month. Nothing is guessed: rows
// that don't match exactly one pairing are reported and skipped, and a month
// that already has an invoice with hours for that consultant/client/program is
// never overwritten (an invoice still at 0 hours is filled in). The apply step re-derives everything on the server in one
// transaction, so the preview a person confirmed is not trusted blindly.
const MAX_IMPORT_ROWS = 5000;
// Case-insensitive, whitespace-collapsed key (the database collation compares names the same way).
function nameKey(v) {
  const n = normalizeName(v);
  return n ? n.toLowerCase() : null;
}

router.post('/import-hours', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const body = req.body || {};
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows) return res.status(400).json({ error: 'rows must be a list.' });
    if (rows.length > MAX_IMPORT_ROWS) return res.status(400).json({ error: 'Too many rows (max ' + MAX_IMPORT_ROWS + ').' });
    const year = Number(body.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ error: 'year must look like 2026.' });
    const netTerms = normalizeNetTerms(body.netTerms);
    if (!netTerms) return res.status(400).json({ error: 'netTerms must look like NET30.' });
    const paymentStatus = body.paymentStatus === 'unpaid' ? 'unpaid' : 'paid';
    const timesheet = body.timesheetSubmitted === 'no' ? 'no' : 'yes';
    const apply = isTruthyFlag(body.apply);
    const organizationId = req.user.organization_id;

    const [consultants] = await conn.query('SELECT id, name FROM consultants WHERE organization_id = ?', [organizationId]);
    const byName = new Map();
    for (const c of consultants) {
      const k = nameKey(c.name);
      byName.set(k, byName.has(k) ? null : c); // null = two consultants share the name -> ambiguous
    }
    const [assignments] = await conn.query(
      `SELECT a.id AS assignment_id, a.consultant_id, a.client_id, a.program_id, a.billing,
         cl.name AS client_name, cl.email AS client_email, cl.phone AS client_phone, cl.address AS client_address,
         p.name AS program_name, p.email AS program_email, p.phone AS program_phone, p.address AS program_address
       FROM consultant_assignments a
       LEFT JOIN clients cl ON cl.id = a.client_id
       LEFT JOIN programs p ON p.id = a.program_id
       WHERE a.organization_id = ?`,
      [organizationId]
    );
    const byConsultant = new Map();
    for (const a of assignments) {
      if (!byConsultant.has(a.consultant_id)) byConsultant.set(a.consultant_id, []);
      byConsultant.get(a.consultant_id).push(a);
    }

    const unmatched = [];
    const planned = new Map(); // assignment|month -> plan item
    const dupKeys = new Set();
    const noRate = [];

    rows.forEach((r, idx) => {
      const rowNo = idx + 1;
      const nameText = String((r && r.name) || '').trim();
      const clientText = String((r && r.client) || '').trim();
      if (!nameText) return;
      const months = [];
      for (const [m, h] of Object.entries((r && r.hours) || {})) {
        const month = Number(m);
        const hours = Number(h);
        if (Number.isInteger(month) && month >= 1 && month <= 12 && Number.isFinite(hours) && hours > 0) months.push({ month, hours });
      }
      if (!months.length) return; // nothing worked, nothing to invoice

      const cons = byName.get(nameKey(nameText));
      if (!cons) {
        unmatched.push({ row: rowNo, name: nameText, client: clientText, reason: cons === null ? 'two consultants share this name in Directory' : 'consultant not found in Directory' });
        return;
      }
      if (!clientText) {
        unmatched.push({ row: rowNo, name: nameText, client: clientText, reason: 'no client on this row' });
        return;
      }
      const mine = byConsultant.get(cons.id) || [];
      const whole = nameKey(clientText);
      const slash = clientText.indexOf('/');
      const progKey = slash > -1 ? nameKey(clientText.slice(0, slash)) : null;
      const clientKey = slash > -1 ? nameKey(clientText.slice(slash + 1)) : whole;
      let cands = mine.filter((a) => a.client_name && nameKey(a.client_name) === whole && !a.program_id);
      if (!cands.length) {
        cands = mine.filter((a) => a.client_name && nameKey(a.client_name) === clientKey &&
          (progKey === null || (a.program_name && nameKey(a.program_name) === progKey)));
      }
      if (!cands.length) {
        unmatched.push({ row: rowNo, name: nameText, client: clientText, reason: 'no billing pairing for this consultant on that client/program' });
        return;
      }
      if (cands.length > 1) {
        unmatched.push({ row: rowNo, name: nameText, client: clientText, reason: 'matches more than one program — put "Program/Client" in the Client column' });
        return;
      }
      const a = cands[0];
      for (const { month, hours } of months) {
        const key = a.assignment_id + '|' + month;
        if (planned.has(key) || dupKeys.has(key)) {
          planned.delete(key); dupKeys.add(key);
          unmatched.push({ row: rowNo, name: nameText, client: clientText, month, reason: 'this consultant/client appears on more than one row for the month' });
          continue;
        }
        if (a.billing === null || a.billing === undefined) {
          noRate.push({ row: rowNo, name: nameText, client: clientText, month, reason: 'no billing rate set' });
          continue;
        }
        planned.set(key, { a, cons, month, hours, rowNo });
      }
    });

    const willCreate = [];
    const skippedExisting = [];
    const willFill = [];
    for (const item of planned.values()) {
      const periodMonth = year + '-' + String(item.month).padStart(2, '0') + '-01';
      const [existing] = await conn.query(
        `SELECT id, hours, rate FROM invoices
         WHERE organization_id = ? AND consultant_id = ? AND client_id <=> ? AND program_id <=> ? AND period_month = ?`,
        [organizationId, item.cons.id, item.a.client_id, item.a.program_id, periodMonth]
      );
      const label = { consultant: item.cons.name, client: item.a.client_name, program: item.a.program_name, periodMonth: periodMonth.slice(0, 7), hours: item.hours };
      const existingHours = existing.length && existing[0].hours !== null ? Number(existing[0].hours) : null;
      // An invoice generated with no hours yet (0 / blank) is a placeholder: fill it from the file.
      // One that already has hours is never changed.
      if (existing.length && !(existingHours > 0)) willFill.push({ ...label, invoiceId: existing[0].id, rate: Number(existing[0].rate), amount: Math.round(Number(existing[0].rate) * item.hours * 100) / 100 });
      else if (existing.length) skippedExisting.push({ ...label, invoiceId: existing[0].id, existingHours });
      else willCreate.push({ ...label, rate: Number(item.a.billing), amount: Math.round(Number(item.a.billing) * item.hours * 100) / 100, _item: item, _period: periodMonth });
    }
    willCreate.sort((x, y) => x.periodMonth.localeCompare(y.periodMonth) || x.consultant.localeCompare(y.consultant));

    const summary = {
      willCreate: willCreate.length, willFill: willFill.length, skippedExisting: skippedExisting.length,
      unmatched: unmatched.length + noRate.length,
      totalAmount: Math.round(willCreate.concat(willFill).reduce((t, w) => t + w.amount, 0) * 100) / 100,
    };
    const clean = (w) => { const { _item, _period, ...rest } = w; return rest; };

    if (!apply) {
      return res.json({ applied: false, summary, willCreate: willCreate.map(clean), willFill, skippedExisting, unmatched: unmatched.concat(noRate) });
    }

    await conn.beginTransaction();
    const createdIds = [];
    for (const w of willCreate) {
      const { a, cons } = w._item;
      const issueDate = toDateOnly(new Date(Date.UTC(year, w._item.month, 0)));
      const dueDate = addDays(issueDate, netTermsDays(netTerms));
      const billTo = a.program_id
        ? { name: a.program_name, email: a.program_email, phone: a.program_phone, address: a.program_address }
        : { name: a.client_name, email: a.client_email, phone: a.client_phone, address: a.client_address };
      const [result] = await conn.query(
        `INSERT INTO invoices
           (organization_id, invoice_number, consultant_id, client_id, program_id, assignment_id,
            period_month, rate, hours, amount, bill_to_name, bill_to_email, bill_to_phone, bill_to_address,
            net_terms, issue_date, due_date, payment_status, timesheet_submitted)
         VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          organizationId, cons.id, a.client_id, a.program_id, a.assignment_id,
          w._period, a.billing, w.hours, w.amount,
          billTo.name, billTo.email, billTo.phone, billTo.address,
          netTerms, issueDate, dueDate, paymentStatus, timesheet,
        ]
      );
      const invoiceNumber = await nextInvoiceNumber(conn, organizationId, w._period, result.insertId);
      await conn.query('UPDATE invoices SET invoice_number = ? WHERE id = ?', [invoiceNumber, result.insertId]);
      createdIds.push(result.insertId);
    }
    for (const w of willFill) {
      await conn.query(
        'UPDATE invoices SET hours = ?, amount = ? WHERE id = ? AND organization_id = ? AND (hours IS NULL OR hours = 0)',
        [w.hours, w.amount, w.invoiceId, organizationId]
      );
    }
    await conn.commit();
    res.status(201).json({ applied: true, summary, created: createdIds.length, filled: willFill.length, skippedExisting, unmatched: unmatched.concat(noRate) });
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* no-op */ }
    next(err);
  } finally {
    conn.release();
  }
});

// GET /api/invoices?periodMonth=&paymentStatus=&timesheetSubmitted=&consultantId=&includeInactive=
// Only invoices for Active consultants are listed unless includeInactive=1,
// which also lists Inactive and not-yet-set (NULL) consultants' invoices and
// unpaid invoices left over on client/program pairings the consultant has left.
router.get('/', async (req, res, next) => {
  try {
    const where = ['i.organization_id = ?'];
    const params = [req.user.organization_id];

    if (!isTruthyFlag(req.query.includeInactive)) {
      where.push("c.status = 'active'");
      // Invoices generated before a pairing was marked left: hide the unpaid
      // ones dated after the consultant left that client/program (all of them
      // when the file gives no left date). Paid history and months worked stay.
      where.push("NOT (a.status = 'left' AND i.payment_status = 'unpaid' AND (a.left_date IS NULL OR i.period_month > a.left_date))");
    }

    const periodMonth = normalizePeriodMonth(req.query.periodMonth || null);
    if (req.query.periodMonth) {
      if (!periodMonth) return res.status(400).json({ error: 'periodMonth must look like YYYY-MM.' });
      where.push('i.period_month = ?');
      params.push(periodMonth);
    }
    if (req.query.paymentStatus) {
      if (!['paid', 'unpaid'].includes(req.query.paymentStatus)) return res.status(400).json({ error: 'paymentStatus must be paid or unpaid.' });
      where.push('i.payment_status = ?');
      params.push(req.query.paymentStatus);
    }
    if (req.query.timesheetSubmitted) {
      if (!['yes', 'no'].includes(req.query.timesheetSubmitted)) return res.status(400).json({ error: 'timesheetSubmitted must be yes or no.' });
      where.push('i.timesheet_submitted = ?');
      params.push(req.query.timesheetSubmitted);
    }
    if (req.query.consultantId) {
      where.push('i.consultant_id = ?');
      params.push(Number(req.query.consultantId));
    }

    const [rows] = await pool.query(
      `SELECT i.*, c.name AS consultant_name, c.status AS consultant_status, cl.name AS client_name, p.name AS program_name
       FROM invoices i
       JOIN consultants c ON c.id = i.consultant_id
       LEFT JOIN clients cl ON cl.id = i.client_id
       LEFT JOIN programs p ON p.id = i.program_id
       LEFT JOIN consultant_assignments a ON a.id = i.assignment_id
       WHERE ${where.join(' AND ')}
       ORDER BY i.period_month DESC, i.id DESC`,
      params
    );
    res.json({ invoices: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT i.*, c.name AS consultant_name, c.status AS consultant_status, cl.name AS client_name, p.name AS program_name
       FROM invoices i
       JOIN consultants c ON c.id = i.consultant_id
       LEFT JOIN clients cl ON cl.id = i.client_id
       LEFT JOIN programs p ON p.id = i.program_id
       WHERE i.id = ? AND i.organization_id = ?`,
      [req.params.id, req.user.organization_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ invoice: rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/invoices/:id
// Editable fields: hours, amount, netTerms, dueDate, issueDate, paymentStatus,
// timesheetSubmitted, notes. When hours is sent and amount is not sent in
// the same request, amount is recomputed as rate x hours; sending amount
// explicitly always wins, so a flat dollar figure can be typed directly
// without entering hours at all.
router.patch('/:id', async (req, res, next) => {
  try {
    const [existingRows] = await pool.query(
      'SELECT * FROM invoices WHERE id = ? AND organization_id = ?',
      [req.params.id, req.user.organization_id]
    );
    if (!existingRows.length) return res.status(404).json({ error: 'Not found.' });
    const existing = existingRows[0];
    const body = req.body || {};

    const sets = [];
    const params = [];

    let hours = existing.hours;
    if (Object.prototype.hasOwnProperty.call(body, 'hours')) {
      hours = toNullableNumber(body.hours);
      if (body.hours !== null && body.hours !== undefined && body.hours !== '' && hours === null) {
        return res.status(400).json({ error: 'hours must be a number.' });
      }
      sets.push('hours = ?');
      params.push(hours);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'amount')) {
      const amount = toNullableNumber(body.amount);
      if (body.amount !== null && body.amount !== undefined && body.amount !== '' && amount === null) {
        return res.status(400).json({ error: 'amount must be a number.' });
      }
      sets.push('amount = ?');
      params.push(amount);
    } else if (Object.prototype.hasOwnProperty.call(body, 'hours')) {
      const rate = existing.rate === null || existing.rate === undefined ? null : Number(existing.rate);
      const amount = rate !== null && hours !== null ? Math.round(rate * hours * 100) / 100 : null;
      sets.push('amount = ?');
      params.push(amount);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'netTerms')) {
      const netTerms = normalizeNetTerms(body.netTerms);
      if (!netTerms) return res.status(400).json({ error: 'netTerms must look like NET30.' });
      sets.push('net_terms = ?');
      params.push(netTerms);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'issueDate')) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.issueDate || ''))) return res.status(400).json({ error: 'issueDate must look like YYYY-MM-DD.' });
      sets.push('issue_date = ?');
      params.push(body.issueDate);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'dueDate')) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate || ''))) return res.status(400).json({ error: 'dueDate must look like YYYY-MM-DD.' });
      sets.push('due_date = ?');
      params.push(body.dueDate);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'paymentStatus')) {
      if (!['paid', 'unpaid'].includes(body.paymentStatus)) return res.status(400).json({ error: 'paymentStatus must be paid or unpaid.' });
      sets.push('payment_status = ?');
      params.push(body.paymentStatus);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'timesheetSubmitted')) {
      if (!['yes', 'no'].includes(body.timesheetSubmitted)) return res.status(400).json({ error: 'timesheetSubmitted must be yes or no.' });
      sets.push('timesheet_submitted = ?');
      params.push(body.timesheetSubmitted);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
      sets.push('notes = ?');
      params.push(body.notes === null || body.notes === undefined ? null : String(body.notes).slice(0, 1000));
    }

    if (!sets.length) return res.json({ invoice: existing });

    params.push(req.params.id, req.user.organization_id);
    await pool.query(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ? AND organization_id = ?`, params);

    const [rows] = await pool.query('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
    res.json({ invoice: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM invoices WHERE id = ? AND organization_id = ?',
      [req.params.id, req.user.organization_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.maxBillableHours = maxBillableHours;
module.exports.usFederalHolidays = usFederalHolidays;
