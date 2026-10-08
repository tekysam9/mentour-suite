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
const { findOrCreateDirectoryRecord } = require('./directoryUpsert');
const { aliasKey, splitClientText, isMissingTable, SCHEMA_NEEDED_MESSAGE } = require('./clientAliases');

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
    { table: 'invoices', column: 'consultant_id' },
    // Generated subvendor invoices are regenerable, so a pairing both records
    // already have is simply left on the loser (and cascades away with it).
    { table: 'subvendor_invoices', column: 'consultant_id', ignore: true },
  ],
  subvendors: [
    { table: 'margin_roster_entries', column: 'subvendor_id' },
    { table: 'ledger_roster_entries', column: 'subvendor_id' },
    { table: 'subvendor_invoices', column: 'subvendor_id', ignore: true },
  ],
  clients: [
    { table: 'margin_roster_entries', column: 'client_id' },
    { table: 'programs', column: 'client_id' },
    { table: 'consultant_assignments', column: 'client_id' },
    { table: 'invoices', column: 'client_id' },
    // Saved client-name matches follow the surviving record (optional: the
    // table only exists once db/schema.sql has been re-run).
    { table: 'client_text_aliases', column: 'client_id', optional: true },
  ],
  programs: [
    { table: 'margin_roster_entries', column: 'program_id' },
    { table: 'consultant_assignments', column: 'program_id' },
    { table: 'invoices', column: 'program_id' },
    { table: 'client_text_aliases', column: 'program_id', optional: true },
  ],
};

// UPDATE that tolerates an optional table not existing yet.
async function updateReferences(conn, table, sql, params, optional) {
  try {
    await conn.query(sql, params);
  } catch (err) {
    if (!(optional && isMissingTable(err))) throw err;
  }
}

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

    // Embed each consultant's own billing assignments (same shape as
    // GET /consultants/:id/assignments) so the list view can show a
    // Client/Program and Billing column without a fetch per row — one
    // extra query here instead of N later.
    const [assignmentRows] = await pool.query(
      `SELECT a.id, a.consultant_id, a.billing, a.source, a.status, a.left_date, a.client_id, a.program_id,
         cl.name AS client_name, p.name AS program_name
       FROM consultant_assignments a
       LEFT JOIN clients cl ON cl.id = a.client_id
       LEFT JOIN programs p ON p.id = a.program_id
       WHERE a.organization_id = ?
       ORDER BY a.status, cl.name, p.name`,
      [req.user.organization_id]
    );
    const byConsultant = new Map();
    for (const a of assignmentRows) {
      if (!byConsultant.has(a.consultant_id)) byConsultant.set(a.consultant_id, []);
      byConsultant.get(a.consultant_id).push(a);
    }
    for (const c of rows) c.assignments = byConsultant.get(c.id) || [];

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
      `SELECT a.id, a.billing, a.source, a.status, a.left_date, a.client_id, a.program_id,
         cl.name AS client_name, p.name AS program_name
       FROM consultant_assignments a
       LEFT JOIN clients cl ON cl.id = a.client_id
       LEFT JOIN programs p ON p.id = a.program_id
       WHERE a.organization_id = ? AND a.consultant_id = ?
       ORDER BY a.status, cl.name, p.name`,
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
      clientId, programId, billing, source: 'manual', status: 'active',
    });

    const [rows] = await pool.query(
      `SELECT a.id, a.billing, a.source, a.status, a.left_date, a.client_id, a.program_id,
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

// Adds a billing pairing from an hours file's Client column text (Fin-Module >
// Import hours, "Add as new pairing"). The text is split like the Margin
// file's "Client / Account" (Program/Client; no "/" = client only), the
// client and program are found by exact name or created (the same
// find-or-create the uploads use, including the near-duplicate flagging), and
// the pairing is added as a manual one. An existing pairing is returned as is
// (its billing is only filled in when it has none).
// body: { clientText, billing }
router.post('/consultants/:id/assignments/from-text', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const organizationId = req.user.organization_id;
    const consultant = await findConsultant(req.params.id, organizationId);
    if (!consultant) return res.status(404).json({ error: 'Not found.' });
    const body = req.body || {};
    const { clientName, programName } = splitClientText(body.clientText);
    if (!clientName) return res.status(400).json({ error: 'clientText must name a client (e.g. "Program/Client" or "Client").' });
    const billing = body.billing === null || body.billing === undefined || body.billing === '' ? null : Number(body.billing);
    if (billing !== null && (!Number.isFinite(billing) || billing < 0)) return res.status(400).json({ error: 'Billing must be a number.' });

    await conn.beginTransaction();
    const client = await findOrCreateDirectoryRecord(conn, 'clients', { organizationId, name: clientName, status: 'active' });
    const program = programName
      ? await findOrCreateDirectoryRecord(conn, 'programs', { organizationId, clientId: client.id, name: programName, status: 'active' })
      : null;
    const [existing] = await conn.query(
      `SELECT id, billing FROM consultant_assignments
       WHERE organization_id = ? AND consultant_id = ? AND client_id <=> ? AND program_id <=> ?`,
      [organizationId, consultant.id, client.id, program ? program.id : null]
    );
    let assignmentId, existed = false;
    if (existing.length) {
      existed = true;
      assignmentId = existing[0].id;
      if (existing[0].billing === null && billing !== null) {
        await conn.query('UPDATE consultant_assignments SET billing = ? WHERE id = ?', [billing, assignmentId]);
      }
    } else {
      assignmentId = await upsertAssignmentBilling(conn, {
        organizationId, consultantId: consultant.id, clientId: client.id, programId: program ? program.id : null,
        billing, source: 'manual', status: 'active',
      });
    }
    await conn.commit();
    const [rows] = await pool.query(
      `SELECT a.id, a.billing, a.source, a.status, a.left_date, a.client_id, a.program_id,
         cl.name AS client_name, p.name AS program_name
       FROM consultant_assignments a
       LEFT JOIN clients cl ON cl.id = a.client_id
       LEFT JOIN programs p ON p.id = a.program_id
       WHERE a.id = ?`,
      [assignmentId]
    );
    res.status(existed ? 200 : 201).json({ assignment: rows[0], existed, clientCreated: client.created, programCreated: !!(program && program.created) });
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* no-op */ }
    next(err);
  } finally {
    conn.release();
  }
});

// --- Client name matches (alternate Client-column text -> client/program) ---
// See clientAliases.js. Created from Fin-Module > Import hours ("Same as").

router.get('/client-aliases', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT x.id, x.alias_text, x.client_id, x.program_id, x.created_at, cl.name AS client_name, p.name AS program_name
       FROM client_text_aliases x
       JOIN clients cl ON cl.id = x.client_id
       LEFT JOIN programs p ON p.id = x.program_id
       WHERE x.organization_id = ?
       ORDER BY x.alias_text`,
      [req.user.organization_id]
    );
    res.json({ aliases: rows });
  } catch (err) {
    if (isMissingTable(err)) return res.json({ aliases: [], schemaNeeded: true });
    next(err);
  }
});

