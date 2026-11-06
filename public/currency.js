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

// Same map, but each currency is labelled with its code so the split is obvious.
// stacked (default): one line per currency; inline: side by side. Never adds across currencies.
var CUR_TINT = { USD: '#E8F0FE', CAD: '#FDE7E7', INR: '#FFF1DB' };
function curSumHtml(map, short, inline) {
  var keys = CUR_LIST.filter(function (k) { return map && Math.abs(map[k] || 0) > 0.004; });
  if (!keys.length) keys = ['USD'], map = { USD: 0 };
  return keys.map(function (k) {
    return '<span class="fin-cur-amt" style="display:' + (inline ? 'inline-flex' : 'flex') + ';gap:6px;align-items:baseline;justify-content:' + (inline ? 'flex-start' : 'flex-end') + ';white-space:nowrap;' + (inline ? 'margin-right:10px' : '') + '">' +
      '<span title="' + k + ' total" style="font-size:10px;font-weight:700;letter-spacing:.4px;padding:1px 5px;border-radius:4px;color:#33414E;background:' + CUR_TINT[k] + '">' + k + '</span>' +
      '<span>' + (short ? curShort(map[k], k) : curMoney(map[k], k)) + '</span></span>';
  }).join('');
}
