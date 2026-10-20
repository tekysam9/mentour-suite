// Routing number (ABA) -> bank name, from the Federal Reserve's FedACH directory
// (src/data/aba.json, rebuilt with scripts/build-aba.js). Works offline.
let table = null;
function load() { if (!table) { try { table = require('../data/aba.json'); } catch (e) { table = {}; } } return table; }

// The ABA checksum: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) must be a multiple of 10.
function checksumOk(rn) {
  if (!/^\d{9}$/.test(rn)) return false;
  const d = rn.split('').map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}
function lookup(raw) {
  const rn = String(raw || '').replace(/\D/g, '');
  if (rn.length !== 9) return { valid: false, reason: 'A routing number has 9 digits.' };
  if (!checksumOk(rn)) return { valid: false, reason: 'This is not a valid routing number (the check digit does not match). Re-check the digits.' };
  const hit = load()[rn];
  if (!hit) return { valid: true, bank: null, reason: 'Valid format, but this number is not in the Federal Reserve directory. Confirm it with the bank.' };
  return { valid: true, bank: { name: hit[0], city: hit[1], state: hit[2] } };
}
module.exports = { lookup, checksumOk };
