// Fillable W-9 / W-4 / I-9 forms attached to a directory record, with typed
// electronic signatures. Scoped to req.user.organization_id. Identifying
// numbers are encrypted and write-only (last 4 shown), exactly like profiles.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { encrypt, isConfigured } = require('../crypto');
const profiles = require('./profiles');
const { FORMS, fieldsOfForm } = require('./formSpecs');

const { cleanValue, secretClean, maskFor } = profiles.helpers;
const router = express.Router();
// The supplier portal (vendorPortal.js) sets req.vendorLink after checking a secure link; everyone else signs in.
router.use((req, res, next) => (req.vendorLink ? next() : requireAuth(req, res, next)));

const SCHEMA_MSG = 'Forms need the latest database update. Run db/schema.sql on the database, then try again.';
const ENTITIES = ['consultants', 'clients', 'programs', 'subvendors'];
// A signature can only be applied after the one it depends on.
const SIGN_AFTER = { employer: 'employee', reverify: 'employer' };
const OPTIONAL_SIG = { i9: ['reverify'] };

// Who may type identifying numbers (SSN, tax ID, document and bank numbers): the owner and HR admins
// (and the supplier through their secure link). Nobody can read them back.
const isHrAdmin = (req) => req.user.role === 'owner' || req.user.role === 'hr';
const canEditSecrets = (req) => !!req.vendorLink || isHrAdmin(req);
// The employer's parts of a form (I-9 Sections 2 and 3, W-4 employer sign-off) are never open to a secure link.
const EMPLOYER_SIGNS = new Set(['employer', 'reverify']);
const employerFieldKeys = (form) => new Set(FORMS[form].sections.filter((sec) => EMPLOYER_SIGNS.has(sec.signKey)).flatMap((sec) => sec.fields.map((f) => f.key)));
const missingTable = (e) => e && e.code === 'ER_NO_SUCH_TABLE';

async function loadRecord(entity, id, orgId) {
  const [rows] = await pool.query(`SELECT * FROM ${entity} WHERE id = ? AND organization_id = ?`, [id, orgId]);
  return rows[0] || null;
}

async function loadForm(orgId, entity, id, form) {
  const [rows] = await pool.query(
    `SELECT data, signatures, updated_at FROM record_forms WHERE organization_id = ? AND entity = ? AND record_id = ? AND form_type = ?`,
    [orgId, entity, id, form]);
  const parse = (t) => { try { return (t && JSON.parse(t)) || {}; } catch (e) { return {}; } };
  if (!rows[0]) return { exists: false, values: {}, signatures: {} };
  return { exists: true, values: parse(rows[0].data), signatures: parse(rows[0].signatures), updatedAt: rows[0].updated_at };
}

async function saveForm(orgId, entity, id, form, values, signatures) {
  await pool.query(
    `INSERT INTO record_forms (organization_id, entity, record_id, form_type, data, signatures) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE data = VALUES(data), signatures = VALUES(signatures)`,
    [orgId, entity, id, form, JSON.stringify(values), JSON.stringify(signatures)]);
}

async function secretState(orgId, entity, id, form) {
  const defs = fieldsOfForm(form).filter((x) => x.kind === 'secret');
  const [rows] = await pool.query(
    `SELECT field, last4, updated_at FROM record_secrets WHERE organization_id = ? AND entity = ? AND record_id = ? AND field LIKE ?`,
    [orgId, entity, id, form + '.%']);
  const out = {};
  defs.forEach((d) => { out[d.key] = { set: false }; });
  rows.forEach((r) => {
    const key = r.field.slice(form.length + 1);
    const d = defs.find((x) => x.key === key);
    if (d) out[key] = { set: true, last4: r.last4, masked: maskFor(d.secretKind, r.last4), updatedAt: r.updated_at };
  });
  return out;
}

async function log(orgId, entity, id, req, text) {
  try {
    await pool.query(`INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, ?, ?, 'log', ?, ?)`,
      [orgId, entity, id, text, req.user.name || req.user.email]);
  } catch (e) { /* best effort */ }
}

function lockedKeys(form, signatures) {
  const locked = new Set();
  FORMS[form].sections.forEach((s) => { if (s.signKey && signatures[s.signKey]) s.fields.forEach((x) => locked.add(x.key)); });
  return locked;
}

