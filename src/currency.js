// Currency on Fin-Module rows. A row's own `currency` (USD / CAD / INR) wins; a row with none follows its placement
// (client invoices: the placement's billing currency, supplier payments: the placement's pay currency), else USD.
// Nothing is ever converted or added across currencies.
const CURRENCIES = ['USD', 'CAD', 'INR'];
const SYMBOL = { USD: '$', CAD: 'CA$', INR: '₹' };
const norm = (v) => { const t = String(v === undefined || v === null ? '' : v).trim().toUpperCase(); return CURRENCIES.includes(t) ? t : null; };
const sym = (c) => SYMBOL[norm(c) || 'USD'];

// (consultantId, subvendorId) -> the pay currency to show for a supplier payment.
async function payCurrencyResolver(conn, orgId) {
  const bySupplier = new Map(); const byConsultant = new Map();
  try {
    const [rows] = await conn.query(`SELECT consultant_id, supplier_id, pay_currency FROM consultant_assignments WHERE organization_id = ? AND pay_currency IS NOT NULL`, [orgId]);
    rows.forEach((r) => {
      const c = norm(r.pay_currency); if (!c) return;
      if (r.supplier_id) bySupplier.set(r.consultant_id + '|' + r.supplier_id, c);
      const cur = byConsultant.get(r.consultant_id);
      byConsultant.set(r.consultant_id, cur === undefined || cur === c ? c : null); // null = the consultant has placements in different currencies
    });
  } catch (e) { /* column not there yet: everything is USD */ }
  return (consultantId, subvendorId) => bySupplier.get(consultantId + '|' + subvendorId) || byConsultant.get(consultantId) || 'USD';
}
module.exports = { CURRENCIES, SYMBOL, norm, sym, payCurrencyResolver };
