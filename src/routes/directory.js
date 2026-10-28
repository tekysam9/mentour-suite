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
const { TABLES: DIRECTORY_TABLES, scanDuplicates } = require('./directoryDedup');
const { upsertAssignmentBilling } = require('./assignmentUpsert');
const { findOrCreateDirectoryRecord, normalizeName } = require('./directoryUpsert');
const { checkSupplierRule, repointMarginRows, defaultsFor, syncConsultantStatus, isHrUser, EMPLOYMENT_BY_PROFILE, KIND_BY_EMPLOYMENT } = require('../placementRules');
const { aliasKey, splitClientText, isMissingTable, SCHEMA_NEEDED_MESSAGE } = require('./clientAliases');

// Profile form data follows the surviving record when two records are merged:
// fields the survivor leaves blank are filled from the removed record, secrets
// and notes are carried over (optional: tables exist once schema.sql has run).
async function mergeProfileRecords(conn, tableName, keepId, loseId, orgId) {
  if (!['consultants', 'clients', 'programs', 'subvendors'].includes(tableName)) return;
  try {
    const [rows] = await conn.query(
      `SELECT record_id, data FROM record_profiles WHERE organization_id = ? AND entity = ? AND record_id IN (?, ?)`,
      [orgId, tableName, keepId, loseId]);
    const parse = (r) => { try { return (r && r.data && JSON.parse(r.data)) || {}; } catch (e) { return {}; } };
    const keep = parse(rows.find((r) => r.record_id === keepId));
    const lose = parse(rows.find((r) => r.record_id === loseId));
    if (Object.keys(lose).length) {
      const merged = Object.assign({}, lose, keep);
      await conn.query(
        `INSERT INTO record_profiles (organization_id, entity, record_id, data) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data)`, [orgId, tableName, keepId, JSON.stringify(merged)]);
    }
    await conn.query(`UPDATE IGNORE record_secrets SET record_id = ? WHERE organization_id = ? AND entity = ? AND record_id = ?`, [keepId, orgId, tableName, loseId]);
    await conn.query(`DELETE FROM record_secrets WHERE organization_id = ? AND entity = ? AND record_id = ?`, [orgId, tableName, loseId]);
    await conn.query(`UPDATE record_notes SET record_id = ? WHERE organization_id = ? AND entity = ? AND record_id = ?`, [keepId, orgId, tableName, loseId]);
    await conn.query(`DELETE FROM record_profiles WHERE organization_id = ? AND entity = ? AND record_id = ?`, [orgId, tableName, loseId]);
    // A form both records have: keep whichever has more signatures (the survivor's when equal).
    const [bothForms] = await conn.query(`SELECT record_id, form_type, data, signatures FROM record_forms WHERE organization_id = ? AND entity = ? AND record_id IN (?, ?)`, [orgId, tableName, keepId, loseId]);
    const nSig = (r) => { try { return Object.keys(JSON.parse(r.signatures || '{}')).length; } catch (e) { return 0; } };
    for (const lf of bothForms.filter((r) => r.record_id === loseId)) {
      const kf = bothForms.find((r) => r.record_id === keepId && r.form_type === lf.form_type);
      if (kf && nSig(lf) > nSig(kf)) {
        await conn.query(`UPDATE record_forms SET data = ?, signatures = ? WHERE organization_id = ? AND entity = ? AND record_id = ? AND form_type = ?`, [lf.data, lf.signatures, orgId, tableName, keepId, lf.form_type]);
      }
    }
    await conn.query(`UPDATE IGNORE record_forms SET record_id = ? WHERE organization_id = ? AND entity = ? AND record_id = ?`, [keepId, orgId, tableName, loseId]);
    await conn.query(`DELETE FROM record_forms WHERE organization_id = ? AND entity = ? AND record_id = ?`, [orgId, tableName, loseId]);
  } catch (err) {
    if (!(err && err.code === 'ER_NO_SUCH_TABLE')) throw err;
  }
}


// The surviving record keeps its own contact details; anything it leaves blank is filled from the
// record being removed, and it stays active if either one was.
async function mergeCoreFields(conn, tableName, keepId, loseId, orgId) {
  const [rows] = await conn.query(`SELECT * FROM ${tableName} WHERE organization_id = ? AND id IN (?, ?)`, [orgId, keepId, loseId]);
  const keep = rows.find((r) => r.id === keepId), lose = rows.find((r) => r.id === loseId);
  if (!keep || !lose) return;
  const sets = []; const params = [];
  ['email', 'phone', 'address'].forEach((c) => { if (!String(keep[c] || '').trim() && String(lose[c] || '').trim()) { sets.push(`${c} = ?`); params.push(lose[c]); } });
  if (keep.status !== 'active' && lose.status === 'active') { sets.push("status = 'active'"); }
  if (sets.length) await conn.query(`UPDATE ${tableName} SET ${sets.join(', ')} WHERE id = ? AND organization_id = ?`, params.concat([keepId, orgId]));
}

