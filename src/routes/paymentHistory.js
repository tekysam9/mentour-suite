// Payment history import (owner / HR): reads the old supplier-payments workbook, works out what it means,
// ASKS about everything uncertain, and only then saves. See src/paymentHistory/{parse,plan}.js.
//   POST /preview  changes nothing: returns what was read, what would be saved, and the questions.
//   POST /apply    recomputes the same plan from the same sheets + answers and saves it in one transaction.
//   GET  /imports  what has been imported;  POST /imports/:id/undo removes that import's payments only.
// Safety: nothing is ever deleted except by "undo", which touches only the rows that import added. People and
// suppliers are created only when the answers say "new"; existing records are never edited.
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { isHrUser } = require('../placementRules');
const { findOrCreateDirectoryRecord } = require('./directoryUpsert');
const { ledgerMonthlyRecords } = require('./subvendorInvoices');
const { parseWorkbook } = require('../paymentHistory/parse');
const { buildPlan, sourceKey, nameKey } = require('../paymentHistory/plan');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => isHrUser(req.user) ? next() : res.status(403).json({ error: 'Only the account owner or an HR admin can import payment history.' }));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const SCHEMA_MSG = 'Payment history needs the latest database update — re-run db/schema.sql, then try again.';
const missing = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146);
const MAX_SHEETS = 40; const MAX_ROWS = 3000; const MAX_COLS = 200;

function readSheets(body) {
  const sheets = body && body.sheets;
  if (!sheets || typeof sheets !== 'object' || Array.isArray(sheets)) return { error: 'Choose the workbook first.' };
  const names = Object.keys(sheets);
  if (!names.length || names.length > MAX_SHEETS) return { error: 'The workbook has no sheets, or too many.' };
  const out = {};
  for (const n of names) {
    const rows = sheets[n];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) return { error: 'Sheet “' + String(n).slice(0, 60) + '” is too large to import in one go.' };
    out[String(n).slice(0, 128)] = rows.map((r) => (Array.isArray(r) ? r.slice(0, MAX_COLS).map((c) => (c === undefined ? null : typeof c === 'string' ? c.slice(0, 500) : c)) : []));
  }
  return { sheets: out };
}

async function loadContext(orgId) {
  const [consultants] = await pool.query('SELECT id, name, status FROM consultants WHERE organization_id = ? ORDER BY name', [orgId]);
  const [suppliers] = await pool.query('SELECT id, name FROM subvendors WHERE organization_id = ? ORDER BY name', [orgId]);
  const existing = [];
  const file = await ledgerMonthlyRecords(pool, orgId);
  file.records.forEach((r) => existing.push({ consultant: r.consultant_name, supplier: r.subvendor_name, period_month: r.period_month, amount: r.amount }));
  try {
    const [h] = await pool.query(
      `SELECT c.name AS consultant, s.name AS supplier, h.period_month, h.amount FROM supplier_payment_history h
       JOIN payment_history_imports i ON i.id = h.import_id AND i.undone_at IS NULL
       JOIN consultants c ON c.id = h.consultant_id JOIN subvendors s ON s.id = h.subvendor_id WHERE h.organization_id = ?`, [orgId]);
    h.forEach((r) => existing.push({ consultant: r.consultant, supplier: r.supplier, period_month: String(r.period_month instanceof Date ? r.period_month.toISOString() : r.period_month).slice(0, 10), amount: r.amount }));
  } catch (e) { if (!missing(e)) throw e; }
  const [paid] = await pool.query(
    `SELECT c.name AS consultant, s.name AS supplier, i.period_month, i.amount FROM subvendor_invoices i
     JOIN consultants c ON c.id = i.consultant_id JOIN subvendors s ON s.id = i.subvendor_id WHERE i.organization_id = ? AND i.payment_status = 'paid' AND i.amount IS NOT NULL`, [orgId]);
  paid.forEach((r) => existing.push({ consultant: r.consultant, supplier: r.supplier, period_month: String(r.period_month instanceof Date ? r.period_month.toISOString() : r.period_month).slice(0, 10), amount: r.amount }));
  return { directory: { consultants, suppliers }, existing };
}

