// Supplier portal: a supplier opens a secure link from HR (no login) and fills in the W-9 /
// banking forms and uploads documents that were requested. The link is a random 256-bit
// token; only its hash is stored. It reaches ONLY what the request asked for, on the one
// supplier company record, and stops working when revoked or expired.

const express = require('express');
const pool = require('../db');
const { isConfigured, encryptBuffer } = require('../crypto');
const ob = require('./onboarding');
const formsRouter = require('./forms');
const vendorItems = require('./vendorItems');

const { DOC_TYPES, DOC_MAX, parse, requestView, sha256, SCHEMA_MSG } = ob.helpers;
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
    req.vreq = r; req.vrow = obs[0]; req.vitems = String(r.items).split(',').filter((k) => vendorItems.ITEMS[k]);
    next();
  } catch (err) { if (err && err.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

async function addLog(row, text) {
  const [cur] = await pool.query('SELECT log FROM onboardings WHERE id = ?', [row.id]);
  const l = parse(cur[0] && cur[0].log, []); l.push({ at: new Date().toISOString(), by: 'Supplier (secure link)', text });
  await pool.query('UPDATE onboardings SET log = ? WHERE id = ?', [JSON.stringify(l.slice(-200)), row.id]);
}

router.get('/:token', async (req, res, next) => {
  try {
    const r = req.vreq;
    pool.query('UPDATE vendor_requests SET last_opened_at = NOW() WHERE id = ?', [r.id]).catch(() => {});
    const [org] = await pool.query('SELECT name FROM organizations WHERE id = ?', [r.organization_id]);
    const [sup] = await pool.query('SELECT name FROM subvendors WHERE id = ? AND organization_id = ?', [r.supplier_id, r.organization_id]);
    const view = await requestView(Object.assign({}, req.vrow, { supplier_id: r.supplier_id }), r);
    view.items = view.items.map((i) => Object.assign(i, { kind: vendorItems.ITEMS[i.key].kind, form: vendorItems.ITEMS[i.key].form || null, help: vendorItems.ITEMS[i.key].help }));
    res.json({ organization: org[0] ? org[0].name : '', company: sup[0] ? sup[0].name : '', request: view, encryptionConfigured: isConfigured() });
  } catch (err) { next(err); }
});

router.get('/:token/bank-lookup/:rn', (req, res) => {
  if (!req.vitems.includes('banking')) return res.status(404).json({ error: 'Not requested.' });
  res.json(require('./abaLookup').lookup(req.params.rn));
});

// W-9 / banking forms: handed to the same code HR uses, but only for this supplier and these forms.
router.use('/:token/forms', (req, res, next) => {
  const m = /^\/(w9|banking)(\/|\?|$)/.exec(req.url);
  const it = m && vendorItems.KEYS.find((k) => vendorItems.ITEMS[k].form === m[1]);
  if (!it || !req.vitems.includes(it)) return res.status(404).json({ error: 'That form was not requested.' });
  if (/\/reopen(\/|\?|$)/.test(req.url)) return res.status(403).json({ error: 'Contact HR to change a signed form.' });
  req.vendorLink = true;
  req.user = { id: null, name: 'Supplier (secure link)', email: 'supplier-link', role: 'vendor', organization_id: req.vreq.organization_id };
  if (req.method === 'POST' && /\/sign(\?|$)/.test(req.url)) res.on('finish', () => { if (res.statusCode === 200) addLog(req.vrow, `${vendorItems.ITEMS[it].label} signed by the supplier.`).catch(() => {}); });
  req.url = '/subvendors/' + req.vreq.supplier_id + req.url;
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
      [row.organization_id, row.id, it.itemKey, filename, t.mime, buf.length, encryptBuffer(buf), 'Supplier (secure link)']);
    await pool.query('DELETE FROM onboarding_documents WHERE organization_id = ? AND onboarding_id = ? AND item_key = ? AND id <> ?', [row.organization_id, row.id, it.itemKey, r.insertId]);
    await addLog(row, `${it.label}: uploaded by the supplier (${filename}, ${Math.max(1, Math.round(buf.length / 1024))} KB).`);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:token/submit', async (req, res, next) => {
  try {
    const view = await requestView(Object.assign({}, req.vrow, { supplier_id: req.vreq.supplier_id }), req.vreq);
    const left = view.items.filter((i) => !i.done);
    if (left.length) return res.status(409).json({ error: 'Still to do: ' + left.map((i) => i.label).join(', ') + '.' });
    await pool.query('UPDATE vendor_requests SET submitted_at = NOW() WHERE id = ?', [req.vreq.id]);
    await addLog(req.vrow, 'The supplier marked everything requested as complete.');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
