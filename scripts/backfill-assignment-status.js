require('dotenv').config();
const mysql = require('mysql2/promise');

// One-time backfill for consultant_assignments.status / left_date (see
// db/schema.sql). Assignments created before those columns existed all read
// 'active'. This replays each organization's LATEST Margin upload: a
// consultant/client/program pairing the file lists only with non-Active rows
// becomes 'left' (left_date = the latest left date on its rows); one with at
// least one Active row stays 'active'. Pairings the latest file doesn't
// mention, and hand-added (source = 'manual') ones, are left alone.
// Re-uploading the Margin file does the same thing; this just avoids needing to.
// Safe to run more than once.
async function main() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const [orgs] = await pool.query('SELECT DISTINCT organization_id FROM margin_imports');
  let changed = 0;
  for (const { organization_id: orgId } of orgs) {
    const [[latest]] = await pool.query(
      'SELECT id FROM margin_imports WHERE organization_id = ? ORDER BY imported_at DESC, id DESC LIMIT 1', [orgId]);
    const [pairs] = await pool.query(
      `SELECT consultant_id, client_id, program_id,
              MAX(status = 'Active') AS any_active, MAX(left_date) AS left_date
       FROM margin_roster_entries
       WHERE import_id = ? AND organization_id = ? AND consultant_id IS NOT NULL
       GROUP BY consultant_id, client_id, program_id`,
      [latest.id, orgId]);
    for (const p of pairs) {
      const status = p.any_active ? 'active' : 'left';
      const [res] = await pool.query(
        `UPDATE consultant_assignments SET status = ?, left_date = ?
         WHERE organization_id = ? AND source = 'upload' AND consultant_id = ?
           AND client_id <=> ? AND program_id <=> ? AND (status <> ? OR NOT (left_date <=> ?))`,
        [status, p.any_active ? null : p.left_date, orgId, p.consultant_id, p.client_id, p.program_id, status, p.any_active ? null : p.left_date]);
      changed += res.affectedRows;
    }
  }
  console.log(`Updated ${changed} assignment(s).`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
