// Margin roster straight from the database: every consultant_assignments row is a
// placement (consultant at a client/vendor with billing, pay, supplier, recruiter,
// status). Users add, edit and close placements here; file uploads (marginRoster.js)
// only seed or update the same rows. Records come back in the shape the Margin page
// has always used so the dashboard math is unchanged.
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { normalizeName, upsertConsultant, upsertSubvendor, upsertClient, upsertProgram } = require('./directoryUpsert');
const { upsertAssignmentBilling } = require('./assignmentUpsert');

const router = express.Router();
router.use(requireAuth);

const EMPLOYMENT = ['Subvendor', 'W2 (direct)', '1099 (direct)', 'Unspecified'];

const SELECT = `SELECT a.id, a.consultant_id, c.name, a.client_id, cl.name AS client_name, a.program_id, p.name AS program_name,
    a.billing, a.pay_rate, a.status, a.left_date, a.left_text, a.joined_text, a.recruiter, a.employment_type,
    a.supplier_id, sv.name AS supplier_name, a.source
  FROM consultant_assignments a
  JOIN consultants c ON c.id = a.consultant_id
  LEFT JOIN clients cl ON cl.id = a.client_id
  LEFT JOIN programs p ON p.id = a.program_id
  LEFT JOIN subvendors sv ON sv.id = a.supplier_id`;

const num = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : Number(String(v).replace(/[$,\s]/g, '')));
const text = (v, n) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s ? s.slice(0, n || 255) : null; };
const day = (v) => { const s = v ? String(v).slice(0, 10) : ''; return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };

function toRecord(r) {
  const billing = r.billing === null ? null : Number(r.billing);
  const cost = r.pay_rate === null ? null : Number(r.pay_rate);
  const emp = r.employment_type || 'Unspecified';
  const client = r.client_name || '';
  const program = r.program_name || '(unspecified)';
  return {
    id: r.id, consultantId: r.consultant_id, name: r.name, client, clientId: r.client_id, program, programId: r.program_id,
    clientDetail: r.program_name ? client : null,
    rawClient: r.program_name ? `${r.program_name}/${client}` : client,
    cost, billing, margin: billing !== null && cost !== null ? Math.round((billing - cost) * 100) / 100 : null,
    status: r.status === 'left' ? 'Left' : 'Active',
    joined: r.joined_text || '', leftText: r.left_text || null,
    leftDate: r.left_date ? new Date(r.left_date).toISOString().slice(0, 10) : null,
    recruiter: r.recruiter || null, supplierId: r.supplier_id, subvendorText: r.supplier_name || (emp.startsWith('W2') ? 'W2' : emp.startsWith('1099') ? '1099' : ''),
    employmentType: emp, sourceSheet: r.source === 'upload' ? 'file import' : 'entered in app',
  };
}

// Placements seeded by an earlier upload only have billing; fill the other columns once
// from the latest Margin file (never overwrites anything a person has typed).
async function backfillFromLatestImport(orgId) {
  const [[need]] = await pool.query(
    `SELECT COUNT(*) AS n FROM consultant_assignments WHERE organization_id = ? AND employment_type IS NULL`, [orgId]);
  if (!need.n) return;
  await pool.query(
    `UPDATE consultant_assignments a
       JOIN (SELECT m.consultant_id, m.client_id, m.program_id, MAX(m.id) AS mid FROM margin_roster_entries m
             WHERE m.organization_id = ? AND m.import_id = (SELECT MAX(id) FROM margin_imports WHERE organization_id = ?)
             GROUP BY m.consultant_id, m.client_id, m.program_id) k
         ON k.consultant_id = a.consultant_id AND k.client_id <=> a.client_id AND k.program_id <=> a.program_id
       JOIN margin_roster_entries m ON m.id = k.mid
     SET a.pay_rate = COALESCE(a.pay_rate, m.cost), a.employment_type = COALESCE(m.employment_type, 'Unspecified'),
         a.supplier_id = COALESCE(a.supplier_id, m.subvendor_id), a.recruiter = COALESCE(a.recruiter, m.recruiter),
         a.joined_text = COALESCE(a.joined_text, m.joined_text), a.left_text = COALESCE(a.left_text, m.left_text)
     WHERE a.organization_id = ? AND a.employment_type IS NULL`, [orgId, orgId, orgId]);
  await pool.query(`UPDATE consultant_assignments SET employment_type = 'Unspecified' WHERE organization_id = ? AND employment_type IS NULL`, [orgId]);
}

