// Breaks a Margin upload's parsed records (public/margin.html's
// processWorkbook() output) into rows in margin_roster_entries, so the
// roster is queryable with plain SQL instead of only as one JSON blob.
// Wired into the /api/margin import router as its onSave hook — runs in
// the same transaction as the margin_imports insert, so the two can never
// go out of sync.

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

  const rows = records
    .filter((r) => r && toNullableText(r.name, 255)) // name is NOT NULL; skip anything malformed rather than fail the whole upload
    .map((r) => [
      importId,
      organizationId,
      toNullableText(r.name, 255),
      toNullableText(r.client, 255),
      toNullableText(r.program, 255),
      toNullableText(r.clientDetail, 255),
      toNullableNumber(r.cost),
      toNullableNumber(r.billing),
      toNullableNumber(r.margin),
      toNullableText(r.status, 32),
      toNullableText(r.joined, 64),
      toNullableText(r.leftText, 255),
      toNullableDate(r.leftDate),
      toNullableText(r.recruiter, 255),
      toNullableText(r.subvendorText, 255),
      toNullableText(r.employmentType, 64),
      toNullableText(r.sourceSheet, 255),
    ]);

  if (!rows.length) return;

  await conn.query(
    `INSERT INTO margin_roster_entries
       (import_id, organization_id, name, client, program, client_detail,
        cost, billing, margin, status, joined_text, left_text, left_date,
        recruiter, subvendor_text, employment_type, source_sheet)
     VALUES ?`,
    [rows]
  );
}

module.exports = { saveMarginRoster };
