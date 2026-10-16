// Onboarding: placement information (the e-mail the recruiter used to send)
// plus the HR checklist for W2 / C2C / 1099 engagements. Scoped to
// req.user.organization_id.
//
// Flow: draft (recruiter) -> submitted (sent to HR) -> in_progress (HR working
// the checklist) -> complete. "Create directory records" turns the placement
// into the consultant, supplier company, client, vendor and billing pairing.

const express = require('express');
const pool = require('../db');
const { requireAuth, hashPassword, validateSignupInput } = require('../auth');
const forms = require('./forms');
const { FORMS } = require('./formSpecs');
const { splitClientText } = require('./clientAliases');
const spec = require('./onboardingSpec');

const router = express.Router();
router.use(requireAuth);

const SCHEMA_MSG = 'Onboarding needs the latest database update. Run db/schema.sql on the database, then try again.';
const TYPES = ['W2', 'C2C', '1099'];
const STATUSES = ['draft', 'submitted', 'in_progress', 'complete', 'cancelled'];
const NEXT = {
  draft: ['submitted', 'in_progress', 'cancelled'],
  submitted: ['draft', 'in_progress', 'cancelled'],
  in_progress: ['complete', 'draft', 'cancelled'],
  complete: ['in_progress'],
  cancelled: ['draft'],
};
const PROFILE_TYPE = { W2: 'W2', C2C: 'Corp-to-Corp', '1099': '1099' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const missingTable = (e) => e && e.code === 'ER_NO_SUCH_TABLE';
const parse = (t, fallback) => { try { const v = t && JSON.parse(t); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; } };
const pad2 = (n) => String(n).padStart(2, '0');
const dateStr = (v) => (!v ? null : v instanceof Date ? v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate()) : String(v).slice(0, 10));
const who = (req) => req.user.name || req.user.email;
// HR admins (and the owner) see every request and can change anything; recruiters (members) see and edit their own.
const isHr = (req) => req.user.role === 'owner' || req.user.role === 'hr';
// Money figures are for HR only: a recruiter can type them in, but never reads them back.
const SENSITIVE = ['bill_rate', 'pay_rate', 'final_cost'];
const withoutMoney = (data) => { const d = Object.assign({}, data); SENSITIVE.forEach((k) => { delete d[k]; }); return d; };
const denyHr = (res) => res.status(403).json({ error: 'Only an HR admin can do that.' });

// ------------------------------------------------------------ validation
function allKeys() { return new Set(spec.SECTIONS.flatMap((s) => s.fields.map((x) => x.key))); }
const FIELD_BY_KEY = {};
spec.SECTIONS.forEach((s) => s.fields.forEach((x) => { FIELD_BY_KEY[x.key] = x; }));

// Cleans the submitted values field by field. Returns { data, errors }.
function clean(input, existing) {
  const data = Object.assign({}, existing || {});
  const errors = [];
  for (const key of allKeys()) {
    if (!input || !Object.prototype.hasOwnProperty.call(input, key)) continue;
    const fld = FIELD_BY_KEY[key];
    const raw = input[key];
    const s = raw === null || raw === undefined ? '' : String(raw).trim();
    if (s === '') { delete data[key]; continue; }
    const max = fld.kind === 'textarea' ? 2000 : 300;
    if (s.length > max) { errors.push({ key, message: `${fld.label} is too long.` }); continue; }
    if (fld.kind === 'number') {
      const n = Number(s.replace(/[$,]/g, ''));
      if (!isFinite(n) || n < 0 || n > 10000000) { errors.push({ key, message: `${fld.label} must be a number.` }); continue; }
      data[key] = n;
    } else if (fld.kind === 'date') {
      if (!DATE_RE.test(s) || isNaN(new Date(s + 'T00:00:00Z'))) { errors.push({ key, message: `${fld.label} must be a valid date.` }); continue; }
      data[key] = s;
    } else if (fld.kind === 'email') {
      if (!EMAIL_RE.test(s)) { errors.push({ key, message: `${fld.label} is not a valid email address.` }); continue; }
      data[key] = s;
    } else if (fld.kind === 'select') {
      const hit = fld.options.find((o) => o.toLowerCase() === s.toLowerCase());
      if (!hit) { errors.push({ key, message: `${fld.label}: choose one of the listed options.` }); continue; }
      data[key] = hit;
    } else data[key] = s;
  }
  return { data, errors };
}

