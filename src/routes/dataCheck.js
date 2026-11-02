// Data check (owner / HR): a read-only report of what is stored, so "records have gone missing" can be
// answered from facts. It compares every earlier Ledger / Margin upload with the one the app currently
// shows, and lists Margin-file people with no placement in the app. Nothing here changes or deletes data.
// The one write is "Use this upload again", which saves an earlier upload as a new upload (the same thing
// as uploading that file again); it never removes anything.
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { isHrUser } = require('../placementRules');
const { saveLedgerRoster } = require('./ledgerRoster');
const { saveMarginRoster } = require('./marginRoster');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => isHrUser(req.user) ? next() : res.status(403).json({ error: 'Only the account owner or an HR admin can open the data check.' }));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const SAMPLE = 40;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const num2 = (v) => (v === null || v === undefined ? '' : Number(v).toFixed(2));

router.get('/', async (req, res, next) => {
  try {
    const org = req.user.organization_id;
    const q = async (sql, p) => (await pool.query(sql, p))[0];

    const ledgerImports = await q(
      `SELECT i.id, i.file_name, i.imported_at, u.name AS uploaded_by,
              (SELECT COUNT(*) FROM ledger_roster_entries e WHERE e.import_id = i.id) AS rows_total,
              (SELECT COUNT(*) FROM ledger_roster_entries e WHERE e.import_id = i.id AND e.unpaid = 0) AS rows_paid,
              (SELECT COUNT(*) FROM ledger_roster_entries e WHERE e.import_id = i.id AND e.unpaid = 1) AS rows_unpaid,
              (SELECT COUNT(DISTINCT e.name) FROM ledger_roster_entries e WHERE e.import_id = i.id) AS people
       FROM ledger_imports i LEFT JOIN users u ON u.id = i.uploaded_by
       WHERE i.organization_id = ? ORDER BY i.imported_at DESC, i.id DESC LIMIT 50`, [org]);
    const marginImports = await q(
      `SELECT i.id, i.file_name, i.imported_at, u.name AS uploaded_by,
              (SELECT COUNT(*) FROM margin_roster_entries e WHERE e.import_id = i.id) AS rows_total,
              (SELECT COUNT(DISTINCT e.name) FROM margin_roster_entries e WHERE e.import_id = i.id) AS people
       FROM margin_imports i LEFT JOIN users u ON u.id = i.uploaded_by
       WHERE i.organization_id = ? ORDER BY i.imported_at DESC, i.id DESC LIMIT 50`, [org]);

    // Payments that were in an earlier Ledger upload but are not in the current one.
    const out = { ledgerImports, marginImports, ledgerGaps: [], marginGaps: [] };
    if (ledgerImports.length > 1) {
      const cur = ledgerImports[0];
      const key = (r) => [norm(r.name), norm(r.subvendor_text), norm(r.period_text), norm(r.year_text), norm(r.month_label), num2(r.amount)].join('|');
      const curRows = await q('SELECT name, subvendor_text, period_text, year_text, month_label, amount FROM ledger_roster_entries WHERE import_id = ?', [cur.id]);
      const bag = new Map();
      curRows.forEach((r) => bag.set(key(r), (bag.get(key(r)) || 0) + 1));
      for (const old of ledgerImports.slice(1, 6)) {
        const rows = await q('SELECT name, subvendor_text, period_text, year_text, month_label, amount, unpaid FROM ledger_roster_entries WHERE import_id = ?', [old.id]);
        const left = new Map(bag); const missing = [];
        rows.forEach((r) => { const k = key(r); if (left.get(k)) left.set(k, left.get(k) - 1); else missing.push(r); });
        out.ledgerGaps.push({ importId: old.id, file_name: old.file_name, imported_at: old.imported_at, missingCount: missing.length,
          missingAmount: Math.round(missing.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100,
          sample: missing.slice(0, SAMPLE).map((r) => ({ consultant: r.name, supplier: r.subvendor_text, label: r.period_text, year: r.year_text, sheet: r.month_label, amount: r.amount === null ? null : Number(r.amount), unpaid: !!r.unpaid })) });
      }
    }
    if (marginImports.length > 1) {
      const cur = marginImports[0];
      const key = (r) => [norm(r.name), norm(r.client), norm(r.program)].join('|');
      const curRows = await q('SELECT name, client, program FROM margin_roster_entries WHERE import_id = ?', [cur.id]);
      const have = new Set(curRows.map(key));
      for (const old of marginImports.slice(1, 6)) {
        const rows = await q('SELECT name, client, program, status FROM margin_roster_entries WHERE import_id = ?', [old.id]);
        const missing = rows.filter((r) => !have.has(key(r)));
        out.marginGaps.push({ importId: old.id, file_name: old.file_name, imported_at: old.imported_at, missingCount: missing.length,
          sample: missing.slice(0, SAMPLE).map((r) => ({ consultant: r.name, client: r.client, vendor: r.program, status: r.status })) });
      }
    }

    // What the app holds now.
    const [[pc]] = await pool.query(
      `SELECT COUNT(*) AS total, SUM(status = 'active') AS active, SUM(status = 'left') AS gone, SUM(source = 'manual') AS manual_rows, SUM(source = 'upload') AS upload_rows
       FROM consultant_assignments WHERE organization_id = ?`, [org]);
    const [[cc]] = await pool.query(`SELECT COUNT(*) AS total, SUM(status = 'active') AS active, SUM(status = 'inactive') AS inactive, SUM(status IS NULL) AS unset FROM consultants WHERE organization_id = ?`, [org]);
    const [[sc]] = await pool.query(`SELECT COUNT(*) AS total FROM subvendors WHERE organization_id = ?`, [org]);
    const [[iv]] = await pool.query(`SELECT COUNT(*) AS total, SUM(overrides_ledger = 1) AS edited_file_rows, MIN(period_month) AS first_month, MAX(period_month) AS last_month FROM subvendor_invoices WHERE organization_id = ?`, [org]);
    const [[ci]] = await pool.query(`SELECT COUNT(*) AS total FROM invoices WHERE organization_id = ?`, [org]);
    out.now = { placements: pc, consultants: cc, suppliers: sc, supplierInvoices: iv, clientInvoices: ci };

    // Margin-file people (latest upload) with no placement in the app: a placement removed after the upload.
    if (marginImports.length) {
      const rows = await q(
        `SELECT m.name, m.client, m.program, m.status FROM margin_roster_entries m
         WHERE m.import_id = ? AND m.organization_id = ?
           AND NOT EXISTS (SELECT 1 FROM consultant_assignments a WHERE a.organization_id = m.organization_id AND a.consultant_id <=> m.consultant_id AND a.client_id <=> m.client_id AND a.program_id <=> m.program_id)
         ORDER BY m.name`, [marginImports[0].id, org]);
      out.fileOnly = { importId: marginImports[0].id, count: rows.length, sample: rows.slice(0, SAMPLE * 2) };
    }
    // Consultants whose Ledger payments exist but who have no placement at all.
    if (ledgerImports.length) {
      const rows = await q(
        `SELECT DISTINCT c.id, c.name, c.status FROM ledger_roster_entries l JOIN consultants c ON c.id = l.consultant_id
         WHERE l.import_id = ? AND l.organization_id = ? AND NOT EXISTS (SELECT 1 FROM consultant_assignments a WHERE a.consultant_id = c.id)
         ORDER BY c.name`, [ledgerImports[0].id, org]);
      out.paidNoPlacement = { count: rows.length, sample: rows.slice(0, SAMPLE * 2) };
    }
    res.json(out);
  } catch (err) { next(err); }
});

// Save an earlier upload again as the newest one: the same as uploading that file again.
router.post('/reuse/:kind/:id', async (req, res, next) => {
  const kinds = { ledger: ['ledger_imports', saveLedgerRoster], margin: ['margin_imports', saveMarginRoster] };
  const k = kinds[req.params.kind];
  if (!k || !/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
  const [table, onSave] = k;
  const conn = await pool.getConnection();
  try {
    const [[old]] = [await conn.query(`SELECT file_name, data FROM ${table} WHERE id = ? AND organization_id = ?`, [req.params.id, req.user.organization_id]).then((r) => [r[0][0]])];
    if (!old) return res.status(404).json({ error: 'That upload was not found.' });
    const data = typeof old.data === 'string' ? JSON.parse(old.data) : old.data;
    await conn.beginTransaction();
    const [ins] = await conn.query(`INSERT INTO ${table} (organization_id, uploaded_by, file_name, data) VALUES (?, ?, ?, ?)`,
      [req.user.organization_id, req.user.id, String(old.file_name).slice(0, 240) + ' (re-used)', JSON.stringify(data)]);
    await onSave(conn, { organizationId: req.user.organization_id, uploadedBy: req.user.id, importId: ins.insertId, data });
    await conn.commit();
    res.status(201).json({ import: { id: ins.insertId } });
  } catch (err) { try { await conn.rollback(); } catch (e) { /* ignore */ } next(err); } finally { conn.release(); }
});

module.exports = router;
