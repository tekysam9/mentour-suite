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
const { TABLES: DIRECTORY_TABLES } = require('./directoryDedup');
const { upsertAssignmentBilling } = require('./assignmentUpsert');

const router = express.Router();
router.use(requireAuth);

// Other tables that hold a foreign key into each directory table — reassigned
// to the surviving record when two directory rows are merged (see the
// duplicate-candidate routes near the bottom of this file).
const REFERENCING_COLUMNS = {
  consultants: [
    { table: 'margin_roster_entries', column: 'consultant_id' },
    { table: 'ledger_roster_entries', column: 'consultant_id' },
    { table: 'consultant_assignments', column: 'consultant_id' },
  ],
  subvendors: [
    { table: 'margin_roster_entries', column: 'subvendor_id' },
    { table: 'ledger_roster_entries', column: 'subvendor_id' },
  ],
  clients: [
    { table: 'margin_roster_entries', column: 'client_id' },
    { table: 'programs', column: 'client_id' },
    { table: 'consultant_assignments', column: 'client_id' },
  ],
  programs: [
    { table: 'margin_roster_entries', column: 'program_id' },
    { table: 'consultant_assignments', column: 'program_id' },
  ],
};

// After reassigning ids in a merge, two consultant_assignments rows can end
// up representing the exact same (consultant, client, program) pairing
// (e.g. both merged consultants already had their own billing row for the
// same client). Keep the most recently touched one and drop the rest,
// scoped to this organization since consultant_assignments has no unique
// constraint of its own to lean on (see assignmentUpsert.js).
async function dedupeAssignments(conn, organizationId) {
  const [dupeGroups] = await conn.query(
    `SELECT consultant_id, client_id, program_id, MAX(id) AS keep_id
     FROM consultant_assignments
     WHERE organization_id = ?
     GROUP BY consultant_id, client_id, program_id
     HAVING COUNT(*) > 1`,
    [organizationId]
  );
  for (const g of dupeGroups) {
    await conn.query(
      `DELETE FROM consultant_assignments
       WHERE organization_id = ? AND consultant_id <=> ? AND client_id <=> ? AND program_id <=> ? AND id != ?`,
      [organizationId, g.consultant_id, g.client_id, g.program_id, g.keep_id]
    );
  }
}

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
         (SELECT COUNT(*) FROM ledger_roster_entries l WHERE l.consultant_id = c.id) AS ledger_rows,
         (SELECT COUNT(*) FROM consultant_assignments a WHERE a.consultant_id = c.id) AS assignment_count
       FROM consultants c WHERE c.organization_id = ? ORDER BY c.name`,
      [req.user.organization_id]
    );
    res.json({ consultants: rows });
  } catch (err) {
    next(err);
  }
});

router.patch('/consultants/:id', (req, res, next) => updateContactFields('consultants', req, res, next));

// --- Assignments: a consultant's billing rate per client/program ---
//
// Auto-populated and kept in sync from every Margin upload (see
// assignmentUpsert.js) — this is the manual side: adding a pairing an
// upload hasn't covered yet, correcting a billing figure, or removing a
// stale one. See the consultant_assignments comment in db/schema.sql for
// why billing (unlike email/phone/address) is allowed to be overwritten by
// a later upload.

async function findConsultant(id, organizationId) {
  const [rows] = await pool.query('SELECT id FROM consultants WHERE id = ? AND organization_id = ?', [id, organizationId]);
  return rows[0] || null;
}

router.get('/consultants/:id/assignments', async (req, res, next) => {
  try {
    const consultant = await findConsultant(req.params.id, req.user.organization_id);
    if (!consultant) return res.status(404).json({ error: 'Not found.' });

    const [rows] = await pool.query(
      `SELECT a.id, a.billing, a.source, a.client_id, a.program_id,
         cl.name AS client_name, p.name AS program_name
       FROM consultant_assignments a
       LEFT JOIN clients cl ON cl.id = a.client_id
       LEFT JOIN programs p ON p.id = a.program_id
       WHERE a.organization_id = ? AND a.consultant_id = ?
       ORDER BY cl.name, p.name`,
      [req.user.organization_id, req.params.id]
    );
    res.json({ assignments: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/consultants/:id/assignments', async (req, res, next) => {
  try {
    const consultant = await findConsultant(req.params.id, req.user.organization_id);
    if (!consultant) return res.status(404).json({ error: 'Not found.' });

    const body = req.body || {};
    const clientId = body.client_id ? Number(body.client_id) : null;
    const programId = body.program_id ? Number(body.program_id) : null;
    const billing = body.billing === null || body.billing === undefined || body.billing === ''
      ? null : Number(body.billing);
    if (billing !== null && !Number.isFinite(billing)) {
      return res.status(400).json({ error: 'Billing must be a number.' });
    }

    if (clientId) {
      const [clientRows] = await pool.query('SELECT id FROM clients WHERE id = ? AND organization_id = ?', [clientId, req.user.organization_id]);
      if (!clientRows.length) return res.status(400).json({ error: 'Unknown client.' });
    }
    if (programId) {
      const [programRows] = await pool.query(
        'SELECT id FROM programs WHERE id = ? AND organization_id = ? AND client_id <=> ?',
        [programId, req.user.organization_id, clientId]
      );
      if (!programRows.length) return res.status(400).json({ error: 'Unknown program, or it doesn’t belong to that client.' });
    }

    const assignmentId = await upsertAssignmentBilling(pool, {
      organizationId: req.user.organization_id, consultantId: Number(req.params.id),
      clientId, programId, billing, source: 'manual',
    });

    const [rows] = await pool.query(
      `SELECT a.id, a.billing, a.source, a.client_id, a.program_id,
         cl.name AS client_name, p.name AS program_name
       FROM consultant_assignments a
       LEFT JOIN clients cl ON cl.id = a.client_id
       LEFT JOIN programs p ON p.id = a.program_id
       WHERE a.id = ?`,
      [assignmentId]
    );
    res.status(201).json({ assignment: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch('/assignments/:id', async (req, res, next) => {
  try {
    const billing = req.body && req.body.billing !== undefined && req.body.billing !== null && req.body.billing !== ''
      ? Number(req.body.billing) : null;
    if (req.body && req.body.billing !== undefined && req.body.billing !== null && req.body.billing !== '' && !Number.isFinite(billing)) {
      return res.status(400).json({ error: 'Billing must be a number.' });
    }
    const [result] = await pool.query(
      `UPDATE consultant_assignments SET billing = ?, source = 'manual' WHERE id = ? AND organization_id = ?`,
      [billing, req.params.id, req.user.organization_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found.' });
    const [rows] = await pool.query('SELECT * FROM consultant_assignments WHERE id = ?', [req.params.id]);
    res.json({ assignment: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/assignments/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM consultant_assignments WHERE id = ? AND organization_id = ?',
      [req.params.id, req.user.organization_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

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

// --- Smart-parser duplicate review ---
//
// See directoryDedup.js for how a candidate gets flagged in the first
// place (a brand-new record whose name was *close* to, but not exactly,
// an existing one — never merged automatically). These routes are how a
// person resolves one: confirm it's the same thing and merge, or dismiss
// it as a coincidence.

router.get('/duplicates', async (req, res, next) => {
  try {
    const requested = req.query.table;
    if (requested && !DIRECTORY_TABLES.includes(requested)) {
      return res.status(400).json({ error: 'Unknown table. Use consultants, subvendors, clients, or programs.' });
    }
    const tables = requested ? [requested] : DIRECTORY_TABLES;
    const out = {};
    for (const t of tables) {
      const [rows] = await pool.query(
        `SELECT d.id AS flag_id, d.similarity, d.created_at,
           a.id AS record_id, a.name AS record_name, a.status AS record_status,
           b.id AS matched_id, b.name AS matched_name, b.status AS matched_status
         FROM directory_duplicate_candidates d
         JOIN ${t} a ON a.id = d.record_id
         JOIN ${t} b ON b.id = d.matched_record_id
         WHERE d.organization_id = ? AND d.table_name = ? AND d.status = 'open'
         ORDER BY d.similarity DESC, d.created_at DESC`,
        [req.user.organization_id, t]
      );
      out[t] = rows;
    }
    res.json({ duplicates: requested ? out[requested] : out });
  } catch (err) {
    next(err);
  }
});

router.post('/duplicates/:id/dismiss', async (req, res, next) => {
  try {
    const [result] = await pool.query(
      `UPDATE directory_duplicate_candidates SET status = 'dismissed', resolved_at = NOW()
       WHERE id = ? AND organization_id = ? AND status = 'open'`,
      [req.params.id, req.user.organization_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found, or already resolved.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Merges one flagged pair: req.body.keep is 'record' or 'matched', naming
// which side of the flag survives. The loser's rows in whatever tables
// point at it (margin_roster_entries, ledger_roster_entries, programs for a
// client merge) are repointed at the survivor, then the loser row itself is
// deleted. All in one transaction, so a failure partway through (most
// likely two same-named programs landing under one client, see the
// ER_DUP_ENTRY handling below) leaves nothing half-merged.
router.post('/duplicates/:id/merge', async (req, res, next) => {
  const keepSide = req.body && req.body.keep === 'matched' ? 'matched' : 'record';
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [flagRows] = await conn.query(
      `SELECT * FROM directory_duplicate_candidates WHERE id = ? AND organization_id = ? AND status = 'open' FOR UPDATE`,
      [req.params.id, req.user.organization_id]
    );
    const flag = flagRows[0];
    if (!flag) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found, or already resolved.' });
    }

    const tableName = flag.table_name;
    if (!DIRECTORY_TABLES.includes(tableName)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Unrecognized directory table on this flag.' });
    }

    const keepId = keepSide === 'matched' ? flag.matched_record_id : flag.record_id;
    const loseId = keepSide === 'matched' ? flag.record_id : flag.matched_record_id;

    const [existing] = await conn.query(
      `SELECT id FROM ${tableName} WHERE id IN (?, ?) AND organization_id = ?`,
      [keepId, loseId, req.user.organization_id]
    );
    if (existing.length !== 2) {
      await conn.rollback();
      return res.status(409).json({ error: 'One of these records no longer exists — it may have already been merged.' });
    }

    for (const ref of REFERENCING_COLUMNS[tableName] || []) {
      await conn.query(
        `UPDATE ${ref.table} SET ${ref.column} = ? WHERE ${ref.column} = ? AND organization_id = ?`,
        [keepId, loseId, req.user.organization_id]
      );
    }
    if (REFERENCING_COLUMNS[tableName] && REFERENCING_COLUMNS[tableName].some((ref) => ref.table === 'consultant_assignments')) {
      await dedupeAssignments(conn, req.user.organization_id);
    }

    await conn.query(`DELETE FROM ${tableName} WHERE id = ? AND organization_id = ?`, [loseId, req.user.organization_id]);

    await conn.query(
      `UPDATE directory_duplicate_candidates SET status = 'merged', resolved_at = NOW() WHERE id = ?`,
      [flag.id]
    );
    // Any other open flag naming the record that just disappeared is moot now.
    await conn.query(
      `DELETE FROM directory_duplicate_candidates
       WHERE table_name = ? AND status = 'open' AND (record_id = ? OR matched_record_id = ?)`,
      [tableName, loseId, loseId]
    );

    await conn.commit();

    const [keptRows] = await pool.query(`SELECT * FROM ${tableName} WHERE id = ?`, [keepId]);
    res.json({ kept: keptRows[0], removedId: loseId });
  } catch (err) {
    await conn.rollback();
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: 'Could not merge: the two records have a conflicting child record (e.g. a program with the same name under both clients). Resolve that by hand first.',
      });
    }
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
