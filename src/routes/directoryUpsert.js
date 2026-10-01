// Shared "find or create" helpers for the directory tables (consultants,
// subvendors, clients, programs). Used by marginRoster.js and
// ledgerRoster.js while saving an import, so a name seen in an upload
// always resolves to one record per organization — created the first time,
// left untouched (no contact fields overwritten) every time after.
//
// Matching is by exact name after trim + MySQL's default case-insensitive
// comparison (the unique keys use the table's default utf8mb4 collation,
// which is case-insensitive) — not fuzzy. "Jordan Blake" uploaded from both
// Ledger and Margin resolves to the same consultant; "Jordan  Blake" with a
// double space would not, since matching only normalizes case, not spacing
// beyond a plain trim.
//
// The upsert-and-get-id in one round trip relies on a MySQL/MariaDB idiom:
// ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id) makes insertId come back
// as the existing row's id on a duplicate-key hit, not just on a fresh
// insert, and it's atomic against concurrent saves (no read-then-write race).

function normalizeName(name) {
  if (name === null || name === undefined) return null;
  const s = String(name).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 255) : null;
}

async function upsertConsultant(conn, organizationId, name) {
  const n = normalizeName(name);
  if (!n) return null;
  const [result] = await conn.query(
    `INSERT INTO consultants (organization_id, name) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [organizationId, n]
  );
  return result.insertId;
}

async function upsertSubvendor(conn, organizationId, name) {
  const n = normalizeName(name);
  if (!n) return null;
  const [result] = await conn.query(
    `INSERT INTO subvendors (organization_id, name) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [organizationId, n]
  );
  return result.insertId;
}

async function upsertClient(conn, organizationId, name) {
  const n = normalizeName(name);
  if (!n) return null;
  const [result] = await conn.query(
    `INSERT INTO clients (organization_id, name) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [organizationId, n]
  );
  return result.insertId;
}

async function upsertProgram(conn, organizationId, clientId, name) {
  const n = normalizeName(name);
  if (!n || !clientId) return null;
  const [result] = await conn.query(
    `INSERT INTO programs (organization_id, client_id, name) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [organizationId, clientId, n]
  );
  return result.insertId;
}

module.exports = { normalizeName, upsertConsultant, upsertSubvendor, upsertClient, upsertProgram };
