// Pre-placement information (the "Pre-Placement Document"): collected by a recruiter before a placement goes to
// onboarding. Everyone with a login that reaches this module (recruiters, HR admins, the owner) can SEE every candidate, so
// recruiters can see who is already in the pipeline. Only the recruiter who added a candidate, an HR admin or the owner can CHANGE one.
//   * Date of birth and the SSN digits are encrypted, never listed, and only the owner / HR can reveal them
//     (every reveal is written to the Activity log).
//   * A pre-placement exists while the candidate is still being interviewed: draft -> interviewing -> selected. Only a
//     SELECTED candidate can be sent to onboarding. If the candidate is not selected, the sensitive details are erased.
//   * Nothing here touches invoices or supplier payments. "Add vendor to Directory" (and sending a selected candidate to
//     onboarding) creates / completes the vendor's supplier company in the Directory, filling only blanks. "Send to
//     onboarding" otherwise only creates a draft in the existing Onboarding module.
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const spec = require('./prePlacementSpec');
const onboarding = require('./onboarding');
const { isConfigured, encrypt, decrypt, encryptBuffer, decryptBuffer } = require('../crypto');
const profiles = require('./profiles');
const { flagLikelyDuplicates } = require('./directoryDedup');
const { SPEC: PROFILE_SPEC } = require('./profileFields');

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
const mine = (req, row) => isHr(req) || row.created_by_id === req.user.id;
// write: true = the caller wants to change it (only the recruiter who added it, HR or the owner may).
async function load(req, res, opts) {
  if (!/^\d+$/.test(req.params.id)) { res.status(404).json({ error: 'Not found.' }); return null; }
  const [rows] = await pool.query('SELECT * FROM pre_placements WHERE id = ? AND organization_id = ?', [req.params.id, req.user.organization_id]);
  if (!rows[0]) { res.status(404).json({ error: 'Pre-placement not found.' }); return null; }
  if (opts && opts.write && !mine(req, rows[0])) { res.status(403).json({ error: 'Only the recruiter who added this candidate, an HR admin or the owner can change it.' }); return null; }
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
    onboardingId: row.onboarding_id || null, supplierId: row.supplier_id || null,
    resume: row.resume_name ? { name: row.resume_name, size: row.resume_size, at: row.resume_at, by: row.resume_by } : null, log: parse(row.log, []), createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    canReveal: isHr(req) && isConfigured(), canEdit: OPEN.includes(row.status) && mine(req, row), isMine: row.created_by_id === req.user.id,
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
  res.json({ sections: spec.SECTIONS, secretFields: spec.SECRET_FIELDS, encryptionConfigured: isConfigured(), isHr: isHr(req), resumeRequired: resumeRequired(), resumeTypes: Object.keys(RESUME_TYPES) });
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
    if (req.query.mine === '1') { where.push('created_by_id = ?'); params.push(req.user.id); }
    const st = String(req.query.status || 'open');
    if (st === 'open') where.push(`status IN ('draft','interviewing','selected')`);
    else if (STATUSES.includes(st)) { where.push('status = ?'); params.push(st); }
    if (req.query.q) {
      const like = '%' + String(req.query.q).slice(0, 100).replace(/[\\%_]/g, '\\$&') + '%';
      where.push('(consultant_name LIKE ? OR vendor_name LIKE ? OR client_name LIKE ? OR end_client_name LIKE ?)'); params.push(like, like, like, like);
    }
    const [rows] = await pool.query(`SELECT id, status, consultant_name, vendor_name, client_name, end_client_name, start_date, onboarding_id, created_by, updated_at FROM pre_placements WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 500`, params);
    const [counts] = await pool.query(`SELECT status, COUNT(*) n FROM pre_placements WHERE organization_id = ?${req.query.mine === '1' ? ' AND created_by_id = ?' : ''} GROUP BY status`,
      req.query.mine === '1' ? [req.user.organization_id, req.user.id] : [req.user.organization_id]);
    let vendorsMissing = 0;
    if (isHr(req)) {
      try {
        const [m] = await pool.query(`SELECT COUNT(*) n FROM pre_placements WHERE organization_id = ? AND status <> 'not_selected' AND vendor_name IS NOT NULL AND vendor_name <> '' AND supplier_id IS NULL`, [req.user.organization_id]);
        vendorsMissing = Number(m[0].n);
      } catch (e) { if (!(e && (e.code === 'ER_BAD_FIELD_ERROR' || missingTable(e)))) throw e; }
    }
    res.json({
      vendorsMissing,
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      items: rows.map((r) => ({ id: r.id, status: r.status, consultantName: r.consultant_name, vendorName: r.vendor_name, clientName: r.client_name, endClientName: r.end_client_name,
        startDate: dateStr(r.start_date), onboardingId: r.onboarding_id || null, createdBy: r.created_by, isMine: r.created_by_id === req.user.id, updatedAt: r.updated_at })),
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
    const row = await load(req, res, { write: true }); if (!row) return;
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
    const row = await load(req, res, { write: true }); if (!row) return;
    const to = String((req.body || {}).status || '');
    if (!['draft', 'interviewing', 'selected', 'not_selected'].includes(to)) return res.status(400).json({ error: 'Choose draft, interviewing, selected or not selected.' });
    if (row.status === 'converted') return res.status(409).json({ error: 'This candidate has already been sent to onboarding.' });
    if (row.status === to) return res.json(present(row, req));
    if (resumeRequired() && (to === 'interviewing' || to === 'selected') && !row.resume_name) return res.status(409).json({ error: 'Add the candidate’s resume before moving them to interviewing.' });
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
    const row = await load(req, res, { write: true }); if (!row) return;
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

// ------------------------------------------------------------ vendor -> Directory supplier company
// Creates the supplier company (or completes an existing one with the same name) from the vendor / signing-authority fields.
// Only BLANK fields are filled, so nothing already in the Directory is overwritten. The tax ID is encrypted like every other
// Directory secret and is only copied by the owner / HR.
const PROFILE_MAP = { incorporated_state: 'incorporated_state', vendor_fax: 'fax', signer_name: 'signer_name', signer_designation: 'signer_designation', signer_phone: 'signer_phone', signer_email: 'signer_email' };
const supplierField = (key) => PROFILE_SPEC.subvendors.sections.flatMap((s) => s.fields).find((x) => x.key === key);
async function addVendorToDirectory(req, row) {
  const d = parse(row.data, {});
  const name = String(d.vendor_name || '').replace(/\s+/g, ' ').trim().slice(0, 255);
  if (!name) return { status: 422, error: 'There is no vendor name on this pre-placement.' };
  const orgId = row.organization_id;
  const skipped = []; const filled = [];
  const conn = await pool.getConnection();
  let created = false; let id;
  try {
    await conn.beginTransaction();
    const [ex] = await conn.query('SELECT id, email, phone, address FROM subvendors WHERE organization_id = ? AND LOWER(name) = LOWER(?) FOR UPDATE', [orgId, name]);
    const core = {};
    const email = String(d.vendor_email || '').trim(); const phone = String(d.vendor_phone || '').trim(); const address = String(d.vendor_address || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (email) { const c = profiles.helpers.cleanValue(supplierField('email'), email); if (c.error) skipped.push('e-mail'); else core.email = c.value; }
    if (phone) { const c = profiles.helpers.cleanValue(supplierField('phone'), phone); if (c.error) skipped.push('phone'); else core.phone = c.value; }
    if (address) core.address = address;
    if (ex[0]) {
      id = ex[0].id;
      for (const [k, v] of Object.entries(core)) {
        if (!ex[0][k]) { await conn.query(`UPDATE subvendors SET ${k} = ? WHERE id = ? AND organization_id = ?`, [v, id, orgId]); filled.push(k); }
      }
    } else {
      const [r] = await conn.query(`INSERT INTO subvendors (organization_id, name, status, email, phone, address) VALUES (?, ?, 'active', ?, ?, ?)`, [orgId, name, core.email || null, core.phone || null, core.address || null]);
      id = r.insertId; created = true; filled.push(...Object.keys(core));
    }
    // profile (extra) fields, blanks only
    const [cur] = await conn.query(`SELECT data FROM record_profiles WHERE organization_id = ? AND entity = 'subvendors' AND record_id = ? FOR UPDATE`, [orgId, id]);
    const prof = cur[0] ? parse(cur[0].data, {}) : {};
    const want = Object.assign({ contact_name: d.signer_name, contact_title: d.signer_designation }, Object.fromEntries(Object.entries(PROFILE_MAP).map(([from, to]) => [to, d[from]])));
    let pchanged = false;
    for (const [key, raw] of Object.entries(want)) {
      const v = String(raw || '').trim(); if (!v || prof[key]) continue;
      const def = supplierField(key); if (!def) continue;
      const c = profiles.helpers.cleanValue(def, v);
      if (c.error || !c.value) { skipped.push(def.label.toLowerCase()); continue; }
      prof[key] = c.value; pchanged = true; filled.push(def.label.toLowerCase());
    }
    if (pchanged) await conn.query(`INSERT INTO record_profiles (organization_id, entity, record_id, data) VALUES (?, 'subvendors', ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`, [orgId, id, JSON.stringify(prof)]);
    // tax ID (encrypted)
    const tax = String(d.fed_tax_id || '').trim();
    if (tax) {
      const [has] = await conn.query(`SELECT 1 FROM record_secrets WHERE organization_id = ? AND entity = 'subvendors' AND record_id = ? AND field = 'tax_id'`, [orgId, id]);
      if (!has[0]) {
        const clean = profiles.helpers.secretClean('taxid', tax);
        if (!isHr(req)) skipped.push('tax ID (only HR or the owner can copy it — they can add it with “Add vendor to Directory”)');
        else if (!isConfigured()) skipped.push('tax ID (the server has no encryption key)');
        else if (!clean) skipped.push('tax ID (not a valid format)');
        else { await conn.query(`INSERT INTO record_secrets (organization_id, entity, record_id, field, cipher, last4) VALUES (?, 'subvendors', ?, 'tax_id', ?, ?) ON DUPLICATE KEY UPDATE cipher = VALUES(cipher), last4 = VALUES(last4)`, [orgId, id, encrypt(clean), clean.slice(-4)]); filled.push('tax ID (encrypted)'); }
      }
    }
    const uniq = Array.from(new Set(filled));
    const text = (created ? 'Created from pre-placement #' + row.id + ' (' + (row.consultant_name || 'candidate') + ').' : 'Completed from pre-placement #' + row.id + ' (blank fields only).') + (uniq.length ? ' Filled: ' + uniq.join(', ') + '.' : '');
    try { await conn.query(`INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, 'subvendors', ?, 'log', ?, ?)`, [orgId, id, text, who(req)]); } catch (e) { if (!missingTable(e)) throw e; }
    addLog(row, req, 'Vendor “' + name + '” ' + (created ? 'added to the Directory' : 'matched to the existing supplier company') + (uniq.length ? ' (' + uniq.join(', ') + ')' : '') + '.');
    await conn.query('UPDATE pre_placements SET supplier_id = ?, log = ? WHERE id = ? AND organization_id = ?', [id, row.log, row.id, orgId]);
    await conn.commit();
    row.supplier_id = id;
    if (created) flagLikelyDuplicates(pool, { organizationId: orgId, tableName: 'subvendors', newId: id, newName: name }).catch(() => {});
    return { status: created ? 201 : 200, supplierId: id, name, created, filled: uniq, skipped };
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* ignore */ }
    if (err && err.code === 'ER_DUP_ENTRY') return { status: 409, error: 'A supplier company with that name was just added. Try again.' };
    throw err;
  } finally { conn.release(); }
}

// ------------------------------------------------------------------ resume (optional; several versions per candidate)
// A candidate may send a different resume later, so every upload is kept as a new VERSION (v1, v2 ...); the newest is the
// current one, older versions stay viewable until someone removes them. PDF / Word (.doc, .docx) / RTF up to 10 MB each, stored
// encrypted. Anyone who can see the candidate can open the resumes; only the people who can change the candidate can add or remove
// them. When the candidate is sent to onboarding the CURRENT resume is copied across. A resume becomes mandatory (before a
// candidate can move to "interviewing") by setting PREPLACEMENT_RESUME_REQUIRED=1.
const RESUME_MAX = 10 * 1024 * 1024;
const RESUME_VERSIONS_MAX = 20;
const RESUME_TYPES = {
  pdf: { mime: 'application/pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  doc: { mime: 'application/msword', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  rtf: { mime: 'application/rtf', magic: (b) => b.subarray(0, 5).toString('latin1') === '{\\rtf' },
};
const resumeRequired = () => /^(1|true|yes)$/i.test(String(process.env.PREPLACEMENT_RESUME_REQUIRED || ''));
const sha = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');
const noResumeErr = (res) => res.status(404).json({ error: 'There is no such resume on this pre-placement.' });

// Point the summary columns on the pre-placement at the newest remaining version (or clear them).
async function syncResumeSummary(conn, orgId, id) {
  const [l] = await conn.query('SELECT filename, size, uploaded_at, uploaded_by FROM pre_placement_resume_files WHERE pre_placement_id = ? AND organization_id = ? ORDER BY version DESC LIMIT 1', [id, orgId]);
  if (l[0]) await conn.query('UPDATE pre_placements SET resume_name = ?, resume_size = ?, resume_at = ?, resume_by = ? WHERE id = ? AND organization_id = ?', [l[0].filename, l[0].size, l[0].uploaded_at, l[0].uploaded_by, id, orgId]);
  else await conn.query('UPDATE pre_placements SET resume_name = NULL, resume_size = NULL, resume_at = NULL, resume_by = NULL WHERE id = ? AND organization_id = ?', [id, orgId]);
}

// Every version, newest first (no file contents).
router.get('/:id/resumes', async (req, res, next) => {
  try {
    const row = await load(req, res); if (!row) return;
    const [v] = await pool.query('SELECT id, version, filename, size, uploaded_by, uploaded_at FROM pre_placement_resume_files WHERE pre_placement_id = ? AND organization_id = ? ORDER BY version DESC', [row.id, row.organization_id]);
    res.json({ versions: v.map((x, i) => ({ id: x.id, version: x.version, name: x.filename, size: x.size, by: x.uploaded_by, at: x.uploaded_at, current: i === 0 })), maxVersions: RESUME_VERSIONS_MAX });
  } catch (err) { if (missingTable(err)) return res.json({ versions: [], maxVersions: RESUME_VERSIONS_MAX }); next(err); }
});

// Add a new version.
router.post('/:id/resume', async (req, res, next) => {
  let conn;
  try {
    const row = await load(req, res, { write: true }); if (!row) return;
    if (!OPEN.includes(row.status)) return res.status(409).json({ error: row.status === 'converted' ? 'This candidate has already been sent to onboarding. Add the new resume on the onboarding instead.' : 'Reopen this candidate before changing the resume.' });
    const b = req.body || {};
    const filename = String(b.filename || '').replace(/[\\/\r\n"]/g, '_').trim().slice(0, 200);
    const ext = (/\.([a-z0-9]+)$/i.exec(filename) || [])[1];
    const t = ext && RESUME_TYPES[ext.toLowerCase()];
    if (!t) return res.status(415).json({ error: 'Upload the resume as a PDF or Word (.doc, .docx) file.' });
    if (typeof b.contentBase64 !== 'string' || !b.contentBase64) return res.status(400).json({ error: 'Choose a file to upload.' });
    if (b.contentBase64.length > Math.ceil(RESUME_MAX / 3) * 4 + 8) return res.status(413).json({ error: 'That file is larger than 10 MB.' });
    const buf = Buffer.from(b.contentBase64, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'That file is empty.' });
    if (buf.length > RESUME_MAX) return res.status(413).json({ error: 'That file is larger than 10 MB.' });
    if (!t.magic(buf)) return res.status(415).json({ error: 'That file does not look like a real .' + ext.toLowerCase() + ' file.' });
    if (!isConfigured()) return res.status(503).json({ error: 'The resume cannot be stored yet: the server has no encryption key (FIELD_ENCRYPTION_KEY). Nothing was saved.' });
    const digest = sha(buf);
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [pl] = await conn.query('SELECT id FROM pre_placements WHERE id = ? AND organization_id = ? FOR UPDATE', [row.id, row.organization_id]); // serialises version numbers
    if (!pl[0]) { await conn.rollback(); return res.status(404).json({ error: 'Pre-placement not found.' }); }
    const [cur] = await conn.query('SELECT version, sha256, filename FROM pre_placement_resume_files WHERE pre_placement_id = ? AND organization_id = ? ORDER BY version DESC', [row.id, row.organization_id]);
    if (cur[0] && cur[0].sha256 === digest) { await conn.rollback(); return res.status(409).json({ error: 'That is the same file as the current resume (version ' + cur[0].version + ', ' + cur[0].filename + ').' }); }
    if (cur.length >= RESUME_VERSIONS_MAX) { await conn.rollback(); return res.status(409).json({ error: 'There are already ' + RESUME_VERSIONS_MAX + ' versions of this resume. Remove an old one first.' }); }
    const version = (cur[0] ? cur[0].version : 0) + 1;
    await conn.query('INSERT INTO pre_placement_resume_files (organization_id, pre_placement_id, version, filename, mime, size, sha256, content, uploaded_by, uploaded_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.organization_id, row.id, version, filename, t.mime, buf.length, digest, encryptBuffer(buf), who(req), req.user.id]);
    addLog(row, req, 'Resume ' + (version === 1 ? 'added' : 'version ' + version + ' added (now the current one)') + ' (' + filename + ', ' + Math.max(1, Math.round(buf.length / 1024)) + ' KB).');
    await conn.query('UPDATE pre_placements SET log = ? WHERE id = ? AND organization_id = ?', [row.log, row.id, row.organization_id]);
    await syncResumeSummary(conn, row.organization_id, row.id);
    await conn.commit();
    const [rows] = await pool.query('SELECT * FROM pre_placements WHERE id = ?', [row.id]);
    res.status(201).json(present(rows[0], req, { resumeVersion: version }));
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch (e) { /* ignore */ } }
    if (missingTable(err) || (err && err.code === 'ER_BAD_FIELD_ERROR')) return res.status(503).json({ error: SCHEMA_MSG });
    if (err && (err.code === 'ER_NET_PACKET_TOO_LARGE' || err.code === 'EPIPE')) return res.status(413).json({ error: 'The database refused a file that large. Try a smaller file.' });
    next(err);
  } finally { if (conn) conn.release(); }
});

// View / download: the current version, or one chosen by its id.
async function sendResume(req, res, next, versionId) {
  try {
    const row = await load(req, res); if (!row) return;
    const [d] = versionId
      ? await pool.query('SELECT filename, mime, content FROM pre_placement_resume_files WHERE id = ? AND pre_placement_id = ? AND organization_id = ?', [versionId, row.id, row.organization_id])
      : await pool.query('SELECT filename, mime, content FROM pre_placement_resume_files WHERE pre_placement_id = ? AND organization_id = ? ORDER BY version DESC LIMIT 1', [row.id, row.organization_id]);
    if (!d[0]) return noResumeErr(res);
    let buf;
    try { buf = decryptBuffer(d[0].content); } catch (e) { return res.status(503).json({ error: 'The resume cannot be decrypted with the server’s current encryption key.' }); }
    const mode = req.query.download || d[0].mime !== 'application/pdf' ? 'attachment' : 'inline';
    res.set({
      'Content-Type': d[0].mime, 'Content-Length': buf.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': mode + '; filename="' + d[0].filename.replace(/[^\x20-\x7e]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(d[0].filename),
    });
    res.end(buf);
  } catch (err) { if (missingTable(err) || (err && err.code === 'ER_BAD_FIELD_ERROR')) return noResumeErr(res); next(err); }
}
router.get('/:id/resume', (req, res, next) => sendResume(req, res, next, null));
router.get('/:id/resume/:vid', (req, res, next) => { if (!/^\d+$/.test(req.params.vid)) return noResumeErr(res); return sendResume(req, res, next, Number(req.params.vid)); });

// Remove one version.
router.delete('/:id/resume/:vid', async (req, res, next) => {
  let conn;
  try {
    const row = await load(req, res, { write: true }); if (!row) return;
    if (!OPEN.includes(row.status)) return res.status(409).json({ error: 'Reopen this candidate before changing the resume.' });
    if (!/^\d+$/.test(req.params.vid)) return noResumeErr(res);
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query('SELECT id FROM pre_placements WHERE id = ? AND organization_id = ? FOR UPDATE', [row.id, row.organization_id]);
    const [all] = await conn.query('SELECT id, version, filename FROM pre_placement_resume_files WHERE pre_placement_id = ? AND organization_id = ?', [row.id, row.organization_id]);
    const v = all.find((x) => x.id === Number(req.params.vid));
    if (!v) { await conn.rollback(); return noResumeErr(res); }
    if (resumeRequired() && row.status !== 'draft' && all.length === 1) { await conn.rollback(); return res.status(409).json({ error: 'A resume is required once a candidate is being interviewed. Add the new version first, then remove this one.' }); }
    await conn.query('DELETE FROM pre_placement_resume_files WHERE id = ?', [v.id]);
    addLog(row, req, 'Resume version ' + v.version + ' removed (' + v.filename + ').');
    await conn.query('UPDATE pre_placements SET log = ? WHERE id = ? AND organization_id = ?', [row.log, row.id, row.organization_id]);
    await syncResumeSummary(conn, row.organization_id, row.id);
    await conn.commit();
    const [rows] = await pool.query('SELECT * FROM pre_placements WHERE id = ?', [row.id]);
    res.json(present(rows[0], req));
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch (e) { /* ignore */ } }
    if (missingTable(err) || (err && err.code === 'ER_BAD_FIELD_ERROR')) return res.status(503).json({ error: SCHEMA_MSG });
    next(err);
  } finally { if (conn) conn.release(); }
});

// One-off catch-up for pre-placements saved before vendors were added to the Directory automatically (owner / HR only).
// Skips candidates who were not selected. Several candidates with the same vendor share one supplier company.
router.post('/sync-vendors', async (req, res, next) => {
  try {
    if (!isHr(req)) return res.status(403).json({ error: 'Only the account owner or an HR admin can add all the missing vendors at once.' });
    const [rows] = await pool.query(`SELECT * FROM pre_placements WHERE organization_id = ? AND status <> 'not_selected' AND vendor_name IS NOT NULL AND vendor_name <> '' AND supplier_id IS NULL ORDER BY id`, [req.user.organization_id]);
    const out = { created: [], matched: [], failed: [], skipped: [] };
    for (const row of rows) {
      try {
        const r = await addVendorToDirectory(req, row);
        if (r.error) { out.failed.push({ id: row.id, vendor: row.vendor_name, error: r.error }); continue; }
        (r.created ? out.created : out.matched).push(r.name);
        r.skipped.forEach((x) => out.skipped.push(r.name + ': ' + x));
      } catch (e) { out.failed.push({ id: row.id, vendor: row.vendor_name, error: 'Could not be added.' }); }
    }
    out.created = Array.from(new Set(out.created)); out.matched = Array.from(new Set(out.matched.filter((n) => !out.created.includes(n))));
    res.json(out);
  } catch (err) {
    if (missingTable(err) || (err && err.code === 'ER_BAD_FIELD_ERROR')) return res.status(503).json({ error: SCHEMA_MSG });
    next(err);
  }
});

router.post('/:id/add-vendor', async (req, res, next) => {
  try {
    const row = await load(req, res, { write: true }); if (!row) return;
    if (row.status === 'not_selected') return res.status(409).json({ error: 'This candidate was not selected. Reopen it first if you still want the vendor in the Directory.' });
    const r = await addVendorToDirectory(req, row);
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.status(r.status).json(Object.assign({ pre: present(row, req) }, r));
  } catch (err) {
    if (missingTable(err) || (err && err.code === 'ER_BAD_FIELD_ERROR')) return res.status(503).json({ error: SCHEMA_MSG });
    next(err);
  }
});

// Only for a SELECTED candidate (one who passed the interview). Creates a prefilled Onboarding draft (owned by whoever clicks) and links
// it. The date of birth and SSN are NOT copied: Onboarding collects its own sensitive paperwork.
router.post('/:id/send-to-onboarding', async (req, res, next) => {
  let conn;
  try {
    const row = await load(req, res, { write: true }); if (!row) return;
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
    // the current resume goes across as the onboarding's Resume document (same encryption key, so the sealed bytes are copied as they are)
    const [cr] = await conn.query('SELECT id, filename, version FROM pre_placement_resume_files WHERE pre_placement_id = ? AND organization_id = ? ORDER BY version DESC LIMIT 1', [row.id, row.organization_id]);
    if (cr[0]) {
      await conn.query(`INSERT INTO onboarding_documents (organization_id, onboarding_id, item_key, filename, mime, size, content, uploaded_by, uploaded_by_id)
        SELECT organization_id, ?, 'resume', filename, mime, size, content, ?, ? FROM pre_placement_resume_files WHERE id = ?`, [ins.insertId, who(req), req.user.id, cr[0].id]);
      await conn.query('UPDATE onboardings SET log = ? WHERE id = ?', [JSON.stringify(parse(obLog, []).concat([{ at: new Date().toISOString(), by: who(req), text: 'Resume copied from the pre-placement (' + cr[0].filename + (cr[0].version > 1 ? ', version ' + cr[0].version : '') + ').' }])), ins.insertId]);
      notes.push('Resume “' + cr[0].filename + '” copied to the onboarding.');
    }
    addLog(row, req, 'Sent to onboarding (onboarding #' + ins.insertId + ').');
    await conn.query(`UPDATE pre_placements SET status = 'converted', onboarding_id = ?, log = ? WHERE id = ? AND organization_id = ? AND status <> 'converted'`, [ins.insertId, row.log, row.id, row.organization_id]);
    await conn.commit();
    // The vendor becomes a supplier company in the Directory (blank fields only). A problem here never undoes the hand-off.
    if (String(d.vendor_name || '').trim()) {
      try {
        const fresh = Object.assign({}, row, { log: (await pool.query('SELECT log FROM pre_placements WHERE id = ?', [row.id]))[0][0].log });
        const v = await addVendorToDirectory(req, fresh);
        if (v.error) notes.push('Vendor was not added to the Directory: ' + v.error);
        else {
          notes.push('Vendor “' + v.name + '” ' + (v.created ? 'added to the Directory.' : 'was already in the Directory and was completed.'));
          if (v.skipped.length) notes.push('Not copied to the Directory: ' + v.skipped.join('; ') + '.');
          if (workerType === 'C2C') await pool.query('UPDATE onboardings SET supplier_id = ? WHERE id = ? AND organization_id = ? AND supplier_id IS NULL', [v.supplierId, ins.insertId, row.organization_id]).catch(() => {});
        }
      } catch (e) { notes.push('Vendor could not be added to the Directory automatically; use “Add vendor to Directory” on the pre-placement.'); }
    }
    res.status(201).json({ onboardingId: ins.insertId, notes });
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch (e) { /* ignore */ } }
    if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG });
    next(err);
  } finally { if (conn) conn.release(); }
});

module.exports = router;
