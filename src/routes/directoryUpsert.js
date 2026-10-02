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
// How a record is resolved (findOrCreateDirectoryRecord):
//   1. Look the name up by the table's unique key. If it's there, that's
//      the record — nothing is written.
//   2. Otherwise insert it. The insert still uses
//      ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), so if another save
//      created the same name in between steps 1 and 2 we get that row's id
//      back instead of an error (insertId is the existing row's id on a
//      duplicate-key hit, not just on a fresh insert).
// Only a record that didn't exist at step 1 gets the smart-parser duplicate
// scan, since an existing exact-name match was never a duplicate to begin
// with.
//
// (This used to be a single INSERT ... ON DUPLICATE KEY UPDATE whose
// affectedRows told a new row from an existing one. That doesn't work:
// mysql2 connects with the CLIENT_FOUND_ROWS flag, under which an
// existing row whose status didn't change also reports affectedRows = 1 —
// the same as a fresh insert — so every re-upload re-ran the duplicate
// scan for every existing name and re-opened flags, e.g. the reverse
// direction of a pair someone had already dismissed.)
//
// `status` ('active' | 'inactive') is passed in by the caller (already
// resolved from that import's data — see marginRoster.js/ledgerRoster.js)
// and *is* overwritten on every save, unlike the contact fields: it's meant
// to always reflect the most recent upload, not something a person edits by
// hand on the Directory page. It's only written when it actually differs,
// so a save that changes nothing leaves updated_at alone.

const { flagLikelyDuplicates } = require('./directoryDedup');

function normalizeName(name) {
  if (name === null || name === undefined) return null;
  const s = String(name).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 255) : null;
}

function normalizeStatus(status) {
  return status === 'active' ? 'active' : 'inactive';
}

const DIRECTORY_TABLES = ['consultants', 'subvendors', 'clients', 'programs'];

// Resolves `name` to a record id in `tableName` (programs are keyed per
// client, so they need `clientId`), creating the record — with `status` —
// if it doesn't exist yet. An existing record is returned as-is: this never
// changes an existing row (see setDirectoryStatus for that).
// Returns { id, status, created } or null when there's no usable name.
async function findOrCreateDirectoryRecord(conn, tableName, { organizationId, clientId, name, status }) {
  if (!DIRECTORY_TABLES.includes(tableName)) throw new Error('Unknown directory table: ' + tableName);
  const n = normalizeName(name);
  if (!n) return null;
  const isProgram = tableName === 'programs';
  if (isProgram && !clientId) return null;
  const st = normalizeStatus(status);

  const [found] = await conn.query(
    isProgram
      ? `SELECT id, status FROM programs WHERE client_id = ? AND name = ? LIMIT 1`
      : `SELECT id, status FROM ${tableName} WHERE organization_id = ? AND name = ? LIMIT 1`,
    isProgram ? [clientId, n] : [organizationId, n]
  );
  if (found.length) return { id: found[0].id, status: found[0].status, created: false };

  const [result] = await conn.query(
    isProgram
      ? `INSERT INTO programs (organization_id, client_id, name, status) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`
      : `INSERT INTO ${tableName} (organization_id, name, status) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    isProgram ? [organizationId, clientId, n, st] : [organizationId, n, st]
  );
  const id = result.insertId;
  await flagLikelyDuplicates(conn, {
    organizationId, tableName, newId: id, newName: n, scopeClientId: isProgram ? clientId : undefined,
  });
  return { id, status: st, created: true };
}

// Sets a record's status, writing only if it actually changes.
async function setDirectoryStatus(conn, tableName, id, status) {
  if (!DIRECTORY_TABLES.includes(tableName)) throw new Error('Unknown directory table: ' + tableName);
  const st = normalizeStatus(status);
  const [result] = await conn.query(`UPDATE ${tableName} SET status = ? WHERE id = ? AND status <> ?`, [st, id, st]);
  return result.affectedRows > 0;
}

async function upsertDirectoryRecord(conn, tableName, fields) {
  const rec = await findOrCreateDirectoryRecord(conn, tableName, fields);
  if (!rec) return null;
  const st = normalizeStatus(fields.status);
  if (!rec.created && rec.status !== st) await setDirectoryStatus(conn, tableName, rec.id, st);
  return rec.id;
}

async function upsertConsultant(conn, organizationId, name, status) {
  return upsertDirectoryRecord(conn, 'consultants', { organizationId, name, status });
}

async function upsertSubvendor(conn, organizationId, name, status) {
  return upsertDirectoryRecord(conn, 'subvendors', { organizationId, name, status });
}

async function upsertClient(conn, organizationId, name, status) {
  return upsertDirectoryRecord(conn, 'clients', { organizationId, name, status });
}

async function upsertProgram(conn, organizationId, clientId, name, status) {
  return upsertDirectoryRecord(conn, 'programs', { organizationId, clientId, name, status });
}

module.exports = {
  normalizeName, normalizeStatus, findOrCreateDirectoryRecord, setDirectoryStatus,
  upsertConsultant, upsertSubvendor, upsertClient, upsertProgram,
};