function missingRequired(type, data) {
  return spec.fieldsFor(type).filter((x) => x.required && (data[x.key] === undefined || data[x.key] === '')).map((x) => x.label);
}

function lev(a, b) {
  const m = []; for (let i = 0; i <= a.length; i++) { m[i] = [i]; }
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length];
}
const COMMON_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com'];
function emailTypo(addr) {
  const at = String(addr || '').lastIndexOf('@'); if (at < 0) return null;
  const dom = addr.slice(at + 1).toLowerCase();
  if (COMMON_DOMAINS.includes(dom)) return null;
  const sorted = (x) => x.split('').sort().join('');
  const near = COMMON_DOMAINS.find((d) => lev(dom, d) === 1 || (d.length === dom.length && sorted(d) === sorted(dom)));
  return near ? `${dom} looks like a typo of ${near}` : null;
}

function warningsFor(type, data) {
  const w = [];
  ['email', 'invoice_to_email', 'employer_email'].forEach((k) => {
    const t = data[k] && emailTypo(data[k]);
    if (t) w.push({ key: k, message: `${FIELD_BY_KEY[k].label}: ${t}.` });
  });
  const mg = margin(data);
  if (mg && mg.perHour < 0) w.push({ key: 'pay_rate', message: 'The cost is higher than the bill rate, so this placement loses money.' });
  if (data.start_date) {
    const days = (Date.now() - new Date(data.start_date + 'T00:00:00Z').getTime()) / 86400000;
    if (days > 60) w.push({ key: 'start_date', message: 'The project start date is more than 60 days ago.' });
  }
  if (type === 'C2C' && !data.employer_name) w.push({ key: 'employer_name', message: 'C2C needs the consultant’s company (candidate employer).' });
  return w;
}

function margin(d) {
  if (!d || d.bill_rate === undefined || (d.pay_rate === undefined && d.final_cost === undefined)) return null;
  if ((d.bill_rate_basis || 'Hourly') !== (d.pay_rate_basis || 'Hourly')) return null;
  const cost = d.final_cost !== undefined ? d.final_cost : d.pay_rate;
  const per = Math.round((d.bill_rate - cost) * 100) / 100;
  return { perHour: per, pct: d.bill_rate ? Math.round((per / d.bill_rate) * 1000) / 10 : null, basis: d.bill_rate_basis || 'Hourly', costUsed: d.final_cost !== undefined ? 'final cost' : 'pay rate' };
}

// ------------------------------------------------------------- checklist
async function formStates(orgId, rows) {
  // rows: onboardings; returns Map "entity:id:form" -> status
  const out = new Map();
  const want = { consultants: new Set(), subvendors: new Set() };
  rows.forEach((r) => { if (r.consultant_id) want.consultants.add(r.consultant_id); if (r.supplier_id) want.subvendors.add(r.supplier_id); });
  for (const [entity, ids] of Object.entries(want)) {
    if (!ids.size) continue;
    const [fr] = await pool.query(
      `SELECT record_id, form_type, data, signatures FROM record_forms WHERE organization_id = ? AND entity = ? AND record_id IN (?)`,
      [orgId, entity, Array.from(ids)]);
    fr.forEach((r) => {
      if (!FORMS[r.form_type]) return;
      out.set(`${entity}:${r.record_id}:${r.form_type}`, forms.helpers.statusOf(r.form_type, true, parse(r.signatures, {})));
    });
  }
  return out;
}

function checklistView(row, data, stored, states) {
  const meta = data._meta || {};
  return spec.checklistFor(row.worker_type, data).map((c) => {
    const st = stored[c.key] || {};
    const out = { key: c.key, label: c.label, group: c.group, hint: c.hint || null, manualDone: !!st.done, na: !!st.na, note: st.note || '', at: st.at || null, by: st.by || null };
    if (c.form) {
      const entity = c.on === 'supplier' ? 'subvendors' : 'consultants';
      const rid = c.on === 'supplier' ? row.supplier_id : row.consultant_id;
      out.form = { form: c.form, entity, recordId: rid || null, title: FORMS[c.form].title, status: rid ? (states.get(`${entity}:${rid}:${c.form}`) || 'not started') : null };
      out.autoDone = out.form.status === 'complete';
    } else if (c.auto === 'records') {
      out.autoDone = !!(row.consultant_id && meta.assignmentId && (row.worker_type !== 'C2C' || !data.employer_name || row.supplier_id));
    }
    out.done = !out.na && (out.manualDone || !!out.autoDone);
    return out;
  });
}
const progress = (items) => { const live = items.filter((i) => !i.na); return { done: live.filter((i) => i.done).length, total: live.length }; };