// Consultant profiles remember their supplier company by id inside the profile data.
async function repointProfileSupplier(conn, keepId, loseId, orgId) {
  try {
    const [rows] = await conn.query(`SELECT record_id, data FROM record_profiles WHERE organization_id = ? AND entity = 'consultants'`, [orgId]);
    for (const r of rows) {
      let d; try { d = JSON.parse(r.data || '{}'); } catch (e) { continue; }
      if (String(d.supplier_id) === String(loseId)) {
        d.supplier_id = String(keepId);
        await conn.query(`UPDATE record_profiles SET data = ? WHERE organization_id = ? AND entity = 'consultants' AND record_id = ?`, [JSON.stringify(d), orgId, r.record_id]);
      }
    }
  } catch (err) { if (!(err && err.code === 'ER_NO_SUCH_TABLE')) throw err; }
}

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
    { table: 'onboardings', column: 'consultant_id', optional: true },
  ],
  subvendors: [
    { table: 'margin_roster_entries', column: 'subvendor_id' },
    { table: 'ledger_roster_entries', column: 'subvendor_id' },
    { table: 'subvendor_invoices', column: 'subvendor_id', ignore: true },
    { table: 'onboardings', column: 'supplier_id', optional: true },
    { table: 'consultant_assignments', column: 'supplier_id', optional: true },
    { table: 'vendor_requests', column: 'supplier_id', optional: true },
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
      `SELECT a.id, a.consultant_id, a.billing, a.pay_rate, a.source, a.status, a.left_date, a.client_id, a.program_id,
         a.employment_type, a.supplier_id, cl.name AS client_name, p.name AS program_name, sv.name AS supplier_name
       FROM consultant_assignments a
       LEFT JOIN clients cl ON cl.id = a.client_id
       LEFT JOIN programs p ON p.id = a.program_id
       LEFT JOIN subvendors sv ON sv.id = a.supplier_id
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
      `SELECT a.id, a.billing, a.pay_rate, a.source, a.status, a.left_date, a.client_id, a.program_id,
         a.employment_type, a.supplier_id, cl.name AS client_name, p.name AS program_name, sv.name AS supplier_name
       FROM consultant_assignments a
       LEFT JOIN clients cl ON cl.id = a.client_id
       LEFT JOIN programs p ON p.id = a.program_id
       LEFT JOIN subvendors sv ON sv.id = a.supplier_id
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
    const payRate = body.pay_rate === undefined ? undefined
      : (body.pay_rate === null || body.pay_rate === '' ? null : Number(body.pay_rate));
    if (payRate !== undefined && payRate !== null && !Number.isFinite(payRate)) {
      return res.status(400).json({ error: 'Pay rate must be a number.' });
    }

    if (!clientId) return res.status(400).json({ error: 'Every consultant needs a client. Choose the client.' });
    if (clientId) {
      const [clientRows] = await pool.query('SELECT id FROM clients WHERE id = ? AND organization_id = ?', [clientId, req.user.organization_id]);
      if (!clientRows.length) return res.status(400).json({ error: 'Unknown client.' });
    }
    if (programId) {
      const [programRows] = await pool.query(
        'SELECT id FROM programs WHERE id = ? AND organization_id = ? AND client_id <=> ?',
        [programId, req.user.organization_id, clientId]
      );
      if (!programRows.length) return res.status(400).json({ error: 'Unknown vendor, or it doesn’t belong to that client.' });
    }

    const assignmentId = await upsertAssignmentBilling(pool, {
      organizationId: req.user.organization_id, consultantId: Number(req.params.id),
      clientId, programId, billing, payRate, source: 'manual', status: 'active',
    });
    const dflt = await defaultsFor(pool, req.user.organization_id, Number(req.params.id));
    await pool.query('UPDATE consultant_assignments SET employment_type = COALESCE(employment_type, ?), supplier_id = COALESCE(supplier_id, ?) WHERE id = ?', [dflt.employmentType, dflt.supplierId, assignmentId]);

    const [rows] = await pool.query(
      `SELECT a.id, a.billing, a.pay_rate, a.source, a.status, a.left_date, a.client_id, a.program_id,
         a.employment_type, a.supplier_id, cl.name AS client_name, p.name AS program_name, sv.name AS supplier_name
       FROM consultant_assignments a
       LEFT JOIN clients cl ON cl.id = a.client_id
       LEFT JOIN programs p ON p.id = a.program_id
       LEFT JOIN subvendors sv ON sv.id = a.supplier_id
       WHERE a.id = ?`,
      [assignmentId]
    );
    res.status(201).json({ assignment: rows[0] });
  } catch (err) {
    next(err);
  }
});

const ASSIGN_ONE = `SELECT a.id, a.consultant_id, a.billing, a.pay_rate, a.source, a.status, a.left_date, a.client_id, a.program_id,
    a.employment_type, a.supplier_id, cl.name AS client_name, p.name AS program_name, sv.name AS supplier_name
  FROM consultant_assignments a
  LEFT JOIN clients cl ON cl.id = a.client_id
  LEFT JOIN programs p ON p.id = a.program_id
  LEFT JOIN subvendors sv ON sv.id = a.supplier_id
  WHERE a.id = ? AND a.organization_id = ?`;

