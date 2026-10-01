// Breaks a Ledger upload's parsed data (public/ledger.html's
// processWorkbook() output, specifically data.consultants[].placements[])
// into rows in ledger_roster_entries. Ledger's natural grain is a subvendor
// payment line, not a roster snapshot — one row here is one consultant's
// payment for one subvendor in one month of one upload. Wired into the
// /api/ledger import router as its onSave hook, same transaction as the
// ledger_imports insert.
//
// Also resolves each row's consultant/subvendor against the shared
// directory tables, the same ones Margin resolves against — a consultant
// or subvendor uploaded through either tool becomes one directory record.

const { normalizeName, upsertConsultant, upsertSubvendor } = require('./directoryUpsert');

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

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

async function saveLedgerRoster(conn, { organizationId, importId, data }) {
  const consultants = data && Array.isArray(data.consultants) ? data.consultants : [];
  if (!consultants.length) return;

  const consultantIds = new Map();
  const subvendorIds = new Map();
  const flatRows = [];

  for (const c of consultants) {
    if (!c || !toNullableText(c.name, 255)) continue;
    const placements = Array.isArray(c.placements) ? c.placements : [];
    if (!placements.length) continue;

    const consultantKey = normalizeName(c.name);
    if (consultantKey && !consultantIds.has(consultantKey)) {
      consultantIds.set(consultantKey, await upsertConsultant(conn, organizationId, c.name));
    }

    for (const p of placements) {
      if (!p) continue;
      const subvendorKey = normalizeName(p.subvendor);
      if (subvendorKey && subvendorKey !== '(unspecified)' && !subvendorIds.has(subvendorKey)) {
        subvendorIds.set(subvendorKey, await upsertSubvendor(conn, organizationId, p.subvendor));
      }
      flatRows.push({ name: c.name, consultantKey, p, subvendorKey });
    }
  }

  if (!flatRows.length) return;

  const rows = flatRows.map(({ name, consultantKey, p, subvendorKey }) => [
    importId,
    organizationId,
    consultantKey ? consultantIds.get(consultantKey) || null : null,
    subvendorKey ? subvendorIds.get(subvendorKey) || null : null,
    toNullableText(name, 255),
    toNullableText(p.subvendor, 255),
    toNullableText(p.clientTag, 32),
    toNullableText(p.month, 64),
    toNullableText(p.period, 255),
    toNullableNumber(p.amount),
    toNullableNumber(p.rate),
    toNullableNumber(p.hours),
    toNullableDate(p.paidDate),
    toNullableText(p.notes, 500),
  ]);

  await conn.query(
    `INSERT INTO ledger_roster_entries
       (import_id, organization_id, consultant_id, subvendor_id, name,
        subvendor_text, client_tag, month_label, period_text, amount, rate,
        hours, paid_date, notes)
     VALUES ?`,
    [rows]
  );
}

module.exports = { saveLedgerRoster };