// ----------------------------------------------------------------- serialise
async function present(row, extra, req) {
  const full = parse(row.data, {});
  const hide = !!req && !isHr(req);
  const data = hide ? withoutMoney(full) : full;
  const stored = parse(row.checklist, {});
  const states = await formStates(row.organization_id, [row]);
  const items = checklistView(row, data, stored, states);
  const pub = Object.assign({}, data); delete pub._meta;
  return Object.assign({
    id: row.id, workerType: row.worker_type, status: row.status, consultantName: row.consultant_name,
    startDate: dateStr(row.start_date),
    consultantId: row.consultant_id, supplierId: row.supplier_id, data: pub, meta: data._meta || {},
    checklist: items, progress: progress(items), margin: hide ? null : margin(data), warnings: warningsFor(row.worker_type, data),
    hiddenFields: hide ? Object.fromEntries(SENSITIVE.filter((k) => full[k] !== undefined).map((k) => [k, true])) : {},
    log: parse(row.log, []).slice(-60).reverse(), createdBy: row.created_by,
    submittedAt: row.submitted_at, completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at,
  }, extra || {});
}

async function load(req, res) {
  if (!/^\d+$/.test(req.params.id)) { res.status(404).json({ error: 'Not found.' }); return null; }
  const [rows] = await pool.query(`SELECT * FROM onboardings WHERE id = ? AND organization_id = ?`, [req.params.id, req.user.organization_id]);
  if (!rows[0] || (!isHr(req) && rows[0].created_by_id !== req.user.id)) { res.status(404).json({ error: 'Onboarding not found.' }); return null; }
  return rows[0];
}
function addLog(row, req, text) {
  const l = parse(row.log, []); l.push({ at: new Date().toISOString(), by: who(req), text });
  row.log = JSON.stringify(l.slice(-200));
}
async function save(row, fields) {
  const cols = []; const params = [];
  Object.entries(fields).forEach(([k, v]) => { cols.push(`${k} = ?`); params.push(v); });
  await pool.query(`UPDATE onboardings SET ${cols.join(', ')} WHERE id = ? AND organization_id = ?`, params.concat([row.id, row.organization_id]));
}
async function directoryMatch(orgId, name) {
  const [r] = await pool.query(`SELECT id, status FROM consultants WHERE organization_id = ? AND LOWER(name) = LOWER(?) LIMIT 1`, [orgId, name]);
  return r[0] || null;
}

// ----------------------------------------------------------------- routes
router.get('/me', async (req, res, next) => {
  try {
    const [r] = await pool.query(`SELECT COUNT(*) n FROM onboardings WHERE organization_id = ? AND status = 'submitted'`, [req.user.organization_id]);
    res.json({ role: req.user.role, isHr: isHr(req), isOwner: req.user.role === 'owner', pending: isHr(req) ? Number(r[0].n) : 0 });
  } catch (err) { if (missingTable(err)) return res.json({ role: req.user.role, isHr: isHr(req), isOwner: req.user.role === 'owner', pending: 0 }); next(err); }
});

router.get('/people', async (req, res, next) => {
  try {
    if (!isHr(req)) return denyHr(res);
    const [rows] = await pool.query(`SELECT id, name, email, role FROM users WHERE organization_id = ? ORDER BY name`, [req.user.organization_id]);
    res.json({ people: rows, canEdit: req.user.role === 'owner' });
  } catch (err) { next(err); }
});

