// Directory import: fills in details for consultants that ALREADY exist in the
// Directory from a "contact card" workbook (name, phone, email, skill, W2/C2C/1099,
// the consultant's company and its contact lines).
//
// Safety rules (this edits live records, so it is deliberately cautious):
//  * HR / owner only; everything scoped to the caller's organisation.
//  * POST /preview changes nothing. POST /apply recomputes the same plan from the
//    same rows and writes only the fields the person ticked.
//  * People are matched by name (and by email); a person who is not in the
//    Directory is listed but never created. A near-match is offered, not assumed.
//  * Blank fields are filled. A field that already holds a DIFFERENT value is a
//    conflict and is only replaced when it is ticked. Equal values are left alone.
//  * Supplier companies are matched by name; a missing one is created only when
//    ticked. Nothing is ever deleted. All writes for one person are one transaction.
//  * Every change is written to the record's change log.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.user.role === 'owner' || req.user.role === 'hr') return next();
  res.status(403).json({ error: 'Only HR or an administrator can import Directory details.' });
});

const MAX_ROWS = 300;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const EMAIL_FULL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const DOMAIN_TYPOS = { 'gamil.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'hotmial.com': 'hotmail.com', 'outlok.com': 'outlook.com', 'iclod.com': 'icloud.com' };
const COMPANY_RE = /\b(inc\.?|llc|l\.l\.c|ltd\.?|limited|corp\.?|corporation|technologies|technology|solutions|enterprises?|consulting|consultants|systems|services|software|group|company|co\.|pvt|llp)\b/i;
const TITLE_RE = /^(owner|ceo|cto|cfo|coo|president|vice president|vp|managing (member|partner|director)|director|manager|accounts? (executive|manager|payable)|bench sales (lead|executive)|recruiter|hr( manager)?|founder|partner)\b/i;
const WORKER = { W2: 'W2', C2C: 'Corp-to-Corp', '1099': '1099' };

const clean = (v, max) => { const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(); return max ? s.slice(0, max) : s; };
const nameKey = (s) => clean(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => nameKey(s).split(' ').filter(Boolean);
const companyKey = (s) => nameKey(s).replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|pvt|llp)\b/g, ' ').replace(/\s+/g, ' ').trim();
const digits = (s) => String(s || '').replace(/\D/g, '');

// ---- field cleaners (return { value, warn }) -------------------------------
function cleanPhones(raw) {
  const out = []; const warn = [];
  const parts = String(raw == null ? '' : raw).split(/[\/|;,]|\s{2,}|\sor\s/i).map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    let d = digits(p);
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length === 10) {
      out.push(d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6));
      if (!/^\d{10}$/.test(p) && !/^\d{3}[-. ]\d{3}[-. ]\d{4}$/.test(p) && !/^\(\d{3}\)\s?\d{3}[-. ]\d{4}$/.test(p) && !/^\+?1?[-. ]?\d{3}[-. ]\d{3}[-. ]\d{4}$/.test(p)) warn.push(`Phone "${p}" was reformatted to ${out[out.length - 1]}; please check it.`);
    } else if (d.length >= 7) { out.push(clean(p, 64)); warn.push(`Phone "${p}" is not a 10-digit US number; kept as written.`); }
  }
  return { list: out, warn };
}
function cleanEmail(raw) {
  const s = clean(raw).toLowerCase().replace(/^mailto:/, '');
  if (!s) return { value: '', warn: [] };
  if (!EMAIL_FULL.test(s)) return { value: '', warn: [`"${s}" is not a valid email address, so it was skipped.`] };
  const [u, d] = s.split('@');
  if (DOMAIN_TYPOS[d]) return { value: u + '@' + DOMAIN_TYPOS[d], fixedFrom: s, warn: [`Email "${s}" looks mistyped; changed ${d} to ${DOMAIN_TYPOS[d]}.`] };
  return { value: s, warn: [] };
}

