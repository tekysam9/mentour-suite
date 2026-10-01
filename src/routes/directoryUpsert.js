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
// beyond a plain trim. A name that's merely *close* to an existing one (a
// typo, different punctuation) is handled separately, see below.
//
// The upsert-and-get-id in one round trip relies on a MySQL/MariaDB idiom:
// ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id) makes insertId come back
// as the existing row's id on a duplicate-key hit, not just on a fresh
// insert, and it's atomic against concurrent saves (no read-then-write race).
//
// `status` ('active' | 'inactive') is passed in by the caller (already
// resolved from that import's data — see marginRoster.js/ledgerRoster.js)
// and *is* overwritten on every save, unlike the contact fields: it's meant
// to always reflect the most recent upload, not something a person edits by
// hand on the Directory page. We can tell a plain insert from a
// status-only update by mysql2's affectedRows (1 for a new row, 2 when an
// existing row's status actually changed, 0 when it matched and nothing
// changed) — and only a brand-new row needs the smart-parser duplicate scan,
// since an existing exact-name match was never a duplicate to begin with.

const { flagLikelyDuplicates } = require('./directoryDedup');

function normalizeName(name) {
  if (name === null || name === undefined) return null;
  const s = String(name).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 255) : null;
}

function normalizeStatus(status) {
  return status === 'active' ? 'active' : 'inactive';
}

async function upsertConsultant(conn, organizationId, name, status) {
  const n = normalizeName(name);
  if (!n) return null;
  const st = normalizeStatus(status);
  const [result] = await conn.query(
    `INSERT INTO consultants (organization_id, name, status) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), id = LAST_INSERT_ID(id)`,
    [organizationId, n, st]
  );
  if (result.affectedRows === 1) {
    await flagLikelyDuplicates(conn, { organizationId, tableName: 'consultants', newId: result.insertId, newName: n });
  }
  return result.insertId;
}

async function upsertSubvendor(conn, organizationId, name, status) {
  const n = normalizeName(name);
  if (!n) return null;
  const st = normalizeStatus(status);
  const [result] = await conn.query(
    `INSERT INTO subvendors (organization_id, name, status) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), id = LAST_INSERT_ID(id)`,
    [organizationId, n, st]
  );
  if (result.affectedRows === 1) {
    await flagLikelyDuplicates(conn, { organizationId, tableName: 'subvendors', newId: result.insertId, newName: n });
  }
  return result.insertId;
}

async function upsertClient(conn, organizationId, name, status) {
  const n = normalizeName(name);
  if (!n) return null;
  const st = normalizeStatus(status);
  const [result] = await conn.query(
    `INSERT INTO clients (organization_id, name, status) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), id = LAST_INSERT_ID(id)`,
    [organizationId, n, st]
  );
  if (result.affectedRows === 1) {
    await flagLikelyDuplicates(conn, { organizationId, tableName: 'clients', newId: result.insertId, newName: n });
  }
  return result.insertId;
}

async function upsertProgram(conn, organizationId, clientId, name, status) {
  const n = normalizeName(name);
  if (!n || !clientId) return null;
  const st = normalizeStatus(status);
  const [result] = await conn.query(
    `INSERT INTO programs (organization_id, client_id, name, status) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), id = LAST_INSERT_ID(id)`,
    [organizationId, clientId, n, st]
  );
  if (result.affectedRows === 1) {
    await flagLikelyDuplicates(conn, {
      organizationId, tableName: 'programs', newId: result.insertId, newName: n, scopeClientId: clientId,
    });
  }
  return result.insertId;
}

module.exports = { normalizeName, upsertConsultant, upsertSubvendor, upsertClient, upsertProgram };