// Values the form can start with from what the directory already knows.
async function prefill(entity, rec, orgId, form) {
  const [pr] = await pool.query(`SELECT data FROM record_profiles WHERE organization_id = ? AND entity = ? AND record_id = ?`, [orgId, entity, rec.id]);
  let p = {}; try { p = (pr[0] && pr[0].data && JSON.parse(pr[0].data)) || {}; } catch (e) { p = {}; }
  const out = {};
  const base = { address: rec.address || '', city: p.city || '', state: p.state || '', zip: p.postal_code || '' };
  if (form === 'banking') {
    Object.assign(out, { bank_name: '', ach_holder: p.legal_name || rec.name, wire_beneficiary: p.legal_name || rec.name, remit_email: rec.email || '' });
  } else if (form === 'w9') {
    Object.assign(out, base, { name: p.legal_name || rec.name });
  } else {
    const parts = String(rec.name || '').replace(/-\d+$/, '').trim().split(/\s+/);
    const last = parts.length > 1 ? parts.pop() : '';
    Object.assign(out, base, { first_name: parts.join(' '), last_name: last });
    if (form === 'i9') {
      out.dob = p.date_of_birth || ''; out.email = p.personal_email || rec.email || ''; out.phone = rec.phone || '';
      if (p.work_authorization === 'US citizen') out.citizenship = 'A citizen of the United States';
      else if (p.work_authorization === 'Green card') out.citizenship = 'A lawful permanent resident';
      else if (p.work_authorization) out.citizenship = 'A noncitizen authorized to work';
      if (p.work_auth_expiry && out.citizenship === 'A noncitizen authorized to work') out.work_until = p.work_auth_expiry;
      if (p.hire_date) out.first_day = p.hire_date;
    }
    if (form === 'w4' && p.hire_date) out.first_date_employment = p.hire_date;
  }
  Object.keys(out).forEach((k) => { if (!out[k]) delete out[k]; });
  return out;
}

function statusOf(form, exists, signatures) {
  const need = Object.keys(FORMS[form].signatures).filter((k) => !(OPTIONAL_SIG[form] || []).includes(k));
  const done = need.filter((k) => signatures[k]).length;
  if (done === need.length) return 'complete';
  if (done > 0) return 'partly signed';
  return exists ? 'draft' : 'not started';
}

function checkParams(req, res) {
  const { entity, id } = req.params;
  const form = req.params.form;
  if (!ENTITIES.includes(entity) || !/^\d+$/.test(id)) { res.status(404).json({ error: 'Not found.' }); return null; }
  if (form !== undefined && !(FORMS[form] && FORMS[form].entities.includes(entity))) { res.status(404).json({ error: 'That form does not apply to this record.' }); return null; }
  return { entity, id: Number(id), form, orgId: req.user.organization_id };
}

router.get('/schema', (req, res) => {
  res.json({ forms: FORMS, encryptionConfigured: isConfigured(), canEditSecrets: isHrAdmin(req), canEditSecretsFor: Object.fromEntries(Object.keys(FORMS).map((k) => [k, canEditSecrets(req, k)])) });
});

router.get('/bank-lookup/:rn', (req, res) => res.json(require('./abaLookup').lookup(req.params.rn)));