// Billing and pay rate: anyone who can use the Directory. Client, vendor, supplier and worker
// type: HR or an owner only, checked against the rules in placementRules.js.
router.patch('/assignments/:id', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const orgId = req.user.organization_id;
    const body = req.body || {};
    const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
    const [curRows] = await conn.query(ASSIGN_ONE, [req.params.id, orgId]);
    if (!curRows.length) return res.status(404).json({ error: 'Not found.' });
    const cur = curRows[0];
    const sets = []; const params = [];
    for (const [key, col, label] of [['billing', 'billing', 'Billing'], ['pay_rate', 'pay_rate', 'Pay rate']]) {
      if (body[key] === undefined) continue;
      const v = num(body[key]);
      if (v !== null && (!Number.isFinite(v) || v < 0)) return res.status(400).json({ error: label + ' must be a number.' });
      sets.push(col + ' = ?'); params.push(v);
    }
    const dayOf = (v) => { const t = v ? String(v).slice(0, 10) : ''; return /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t + 'T00:00:00Z')) ? t : null; };
    let statusChange = null;
    if (body.status !== undefined || body.left_date !== undefined) {
      if (!isHrUser(req.user)) return res.status(403).json({ error: 'Only HR or an administrator can end or reopen a placement.' });
      const st = body.status !== undefined ? String(body.status).toLowerCase() : cur.status;
      if (!['active', 'left'].includes(st)) return res.status(400).json({ error: 'Status must be Active or Left.' });
      let ld = st === 'left' ? (body.left_date !== undefined ? dayOf(body.left_date) : (cur.left_date ? dayOf(new Date(cur.left_date).toISOString()) : null)) : null;
      if (st === 'left' && body.left_date && !dayOf(body.left_date)) return res.status(400).json({ error: 'The end date must be a date.' });
      statusChange = { status: st, leftDate: ld };
      sets.push('status = ?', 'left_date = ?'); params.push(st, ld);
      if (st === 'active') sets.push('left_text = NULL');
    }
    const idOf = (v) => (v === undefined ? undefined : (v === null || v === '' ? null : Number(v)));
    const want = { client: idOf(body.client_id), program: idOf(body.program_id), supplier: idOf(body.supplier_id), type: body.employment_type };
    const structural = want.client !== undefined || want.program !== undefined || want.supplier !== undefined || want.type !== undefined;
    let note = null; let moved = null;
    if (structural) {
      if (!isHrUser(req.user)) return res.status(403).json({ error: 'Only HR or an administrator can change a placement’s client, vendor, supplier or worker type.' });
      const newClient = want.client !== undefined ? want.client : cur.client_id;
      let newProgram = want.program !== undefined ? want.program : cur.program_id;
      if (want.client !== undefined && want.client !== cur.client_id && want.program === undefined) newProgram = null; // the old vendor belonged to the old client
      if (!newClient) return res.status(400).json({ error: 'Every consultant needs a client. Choose the client.' });
      const [cl] = await conn.query('SELECT id, name FROM clients WHERE id = ? AND organization_id = ?', [newClient, orgId]);
      if (!cl.length) return res.status(400).json({ error: 'Unknown client.' });
      let pname = null;
      if (newProgram) {
        const [pr] = await conn.query('SELECT id, name FROM programs WHERE id = ? AND organization_id = ? AND client_id = ?', [newProgram, orgId, newClient]);
        if (!pr.length) return res.status(400).json({ error: 'That vendor does not belong to the chosen client.' });
        pname = pr[0].name;
      }
      let newSupplier = want.supplier !== undefined ? want.supplier : cur.supplier_id;
      if (newSupplier) { const [sv] = await conn.query('SELECT id FROM subvendors WHERE id = ? AND organization_id = ?', [newSupplier, orgId]); if (!sv.length) return res.status(400).json({ error: 'Unknown supplier company.' }); }
      let newType = want.type !== undefined ? String(want.type) : (cur.employment_type || 'Unspecified');
      if (!['Subvendor', 'W2 (direct)', '1099 (direct)', 'Unspecified'].includes(newType)) return res.status(400).json({ error: 'Worker type must be Subvendor, W2 (direct), 1099 (direct) or Unspecified.' });
      const typeChanged = newType !== (cur.employment_type || 'Unspecified');
      const supplierChanged = newSupplier !== (cur.supplier_id || null);
      if (typeChanged && newType === 'W2 (direct)' && want.supplier === undefined) newSupplier = null; // switching to W2 drops the supplier
      const ruleErr = checkSupplierRule({ employmentType: newType, supplierId: newSupplier, enforce: typeChanged || supplierChanged });
      if (ruleErr && (typeChanged || supplierChanged)) return res.status(400).json({ error: ruleErr });
      const pairChanged = newClient !== cur.client_id || (newProgram || null) !== (cur.program_id || null);
      if (pairChanged) {
        const [clash] = await conn.query('SELECT id FROM consultant_assignments WHERE organization_id = ? AND consultant_id = ? AND client_id <=> ? AND program_id <=> ? AND id <> ?', [orgId, cur.consultant_id, newClient, newProgram || null, cur.id]);
        if (clash.length) return res.status(409).json({ error: 'This consultant already has a placement with that client and vendor. Edit that one instead.' });
        moved = { from: { clientId: cur.client_id, programId: cur.program_id }, to: { clientId: newClient, programId: newProgram || null, clientName: cl[0].name, programName: pname } };
        sets.push('client_id = ?', 'program_id = ?'); params.push(newClient, newProgram || null);
      }
      if (typeChanged) { sets.push('employment_type = ?'); params.push(newType); }
      if (supplierChanged || (typeChanged && newType === 'W2 (direct)')) { sets.push('supplier_id = ?'); params.push(newSupplier || null); }
      const bits = [];
      if (pairChanged) bits.push(`client/vendor ${cur.client_name || '(none)'}${cur.program_name ? ' / ' + cur.program_name : ''} → ${cl[0].name}${pname ? ' / ' + pname : ''}`);
      if (typeChanged) bits.push(`worker type ${cur.employment_type || 'Unspecified'} → ${newType}`);
      if (supplierChanged || (typeChanged && newType === 'W2 (direct)')) bits.push('supplier changed');
      if (bits.length) note = 'Placement edited: ' + bits.join('; ');
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
    if (statusChange) note = (note ? note + '; ' : 'Placement edited: ') + (statusChange.status === 'left' ? `ended${statusChange.leftDate ? ' ' + statusChange.leftDate : ''}` : 'reopened');
    await conn.beginTransaction();
    await conn.query(`UPDATE consultant_assignments SET ${sets.join(', ')}, source = 'manual' WHERE id = ? AND organization_id = ?`, [...params, cur.id, orgId]);
    if (statusChange) await syncConsultantStatus(conn, cur.consultant_id);
    if (moved) await repointMarginRows(conn, orgId, cur.consultant_id, moved.from, moved.to);
    if (note) {
      try { await conn.query(`INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, 'consultants', ?, 'log', ?, ?)`, [orgId, cur.consultant_id, note, req.user.name || req.user.email]); }
      catch (e) { if (!isMissingTable(e)) throw e; }
    }
    await conn.commit();
    const [rows] = await pool.query(ASSIGN_ONE, [cur.id, orgId]);
    res.json({ assignment: rows[0] });
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* no-op */ }
    next(err);
  } finally { conn.release(); }
});

