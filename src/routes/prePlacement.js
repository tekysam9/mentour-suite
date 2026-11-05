// Pre-placement information (the "Pre-Placement Document"): collected by a recruiter before a placement goes to
// onboarding. Recruiters see their own records, HR admins and the owner see everyone's.
//   * Date of birth and the SSN digits are encrypted, never listed, and only the owner / HR can reveal them
//     (every reveal is written to the Activity log).
//   * A pre-placement exists while the candidate is still being interviewed: draft -> interviewing -> selected. Only a
//     SELECTED candidate can be sent to onboarding. If the candidate is not selected, the sensitive details are erased.
//   * Nothing here touches invoices, supplier payments or the Directory. "Send to onboarding" only creates a
//     draft in the existing Onboarding module.
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const spec = require('./prePlacementSpec');
const onboarding = require('./onboarding');
const { isConfigured, encrypt, decrypt } = require('../crypto');

const router = express.Router();
router.use(requireAuth);

const SCHEMA_MSG = 'Pre-Placement needs the latest database update. Run db/schema.sql on the database, then try again.';
const STATUSES = ['draft', 'interviewing', 'selected', 'not_selected', 'converted'];
const OPEN = ['draft', 'interviewing', 'selected'];
const missingTable = (e) => e && e.code === 'ER_NO_SUCH_TABLE';
const parse = (t, fallback) => { try { const v = t && JSON.parse(t); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; } };
const pad2 = (n) => String(n).padStart(2, '0');
const dateStr = (v) => (!v ? null : v instanceof Date ? v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate()) : String(v).slice(0, 10));
const who = (req) => req.user.name || req.user.email;
const isHr = (req) => req.user.role === 'owner' || req.user.role === 'hr';
const NO_KEY_MSG = 'Date of birth and SSN digits cannot be saved yet: the server has no encryption key. Set FIELD_ENCRYPTION_KEY (see README-DEPLOY.md). Everything else can still be saved.';

function addLog(row, req, text) {
  const l = parse(row.log, []); l.push({ at: new Date().toISOString(), by: who(req), text });
  row.log = JSON.stringify(l.slice(-200));
}
async function load(req, res) {
  if (!/^\d+$/.test(req.params.id)) { res.status(404).json({ error: 'Not found.' }); return null; }
  const [rows] = await pool.query('SELECT * FROM pre_placements WHERE id = ? AND organization_id = ?', [req.params.id, req.user.organization_id]);
  if (!rows[0] || (!isHr(req) && rows[0].created_by_id !== req.user.id)) { res.status(404).json({ error: 'Pre-placement not found.' }); return null; }
  return rows[0];
}
// Which sensitive values exist, without decrypting them.
function secretFlags(row) {
  const flags = { dob: false, ssn_last5: false };
  if (!row.secrets) return flags;
  if (isConfigured()) {
    try { const s = JSON.parse(decrypt(row.secrets)); flags.dob = !!s.dob; flags.ssn_last5 = !!s.ssn_last5; return flags; } catch (e) { /* fall through */ }
  }
  flags.dob = flags.ssn_last5 = true; // a sealed value is stored; we just cannot read it right now
  return flags;
}
function present(row, req, extra) {
  return Object.assign({
    id: row.id, status: row.status, consultantName: row.consultant_name, data: parse(row.data, {}), secretsSaved: secretFlags(row),
    onboardingId: row.onboarding_id || null, log: parse(row.log, []), createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    canReveal: isHr(req) && isConfigured(), canEdit: OPEN.includes(row.status),
  }, extra || {});
}
async function similarOnes(orgId, name, email, exceptId) {
  const out = [];
  try {
    const [byName] = await pool.query(
      `SELECT id, consultant_name, status FROM pre_placements WHERE organization_id = ? AND status IN ('draft','interviewing','selected') AND LOWER(consultant_name) = LOWER(?)${exceptId ? ' AND id <> ?' : ''} LIMIT 5`,
      exceptId ? [orgId, name, exceptId] : [orgId, name]);
    byName.forEach((r) => out.push({ id: r.id, name: r.consultant_name, status: r.status, why: 'same name' }));
    if (email) {
      const [byMail] = await pool.query(
        `SELECT id, consultant_name, status FROM pre_placements WHERE organization_id = ? AND status IN ('draft','interviewing','selected') AND data LIKE ?${exceptId ? ' AND id <> ?' : ''} LIMIT 5`,
        exceptId ? [orgId, '%"consultant_email":' + JSON.stringify(email) + '%', exceptId] : [orgId, '%"consultant_email":' + JSON.stringify(email) + '%']);
      byMail.forEach((r) => { if (!out.some((o) => o.id === r.id)) out.push({ id: r.id, name: r.consultant_name, status: r.status, why: 'same e-mail' }); });
    }
  } catch (e) { if (!missingTable(e)) throw e; }
  return out;
}
async function directoryHas(orgId, name) {
  const [r] = await pool.query('SELECT id FROM consultants WHERE organization_id = ? AND LOWER(name) = LOWER(?) LIMIT 1', [orgId, name]);
  return !!r[0];
}
const cols = (data) => ({
  vendor_name: data.vendor_name || null, client_name: data.client_name || null, end_client_name: data.end_client_name || null, start_date: data.start_date || null,
});

