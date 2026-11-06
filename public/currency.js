/* Money in Fin-Module: every amount shows in its own currency, and totals are kept per currency (never added across). */
var CUR_SYMBOL = { USD: '$', CAD: 'CA$', INR: '₹' };
var CUR_LIST = ['USD', 'CAD', 'INR'];
function curCode(c) { return CUR_SYMBOL[c] ? c : 'USD'; }
function curMoney(n, c) { return CUR_SYMBOL[curCode(c)] + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function curShort(n, c) {
  n = Number(n || 0); var s = CUR_SYMBOL[curCode(c)];
  if (Math.abs(n) >= 1e6) return s + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e4) return s + Math.round(n / 1e3) + 'K';
  return s + Math.round(n).toLocaleString('en-US');
}
// a { USD: 100, CAD: 50 } map -> "$100.00 · CA$50.00" (USD first, empty -> $0.00)
function curSum(map, short) {
  var keys = CUR_LIST.filter(function (k) { return map && Math.abs(map[k] || 0) > 0.004; });
  if (!keys.length) return CUR_SYMBOL.USD + '0.00';
  return keys.map(function (k) { return short ? curShort(map[k], k) : curMoney(map[k], k); }).join(' · ');
}
function curAdd(map, c, n) { c = curCode(c); map[c] = (map[c] || 0) + (Number(n) || 0); return map; }
function curSelectHtml(attr, value, extra) {
  return '<select ' + attr + ' class="fin-cur-select" aria-label="Currency" title="Currency" style="width:auto;min-width:62px;font-size:12px;padding:2px"' + (extra || '') + '>' +
    CUR_LIST.map(function (k) { return '<option value="' + k + '"' + (curCode(value) === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select>';
}
