// Supplier / consultant portal: a supplier (or the consultant) opens a secure link from HR (no login) and fills in the W-9 /
// banking forms and uploads documents that were requested. The link is a random 256-bit
// token; only its hash is stored. It reaches ONLY what the request asked for, on the one
// supplier company record, and stops working when revoked or expired.

const express = require('express');
const pool = require('../db');
const { isConfigured, encryptBuffer } = require('../crypto');
const ob = require('./onboarding');
const formsRouter = require('./forms');
const vendorItems = require('./vendorItems');

const { DOC_TYPES, DOC_MAX, parse, requestView, sha256, SCHEMA_MSG, mergeProfile } = ob.helpers;
const PAY_TERMS = ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60', 'Net 90', 'Other'];
const router = express.Router();

router.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' });
  next();
});

// Slow down anyone guessing links: 30 bad links per IP per 15 minutes.
const misses = new Map();
const tooMany = (ip) => { const m = misses.get(ip); return !!m && m.reset > Date.now() && m.n >= 30; };
const miss = (ip) => { const m = misses.get(ip); if (!m || m.reset <= Date.now()) misses.set(ip, { n: 1, reset: Date.now() + 15 * 60000 }); else m.n += 1; };

router.use('/:token', async (req, res, next) => {
  try {
    if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    const t = String(req.params.token || '');
    if (!/^[a-f0-9]{64}$/.test(t)) { miss(req.ip); return res.status(404).json({ error: 'This link is not valid.' }); }
    const [rs] = await pool.query('SELECT * FROM vendor_requests WHERE token_hash = ?', [sha256(t)]);
    const r = rs[0];
    if (!r) { miss(req.ip); return res.status(404).json({ error: 'This link is not valid.' }); }
    if (r.revoked_at) return res.status(410).json({ error: 'This link was cancelled. Ask your contact for a new one.' });
    if (new Date(r.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'This link has expired. Ask your contact for a new one.' });
    const [obs] = await pool.query('SELECT * FROM onboardings WHERE id = ? AND organization_id = ?', [r.onboarding_id, r.organization_id]);
    if (!obs[0] || obs[0].status === 'cancelled' || obs[0].status === 'complete') return res.status(410).json({ error: 'This request is closed.' });
    req.vreq = r; req.vparty = r.party === 'consultant' ? 'consultant' : 'supplier'; req.vrow = obs[0]; req.vitems = String(r.items).split(',').filter((k) => vendorItems.ITEMS[k]);
    next();
  } catch (err) { if (err && err.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

const PARTY_LABEL = { supplier: 'Supplier (secure link)', consultant: 'Consultant (secure link)' };
async function addLog(row, text, party) {
  const [cur] = await pool.query('SELECT log FROM onboardings WHERE id = ?', [row.id]);
  const l = parse(cur[0] && cur[0].log, []); l.push({ at: new Date().toISOString(), by: PARTY_LABEL[party || 'supplier'], text });
  await pool.query('UPDATE onboardings SET log = ? WHERE id = ?', [JSON.stringify(l.slice(-200)), row.id]);
}

router.get('/:token', async (req, res, next) => {
  try {
    const r = req.vreq;
    pool.query('UPDATE vendor_requests SET last_opened_at = NOW() WHERE id = ?', [r.id]).catch(() => {});
    const [org] = await pool.query('SELECT name FROM organizations WHERE id = ?', [r.organization_id]);
    const [sup] = req.vparty === 'consultant'
      ? await pool.query('SELECT name FROM consultants WHERE id = ? AND organization_id = ?', [r.consultant_id, r.organization_id])
      : await pool.query('SELECT name FROM subvendors WHERE id = ? AND organization_id = ?', [r.supplier_id, r.organization_id]);
    const view = await requestView(viewRowOf(req), r);
    view.items = view.items.map((i) => Object.assign(i, { kind: vendorItems.ITEMS[i.key].kind, form: vendorItems.ITEMS[i.key].form || null, help: vendorItems.ITEMS[i.key].help }));
    res.json({ party: req.vparty, organization: org[0] ? org[0].name : '', company: sup[0] ? sup[0].name : '', request: view, encryptionConfigured: isConfigured(), payTerms: PAY_TERMS });
  } catch (err) { next(err); }
});

const viewRowOf = (req) => Object.assign({}, req.vrow, { supplier_id: req.vreq.supplier_id || null, consultant_id: req.vreq.consultant_id || null });
const one = (v, n) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
router.get('/:token/company', async (req, res, next) => {
  try {
    if (!req.vitems.includes('company')) return res.status(404).json({ error: 'Not requested.' });
    const r = req.vreq;
    const [sv] = await pool.query('SELECT name, email, phone, address FROM subvendors WHERE id = ? AND organization_id = ?', [r.supplier_id, r.organization_id]);
    const [pr] = await pool.query(`SELECT data FROM record_profiles WHERE organization_id = ? AND entity = 'subvendors' AND record_id = ?`, [r.organization_id, r.supplier_id]);
    const p = parse(pr[0] && pr[0].data, {});
    const addr = String((sv[0] && sv[0].address) || '');
    const street = addr.split(',')[0] || '';
    res.json({ values: { contact_name: p.contact_name || '', email: (sv[0] && sv[0].email) || '', phone: (sv[0] && sv[0].phone) || '', street, city: p.city || '', state: p.state || '', postal_code: p.postal_code || '', payment_terms: p.payment_terms || '' } });
  } catch (err) { next(err); }
});
router.put('/:token/company', async (req, res, next) => {
  try {
    if (!req.vitems.includes('company')) return res.status(404).json({ error: 'Not requested.' });
    const b = (req.body && req.body.values) || {};
    const v = { contact_name: one(b.contact_name, 120), email: one(b.email, 255), phone: one(b.phone, 40), street: one(b.street, 200), city: one(b.city, 80), state: one(b.state, 40), postal_code: one(b.postal_code, 20), payment_terms: one(b.payment_terms, 40) };
    if (!v.contact_name || !v.street || !v.city || !v.state) return res.status(400).json({ error: 'Fill in the contact name, street address, city and state.' });
    if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (v.payment_terms && !PAY_TERMS.includes(v.payment_terms)) return res.status(400).json({ error: 'Choose one of the listed payment terms.' });
    const r = req.vreq;
    const address = [v.street, [v.city, v.state, v.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    await pool.query('UPDATE subvendors SET email = COALESCE(NULLIF(?, \'\'), email), phone = COALESCE(NULLIF(?, \'\'), phone), address = ? WHERE id = ? AND organization_id = ?', [v.email, v.phone, address, r.supplier_id, r.organization_id]);
    await mergeProfile(pool, r.organization_id, 'subvendors', r.supplier_id, { contact_name: v.contact_name, city: v.city, state: v.state, postal_code: v.postal_code, payment_terms: v.payment_terms });
    await addLog(req.vrow, 'Company details entered by the supplier.', 'supplier');
    res.json({ ok: true });
  } catch (err) { next(err); }
});


// Consultant's own details (email, phone, address).
router.get('/:token/details', async (req, res, next) => {
  try {
    if (!req.vitems.includes('c_details')) return res.status(404).json({ error: 'Not requested.' });
    const r = req.vreq;
    const [c] = await pool.query('SELECT name, email, phone, address FROM consultants WHERE id = ? AND organization_id = ?', [r.consultant_id, r.organization_id]);
    const [pr] = await pool.query(`SELECT data FROM record_profiles WHERE organization_id = ? AND entity = 'consultants' AND record_id = ?`, [r.organization_id, r.consultant_id]);
    const p = parse(pr[0] && pr[0].data, {});
    const addr = String((c[0] && c[0].address) || '');
    res.json({ values: { email: (c[0] && c[0].email) || '', phone: (c[0] && c[0].phone) || '', street: addr.split(',')[0] || '', city: p.city || '', state: p.state || '', postal_code: p.postal_code || '' }, name: c[0] ? c[0].name : '' });
  } catch (err) { next(err); }
});
router.put('/:token/details', async (req, res, next) => {
  try {
    if (!req.vitems.includes('c_details')) return res.status(404).json({ error: 'Not requested.' });
    const b = (req.body && req.body.values) || {};
    const v = { email: one(b.email, 255), phone: one(b.phone, 40), street: one(b.street, 200), city: one(b.city, 80), state: one(b.state, 40), postal_code: one(b.postal_code, 20) };
    if (!v.email && !v.phone) return res.status(400).json({ error: 'Give an email address or a phone number.' });
    if (!v.street || !v.city || !v.state) return res.status(400).json({ error: 'Fill in the street address, city and state.' });
    if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const r = req.vreq;
    const address = [v.street, [v.city, v.state, v.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    await pool.query('UPDATE consultants SET email = COALESCE(NULLIF(?, \'\'), email), phone = COALESCE(NULLIF(?, \'\'), phone), address = ? WHERE id = ? AND organization_id = ?', [v.email, v.phone, address, r.consultant_id, r.organization_id]);
    await mergeProfile(pool, r.organization_id, 'consultants', r.consultant_id, { city: v.city, state: v.state, postal_code: v.postal_code });
    await addLog(req.vrow, 'Personal details entered by the consultant.', 'consultant');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/:token/bank-lookup/:rn', (req, res) => {
  if (!req.vitems.includes('banking') && !req.vitems.includes('c_banking')) return res.status(404).json({ error: 'Not requested.' });
  res.json(require('./abaLookup').lookup(req.params.rn));
});

// W-9 / banking forms: handed to the same code HR uses, but only for this supplier and these forms.
router.use('/:token/forms', (req, res, next) => {
  const m = /^\/(w9|banking|i9)(\/|\?|$)/.exec(req.url);
  const it = m && vendorItems.keysFor(req.vparty).find((k) => vendorItems.ITEMS[k].form === m[1]);
  if (!it || !req.vitems.includes(it)) return res.status(404).json({ error: 'That form was not requested.' });
  if (/\/reopen(\/|\?|$)/.test(req.url)) return res.status(403).json({ error: 'Contact HR to change a signed form.' });
  const def = vendorItems.ITEMS[it];
  const rid = def.entity === 'consultants' ? req.vreq.consultant_id : req.vreq.supplier_id;
  if (!rid) return res.status(404).json({ error: 'That form is not available.' });
  req.vendorLink = true;
  req.user = { id: null, name: PARTY_LABEL[req.vparty], email: req.vparty + '-link', role: 'vendor', organization_id: req.vreq.organization_id };
  if (req.method === 'POST' && /\/sign(\?|$)/.test(req.url)) res.on('finish', () => { if (res.statusCode === 200) addLog(req.vrow, `${def.label} signed by the ${req.vparty}.`, req.vparty).catch(() => {}); });
  req.url = '/' + def.entity + '/' + rid + req.url;
  formsRouter(req, res, next);
});

router.post('/:token/documents', async (req, res, next) => {
  try {
    const b = req.body || {};
    const it = vendorItems.ITEMS[b.item];
    if (!it || it.kind !== 'upload' || !req.vitems.includes(b.item)) return res.status(404).json({ error: 'That document was not requested.' });
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
    if (!isConfigured()) return res.status(503).json({ error: 'Documents cannot be stored yet. Please tell your contact at the company.' });
    const row = req.vrow;
    const [r] = await pool.query(
      'INSERT INTO onboarding_documents (organization_id, onboarding_id, item_key, filename, mime, size, content, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [row.organization_id, row.id, it.itemKey, filename, t.mime, buf.length, encryptBuffer(buf), PARTY_LABEL[req.vparty]]);
    await pool.query('DELETE FROM onboarding_documents WHERE organization_id = ? AND onboarding_id = ? AND item_key = ? AND id <> ?', [row.organization_id, row.id, it.itemKey, r.insertId]);
    await addLog(row, `${it.label}: uploaded by the ${req.vparty} (${filename}, ${Math.max(1, Math.round(buf.length / 1024))} KB).`, req.vparty);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:token/submit', async (req, res, next) => {
  try {
    const view = await requestView(viewRowOf(req), req.vreq);
    const left = view.items.filter((i) => !i.done);
    if (left.length) return res.status(409).json({ error: 'Still to do: ' + left.map((i) => i.label).join(', ') + '.' });
    await pool.query('UPDATE vendor_requests SET submitted_at = NOW() WHERE id = ?', [req.vreq.id]);
    if (req.vparty === 'supplier') await pool.query(`UPDATE subvendors SET status = 'active' WHERE id = ? AND organization_id = ? AND (status IS NULL OR status = 'inactive')`, [req.vreq.supplier_id, req.vreq.organization_id]);
    await addLog(req.vrow, `The ${req.vparty} marked everything requested as complete.`, req.vparty);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