router.get('/schema', (req, res) => {
  res.json({ sections: spec.SECTIONS, secretFields: spec.SECRET_FIELDS, encryptionConfigured: isConfigured(), isHr: isHr(req) });
});

router.post('/parse', async (req, res, next) => {
  try {
    const text = req.body && typeof req.body.text === 'string' ? req.body.text.slice(0, 30000) : '';
    if (!text.trim()) return res.status(400).json({ error: 'Paste the pre-placement information first.' });
    const r = spec.parseText(text);
    if (!r.matched.length) return res.status(422).json({ error: 'Could not find any pre-placement fields in that text. Paste the table as it appears in the e-mail, or type the details in.', unmatched: r.unmatched.slice(0, 10) });
    const similar = r.fields.consultant_name ? await similarOnes(req.user.organization_id, r.fields.consultant_name, r.fields.consultant_email, null) : [];
    res.json(Object.assign(r, { similar }));
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const where = ['organization_id = ?']; const params = [req.user.organization_id];
    if (!isHr(req)) { where.push('created_by_id = ?'); params.push(req.user.id); }
    const st = String(req.query.status || 'open');
    if (st === 'open') where.push(`status IN ('draft','interviewing','selected')`);
    else if (STATUSES.includes(st)) { where.push('status = ?'); params.push(st); }
    if (req.query.q) {
      const like = '%' + String(req.query.q).slice(0, 100).replace(/[\\%_]/g, '\\$&') + '%';
      where.push('(consultant_name LIKE ? OR vendor_name LIKE ? OR client_name LIKE ? OR end_client_name LIKE ?)'); params.push(like, like, like, like);
    }
    const [rows] = await pool.query(`SELECT id, status, consultant_name, vendor_name, client_name, end_client_name, start_date, onboarding_id, created_by, updated_at FROM pre_placements WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 500`, params);
    const [counts] = await pool.query(`SELECT status, COUNT(*) n FROM pre_placements WHERE organization_id = ?${isHr(req) ? '' : ' AND created_by_id = ?'} GROUP BY status`,
      isHr(req) ? [req.user.organization_id] : [req.user.organization_id, req.user.id]);
    res.json({
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      items: rows.map((r) => ({ id: r.id, status: r.status, consultantName: r.consultant_name, vendorName: r.vendor_name, clientName: r.client_name, endClientName: r.end_client_name,
        startDate: dateStr(r.start_date), onboardingId: r.onboarding_id || null, createdBy: r.created_by, updatedAt: r.updated_at })),
    });
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

// body: { data: { ...plain and sensitive fields } }
router.post('/', async (req, res, next) => {
  try {
    const { data, secrets, errors } = spec.clean((req.body || {}).data || {});
    if (errors.length) return res.status(400).json({ error: errors[0].message, errors });
    if (!data.consultant_name) return res.status(400).json({ error: 'The consultant’s first and last name is required.' });
    const plain = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== ''));
    const secretVals = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== ''));
    let sealed = null;
    if (Object.keys(secretVals).length) {
      if (!isConfigured()) return res.status(400).json({ error: NO_KEY_MSG });
      sealed = encrypt(JSON.stringify(secretVals));
    }
    const row = { log: '[]' };
    addLog(row, req, 'Created as a draft.');
    const c = cols(plain);
    const [r] = await pool.query(
      `INSERT INTO pre_placements (organization_id, status, consultant_name, vendor_name, client_name, end_client_name, start_date, data, secrets, log, created_by, created_by_id) VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.organization_id, plain.consultant_name, c.vendor_name, c.client_name, c.end_client_name, c.start_date, JSON.stringify(plain), sealed, row.log, who(req), req.user.id]);
    const [rows] = await pool.query('SELECT * FROM pre_placements WHERE id = ?', [r.insertId]);
    const similar = await similarOnes(req.user.organization_id, plain.consultant_name, plain.consultant_email, r.insertId);
    res.status(201).json(present(rows[0], req, { similar, inDirectory: await directoryHas(req.user.organization_id, plain.consultant_name) }));
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await load(req, res); if (!row) return;
    const data = parse(row.data, {});
    res.json(present(row, req, { similar: await similarOnes(req.user.organization_id, row.consultant_name, data.consultant_email, row.id), inDirectory: await directoryHas(req.user.organization_id, row.consultant_name) }));
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

// An empty value clears a field; a field that is not sent is left alone. Sensitive values can be replaced or cleared but never read back here.
router.put('/:id', async (req, res, next) => {
  try {
    const row = await load(req, res); if (!row) return;
    if (!OPEN.includes(row.status)) return res.status(409).json({ error: row.status === 'converted' ? 'This candidate has already been sent to onboarding, so it can no longer be edited here.' : 'This candidate was not selected. Reopen it first to edit.' });
    const { data, secrets, errors } = spec.clean((req.body || {}).data || {});
    if (errors.length) return res.status(400).json({ error: errors[0].message, errors });
    const merged = Object.assign({}, parse(row.data, {}));
    Object.entries(data).forEach(([k, v]) => { if (v === '') delete merged[k]; else merged[k] = v; });
    if (!merged.consultant_name) return res.status(400).json({ error: 'The consultant’s first and last name is required.' });
    let sealed = row.secrets;
    if (Object.keys(secrets).length) {
      if (!isConfigured()) return res.status(400).json({ error: NO_KEY_MSG });
      let cur = {};
      if (row.secrets) { try { cur = JSON.parse(decrypt(row.secrets)); } catch (e) { return res.status(409).json({ error: 'The saved sensitive details cannot be read with the current encryption key, so they cannot be changed. Check FIELD_ENCRYPTION_KEY.' }); } }
      Object.entries(secrets).forEach(([k, v]) => { if (v === '') delete cur[k]; else cur[k] = v; });
      sealed = Object.keys(cur).length ? encrypt(JSON.stringify(cur)) : null;
    }
    const changed = Object.keys(data).concat(Object.keys(secrets).map((k) => k + ' (encrypted)'));
    addLog(row, req, changed.length ? 'Updated: ' + changed.join(', ') + '.' : 'Saved with no changes.');
    const c = cols(merged);
    await pool.query(
      'UPDATE pre_placements SET consultant_name = ?, vendor_name = ?, client_name = ?, end_client_name = ?, start_date = ?, data = ?, secrets = ?, log = ? WHERE id = ? AND organization_id = ?',
      [merged.consultant_name, c.vendor_name, c.client_name, c.end_client_name, c.start_date, JSON.stringify(merged), sealed, row.log, row.id, row.organization_id]);
    const [rows] = await pool.query('SELECT * FROM pre_placements WHERE id = ?', [row.id]);
    res.json(present(rows[0], req));
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

// Moves a candidate through the interview stages: draft -> interviewing -> selected, or not_selected (any time before onboarding).
// Marking someone "not selected" erases their date of birth and SSN digits (nothing sensitive is kept for a person who is not hired).
router.post('/:id/status', async (req, res, next) => {
  try {
    const row = await load(req, res); if (!row) return;
    const to = String((req.body || {}).status || '');
    if (!['draft', 'interviewing', 'selected', 'not_selected'].includes(to)) return res.status(400).json({ error: 'Choose draft, interviewing, selected or not selected.' });
    if (row.status === 'converted') return res.status(409).json({ error: 'This candidate has already been sent to onboarding.' });
    if (row.status === to) return res.json(present(row, req));
    const reason = String((req.body || {}).reason || '').trim().slice(0, 255);
    const notes = { draft: 'Moved back to collecting details.', interviewing: 'Marked as interviewing.', selected: 'Candidate selected — ready to send to onboarding.',
      not_selected: 'Candidate not selected / placement not going ahead' + (reason ? ': ' + reason : '') + '.' };
    addLog(row, req, notes[to]);
    let secrets = row.secrets;
    if (to === 'not_selected' && row.secrets) { secrets = null; addLog(row, req, 'Date of birth and SSN digits were erased because the candidate was not selected.'); }
    await pool.query('UPDATE pre_placements SET status = ?, secrets = ?, log = ? WHERE id = ? AND organization_id = ?', [to, secrets, row.log, row.id, row.organization_id]);
    const [rows] = await pool.query('SELECT * FROM pre_placements WHERE id = ?', [row.id]);
    res.json(present(rows[0], req));
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const row = await load(req, res); if (!row) return;
    if (!isHr(req) && row.status !== 'draft') return res.status(403).json({ error: 'Only the account owner or an HR admin can delete a pre-placement that has left draft.' });
    await pool.query('DELETE FROM pre_placements WHERE id = ? AND organization_id = ?', [row.id, row.organization_id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Owner / HR only. A POST so the Activity log records every reveal.
router.post('/:id/reveal', async (req, res, next) => {
  try {
    if (!isHr(req)) return res.status(403).json({ error: 'Only the account owner or an HR admin can reveal a date of birth or SSN digits.' });
    const row = await load(req, res); if (!row) return;
    if (!row.secrets) return res.json({ dob: '', ssn_last5: '' });
    if (!isConfigured()) return res.status(503).json({ error: NO_KEY_MSG });
    let s;
    try { s = JSON.parse(decrypt(row.secrets)); } catch (e) { return res.status(409).json({ error: 'These details cannot be read with the current encryption key.' }); }
    res.locals.auditNote = 'Revealed date of birth / SSN digits of pre-placement #' + row.id;
    res.json({ dob: s.dob || '', ssn_last5: s.ssn_last5 || '' });
  } catch (err) { next(err); }
});

// Only for a SELECTED candidate (one who passed the interview). Creates a prefilled Onboarding draft (owned by whoever clicks) and links
// it. The date of birth and SSN are NOT copied: Onboarding collects its own sensitive paperwork.
router.post('/:id/send-to-onboarding', async (req, res, next) => {
  let conn;
  try {
    const row = await load(req, res); if (!row) return;
    if (row.status === 'converted') return res.status(409).json({ error: 'This candidate has already been sent to onboarding.' });
    if (row.status !== 'selected') return res.status(409).json({ error: 'Only a selected candidate can be sent to onboarding. Mark the candidate as Selected once they have passed the interview.' });
    const d = parse(row.data, {});
    const workerType = String((req.body || {}).workerType || d.engagement || '');
    if (!onboarding.helpers.TYPES.includes(workerType)) return res.status(400).json({ error: 'Choose how the person is engaged (W2, C2C or 1099) to send them to onboarding.' });
    const visa = String(d.visa_status || '');
    const auth = /citizen/i.test(visa) && /\b(us|u\.s\.?|american)\b/i.test(visa) ? 'US citizen' : /green\s*card|permanent/i.test(visa) ? 'Green card' : /h-?1b/i.test(visa) ? 'H-1B'
      : /\bl-?1\b/i.test(visa) ? 'L-1' : /opt|cpt/i.test(visa) ? 'OPT / CPT' : /\btn\b/i.test(visa) ? 'TN' : /\bead\b/i.test(visa) ? 'EAD' : visa ? 'Other' : '';
    const input = {
      consultant_name: d.consultant_name, phone: d.consultant_phone, email: d.consultant_email, technical_skill: d.technical_skill, work_authorization: auth,
      start_date: d.start_date, duration: d.project_duration, end_client: d.end_client_name || d.client_name, bill_to: d.client_name, location: d.work_location,
      bill_rate: d.bill_rate, bill_rate_basis: d.bill_basis, pay_rate: d.pay_rate, pay_rate_basis: d.pay_basis, recruiter: who(req),
    };
    if (workerType === 'C2C') {
      Object.assign(input, { employer_name: d.vendor_name, employer_contact: d.signer_name, employer_email: d.vendor_email || d.signer_email, employer_phone: d.vendor_phone || d.signer_phone, employer_address: d.vendor_address });
    }
    const { data: obData, errors } = onboarding.helpers.clean(input, {});
    const dropped = errors.map((e) => e.key);
    errors.forEach((e) => { delete obData[e.key]; });
    const notes = [];
    if (dropped.length) notes.push('Not carried over (did not fit the onboarding form): ' + dropped.join(', ') + '.');
    const cur = [d.pay_currency, d.bill_currency].filter((x) => x && x !== 'USD');
    if (cur.length) notes.push('Rates were in ' + Array.from(new Set(cur)).join('/') + ' — the onboarding form has no currency, so check the amounts.');
    const obLog = JSON.stringify([{ at: new Date().toISOString(), by: who(req), text: 'Created from pre-placement #' + row.id + ' (candidate selected).' + (notes.length ? ' ' + notes.join(' ') : '') }]);
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [lock] = await conn.query('SELECT status FROM pre_placements WHERE id = ? AND organization_id = ? FOR UPDATE', [row.id, row.organization_id]);
    if (!lock[0] || lock[0].status === 'converted') { await conn.rollback(); return res.status(409).json({ error: 'This candidate has already been sent to onboarding.' }); }
    const [ins] = await conn.query(
      `INSERT INTO onboardings (organization_id, worker_type, status, consultant_name, start_date, data, checklist, log, created_by, created_by_id) VALUES (?, ?, 'draft', ?, ?, ?, '{}', ?, ?, ?)`,
      [req.user.organization_id, workerType, obData.consultant_name, obData.start_date || null, JSON.stringify(obData), obLog, who(req), req.user.id]);
    addLog(row, req, 'Sent to onboarding (onboarding #' + ins.insertId + ').');
    await conn.query(`UPDATE pre_placements SET status = 'converted', onboarding_id = ?, log = ? WHERE id = ? AND organization_id = ? AND status <> 'converted'`, [ins.insertId, row.log, row.id, row.organization_id]);
    await conn.commit();
    res.status(201).json({ onboardingId: ins.insertId, notes });
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch (e) { /* ignore */ } }
    if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG });
    next(err);
  } finally { if (conn) conn.release(); }
});

module.exports = router;