router.get('/:entity/:id', async (req, res, next) => {
  try {
    const P = checkParams(req, res); if (!P) return;
    if (!(await loadRecord(P.entity, P.id, P.orgId))) return res.status(404).json({ error: 'Record not found.' });
    const out = [];
    for (const key of Object.keys(FORMS).filter((k) => FORMS[k].entities.includes(P.entity))) {
      const fm = await loadForm(P.orgId, P.entity, P.id, key);
      out.push({ form: key, title: FORMS[key].title, subtitle: FORMS[key].subtitle, status: statusOf(key, fm.exists, fm.signatures), signatures: fm.signatures });
    }
    res.json({ forms: out });
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.get('/:entity/:id/:form', async (req, res, next) => {
  try {
    const P = checkParams(req, res); if (!P) return;
    const rec = await loadRecord(P.entity, P.id, P.orgId);
    if (!rec) return res.status(404).json({ error: 'Record not found.' });
    const fm = await loadForm(P.orgId, P.entity, P.id, P.form);
    const pre = await prefill(P.entity, rec, P.orgId, P.form);
    const values = Object.assign({}, pre, fm.values);
    const prefilled = Object.keys(pre).filter((k) => !(k in fm.values));
    res.json({
      form: P.form, spec: FORMS[P.form], recordName: rec.name, values, prefilled,
      secrets: await secretState(P.orgId, P.entity, P.id, P.form),
      signatures: fm.signatures, locked: Array.from(lockedKeys(P.form, fm.signatures)),
      status: statusOf(P.form, fm.exists, fm.signatures),
    });
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.put('/:entity/:id/:form', async (req, res, next) => {
  try {
    const P = checkParams(req, res); if (!P) return;
    const rec = await loadRecord(P.entity, P.id, P.orgId);
    if (!rec) return res.status(404).json({ error: 'Record not found.' });
    const fm = await loadForm(P.orgId, P.entity, P.id, P.form);
    const locked = lockedKeys(P.form, fm.signatures);
    const submitted = (req.body && typeof req.body.values === 'object' && req.body.values) || {};
    const secrets = (req.body && typeof req.body.secrets === 'object' && req.body.secrets) || {};
    const defs = fieldsOfForm(P.form);
    const errors = []; const merged = Object.assign({}, fm.values);

    const hrOnly = req.vendorLink ? employerFieldKeys(P.form) : new Set();
    for (const k of Object.keys(submitted).concat(Object.keys(secrets))) {
      if (hrOnly.has(k)) return res.status(403).json({ error: 'That part of the form is completed by the company, not through this link.' });
    }
    for (const d of defs) {
      if (d.kind === 'secret' || !(d.key in submitted)) continue;
      if (locked.has(d.key)) { errors.push(`${d.label} is in a signed section. Reopen the signature to change it.`); continue; }
      const r = cleanValue(d, submitted[d.key]);
      if (r.error) { errors.push(r.error); continue; }
      if (r.value === '' || r.value === false) delete merged[d.key]; else merged[d.key] = r.value;
    }
    const secretKeys = Object.keys(secrets);
    if (secretKeys.length) {
      if (!canEditSecrets(req, P.form)) return res.status(403).json({ error: 'Only the account owner or an HR admin can enter SSN, tax ID, document or bank numbers.' });
      if (secretKeys.some((k) => secrets[k] !== null && secrets[k] !== '') && !isConfigured()) {
        return res.status(503).json({ error: 'Sensitive fields cannot be saved yet: the server has no encryption key. Set FIELD_ENCRYPTION_KEY (see README-DEPLOY.md), restart, and try again. Nothing was stored.' });
      }
    }
    const secretPlan = [];
    for (const k of secretKeys) {
      const d = defs.find((x) => x.key === k && x.kind === 'secret');
      if (!d) { errors.push(`Unknown field "${k}".`); continue; }
      if (locked.has(k)) { errors.push(`${d.label} is in a signed section. Reopen the signature to change it.`); continue; }
      if (secrets[k] === null || secrets[k] === '') { secretPlan.push({ k, clear: true }); continue; }
      const clean = secretClean(d.secretKind, secrets[k]);
      if (!clean) { errors.push(`${d.label} is not in a valid format.`); continue; }
      secretPlan.push({ k, clean });
    }
    if (errors.length) return res.status(400).json({ error: errors[0], errors });

    await saveForm(P.orgId, P.entity, P.id, P.form, merged, fm.signatures);
    for (const sp of secretPlan) {
      const field = P.form + '.' + sp.k;
      if (sp.clear) {
        await pool.query(`DELETE FROM record_secrets WHERE organization_id = ? AND entity = ? AND record_id = ? AND field = ?`, [P.orgId, P.entity, P.id, field]);
      } else {
        await pool.query(
          `INSERT INTO record_secrets (organization_id, entity, record_id, field, cipher, last4) VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE cipher = VALUES(cipher), last4 = VALUES(last4)`,
          [P.orgId, P.entity, P.id, field, encrypt(sp.clean), sp.clean.slice(-4)]);
      }
    }
    const changed = Object.keys(submitted).filter((k) => !locked.has(k)).concat(secretPlan.map((x) => x.k + ' (encrypted)'));
    if (changed.length) await log(P.orgId, P.entity, P.id, req, `${FORMS[P.form].title} saved: ${changed.join(', ')}`);
    res.json({ ok: true });
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

function requiredMissing(form, key, values, secretSet) {
  const out = [];
  FORMS[form].sections.filter((s) => s.signKey === key).forEach((s) => {
    s.fields.forEach((d) => {
      let need = !!d.required;
      if (!need && d.requiredIf) {
        const cur = values[d.requiredIf.key];
        need = d.requiredIf.in.some((x) => x === cur || (x === true && cur === true));
      }
      if (!need) return;
      if (d.kind === 'secret') { if (!secretSet[d.key] || !secretSet[d.key].set) out.push(d.label); }
      else if (d.kind === 'attest') { if (values[d.key] !== true) out.push(d.label.slice(0, 60) + '…'); }
      else if (values[d.key] === undefined || values[d.key] === '' || values[d.key] === false) out.push(d.label);
    });
  });
  const groups = {};
  FORMS[form].sections.filter((s) => s.signKey === key).forEach((s) => s.fields.forEach((d) => {
    if (!d.oneOf) return;
    const g = groups[d.oneOf] || (groups[d.oneOf] = { labels: [], ok: false });
    g.labels.push(d.label);
    if (d.kind === 'secret' ? secretSet[d.key] && secretSet[d.key].set : values[d.key]) g.ok = true;
  }));
  // a one-of group only applies when its section is showing (e.g. the wire fields when Wire is chosen)
  if (form === 'banking' && values.method !== 'Wire') delete groups.wire_code;
  Object.values(groups).forEach((g) => { if (!g.ok) out.push(g.labels.join(' or ')); });
  return out;
}

router.post('/:entity/:id/:form/sign', async (req, res, next) => {
  try {
    const P = checkParams(req, res); if (!P) return;
    if (!(await loadRecord(P.entity, P.id, P.orgId))) return res.status(404).json({ error: 'Record not found.' });
    const key = req.body && req.body.signature;
    const typed = String((req.body && req.body.typedName) || '').replace(/\s+/g, ' ').trim();
    if (!FORMS[P.form].signatures[key]) return res.status(400).json({ error: 'Unknown signature.' });
    if (req.vendorLink && EMPLOYER_SIGNS.has(key)) return res.status(403).json({ error: 'That signature is added by the company, not through this link.' });
    if (!(req.body && req.body.consent === true)) return res.status(400).json({ error: 'Tick the box agreeing to sign electronically.' });
    if (typed.length < 2 || typed.length > 120) return res.status(400).json({ error: 'Type the full name of the person signing.' });
    const fm = await loadForm(P.orgId, P.entity, P.id, P.form);
    if (fm.signatures[key]) return res.status(409).json({ error: 'This is already signed.' });
    const prior = SIGN_AFTER[key];
    if (prior && FORMS[P.form].signatures[prior] && !fm.signatures[prior]) {
      return res.status(409).json({ error: `${FORMS[P.form].signatures[prior].label} must be signed first.` });
    }
    const missing = requiredMissing(P.form, key, fm.values, await secretState(P.orgId, P.entity, P.id, P.form));
    if (missing.length) return res.status(400).json({ error: `Complete these before signing: ${missing.join('; ')}`, missing });
    const sigs = Object.assign({}, fm.signatures, {
      [key]: { name: typed, at: new Date().toISOString(), by: req.user.email, ip: req.ip, agent: String(req.get('user-agent') || '').slice(0, 160) },
    });
    await saveForm(P.orgId, P.entity, P.id, P.form, fm.values, sigs);
    await log(P.orgId, P.entity, P.id, req, `${FORMS[P.form].title}: ${FORMS[P.form].signatures[key].label} signed electronically by "${typed}"`);
    res.json({ ok: true, signature: sigs[key], status: statusOf(P.form, true, sigs) });
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.post('/:entity/:id/:form/reopen', async (req, res, next) => {
  try {
    const P = checkParams(req, res); if (!P) return;
    if (!isHrAdmin(req)) return res.status(403).json({ error: 'Only the account owner or an HR admin can reopen a signed form.' });
    const key = req.body && req.body.signature;
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!FORMS[P.form].signatures[key]) return res.status(400).json({ error: 'Unknown signature.' });
    if (reason.length < 3) return res.status(400).json({ error: 'Give a reason; it is kept in the activity log.' });
    const fm = await loadForm(P.orgId, P.entity, P.id, P.form);
    if (!fm.signatures[key]) return res.status(409).json({ error: 'That signature is not applied.' });
    const sigs = Object.assign({}, fm.signatures);
    const drop = [key];
    for (let changed = true; changed;) { // anything that depended on it goes too
      changed = false;
      for (const [k, dep] of Object.entries(SIGN_AFTER)) { if (drop.includes(dep) && sigs[k] && !drop.includes(k)) { drop.push(k); changed = true; } }
    }
    drop.forEach((k) => { delete sigs[k]; });
    await saveForm(P.orgId, P.entity, P.id, P.form, fm.values, sigs);
    await log(P.orgId, P.entity, P.id, req, `${FORMS[P.form].title}: signature reopened (${drop.join(', ')}). Reason: ${reason}`);
    res.json({ ok: true, removed: drop });
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.helpers = { loadForm, statusOf };
module.exports = router;
