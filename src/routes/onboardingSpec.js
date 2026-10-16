// Onboarding: the "placement information" a recruiter hands to the HR admin,
// plus the paperwork checklist that depends on how the person is engaged:
//
//   W2   - employee on Mentour payroll (W-4, I-9, direct deposit, benefits ...)
//   C2C  - corp-to-corp: the consultant works through their own company
//          (company W-9, subcontract / MSA, certificate of insurance ...)
//   1099 - individual independent contractor (contractor agreement, W-9 ...)
//
// The placement fields mirror the e-mail the team used to send by hand
// ("PLACEMENT INFORMATION ..."), so buildEmail() / parseEmail() round-trip it.

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
const RATE_BASIS = ['Hourly', 'Daily', 'Monthly', 'Annual'];
const YES_NO = ['Yes', 'No'];
const f = (key, label, kind, extra) => Object.assign({ key, label, kind }, extra || {});

const WORKER_TYPES = [
  { key: 'W2', label: 'W-2 employee', blurb: 'On Mentour payroll. Withholding (W-4), employment eligibility (I-9), direct deposit and benefits.' },
  { key: 'C2C', label: 'Corp-to-corp (C2C)', blurb: 'Works through their own company. We contract with that company: its W-9, a subcontract agreement and insurance.' },
  { key: '1099', label: '1099 contractor', blurb: 'Individual independent contractor. Contractor agreement and W-9, paid on a 1099.' },
];

