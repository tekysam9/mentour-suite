// GET /api/version -- public, read-only deploy check. Returns ONLY: a
// fingerprint of the deployed code (sha256 per file group, so a deploy can be
// compared with GitHub without guessing), the git commit when the host keeps
// .git, and yes/no flags for the schema columns the latest features need.
// No data, no credentials, no row counts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const pool = require('../db');

const router = express.Router();
const ROOT = path.join(__dirname, '..', '..');

function walk(dir, exts, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}
// Line endings are normalised so a Windows checkout hashes the same as Linux.
function hashFiles(files) {
  const h = crypto.createHash('sha256');
  const per = {};
  for (const f of files.sort()) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const fh = crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    per[rel] = fh.slice(0, 12);
    h.update(rel + ':' + fh + '\n');
  }
  return { overall: h.digest('hex').slice(0, 16), files: per };
}
function gitCommit() {
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 7);
    return fs.readFileSync(path.join(ROOT, '.git', head.slice(5)), 'utf8').trim().slice(0, 7);
  } catch (e) { return null; }
}

let cached = null;
function fingerprint() {
  if (!cached) {
    cached = {
      server: hashFiles(walk(path.join(ROOT, 'src'), ['.js'], []).concat([path.join(ROOT, 'server.js')])),
      public: hashFiles(walk(path.join(ROOT, 'public'), ['.js', '.html', '.css'], [])),
      schemaFile: hashFiles([path.join(ROOT, 'db', 'schema.sql')]),
    };
  }
  return cached;
}

const NEEDED = [
  ['invoices', 'payment_category'], ['invoices', 'payment_terms'], ['invoices', 'subvendor_id'], ['invoices', 'source'],
  ['consultant_assignments', 'status'], ['consultant_assignments', 'left_date'],
  ['subvendor_invoices', 'paid_date'], ['subvendor_invoices', 'overrides_ledger'],
  ['ledger_roster_entries', 'year_text'], ['ledger_roster_entries', 'unpaid'],
];

router.get('/', async (req, res) => {
  const out = { commit: gitCommit(), nodeEnv: process.env.NODE_ENV || null, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() };
  try { out.fingerprint = fingerprint(); } catch (e) { out.fingerprint = null; }
  try {
    const [cols] = await pool.query(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN (?)`,
      [[...new Set(NEEDED.map((n) => n[0]))]]);
    const have = new Set(cols.map((r) => r.t + '.' + r.c));
    out.schema = { ok: NEEDED.every(([t, c]) => have.has(t + '.' + c)), missing: NEEDED.filter(([t, c]) => !have.has(t + '.' + c)).map(([t, c]) => t + '.' + c) };
    const [tbl] = await pool.query(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'client_text_aliases'`);
    out.schema.clientTextAliasesTable = tbl.length > 0;
    const [en] = await pool.query(`SELECT column_type AS ct FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'subvendor_invoices' AND column_name = 'rate_source'`);
    out.schema.rateSourceHasHoursFile = !!en.length && /hours_file/.test(en[0].ct);
    const [pt] = await pool.query(`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('record_profiles','record_secrets','record_notes','record_forms')`);
    out.schema.profileTables = pt[0].n === 4;
    out.fieldEncryptionConfigured = require('../crypto').isConfigured();
    const [ee] = await pool.query(`SELECT column_type AS ct FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'record_profiles' AND column_name = 'entity'`);
    out.schema.supplierProfiles = !!ee.length && /subvendors/.test(ee[0].ct);
    if (!out.schema.profileTables || !out.schema.supplierProfiles) out.schema.ok = false;
    if (!out.schema.clientTextAliasesTable || !out.schema.rateSourceHasHoursFile) out.schema.ok = false;
  } catch (e) { out.schema = { ok: false, error: 'could not read the database schema' }; }
  res.set('Cache-Control', 'no-store').json(out);
});

module.exports = router;