// A consultant is Active while at least one placement is; Inactive once all are marked Left.
async function syncConsultantStatus(conn, consultantId) {
  await conn.query(
    `UPDATE consultants c SET c.status = IF(EXISTS (SELECT 1 FROM consultant_assignments a WHERE a.consultant_id = c.id AND a.status = 'active'), 'active', 'inactive')
     WHERE c.id = ?`, [consultantId]);
}

async function loadOne(id, orgId) {
  const [rows] = await pool.query(`${SELECT} WHERE a.id = ? AND a.organization_id = ?`, [id, orgId]);
  return rows[0] ? toRecord(rows[0]) : null;
}

router.get('/', async (req, res, next) => {
  try {
    await backfillFromLatestImport(req.user.organization_id);
    const [rows] = await pool.query(`${SELECT} WHERE a.organization_id = ? ORDER BY c.name, cl.name, p.name`, [req.user.organization_id]);
    res.json({ records: rows.map(toRecord) });
  } catch (err) { next(err); }
});

// Reads and validates the editable fields. `partial` = PATCH (only fields that were sent).
function readFields(b, partial) {
  const out = {}; const has = (k) => b[k] !== undefined;
  if (!partial || has('name')) { out.name = normalizeName(b.name); if (!out.name && !partial) return { error: 'Enter the consultant’s name.' }; }
  if (!partial || has('client')) out.client = normalizeName(b.client);
  if (!partial || has('vendor')) out.vendor = normalizeName(b.vendor);
  if (!partial || has('supplier')) out.supplier = normalizeName(b.supplier);
  if (!partial || has('employmentType')) {
    out.employmentType = text(b.employmentType, 64) || 'Unspecified';
    if (!EMPLOYMENT.includes(out.employmentType)) return { error: 'Employment type must be one of: ' + EMPLOYMENT.join(', ') + '.' };
  }
  for (const [key, label] of [['billing', 'Billing'], ['cost', 'Cost']]) {
    if (!partial || has(key)) { const v = num(b[key]); if (v !== null && (!Number.isFinite(v) || v < 0)) return { error: label + ' must be a number.' }; out[key] = v; }
  }
  if (!partial || has('joined')) out.joined = text(b.joined, 64);
  if (!partial || has('recruiter')) out.recruiter = text(b.recruiter);
  if (!partial || has('leftText')) out.leftText = text(b.leftText);
  if (!partial || has('leftDate')) out.leftDate = day(b.leftDate);
  if (!partial || has('status')) {
    const s = String(b.status || 'Active').toLowerCase();
    if (!['active', 'left'].includes(s)) return { error: 'Status must be Active or Left.' };
    out.status = s;
  }
  return { fields: out };
}

async function saveRefs(conn, orgId, f, current) {
  const clientName = f.client !== undefined ? f.client : current.client_name;
  const vendorName = f.vendor !== undefined ? f.vendor : current.program_name;
  let clientId = null; let programId = null;
  if (clientName) clientId = await upsertClient(conn, orgId, clientName, 'active');
  if (clientId && vendorName && vendorName.toLowerCase() !== String(clientName).toLowerCase()) programId = await upsertProgram(conn, orgId, clientId, vendorName, 'active');
  let supplierId = f.supplier !== undefined ? null : current.supplier_id;
  if (f.supplier) supplierId = await upsertSubvendor(conn, orgId, f.supplier, 'active');
  return { clientId, programId, supplierId };
}

