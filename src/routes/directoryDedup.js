// The "smart parser" duplicate check. An exact name match (normalizeName in
// directoryUpsert.js -- trim + collapse whitespace + MySQL's case-insensitive
// collation) always resolves to the one existing record; this module only
// runs on a name that *didn't* match anything exactly and so just became a
// brand-new row. It compares that new name against every other name of the
// same type in the same organization (same client, for a program) and flags
// a close-but-not-identical match -- a likely typo or formatting slip, e.g.
// "Jon Smith" vs "John Smith", or "Acme Corp" vs "Acme Corp." -- for a
// person to confirm or dismiss on the Directory page.
//
// This never merges on its own. Two different people can genuinely share a
// very similar name, and only a person looking at both records (what else
// they're linked to, whether the contact details make sense) can tell the
// difference safely.

const TABLES = ['consultants', 'subvendors', 'clients', 'programs'];

// How similar two names have to be (1 = identical) before they're flagged.
// Picked so a single typo/missing letter in an average-length name (roughly
// 8-20 characters) crosses it, but two merely-short or coincidentally
// similar names don't.
const SIMILARITY_THRESHOLD = 0.82;

function foldName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip accents (e.g. "José" -> "jose")
    .replace(/[^a-z0-9\s]/g, '') // drop punctuation: periods, apostrophes, hyphens, commas...
    .replace(/\s+/g, ' ')
    .trim();
}

// Classic edit-distance, iterative two-row version (no need for the full
// matrix -- these are short strings, but this keeps memory flat either way).
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[bl];
}

function similarity(nameA, nameB) {
  const a = foldName(nameA), b = foldName(nameB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

// Scans existing rows of `tableName` (scoped to the organization, and to
// `scopeClientId` for programs, since program names are only unique per
// client) for anything close to `newName`, and records an open candidate
// row for each one found. Called right after a brand-new row is inserted --
// see directoryUpsert.js, which only calls this when the insert created a
// new record rather than matching an existing one.
async function flagLikelyDuplicates(conn, { organizationId, tableName, newId, newName, scopeClientId }) {
  if (!TABLES.includes(tableName)) return;
  let sql = `SELECT id, name FROM ${tableName} WHERE organization_id = ? AND id != ?`;
  const params = [organizationId, newId];
  if (tableName === 'programs') {
    sql += ' AND client_id = ?';
    params.push(scopeClientId);
  }
  const [rows] = await conn.query(sql, params);

  for (const row of rows) {
    const score = similarity(newName, row.name);
    if (score >= SIMILARITY_THRESHOLD && score < 1) {
      await conn.query(
        `INSERT IGNORE INTO directory_duplicate_candidates
           (organization_id, table_name, record_id, matched_record_id, similarity)
         VALUES (?, ?, ?, ?, ?)`,
        [organizationId, tableName, newId, row.id, score.toFixed(3)]
      );
    }
  }
}

module.exports = { foldName, levenshtein, similarity, flagLikelyDuplicates, SIMILARITY_THRESHOLD, TABLES };
