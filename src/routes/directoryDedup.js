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

// Words that only say what kind of legal entity a company is; "Acme Corp" and "Acme, Inc." are one name.
const LEGAL = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'llp', 'lp', 'pllc', 'pc', 'plc', 'gmbh', 'pvt', 'private', 'sa', 'ag', 'bv', 'the']);
const tokensOf = (folded) => folded.split(' ').filter((t) => t && !LEGAL.has(t));

function similarity(nameA, nameB) {
  const a = foldName(nameA), b = foldName(nameB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = tokensOf(a), tb = tokensOf(b);
  if (ta.length && ta.join(' ') === tb.join(' ')) return 0.97; // same name apart from Inc / LLC / Ltd ...
  // One name is the start of the other: "Alef Data" vs "Alef Data Integration Ltd".
  const [s, l] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (s.length && l.length > s.length && s.every((t, i) => t === l[i]) && (s.length >= 2 || s[0].length >= 5)) return 0.9;
  const maxLen = Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) / maxLen > 0.3) return 0; // too different in length to be a typo
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

// Compares every pair of existing records in `tableName` (programs: within a client) and opens a
// flag for each close pair that has never been flagged. Pairs someone already merged, dismissed or
// has open are left alone. Safe to run any time. Returns how many new flags were opened.
async function scanDuplicates(conn, organizationId, tableName) {
  if (!TABLES.includes(tableName)) return 0;
  const [rows] = await conn.query(`SELECT id, name${tableName === 'programs' ? ', client_id' : ''} FROM ${tableName} WHERE organization_id = ? ORDER BY id`, [organizationId]);
  const [seen] = await conn.query('SELECT record_id, matched_record_id FROM directory_duplicate_candidates WHERE organization_id = ? AND table_name = ?', [organizationId, tableName]);
  const have = new Set(seen.map((x) => Math.min(x.record_id, x.matched_record_id) + ':' + Math.max(x.record_id, x.matched_record_id)));
  const folded = rows.map((r) => ({ id: r.id, name: r.name, scope: r.client_id || 0, f: foldName(r.name) }));
  let opened = 0;
  for (let i = 0; i < folded.length; i++) {
    for (let j = i + 1; j < folded.length; j++) {
      const x = folded[i], y = folded[j];
      if (x.scope !== y.scope || !x.f || !y.f) continue;
      if (have.has(x.id + ':' + y.id)) continue;
      const score = similarity(x.name, y.name);
      if (score >= SIMILARITY_THRESHOLD && score < 1) {
        await conn.query(
          `INSERT IGNORE INTO directory_duplicate_candidates (organization_id, table_name, record_id, matched_record_id, similarity) VALUES (?, ?, ?, ?, ?)`,
          [organizationId, tableName, y.id, x.id, score.toFixed(3)]);
        opened += 1;
      }
    }
  }
  return opened;
}

module.exports = { foldName, levenshtein, similarity, flagLikelyDuplicates, scanDuplicates, SIMILARITY_THRESHOLD, TABLES };