// Swap client and vendor on one placement (they were entered the wrong way round): the old vendor name
// becomes the client and the old client name becomes the vendor under it. Missing records are created.
router.post('/assignments/:id/swap', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    if (!isHrUser(req.user)) return res.status(403).json({ error: 'Only HR or an administrator can swap a placement’s client and vendor.' });
    const orgId = req.user.organization_id;
    const [curRows] = await conn.query(ASSIGN_ONE, [req.params.id, orgId]);
    if (!curRows.length) return res.status(404).json({ error: 'Not found.' });
    const cur = curRows[0];
    if (!cur.client_name || !cur.program_name) return res.status(400).json({ error: 'Nothing to swap: this placement needs both a client and a vendor.' });
    await conn.beginTransaction();
    const newClient = await findOrCreateDirectoryRecord(conn, 'clients', { organizationId: orgId, name: cur.program_name, status: 'active' });
    const newProgram = await findOrCreateDirectoryRecord(conn, 'programs', { organizationId: orgId, clientId: newClient.id, name: cur.client_name, status: 'active' });
    const [clash] = await conn.query('SELECT id FROM consultant_assignments WHERE organization_id = ? AND consultant_id = ? AND client_id <=> ? AND program_id <=> ? AND id <> ?', [orgId, cur.consultant_id, newClient.id, newProgram.id, cur.id]);
    if (clash.length) { await conn.rollback(); return res.status(409).json({ error: 'This consultant already has a placement with that client and vendor. Edit or remove one of them.' }); }
    await conn.query(`UPDATE consultant_assignments SET client_id = ?, program_id = ?, source = 'manual' WHERE id = ? AND organization_id = ?`, [newClient.id, newProgram.id, cur.id, orgId]);
    await repointMarginRows(conn, orgId, cur.consultant_id, { clientId: cur.client_id, programId: cur.program_id }, { clientId: newClient.id, programId: newProgram.id, clientName: cur.program_name, programName: cur.client_name });
    try { await conn.query(`INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, 'consultants', ?, 'log', ?, ?)`, [orgId, cur.consultant_id, `Placement swapped: client ${cur.client_name} / vendor ${cur.program_name} → client ${cur.program_name} / vendor ${cur.client_name}`, req.user.name || req.user.email]); }
    catch (e) { if (!isMissingTable(e)) throw e; }
    await conn.commit();
    const [rows] = await pool.query(ASSIGN_ONE, [cur.id, orgId]);
    res.json({ assignment: rows[0] });
  } catch (err) { try { await conn.rollback(); } catch (_) { /* no-op */ } next(err); } finally { conn.release(); }
});

