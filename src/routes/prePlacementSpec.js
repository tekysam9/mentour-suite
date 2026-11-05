// Pre-placement information: what a recruiter collects about a vendor and a consultant BEFORE the placement
// goes to onboarding. The fields mirror the "Pre-Placement Document" the team e-mails around, so
// parseText() reads a pasted copy of that table and fills them in.
//
// Two values are sensitive (date of birth and the SSN digits): they are kept apart from the other fields,
// encrypted with the field-encryption key, never listed, and only the owner / HR can reveal them.

const f = (key, label, kind, extra) => Object.assign({ key, label, kind }, extra || {});
const BASIS = ['Hourly', 'Daily', 'Monthly', 'Annual'];
const ENGAGEMENT = ['C2C', 'W2', '1099'];

const SECTIONS = [
  { key: 'vendor', title: 'Vendor (the company the consultant works through)', fields: [
    f('vendor_name', 'Vendor name', 'text'),
    f('vendor_address', 'Vendor address', 'text', { wide: true }),
    f('fed_tax_id', 'Fed / business tax ID', 'text'),
    f('incorporated_state', 'Incorporated state / province', 'text'),
    f('vendor_email', 'Vendor e-mail', 'email'),
    f('vendor_phone', 'Vendor phone', 'text'),
    f('vendor_fax', 'Fax', 'text'),
  ] },
  { key: 'signer', title: 'Signing authority', fields: [
    f('signer_name', 'Signing authority name', 'text'),
    f('signer_designation', 'Designation', 'text'),
    f('signer_phone', 'Phone', 'text'),
    f('signer_email', 'E-mail', 'email'),
  ] },
  { key: 'terms', title: 'Placement terms', fields: [
    f('client_name', 'Client name', 'text'),
    f('end_client_name', 'End client name', 'text'),
    f('technical_skill', 'Technical skill of the candidate', 'text'),
    f('project_duration', 'Project duration', 'text', { help: 'e.g. 12 months' }),
    f('start_date', 'Start date', 'date'),
    f('work_location', 'Work location', 'text'),
    f('engagement', 'Engagement', 'select', { options: ENGAGEMENT, help: 'C2C, W2 or 1099 (read from the pay rate line when it says so).' }),
    f('pay_rate', 'Pay rate', 'number'),
    f('pay_basis', 'Pay rate basis', 'select', { options: BASIS }),
    f('pay_currency', 'Pay currency', 'text', { help: 'USD, CAD ...' }),
    f('bill_rate', 'Bill rate', 'number'),
    f('bill_basis', 'Bill rate basis', 'select', { options: BASIS }),
    f('bill_currency', 'Bill currency', 'text', { help: 'USD, CAD ...' }),
  ] },
  { key: 'consultant', title: 'Consultant', fields: [
    f('consultant_name', 'Consultant first and last name', 'text', { required: true }),
    f('consultant_email', 'E-mail', 'email'),
    f('consultant_phone', 'Cell / home number', 'text'),
    f('emergency_contact', 'Emergency contact number', 'text'),
    f('visa_status', 'Visa status', 'text'),
    f('visa_expiry', 'Visa expiry date', 'date'),
    f('laptop_address', 'Address for laptop shipment', 'text', { wide: true }),
  ] },
];
// Encrypted, write-only (the API never lists them; owner / HR can reveal on request).
const SECRET_FIELDS = [
  f('dob', 'Date of birth', 'date', { secret: true }),
  f('ssn_last5', 'SSN (last 4–5 digits only)', 'text', { secret: true, help: 'Only the last digits are kept — never the full number.' }),
];

const FIELD_BY_KEY = {};
SECTIONS.forEach((s) => s.fields.forEach((x) => { FIELD_BY_KEY[x.key] = x; }));
SECRET_FIELDS.forEach((x) => { FIELD_BY_KEY[x.key] = x; });
const PLAIN_KEYS = SECTIONS.reduce((a, s) => a.concat(s.fields.map((x) => x.key)), []);
const SECRET_KEYS = SECRET_FIELDS.map((x) => x.key);