// Only ids that really are this organisation's can be chosen as the "existing" record.
function cleanAnswers(raw, ctx) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const cIds = new Set(ctx.directory.consultants.map((c) => c.id)); const sIds = new Set(ctx.directory.suppliers.map((s) => s.id));
  const cName = new Map(ctx.directory.consultants.map((c) => [c.id, c.name])); const sName = new Map(ctx.directory.suppliers.map((s) => [s.id, s.name]));
  const out = { years: a.years === 'ok' ? 'ok' : a.years === 'no' ? 'no' : null, deduction: ['net', 'gross'].includes(a.deduction) ? a.deduction : null, dates: ['blank', 'keep'].includes(a.dates) ? a.dates : undefined,
    aliases: {}, groups: {}, dupes: {}, clients: {}, fixes: {}, entities: {} };
  for (const [k, v] of Object.entries(a.aliases || {})) if (['smart', 'first', 'second', 'one', 'distinct'].includes(v)) out.aliases[String(k).slice(0, 255)] = v;
  for (const [k, v] of Object.entries(a.groups || {})) if (['skip', 'import'].includes(v)) out.groups[String(k).slice(0, 255)] = v;
  for (const [k, v] of Object.entries(a.dupes || {})) if (['once', 'both', 'first', 'second'].includes(v)) out.dupes[String(k).slice(0, 255)] = v;
  for (const [k, v] of Object.entries(a.clients || {})) if (typeof v === 'string') out.clients[String(k).slice(0, 255)] = v.slice(0, 255);
  for (const [k, v] of Object.entries(a.fixes || {})) if (v && Number(v.amount) > 0 && Number(v.amount) < 10000000) out.fixes[String(k).slice(0, 255)] = { amount: Number(v.amount), paidDate: /^\d{4}-\d{2}-\d{2}$/.test(String(v.paidDate || '')) ? v.paidDate : null };
  for (const [k, v] of Object.entries(a.entities || {})) {
    if (!v || typeof v !== 'object' || !/^[cs]:/.test(k)) continue;
    const isC = k[0] === 'c';
    if (v.action === 'existing' && (isC ? cIds : sIds).has(Number(v.id))) out.entities[k] = { action: 'existing', id: Number(v.id), name: (isC ? cName : sName).get(Number(v.id)) };
    else if (v.action === 'new') out.entities[k] = { action: 'new', name: String(v.name || '').trim().slice(0, 255) || undefined };
    else if (v.action === 'skip') out.entities[k] = { action: 'skip' };
    else if (v.action === 'merge' && typeof v.key === 'string' && v.key[0] === k[0]) out.entities[k] = { action: 'merge', key: v.key.slice(0, 255), name: String(v.name || '').trim().slice(0, 255) };
  }
  return out;
}

async function makePlan(req) {
  const r = readSheets(req.body);
  if (r.error) return { error: r.error };
  const ctx = await loadContext(req.user.organization_id);
  const parsed = parseWorkbook(r.sheets);
  if (!parsed.sheets.length) return { error: 'None of the sheets looks like a supplier-payments sheet (a list of consultants with a month-by-month payment grid, or the monthly AR/AP sheets).' };
  const answers = cleanAnswers(req.body.answers, ctx);
  const plan = buildPlan({ parsed, directory: ctx.directory, existing: ctx.existing, answers });
  return { plan, ctx, answers };
}

router.post('/preview', async (req, res, next) => {
  try {
    const m = await makePlan(req);
    if (m.error) return res.status(400).json({ error: m.error });
    const { plan } = m;
    res.json({ sheets: plan.sheets, skippedSheets: plan.skippedSheets, questions: plan.questions, requiredOpen: plan.requiredOpen, canApply: plan.canApply && m.answers.years === 'ok',
      stats: plan.stats, sample: plan.rows.slice(0, 25).map((r) => ({ consultant: r.cRef.name || r.cRef.newName, supplier: r.sRef.name || r.sRef.newName, month: r.hoursMonth, paid: r.paidDate, amount: r.amount, note: r.note, source: r.sheet + ' row ' + r.row })), noMonth: plan.noMonth.slice(0, 30) });
  } catch (err) { next(err); }
});

