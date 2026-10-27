// Rules for a consultant's placement (consultant_assignments row), shared by the Margin roster,
// the Directory, Onboarding and the profile form so they all agree:
//   * every placement needs a client; the vendor is optional;
//   * W2 (direct): never a supplier company;
//   * Subvendor (Corp-to-Corp): a supplier company is required;
//   * 1099 (direct): a supplier company is optional.
// Existing records that break a rule are not blocked from unrelated edits; they are listed in the
// Directory's fix-it list instead. A rule is enforced when a placement is created or when the edit
// itself touches the worker type or the supplier.

const EMPLOYMENT_BY_WORKER = { W2: 'W2 (direct)', C2C: 'Subvendor', '1099': '1099 (direct)' };
const KIND_BY_EMPLOYMENT = { 'W2 (direct)': 'W2', 'Subvendor': 'C2C', '1099 (direct)': '1099' };
// profile worker_type values -> placement employment type
const EMPLOYMENT_BY_PROFILE = { 'W2': 'W2 (direct)', 'Subvendor': 'Subvendor', 'Corp-to-Corp': 'Subvendor', '1099': '1099 (direct)' };

function checkSupplierRule({ employmentType, supplierId, enforce }) {
  const kind = KIND_BY_EMPLOYMENT[employmentType] || null;
  if (kind === 'W2' && supplierId) return 'A W2 consultant has no supplier company. Clear the supplier, or change the worker type.';
  if (kind === 'C2C' && !supplierId && enforce) return 'A Corp-to-Corp (Subvendor) consultant needs a supplier company.';
  return null;
}

// Moves a consultant's Margin file rows to a new client / vendor so the roster, Ledger and hours
// matching keep agreeing with the placement. Invoices and supplier payments already created are
// deliberately left as they are.
async function repointMarginRows(conn, orgId, consultantId, from, to) {
  await conn.query(
    `UPDATE margin_roster_entries SET client_id = ?, program_id = ?, client = ?, program = ?, client_detail = ?
     WHERE organization_id = ? AND consultant_id = ? AND client_id <=> ? AND program_id <=> ?`,
    [to.clientId, to.programId, to.clientName || null, to.programName || to.clientName || null, to.programName ? to.clientName : null,
      orgId, consultantId, from.clientId, from.programId]);
}

// What a consultant's new placement should inherit: the worker type and supplier on their profile,
// else those of their latest placement. Returns { employmentType, supplierId } (either may be null).
async function defaultsFor(conn, orgId, consultantId) {
  let employmentType = null, supplierId = null;
  try {
    const [p] = await conn.query(`SELECT data FROM record_profiles WHERE organization_id = ? AND entity = 'consultants' AND record_id = ?`, [orgId, consultantId]);
    const d = (p[0] && p[0].data && JSON.parse(p[0].data)) || {};
    if (d.worker_type && EMPLOYMENT_BY_PROFILE[d.worker_type]) employmentType = EMPLOYMENT_BY_PROFILE[d.worker_type];
    if (d.supplier_id && /^\d+$/.test(String(d.supplier_id))) supplierId = Number(d.supplier_id);
  } catch (e) { /* profile tables are optional */ }
  if (!employmentType) {
    const [a] = await conn.query(
      `SELECT employment_type, supplier_id FROM consultant_assignments WHERE organization_id = ? AND consultant_id = ? AND employment_type IS NOT NULL AND employment_type <> 'Unspecified' ORDER BY id DESC LIMIT 1`, [orgId, consultantId]);
    if (a[0]) { employmentType = a[0].employment_type; if (!supplierId) supplierId = a[0].supplier_id; }
  }
  if (employmentType === 'W2 (direct)') supplierId = null;
  return { employmentType, supplierId };
}

const isHrUser = (user) => !!user && (user.role === 'owner' || user.role === 'hr');

module.exports = { EMPLOYMENT_BY_WORKER, KIND_BY_EMPLOYMENT, EMPLOYMENT_BY_PROFILE, checkSupplierRule, repointMarginRows, defaultsFor, isHrUser };
