// Record profiles: the full CRM-style form for a consultant, client or
// vendor (programs table), plus the blank intake form for new records.
// Everything is scoped to req.user.organization_id.
//
// Sensitive values (SSN, tax IDs, bank routing/account numbers) are
// encrypted with AES-256-GCM (src/crypto.js) and are WRITE-ONLY: the API only
// ever returns whether a value is set and its last 4 characters.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { encrypt, isConfigured } = require('../crypto');
const { SPEC, fieldsOf } = require('./profileFields');

const router = express.Router();
router.use(requireAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TEXT = 500;
const MAX_LONG = 4000;

function specFor(entity) { return SPEC[entity] || null; }

function schemaMissing(err) { return err && (err.code === 'ER_NO_SUCH_TABLE'); }
const SCHEMA_MSG = 'Profiles need the latest database update. Run db/schema.sql on the database, then try again.';

function secretClean(kind, raw) {
  const s = String(raw).trim();
  if (kind === 'ssn') {
    const d = s.replace(/[\s-]/g, '');
    return /^\d{9}$/.test(d) ? d : null;
  }
  if (kind === 'routing') return /^\d{9}$/.test(s.replace(/\s/g, '')) ? s.replace(/\s/g, '') : null;
  if (kind === 'account') {
    const d = s.replace(/[\s-]/g, '');
    return /^\d{4,17}$/.test(d) ? d : null;
  }
  if (kind === 'anumber') {
    const d = s.replace(/^a[-\s]?/i, '').replace(/[\s-]/g, '');
    return /^\d{7,9}$/.test(d) ? d : null;
  }
  if (kind === 'docnumber') {
    const d = s.replace(/\s/g, '');
    return /^[0-9A-Za-z-]{3,30}$/.test(d) ? d : null;
  }
  if (kind === 'taxid') {
    const d = s.replace(/[\s-]/g, '');
    return /^[0-9A-Za-z]{5,15}$/.test(d) ? d : null;
  }
  return null;
}

function maskFor(kind, last4) {
  if (kind === 'ssn') return `***-**-${last4}`;
  return `****${last4}`;
}

// Validates and normalises one submitted value. Returns { value } or { error }.
function cleanValue(field, raw, optionsFor) {
  if (raw === null || raw === undefined) return { value: '' };
  if (field.kind === 'bool' || field.kind === 'attest') {
    if (raw === true || raw === 'true' || raw === 1 || raw === '1') return { value: true };
    if (raw === false || raw === 'false' || raw === 0 || raw === '0' || raw === '') return { value: false };
    return { error: `${field.label} must be yes or no.` };
  }
  if (typeof raw === 'object') return { error: `${field.label} is not valid.` };
  const s = String(raw).trim();
  if (s === '') return { value: '' };
  switch (field.kind) {
    case 'email':
      if (!EMAIL_RE.test(s) || s.length > 255) return { error: `${field.label} must be an email address.` };
      return { value: s };
    case 'phone':
      if (s.length > 64 || !/^[0-9+().\-\sxXext#]+$/.test(s)) return { error: `${field.label} must be a phone number.` };
      return { value: s };
    case 'url':
      if (s.length > 255 || !/^(https?:\/\/)?[^\s.]+\.[^\s]+$/i.test(s)) return { error: `${field.label} must be a web address.` };
      return { value: s };
    case 'date':
      if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) return { error: `${field.label} must be a date (YYYY-MM-DD).` };
      return { value: s };
    case 'number': {
      const n = Number(s.replace(/,/g, ''));
      if (!Number.isFinite(n) || n < 0 || n > 1e9) return { error: `${field.label} must be a number.` };
      return { value: String(n) };
    }
    case 'select': {
      const opts = field.options || (optionsFor && optionsFor(field)) || [];
      const hit = opts.find((o) => String(o).toLowerCase() === s.toLowerCase());
      if (!hit) return { error: `${field.label} must be one of: ${opts.join(', ')}.` };
      return { value: hit };
    }
    case 'record':
      if (!/^\d+$/.test(s)) return { error: `${field.label} is not valid.` };
      return { value: s };
    case 'textarea':
      if (s.length > MAX_LONG) return { error: `${field.label} is too long.` };
      return { value: s };
    default:
      if (s.length > (field.core && field.key === 'address' ? 500 : MAX_TEXT)) return { error: `${field.label} is too long.` };
      return { value: s };
  }
}

async function loadRecord(entity, id, orgId) {
  const [rows] = await pool.query(`SELECT * FROM ${entity} WHERE id = ? AND organization_id = ?`, [id, orgId]);
  return rows[0] || null;
}

async function recordExists(table, id, orgId) {
  const [r] = await pool.query(`SELECT id FROM ${table} WHERE id = ? AND organization_id = ?`, [id, orgId]);
  return r.length > 0;
}

// Cross-record references (supplier company, client) must be in this org.
async function checkRecordFields(spec, values, orgId) {
  for (const fld of fieldsOf(spec.table)) {
    if (fld.kind !== 'record' || !values[fld.key]) continue;
    if (!(await recordExists(fld.source, Number(values[fld.key]), orgId))) return `${fld.label} was not found.`;
  }
  return null;
}

async function loadProfile(entity, id, orgId) {
  const [rows] = await pool.query(
    `SELECT data FROM record_profiles WHERE organization_id = ? AND entity = ? AND record_id = ?`, [orgId, entity, id]);
  let data = {};
  if (rows[0] && rows[0].data) { try { data = JSON.parse(rows[0].data) || {}; } catch (e) { data = {}; } }
  return data;
}

async function loadSecrets(entity, id, orgId) {
  const spec = SPEC[entity];
  const kinds = {};
  fieldsOf(entity).forEach((fld) => { if (fld.kind === 'secret') kinds[fld.key] = fld.secretKind; });
  const [rows] = await pool.query(
    `SELECT field, last4, updated_at FROM record_secrets WHERE organization_id = ? AND entity = ? AND record_id = ?`, [orgId, entity, id]);
  const out = {};
  Object.keys(kinds).forEach((k) => { out[k] = { set: false }; });
  rows.forEach((r) => {
    if (kinds[r.field]) out[r.field] = { set: true, last4: r.last4, masked: maskFor(kinds[r.field], r.last4), updatedAt: r.updated_at };
  });
  void spec;
  return out;
}

async function related(entity, id, orgId) {
  if (entity === 'consultants') {
    const [rows] = await pool.query(
      `SELECT a.id, a.status, a.left_date AS leftDate, a.billing, c.id AS clientId, c.name AS clientName, p.id AS programId, p.name AS programName
         FROM consultant_assignments a
         LEFT JOIN clients c ON c.id = a.client_id
         LEFT JOIN programs p ON p.id = a.program_id
        WHERE a.consultant_id = ? AND a.organization_id = ?
        ORDER BY a.status, c.name, p.name`, [id, orgId]);
    return { assignments: rows };
  }
  if (entity === 'clients') {
    const [subs] = await pool.query(`SELECT id, name, status FROM programs WHERE client_id = ? AND organization_id = ? ORDER BY name`, [id, orgId]);
    const [cnt] = await pool.query(
      `SELECT COUNT(DISTINCT consultant_id) AS n FROM consultant_assignments WHERE client_id = ? AND status = 'active' AND organization_id = ?`, [id, orgId]);
    return { subVendors: subs, activeConsultants: cnt[0].n };
  }
  if (entity === 'subvendors') {
    const [cons] = await pool.query(
      `SELECT DISTINCT co.id, co.name FROM consultants co
        WHERE co.organization_id = ? AND (
          co.id IN (SELECT consultant_id FROM subvendor_invoices WHERE subvendor_id = ? AND organization_id = ?)
          OR co.id IN (SELECT record_id FROM record_profiles WHERE organization_id = ? AND entity = 'consultants'
                         AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.supplier_id')) = ?))
        ORDER BY co.name`, [orgId, id, orgId, orgId, String(id)]);
    return { supplierConsultants: cons };
  }
  const [rows] = await pool.query(
    `SELECT DISTINCT co.id, co.name FROM consultant_assignments a JOIN consultants co ON co.id = a.consultant_id
      WHERE a.program_id = ? AND a.status = 'active' AND a.organization_id = ? ORDER BY co.name`, [id, orgId]);
  return { activeConsultantsList: rows };
}

async function optionLists(orgId) {
  const [clients] = await pool.query(`SELECT id, name FROM clients WHERE organization_id = ? ORDER BY name`, [orgId]);
  const [subs] = await pool.query(`SELECT id, name FROM subvendors WHERE organization_id = ? ORDER BY name`, [orgId]);
  return { clients, subvendors: subs };
}

async function writeLog(entity, id, req, text) {
  try {
    await pool.query(
      `INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, ?, ?, 'log', ?, ?)`,
      [req.user.organization_id, entity, id, text, req.user.name || req.user.email]);
  } catch (e) { /* the log is best-effort */ }
}

// Splits submitted values into core columns, profile JSON and validated errors.
async function prepare(spec, body, orgId, { creating }) {
  const values = (body && typeof body.values === 'object' && body.values) || {};
  const errors = [];
  const core = {};
  const data = {};
  const touched = [];
  for (const fld of fieldsOf(spec.table)) {
    if (fld.kind === 'secret') continue;
    if (!(fld.key in values)) {
      if (creating && fld.required) errors.push(`${fld.label} is required.`);
      continue;
    }
    if (!creating && fld.readOnlyAfterCreate) continue;
    const r = cleanValue(fld, values[fld.key]);
    if (r.error) { errors.push(r.error); continue; }
    if (fld.required && creating && (r.value === '' || r.value === false)) { errors.push(`${fld.label} is required.`); continue; }
    touched.push(fld.key);
    if (fld.core) core[fld.key] = r.value; else data[fld.key] = r.value;
  }
  const refErr = await checkRecordFields(spec, Object.assign({}, core, data), orgId);
  if (refErr) errors.push(refErr);
  return { core, data, errors, touched };
}

async function applySecrets(conn, spec, entity, id, orgId, secrets) {
  const changed = [];
  if (!secrets || typeof secrets !== 'object') return { changed, errors: [] };
  const errors = [];
  const defs = {};
  fieldsOf(entity).forEach((fld) => { if (fld.kind === 'secret') defs[fld.key] = fld; });
  for (const [key, raw] of Object.entries(secrets)) {
    const def = defs[key];
    if (!def) { errors.push(`Unknown field "${key}".`); continue; }
    if (raw === null || raw === '') {
      await conn.query(`DELETE FROM record_secrets WHERE organization_id = ? AND entity = ? AND record_id = ? AND field = ?`, [orgId, entity, id, key]);
      changed.push(key);
      continue;
    }
    const clean = secretClean(def.secretKind, raw);
    if (!clean) { errors.push(`${def.label} is not in a valid format.`); continue; }
    const cipher = encrypt(clean);
    await conn.query(
      `INSERT INTO record_secrets (organization_id, entity, record_id, field, cipher, last4) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE cipher = VALUES(cipher), last4 = VALUES(last4)`,
      [orgId, entity, id, key, cipher, clean.slice(-4)]);
    changed.push(key);
  }
  return { changed, errors };
}

function guardSecrets(req, res, secrets) {
  if (!secrets || typeof secrets !== 'object' || !Object.keys(secrets).length) return true;
  if (req.user.role !== 'owner') {
    res.status(403).json({ error: 'Only the account owner can change SSN, tax ID or bank numbers.' });
    return false;
  }
  const anyValue = Object.values(secrets).some((v) => v !== null && v !== '');
  if (anyValue && !isConfigured()) {
    res.status(503).json({ error: 'Sensitive fields cannot be saved yet: the server has no encryption key. Set FIELD_ENCRYPTION_KEY (see README-DEPLOY.md), restart, and try again. Nothing was stored.' });
    return false;
  }
  return true;
}

router.get('/schema', async (req, res, next) => {
  try {
    const lists = await optionLists(req.user.organization_id);
    res.json({ spec: SPEC, lists, encryptionConfigured: isConfigured(), canEditSecrets: req.user.role === 'owner' });
  } catch (err) { next(err); }
});

router.get('/:entity/:id', async (req, res, next) => {
  try {
    const entity = req.params.entity;
    const spec = specFor(entity);
    if (!spec || !/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
    const orgId = req.user.organization_id;
    const id = Number(req.params.id);
    const rec = await loadRecord(entity, id, orgId);
    if (!rec) return res.status(404).json({ error: 'Record not found.' });
    const data = await loadProfile(entity, id, orgId);
    const values = {};
    fieldsOf(entity).forEach((fld) => {
      if (fld.kind === 'secret') return;
      let v = fld.core ? rec[fld.key] : data[fld.key];
      if (v instanceof Date) v = v.toISOString().slice(0, 10);
      values[fld.key] = v === undefined || v === null ? (fld.kind === 'bool' ? false : '') : v;
    });
    const [notes] = await pool.query(
      `SELECT id, kind, body, user_name AS userName, created_at AS createdAt FROM record_notes
        WHERE organization_id = ? AND entity = ? AND record_id = ? ORDER BY id DESC LIMIT 100`, [orgId, entity, id]);
    res.json({
      entity, id, name: rec.name, values,
      secrets: await loadSecrets(entity, id, orgId),
      related: await related(entity, id, orgId),
      notes, createdAt: rec.created_at, updatedAt: rec.updated_at,
    });
  } catch (err) {
    if (schemaMissing(err)) return res.status(503).json({ error: SCHEMA_MSG });
    next(err);
  }
});

router.patch('/:entity/:id', async (req, res, next) => {
  const entity = req.params.entity;
  const spec = specFor(entity);
  if (!spec || !/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
  const orgId = req.user.organization_id;
  const id = Number(req.params.id);
  let conn;
  try {
    const rec = await loadRecord(entity, id, orgId);
    if (!rec) return res.status(404).json({ error: 'Record not found.' });
    const secrets = req.body && req.body.secrets;
    if (!guardSecrets(req, res, secrets)) return;
    const { core, data, errors, touched } = await prepare(spec, req.body, orgId, { creating: false });
    if (errors.length) return res.status(400).json({ error: errors[0], errors });

    conn = await pool.getConnection();
    await conn.beginTransaction();
    const sets = []; const params = [];
    for (const [k, v] of Object.entries(core)) {
      if (k === 'status') { if (v) { sets.push('status = ?'); params.push(v); } continue; }
      sets.push(`${k} = ?`); params.push(v === '' ? null : v);
    }
    if (sets.length) await conn.query(`UPDATE ${entity} SET ${sets.join(', ')} WHERE id = ? AND organization_id = ?`, [...params, id, orgId]);

    if (Object.keys(data).length) {
      const [cur] = await conn.query(`SELECT data FROM record_profiles WHERE organization_id = ? AND entity = ? AND record_id = ? FOR UPDATE`, [orgId, entity, id]);
      let merged = {};
      if (cur[0] && cur[0].data) { try { merged = JSON.parse(cur[0].data) || {}; } catch (e) { merged = {}; } }
      for (const [k, v] of Object.entries(data)) {
        if (v === '' || v === false) delete merged[k]; else merged[k] = v;
      }
      await conn.query(
        `INSERT INTO record_profiles (organization_id, entity, record_id, data) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data)`, [orgId, entity, id, JSON.stringify(merged)]);
    }
    const sec = await applySecrets(conn, spec, entity, id, orgId, secrets);
    if (sec.errors.length) { await conn.rollback(); return res.status(400).json({ error: sec.errors[0], errors: sec.errors }); }
    await conn.commit();

    const names = touched.concat(sec.changed.map((k) => k + ' (encrypted)'));
    if (names.length) await writeLog(entity, id, req, `Updated: ${names.join(', ')}`);
    res.json({ ok: true });
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch (e) { /* ignore */ } }
    if (schemaMissing(err)) return res.status(503).json({ error: SCHEMA_MSG });
    next(err);
  } finally { if (conn) conn.release(); }
});

router.post('/:entity', async (req, res, next) => {
  const entity = req.params.entity;
  const spec = specFor(entity);
  if (!spec) return res.status(404).json({ error: 'Not found.' });
  const orgId = req.user.organization_id;
  let conn;
  try {
    const secrets = req.body && req.body.secrets;
    if (!guardSecrets(req, res, secrets)) return;
    const { core, data, errors, touched } = await prepare(spec, req.body, orgId, { creating: true });
    if (errors.length) return res.status(400).json({ error: errors[0], errors });

    const name = String(core.name || '').replace(/\s+/g, ' ').trim();
    if (!name) return res.status(400).json({ error: `${spec.singular} name is required.` });
    let dupSql; let dupParams;
    if (entity === 'programs') {
      dupSql = `SELECT id FROM programs WHERE organization_id = ? AND client_id = ? AND LOWER(name) = LOWER(?)`;
      dupParams = [orgId, Number(core.client_id), name];
    } else {
      dupSql = `SELECT id FROM ${entity} WHERE organization_id = ? AND LOWER(name) = LOWER(?)`;
      dupParams = [orgId, name];
    }
    const [dup] = await pool.query(dupSql, dupParams);
    if (dup.length) return res.status(409).json({ error: `A ${spec.singular.toLowerCase()} named "${name}" already exists.`, existingId: dup[0].id });

    conn = await pool.getConnection();
    await conn.beginTransaction();
    const cols = ['organization_id', 'name']; const vals = [orgId, name];
    for (const [k, v] of Object.entries(core)) {
      if (k === 'name') continue;
      if (k === 'status' && !v) continue;
      cols.push(k); vals.push(k === 'client_id' ? Number(v) : (v === '' ? null : v));
    }
    const [ins] = await conn.query(`INSERT INTO ${entity} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals);
    const id = ins.insertId;
    const clean = {};
    for (const [k, v] of Object.entries(data)) if (v !== '' && v !== false) clean[k] = v;
    if (Object.keys(clean).length) {
      await conn.query(`INSERT INTO record_profiles (organization_id, entity, record_id, data) VALUES (?, ?, ?, ?)`, [orgId, entity, id, JSON.stringify(clean)]);
    }
    const sec = await applySecrets(conn, spec, entity, id, orgId, secrets);
    if (sec.errors.length) { await conn.rollback(); return res.status(400).json({ error: sec.errors[0], errors: sec.errors }); }
    await conn.commit();
    await writeLog(entity, id, req, `${spec.singular} created${touched.length ? '' : ''}`);
    res.status(201).json({ id, name });
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch (e) { /* ignore */ } }
    if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `That ${spec.singular.toLowerCase()} already exists.` });
    if (schemaMissing(err)) return res.status(503).json({ error: SCHEMA_MSG });
    next(err);
  } finally { if (conn) conn.release(); }
});

router.post('/:entity/:id/notes', async (req, res, next) => {
  try {
    const entity = req.params.entity;
    if (!specFor(entity) || !/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
    const orgId = req.user.organization_id;
    const id = Number(req.params.id);
    if (!(await loadRecord(entity, id, orgId))) return res.status(404).json({ error: 'Record not found.' });
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Write a note first.' });
    if (body.length > MAX_LONG) return res.status(400).json({ error: 'That note is too long.' });
    await pool.query(
      `INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, ?, ?, 'note', ?, ?)`,
      [orgId, entity, id, body, req.user.name || req.user.email]);
    res.status(201).json({ ok: true });
  } catch (err) {
    if (schemaMissing(err)) return res.status(503).json({ error: SCHEMA_MSG });
    next(err);
  }
});

router.helpers = { cleanValue, secretClean, maskFor };
module.exports = router;