// ---------------------------------------------------------------- value readers
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const p2 = (n) => String(n).padStart(2, '0');
function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && y <= 2100 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
// "September 3 1989", "23 August 2034", "Sep 3, 1989", "2034-08-23", "8/23/2034" (month first) -> "YYYY-MM-DD" or ''.
function parseDate(s) {
  const t = String(s || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return validYmd(+m[1], +m[2], +m[3]) ? `${m[1]}-${p2(m[2])}-${p2(m[3])}` : '';
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/.exec(t);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return validYmd(y, +m[1], +m[2]) ? `${y}-${p2(m[1])}-${p2(m[2])}` : ''; }
  const monthNo = (w) => MONTHS[w.slice(0, 4).toLowerCase()] || MONTHS[w.slice(0, 3).toLowerCase()] || 0;
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)? (\d{4})$/.exec(t);
  if (m) { const mo = monthNo(m[1]); if (mo && validYmd(+m[3], mo, +m[2])) return `${m[3]}-${p2(mo)}-${p2(m[2])}`; }
  m = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,9})\.? (\d{4})$/.exec(t);
  if (m) {
    const mo = monthNo(m[2]);
    if (mo && validYmd(+m[3], mo, +m[1])) return `${m[3]}-${p2(mo)}-${p2(m[1])}`;
  }
  return '';
}
// "CAD 65/hr C2C" -> { value: 65, basis: 'Hourly', currency: 'CAD', engagement: 'C2C' }
function parseRate(s) {
  const t = String(s || '');
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(t);
  if (!m) return null;
  const low = t.toLowerCase();
  const basis = /\/\s*(day|d)\b|per day|daily/.test(low) ? 'Daily' : /\/\s*(mo|month)|monthly|per month/.test(low) ? 'Monthly'
    : /\/\s*(yr|year|annum)|annual|per year|salary|\bpa\b/.test(low) ? 'Annual' : 'Hourly';
  let currency = '';
  const c = /\b(USD|CAD|INR|GBP|EUR|AUD)\b/i.exec(t);
  if (c) currency = c[1].toUpperCase(); else if (/CA\$|C\$/.test(t)) currency = 'CAD'; else if (/US\$|\$/.test(t)) currency = 'USD';
  const engagement = /c\s*2\s*c|corp[\s-]*to[\s-]*corp/i.test(t) ? 'C2C' : /\bw-?2\b/i.test(t) ? 'W2' : /1099/.test(t) ? '1099' : '';
  return { value: Number(m[1].replace(/,/g, '')), basis, currency, engagement };
}

// ---------------------------------------------------------------- reading a pasted copy of the table
// [pattern, key, section it switches to]. The same label (Phone, E-mail ID) appears for the vendor, the signer and the consultant,
// so the section we are in decides which field it is.
const LABELS = [
  [/^pre-?placement\s+(document|information)/i, '_title'],
  [/^vendor\s*name/i, 'vendor_name', 'vendor'],
  [/^vendor\s*address/i, 'vendor_address'],
  [/^(fed(eral)?\.?\s*)?(tax\s*id|ein|business\s*(no|number))|^fed\s*tax/i, 'fed_tax_id'],
  [/^(incorporated|incorporation)\s*(state|province)?|^state\s*of\s*incorporation/i, 'incorporated_state'],
  [/^signing\s*authority/i, 'signer_name', 'signer'],
  [/^designation|^title$/i, 'signer_designation'],
  [/^details\s*of\s*the\s*consultant|^consultant\s*details/i, '_consultant', 'consultant'],
  [/^consultant.{0,3}s?\s*(first|name|full)|^consultant\s*first/i, 'consultant_name', 'consultant'],
  [/^consultant.{0,3}s?\s*(date\s*of\s*birth|dob)|^(date\s*of\s*birth|dob)/i, 'dob'],
  [/^consultant.{0,3}s?\s*ssn|^ssn/i, 'ssn_last5'],
  [/^consultant.{0,3}s?\s*e-?mail/i, 'consultant_email'],
  [/^consultant.{0,3}s?\s*(cell|home|phone|mobile|contact)/i, 'consultant_phone'],
  [/^emergency/i, 'emergency_contact'],
  [/^(consultant.{0,3}s?\s*)?visa\s*expir/i, 'visa_expiry'],
  [/^(consultant.{0,3}s?\s*)?visa\s*status|^work\s*authori[sz]ation/i, 'visa_status'],
  [/^work\s*location|^project\s*location/i, 'work_location'],
  [/^address\s*for\s*laptop|^laptop/i, 'laptop_address'],
  [/^pay\s*rate/i, 'pay_rate'],
  [/^bill\s*rate/i, 'bill_rate'],
  [/^start\s*date|^project\s*start/i, 'start_date'],
  [/^end\s*client/i, 'end_client_name'],
  [/^client\s*name|^client$/i, 'client_name'],
  [/^technical\s*skill|^skill/i, 'technical_skill'],
  [/^project\s*duration|^duration/i, 'project_duration'],
  [/^fax/i, 'vendor_fax'],
  [/^e-?mail(\s*id)?$/i, '_email'],
  [/^(phone|telephone|contact\s*(no|number))\b/i, '_phone'],
];
function labelOf(text) {
  const t = String(text || '').replace(/[:\s]+$/, '').trim();
  if (!t || t.length > 70) return null;
  return LABELS.find((l) => l[0].test(t)) || null;
}

