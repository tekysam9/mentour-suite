// Alternate names for a client/program, as they appear in an hours file's
// Client column. The Directory has exactly one name per client/program (its
// duplicate merge folds two records into one and drops the loser's name), so
// a file that writes the same engagement differently -- e.g. "International
// Resource Group/State of RI" for the IRG program under State of RI -- would
// never match. Fin-Module's Import hours lets a person say "this text is that
// pairing" once; the text is saved here (client_text_aliases, db/schema.sql)
// and every later import of the same text resolves to that client/program.
//
// Aliases are per organization and point at a client (+ program); a
// consultant still needs their own billing pairing on that client/program.

const { normalizeName } = require('./directoryUpsert');
const { resolveClientProgram } = require('./marginRoster');

// Case/space-insensitive key: "ROSE/ University of MO" == "rose/university of mo".
function aliasKey(text) {
  const n = normalizeName(text);
  return n ? n.toLowerCase().replace(/\s*\/\s*/g, '/').slice(0, 255) : null;
}

// Splits a Client column value the way the Margin file's "Client / Account"
// is split (public/margin.html + marginRoster.resolveClientProgram): text
// before the first "/" is the program, the rest is the client; no "/" means
// a client with no program.
function splitClientText(text) {
  const raw = normalizeName(text) || '';
  const slash = raw.indexOf('/');
  if (slash < 0) return resolveClientProgram({ client: raw, program: raw, clientDetail: null });
  const program = raw.slice(0, slash).trim();
  const detail = raw.slice(slash + 1).trim();
  if (!detail) return resolveClientProgram({ client: program || raw, program: null, clientDetail: null });
  return resolveClientProgram({ client: detail, program: program || null, clientDetail: detail });
}

function isMissingTable(err) {
  return !!err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146);
}

// alias_key -> { client_id, program_id }. An empty map when the table isn't
// there yet (code deployed before db/schema.sql was re-run), so imports keep
// working exactly as before.
async function loadAliasMap(conn, organizationId) {
  const map = new Map();
  try {
    const [rows] = await conn.query(
      'SELECT alias_key, client_id, program_id FROM client_text_aliases WHERE organization_id = ?',
      [organizationId]
    );
    for (const r of rows) map.set(r.alias_key, { client_id: r.client_id, program_id: r.program_id });
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  return map;
}

const SCHEMA_NEEDED_MESSAGE = 'Saving client name matches needs the latest database update — re-run db/schema.sql, then try again.';

module.exports = { aliasKey, splitClientText, loadAliasMap, isMissingTable, SCHEMA_NEEDED_MESSAGE };