// body: { aliasText, assignmentId } -- "aliasText means the client/program of this pairing".
router.post('/client-aliases', async (req, res, next) => {
  try {
    const organizationId = req.user.organization_id;
    const body = req.body || {};
    const key = aliasKey(body.aliasText);
    if (!key) return res.status(400).json({ error: 'aliasText is required.' });
    const [aRows] = await pool.query(
      'SELECT id, client_id, program_id FROM consultant_assignments WHERE id = ? AND organization_id = ?',
      [Number(body.assignmentId) || 0, organizationId]
    );
    if (!aRows.length) return res.status(404).json({ error: 'That pairing no longer exists.' });
    if (!aRows[0].client_id) return res.status(400).json({ error: 'That pairing has no client to match to.' });
    const text = String(body.aliasText).replace(/\s+/g, ' ').trim().slice(0, 255);
    try {
      await pool.query(
        `INSERT INTO client_text_aliases (organization_id, alias_key, alias_text, client_id, program_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE alias_text = VALUES(alias_text), client_id = VALUES(client_id), program_id = VALUES(program_id)`,
        [organizationId, key, text, aRows[0].client_id, aRows[0].program_id]
      );
    } catch (err) {
      if (isMissingTable(err)) return res.status(409).json({ error: SCHEMA_NEEDED_MESSAGE, schemaNeeded: true });
      throw err;
    }
    const [rows] = await pool.query(
      `SELECT x.id, x.alias_text, x.client_id, x.program_id, cl.name AS client_name, p.name AS program_name
       FROM client_text_aliases x JOIN clients cl ON cl.id = x.client_id LEFT JOIN programs p ON p.id = x.program_id
       WHERE x.organization_id = ? AND x.alias_key = ?`,
      [organizationId, key]
    );
    res.status(201).json({ alias: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/client-aliases/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM client_text_aliases WHERE id = ? AND organization_id = ?', [req.params.id, req.user.organization_id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  } catch (err) {
    if (isMissingTable(err)) return res.status(404).json({ error: 'Not found.' });
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

// --- "Seen in" usage detail ---
//
// The directory list routes above return bare counts (margin_rows,
// ledger_rows) for a quick "Seen in" badge. This route is what backs the
// expandable panel: the actual uploads behind that count, so a person can
// see which file(s) named this record and with what details, not just a
// number.

// Which margin_roster_entries/ledger_roster_entries column links back to
// each directory table. Clients and programs are Margin-only (see
// schema.sql's Directory comment), so they have no ledger entry.
const MARGIN_USAGE_COLUMN = {
  consultants: 'consultant_id',
  subvendors: 'subvendor_id',
  clients: 'client_id',
  programs: 'program_id',
};
const LEDGER_USAGE_COLUMN = {
  consultants: 'consultant_id',
  subvendors: 'subvendor_id',
};

router.get('/:table/:id/usage', async (req, res, next) => {
  try {
    const tableName = req.params.table;
    if (!DIRECTORY_TABLES.includes(tableName)) {
      return res.status(400).json({ error: 'Unknown table. Use consultants, subvendors, clients, or programs.' });
    }

    const [recordRows] = await pool.query(
      `SELECT id, name FROM ${tableName} WHERE id = ? AND organization_id = ?`,
      [req.params.id, req.user.organization_id]
    );
    const record = recordRows[0];
    if (!record) return res.status(404).json({ error: 'Not found.' });

    const marginColumn = MARGIN_USAGE_COLUMN[tableName];
    const [marginRows] = await pool.query(
      `SELECT mi.id AS import_id, mi.file_name, mi.imported_at,
         m.name, m.client, m.program, m.client_detail, m.cost, m.billing, m.margin,
         m.status, m.employment_type, m.subvendor_text, m.source_sheet
       FROM margin_roster_entries m
       JOIN margin_imports mi ON mi.id = m.import_id
       WHERE m.organization_id = ? AND m.${marginColumn} = ?
       ORDER BY mi.imported_at DESC, m.id DESC`,
      [req.user.organization_id, req.params.id]
    );

    let ledgerRows = [];
    const ledgerColumn = LEDGER_USAGE_COLUMN[tableName];
    if (ledgerColumn) {
      const [rows] = await pool.query(
        `SELECT li.id AS import_id, li.file_name, li.imported_at,
           l.name, l.subvendor_text, l.client_tag, l.month_label, l.period_text,
           l.amount, l.rate, l.hours, l.paid_date, l.notes
         FROM ledger_roster_entries l
         JOIN ledger_imports li ON li.id = l.import_id
         WHERE l.organization_id = ? AND l.${ledgerColumn} = ?
         ORDER BY li.imported_at DESC, l.id DESC`,
        [req.user.organization_id, req.params.id]
      );
      ledgerRows = rows;
    }

    res.json({ table: tableName, record, margin: marginRows, ledger: ledgerRows });
  } catch (err) {
    next(err);
  }
});

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

    // Merging two clients: a program with the same name under both is the
    // same program, so fold the loser's into the kept client's (repointing
    // everything that references it) before the remaining programs move over;
    // otherwise (client_id, name) collides and the whole merge is rejected.
    if (tableName === 'clients') {
      const [sameNamed] = await conn.query(
        `SELECT lp.id AS lose_pid, kp.id AS keep_pid
         FROM programs lp
         JOIN programs kp ON kp.client_id = ? AND kp.organization_id = lp.organization_id AND kp.name = lp.name
         WHERE lp.client_id = ? AND lp.organization_id = ?`,
        [keepId, loseId, req.user.organization_id]
      );
      for (const pair of sameNamed) {
        for (const table of ['margin_roster_entries', 'consultant_assignments', 'invoices', 'client_text_aliases']) {
          await updateReferences(conn, table,
            `UPDATE ${table} SET program_id = ? WHERE program_id = ? AND organization_id = ?`,
            [pair.keep_pid, pair.lose_pid, req.user.organization_id], table === 'client_text_aliases');
        }
        await conn.query(
          `DELETE FROM directory_duplicate_candidates WHERE table_name = 'programs' AND status = 'open' AND (record_id = ? OR matched_record_id = ?)`,
          [pair.lose_pid, pair.lose_pid]
        );
        await conn.query('DELETE FROM programs WHERE id = ? AND organization_id = ?', [pair.lose_pid, req.user.organization_id]);
      }
    }

    for (const ref of REFERENCING_COLUMNS[tableName] || []) {
      await updateReferences(conn, ref.table,
        `UPDATE ${ref.ignore ? 'IGNORE ' : ''}${ref.table} SET ${ref.column} = ? WHERE ${ref.column} = ? AND organization_id = ?`,
        [keepId, loseId, req.user.organization_id], ref.optional);
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