// ---- employer block parsing ------------------------------------------------
function parseEmployer(lines, consultantName, consultantEmail, consultantPhoneDigits) {
  const res = { company: '', contactName: '', contactTitle: '', emails: [], phones: [], website: '', street: '', city: '', state: '', zip: '', warnings: [], selfContact: false, selfNamedFirst: false };
  const L = (lines || []).map((l) => clean(l, 300).replace(/[\uD800-\uDFFF]|[☀-➿]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const addr = [];
  const cn = nameKey(consultantName);
  for (let raw of L) {
    let line = raw.replace(/^(phone|ph|tel|email|e-mail|web)\s*[:\-]\s*/i, '').trim();
    if (!line) continue;
    if (/^https?:\/\//i.test(line) || /^www\./i.test(line)) { res.website = line; continue; }
    const em = line.match(EMAIL_RE);
    if (em && line.replace(em[0], '').trim().length < 3) { res.emails.push(em[0].toLowerCase()); continue; }
    if (em) { res.emails.push(em[0].toLowerCase()); line = line.replace(em[0], '').trim(); if (!line) continue; }
    // "Name/phone" or phone lines
    const ph = line.match(/(\+?\d[\d\s().\-]{8,}\d)/);
    if (ph && digits(ph[1]).length >= 10 && !/^\d{1,5}\s+[A-Za-z]/.test(line)) {
      const cp = cleanPhones(ph[1]);
      if (cp.list[0]) res.phones.push(cp.list[0]);
      const rest = line.replace(ph[0], '').replace(/[|\/:,]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (rest && /^[A-Za-z][A-Za-z .'-]{1,40}$/.test(rest) && !res.contactName && !COMPANY_RE.test(rest)) res.contactName = rest;
      continue;
    }
    if (/^\d+$/.test(digits(line)) && digits(line).length >= 10 && !/[A-Za-z]/.test(line)) { const cp = cleanPhones(line); if (cp.list[0]) res.phones.push(cp.list[0]); continue; }
    // address-looking
    if (/^\d{1,6}\s+\S/.test(line) || /\b[A-Z]{2}\s*-?\s*\d{5}\b/.test(line)) { addr.push(line.replace(/[,\s]+$/, '')); continue; }
    // title (possibly "Name, CEO")
    const tm = line.match(/^(.*?),\s*(owner|ceo|cto|cfo|president|founder|director|manager|managing member)\s*$/i);
    if (tm) { if (!res.contactName) res.contactName = tm[1].trim(); res.contactTitle = tm[2]; continue; }
    if (TITLE_RE.test(line) && !COMPANY_RE.test(line)) { res.contactTitle = line.replace(/[,\s]+$/, ''); continue; }
    // company tagline "Something @ Company LLC"
    const at = line.match(/@\s*(.+)$/);
    if (at && COMPANY_RE.test(at[1])) { if (!res.company) res.company = at[1].trim(); continue; }
    if (COMPANY_RE.test(line) && !/^own company/i.test(line) && !/ own company$/i.test(line)) { if (!res.company) res.company = line.replace(/[,\s]+$/, ''); continue; }
    if (/\bown(s)? (company|firm)\b/i.test(line)) { res.ownCompany = true; continue; }
    // person-ish name
    const nm = line.replace(/[,\s]+$/, '');
    if (/^[A-Za-z][A-Za-z .'-]{1,50}$/.test(nm) && nm.split(' ').length <= 5) {
      if (nameKey(nm) === cn) { res.selfContact = true; if (!res.company) res.selfNamedFirst = true; if (!res.contactName) res.contactName = nm; }
      else if (!res.contactName) res.contactName = nm;
      continue;
    }
    res.warnings.push(`Could not tell what "${raw}" is, so it was left out.`);
  }
  if (addr.length) {
    const joined = addr.join(', ').replace(/,\s*,/g, ',');
    const m = joined.match(/^(.*?),?\s*([A-Za-z][A-Za-z .]+?),?\s+([A-Z]{2})\s*-?\s*(\d{5})(?:-\d{4})?$/);
    if (m) { res.street = m[1].replace(/[,\s]+$/, ''); res.city = m[2].trim(); res.state = m[3]; res.zip = m[4]; }
    else { res.street = joined.slice(0, 500); res.warnings.push('The company address could not be split into city/state/ZIP; saved as one street line.'); }
  }
  const ownEmail = consultantEmail ? consultantEmail.toLowerCase() : '';
  if (res.emails.some((e) => e === ownEmail)) res.selfContact = true;
  if (consultantPhoneDigits && res.phones.some((p) => digits(p) === consultantPhoneDigits)) res.selfContact = true;
  return res;
}

// ---- matching ---------------------------------------------------------------
function sameTokens(a, b) { const x = [...a].sort().join(' '), y = [...b].sort().join(' '); return x === y; }
function subsetTokens(a, b) { const [s, l] = a.length <= b.length ? [a, b] : [b, a]; return s.length >= 2 && s.every((t) => l.includes(t)); }

async function loadDirectory(orgId) {
  const [cons] = await pool.query('SELECT id, name, email, phone, address FROM consultants WHERE organization_id = ?', [orgId]);
  const [subs] = await pool.query('SELECT id, name, email, phone, address FROM subvendors WHERE organization_id = ?', [orgId]);
  const [profs] = await pool.query(`SELECT entity, record_id, data FROM record_profiles WHERE organization_id = ? AND entity IN ('consultants','subvendors')`, [orgId]);
  const prof = { consultants: {}, subvendors: {} };
  for (const p of profs) { try { prof[p.entity][p.record_id] = (p.data && JSON.parse(p.data)) || {}; } catch (e) { prof[p.entity][p.record_id] = {}; } }
  return { cons, subs, prof };
}

function diff(label, key, current, proposed, extra) {
  const cur = clean(current), pro = clean(proposed);
  if (!pro) return null;
  const same = key === 'phone' || key === 'alt_phone' ? digits(cur) === digits(pro) : cur.toLowerCase() === pro.toLowerCase();
  return Object.assign({ key, label, current: cur, proposed: pro, kind: same ? 'same' : (cur ? 'conflict' : 'fill') }, extra || {});
}

async function buildPlan(orgId, rows) {
  const dir = await loadDirectory(orgId);
  const byName = new Map();
  dir.cons.forEach((c) => { const k = nameKey(c.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(c); });
  const plans = [];
  const seen = new Map();
  rows.forEach((r, idx) => {
    const name = clean(r.name, 255);
    const plan = { idx, name, sheetType: clean(r.type, 20).toUpperCase(), status: 'unmatched', consultantId: null, candidates: [], changes: [], warnings: [], supplier: null, note: clean(r.note, 500) };
    plans.push(plan);
    if (!name) { plan.status = 'skipped'; plan.warnings.push('No name on this card.'); return; }
    const nk = nameKey(name);
    if (seen.has(nk)) plan.warnings.push(`The same name also appears on card ${seen.get(nk) + 1}; check for a duplicate.`);
    seen.set(nk, idx);
    // match
    let hits = byName.get(nk) || [];
    const t = tokens(name);
    if (!hits.length) hits = dir.cons.filter((c) => sameTokens(tokens(c.name), t));
    const em = cleanEmail(r.email);
    if (!hits.length && em.value) hits = dir.cons.filter((c) => c.email && c.email.toLowerCase() === em.value);
    if (hits.length === 1) { plan.status = 'matched'; plan.consultantId = hits[0].id; plan.matchedName = hits[0].name; }
    else if (hits.length > 1) { plan.status = 'ambiguous'; plan.candidates = hits.map((c) => ({ id: c.id, name: c.name, email: c.email || '' })); return; }
    else {
      const near = dir.cons.filter((c) => subsetTokens(tokens(c.name), t) || (tokens(c.name)[0] === t[0] && tokens(c.name).slice(-1)[0] === t.slice(-1)[0] && t.length > 1));
      if (near.length) { plan.status = 'ambiguous'; plan.candidates = near.slice(0, 5).map((c) => ({ id: c.id, name: c.name, email: c.email || '' })); plan.warnings.push('No exact match; these Directory names are similar. Pick one if it is the same person.'); }
      return;
    }
    fillPlan(plan, r, em, dir);
  });
  return { plans, dir };
}

// Compute the field changes for a (now known) consultant.
function fillPlan(plan, r, em, dir) {
  const cons = dir.cons.find((c) => c.id === plan.consultantId);
  const prof = dir.prof.consultants[plan.consultantId] || {};
  const add = (d) => { if (d) plan.changes.push(d); };
  if (em.value) { add(diff('Work email', 'email', cons.email, em.value)); em.warn.forEach((w) => plan.warnings.push(w)); }
  else em.warn.forEach((w) => plan.warnings.push(w));
  const ph = cleanPhones(r.phone);
  ph.warn.forEach((w) => plan.warnings.push(w));
  if (ph.list[0]) add(diff('Mobile phone', 'phone', cons.phone, ph.list[0]));
  if (ph.list[1]) add(diff('Alternate phone', 'alt_phone', prof.alt_phone, ph.list[1]));
  if (ph.list.length > 2) plan.warnings.push(`${ph.list.length} phone numbers were given; only the first two are used.`);
  if (clean(r.skill)) add(diff('Key skills / technologies', 'skills', prof.skills, clean(r.skill, 500)));
  const wt = WORKER[plan.sheetType];
  if (plan.sheetType && !wt) plan.warnings.push(`Worker type "${r.type}" is not W2, C2C or 1099; skipped.`);
  if (wt) {
    const d = diff('Worker type', 'worker_type', prof.worker_type, wt);
    if (d) { if (d.kind === 'conflict' && prof.worker_type === 'Subvendor' && wt === 'Corp-to-Corp') d.note = 'The record says Subvendor; the sheet says C2C.'; add(d); }
  }
  // supplier (C2C only; W2 has no supplier company)
  if (plan.sheetType === 'C2C') {
    const lines = Array.isArray(r.employer) ? r.employer : [];
    const own = em.value || (cons.email || '').toLowerCase();
    const emp = parseEmployer(lines, plan.name, own, digits(ph.list[0] || cons.phone));
    emp.warnings.forEach((w) => plan.warnings.push(w));
    if (!emp.company) {
      if (emp.ownCompany) plan.warnings.push('The sheet says "own company" without giving its name. Supplier not linked; tell me the company name if you want it added.');
      else plan.warnings.push(lines.length ? `C2C, but no company name could be found in: "${lines.join(' / ').slice(0, 120)}". Supplier not linked.` : 'C2C, but no company details were given.');
    } else {
      const key = companyKey(emp.company);
      const hits = dir.subs.filter((s) => companyKey(s.name) === key);
      const sup = { company: emp.company, contactName: emp.contactName, selfContact: emp.selfContact, match: null, candidates: [], changes: [], create: false, extraEmails: emp.emails.slice(1), extraPhones: emp.phones.slice(1) };
      if (emp.selfNamedFirst) plan.warnings.push(`The line before "${emp.company}" is the consultant's own name; unclear whether they own it or just work there. Contact details were kept as the consultant's.`);
      if (hits.length === 1) { sup.match = { id: hits[0].id, name: hits[0].name }; }
      else if (hits.length > 1) { sup.candidates = hits.map((s) => ({ id: s.id, name: s.name })); plan.warnings.push(`"${emp.company}" matches several supplier companies; supplier not linked.`); }
      const sp = sup.match ? (dir.prof.subvendors[sup.match.id] || {}) : {};
      const srow = sup.match ? dir.subs.find((s) => s.id === sup.match.id) : null;
      const sadd = (d) => { if (d) sup.changes.push(d); };
      const se = cleanEmail(emp.emails[0]);
      se.warn.forEach((w) => plan.warnings.push(w));
      sadd(diff('Email', 'email', srow && srow.email, se.value));
      sadd(diff('Phone', 'phone', srow && srow.phone, emp.phones[0]));
      sadd(diff('Contact name', 'contact_name', sp.contact_name, emp.contactName));
      sadd(diff('Contact title', 'contact_title', sp.contact_title, emp.contactTitle));
      sadd(diff('Street address', 'address', srow && srow.address, emp.street));
      sadd(diff('City', 'city', sp.city, emp.city));
      sadd(diff('State', 'state', sp.state, emp.state));
      sadd(diff('ZIP', 'postal_code', sp.postal_code, emp.zip));
      sadd(diff('Website', 'website', sp.website, emp.website));
      if (emp.selfContact) plan.warnings.push(`The contact lines under "${emp.company}" are the consultant's own details (their own company).`);
      const doms = [...new Set(emp.emails.map((e) => e.split('@')[1]))];
      if (doms.length > 1) plan.warnings.push(`Company emails use different domains (${doms.join(', ')}); check the first one is right.`);
      if (sup.extraEmails.length) plan.warnings.push(`Extra company emails not saved: ${sup.extraEmails.join(', ')}.`);
      if (emp.emails.length && emp.emails[0] && emp.emails[0] !== se.value && !se.fixedFrom) { /* normal */ }
      if (sup.match) {
        const link = diff('Supplier company', 'supplier_id', prof.supplier_id ? (dir.subs.find((s) => String(s.id) === String(prof.supplier_id)) || {}).name || String(prof.supplier_id) : '', sup.match.name);
        if (link) { if (link.kind === 'conflict') { const curId = String(prof.supplier_id); link.kind = curId === String(sup.match.id) ? 'same' : 'conflict'; } link.value = String(sup.match.id); sup.link = link; }
      }
      plan.supplier = sup;
    }
  }
  plan.changes = plan.changes.filter((c) => c);
  // a "same" for everything means nothing to do
  plan.nothingToDo = !plan.changes.some((c) => c.kind !== 'same') && !(plan.supplier && (plan.supplier.changes.some((c) => c.kind !== 'same') || !plan.supplier.match || (plan.supplier.link && plan.supplier.link.kind !== 'same')));
}

function validRows(body) {
  const rows = body && Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length) return { error: 'No rows to import.' };
  if (rows.length > MAX_ROWS) return { error: `Please import at most ${MAX_ROWS} people at a time.` };
  return {
    rows: rows.map((r) => ({
      name: clean(r && r.name, 255), phone: clean(r && r.phone, 200), email: clean(r && r.email, 255), skill: clean(r && r.skill, 500),
      type: clean(r && r.type, 20), note: clean(r && r.note, 500),
      employer: Array.isArray(r && r.employer) ? r.employer.slice(0, 20).map((l) => clean(l, 300)) : [],
    })),
  };
}

router.post('/preview', async (req, res, next) => {
  try {
    const v = validRows(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { plans } = await buildPlan(req.user.organization_id, v.rows);
    res.json({ plans });
  } catch (err) { next(err); }
});

// picks: { "<idx>": { consultantId?, fields: ["email", ...], supplier: { mode: 'link'|'create'|'skip', fields: [...], link: bool }, note: bool } }
router.post('/apply', async (req, res, next) => {
  const v = validRows(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const picks = (req.body && typeof req.body.picks === 'object' && req.body.picks) || {};
  const orgId = req.user.organization_id;
  const who = req.user.name || req.user.email;
  try {
    const { plans, dir } = await buildPlan(orgId, v.rows);
    const results = [];
    for (const plan of plans) {
      const pick = picks[plan.idx];
      if (!pick) continue;
      // an ambiguous person can be resolved by the user choosing one of the offered candidates
      if (plan.status === 'ambiguous' && pick.consultantId) {
        const chosen = plan.candidates.find((c) => c.id === Number(pick.consultantId));
        if (!chosen) { results.push({ idx: plan.idx, name: plan.name, error: 'That Directory record was not one of the offered matches.' }); continue; }
        plan.status = 'matched'; plan.consultantId = chosen.id;
        plan.changes = []; plan.warnings = plan.warnings.filter((w) => !/similar|several/.test(w));
        fillPlan(plan, v.rows[plan.idx], cleanEmail(v.rows[plan.idx].email), dir);
      }
      if (plan.status !== 'matched') continue;
      const want = new Set(Array.isArray(pick.fields) ? pick.fields : []);
      const sel = plan.changes.filter((c) => want.has(c.key) && c.kind !== 'same');
      const sup = plan.supplier;
      const supMode = pick.supplier && pick.supplier.mode;
      const conn = await pool.getConnection();
      const done = [];
      try {
        await conn.beginTransaction();
        // 1) supplier company: link existing or create
        let supplierId = null;
        if (sup && supMode === 'create' && !sup.match && !sup.candidates.length) {
          const [ins] = await conn.query(
            `INSERT INTO subvendors (organization_id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`, [orgId, clean(sup.company, 255)]);
          supplierId = ins.insertId; done.push(`created supplier company "${sup.company}"`);
          await conn.query(`INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, 'subvendors', ?, 'log', ?, ?)`,
            [orgId, supplierId, `Created from a Directory import (${plan.name})`, who]);
        } else if (sup && sup.match && (supMode === 'link' || supMode === 'update')) supplierId = sup.match.id;
        // 2) supplier fields (only for a company we link to or just created)
        if (sup && supplierId && Array.isArray(pick.supplier.fields)) {
          const sw = new Set(pick.supplier.fields);
          const sdiffs = sup.match ? sup.changes : sup.changes.map((c) => Object.assign({}, c, { kind: 'fill', current: '' }));
          const ssel = sdiffs.filter((c) => sw.has(c.key) && c.kind !== 'same');
          const core = ssel.filter((c) => ['email', 'phone', 'address'].includes(c.key));
          for (const c of core) await conn.query(`UPDATE subvendors SET ${c.key} = ? WHERE id = ? AND organization_id = ?`, [c.proposed, supplierId, orgId]);
          const pd = ssel.filter((c) => !['email', 'phone', 'address'].includes(c.key));
          if (pd.length) await mergeProfile(conn, orgId, 'subvendors', supplierId, pd);
          if (ssel.length) {
            const txt = `Updated from a Directory import: ${ssel.map((c) => c.label).join(', ')}`;
            await conn.query(`INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, 'subvendors', ?, 'log', ?, ?)`, [orgId, supplierId, txt, who]);
            done.push(`supplier ${ssel.map((c) => c.label.toLowerCase()).join(', ')}`);
          }
        }
        // 3) consultant core + profile
        const core = sel.filter((c) => ['email', 'phone'].includes(c.key));
        for (const c of core) await conn.query(`UPDATE consultants SET ${c.key} = ? WHERE id = ? AND organization_id = ?`, [c.proposed, plan.consultantId, orgId]);
        const pdata = sel.filter((c) => !['email', 'phone'].includes(c.key));
        if (pick.supplier && pick.supplier.link && supplierId) {
          const lk = (sup && sup.link) || { kind: 'fill' };
          if (!sup.match || lk.kind !== 'same') pdata.push({ key: 'supplier_id', label: 'Supplier company', proposed: String(supplierId) });
        }
        if (pdata.length) await mergeProfile(conn, orgId, 'consultants', plan.consultantId, pdata);
        const labels = sel.map((c) => c.label).concat(pdata.some((c) => c.key === 'supplier_id') && !sel.some((c) => c.key === 'supplier_id') ? ['Supplier company'] : []);
        if (labels.length) {
          await conn.query(`INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, 'consultants', ?, 'log', ?, ?)`,
            [orgId, plan.consultantId, `Updated from a Directory import: ${labels.join(', ')}`, who]);
          done.push(labels.join(', ').toLowerCase());
        }
        if (pick.note && plan.note) {
          await conn.query(`INSERT INTO record_notes (organization_id, entity, record_id, kind, body, user_name) VALUES (?, 'consultants', ?, 'note', ?, ?)`, [orgId, plan.consultantId, plan.note, who]);
          done.push('added the note');
        }
        await conn.commit();
        results.push({ idx: plan.idx, name: plan.name, done });
      } catch (e) {
        try { await conn.rollback(); } catch (x) { /* ignore */ }
        results.push({ idx: plan.idx, name: plan.name, error: e && e.code === 'ER_DUP_ENTRY' ? 'A record with that name already exists.' : 'Could not save this person; nothing was changed for them.' });
      } finally { conn.release(); }
    }
    res.json({ results });
  } catch (err) { next(err); }
});

async function mergeProfile(conn, orgId, entity, id, changes) {
  const [cur] = await conn.query(`SELECT data FROM record_profiles WHERE organization_id = ? AND entity = ? AND record_id = ? FOR UPDATE`, [orgId, entity, id]);
  let merged = {};
  if (cur[0] && cur[0].data) { try { merged = JSON.parse(cur[0].data) || {}; } catch (e) { merged = {}; } }
  for (const c of changes) merged[c.key] = c.proposed;
  await conn.query(`INSERT INTO record_profiles (organization_id, entity, record_id, data) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`, [orgId, entity, id, JSON.stringify(merged)]);
}

router.helpers = { parseEmployer, cleanPhones, cleanEmail, companyKey };
module.exports = router;
