require('dotenv').config();
const mysql = require('mysql2/promise');

// Undoes the Fin-Module "Import hours" workbook import: deletes the client
// invoices it created (invoices.source = 'hours_file') and the subvendor
// invoices it created (subvendor_invoices.rate_source = 'hours_file' that
// have not been edited to another source). Invoices you generated yourself,
// and consultants / clients / programs / pairings / subvendors that the import
// added to Directory, are left alone (remove those from the Directory page).
//
//   npm run undo-hours-import                 # dry run: only counts
//   npm run undo-hours-import -- --yes        # deletes
//   npm run undo-hours-import -- --yes --org 3
// This cannot be undone -- back up first if in doubt.
async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const orgIdx = args.indexOf('--org');
  const orgId = orgIdx > -1 ? Number(args[orgIdx + 1]) : null;
  if (orgIdx > -1 && !Number.isInteger(orgId)) throw new Error('--org needs a number');
  const pool = await mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const targets = [['invoices', "source = 'hours_file'", 'client invoices'], ['subvendor_invoices', "rate_source = 'hours_file'", 'subvendor invoices']];
  for (const [table, cond, label] of targets) {
    const where = cond + (orgId ? ' AND organization_id = ?' : '');
    const params = orgId ? [orgId] : [];
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params);
    console.log(`${label} from the hours import: ${n}`);
    if (yes && n) {
      const [res] = await pool.query(`DELETE FROM ${table} WHERE ${where}`, params);
      console.log(`  -> deleted ${res.affectedRows}`);
    }
  }
  if (!yes) console.log('\nDry run only. Re-run with --yes to delete.');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