// Employment status of a consultant. Inactive: every active placement is ended on the end date (today when
// none is given). Active: the most recently ended placement is reopened. HR or owner only.
router.post('/consultants/:id/status', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    if (!isHrUser(req.user)) return res.status(403).json({ error: 'Only HR or an administrator can change a consultant’s status.' });
    const orgId = req.user.organization_id;
    const consultant = await findConsultant(req.params.id, orgId);
    if (!consultant) return res.status(404).json({ error: 'Not found.' });
    const status = String((req.body && req.body.status) || '').toLowerCase();
    if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: 'Choose Active or Inactive.' });
    const rawEnd = req.body && req.body.endDate ? String(req.body.endDate).slice(0, 10) : '';
    if (rawEnd && (!/^\d{4}-\d{2}-\d{2}$/.test(rawEnd) || Number.isNaN(Date.parse(rawEnd + 'T00:00:00Z')))) return res.status(400).json({ error: 'The end date must be a date.' });
    const end = rawEnd || new Date().toISOString().slice(0, 10);
    await conn.beginTransaction();
    let changed = 0;
    if (status === 'inactive') {
      const [r] = await conn.query(`UPDATE consultant_assignments SET status = 'left', left_date = ?, source = 'manual' WHERE organization_id = ? AND consultant_id = ? AND status = 'active'`, [end, orgId, consultant.id]);
      changed = r.affectedRows;
      await conn.query(`UPDATE consultants SET status = 'inactive' WHERE id = ? AND organization_id = ?`, [consultant.id, orgId]);
    } else {
      const [last] = await conn.query(`SELECT id FROM consultant_assignments WHERE organization_id = ? AND consultant_id = ? AND status = 'left' ORDER BY left_date IS NULL, left_date DESC, id DESC LIMIT 1`, [orgId, consultant.id]);
      const [act] = await conn.query(`SELECT id FROM consultant_assignments WHERE organization_id = ? AND consultant_id = ? AND status = 'active' LIMIT 1`, [orgId, consultant.id]);
      if (!act.length && !last.length) { await conn.rollback(); return res.status(409).json({ error: 'This consultant has no placement yet. Add a placement with a client first.' }); }
      if (!act.length) { await conn.query(`UPDATE consultant_assignments SET status = 'active', left_date = NULL, left_text = NULL, source = 'manual' WHERE id = ?`, [last[0].id]); changed = 1; }
      await conn.query(`UPDATE consultants SET status = 'active' WHERE id = ? AND organization_id = ?`, [consultant.id, orgId]);
    }
    try { await conn.query(`INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, 'consultants', ?, 'log', ?, ?)`, [orgId, consultant.id, status === 'inactive' ? `Marked inactive; ${changed} placement(s) ended ${end}` : `Marked active${changed ? '; latest placement reopened' : ''}`, req.user.name || req.user.email]); }
    catch (e) { if (!isMissingTable(e)) throw e; }
    await conn.commit();
    const [rows] = await pool.query('SELECT * FROM consultants WHERE id = ?', [consultant.id]);
    const [assignments] = await pool.query(`${ASSIGN_ONE.replace('WHERE a.id = ? AND a.organization_id = ?', 'WHERE a.consultant_id = ? AND a.organization_id = ? ORDER BY a.status, cl.name, p.name')}`, [consultant.id, orgId]);
    res.json({ consultant: rows[0], assignments, changed });
  } catch (err) { try { await conn.rollback(); } catch (_) { /* no-op */ } next(err); } finally { conn.release(); }
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