router.post('/', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const orgId = req.user.organization_id;
    const { fields: f, error } = readFields(req.body || {}, false);
    if (error) return res.status(400).json({ error });
    if (!f.client) return res.status(400).json({ error: 'Enter the client.' });
    await conn.beginTransaction();
    const consultantId = await upsertConsultant(conn, orgId, f.name, f.status === 'left' ? 'inactive' : 'active');
    const refs = await saveRefs(conn, orgId, f, {});
    const id = await upsertAssignmentBilling(conn, { organizationId: orgId, consultantId, clientId: refs.clientId, programId: refs.programId,
      billing: f.billing, payRate: f.cost, source: 'manual', status: f.status, leftDate: f.status === 'left' ? f.leftDate : null });
    await conn.query(`UPDATE consultant_assignments SET employment_type = ?, supplier_id = ?, recruiter = ?, joined_text = ?, left_text = ? WHERE id = ?`,
      [f.employmentType, refs.supplierId, f.recruiter, f.joined, f.status === 'left' ? f.leftText : null, id]);
    await syncConsultantStatus(conn, consultantId);
    await conn.commit();
    res.status(201).json({ record: await loadOne(id, orgId) });
  } catch (err) { try { await conn.rollback(); } catch (_) { /* no-op */ } next(err); } finally { conn.release(); }
});

router.patch('/:id', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const orgId = req.user.organization_id;
    const [cur] = await pool.query(`${SELECT} WHERE a.id = ? AND a.organization_id = ?`, [req.params.id, orgId]);
    if (!cur.length) return res.status(404).json({ error: 'Not found.' });
    const current = cur[0];
    const { fields: f, error } = readFields(req.body || {}, true);
    if (error) return res.status(400).json({ error });
    if (f.client !== undefined && !f.client) return res.status(400).json({ error: 'The client can’t be empty.' });
    await conn.beginTransaction();
    const refs = await saveRefs(conn, orgId, f, current);
    const [clash] = await conn.query(
      `SELECT id FROM consultant_assignments WHERE organization_id = ? AND consultant_id = ? AND client_id <=> ? AND program_id <=> ? AND id <> ?`,
      [orgId, current.consultant_id, refs.clientId, refs.programId, current.id]);
    if (clash.length) { await conn.rollback(); return res.status(409).json({ error: 'This consultant already has a placement with that client and vendor — edit that one instead.' }); }
    const sets = ['client_id = ?', 'program_id = ?', 'supplier_id = ?']; const params = [refs.clientId, refs.programId, refs.supplierId];
    const map = { billing: 'billing', cost: 'pay_rate', employmentType: 'employment_type', recruiter: 'recruiter', joined: 'joined_text', leftText: 'left_text' };
    for (const [k, col] of Object.entries(map)) if (f[k] !== undefined) { sets.push(col + ' = ?'); params.push(f[k]); }
    if (f.status !== undefined) {
      sets.push('status = ?'); params.push(f.status);
      sets.push('left_date = ?'); params.push(f.status === 'left' ? (f.leftDate !== undefined ? f.leftDate : (current.left_date || null)) : null);
      if (f.status === 'active') sets.push('left_text = NULL');
    } else if (f.leftDate !== undefined) { sets.push('left_date = ?'); params.push(f.leftDate); }
    sets.push("source = 'manual'");
    await conn.query(`UPDATE consultant_assignments SET ${sets.join(', ')} WHERE id = ?`, [...params, current.id]);
    await syncConsultantStatus(conn, current.consultant_id);
    await conn.commit();
    res.json({ record: await loadOne(current.id, orgId) });
  } catch (err) { try { await conn.rollback(); } catch (_) { /* no-op */ } next(err); } finally { conn.release(); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const [cur] = await pool.query('SELECT consultant_id FROM consultant_assignments WHERE id = ? AND organization_id = ?', [req.params.id, req.user.organization_id]);
    const [r] = await pool.query('DELETE FROM consultant_assignments WHERE id = ? AND organization_id = ?', [req.params.id, req.user.organization_id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found.' });
    if (cur.length) await syncConsultantStatus(pool, cur[0].consultant_id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
