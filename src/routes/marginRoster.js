// Breaks a Margin upload's parsed records (public/margin.html's
// processWorkbook() output) into rows in margin_roster_entries, so the
// roster is queryable with plain SQL instead of only as one JSON blob.
// Wired into the /api/margin import router as its onSave hook — runs in
// the same transaction as the margin_imports insert, so the two can never
// go out of sync.
//
// Also resolves each row's consultant/client/program/subvendor against the
// directory tables (creating a record the first time a name is seen,
// reusing it after) and stores the resulting ids alongside the existing
// text columns. See directoryUpsert.js and db/schema.sql for the
// client/program field-mapping explanation.

const { normalizeName, upsertConsultant, upsertSubvendor, upsertClient, upsertProgram } = require('./directoryUpsert');

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Record dates arrive as JS Date objects on the client, but by the time
// they reach here they've been through JSON.stringify/parse, so a real
// date is an ISO string like "2024-05-01T00:00:00.000Z" and anything else
// (free text, missing) is left for the *_text columns instead.
function toNullableDate(value) {
  if (!value) return null;
  const isoDay = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(isoDay) ? isoDay : null;
}

function toNullableText(value, maxLen) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return maxLen ? s.slice(0, maxLen) : s;
}

async function saveMarginRoster(conn, { organizationId, importId, data }) {
  const records = data && Array.isArray(data.records) ? data.records : [];
  if (!records.length) return;

  const valid = records.filter((r) => r && toNullableText(r.name, 255));
  if (!valid.length) return;

  // Pass 1: settle each name's directory status for this import before
  // touching the database. A consultant/client/program/subvendor is
  // "active" here if *any* row in this upload says so (someone can have
  // several placement rows in one file) — Active wins over Left/Unknown
  // when they disagree, since the point is "still going as of this file."
  // See directoryUpsert.js for why status is the one field that's allowed
  // to change on every save, unlike email/phone/address.
  function bumpStatus(map, key, rowStatus) {
    if (!key) return;
    const isActive = rowStatus === 'Active';
    map.set(key, map.get(key) === 'active' || isActive ? 'active' : 'inactive');
  }

  const consultantStatus = new Map();
  const clientStatus = new Map();
  const programStatus = new Map(); // "clientKey|detailKey" -> status (text-keyed; client id isn't known yet)
  const subvendorStatus = new Map();

  for (const r of valid) {
    bumpStatus(consultantStatus, normalizeName(r.name), r.status);

    const clientKey = normalizeName(r.program);
    bumpStatus(clientStatus, clientKey, r.status);

    const programDetailKey = normalizeName(r.clientDetail);
    if (clientKey && programDetailKey) {
      bumpStatus(programStatus, clientKey + '|' + programDetailKey, r.status);
    }

    if (r.employmentType === 'Subvendor') {
      bumpStatus(subvendorStatus, normalizeName(r.subvendorText), r.status);
    }
  }

  // Resolve each distinct name once, not once per row — most names repeat
  // across dozens of rows in a real roster.
  const consultantIds = new Map(); // normalized name -> id
  const clientIds = new Map(); // normalized program value -> client id
  const programIds = new Map(); // "clientId|detail" -> program id
  const subvendorIds = new Map(); // normalized name -> id

  for (const r of valid) {
    const consultantKey = normalizeName(r.name);
    if (consultantKey && !consultantIds.has(consultantKey)) {
      consultantIds.set(consultantKey, await upsertConsultant(conn, organizationId, r.name, consultantStatus.get(consultantKey)));
    }

    // "Program" is the end-client/account name in this data (see
    // schema.sql's comment on the clients/programs tables).
    const clientKey = normalizeName(r.program);
    if (clientKey && !clientIds.has(clientKey)) {
      clientIds.set(clientKey, await upsertClient(conn, organizationId, r.program, clientStatus.get(clientKey)));
    }

    const clientId = clientKey ? clientIds.get(clientKey) : null;
    const programDetailKey = normalizeName(r.clientDetail);
    if (clientId && programDetailKey) {
      const programKey = clientId + '|' + programDetailKey;
      if (!programIds.has(programKey)) {
        const status = programStatus.get(clientKey + '|' + programDetailKey);
        programIds.set(programKey, await upsertProgram(conn, organizationId, clientId, r.clientDetail, status));
      }
    }

    // Only a real "Subvendor" employment row names an actual vendor company
    // — for W2/1099/direct rows, subvendorText holds a marker like "W2",
    // not a vendor, so skip creating a bogus subvendor record for those.
    if (r.employmentType === 'Subvendor') {
      const subvendorKey = normalizeName(r.subvendorText);
      if (subvendorKey && !subvendorIds.has(subvendorKey)) {
        subvendorIds.set(subvendorKey, await upsertSubvendor(conn, organizationId, r.subvendorText, subvendorStatus.get(subvendorKey)));
      }
    }
  }

  const rows = valid.map((r) => {
    const consultantKey = normalizeName(r.name);
    const clientKey = normalizeName(r.program);
    const clientId = clientKey ? clientIds.get(clientKey) || null : null;
    const programDetailKey = normalizeName(r.clientDetail);
    const programId = clientId && programDetailKey ? programIds.get(clientId + '|' + programDetailKey) || null : null;
    const subvendorKey = r.employmentType === 'Subvendor' ? normalizeName(r.subvendorText) : null;

    return [
      importId,
      organizationId,
      toNullableText(r.name, 255),
      consultantKey ? consultantIds.get(consultantKey) || null : null,
      toNullableText(r.client, 255),
      toNullableText(r.program, 255),
      clientId,
      toNullableText(r.clientDetail, 255),
      programId,
      toNullableNumber(r.cost),
      toNullableNumber(r.billing),
      toNullableNumber(r.margin),
      toNullableText(r.status, 32),
      toNullableText(r.joined, 64),
      toNullableText(r.leftText, 255),
      toNullableDate(r.leftDate),
      toNullableText(r.recruiter, 255),
      toNullableText(r.subvendorText, 255),
      subvendorKey ? subvendorIds.get(subvendorKey) || null : null,
      toNullableText(r.employmentType, 64),
      toNullableText(r.sourceSheet, 255),
    ];
  });

  await conn.query(
    `INSERT INTO margin_roster_entries
       (import_id, organization_id, name, consultant_id, client, program, client_id,
        client_detail, program_id, cost, billing, margin, status, joined_text,
        left_text, left_date, recruiter, subvendor_text, subvendor_id,
        employment_type, source_sheet)
     VALUES ?`,
    [rows]
  );
}

module.exports = { saveMarginRoster };