// Adds several client/vendor pairings in one go (a consultant working on more
// than one project at once). body: { text } -- one project per line:
//   Client, Vendor, Billing $/hr, Pay rate $/hr   (tab- or comma-separated)
// Missing clients and vendors are created; an existing pairing has its rates updated.
router.post('/consultants/:id/assignments/bulk', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const organizationId = req.user.organization_id;
    const consultant = await findConsultant(req.params.id, organizationId);
    if (!consultant) return res.status(404).json({ error: 'Not found.' });
    const money = (v) => { const n = Number(String(v === undefined ? '' : v).replace(/[$,\s]/g, '')); return String(v || '').trim() === '' ? null : n; };
    const lines = String((req.body && req.body.text) || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rows = [];
    // Structured rows (the add form sends these, so names may contain commas).
    for (const x of Array.isArray(req.body && req.body.rows) ? req.body.rows : []) {
      const client = normalizeName(x && x.client); if (!client) continue;
      const billing = money(x.billing); const payRate = money(x.pay_rate);
      if ((billing !== null && !Number.isFinite(billing)) || (payRate !== null && !Number.isFinite(payRate))) return res.status(400).json({ error: 'Billing and pay rate must be numbers.' });
      rows.push({ client, vendor: normalizeName(x.vendor) || '', billing, payRate, supplier: normalizeName(x.supplier) || '' });
    }
    for (const line of lines) {
      const cells = (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim().replace(/^\d+[.)]\s+/, ''));
      if (/^client$/i.test(cells[0])) continue; // header
      const [client, vendor, bill, pay] = cells;
      if (!client) continue;
      const billing = money(bill); const payRate = money(pay);
      if ((billing !== null && !Number.isFinite(billing)) || (payRate !== null && !Number.isFinite(payRate))) {
        return res.status(400).json({ error: `Couldn’t read the rates on: “${line}”. Use numbers like 240 or $240.` });
      }
      rows.push({ client, vendor: vendor || '', billing, payRate });
    }
    if (!rows.length) return res.status(400).json({ error: 'Add at least one line: Client, Vendor, Billing, Pay rate.' });

    const dflt = await defaultsFor(conn, organizationId, consultant.id);
    for (const r of rows) {
      let sid = dflt.supplierId;
      if (r.supplier) { const [sv] = await conn.query('SELECT id FROM subvendors WHERE organization_id = ? AND LOWER(name) = LOWER(?)', [organizationId, r.supplier]); sid = sv[0] ? sv[0].id : -1; }
      const ruleErr = checkSupplierRule({ employmentType: dflt.employmentType, supplierId: sid || (r.supplier ? -1 : null), enforce: true });
      if (ruleErr) return res.status(400).json({ error: ruleErr + (dflt.employmentType === 'Subvendor' ? ' Pick the supplier company for this project.' : '') });
    }
    await conn.beginTransaction();
    for (const r of rows) {
      const client = await findOrCreateDirectoryRecord(conn, 'clients', { organizationId, name: r.client, status: 'active' });
      const program = r.vendor && r.vendor.toLowerCase() !== r.client.toLowerCase()
        ? await findOrCreateDirectoryRecord(conn, 'programs', { organizationId, clientId: client.id, name: r.vendor, status: 'active' }) : null;
      const aid = await upsertAssignmentBilling(conn, {
        organizationId, consultantId: consultant.id, clientId: client.id, programId: program ? program.id : null,
        billing: r.billing, payRate: r.payRate, source: 'manual', status: 'active',
      });
      let sid = dflt.supplierId;
      if (r.supplier) sid = (await findOrCreateDirectoryRecord(conn, 'subvendors', { organizationId, name: r.supplier, status: 'active' })).id;
      if (dflt.employmentType === 'W2 (direct)') sid = null;
      await conn.query('UPDATE consultant_assignments SET employment_type = COALESCE(employment_type, ?), supplier_id = COALESCE(supplier_id, ?) WHERE id = ?', [dflt.employmentType, sid, aid]);
    }
    await conn.commit();
    const [assignments] = await pool.query(
      `SELECT a.id, a.billing, a.pay_rate, a.source, a.status, a.left_date, a.client_id, a.program_id,
         a.employment_type, a.supplier_id, cl.name AS client_name, p.name AS program_name, sv.name AS supplier_name
       FROM consultant_assignments a
       LEFT JOIN clients cl ON cl.id = a.client_id
       LEFT JOIN programs p ON p.id = a.program_id
       LEFT JOIN subvendors sv ON sv.id = a.supplier_id
       WHERE a.organization_id = ? AND a.consultant_id = ?
       ORDER BY a.status, cl.name, p.name`, [organizationId, consultant.id]);
    res.status(201).json({ assignments, added: rows.length });
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* no-op */ }
    next(err);
  } finally {
    conn.release();
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
    if (!clientName) return res.status(400).json({ error: 'clientText must name a client (e.g. "Vendor/Client" or "Client").' });
    const billing = body.billing === null || body.billing === undefined || body.billing === '' ? null : Number(body.billing);
    if (billing !== null && (!Number.isFinite(billing) || billing < 0)) return res.status(400).json({ error: 'Billing must be a number.' });

    const payRate = body.pay_rate === undefined || body.pay_rate === null || body.pay_rate === '' ? undefined : Number(body.pay_rate);
    if (payRate !== undefined && (!Number.isFinite(payRate) || payRate < 0)) return res.status(400).json({ error: 'Pay rate must be a number.' });

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
        billing, payRate, source: 'manual', status: 'active',
      });
    }
    if (existed && payRate !== undefined) await conn.query('UPDATE consultant_assignments SET pay_rate = COALESCE(pay_rate, ?) WHERE id = ?', [payRate, assignmentId]);
    await conn.commit();
    const [rows] = await pool.query(
      `SELECT a.id, a.billing, a.pay_rate, a.source, a.status, a.left_date, a.client_id, a.program_id,
         a.employment_type, a.supplier_id, cl.name AS client_name, p.name AS program_name, sv.name AS supplier_name
       FROM consultant_assignments a
       LEFT JOIN clients cl ON cl.id = a.client_id
       LEFT JOIN programs p ON p.id = a.program_id
       LEFT JOIN subvendors sv ON sv.id = a.supplier_id
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

// Swap a vendor row's Name and Client. A program P named V under client C
// becomes program C under client V, and everything that pointed at P/C for
// it (Margin rows, placements, invoices, saved name matches) is repointed.
// Nothing is deleted unless it is left completely unreferenced; collisions
// with an existing placement/invoice stay where they were and are reported.
// body: { ids: [programId, ...] }
router.post('/programs/swap', async (req, res, next) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'Choose at least one vendor row.' });
  const conn = await pool.getConnection();
  try {
    const organizationId = req.user.organization_id;
    const swapped = []; const skipped = [];
    await conn.beginTransaction();
    for (const pid of ids) {
      const [[p]] = await conn.query(
        `SELECT p.id, p.name, p.client_id, c.name AS client_name FROM programs p JOIN clients c ON c.id = p.client_id
         WHERE p.id = ? AND p.organization_id = ?`, [pid, organizationId]);
      if (!p) { skipped.push({ id: pid, reason: 'not found (already swapped?)' }); continue; }
      const newClient = await findOrCreateDirectoryRecord(conn, 'clients', { organizationId, name: p.name, status: 'active' });
      const newProgram = await findOrCreateDirectoryRecord(conn, 'programs', { organizationId, clientId: newClient.id, name: p.client_name, status: 'active' });
      if (newProgram.id === p.id) { skipped.push({ id: pid, reason: 'already the same' }); continue; }
      const where = 'program_id = ? AND client_id = ? AND organization_id = ?';
      const args = [newClient.id, newProgram.id, p.id, p.client_id, organizationId];
      await conn.query(`UPDATE margin_roster_entries SET client_id = ?, program_id = ? WHERE ${where}`, args);
      await conn.query(`UPDATE IGNORE consultant_assignments SET client_id = ?, program_id = ? WHERE ${where}`, args);
      await conn.query(`UPDATE IGNORE invoices SET client_id = ?, program_id = ? WHERE ${where}`, args);
      await updateReferences(conn, 'client_text_aliases', `UPDATE client_text_aliases SET client_id = ?, program_id = ? WHERE ${where}`, args, true);
      let left = 0;
      for (const t of ['margin_roster_entries', 'consultant_assignments', 'invoices']) {
        const [[r]] = await conn.query(`SELECT COUNT(*) AS n FROM ${t} WHERE program_id = ?`, [p.id]);
        left += r.n;
      }
      if (!left) {
        await conn.query(`DELETE FROM directory_duplicate_candidates WHERE table_name = 'programs' AND (record_id = ? OR matched_record_id = ?)`, [p.id, p.id]);
        await conn.query('DELETE FROM programs WHERE id = ? AND organization_id = ?', [p.id, organizationId]);
      } else skipped.push({ id: pid, reason: left + ' record(s) could not move because the new pairing already has the same entry' });
      swapped.push({ id: pid, client: p.name, vendor: p.client_name });
    }
    await conn.commit();
    res.json({ swapped, skipped });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
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

// ---- Fix-it list: placements that break the client / supplier rules (HR or owner) ----
const denyHr = (res) => res.status(403).json({ error: 'Only HR or an administrator can see or fix this.' });

router.get('/placement-issues', async (req, res, next) => {
  try {
    if (!isHrUser(req.user)) return denyHr(res);
    const orgId = req.user.organization_id;
    const [noClient] = await pool.query(
      `SELECT c.id, c.name, c.status FROM consultants c
       WHERE c.organization_id = ? AND (c.status IS NULL OR c.status <> 'inactive')
         AND NOT EXISTS (SELECT 1 FROM consultant_assignments a WHERE a.consultant_id = c.id AND a.client_id IS NOT NULL)
       ORDER BY c.name`, [orgId]);
    const [w2Placements] = await pool.query(
      `SELECT a.id AS assignment_id, c.id AS consultant_id, c.name AS consultant, cl.name AS client, sv.name AS supplier
       FROM consultant_assignments a JOIN consultants c ON c.id = a.consultant_id
       LEFT JOIN clients cl ON cl.id = a.client_id JOIN subvendors sv ON sv.id = a.supplier_id
       WHERE a.organization_id = ? AND a.employment_type = 'W2 (direct)' ORDER BY c.name`, [orgId]);
    const [profiles] = await pool.query(
      `SELECT p.record_id AS consultant_id, c.name AS consultant, p.data FROM record_profiles p JOIN consultants c ON c.id = p.record_id
       WHERE p.organization_id = ? AND p.entity = 'consultants'`, [orgId]).catch(() => [[]]);
    const w2Profiles = [];
    for (const r of profiles || []) {
      let d = {}; try { d = JSON.parse(r.data) || {}; } catch (e) { /* skip */ }
      if (d.worker_type === 'W2' && d.supplier_id) w2Profiles.push({ consultant_id: r.consultant_id, consultant: r.consultant, supplier_id: d.supplier_id });
    }
    const [missingSupplier] = await pool.query(
      `SELECT a.id AS assignment_id, c.id AS consultant_id, c.name AS consultant, cl.name AS client
       FROM consultant_assignments a JOIN consultants c ON c.id = a.consultant_id LEFT JOIN clients cl ON cl.id = a.client_id
       WHERE a.organization_id = ? AND a.employment_type = 'Subvendor' AND a.supplier_id IS NULL AND a.status = 'active' ORDER BY c.name`, [orgId]);
    res.json({ noClient, w2Placements, w2Profiles, missingSupplier });
  } catch (err) { next(err); }
});

// Clears the supplier from W2 consultants (their placements and, where set, their profile). Only rows that
// really are W2 are touched; the caller lists the ids to clear.
router.post('/placement-issues/clear-supplier', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    if (!isHrUser(req.user)) return denyHr(res);
    const orgId = req.user.organization_id;
    const aIds = (Array.isArray(req.body && req.body.assignmentIds) ? req.body.assignmentIds : []).map(Number).filter(Number.isInteger).slice(0, 2000);
    const cIds = (Array.isArray(req.body && req.body.consultantIds) ? req.body.consultantIds : []).map(Number).filter(Number.isInteger).slice(0, 2000);
    if (!aIds.length && !cIds.length) return res.status(400).json({ error: 'Nothing selected.' });
    await conn.beginTransaction();
    let placements = 0, profiles = 0;
    if (aIds.length) {
      const [r] = await conn.query(`UPDATE consultant_assignments SET supplier_id = NULL WHERE organization_id = ? AND id IN (?) AND employment_type = 'W2 (direct)'`, [orgId, aIds]);
      placements = r.affectedRows;
      const [who] = await conn.query(`SELECT DISTINCT consultant_id FROM consultant_assignments WHERE organization_id = ? AND id IN (?)`, [orgId, aIds]);
      for (const w of who) await conn.query(`INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, 'consultants', ?, 'log', ?, ?)`, [orgId, w.consultant_id, 'Supplier cleared from W2 placement(s) (W2 consultants have no supplier company)', req.user.name || req.user.email]);
    }
    for (const id of cIds) {
      const [p] = await conn.query(`SELECT data FROM record_profiles WHERE organization_id = ? AND entity = 'consultants' AND record_id = ? FOR UPDATE`, [orgId, id]);
      let d = {}; try { d = (p[0] && JSON.parse(p[0].data)) || {}; } catch (e) { d = {}; }
      if (d.worker_type === 'W2' && d.supplier_id) {
        delete d.supplier_id;
        await conn.query(`UPDATE record_profiles SET data = ? WHERE organization_id = ? AND entity = 'consultants' AND record_id = ?`, [JSON.stringify(d), orgId, id]);
        await conn.query(`INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, 'consultants', ?, 'log', ?, ?)`, [orgId, id, 'Supplier cleared from the profile (W2 consultants have no supplier company)', req.user.name || req.user.email]);
        profiles++;
      }
    }
    await conn.commit();
    res.json({ ok: true, placements, profiles });
  } catch (err) { try { await conn.rollback(); } catch (_) { /* no-op */ } next(err); } finally { conn.release(); }
});

router.get('/:table/:id/usage', async (req, res, next) => {
  try {
    const tableName = req.params.table;
    if (!DIRECTORY_TABLES.includes(tableName)) {
      return res.status(400).json({ error: 'Unknown table. Use consultants, supplier companies, clients, or vendors.' });
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
      return res.status(400).json({ error: 'Unknown table. Use consultants, supplier companies, clients, or vendors.' });
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

// Looks through everything already in the Directory for names that look like the same thing.
router.post('/duplicates/scan', async (req, res, next) => {
  try {
    const requested = req.body && req.body.table;
    if (requested && !DIRECTORY_TABLES.includes(requested)) return res.status(400).json({ error: 'Unknown table.' });
    let opened = 0;
    for (const t of requested ? [requested] : DIRECTORY_TABLES) opened += await scanDuplicates(pool, req.user.organization_id, t);
    res.json({ opened });
  } catch (err) { next(err); }
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

    await mergeCoreFields(conn, tableName, keepId, loseId, req.user.organization_id);
    if (tableName === 'subvendors') await repointProfileSupplier(conn, keepId, loseId, req.user.organization_id);
    await mergeProfileRecords(conn, tableName, keepId, loseId, req.user.organization_id);
    const [[loseRow]] = await conn.query(`SELECT name FROM ${tableName} WHERE id = ?`, [loseId]);
    try {
      await conn.query(`INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, ?, ?, 'log', ?, ?)`,
        [req.user.organization_id, tableName, keepId, `Merged the duplicate record “${loseRow ? loseRow.name : loseId}” into this one. Its links, profile, notes, forms and contact details were moved here.`, req.user.name || req.user.email]);
    } catch (e) { if (!(e && e.code === 'ER_NO_SUCH_TABLE')) throw e; }

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
        error: 'Could not merge: the two records have a conflicting child record (e.g. a vendor with the same name under both clients). Resolve that by hand first.',
      });
    }
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
