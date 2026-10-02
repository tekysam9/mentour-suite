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

async function nextInvoiceNumber(conn, organizationId, periodMonth, insertId) {
  const ym = String(periodMonth).slice(0, 7).replace('-', '');
  return 'INV-' + ym + '-' + String(insertId).padStart(5, '0');
}

// POST /api/invoices/generate
// body: { periodMonth: 'YYYY-MM' (default: current month), netTerms: 'NET30' (default), issueDate: 'YYYY-MM-DD' (default: today) }
// Creates one invoice per (consultant, client, program) billing pairing that
// doesn't already have one for this period -- skipping pairings with no
// billing rate and pairings with neither a client nor a program (nothing to
// bill). Safe to re-run for the same month: existing invoices are left
// untouched.
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

    const [assignments] = await conn.query(
      `SELECT a.id AS assignment_id, a.consultant_id, a.client_id, a.program_id, a.billing,
         c.name AS consultant_name,
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
         VALUES (?, '', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'unpaid', 'no')`,
        [
          organizationId, a.consultant_id, a.client_id, a.program_id, a.assignment_id,
          periodMonth, a.billing, billTo.name, billTo.email, billTo.phone, billTo.address,
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

    res.status(201).json({ created: createdInvoices, skipped });
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* no-op */ }
    next(err);
  } finally {
    conn.release();
  }
});

// GET /api/invoices?periodMonth=&paymentStatus=&timesheetSubmitted=&consultantId=
router.get('/', async (req, res, next) => {
  try {
    const where = ['i.organization_id = ?'];
    const params = [req.user.organization_id];

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
      `SELECT i.*, c.name AS consultant_name, cl.name AS client_name, p.name AS program_name
       FROM invoices i
       JOIN consultants c ON c.id = i.consultant_id
       LEFT JOIN clients cl ON cl.id = i.client_id
       LEFT JOIN programs p ON p.id = i.program_id
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
      `SELECT i.*, c.name AS consultant_name, cl.name AS client_name, p.name AS program_name
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
