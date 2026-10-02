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
//
// Status precedence: the Margin file is the source of truth for
// Active/Inactive. A Ledger upload only sets the status of a consultant or
// subvendor that has never appeared in any Margin upload of this
// organization (no margin_roster_entries row links to it); for anyone
// Margin knows about, Ledger leaves status alone and the latest Margin
// upload's value stands. Ledger still creates brand-new records (with its
// own status) as before.

const { normalizeName, normalizeStatus, findOrCreateDirectoryRecord, setDirectoryStatus } = require('./directoryUpsert');

// Margin-linked column for each directory table Ledger touches.
const MARGIN_LINK_COLUMN = { consultants: 'consultant_id', subvendors: 'subvendor_id' };

// Like upsertConsultant/upsertSubvendor, except an existing record's status
// is only changed when no Margin row in this organization points at it.
async function resolveForLedger(conn, tableName, organizationId, name, rawStatus) {
  const status = normalizeStatus(rawStatus);
  const rec = await findOrCreateDirectoryRecord(conn, tableName, { organizationId, name, status });
  if (!rec) return null;
  if (!rec.created && rec.status !== status) {
    const column = MARGIN_LINK_COLUMN[tableName];
    const [inMargin] = await conn.query(
      `SELECT 1 FROM margin_roster_entries WHERE organization_id = ? AND ${column} = ? LIMIT 1`,
      [organizationId, rec.id]
    );
    if (!inMargin.length) await setDirectoryStatus(conn, tableName, rec.id, status);
  }
  return rec.id;
}

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

  // public/ledger.html's processWorkbook() already settles each consultant's
  // status across the whole file ('Active' | 'Left' | 'Inactive' — see its
  // buildConsultants()) before this payload is posted, so there's no
  // per-row ambiguity to resolve the way Margin's rows have. A subvendor's
  // status rides along with whichever consultants use it: active if at
  // least one currently-active consultant is placed through it anywhere in
  // this file.
  function toDirectoryStatus(rawStatus) {
    return rawStatus === 'Active' ? 'active' : 'inactive';
  }

  const subvendorStatus = new Map();
  for (const c of consultants) {
    if (!c || !toNullableText(c.name, 255)) continue;
    const placements = Array.isArray(c.placements) ? c.placements : [];
    const consultantIsActive = c.status === 'Active';
    for (const p of placements) {
      if (!p) continue;
      const subvendorKey = normalizeName(p.subvendor);
      if (!subvendorKey || subvendorKey === '(unspecified)') continue;
      subvendorStatus.set(subvendorKey, subvendorStatus.get(subvendorKey) === 'active' || consultantIsActive ? 'active' : 'inactive');
    }
  }

  const consultantIds = new Map();
  const subvendorIds = new Map();
  const flatRows = [];

  for (const c of consultants) {
    if (!c || !toNullableText(c.name, 255)) continue;
    const placements = Array.isArray(c.placements) ? c.placements : [];
    if (!placements.length) continue;

    const consultantKey = normalizeName(c.name);
    if (consultantKey && !consultantIds.has(consultantKey)) {
      consultantIds.set(consultantKey, await resolveForLedger(conn, 'consultants', organizationId, c.name, toDirectoryStatus(c.status)));
    }

    for (const p of placements) {
      if (!p) continue;
      const subvendorKey = normalizeName(p.subvendor);
      if (subvendorKey && subvendorKey !== '(unspecified)' && !subvendorIds.has(subvendorKey)) {
        subvendorIds.set(subvendorKey, await resolveForLedger(conn, 'subvendors', organizationId, p.subvendor, subvendorStatus.get(subvendorKey)));
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