// Role-specific invite codes: the role is fixed by the code, so a recruiter who signs up with a
// "Recruiter" code lands in Onboarding only and never has to be demoted by hand.
router.get('/invites', async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the account owner can manage invite codes.' });
    const [rows] = await pool.query('SELECT id, code, role, label, created_at FROM invite_codes WHERE organization_id = ? AND revoked = 0 ORDER BY id DESC', [req.user.organization_id]);
    res.json({ invites: rows, legacyCode: req.user.invite_code });
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});
router.post('/invites', async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the account owner can create invite codes.' });
    const b = req.body || {};
    if (!['hr', 'member', 'recruiter'].includes(b.role)) return res.status(400).json({ error: 'Choose a role for this invite code.' });
    const code = require('crypto').randomBytes(6).toString('hex');
    await pool.query('INSERT INTO invite_codes (organization_id, code, role, label) VALUES (?, ?, ?, ?)', [req.user.organization_id, code, b.role, b.label ? String(b.label).trim().slice(0, 120) : null]);
    res.status(201).json({ code, role: b.role });
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});
router.delete('/invites/:id', async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the account owner can revoke invite codes.' });
    await pool.query('UPDATE invite_codes SET revoked = 1 WHERE id = ? AND organization_id = ?', [req.params.id, req.user.organization_id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// The owner creates a login directly (e.g. a recruiter who only needs Onboarding).
router.post('/people', async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the account owner can add people.' });
    const b = req.body || {};
    if (!['hr', 'member', 'recruiter'].includes(b.role)) return res.status(400).json({ error: 'Choose a role for this person.' });
    const bad = validateSignupInput({ email: b.email, password: b.password, name: b.name });
    if (bad) return res.status(400).json({ error: bad });
    const email = String(b.email).trim().toLowerCase();
    const [dup] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (dup.length) return res.status(409).json({ error: 'That email already has a login.' });
    const hash = await hashPassword(String(b.password));
    await pool.query('INSERT INTO users (organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)', [req.user.organization_id, email, hash, String(b.name).trim(), b.role]);
    res.status(201).json({ ok: true });
  } catch (err) { if (err && /Data truncated|ER_WARN_DATA_OUT_OF_RANGE|Incorrect enum/i.test(String(err.message))) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.put('/people/:userId', async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the account owner can choose HR admins.' });
    const role = req.body && req.body.role;
    if (!['hr', 'member', 'recruiter'].includes(role)) return res.status(400).json({ error: 'Role must be Recruiter, HR admin or Team member.' });
    const [rows] = await pool.query(`SELECT id, role FROM users WHERE id = ? AND organization_id = ?`, [req.params.userId, req.user.organization_id]);
    if (!rows[0]) return res.status(404).json({ error: 'Person not found.' });
    if (rows[0].role === 'owner') return res.status(409).json({ error: 'The owner is always an HR admin.' });
    await pool.query(`UPDATE users SET role = ? WHERE id = ? AND organization_id = ?`, [role, rows[0].id, req.user.organization_id]);
    res.json({ ok: true });
  } catch (err) { if (err && /Data truncated|ER_WARN_DATA_OUT_OF_RANGE|Incorrect enum/i.test(String(err.message))) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.get('/schema', (req, res) => {
  res.json({
    workerTypes: spec.WORKER_TYPES, statuses: STATUSES, next: NEXT,
    sections: spec.SECTIONS.map((s) => ({ key: s.key, title: s.title, types: s.types || null, fields: s.fields })),
    checklists: Object.fromEntries(Object.entries(spec.CHECKLISTS).map(([t, l]) => [t, l.map((c) => ({ key: c.key, label: c.label, group: c.group, when: c.when || null }))])),
  });
});

router.post('/parse-email', (req, res) => {
  const text = req.body && typeof req.body.text === 'string' ? req.body.text.slice(0, 20000) : '';
  if (!text.trim()) return res.status(400).json({ error: 'Paste the placement e-mail first.' });
  const r = spec.parseEmail(text);
  if (!r.matched.length) return res.status(422).json({ error: 'Could not find any placement fields in that text.', unmatched: r.unmatched.slice(0, 10) });
  res.json(r);
});

router.get('/', async (req, res, next) => {
  try {
    const where = ['o.organization_id = ?']; const params = [req.user.organization_id];
    if (!isHr(req)) { where.push('o.created_by_id = ?'); params.push(req.user.id); }
    const st = String(req.query.status || 'open');
    if (st === 'open') where.push(`o.status IN ('draft','submitted','in_progress')`);
    else if (STATUSES.includes(st)) { where.push('o.status = ?'); params.push(st); }
    if (TYPES.includes(req.query.type)) { where.push('o.worker_type = ?'); params.push(req.query.type); }
    if (req.query.q) { where.push('o.consultant_name LIKE ?'); params.push('%' + String(req.query.q).slice(0, 100) + '%'); }
    const [rows] = await pool.query(`SELECT o.* FROM onboardings o WHERE ${where.join(' AND ')} ORDER BY o.updated_at DESC LIMIT 500`, params);
    const states = await formStates(req.user.organization_id, rows);
    const [counts] = await pool.query(`SELECT status, COUNT(*) n FROM onboardings WHERE organization_id = ?${isHr(req) ? '' : ' AND created_by_id = ?'} GROUP BY status`, [req.user.organization_id].concat(isHr(req) ? [] : [req.user.id]));
    res.json({
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      onboardings: rows.map((r) => {
        const data = parse(r.data, {});
        return {
          id: r.id, workerType: r.worker_type, status: r.status, consultantName: r.consultant_name,
          startDate: dateStr(r.start_date), endClient: data.end_client || '', recruiter: data.recruiter || '',
          progress: progress(checklistView(r, data, parse(r.checklist, {}), states)), updatedAt: r.updated_at,
        };
      }),
    });
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!TYPES.includes(body.workerType)) return res.status(400).json({ error: 'Choose how the person is engaged: W2, C2C or 1099.' });
    const { data, errors } = clean(body.data || {}, {});
    if (errors.length) return res.status(400).json({ error: errors[0].message, errors });
    if (!data.consultant_name) return res.status(400).json({ error: 'Consultant name is required.' });
    const row = { organization_id: req.user.organization_id, log: '[]' };
    addLog(row, req, 'Created as a draft.');
    const [r] = await pool.query(
      `INSERT INTO onboardings (organization_id, worker_type, status, consultant_name, start_date, data, checklist, log, created_by, created_by_id) VALUES (?, ?, 'draft', ?, ?, ?, '{}', ?, ?, ?)`,
      [req.user.organization_id, body.workerType, data.consultant_name, data.start_date || null, JSON.stringify(data), row.log, who(req), req.user.id]);
    const [rows] = await pool.query(`SELECT * FROM onboardings WHERE id = ?`, [r.insertId]);
    res.status(201).json(await present(rows[0], { directoryMatch: await directoryMatch(req.user.organization_id, data.consultant_name) }, req));
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await load(req, res); if (!row) return;
    res.json(await present(row, { directoryMatch: await directoryMatch(row.organization_id, row.consultant_name), allowedNext: NEXT[row.status] }, req));
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const row = await load(req, res); if (!row) return;
    if (row.status === 'complete') return res.status(409).json({ error: 'This onboarding is complete. An HR admin must reopen it before the placement can change.' });
    if (!isHr(req) && row.status !== 'draft') return res.status(403).json({ error: 'This request is with HR. Withdraw it first if you need to change it, or ask the HR admin to edit it.' });
    const body = req.body || {};
    let type = row.worker_type;
    if (body.workerType !== undefined) {
      if (!TYPES.includes(body.workerType)) return res.status(400).json({ error: 'Worker type must be W2, C2C or 1099.' });
      type = body.workerType;
    }
    const old = parse(row.data, {});
    const input = Object.assign({}, body.data || {});
    if (!isHr(req)) SENSITIVE.forEach((k) => { if (input[k] === '' || input[k] === null) delete input[k]; }); // a recruiter cannot see or clear these, only replace them
    const { data, errors } = clean(input, old);
    if (errors.length) return res.status(400).json({ error: errors[0].message, errors });
    if (!data.consultant_name) return res.status(400).json({ error: 'Consultant name is required.' });
    const changed = Object.keys(data).filter((k) => k !== '_meta' && String(data[k]) !== String(old[k] === undefined ? '' : old[k]))
      .concat(Object.keys(old).filter((k) => k !== '_meta' && data[k] === undefined));
    if (type !== row.worker_type) changed.unshift('worker type');
    if (row.status !== 'draft' && changed.length) {
      const bits = changed.slice(0, 8).map((k) => {
        const lab = k === 'worker type' ? k : (FIELD_BY_KEY[k] || {}).label || k;
        return k === 'worker type' ? `worker type ${row.worker_type} → ${type}` : SENSITIVE.includes(k) ? `${lab}: changed` : `${lab}: ${old[k] === undefined ? '(blank)' : old[k]} → ${data[k] === undefined ? '(blank)' : data[k]}`;
      });
      addLog(row, req, (isHr(req) && row.created_by_id !== req.user.id ? 'Edited by HR: ' : 'Placement edited after it was sent: ') + bits.join('; '));
    }
    await save(row, { worker_type: type, consultant_name: data.consultant_name, start_date: data.start_date || null, data: JSON.stringify(data), log: row.log });
    const [rows] = await pool.query(`SELECT * FROM onboardings WHERE id = ?`, [row.id]);
    res.json(await present(rows[0], { directoryMatch: await directoryMatch(row.organization_id, data.consultant_name), allowedNext: NEXT[rows[0].status] }, req));
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const row = await load(req, res); if (!row) return;
    if (!isHr(req) && row.status !== 'draft') return res.status(403).json({ error: 'You can only delete your own drafts.' });
    if (!['draft', 'cancelled'].includes(row.status)) return res.status(409).json({ error: 'Only a draft or cancelled onboarding can be deleted. Cancel it first.' });
    await pool.query(`DELETE FROM onboardings WHERE id = ? AND organization_id = ?`, [row.id, row.organization_id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/checklist', async (req, res, next) => {
  try {
    if (!isHr(req)) return denyHr(res);
    const row = await load(req, res); if (!row) return;
    if (row.status === 'complete' || row.status === 'cancelled') return res.status(409).json({ error: 'Reopen this onboarding before changing the checklist.' });
    if (row.status === 'submitted') return res.status(409).json({ error: 'Approve the request (Start onboarding) before working the checklist.' });
    const b = req.body || {};
    const data = parse(row.data, {});
    const def = spec.checklistFor(row.worker_type, data).find((c) => c.key === b.key);
    if (!def) return res.status(404).json({ error: 'That checklist item does not apply.' });
    const stored = parse(row.checklist, {});
    const cur = Object.assign({}, stored[def.key]);
    const bits = [];
    if (b.done !== undefined) { cur.done = !!b.done; if (cur.done) { cur.na = false; cur.at = new Date().toISOString(); cur.by = who(req); } bits.push(cur.done ? 'done' : 'reopened'); }
    if (b.na !== undefined) { cur.na = !!b.na; if (cur.na) { cur.done = false; cur.at = new Date().toISOString(); cur.by = who(req); } bits.push(cur.na ? 'not applicable' : 'applicable again'); }
    if (b.note !== undefined) { cur.note = String(b.note || '').slice(0, 500); bits.push('note updated'); }
    stored[def.key] = cur;
    addLog(row, req, `${def.label}: ${bits.join(', ')}.`);
    const f = { checklist: JSON.stringify(stored), log: row.log };
    if (row.status === 'draft') { f.status = 'in_progress'; }
    await save(row, f);
    const [rows] = await pool.query(`SELECT * FROM onboardings WHERE id = ?`, [row.id]);
    res.json(await present(rows[0], { allowedNext: NEXT[rows[0].status] }, req));
  } catch (err) { next(err); }
});

router.post('/:id/status', async (req, res, next) => {
  try {
    const row = await load(req, res); if (!row) return;
    const to = req.body && req.body.status;
    if (!isHr(req)) {
      const ok = (row.status === 'draft' && ['submitted', 'cancelled'].includes(to)) || (row.status === 'submitted' && to === 'draft');
      if (!ok) return res.status(403).json({ error: 'Only an HR admin can do that. You can send a draft to HR, or withdraw a request that is still waiting.' });
    }
    if (row.status === 'submitted' && to === 'draft' && isHr(req) && !(req.body && String(req.body.reason || '').trim())) return res.status(422).json({ error: 'Say what the recruiter should fix, so they know why it came back.' });
    if (!STATUSES.includes(to) || !NEXT[row.status].includes(to)) return res.status(409).json({ error: `An onboarding that is ${row.status.replace('_', ' ')} cannot move to ${String(to).replace('_', ' ')}.` });
    const data = parse(row.data, {});
    const f = { status: to };
    if (['submitted', 'in_progress'].includes(to) && row.status === 'draft') {
      const miss = missingRequired(row.worker_type, data);
      if (miss.length) return res.status(422).json({ error: 'Fill in these before sending: ' + miss.join(', ') + '.', missing: miss });
    }
    if (to === 'submitted') f.submitted_at = new Date();
    if (to === 'complete') {
      const states = await formStates(row.organization_id, [row]);
      const open = checklistView(row, data, parse(row.checklist, {}), states).filter((i) => !i.na && !i.done).map((i) => i.label);
      if (open.length) return res.status(422).json({ error: `${open.length} checklist item${open.length > 1 ? 's are' : ' is'} still open (mark done or not applicable): ` + open.join('; ') + '.', open });
      f.completed_at = new Date();
    }
    if (row.status === 'complete') f.completed_at = null;
    const reason = req.body && req.body.reason ? ` Reason: ${String(req.body.reason).slice(0, 300)}` : '';
    const label = { draft: row.status === 'cancelled' ? 'Restored as a draft' : (isHr(req) ? 'Returned to the recruiter for changes' : 'Withdrawn by the recruiter'), submitted: 'Sent to HR for approval', in_progress: row.status === 'complete' ? 'Reopened' : row.status === 'submitted' ? 'Approved by HR; onboarding started' : 'HR started onboarding', complete: 'Marked complete', cancelled: 'Cancelled' }[to];
    addLog(row, req, label + '.' + reason);
    f.log = row.log;
    await save(row, f);
    const [rows] = await pool.query(`SELECT * FROM onboardings WHERE id = ?`, [row.id]);
    res.json(await present(rows[0], { allowedNext: NEXT[rows[0].status] }, req));
  } catch (err) { next(err); }
});

router.get('/:id/email', async (req, res, next) => {
  try {
    const row = await load(req, res); if (!row) return;
    res.json({ text: spec.buildEmail(row.worker_type, isHr(req) ? parse(row.data, {}) : withoutMoney(parse(row.data, {}))) });
  } catch (err) { next(err); }
});

// ----------------------------------------------------- directory records
async function mergeProfile(conn, orgId, entity, id, patch) {
  const [r] = await conn.query(`SELECT data FROM record_profiles WHERE organization_id = ? AND entity = ? AND record_id = ?`, [orgId, entity, id]);
  const cur = parse(r[0] && r[0].data, {});
  Object.entries(patch).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') cur[k] = String(v); });
  await conn.query(
    `INSERT INTO record_profiles (organization_id, entity, record_id, data) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [orgId, entity, id, JSON.stringify(cur)]);
}
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 255);

router.post('/:id/create-records', async (req, res, next) => {
  let conn;
  try {
    if (!isHr(req)) return denyHr(res);
    const row = await load(req, res); if (!row) return;
    if (row.status === 'complete' || row.status === 'cancelled') return res.status(409).json({ error: 'Reopen this onboarding first.' });
    if (row.status === 'submitted') return res.status(409).json({ error: 'Approve the request (Start onboarding) before creating directory records.' });
    const data = parse(row.data, {});
    const orgId = row.organization_id;
    const sp = data.end_client ? splitClientText(data.end_client) : {};
    const split = { client: sp.clientName || '', program: sp.programName || '' };
    const clientName = oneLine(req.body && req.body.clientName !== undefined ? req.body.clientName : split.client);
    let vendorName = oneLine(req.body && req.body.vendorName !== undefined ? req.body.vendorName : split.program);
    if (vendorName && vendorName.toLowerCase() === clientName.toLowerCase()) vendorName = '';
    if (!clientName) return res.status(422).json({ error: 'Fill in the end client first (or type the client name).' });
    if (!data.consultant_name) return res.status(422).json({ error: 'Consultant name is required.' });

    conn = await pool.getConnection();
    await conn.beginTransaction();
    const made = [];
    const find = async (sql, params) => (await conn.query(sql, params))[0][0];

    // Consultant
    const addrParts = [data.address, [data.city, data.state, data.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    let cons = await find(`SELECT id, email, phone, address FROM consultants WHERE organization_id = ? AND LOWER(name) = LOWER(?)`, [orgId, data.consultant_name]);
    let consultantId;
    if (cons) {
      consultantId = cons.id;
      await conn.query(`UPDATE consultants SET status = 'active', email = COALESCE(NULLIF(email, ''), ?), phone = COALESCE(NULLIF(phone, ''), ?), address = COALESCE(NULLIF(address, ''), ?) WHERE id = ?`,
        [data.email || null, data.phone || null, addrParts || null, consultantId]);
      made.push('linked the existing consultant');
    } else {
      const [r] = await conn.query(`INSERT INTO consultants (organization_id, name, status, email, phone, address) VALUES (?, ?, 'active', ?, ?, ?)`,
        [orgId, data.consultant_name, data.email || null, data.phone || null, addrParts || null]);
      consultantId = r.insertId; made.push('created the consultant');
    }

    // Supplier company (the consultant's own company, C2C)
    let supplierId = null;
    if (row.worker_type === 'C2C' && data.employer_name) {
      const eAddr = [data.employer_address, [data.employer_city, data.employer_state, data.employer_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      const sup = await find(`SELECT id FROM subvendors WHERE organization_id = ? AND LOWER(name) = LOWER(?)`, [orgId, data.employer_name]);
      if (sup) {
        supplierId = sup.id;
        await conn.query(`UPDATE subvendors SET status = 'active', email = COALESCE(NULLIF(email, ''), ?), phone = COALESCE(NULLIF(phone, ''), ?), address = COALESCE(NULLIF(address, ''), ?) WHERE id = ?`,
          [data.employer_email || null, data.employer_phone || null, eAddr || null, supplierId]);
        made.push('linked the supplier company');
      } else {
        const [r] = await conn.query(`INSERT INTO subvendors (organization_id, name, status, email, phone, address) VALUES (?, ?, 'active', ?, ?, ?)`,
          [orgId, data.employer_name, data.employer_email || null, data.employer_phone || null, eAddr || null]);
        supplierId = r.insertId; made.push('created the supplier company');
      }
      await mergeProfile(conn, orgId, 'subvendors', supplierId, {
        contact_name: data.employer_contact, city: data.employer_city, state: data.employer_state, postal_code: data.employer_zip,
      });
    }

    // Client, vendor, billing pairing
    let client = await find(`SELECT id FROM clients WHERE organization_id = ? AND LOWER(name) = LOWER(?)`, [orgId, clientName]);
    let clientId;
    if (client) clientId = client.id;
    else { const [r] = await conn.query(`INSERT INTO clients (organization_id, name, status) VALUES (?, ?, 'active')`, [orgId, clientName]); clientId = r.insertId; made.push('created the client'); }
    let programId = null;
    if (vendorName) {
      const pr = await find(`SELECT id FROM programs WHERE client_id = ? AND LOWER(name) = LOWER(?)`, [clientId, vendorName]);
      if (pr) programId = pr.id;
      else { const [r] = await conn.query(`INSERT INTO programs (organization_id, client_id, name, status) VALUES (?, ?, ?, 'active')`, [orgId, clientId, vendorName]); programId = r.insertId; made.push('created the vendor'); }
    }
    const billing = data.bill_rate !== undefined ? data.bill_rate : null;
    const asg = await find(`SELECT id FROM consultant_assignments WHERE organization_id = ? AND consultant_id = ? AND client_id = ? AND program_id <=> ?`, [orgId, consultantId, clientId, programId]);
    let assignmentId;
    if (asg) { assignmentId = asg.id; await conn.query(`UPDATE consultant_assignments SET billing = ?, status = 'active', left_date = NULL WHERE id = ?`, [billing, assignmentId]); made.push('updated the billing pairing'); }
    else {
      const [r] = await conn.query(`INSERT INTO consultant_assignments (organization_id, consultant_id, client_id, program_id, billing, source) VALUES (?, ?, ?, ?, ?, 'manual')`,
        [orgId, consultantId, clientId, programId, billing]);
      assignmentId = r.insertId; made.push('added the billing pairing');
    }

    // Profile details
    await mergeProfile(conn, orgId, 'consultants', consultantId, {
      worker_type: PROFILE_TYPE[row.worker_type], hire_date: data.start_date, job_title: data.job_title || data.technical_skill,
      skills: data.technical_skill, pay_rate: data.pay_rate, pay_rate_type: data.pay_rate_basis, recruiter: data.recruiter,
      work_authorization: data.work_authorization, supplier_id: supplierId, city: data.city, state: data.state, postal_code: data.zip,
      preferred_location: data.location, payment_terms: data.payment_terms,
    });

    data._meta = Object.assign({}, data._meta, { assignmentId, clientId, programId, createdAt: new Date().toISOString() });
    addLog(row, req, `Directory records: ${made.join(', ')} (client “${clientName}”${vendorName ? `, vendor “${vendorName}”` : ''}, billing rate ${billing === null ? 'not set' : 'set'}).`);
    await conn.query(`UPDATE onboardings SET consultant_id = ?, supplier_id = ?, data = ?, log = ?${row.status === 'draft' ? `, status = 'in_progress'` : ''} WHERE id = ? AND organization_id = ?`,
      [consultantId, supplierId, JSON.stringify(data), row.log, row.id, orgId]);
    await conn.commit();
    const [rows] = await pool.query(`SELECT * FROM onboardings WHERE id = ?`, [row.id]);
    res.json(await present(rows[0], { allowedNext: NEXT[rows[0].status], made }, req));
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch (e) { /* ignore */ } }
    if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG });
    if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A record with that name already exists in a different form. Check the Directory for near-duplicates and try again.' });
    next(err);
  } finally { if (conn) conn.release(); }
});

module.exports = router;
