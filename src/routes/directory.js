// Directory API: list and edit the consultants/clients/programs/subvendors
// that imports have resolved to (see directoryUpsert.js). Every route is
// scoped to req.user.organization_id, so one company can never see or edit
// another's directory.
//
// Editing is limited to email/phone/address on purpose — name is the key
// imports match on (see directoryUpsert.js), so renaming a record here
// would silently orphan it from future uploads of the same raw name and
// create a duplicate instead. If a name genuinely needs to change, that's a
// direct database edit, not something this API offers.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

function pickContactFields(body) {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const key of ['email', 'phone', 'address']) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      const v = body[key];
      out[key] = v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().slice(0, key === 'address' ? 500 : 255);
    }
  }
  return out;
}

async function updateContactFields(tableName, req, res, next) {
  try {
    const fields = pickContactFields(req.body);
    const keys = Object.keys(fields);
    if (!keys.length) return res.status(400).json({ error: 'Nothing to update. Send email, phone, and/or address.' });

    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => fields[k]);
    const [result] = await pool.query(
      `UPDATE ${tableName} SET ${setClause} WHERE id = ? AND organization_id = ?`,
      [...values, req.params.id, req.user.organization_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found.' });

    const [rows] = await pool.query(`SELECT * FROM ${tableName} WHERE id = ?`, [req.params.id]);
    res.json({ record: rows[0] });
  } catch (err) {
    next(err);
  }
}

// --- Consultants (shared between Ledger and Margin) ---

router.get('/consultants', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*,
         (SELECT COUNT(*) FROM margin_roster_entries m WHERE m.consultant_id = c.id) AS margin_rows,
         (SELECT COUNT(*) FROM ledger_roster_entries l WHERE l.consultant_id = c.id) AS ledger_rows
       FROM consultants c WHERE c.organization_id = ? ORDER BY c.name`,
      [req.user.organization_id]
    );
    res.json({ consultants: rows });
  } catch (err) {
    next(err);
  }
});

router.patch('/consultants/:id', (req, res, next) => updateContactFields('consultants', req, res, next));

// --- Subvendors (shared between Ledger and Margin) ---

router.get('/subvendors', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.*,
         (SELECT COUNT(*) FROM margin_roster_entries m WHERE m.subvendor_id = s.id) AS margin_rows,
         (SELECT COUNT(*) FROM ledger_roster_entries l WHERE l.subvendor_id = s.id) AS ledger_rows
       FROM subvendors s WHERE s.organization_id = ? ORDER BY s.name`,
      [req.user.organization_id]
    );
    res.json({ subvendors: rows });
  } catch (err) {
    next(err);
  }
});

router.patch('/subvendors/:id', (req, res, next) => updateContactFields('subvendors', req, res, next));

// --- Clients (Margin only) ---

router.get('/clients', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*,
         (SELECT COUNT(*) FROM margin_roster_entries m WHERE m.client_id = c.id) AS margin_rows,
         (SELECT COUNT(*) FROM programs p WHERE p.client_id = c.id) AS program_count
       FROM clients c WHERE c.organization_id = ? ORDER BY c.name`,
      [req.user.organization_id]
    );
    res.json({ clients: rows });
  } catch (err) {
    next(err);
  }
});

router.patch('/clients/:id', (req, res, next) => updateContactFields('clients', req, res, next));

// --- Programs (Margin only; each belongs to a client) ---

router.get('/programs', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, c.name AS client_name,
         (SELECT COUNT(*) FROM margin_roster_entries m WHERE m.program_id = p.id) AS margin_rows
       FROM programs p JOIN clients c ON c.id = p.client_id
       WHERE p.organization_id = ? ORDER BY c.name, p.name`,
      [req.user.organization_id]
    );
    res.json({ programs: rows });
  } catch (err) {
    next(err);
  }
});

router.patch('/programs/:id', (req, res, next) => updateContactFields('programs', req, res, next));

module.exports = router;
