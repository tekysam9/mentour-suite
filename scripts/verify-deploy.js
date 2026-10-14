// Compares a live site's /api/version with this checkout (same fingerprint
// algorithm). Usage: node scripts/verify-deploy.js https://utils.mentourcorp.com
const base = (process.argv[2] || '').replace(/\/$/, '');
if (!base) { console.error('usage: node scripts/verify-deploy.js <site url>'); process.exit(2); }
process.env.DB_HOST = process.env.DB_HOST || 'x'; // db pool is lazy; never connects here
const crypto = require('crypto'); const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
function walk(d, exts, out) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, exts, out); else if (exts.some((x) => e.name.endsWith(x))) out.push(p); } return out; }
function hashFiles(files) { const h = crypto.createHash('sha256'); const per = {}; for (const f of files.sort()) { const rel = path.relative(ROOT, f).split(path.sep).join('/'); const fh = crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex'); per[rel] = fh.slice(0, 12); h.update(rel + ':' + fh + '\n'); } return { overall: h.digest('hex').slice(0, 16), files: per }; }
(async () => {
  const live = await (await fetch(base + '/api/version')).json();
  const mine = { server: hashFiles(walk(path.join(ROOT, 'src'), ['.js'], []).concat([path.join(ROOT, 'server.js')])), public: hashFiles(walk(path.join(ROOT, 'public'), ['.js', '.html', '.css'], [])), schemaFile: hashFiles([path.join(ROOT, 'db', 'schema.sql')]) };
  let bad = 0;
  for (const g of ['server', 'public', 'schemaFile']) {
    const a = live.fingerprint && live.fingerprint[g], b = mine[g];
    if (a && a.overall === b.overall) { console.log('MATCH  ' + g); continue; }
    bad++; console.log('DIFF   ' + g);
    const keys = new Set(Object.keys(b.files).concat(a ? Object.keys(a.files) : []));
    for (const k of keys) if (!a || a.files[k] !== b.files[k]) console.log('   ' + k + (a && a.files[k] ? '' : ' (missing on live)'));
  }
  console.log('schema ok:', live.schema && live.schema.ok, live.schema && live.schema.missing && live.schema.missing.length ? 'missing ' + live.schema.missing.join(', ') : '');
  if (!live.schema || !live.schema.ok) bad++;
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(2); });
