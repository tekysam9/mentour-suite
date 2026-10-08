require('dotenv').config();
const mysql = require('mysql2/promise');

// Removes ALL client invoices (the Fin-Module "Client invoices" table, i.e.
// the `invoices` table) so you can start over, e.g. before importing real
// hours. Nothing else is touched: consultants, clients, programs, billing
// assignments, Ledger/Margin uploads and Subvendor payments are all kept.
//
//   npm run delete-client-invoices                 # dry run: only shows what would go
//   npm run delete-client-invoices -- --yes        # actually deletes
//   npm run delete-client-invoices -- --yes --org 3   # only organization 3
//   npm run delete-client-invoices -- --yes --include-subvendor-generated
//        # ALSO deletes the invoices you generated on the Subvendor payments
//        # tab (subvendor_invoices). The paid history read from the Ledger file
//        # is not stored there and is unaffected.
//
// This cannot be undone -- back up the database first if in doubt.
async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const includeSv = args.includes('--include-subvendor-generated');
  const orgIdx = args.indexOf('--org');
  const orgId = orgIdx > -1 ? Number(args[orgIdx + 1]) : null;
  if (orgIdx > -1 && !Number.isInteger(orgId)) throw new Error('--org needs a number');

  const pool = await mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const where = orgId ? 'WHERE organization_id = ?' : '';
  const params = orgId ? [orgId] : [];

  const tables = [['invoices', 'client invoices']];
  if (includeSv) tables.push(['subvendor_invoices', 'generated subvendor invoices']);

  for (const [table, label] of tables) {
    const [rows] = await pool.query(
      `SELECT o.id, o.name, COUNT(*) AS n FROM ${table} t JOIN organizations o ON o.id = t.organization_id ${orgId ? 'WHERE t.organization_id = ?' : ''} GROUP BY o.id, o.name ORDER BY o.id`,
      params);
    const total = rows.reduce((t, r) => t + Number(r.n), 0);
    console.log(`${label}: ${total} row(s)` + rows.map((r) => `\n  org ${r.id} (${r.name}): ${r.n}`).join(''));
    if (yes && total) {
      const [res] = await pool.query(`DELETE FROM ${table} ${where}`, params);
      console.log(`  -> deleted ${res.affectedRows}`);
    }
  }
  if (!yes) console.log('\nDry run only. Re-run with --yes to delete.');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
