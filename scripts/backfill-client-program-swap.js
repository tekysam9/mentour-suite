require('dotenv').config();
const mysql = require('mysql2/promise');
const { normalizeName, findOrCreateDirectoryRecord, setDirectoryStatus } = require('../src/routes/directoryUpsert');
const { resolveClientProgram } = require('../src/routes/marginRoster');

// One-time fix for organizations that had Margin files uploaded *before*
// the Client/Program mapping correction (see db/schema.sql's Directory
// comment and marginRoster.js's field-mapping comment): the Directory used
// to build `clients` from the pre-slash Program value and `programs` from
// the post-slash detail, which is backwards from the real-world meaning —
// for "Wipro/TD Bank", "TD Bank" is the real client and "Wipro" is the
// program/engagement under it, not the other way round.
//
// It doesn't need to re-parse any Excel file: each upload's
// client/program/client_detail text is still stored in
// margin_roster_entries, so this replays that history — oldest import
// first, rows in file order — and brings the database to the state a fresh
// re-upload of every stored file, in order, under the current code would
// produce:
//
//   * Client/Program for every row comes from resolveClientProgram()
//     (marginRoster.js), the same rule new uploads use. That matters for
//     rows uploaded before public/margin.html started sending the
//     post-slash text as `client`: their `client` column still holds the
//     raw "Wipro/TD Bank" text, and only client_detail ("TD Bank") is the
//     real client. Those rows' stored `client` text is also rewritten to
//     the resolved name, so they read like any newer row (the Directory's
//     "Seen in" panel shows it as "client / program").
//   * Client/program status: whatever the most recent import naming that
//     record says, Active winning within one import — the same result the
//     upload code gives, written once (and only if it changes).
//   * Billing assignments (consultant_assignments) with source = 'upload'
//     end up as exactly one row per (consultant, client, program) pairing
//     the stored rows name, billed at the rate of the latest row naming it.
//     Upload rows for pairings no stored row produces any more (the old
//     reversed client/program ones) are removed. Assignments someone added
//     or edited by hand (source = 'manual') are never touched — if one
//     already covers a pairing, no upload copy is added next to it.
//   * New clients/programs get the same smart-parser duplicate scan a new
//     upload would run, and only those (see directoryUpsert.js).
//
// Safe to run more than once: everything is recomputed from the stored
// source text and only written where it differs, so a second run changes
// nothing.
//
// Run this once, after deploying the corrected code, against the same
// database the app uses:
//   node scripts/backfill-client-program-swap.js
//
// It does NOT delete any directory record (clients/programs). Old rows
// created under the previous (wrong) mapping are left in the database — in
// case someone had already added contact details to one by hand — and are
// only pointed away from. At the end, the script prints any
// clients/programs rows that are now unreferenced, so they can be reviewed
// on the Directory page and removed by hand if they really are leftover
// cruft from the old mapping.

function bumpStatus(map, key, rowStatus) {
  if (!key) return;
  const isActive = rowStatus === 'Active';
  map.set(key, map.get(key) === 'active' || isActive ? 'active' : 'inactive');
}

