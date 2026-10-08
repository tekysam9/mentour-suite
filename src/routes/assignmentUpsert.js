// "Find or set" helper for consultant_assignments: one row per (consultant,
// client, program) billing pairing. Called from marginRoster.js for every
// row in a Margin upload, and from the manual add-assignment route in
// directory.js (see directory.js's POST /consultants/:id/assignments).
//
// Matching uses MySQL's NULL-safe equality (<=>) since client_id/program_id
// can be NULL (a row with no "/" in its Client / Account value has no
// program; a manually-added assignment might not specify a client at all)
// and plain `=` never matches NULL to NULL.
//
// Billing is overwritten on every upload for a pairing that already
// exists -- see the comment on consultant_assignments in db/schema.sql for
// why this one field is allowed to change automatically, unlike the
// directory tables' contact fields.

// status: 'active' (default) or 'left'; leftDate only matters for 'left'.
async function upsertAssignmentBilling(conn, { organizationId, consultantId, clientId, programId, billing, source, status, leftDate }) {
  if (!consultantId) return null;
  const src = source === 'manual' ? 'manual' : 'upload';
  const st = status === 'left' ? 'left' : 'active';
  const leftOn = st === 'left' ? (leftDate || null) : null;

  const [existing] = await conn.query(
    `SELECT id FROM consultant_assignments
     WHERE organization_id = ? AND consultant_id = ? AND client_id <=> ? AND program_id <=> ?`,
    [organizationId, consultantId, clientId, programId]
  );
  if (existing.length) {
    const id = existing[0].id;
    await conn.query(
      `UPDATE consultant_assignments SET billing = ?, source = ?, status = ?, left_date = ? WHERE id = ?`,
      [billing, src, st, leftOn, id]
    );
    return id;
  }

  const [result] = await conn.query(
    `INSERT INTO consultant_assignments (organization_id, consultant_id, client_id, program_id, billing, source, status, left_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [organizationId, consultantId, clientId, programId, billing, src, st, leftOn]
  );
  return result.insertId;
}

module.exports = { upsertAssignmentBilling };