router.post('/apply', async (req, res, next) => {
  let conn;
  try {
    if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: 'Confirm that you have reviewed the answers.' });
    const m = await makePlan(req);
    if (m.error) return res.status(400).json({ error: m.error });
    const { plan, answers } = m;
    if (answers.years !== 'ok') return res.status(409).json({ error: 'Confirm the years first.' });
    if (!plan.requiredOpen.length && !plan.rows.length) return res.status(409).json({ error: 'Nothing new to import: everything in this file that can be saved is already in the app.' });
    if (!plan.canApply) return res.status(409).json({ error: 'Some questions still need an answer: ' + plan.requiredOpen.join(', ') + '.', requiredOpen: plan.requiredOpen });
    const orgId = req.user.organization_id;
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [imp] = await conn.query('INSERT INTO payment_history_imports (organization_id, uploaded_by, file_name) VALUES (?, ?, ?)', [orgId, req.user.id, String(req.body.fileName || 'payment history').slice(0, 255)]);
    const importId = imp.insertId;
    const created = { consultants: [], suppliers: [] };
    const cIds = new Map(); const sIds = new Map();
    const leftNames = new Set(plan.rows.filter((r) => r.left && r.cRef.newName).map((r) => r.cRef.newName));
    const idOf = async (ref, table, cache, status) => {
      if (ref.id) return ref.id;
      const k = ref.newName;
      if (cache.has(k)) return cache.get(k);
      const rec = await findOrCreateDirectoryRecord(conn, table, { organizationId: orgId, name: k, status });
      cache.set(k, rec.id);
      if (rec.created) created[table === 'consultants' ? 'consultants' : 'suppliers'].push(k);
      return rec.id;
    };
    const ordinal = new Map(); let added = 0; let total = 0; const batch = [];
    for (const r of plan.rows) {
      const cId = await idOf(r.cRef, 'consultants', cIds, leftNames.has(r.cRef.newName) ? 'inactive' : null);
      const sId = await idOf(r.sRef, 'subvendors', sIds, null);
      const period = r.hoursMonth + '-01';
      const base = [cId, sId, period, r.paidDate || '', Number(r.amount).toFixed(2)].join('|');
      const n = (ordinal.get(base) || 0) + 1; ordinal.set(base, n);
      batch.push([orgId, importId, cId, sId, period, r.amount, r.deduction == null ? null : r.deduction, r.paidDate || null, r.method ? String(r.method).slice(0, 32) : null, r.clientText ? String(r.clientText).slice(0, 255) : null,
        String(r.supplierRaw || '').slice(0, 255) || null, r.note ? String(r.note).slice(0, 1000) : null, String(r.sheet).slice(0, 128), (r.row + (r.col ? ':' + r.col : '')).toString().slice(0, 64), sourceKey(orgId, cId, sId, period, r.paidDate, r.amount, n)]);
    }
    for (let i = 0; i < batch.length; i += 300) {
      const [ins] = await conn.query(
        `INSERT IGNORE INTO supplier_payment_history (organization_id, import_id, consultant_id, subvendor_id, period_month, amount, deduction, paid_date, pay_method, client_text, supplier_text, note, source_sheet, source_ref, source_key) VALUES ?`, [batch.slice(i, i + 300)]);
      added += ins.affectedRows;
    }
    const [[tot]] = await conn.query('SELECT COALESCE(SUM(amount), 0) AS t FROM supplier_payment_history WHERE import_id = ?', [importId]); total = Number(tot.t);
    await conn.query('UPDATE payment_history_imports SET rows_added = ?, total_amount = ?, summary = ? WHERE id = ?', [added, total, JSON.stringify({ created, stats: plan.stats, answers: { years: answers.years, deduction: answers.deduction, dates: answers.dates || 'blank', groups: answers.groups, dupes: answers.dupes, aliases: answers.aliases } }), importId]);
    await conn.commit();
    res.locals.auditNote = 'Payment history import #' + importId + ' (' + (req.body.fileName ? String(req.body.fileName).slice(0, 80) : 'file') + '): ' + added + ' payments, $' + Number(total).toFixed(2) + '; new consultants ' + created.consultants.length + ', new suppliers ' + created.suppliers.length;
    res.status(201).json({ importId, added, alreadyThere: batch.length - added, total, created });
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch (e) { /* ignore */ } }
    if (missing(err)) return res.status(503).json({ error: SCHEMA_MSG });
    next(err);
  } finally { if (conn) conn.release(); }
});

router.get('/imports', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT i.id, i.file_name, i.created_at, i.rows_added, i.total_amount, i.undone_at, i.summary, u.name AS by_name,
              (SELECT COUNT(*) FROM supplier_payment_history h WHERE h.import_id = i.id) AS rows_now
       FROM payment_history_imports i LEFT JOIN users u ON u.id = i.uploaded_by WHERE i.organization_id = ? ORDER BY i.id DESC LIMIT 50`, [req.user.organization_id]);
    res.json({ imports: rows.map((r) => { let s = r.summary; if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { s = null; } } return { id: r.id, file_name: r.file_name, created_at: r.created_at, by: r.by_name, rows_added: r.rows_added, rows_now: r.rows_now, total_amount: Number(r.total_amount), undone_at: r.undone_at, created: s && s.created ? s.created : null }; }) });
  } catch (err) { if (missing(err)) return res.json({ imports: [], schemaMissing: true }); next(err); }
});

// Removes only the payments this import added. People and suppliers it created stay (listed in the import's summary).
router.post('/imports/:id/undo', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
    const orgId = req.user.organization_id;
    const [[imp]] = await pool.query('SELECT id, undone_at FROM payment_history_imports WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!imp) return res.status(404).json({ error: 'That import was not found.' });
    if (imp.undone_at) return res.status(409).json({ error: 'That import was already undone.' });
    const [del] = await pool.query('DELETE FROM supplier_payment_history WHERE import_id = ? AND organization_id = ?', [imp.id, orgId]);
    await pool.query('UPDATE payment_history_imports SET undone_at = NOW() WHERE id = ?', [imp.id]);
    res.locals.auditNote = 'Undid payment history import #' + req.params.id + ': removed ' + del.affectedRows + ' payments';
    res.json({ removed: del.affectedRows });
  } catch (err) { next(err); }
});

module.exports = router;