function toBilling(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sameBilling(a, b) {
  const x = toBilling(a), y = toBilling(b);
  return x === null ? y === null : y !== null && Math.round(x * 100) === Math.round(y * 100);
}

async function backfillOrg(conn, organizationId) {
  const stats = {
    rosterRows: 0, rosterRepointed: 0, legacyClientText: 0,
    clientsCreated: 0, programsCreated: 0, statusChanges: 0,
    assignmentsInserted: 0, assignmentsUpdated: 0, assignmentsDeleted: 0, manualKept: 0,
  };

  await conn.beginTransaction();
  try {
    // Oldest import first, rows in their saved (file) order.
    const [rows] = await conn.query(
      `SELECT mre.id, mre.import_id, mre.consultant_id, mre.client, mre.program, mre.client_detail,
              mre.status, mre.billing, mre.client_id, mre.program_id
         FROM margin_roster_entries mre
         JOIN margin_imports mi ON mi.id = mre.import_id
        WHERE mre.organization_id = ?
        ORDER BY mi.imported_at, mi.id, mre.id`,
      [organizationId]
    );
    stats.rosterRows = rows.length;

    const imports = [];
    for (const r of rows) {
      if (!imports.length || imports[imports.length - 1].importId !== r.import_id) imports.push({ importId: r.import_id, rows: [] });
      imports[imports.length - 1].rows.push(r);
    }

    const clientIds = new Map(); // normalized client name -> id
    const programIds = new Map(); // "clientId|normalized program name" -> id
    const clientFinalStatus = new Map(); // id -> status (last write wins, like sequential uploads)
    const programFinalStatus = new Map();
    const rowTargets = []; // [row, clientId, programId, clientText]
    const desired = new Map(); // "consultant|client|program" -> { consultantId, clientId, programId, billing }

    for (const imp of imports) {
      // Mirrors saveMarginRoster for one upload: statuses settled for the
      // whole import first, then each distinct name resolved in row order.
      const resolved = imp.rows.map((r) => resolveClientProgram({ client: r.client, program: r.program, clientDetail: r.client_detail }));
      const clientStatus = new Map();
      const programStatus = new Map();
      imp.rows.forEach((r, i) => {
        const clientKey = normalizeName(resolved[i].clientName);
        bumpStatus(clientStatus, clientKey, r.status);
        const programNameKey = normalizeName(resolved[i].programName);
        if (clientKey && programNameKey) bumpStatus(programStatus, clientKey + '|' + programNameKey, r.status);
      });

      const seenClients = new Set();
      const seenPrograms = new Set();
      for (let i = 0; i < imp.rows.length; i++) {
        const r = imp.rows[i];
        const { clientName, programName } = resolved[i];

        const clientKey = normalizeName(clientName);
        let clientId = null;
        if (clientKey) {
          if (!clientIds.has(clientKey)) {
            const rec = await findOrCreateDirectoryRecord(conn, 'clients', { organizationId, name: clientName, status: clientStatus.get(clientKey) });
            if (rec.created) stats.clientsCreated++;
            clientIds.set(clientKey, rec.id);
          }
          clientId = clientIds.get(clientKey);
          if (!seenClients.has(clientKey)) {
            seenClients.add(clientKey);
            clientFinalStatus.set(clientId, clientStatus.get(clientKey));
          }
        }

        const programNameKey = normalizeName(programName);
        let programId = null;
        if (clientId && programNameKey) {
          const programKey = clientId + '|' + programNameKey;
          if (!programIds.has(programKey)) {
            const rec = await findOrCreateDirectoryRecord(conn, 'programs', {
              organizationId, clientId, name: programName, status: programStatus.get(clientKey + '|' + programNameKey),
            });
            if (rec.created) stats.programsCreated++;
            programIds.set(programKey, rec.id);
          }
          programId = programIds.get(programKey);
          if (!seenPrograms.has(programKey)) {
            seenPrograms.add(programKey);
            programFinalStatus.set(programId, programStatus.get(clientKey + '|' + programNameKey));
          }
        }

        rowTargets.push([r, clientId, programId, clientName]);

        if (r.consultant_id) {
          const key = [r.consultant_id, clientId, programId].join('|');
          desired.set(key, { consultantId: r.consultant_id, clientId, programId, billing: toBilling(r.billing) });
        }
      }
    }

    for (const [id, status] of clientFinalStatus) {
      if (await setDirectoryStatus(conn, 'clients', id, status)) stats.statusChanges++;
    }
    for (const [id, status] of programFinalStatus) {
      if (await setDirectoryStatus(conn, 'programs', id, status)) stats.statusChanges++;
    }

    for (const [r, clientId, programId, clientText] of rowTargets) {
      const repoint = r.client_id !== clientId || r.program_id !== programId;
      const legacyText = r.client !== clientText;
      if (!repoint && !legacyText) continue;
      if (repoint) stats.rosterRepointed++;
      if (legacyText) stats.legacyClientText++;
      await conn.query('UPDATE margin_roster_entries SET client_id = ?, program_id = ?, client = ? WHERE id = ?', [clientId, programId, clientText, r.id]);
    }

    // Billing assignments: see the header comment.
    const [existing] = await conn.query(
      `SELECT id, consultant_id, client_id, program_id, billing, source
         FROM consultant_assignments WHERE organization_id = ? ORDER BY id`,
      [organizationId]
    );
    const byPairing = new Map();
    for (const a of existing) {
      const key = [a.consultant_id, a.client_id, a.program_id].join('|');
      if (!byPairing.has(key)) byPairing.set(key, []);
      byPairing.get(key).push(a);
    }
    const keepIds = new Set();
    for (const [key, d] of desired) {
      const matches = byPairing.get(key) || [];
      const uploadRow = matches.find((a) => a.source === 'upload');
      if (uploadRow) {
        keepIds.add(uploadRow.id);
        if (!sameBilling(uploadRow.billing, d.billing)) {
          await conn.query('UPDATE consultant_assignments SET billing = ? WHERE id = ?', [d.billing, uploadRow.id]);
          stats.assignmentsUpdated++;
        }
      } else if (matches.some((a) => a.source === 'manual')) {
        stats.manualKept++;
      } else {
        await conn.query(
          `INSERT INTO consultant_assignments (organization_id, consultant_id, client_id, program_id, billing, source)
           VALUES (?, ?, ?, ?, ?, 'upload')`,
          [organizationId, d.consultantId, d.clientId, d.programId, d.billing]
        );
        stats.assignmentsInserted++;
      }
    }
    for (const a of existing) {
      if (a.source === 'upload' && !keepIds.has(a.id)) {
        await conn.query('DELETE FROM consultant_assignments WHERE id = ?', [a.id]);
        stats.assignmentsDeleted++;
      }
    }

    await conn.commit();
    return stats;
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

async function findOrphans(conn, organizationId) {
  // A client only really counts as unreferenced if none of its programs are
  // referenced either — a client whose sole remaining program is itself
  // still in use (or itself only reachable through that client) shouldn't
  // be reported as safe to delete.
  const [orphanClients] = await conn.query(
    `SELECT c.id, c.name FROM clients c
      WHERE c.organization_id = ?
        AND NOT EXISTS (SELECT 1 FROM margin_roster_entries m WHERE m.client_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM consultant_assignments a WHERE a.client_id = c.id)
        AND NOT EXISTS (
          SELECT 1 FROM programs p
           WHERE p.client_id = c.id
             AND (EXISTS (SELECT 1 FROM margin_roster_entries m2 WHERE m2.program_id = p.id)
                  OR EXISTS (SELECT 1 FROM consultant_assignments a2 WHERE a2.program_id = p.id))
        )
      ORDER BY c.id`,
    [organizationId]
  );
  const [orphanPrograms] = await conn.query(
    `SELECT p.id, p.name, p.client_id, c.name AS client_name FROM programs p
       JOIN clients c ON c.id = p.client_id
      WHERE p.organization_id = ?
        AND NOT EXISTS (SELECT 1 FROM margin_roster_entries m WHERE m.program_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM consultant_assignments a WHERE a.program_id = p.id)
      ORDER BY p.id`,
    [organizationId]
  );
  return { orphanClients, orphanPrograms };
}

async function runBackfill(conn, log = console.log) {
  const [orgs] = await conn.query('SELECT id, name FROM organizations ORDER BY id');
  const results = [];
  const allOrphans = [];

  for (const org of orgs) {
    const s = await backfillOrg(conn, org.id);
    results.push({ org, stats: s });
    if (s.rosterRows || s.assignmentsDeleted) {
      log(
        `Org ${org.id} (${org.name}): checked ${s.rosterRows} roster row(s); ` +
          `repointed ${s.rosterRepointed}, rewrote legacy client text on ${s.legacyClientText}; ` +
          `created ${s.clientsCreated} client(s) and ${s.programsCreated} program(s); ` +
          `${s.statusChanges} status change(s); billing assignments: ${s.assignmentsInserted} added, ` +
          `${s.assignmentsUpdated} updated, ${s.assignmentsDeleted} stale removed` +
          (s.manualKept ? `, ${s.manualKept} pairing(s) left to an existing manual assignment` : '') + '.'
      );
    }
    const { orphanClients, orphanPrograms } = await findOrphans(conn, org.id);
    if (orphanClients.length || orphanPrograms.length) {
      allOrphans.push({ org, orphanClients, orphanPrograms });
    }
  }

  log('\nDone.');

  if (allOrphans.length) {
    log(
      '\nThe following Directory records are no longer referenced by any upload after this fix.\n' +
        'They were most likely created under the old (reversed) Client/Program mapping — review them on\n' +
        'the Directory page and remove any that really are leftover cruft (nothing was deleted automatically,\n' +
        'in case contact details had already been added to one of them by hand):\n'
    );
    for (const { org, orphanClients, orphanPrograms } of allOrphans) {
      log(`Org ${org.id} (${org.name}): ${orphanClients.length} client(s), ${orphanPrograms.length} program(s)`);
      for (const c of orphanClients) log(`  - Client #${c.id}: "${c.name}"`);
      for (const p of orphanPrograms) log(`  - Program #${p.id}: "${p.name}" (under client #${p.client_id} "${p.client_name}")`);
    }
  } else {
    log('No leftover unreferenced clients/programs found.');
  }
  return { results, orphans: allOrphans };
}

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4_unicode_ci',
  });

  const conn = await pool.getConnection();
  try {
    await runBackfill(conn);
  } finally {
    conn.release();
    await pool.end();
  }
}

module.exports = { runBackfill, backfillOrg, findOrphans };

if (require.main === module) {
  main().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
}