function parseText(text) {
  const fields = {}; const matched = []; const unmatched = []; const warnings = [];
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/ /g, ' ').trim()).filter(Boolean);
  let section = 'vendor';
  const put = (key, raw) => {
    let v = String(raw || '').trim();
    if (!v || /^[-–—_.]+$/.test(v) || /^(n\/?a|none|tbd)$/i.test(v)) return;
    if (key === 'start_date' || key === 'visa_expiry' || key === 'dob') {
      const d = parseDate(v);
      if (!d) { warnings.push(`Could not read the date "${v}" for ${(FIELD_BY_KEY[key] || {}).label || key}. Please enter it as a date.`); return; }
      v = d;
    } else if (key === 'pay_rate' || key === 'bill_rate') {
      const r = parseRate(v);
      if (!r) { warnings.push(`Could not read a number from "${v}" for ${FIELD_BY_KEY[key].label}.`); return; }
      const pre = key === 'pay_rate' ? 'pay' : 'bill';
      fields[key] = r.value; fields[pre + '_basis'] = r.basis; if (r.currency) fields[pre + '_currency'] = r.currency;
      if (r.engagement && key === 'pay_rate') fields.engagement = r.engagement;
      matched.push(key); return;
    } else if (key === 'ssn_last5') {
      const digits = v.replace(/\D/g, '');
      if (digits.length < 4) { warnings.push('The SSN needs at least the last 4 digits.'); return; }
      if (digits.length > 5) warnings.push('More than 5 SSN digits were pasted. Only the last 5 were kept — the full number is never stored.');
      v = digits.slice(-5);
    }
    fields[key] = v; matched.push(key);
  };
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // "Label<TAB>value", "Label   value" (2+ spaces) or "Label: value"
    let label = null; let value = '';
    const tab = line.split(/\t+| {2,}/);
    if (tab.length > 1 && labelOf(tab[0])) { label = labelOf(tab[0]); value = tab.slice(1).filter((x, k, a) => x !== tab[0]).join(' ').trim(); }
    else {
      const ci = line.indexOf(':');
      if (ci > 0 && labelOf(line.slice(0, ci))) { label = labelOf(line.slice(0, ci)); value = line.slice(ci + 1).trim(); }
      else if (labelOf(line)) { label = labelOf(line); value = ''; }
    }
    if (!label) { unmatched.push(line); continue; }
    // value on the next line when the label stood alone
    if (!value && i + 1 < lines.length && !labelOf(lines[i + 1]) && label[1] !== '_title' && label[1] !== '_consultant') { value = lines[i + 1]; i += 1; }
    if (label[2]) section = label[2];
    let key = label[1];
    if (key === '_title' || key === '_consultant') continue;
    if (key === '_email') key = section === 'signer' ? 'signer_email' : section === 'consultant' ? 'consultant_email' : 'vendor_email';
    else if (key === '_phone') key = section === 'signer' ? 'signer_phone' : section === 'consultant' ? 'consultant_phone' : 'vendor_phone';
    // the same label twice in a section (e.g. a merged header row repeating its text) is not a value
    if (value && labelOf(value) && labelOf(value)[1] === label[1]) value = '';
    put(key, value);
  }
  return { fields, matched: Array.from(new Set(matched)), unmatched, warnings };
}

// ---------------------------------------------------------------- validating what is saved
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// input: { key: value }. Returns { data (plain fields), secrets (only the keys given), errors }.
// An empty value clears a field. A key that is not in the input is left alone (the caller merges).
function clean(input) {
  const data = {}; const secrets = {}; const errors = []; const cleared = [];
  for (const key of PLAIN_KEYS.concat(SECRET_KEYS)) {
    if (!input || !Object.prototype.hasOwnProperty.call(input, key)) continue;
    const fld = FIELD_BY_KEY[key];
    const raw = input[key];
    let s = raw === null || raw === undefined ? '' : String(raw).trim();
    const target = fld.secret ? secrets : data;
    if (s === '') { target[key] = ''; cleared.push(key); continue; }
    if (s.length > 300) { errors.push({ key, message: `${fld.label} is too long.` }); continue; }
    if (fld.kind === 'number') {
      const n = Number(s.replace(/[$,]/g, ''));
      if (!isFinite(n) || n < 0 || n > 10000000) { errors.push({ key, message: `${fld.label} must be a number.` }); continue; }
      target[key] = n;
    } else if (fld.kind === 'date') {
      if (!DATE_RE.test(s) || !validYmd(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10))) { errors.push({ key, message: `${fld.label} must be a valid date.` }); continue; }
      target[key] = s;
    } else if (fld.kind === 'email') {
      if (!EMAIL_RE.test(s)) { errors.push({ key, message: `${fld.label} is not a valid e-mail address.` }); continue; }
      target[key] = s;
    } else if (fld.kind === 'select') {
      const hit = fld.options.find((o) => o.toLowerCase() === s.toLowerCase());
      if (!hit) { errors.push({ key, message: `${fld.label}: choose one of the listed options.` }); continue; }
      target[key] = hit;
    } else if (key === 'ssn_last5') {
      const digits = s.replace(/\D/g, '');
      if (digits.length < 4 || digits.length > 5) { errors.push({ key, message: 'Enter only the last 4 or 5 digits of the SSN (the full number is never stored).' }); continue; }
      target[key] = digits;
    } else if (key === 'pay_currency' || key === 'bill_currency') {
      target[key] = s.toUpperCase().slice(0, 8);
    } else target[key] = s;
  }
  return { data, secrets, errors, cleared };
}

module.exports = { SECTIONS, SECRET_FIELDS, FIELD_BY_KEY, PLAIN_KEYS, SECRET_KEYS, parseText, parseDate, parseRate, clean, ENGAGEMENT, BASIS };
