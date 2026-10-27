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
const mailer = require('../mailer');
const spec = require('./onboardingSpec');
const { isConfigured, encryptBuffer, decryptBuffer } = require('../crypto');
const crypto = require('crypto');
const vendorItems = require('./vendorItems');
const { flagLikelyDuplicates, similarity, SIMILARITY_THRESHOLD } = require('./directoryDedup');
const flagNew = (conn, orgId, tableName, id, name, scopeClientId) => flagLikelyDuplicates(conn, { organizationId: orgId, tableName, newId: id, newName: name, scopeClientId }).catch(() => {});

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
const { EMPLOYMENT_BY_WORKER } = require('../placementRules');
const PROFILE_TYPE = { W2: 'W2', C2C: 'Subvendor', '1099': '1099' };
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
// Checklist documents: PDF / JPG / PNG / DOCX up to 10 MB, encrypted in the database.
const DOC_MAX = 10 * 1024 * 1024;
const DOC_TYPES = {
  pdf: { mime: 'application/pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  jpg: { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { mime: 'image/png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
};
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

function checklistView(row, data, storedRaw, states, docs) {
  const meta = data._meta || {};
  const stored = spec.migrateChecklist(storedRaw);
  const docsFor = (k) => (docs || []).filter((d) => d.onboarding_id === row.id && d.item_key === k).map((d) => ({
    id: d.id, filename: d.filename, mime: d.mime, size: d.size, uploadedBy: d.uploaded_by, uploadedAt: d.uploaded_at,
  }));
  return spec.checklistFor(row.worker_type, data).map((c) => {
    const st = stored[c.key] || {};
    const out = { key: c.key, label: c.label, group: c.group, hint: c.hint || null, optional: !!c.optional, manualDone: !!st.done, na: !!st.na, note: st.note || '', at: st.at || null, by: st.by || null };
    if (c.future) out.future = c.future;
    if (c.upload) { out.upload = c.upload; out.documents = docsFor(c.key); }
    else if (c.uploadInstead) { out.upload = 'instead'; out.documents = docsFor(c.key); }
    if (c.answer) {
      out.answer = c.answer;
      // before Yes/No existed, ticking the item meant "yes"
      out.value = st.answer === 'Yes' || st.answer === 'No' ? st.answer : (st.done ? 'Yes' : null);
    }
    if (c.form) {
      const entity = c.on === 'supplier' ? 'subvendors' : 'consultants';
      const rid = c.on === 'supplier' ? row.supplier_id : row.consultant_id;
      out.form = { form: c.form, entity, recordId: rid || null, title: FORMS[c.form].title, status: rid ? (states.get(`${entity}:${rid}:${c.form}`) || 'not started') : null };
      out.autoDone = out.form.status === 'complete';
      if (c.formOnly) { out.formOnly = true; out.legacyDone = !!st.done && !out.autoDone; }
    } else if (c.auto === 'records') {
      out.autoDone = !!(row.consultant_id && meta.assignmentId && (row.worker_type !== 'C2C' || !vendorOf(row.worker_type, Object.assign({ consultant_name: row.consultant_name }, data)) || row.supplier_id));
    }
    if (c.uploadInstead) out.viaUpload = out.documents.length > 0 && !(out.form && out.form.status === 'complete');
    if (c.answer) out.done = !out.na && !!out.value;
    else if (c.formOnly) out.done = !out.na && (!!out.autoDone || !!st.done || !!(c.uploadInstead && out.documents.length)); // st.done only from before the form existed
    else if (c.upload === 'required') {
      out.legacyDone = !!st.done && !out.documents.length; // ticked by hand before uploads existed: still counts
      out.done = !out.na && (out.documents.length > 0 || !!st.done);
    } else out.done = !out.na && (out.manualDone || !!out.autoDone || !!(c.uploadInstead && out.documents.length));
    return out;
  });
}
const progress = (items) => { const live = items.filter((i) => !i.na && !i.optional); return { done: live.filter((i) => i.done).length, total: live.length }; };

async function docList(orgId, ids) {
  if (!ids.length) return [];
  try {
    const [r] = await pool.query(`SELECT id, onboarding_id, item_key, filename, mime, size, uploaded_by, uploaded_at FROM onboarding_documents WHERE organization_id = ? AND onboarding_id IN (?) ORDER BY id`, [orgId, ids]);
    return r;
  } catch (e) { if (missingTable(e)) return []; throw e; }
}

// ----------------------------------------------------------------- serialise
async function present(row, extra, req) {
  const full = parse(row.data, {});
  const hide = !!req && !isHr(req);
  const data = hide ? withoutMoney(full) : full;
  const stored = parse(row.checklist, {});
  const states = await formStates(row.organization_id, [row]);
  const items = checklistView(row, data, stored, states, await docList(row.organization_id, [row.id]));
  // Recruiters never see the banking form: no link, no status, no record id (the forms API refuses them too).
  if (req && req.user.role === 'recruiter') items.forEach((i) => { if (i.form && i.form.form === 'banking') { delete i.form; delete i.autoDone; i.hint = 'Handled by HR.'; } });
  const pub = Object.assign({}, data); delete pub._meta;
  return Object.assign({
    id: row.id, workerType: row.worker_type, status: row.status, consultantName: row.consultant_name,
    startDate: dateStr(row.start_date),
    consultantId: row.consultant_id, supplierId: row.supplier_id, data: pub, meta: data._meta || {},
    checklist: items, progress: progress(items), margin: hide ? null : margin(data), warnings: warningsFor(row.worker_type, data),
    hiddenFields: hide ? Object.fromEntries(SENSITIVE.filter((k) => full[k] !== undefined).map((k) => [k, true])) : {},
    vendorCheck: hide ? undefined : await vendorCheck(row, full),
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
// Personal invites (email set): one person, one use, the role chosen when sending. The owner can
// invite any role; an HR admin can invite Recruiters and Team members (not other HR admins).
const canInvite = (req, role) => req.user.role === 'owner' || (req.user.role === 'hr' && ['recruiter', 'member'].includes(role));
const inviteLink = (req, code, email) => `${req.protocol}://${req.get('host')}/signup.html?code=${encodeURIComponent(code)}${email ? '&email=' + encodeURIComponent(email) : ''}`;
router.get('/invites', async (req, res, next) => {
  try {
    if (!isHr(req)) return res.status(403).json({ error: 'Only the owner or an HR admin can manage invites.' });
    const owner = req.user.role === 'owner';
    const [rows] = await pool.query(
      `SELECT i.id, i.code, i.role, i.label, i.email, i.invitee_name, i.revoked, i.used_at, i.revoked_at, i.created_at, u.name AS used_by_name
       FROM invite_codes i LEFT JOIN users u ON u.id = i.used_by_user_id WHERE i.organization_id = ? ORDER BY i.id DESC LIMIT 300`, [req.user.organization_id]);
    const status = (r) => (r.used_at ? 'used' : r.revoked ? 'revoked' : 'pending');
    res.json({
      invites: owner ? rows.filter((r) => !r.email && !r.revoked) : [],
      personal: rows.filter((r) => r.email).map((r) => ({
        id: r.id, email: r.email, name: r.invitee_name, role: r.role, status: status(r), createdAt: r.created_at, usedAt: r.used_at, usedBy: r.used_by_name, revokedAt: r.revoked_at,
        link: status(r) === 'pending' ? inviteLink(req, r.code, r.email) : null,
      })),
      legacyCode: owner ? req.user.invite_code : null,
      canInviteRoles: owner ? ['hr', 'member', 'recruiter'] : ['member', 'recruiter'],
      emailSending: await mailer.available(req.user), // false: no mail server is configured; share the link (copy or open in your email app)
    });
  } catch (err) { if (missingTable(err) || (err && err.code === 'ER_BAD_FIELD_ERROR')) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});
// Owner/HR: send a test email to the signed-in user to check that mail delivery works.
router.post('/email-test', async (req, res) => {
  if (!isHr(req)) return denyHr(res);
  if (!(await mailer.available(req.user))) return res.status(503).json({ error: 'Email sending is not set up yet. Connect your mailbox under “My email” (left menu), or set the company mailbox on the server.' });
  const r = await mailer.send({ to: req.user.email, subject: 'Mentour Suite test email', text: 'This is a test from Mentour Suite. If you can read this, onboarding emails will be delivered.', sender: { id: req.user.id, name: req.user.name, email: req.user.email } });
  if (!r.sent) return res.status(502).json({ error: r.error });
  res.json({ ok: true, to: req.user.email });
});
router.post('/invites', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!['hr', 'member', 'recruiter'].includes(b.role)) return res.status(400).json({ error: 'Choose a role for this invite.' });
    const code = require('crypto').randomBytes(b.email !== undefined ? 12 : 6).toString('hex');
    if (b.email === undefined) { // the original shared role code (owner only)
      if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the account owner can create invite codes.' });
      await pool.query('INSERT INTO invite_codes (organization_id, code, role, label) VALUES (?, ?, ?, ?)', [req.user.organization_id, code, b.role, b.label ? String(b.label).trim().slice(0, 120) : null]);
      return res.status(201).json({ code, role: b.role });
    }
    if (!isHr(req)) return res.status(403).json({ error: 'Only the owner or an HR admin can invite people.' });
    if (!canInvite(req, b.role)) return res.status(403).json({ error: 'Only the account owner can invite an HR admin.' });
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 255) return res.status(400).json({ error: 'Enter a valid email address.' });
    const name = b.name ? String(b.name).trim().slice(0, 255) : null;
    const [dup] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (dup.length) return res.status(409).json({ error: 'That email already has a login.' });
    // a fresh invite replaces any still-pending one for the same email
    await pool.query('UPDATE invite_codes SET revoked = 1, revoked_at = NOW() WHERE organization_id = ? AND email = ? AND used_at IS NULL AND revoked = 0', [req.user.organization_id, email]);
    await pool.query('INSERT INTO invite_codes (organization_id, code, role, label, email, invitee_name, created_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.user.organization_id, code, b.role, name, email, name, req.user.id]);
    const link = inviteLink(req, code, email);
    let mail = { attempted: false };
    if ((await mailer.available(req.user)) && b.sendEmail !== false) {
      const r = await mailer.send({
        to: email, sender: { id: req.user.id, name: req.user.name, email: req.user.email }, subject: 'Your Mentour Suite invite',
        text: `Hi${name ? ' ' + name : ''},\n\nYou have been invited to Mentour Suite as ${b.role === 'hr' ? 'an HR admin' : b.role === 'recruiter' ? 'a recruiter (Onboarding only)' : 'a team member'}. Create your login here (use this email address):\n\n${link}\n\nThe link works once.\n\n${req.user.name || req.user.email}`,
      });
      mail = { attempted: true, sent: r.sent, error: r.error || null };
    }
    res.status(201).json({ code, role: b.role, email, link, emailSending: await mailer.available(req.user), emailSent: !!mail.sent, emailError: mail.error || null });
  } catch (err) { if (missingTable(err) || (err && err.code === 'ER_BAD_FIELD_ERROR')) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});
router.delete('/invites/:id', async (req, res, next) => {
  try {
    if (!isHr(req)) return res.status(403).json({ error: 'Only the account owner can revoke invite codes.' });
    const [r] = await pool.query('SELECT id, role, email, used_at FROM invite_codes WHERE id = ? AND organization_id = ?', [req.params.id, req.user.organization_id]);
    if (!r[0]) return res.status(404).json({ error: 'Invite not found.' });
    if (req.user.role !== 'owner' && (!r[0].email || !canInvite(req, r[0].role))) return res.status(403).json({ error: 'Only the account owner can revoke that invite.' });
    if (r[0].used_at) return res.status(409).json({ error: 'That invite has already been used.' });
    await pool.query('UPDATE invite_codes SET revoked = 1, revoked_at = NOW() WHERE id = ? AND organization_id = ?', [r[0].id, req.user.organization_id]);
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

router.get('/schema', async (req, res) => {
  res.json({
    emailConfigured: await mailer.available(req.user),
    workerTypes: spec.WORKER_TYPES, statuses: STATUSES, next: NEXT,
    sections: spec.SECTIONS.map((s) => ({ key: s.key, title: s.title, types: s.types || null, fields: s.fields })),
    checklists: Object.fromEntries(Object.entries(spec.CHECKLISTS).map(([t, l]) => [t, l.map((c) => ({ key: c.key, label: c.label, group: c.group, when: c.when || null, answer: c.answer || null, upload: c.upload || null, optional: !!c.optional, form: c.form || null }))])),
    documents: { maxBytes: DOC_MAX, types: Object.keys(DOC_TYPES) },
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
    const docs = await docList(req.user.organization_id, rows.map((r) => r.id));
    const [counts] = await pool.query(`SELECT status, COUNT(*) n FROM onboardings WHERE organization_id = ?${isHr(req) ? '' : ' AND created_by_id = ?'} GROUP BY status`, [req.user.organization_id].concat(isHr(req) ? [] : [req.user.id]));
    const names = isHr(req) ? await supplierNames(req.user.organization_id) : null;
    res.json({
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      onboardings: rows.map((r) => {
        const data = parse(r.data, {});
        return {
          id: r.id, workerType: r.worker_type, status: r.status, consultantName: r.consultant_name,
          startDate: dateStr(r.start_date), endClient: data.end_client || '', recruiter: data.recruiter || '',
          progress: progress(checklistView(r, data, parse(r.checklist, {}), states, docs)), updatedAt: r.updated_at,
          vendorFlag: (() => { const vn = names && r.worker_type === 'C2C' && ['submitted', 'in_progress'].includes(r.status) ? vendorOf('C2C', Object.assign({ consultant_name: r.consultant_name }, data)) : ''; if (!vn || names.some((x) => x.id === r.supplier_id || (x.key && x.key === normCompany(vn)))) return null; return names.some((x) => similarity(vn, x.name) >= SIMILARITY_THRESHOLD) ? 'similar' : 'new'; })(),
          newVendor: !!(names && r.worker_type === 'C2C' && ['submitted', 'in_progress'].includes(r.status) && vendorOf('C2C', Object.assign({ consultant_name: r.consultant_name }, data)) && r.status !== 'complete' && !names.some((x) => x.id === r.supplier_id || (x.key && x.key === normCompany(vendorOf('C2C', Object.assign({ consultant_name: r.consultant_name }, data)))))),
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
    const stored = spec.migrateChecklist(parse(row.checklist, {}));
    const cur = Object.assign({}, stored[def.key]);
    const bits = [];
    if (b.answer !== undefined) {
      if (!def.answer) return res.status(400).json({ error: 'That item has no Yes / No answer.' });
      if (b.answer !== null && b.answer !== 'Yes' && b.answer !== 'No') return res.status(400).json({ error: 'Choose Yes or No.' });
      if (b.answer === null) { delete cur.answer; cur.done = false; } else { cur.answer = b.answer; cur.na = false; cur.at = new Date().toISOString(); cur.by = who(req); }
      bits.push(b.answer === null ? 'answer cleared' : 'answered ' + b.answer);
    }
    if (b.done !== undefined && (def.answer || (b.done && (def.upload === 'required' || def.formOnly)))) {
      return res.status(400).json({ error: def.answer ? 'Choose Yes or No for this item.' : def.formOnly ? `Fill in and sign the ${FORMS[def.form].title} form to complete this item.` : 'Upload the document to complete this item.' });
    }
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
      const open = checklistView(row, data, parse(row.checklist, {}), states, await docList(row.organization_id, [row.id])).filter((i) => !i.na && !i.done && !i.optional)
        .map((i) => i.label + (i.answer ? ' (choose Yes or No)' : i.upload === 'required' ? ' (upload the document)' : ''));
      if (open.length) return res.status(422).json({ error: `${open.length} required checklist item${open.length > 1 ? 's are' : ' is'} still open (complete them or mark not applicable): ` + open.join('; ') + '.', open });
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


// ------------------------------------------------------- checklist documents
// Upload (or replace) the document for one checklist item. Body: { itemKey, filename, contentBase64, replace }.
router.post('/:id/documents', async (req, res, next) => {
  try {
    if (!isHr(req)) return denyHr(res);
    const row = await load(req, res); if (!row) return;
    if (row.status === 'complete' || row.status === 'cancelled') return res.status(409).json({ error: 'Reopen this onboarding before changing its documents.' });
    const b = req.body || {};
    const def = spec.checklistFor(row.worker_type, parse(row.data, {})).find((c) => c.key === b.itemKey);
    if (!def || !(def.upload || def.uploadInstead)) return res.status(404).json({ error: 'That checklist item does not take a document.' });
    const filename = String(b.filename || '').replace(/[\\/\r\n"]/g, '_').trim().slice(0, 200);
    const ext = (/\.([a-z0-9]+)$/i.exec(filename) || [])[1];
    const t = ext && DOC_TYPES[ext.toLowerCase()];
    if (!t) return res.status(415).json({ error: 'Upload a PDF, JPG, PNG or Word (.docx) file.' });
    if (typeof b.contentBase64 !== 'string' || !b.contentBase64) return res.status(400).json({ error: 'Choose a file to upload.' });
    if (b.contentBase64.length > Math.ceil(DOC_MAX / 3) * 4 + 8) return res.status(413).json({ error: 'That file is larger than 10 MB.' });
    const buf = Buffer.from(b.contentBase64, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'That file is empty.' });
    if (buf.length > DOC_MAX) return res.status(413).json({ error: 'That file is larger than 10 MB.' });
    if (!t.magic(buf)) return res.status(415).json({ error: `That file does not look like a real .${ext.toLowerCase()} file.` });
    if (!isConfigured()) return res.status(503).json({ error: 'Documents cannot be stored yet: the server has no encryption key (FIELD_ENCRYPTION_KEY). Nothing was saved.' });
    const content = encryptBuffer(buf);
    const [old] = await pool.query('SELECT id, filename FROM onboarding_documents WHERE organization_id = ? AND onboarding_id = ? AND item_key = ?', [row.organization_id, row.id, def.key]);
    if (old.length && !b.replace) return res.status(409).json({ error: 'This item already has a document. Choose Replace to swap it.', existing: old.map((o) => o.filename) });
    const [r] = await pool.query(
      'INSERT INTO onboarding_documents (organization_id, onboarding_id, item_key, filename, mime, size, content, uploaded_by, uploaded_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.organization_id, row.id, def.key, filename, t.mime, buf.length, content, who(req), req.user.id]);
    if (old.length) await pool.query('DELETE FROM onboarding_documents WHERE organization_id = ? AND onboarding_id = ? AND item_key = ? AND id <> ?', [row.organization_id, row.id, def.key, r.insertId]);
    addLog(row, req, `${def.label}: ${old.length ? 'document replaced' : 'document uploaded'} (${filename}, ${Math.max(1, Math.round(buf.length / 1024))} KB).`);
    const f = { log: row.log };
    if (row.status === 'draft') f.status = 'in_progress';
    await save(row, f);
    const [rows] = await pool.query('SELECT * FROM onboardings WHERE id = ?', [row.id]);
    res.status(201).json(await present(rows[0], { allowedNext: NEXT[rows[0].status], documentId: r.insertId }, req));
  } catch (err) {
    if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG });
    if (err && (err.code === 'ER_NET_PACKET_TOO_LARGE' || err.code === 'EPIPE')) return res.status(413).json({ error: 'The database refused a file that large. Try a smaller file.' });
    next(err);
  }
});

async function loadDoc(req, res, row) {
  if (!/^\d+$/.test(req.params.docId)) { res.status(404).json({ error: 'Document not found.' }); return null; }
  const [d] = await pool.query('SELECT * FROM onboarding_documents WHERE id = ? AND onboarding_id = ? AND organization_id = ?', [req.params.docId, row.id, row.organization_id]);
  if (!d[0]) { res.status(404).json({ error: 'Document not found.' }); return null; }
  return d[0];
}

// View / download. HR admins and the owner, plus the recruiter who created the request (load() enforces that).
router.get('/:id/documents/:docId', async (req, res, next) => {
  try {
    const row = await load(req, res); if (!row) return;
    const d = await loadDoc(req, res, row); if (!d) return;
    let buf;
    try { buf = decryptBuffer(d.content); } catch (e) { return res.status(503).json({ error: 'This document cannot be decrypted with the server’s current encryption key.' }); }
    const inline = req.query.download ? 'attachment' : 'inline';
    res.set({
      'Content-Type': d.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${inline}; filename="${d.filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(d.filename)}`,
    });
    res.end(buf);
  } catch (err) { if (missingTable(err)) return res.status(404).json({ error: 'Document not found.' }); next(err); }
});

router.delete('/:id/documents/:docId', async (req, res, next) => {
  try {
    if (!isHr(req)) return denyHr(res);
    const row = await load(req, res); if (!row) return;
    if (row.status === 'complete' || row.status === 'cancelled') return res.status(409).json({ error: 'Reopen this onboarding before changing its documents.' });
    const d = await loadDoc(req, res, row); if (!d) return;
    await pool.query('DELETE FROM onboarding_documents WHERE id = ?', [d.id]);
    const def = spec.checklistFor(row.worker_type, parse(row.data, {})).find((c) => c.key === d.item_key);
    addLog(row, req, `${def ? def.label : d.item_key}: document deleted (${d.filename}).`);
    await save(row, { log: row.log });
    const [rows] = await pool.query('SELECT * FROM onboardings WHERE id = ?', [row.id]);
    res.json(await present(rows[0], { allowedNext: NEXT[rows[0].status] }, req));
  } catch (err) { next(err); }
});


// ---- is the consultant's company a new vendor (or one without its paperwork)?
const normCompany = (n) => String(n || '').toLowerCase().replace(/[.,'’]/g, '').replace(/&/g, ' and ').replace(/\b(l\s?l\s?c|inc|incorporated|corp|corporation|co|company|ltd|limited|llp|lp|pllc|pc)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
// The vendor / company a C2C request pays: the consultant's company, or the "Pay to" name when that is a company.
const vendorOf = (type, d) => {
  if (type !== 'C2C' || !d) return '';
  if (d.employer_name) return String(d.employer_name).trim();
  const pt = String(d.pay_to || '').trim();
  return pt && normCompany(pt) !== normCompany(d.consultant_name) ? pt : '';
};
async function supplierNames(orgId) {
  const [r] = await pool.query('SELECT id, name FROM subvendors WHERE organization_id = ?', [orgId]);
  return r.map((x) => ({ id: x.id, name: x.name, key: normCompany(x.name) }));
}
async function vendorCheck(row, data, names) {
  const vname = vendorOf(row.worker_type, Object.assign({ consultant_name: row.consultant_name }, data));
  if (!vname || !['draft', 'submitted', 'in_progress'].includes(row.status)) return null;
  const key = normCompany(vname);
  const all = names || await supplierNames(row.organization_id);
  const hit = all.find((x) => x.id === row.supplier_id) || all.find((x) => x.key && x.key === key);
  const out = { name: vname, email: data.employer_email || '', state: 'new', supplierId: null, missing: [] };
  if (!hit) {
    out.suggest = ['company', 'w9', 'banking', 'coi', 'vendor_agreement'];
    // not an exact match, but is it probably an existing supplier written differently?
    const near = all.map((x) => ({ id: x.id, name: x.name, score: similarity(vname, x.name) })).filter((x) => x.score >= SIMILARITY_THRESHOLD).sort((a, b) => b.score - a.score).slice(0, 3);
    if (near.length) { out.state = 'similar'; out.candidates = near.map((x) => ({ id: x.id, name: x.name })); }
    return out;
  }
  out.supplierId = hit.id; out.supplierName = hit.name;
  const [fr] = await pool.query(`SELECT form_type, signatures FROM record_forms WHERE organization_id = ? AND entity = 'subvendors' AND record_id = ? AND form_type IN ('w9','banking')`, [row.organization_id, hit.id]);
  const st = {}; fr.forEach((f) => { st[f.form_type] = forms.helpers.statusOf(f.form_type, true, parse(f.signatures, {})); });
  // a completed W-9 / banking form uploaded on this request counts as received
  const ups = await docList(row.organization_id, [row.id]);
  if (ups.some((d) => d.item_key === 'company_w9')) st.w9 = 'complete';
  if (ups.some((d) => d.item_key === 'remittance')) st.banking = 'complete';
  if (st.w9 !== 'complete') out.missing.push('w9');
  if (st.banking !== 'complete') out.missing.push('banking');
  if (!(await companyComplete(row.organization_id, hit.id))) out.missing.push('company');
  if (!out.missing.length) { out.state = 'ready'; return out; }
  out.state = 'incomplete'; out.suggest = out.missing.concat(['coi', 'vendor_agreement'].filter(() => false));
  return out;
}

// ------------------------------------------------- supplier requests (secure link)
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

// the supplier's company details are complete once a contact and a full address are on file
async function companyComplete(orgId, supplierId) {
  const [sv] = await pool.query('SELECT address FROM subvendors WHERE id = ? AND organization_id = ?', [supplierId, orgId]);
  const [pr] = await pool.query(`SELECT data FROM record_profiles WHERE organization_id = ? AND entity = 'subvendors' AND record_id = ?`, [orgId, supplierId]);
  const p = parse(pr[0] && pr[0].data, {});
  return !!(sv[0] && sv[0].address && p.contact_name && p.city && p.state);
}

// the consultant's own details are complete once an email or phone and a full address are on file
async function personComplete(orgId, consultantId) {
  const [c] = await pool.query('SELECT email, phone, address FROM consultants WHERE id = ? AND organization_id = ?', [consultantId, orgId]);
  return !!(c[0] && (c[0].email || c[0].phone) && c[0].address);
}

async function requestStatuses(row, items) {
  // what has come back so far for each requested item
  const out = {};
  const states = await formStates(row.organization_id, [row]);
  const docs = await docList(row.organization_id, [row.id]);
  for (const k of items) {
    const it = vendorItems.ITEMS[k];
    if (it.kind === 'company') out[k] = row.supplier_id && (await companyComplete(row.organization_id, row.supplier_id)) ? 'complete' : 'not started';
    else if (it.kind === 'person') out[k] = row.consultant_id && (await personComplete(row.organization_id, row.consultant_id)) ? 'complete' : 'not started';
    else if (it.kind === 'form' && it.party === 'consultant') {
      // the consultant is done once their own signature is on (HR adds the employer part of an I-9 later)
      const own = it.form === 'i9' ? 'employee' : 'payee';
      let st = 'not started';
      if (row.consultant_id) {
        const [fr] = await pool.query(`SELECT signatures FROM record_forms WHERE organization_id = ? AND entity = 'consultants' AND record_id = ? AND form_type = ?`, [row.organization_id, row.consultant_id, it.form]);
        if (fr[0]) st = parse(fr[0].signatures, {})[own] ? 'complete' : 'in progress';
      }
      out[k] = st;
    }
    else if (it.kind === 'form') {
      const rid = it.entity === 'consultants' ? row.consultant_id : row.supplier_id;
      out[k] = rid ? (states.get(`${it.entity}:${rid}:${it.form}`) || 'not started') : 'not started';
    }
    else out[k] = docs.some((d) => d.item_key === it.itemKey) ? 'received' : 'waiting';
  }
  return out;
}
const itemDone = (k, st) => st === 'complete' || st === 'received';

async function requestView(row, r) {
  const items = String(r.items || '').split(',').filter((k) => vendorItems.ITEMS[k]);
  const st = await requestStatuses(row, items);
  const now = Date.now();
  const expired = new Date(r.expires_at).getTime() < now;
  return {
    id: r.id, party: r.party || 'supplier', items: items.map((k) => ({ key: k, label: vendorItems.ITEMS[k].label, status: st[k], done: itemDone(k, st[k]) })),
    message: r.message || '', createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, lastOpenedAt: r.last_opened_at, submittedAt: r.submitted_at,
    state: r.revoked_at ? 'revoked' : expired ? 'expired' : 'open',
  };
}

router.get('/:id/vendor-requests', async (req, res, next) => {
  try {
    if (!isHr(req)) return denyHr(res);
    const row = await load(req, res); if (!row) return;
    const [rs] = await pool.query('SELECT * FROM vendor_requests WHERE organization_id = ? AND onboarding_id = ? ORDER BY id DESC', [row.organization_id, row.id]);
    const out = []; for (const r of rs) out.push(await requestView(row, r));
    const mk = (party) => vendorItems.keysFor(party, row.worker_type).map((k) => ({ key: k, label: vendorItems.ITEMS[k].label, help: vendorItems.ITEMS[k].help, checklistKey: vendorItems.ITEMS[k].checklistKey || null }));
    res.json({ requests: out, items: mk('supplier'), consultantItems: mk('consultant'), consultantEmail: parse(row.data, {}).email || '', emailConfigured: await mailer.available(req.user) });
  } catch (err) { if (missingTable(err)) return res.json({ requests: [], items: [], needsSchema: true }); next(err); }
});

router.post('/:id/vendor-requests', async (req, res, next) => {
  try {
    if (!isHr(req)) return denyHr(res);
    const row = await load(req, res); if (!row) return;
    const party = req.body && req.body.party === 'consultant' ? 'consultant' : 'supplier';
    if (party === 'supplier' && row.worker_type !== 'C2C') return res.status(409).json({ error: 'Supplier requests are for C2C onboardings (the consultant’s own company).' });
    if (party === 'consultant' && !['C2C', '1099'].includes(row.worker_type)) return res.status(409).json({ error: 'Consultant links are for C2C and 1099 onboardings.' });
    if (row.status !== 'in_progress' && row.status !== 'submitted') return res.status(409).json({ error: 'Send details requests only while the request is waiting for approval or in progress.' });
    const items = vendorItems.clean(req.body && req.body.items, party, row.worker_type);
    if (!items.length) return res.status(400).json({ error: 'Tick at least one item to request.' });
    if (!isConfigured() && items.some((k) => ['form', 'upload'].includes(vendorItems.ITEMS[k].kind))) {
      return res.status(503).json({ error: 'The server has no encryption key yet (FIELD_ENCRYPTION_KEY), so tax IDs, bank numbers or documents could not be saved. Set it first (see README-DEPLOY.md).' });
    }
    const days = Math.min(60, Math.max(1, Number(req.body && req.body.days) || 14));
    const message = String((req.body && req.body.message) || '').trim().slice(0, 1000);
    const data = parse(row.data, {});
    const emailIn = String((req.body && req.body.email) || '').trim();
    const emailKey = party === 'consultant' ? 'email' : 'employer_email';
    if (emailIn && !EMAIL_RE.test(emailIn)) return res.status(400).json({ error: `Enter a valid email address for the ${party}.` });
    if (emailIn && emailIn !== data[emailKey]) { data[emailKey] = emailIn; addLog(row, req, `${party === 'consultant' ? 'Consultant' : 'Supplier'} email set to ${emailIn}.`); await save(row, { data: JSON.stringify(data) }); }
    let supplierId = row.supplier_id; let consultantId = row.consultant_id || null;
    if (party === 'consultant') {
      if (!data.consultant_name) return res.status(422).json({ error: 'Fill in the consultant’s name on the request first.' });
      if (!consultantId) {
        const [ex] = await pool.query('SELECT id FROM consultants WHERE organization_id = ? AND LOWER(name) = LOWER(?)', [row.organization_id, oneLine(data.consultant_name)]);
        if (ex[0]) consultantId = ex[0].id;
        else {
          // listed as inactive until directory records are created or the consultant submits their details
          const [r] = await pool.query(`INSERT INTO consultants (organization_id, name, status, email, phone) VALUES (?, ?, 'inactive', ?, ?)`,
            [row.organization_id, oneLine(data.consultant_name), data.email || null, data.phone || null]);
          consultantId = r.insertId;
          await flagNew(pool, row.organization_id, 'consultants', consultantId, data.consultant_name);
        }
        row.consultant_id = consultantId;
      }
    } else if (!supplierId) {
      const vname = vendorOf(row.worker_type, Object.assign({ consultant_name: row.consultant_name }, data));
      if (!vname) return res.status(422).json({ error: 'Fill in the consultant’s company (candidate employer) on the request first.' });
      const [ex] = await pool.query('SELECT id FROM subvendors WHERE organization_id = ? AND LOWER(name) = LOWER(?)', [row.organization_id, vname]);
      if (ex[0]) supplierId = ex[0].id;
      else {
        // listed as inactive until the supplier submits their onboarding
        const [r] = await pool.query(`INSERT INTO subvendors (organization_id, name, status, email, phone) VALUES (?, ?, 'inactive', ?, ?)`,
          [row.organization_id, oneLine(vname), data.employer_email || null, data.employer_phone || null]);
        supplierId = r.insertId;
        await flagNew(pool, row.organization_id, 'subvendors', supplierId, vname);
      }
      row.supplier_id = supplierId;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + days * 86400000);
    const [ins] = await pool.query(
      'INSERT INTO vendor_requests (organization_id, onboarding_id, supplier_id, consultant_id, party, token_hash, items, message, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.organization_id, row.id, party === 'supplier' ? supplierId : null, party === 'consultant' ? consultantId : null, party, sha256(token), items.join(','), message || null, expires, who(req)]);
    addLog(row, req, `Requested from the ${party} (secure link, ${days} days): ${items.map((k) => vendorItems.ITEMS[k].label).join(', ')}.`);
    await save(row, party === 'consultant' ? { consultant_id: consultantId, log: row.log } : { supplier_id: supplierId, log: row.log });
    const [rs] = await pool.query('SELECT * FROM vendor_requests WHERE id = ?', [ins.insertId]);
    // email the link straight to the supplier / consultant when the server can send mail
    let mail = { attempted: false };
    const to = String(data[emailKey] || '').trim();
    const contact = party === 'consultant' ? row.consultant_name : data.employer_contact;
    if ((await mailer.available(req.user)) && to && EMAIL_RE.test(to) && !(req.body && req.body.sendEmail === false)) {
      const link = `${req.protocol}://${req.get('host')}/vendor.html?t=${token}`;
      const list = items.map((k) => '- ' + vendorItems.ITEMS[k].label).join('\n');
      const org = (await pool.query('SELECT name FROM organizations WHERE id = ?', [row.organization_id]))[0][0];
      const text = party === 'consultant'
        ? `Hello${contact ? ' ' + contact : ''},\n\nTo finish your onboarding with ${org ? org.name : 'us'}, please use this private link to fill in:\n${list}\n\n${link}\n\n${message ? message + '\n\n' : ''}The link works until ${expires.toISOString().slice(0, 10)}. No login is needed. Your tax ID and bank numbers are encrypted when saved.\n\nThank you,\n${req.user.name || req.user.email}`
        : `Hello${contact ? ' ' + contact : ''},\n\nTo finish onboarding ${row.consultant_name || 'your consultant'}, please use this private link to send us:\n${list}\n\n${link}\n\n${message ? message + '\n\n' : ''}The link works until ${expires.toISOString().slice(0, 10)}. No login is needed.\n\nThank you,\n${req.user.name || req.user.email}`;
      const r = await mailer.send({
        to, sender: { id: req.user.id, name: req.user.name, email: req.user.email },
        subject: party === 'consultant' ? 'Please complete your onboarding details' : `Documents needed to onboard ${row.consultant_name || 'your consultant'}`,
        text,
      });
      mail = { attempted: true, sent: r.sent, error: r.error || null, to, via: r.via || null, note: r.note || null };
      addLog(row, req, r.sent ? `Emailed the secure link to ${to}.` : `Could not email the secure link to ${to}: ${r.error}`);
      await save(row, { log: row.log });
    }
    res.status(201).json({
      email: mail, emailConfigured: await mailer.available(req.user), party, request: await requestView(row, rs[0]), path: '/vendor.html?t=' + token,
      supplierEmail: data[emailKey] || '', supplierContact: contact || '', company: party === 'consultant' ? row.consultant_name : vendorOf(row.worker_type, Object.assign({ consultant_name: row.consultant_name }, data)), consultant: row.consultant_name,
    });
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

// Add the request's vendor to the Directory now (without sending a link).
router.post('/:id/add-vendor', async (req, res, next) => {
  try {
    if (!isHr(req)) return denyHr(res);
    const row = await load(req, res); if (!row) return;
    const data = parse(row.data, {});
    const vname = vendorOf(row.worker_type, Object.assign({ consultant_name: row.consultant_name }, data));
    if (!vname) return res.status(422).json({ error: 'There is no vendor / company name on this request.' });
    const emailIn = String((req.body && req.body.email) || '').trim();
    if (emailIn && !EMAIL_RE.test(emailIn)) return res.status(400).json({ error: 'Enter a valid email address.' });
    let [ex] = await pool.query('SELECT id, name FROM subvendors WHERE organization_id = ? AND LOWER(name) = LOWER(?)', [row.organization_id, vname]);
    const useId = req.body && /^\d+$/.test(String(req.body.useSupplierId || '')) ? Number(req.body.useSupplierId) : null;
    if (useId) {
      [ex] = await pool.query('SELECT id, name FROM subvendors WHERE id = ? AND organization_id = ?', [useId, row.organization_id]);
      if (!ex[0]) return res.status(404).json({ error: 'That supplier company was not found.' });
    }
    let id = ex[0] && ex[0].id;
    if (!id) {
      const [r] = await pool.query(`INSERT INTO subvendors (organization_id, name, status, email, phone) VALUES (?, ?, 'active', ?, ?)`, [row.organization_id, oneLine(vname), emailIn || data.employer_email || null, data.employer_phone || null]);
      id = r.insertId;
      await flagNew(pool, row.organization_id, 'subvendors', id, vname);
    }
    if (emailIn) { data.employer_email = emailIn; }
    addLog(row, req, useId ? `Vendor “${vname}” matched to the existing supplier company “${ex[0].name}”.` : `Vendor “${vname}” ${ex[0] ? 'linked' : 'added to the Directory'}.`);
    await save(row, { supplier_id: id, data: JSON.stringify(data), log: row.log });
    const [rows] = await pool.query('SELECT * FROM onboardings WHERE id = ?', [row.id]);
    res.status(ex[0] ? 200 : 201).json(await present(rows[0], { allowedNext: NEXT[rows[0].status] }, req));
  } catch (err) { if (missingTable(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.delete('/:id/vendor-requests/:rid', async (req, res, next) => {
  try {
    if (!isHr(req)) return denyHr(res);
    const row = await load(req, res); if (!row) return;
    if (!/^\d+$/.test(req.params.rid)) return res.status(404).json({ error: 'Not found.' });
    const [r] = await pool.query('UPDATE vendor_requests SET revoked_at = NOW() WHERE id = ? AND onboarding_id = ? AND organization_id = ? AND revoked_at IS NULL', [req.params.rid, row.id, row.organization_id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'That request is not open.' });
    addLog(row, req, 'Supplier request link revoked.');
    await save(row, { log: row.log });
    res.json({ ok: true });
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
    // Supplier company rules: W2 none, Corp-to-Corp (C2C) required, 1099 optional.
    const supplierNameFor = row.worker_type === 'C2C' ? vendorOf('C2C', Object.assign({ consultant_name: row.consultant_name }, data))
      : row.worker_type === '1099' ? oneLine(data.employer_name) : '';
    if (row.worker_type === 'C2C' && !supplierNameFor) return res.status(422).json({ error: 'A Corp-to-Corp consultant needs a supplier company. Fill in the consultant’s company first.' });

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
      await flagNew(conn, orgId, 'consultants', consultantId, data.consultant_name);
    }

    // Supplier company (the consultant's own company, C2C)
    let supplierId = null;
    const vnameRec = supplierNameFor;
    if ((row.worker_type === 'C2C' || row.worker_type === '1099') && vnameRec) {
      const eAddr = [data.employer_address, [data.employer_city, data.employer_state, data.employer_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      const sup = await find(`SELECT id FROM subvendors WHERE organization_id = ? AND LOWER(name) = LOWER(?)`, [orgId, vnameRec]);
      if (sup) {
        supplierId = sup.id;
        await conn.query(`UPDATE subvendors SET status = 'active', email = COALESCE(NULLIF(email, ''), ?), phone = COALESCE(NULLIF(phone, ''), ?), address = COALESCE(NULLIF(address, ''), ?) WHERE id = ?`,
          [data.employer_email || null, data.employer_phone || null, eAddr || null, supplierId]);
        made.push('linked the supplier company');
      } else {
        const [r] = await conn.query(`INSERT INTO subvendors (organization_id, name, status, email, phone, address) VALUES (?, ?, 'active', ?, ?, ?)`,
          [orgId, vnameRec, data.employer_email || null, data.employer_phone || null, eAddr || null]);
        supplierId = r.insertId; made.push('created the supplier company');
        await flagNew(conn, orgId, 'subvendors', supplierId, vnameRec);
      }
      await mergeProfile(conn, orgId, 'subvendors', supplierId, {
        contact_name: data.employer_contact, city: data.employer_city, state: data.employer_state, postal_code: data.employer_zip,
      });
    }

    // Client, vendor, billing pairing
    let client = await find(`SELECT id FROM clients WHERE organization_id = ? AND LOWER(name) = LOWER(?)`, [orgId, clientName]);
    let clientId;
    if (client) clientId = client.id;
    else { const [r] = await conn.query(`INSERT INTO clients (organization_id, name, status) VALUES (?, ?, 'active')`, [orgId, clientName]); clientId = r.insertId; made.push('created the client'); await flagNew(conn, orgId, 'clients', clientId, clientName); }
    let programId = null;
    if (vendorName) {
      const pr = await find(`SELECT id FROM programs WHERE client_id = ? AND LOWER(name) = LOWER(?)`, [clientId, vendorName]);
      if (pr) programId = pr.id;
      else { const [r] = await conn.query(`INSERT INTO programs (organization_id, client_id, name, status) VALUES (?, ?, ?, 'active')`, [orgId, clientId, vendorName]); programId = r.insertId; made.push('created the vendor'); await flagNew(conn, orgId, 'programs', programId, vendorName, clientId); }
    }
    const billing = data.bill_rate !== undefined ? data.bill_rate : null;
    const prn = Number(data.pay_rate);
    const payRateVal = data.pay_rate !== undefined && data.pay_rate !== '' && Number.isFinite(prn) ? prn : null;
    const asg = await find(`SELECT id FROM consultant_assignments WHERE organization_id = ? AND consultant_id = ? AND client_id = ? AND program_id <=> ?`, [orgId, consultantId, clientId, programId]);
    let assignmentId;
    const empType = EMPLOYMENT_BY_WORKER[row.worker_type] || 'Unspecified';
    const joinedText = data.start_date ? String(data.start_date).slice(0, 64) : null;
    if (asg) { assignmentId = asg.id; await conn.query(`UPDATE consultant_assignments SET billing = ?, pay_rate = ?, status = 'active', left_date = NULL, employment_type = ?, supplier_id = ?, recruiter = COALESCE(?, recruiter), joined_text = COALESCE(?, joined_text) WHERE id = ?`, [billing, payRateVal, empType, supplierId, data.recruiter || null, joinedText, assignmentId]); made.push('updated the billing pairing'); }
    else {
      const [r] = await conn.query(`INSERT INTO consultant_assignments (organization_id, consultant_id, client_id, program_id, billing, pay_rate, source, employment_type, supplier_id, recruiter, joined_text) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
        [orgId, consultantId, clientId, programId, billing, payRateVal, empType, supplierId, data.recruiter || null, joinedText]);
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

router.helpers = { DOC_TYPES, DOC_MAX, parse, formStates, docList, requestView, sha256, SCHEMA_MSG, mergeProfile, companyComplete };
module.exports = router;
