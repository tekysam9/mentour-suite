require('dotenv').config();
const mysql = require('mysql2/promise');
const { normalizeName, upsertClient, upsertProgram } = require('../src/routes/directoryUpsert');
const { upsertAssignmentBilling } = require('../src/routes/assignmentUpsert');

// One-time fix for organizations that had Margin files uploaded *before*
// the Client/Program mapping correction (see db/schema.sql's Directory
// comment and marginRoster.js's field-mapping comment): the Directory used
// to build `clients` from the pre-slash Program value and `programs` from
// the post-slash detail, which is backwards from the real-world meaning —
// for "Wipro/TD Bank", "TD Bank" is the real client and "Wipro" is the
// program/engagement under it, not the other way round.
//
// This script recomputes the correct client_id/program_id for every
// historical margin roster row and billing assignment. It doesn't need to
// re-parse any Excel file: the original client/program/client_detail text
// from each upload is still sitting in margin_roster_entries untouched, so
// it replays that history through the same upsert helpers the app already
// uses for new uploads (so status and billing come out exactly as if the
// files had been uploaded again in order, under the corrected mapping).
//
// Safe to run more than once: each run recomputes from the stored source
// text rather than transforming existing ids, so a second run is a no-op.
//
// Run this once, after deploying the corrected code, against the same
// database the app uses:
//   node scripts/backfill-client-program-swap.js
//
// It does NOT delete anything. Old clients/programs rows created under the
// previous (wrong) mapping are left in the database — in case someone had
// already added contact details to one by hand — and are only pointed away
// from by every margin_roster_entries/consultant_assignments row once this
// finishes. At the end, the script prints any clients/programs rows that
// are now unreferenced, so they can be reviewed on the Directory page and
// removed by hand if they really are leftover cruft from the old mapping.

function bumpStatus(map, key, rowStatus) {
  if (!key) return;
  const isActive = rowStatus === 'Active';
  map.set(key, map.get(key) === 'active' || isActive ? 'active' : 'inactive');
}

async function backfillOrg(conn, organizationId) {
  // Oldest import first, so replaying rows reproduces "the latest upload
  // wins" for status and billing exactly as real sequential uploads would.
  const [rows] = await conn.query(
    `SELECT mre.id, mre.consultant_id, mre.client, mre.program, mre.client_detail, mre.status, mre.billing
       FROM margin_roster_entries mre
       JOIN margin_imports mi ON mi.id = mre.import_id
      WHERE mre.organization_id = ?
      ORDER BY mi.imported_at, mi.id, mre.id`,
    [organizationId]
  );
  if (!rows.length) return { rosterRows: 0, clients: 0, programs: 0 };

  await conn.beginTransaction();
  try {
    const clientStatus = new Map();
    const programStatus = new Map(); // "clientKey|programNameKey" -> status

    for (const r of rows) {
      const clientKey = normalizeName(r.client);
      bumpStatus(clientStatus, clientKey, r.status);
      const programNameKey = r.client_detail ? normalizeName(r.program) : null;
      if (clientKey && programNameKey) bumpStatus(programStatus, clientKey + '|' + programNameKey, r.status);
    }

    const clientIds = new Map();
    const programIds = new Map();
    const updates = [];

    for (const r of rows) {
      const clientKey = normalizeName(r.client);
      let clientId = null;
      if (clientKey) {
        if (!clientIds.has(clientKey)) {
          clientIds.set(clientKey, await upsertClient(conn, organizationId, r.client, clientStatus.get(clientKey)));
        }
        clientId = clientIds.get(clientKey);
      }

      const programNameKey = r.client_detail ? normalizeName(r.program) : null;
      let programId = null;
      if (clientId && programNameKey) {
        const programKey = clientId + '|' + programNameKey;
        if (!programIds.has(programKey)) {
          const status = programStatus.get(clientKey + '|' + programNameKey);
          programIds.set(programKey, await upsertProgram(conn, organizationId, clientId, r.program, status));
        }
        programId = programIds.get(programKey);
      }

      updates.push([r.id, clientId, programId]);

      if (r.consultant_id) {
        await upsertAssignmentBilling(conn, {
          organizationId,
          consultantId: r.consultant_id,
          clientId,
          programId,
          billing: r.billing === null ? null : Number(r.billing),
          source: 'upload',
        });
      }
    }

    for (const [id, clientId, programId] of updates) {
      await conn.query('UPDATE margin_roster_entries SET client_id = ?, program_id = ? WHERE id = ?', [clientId, programId, id]);
    }

    await conn.commit();
    return { rosterRows: updates.length, clients: clientIds.size, programs: programIds.size };
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
        )`,
    [organizationId]
  );
  const [orphanPrograms] = await conn.query(
    `SELECT p.id, p.name, p.client_id FROM programs p
      WHERE p.organization_id = ?
        AND NOT EXISTS (SELECT 1 FROM margin_roster_entries m WHERE m.program_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM consultant_assignments a WHERE a.program_id = p.id)`,
    [organizationId]
  );
  return { orphanClients, orphanPrograms };
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
    const [orgs] = await conn.query('SELECT id, name FROM organizations ORDER BY id');
    const allOrphans = [];

    for (const org of orgs) {
      const result = await backfillOrg(conn, org.id);
      if (result.rosterRows) {
        console.log(
          `Org ${org.id} (${org.name}): recomputed ${result.rosterRows} roster row(s), ` +
            `${result.clients} client(s), ${result.programs} program(s).`
        );
      }
      const { orphanClients, orphanPrograms } = await findOrphans(conn, org.id);
      if (orphanClients.length || orphanPrograms.length) {
        allOrphans.push({ org, orphanClients, orphanPrograms });
      }
    }

    console.log('\nDone.');

    if (allOrphans.length) {
      console.log(
        '\nThe following Directory records are no longer referenced by any upload after this fix.\n' +
          'They were most likely created under the old (reversed) Client/Program mapping — review them on\n' +
          'the Directory page and remove any that really are leftover cruft (nothing was deleted automatically,\n' +
          'in case contact details had already been added to one of them by hand):\n'
      );
      for (const { org, orphanClients, orphanPrograms } of allOrphans) {
        console.log(`Org ${org.id} (${org.name}):`);
        for (const c of orphanClients) console.log(`  - Client #${c.id}: "${c.name}"`);
        for (const p of orphanPrograms) console.log(`  - Program #${p.id}: "${p.name}" (under old client_id ${p.client_id})`);
      }
    } else {
      console.log('No leftover unreferenced clients/programs found.');
    }
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