const SECTIONS = [
  { key: 'consultant', title: 'Consultant', fields: [
    f('consultant_name', 'Consultant name', 'text', { required: true }),
    f('phone', 'Contact number', 'phone'),
    f('email', 'Email', 'email'),
    f('technical_skill', 'Technical skill', 'text'),
    f('work_authorization', 'Work authorization', 'select', { options: ['US citizen', 'Green card', 'H-1B', 'L-1', 'OPT / CPT', 'TN', 'EAD', 'Other'] }),
    f('h1b_filing_required', 'H-1B filing required', 'select', { options: YES_NO, required: true }),
  ] },
  { key: 'placement', title: 'Placement', fields: [
    f('start_date', 'Project start date', 'date', { required: true }),
    f('duration', 'Project duration', 'text', { help: 'e.g. 12 months' }),
    f('end_client', 'End client', 'text', { required: true, help: 'As you write it in the e-mail, e.g. "CDW / OCC".' }),
    f('bill_to', 'Bill to (customer: T1 / end client)', 'text'),
    f('location', 'Project location (state and city)', 'text', { help: 'Or "Remote".' }),
  ] },
  { key: 'rates', title: 'Rates', fields: [
    f('bill_rate', 'Bill rate', 'number', { required: true }),
    f('bill_rate_basis', 'Bill rate basis', 'select', { options: RATE_BASIS }),
    f('pay_to', 'Pay to (consultant / vendor)', 'text'),
    f('pay_rate', 'Pay rate', 'number', { required: true }),
    f('pay_rate_basis', 'Pay rate basis', 'select', { options: RATE_BASIS }),
    f('final_cost', 'Final cost (if different from pay rate)', 'number', { help: 'Pay rate plus any burden, fees or vendor mark-up. Margin is worked out on this when filled in.' }),
  ] },
  { key: 'team', title: 'Team', fields: [
    f('account_manager', 'Account manager', 'text'),
    f('delivery_manager', 'Delivery manager', 'text'),
    f('recruiter', 'Recruiter', 'text', { required: true }),
  ] },
  { key: 'invoicing', title: 'Invoicing & timesheets', fields: [
    f('invoicing_method', 'Invoicing', 'select', { options: ['QuickBooks', 'Client portal', 'Other'], required: true }),
    f('invoice_to_name', 'Send the invoice to (company / person)', 'text'),
    f('invoice_to_email', 'Invoice recipient email', 'email'),
    f('timesheet_requirement', 'Timesheet sent with the invoice', 'textarea', { wide: true, help: 'Which timesheet (client or implementation partner), company name, and who approves it.' }),
    f('timesheet_approver', 'Timesheet approver', 'text'),
  ] },
  { key: 'employer', title: 'Candidate employer (the consultant’s own company)', types: ['C2C'], fields: [
    f('employer_name', 'Company name', 'text', { required: true }),
    f('employer_contact', 'Contact person', 'text'),
    f('employer_email', 'Company email', 'email'),
    f('employer_phone', 'Company phone', 'phone'),
    f('employer_address', 'Street address', 'text'),
    f('employer_city', 'City', 'text'),
    f('employer_state', 'State', 'select', { options: US_STATES }),
    f('employer_zip', 'ZIP', 'text'),
  ] },
  { key: 'employment', title: 'Employment terms', types: ['W2'], fields: [
    f('job_title', 'Job title', 'text', { required: true }),
    f('employment_type', 'Employment type', 'select', { options: ['Full-time', 'Part-time'] }),
    f('flsa_status', 'Overtime status', 'select', { options: ['Non-exempt (overtime eligible)', 'Exempt'] }),
    f('pay_frequency', 'Pay frequency', 'select', { options: ['Weekly', 'Bi-weekly', 'Semi-monthly', 'Monthly'] }),
    f('work_state', 'State of work (for tax withholding)', 'select', { options: US_STATES, required: true }),
    f('benefits_eligible', 'Benefits eligible', 'select', { options: YES_NO }),
    f('offer_date', 'Offer letter date', 'date'),
    f('address', 'Home street address', 'text'),
    f('city', 'City', 'text'),
    f('state', 'State', 'select', { options: US_STATES }),
    f('zip', 'ZIP', 'text'),
  ] },
  { key: 'contractor', title: 'Contractor details', types: ['1099'], fields: [
    f('business_name', 'Business name / DBA (if any)', 'text'),
    f('contract_end_date', 'Agreement end date', 'date'),
    f('payment_terms', 'Payment terms', 'select', { options: ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60'] }),
    f('address', 'Street address', 'text'),
    f('city', 'City', 'text'),
    f('state', 'State', 'select', { options: US_STATES }),
    f('zip', 'ZIP', 'text'),
  ] },
];

const sectionsFor = (type) => SECTIONS.filter((s) => !s.types || s.types.includes(type));
const fieldsFor = (type) => sectionsFor(type).flatMap((s) => s.fields);

// ---------------------------------------------------------------- checklist
// form: a fillable form in this app (auto-ticks when fully signed)
// on: 'consultant' | 'supplier'  -> which directory record the form lives on
// when: item only applies when data[key] === value
const item = (key, label, extra) => Object.assign({ key, label }, extra || {});
// answer: 'yesno'          -> HR picks Yes / No; the item is done once answered
// upload: 'required'       -> done once a document is uploaded
// upload: 'optional'       -> a document can be attached but is not needed
// optional: true           -> shown, but never blocks completion
// future: 'fillable-pdf'   -> later becomes a fillable PDF with e-signature (upload for now)
const COMMON_TAIL = [
  item('background_check', 'Background check cleared', { group: 'Compliance', answer: 'yesno', upload: 'optional', hint: 'Choose Yes or No. Attaching the report is optional.' }),
  item('rate_confirmation', 'Rate confirmation sent and accepted', { group: 'Commercial', answer: 'yesno', hint: 'Bill rate and pay rate agreed in writing.' }),
  item('timesheet_access', 'Timesheet process and access arranged', { group: 'Setup', answer: 'yesno' }),
  item('client_docs', 'Client onboarding paperwork, badge and equipment', { group: 'Setup', optional: true }),
  item('directory_records', 'Directory records created', { group: 'Setup', auto: 'records', hint: 'Use “Create directory records” on this page.' }),
];
// Checklist keys that were renamed or removed; old onboardings are mapped on read.
const RENAMED = { subcontract: 'vendor_agreement' };
const REMOVED = ['invoicing_setup'];
const NDA = item('nda', 'NDA / confidentiality agreement signed', { group: 'Paperwork', upload: 'required', future: 'fillable-pdf' });
const H1B = item('h1b_petition', 'H-1B petition filed', { group: 'Compliance', when: { key: 'h1b_filing_required', value: 'Yes' } });

const CHECKLISTS = {
  W2: [
    item('offer_letter', 'Offer letter sent and signed', { group: 'Paperwork' }),
    item('w4', 'Form W-4 (federal withholding)', { group: 'Paperwork', form: 'w4', on: 'consultant' }),
    item('i9', 'Form I-9 (employment eligibility)', { group: 'Paperwork', form: 'i9', on: 'consultant', hint: 'Employee completes Section 1 by day one; the employer completes Section 2 within 3 business days of the start date.' }),
    item('state_withholding', 'State withholding form', { group: 'Paperwork', hint: 'The state form for the state of work, if it has one.' }),
    item('direct_deposit', 'Direct deposit details collected', { group: 'Paperwork' }),
    item('emergency_contact', 'Emergency contact collected', { group: 'Paperwork' }),
    item('handbook', 'Handbook and policies acknowledged', { group: 'Paperwork' }),
    NDA,
    item('everify', 'E-Verify case created', { group: 'Compliance', hint: 'Only if the company is enrolled.' }),
    H1B,
    item('benefits', 'Benefits enrollment offered or waived', { group: 'Setup' }),
    item('payroll_setup', 'Added to payroll', { group: 'Setup' }),
  ].concat(COMMON_TAIL.filter((x) => x.key !== 'rate_confirmation')),
  C2C: [
    item('company_w9', 'Company Form W-9', { group: 'Paperwork', form: 'w9', on: 'supplier', hint: 'The consultant’s company fills this in; it needs the company to exist as a supplier company (created for you).' }),
    item('vendor_agreement', 'Vendor agreement', { group: 'Paperwork', upload: 'required', future: 'fillable-pdf', hint: 'Upload the signed agreement.' }),
    item('coi', 'Certificate of insurance on file', { group: 'Paperwork', upload: 'required', hint: 'Upload the certificate; record the expiry date in the note so it can be chased.' }),
    item('employer_work_auth', 'Employer confirms the consultant’s work authorization', { group: 'Compliance', upload: 'required', hint: 'Upload the employer’s confirmation. The consultant’s own company completes the I-9 for its employee.' }),
    NDA,
    item('remittance', 'Company banking / remittance details collected', { group: 'Paperwork', form: 'banking', on: 'supplier', formOnly: true, hint: 'The ACH / Wire banking authorization form, filled in and signed. Needs the supplier company (created with the directory records).' }),
    H1B,
  ].concat(COMMON_TAIL),
  '1099': [
    item('contractor_agreement', 'Independent contractor agreement signed', { group: 'Paperwork' }),
    item('w9', 'Form W-9', { group: 'Paperwork', form: 'w9', on: 'consultant' }),
    item('i9', 'Form I-9 (employment eligibility)', { group: 'Paperwork', form: 'i9', on: 'consultant', hint: 'Kept for contractors as company practice.' }),
    NDA,
    item('payment_details', 'Payment (ACH) details collected', { group: 'Paperwork' }),
    H1B,
  ].concat(COMMON_TAIL),
};

const checklistFor = (type, data) => (CHECKLISTS[type] || []).filter((c) => !c.when || String((data || {})[c.when.key]) === c.when.value);

// -------------------------------------------------------------- e-mail text
const EMAIL_ROWS = [
  ['Consultant Name', 'consultant_name'], ['Consultant Contact Number', 'phone'], ['Consultant Email', 'email'],
  ['Technical Skill', 'technical_skill'], ['Status (W2/C2C/1099)', '@type'], ['Project Start Date', '@start'],
  ['Project Duration', 'duration'], ['End Client', 'end_client'], ['Project Location (State and City)', 'location'],
  ['Bill To (Customer – T1/End Client)', 'bill_to'], ['Bill Rate', '@bill'], ['Pay To (Consultant/Vendor)', 'pay_to'],
  ['Pay Rate', '@pay'], ['Final Cost (if different than pay rate)', '@final'], ['Account Manager Name', 'account_manager'],
  ['Delivery Manager', 'delivery_manager'], ['Recruiter Name', 'recruiter'], ['H1B Filing Required', 'h1b_filing_required'],
  ['Invoicing – QuickBooks or Client Portal', 'invoicing_method'], ['Who should the invoice be sent to', '@invoice_to'],
  ['Timesheet sent along with the invoice (Client, Implementation partners)', 'timesheet_requirement'],
];
const fmtUsDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[2]}/${m[3]}/${m[1]}` : ''; };
const rateText = (v, basis) => (v === undefined || v === null || v === '' ? '' : `$${v}/${({ Hourly: 'hr', Daily: 'day', Monthly: 'month', Annual: 'year' })[basis] || 'hr'}`);

function buildEmail(type, data) {
  const d = data || {};
  const val = (k) => {
    if (k === '@type') return type;
    if (k === '@start') return fmtUsDate(d.start_date);
    if (k === '@bill') return rateText(d.bill_rate, d.bill_rate_basis);
    if (k === '@pay') return rateText(d.pay_rate, d.pay_rate_basis);
    if (k === '@final') return rateText(d.final_cost, d.pay_rate_basis);
    if (k === '@invoice_to') return [d.invoice_to_email, d.invoice_to_name].filter(Boolean).join(' – ');
    return d[k] === undefined || d[k] === null ? '' : String(d[k]);
  };
  const lines = ['PLACEMENT INFORMATION', ''];
  EMAIL_ROWS.forEach(([label, k]) => { lines.push(label + ':', val(k), ''); });
  if (type === 'C2C') {
    lines.push('Candidate Employer Details', '');
    [d.employer_name, d.employer_email, d.employer_phone, [d.employer_address, d.employer_city, d.employer_state, d.employer_zip].filter(Boolean).join(', ')]
      .filter(Boolean).forEach((x) => lines.push(x));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// Reads the same e-mail back into fields. Anything it cannot place is returned
// in `unmatched` so nothing is silently dropped.
const LABELS = [
  [/^consultant\s*name/i, 'consultant_name'], [/^(consultant\s*)?contact\s*(number|no)/i, 'phone'], [/^consultant\s*e-?mail/i, 'email'],
  [/^technical\s*skill/i, 'technical_skill'], [/^status\b/i, 'worker_type'], [/^project\s*start/i, 'start_date'],
  [/^project\s*duration/i, 'duration'], [/^end\s*client/i, 'end_client'], [/^project\s*location/i, 'location'],
  [/^bill\s*to\b/i, 'bill_to'], [/^bill\s*rate/i, 'bill_rate'], [/^pay\s*to\b/i, 'pay_to'], [/^pay\s*rate/i, 'pay_rate'],
  [/^final\s*cost/i, 'final_cost'], [/^account\s*manager/i, 'account_manager'], [/^delivery\s*manager/i, 'delivery_manager'],
  [/^recruiter/i, 'recruiter'], [/^h-?1b\s*filing/i, 'h1b_filing_required'], [/^invoicing\b/i, 'invoicing_method'],
  [/^who\s*should\s*the\s*invoice/i, 'invoice_to'], [/^which\s*timesheet|^timesheet\s*sent/i, 'timesheet_requirement'],
  [/^candidate\s*employer/i, 'employer_block'],
];

function parseDate(s) {
  const t = String(s || '').trim();
  let m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(t);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t); if (m) return t;
  const d = new Date(t + ' UTC'); if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return '';
}
function parseRate(s) {
  const m = /([\d,]+(?:\.\d+)?)/.exec(String(s || '')); if (!m) return null;
  const t = String(s).toLowerCase();
  const basis = /\/\s*(day)|per day|daily/.test(t) ? 'Daily' : /\/\s*(mo|month)|monthly|per month/.test(t) ? 'Monthly' : /\/\s*(yr|year)|annual|per year|salary/.test(t) ? 'Annual' : 'Hourly';
  return { value: Number(m[1].replace(/,/g, '')), basis };
}

function parseEmail(text) {
  const fields = {}; const unmatched = []; const matched = [];
  let cur = null;
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/ /g, ' ').trim());
  const flush = () => { if (cur) { cur.value = cur.parts.join(' ').trim(); apply(cur); } cur = null; };
  function apply(sec) {
    const v = sec.value; const k = sec.key;
    if (k === 'employer_block') {
      const ls = sec.parts.slice();
      ls.forEach((x) => {
        if (/@/.test(x) && !fields.employer_email) fields.employer_email = x;
        else if (/^[\d\s().+-]{7,}$/.test(x) && !fields.employer_phone) fields.employer_phone = x;
        else if (!fields.employer_name) fields.employer_name = x;
        else fields.employer_address = [fields.employer_address, x].filter(Boolean).join(', ');
      });
      if (ls.length) matched.push('employer_name');
      return;
    }
    if (!v) return;
    if (k === 'worker_type') { const t = /c\s*2\s*c|corp/i.test(v) ? 'C2C' : /1099/.test(v) ? '1099' : /w-?2/i.test(v) ? 'W2' : ''; if (t) { fields.worker_type = t; matched.push(k); } return; }
    if (k === 'start_date') { const d = parseDate(v); if (d) { fields.start_date = d; matched.push(k); } return; }
    if (k === 'bill_rate' || k === 'pay_rate' || k === 'final_cost') {
      const r = parseRate(v); if (!r) return;
      fields[k] = r.value; matched.push(k);
      if (k === 'bill_rate') fields.bill_rate_basis = r.basis; else if (k === 'pay_rate') fields.pay_rate_basis = r.basis;
      return;
    }
    if (k === 'h1b_filing_required') { fields[k] = /^\s*(y|yes)/i.test(v) ? 'Yes' : /^\s*(n|no)/i.test(v) ? 'No' : ''; if (fields[k]) matched.push(k); return; }
    if (k === 'invoicing_method') { fields[k] = /quickbooks/i.test(v) && !/portal/i.test(v) ? 'QuickBooks' : /portal/i.test(v) && !/quickbooks/i.test(v) ? 'Client portal' : 'Other'; matched.push(k); return; }
    if (k === 'invoice_to') {
      const em = /[^\s@]+@[^\s@]+\.[^\s@]+/.exec(v);
      const rest = v.replace(/[^\s@]*@[^\s@]*/g, '').replace(/^[\s\-–,]+|[\s\-–,]+$/g, '');
      if (em && !/^x+@/i.test(em[0])) { fields.invoice_to_email = em[0]; matched.push('invoice_to_email'); }
      if (rest && !/^x+$/i.test(rest)) { fields.invoice_to_name = rest; matched.push('invoice_to_name'); }
      return;
    }
    fields[k] = v; matched.push(k);
  }
  for (const line of lines) {
    if (!line) continue;
    const hit = LABELS.find(([re]) => re.test(line));
    if (hit) {
      flush();
      const key = hit[1];
      let inline = '';
      const ci = line.indexOf(':');
      if (ci !== -1) inline = line.slice(ci + 1).trim();
      else if (key === 'invoice_to') { const m = /sent[^-–]*[-–]\s*(.*)$/i.exec(line); inline = m ? m[1].trim() : ''; }
      cur = { key, parts: inline ? [inline] : [] };
      continue;
    }
    if (cur) cur.parts.push(line); else if (!/^placement information$/i.test(line)) unmatched.push(line);
  }
  flush();
  // a pay rate typed only on the bill-rate row, etc. is left as is; just tidy up
  return { fields, worker_type: fields.worker_type || '', matched: Array.from(new Set(matched)), unmatched };
}

// Old checklist JSON -> current keys: renamed keys move over (without overwriting newer data),
// removed items simply stop showing (their stored state is kept, never deleted).
function migrateChecklist(stored) {
  const out = Object.assign({}, stored || {});
  Object.entries(RENAMED).forEach(([from, to]) => { if (out[from] && !out[to]) out[to] = out[from]; delete out[from]; });
  return out;
}

module.exports = { migrateChecklist, RENAMED, REMOVED, WORKER_TYPES, SECTIONS, sectionsFor, fieldsFor, CHECKLISTS, checklistFor, buildEmail, parseEmail, RATE_BASIS, US_STATES };
