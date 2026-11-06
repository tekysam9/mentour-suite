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
const C = require('../countries');
const REGIONS = { 'United States': US_STATES, Canada: C.CA_PROVINCES, India: C.IN_STATES };
const f = (key, label, kind, extra) => Object.assign({ key, label, kind }, extra || {});

const WORKER_TYPES = [
  { key: 'W2', label: 'W-2 employee', blurb: 'On Mentour payroll. Withholding (W-4), employment eligibility (I-9), direct deposit and benefits.' },
  { key: 'C2C', label: 'Corp-to-corp (C2C)', blurb: 'Works through their own company. We contract with that company: its W-9, a subcontract agreement and insurance.' },
  { key: '1099', label: '1099 contractor', blurb: 'Individual independent contractor. Contractor agreement and W-9, paid on a 1099.' },
];

const SECTIONS = [
  { key: 'consultant', title: 'Consultant', fields: [
    f('consultant_name', 'Consultant name', 'text', { required: true }),
    f('country', 'Country', 'select', { options: C.COUNTRIES, help: 'Where the consultant is based and paid. Changes the address fields, currency and paperwork below. Blank = United States.' }),
    f('phone', 'Contact number', 'phone'),
    f('email', 'Email', 'email'),
    f('technical_skill', 'Technical skill', 'text'),
    f('work_authorization', 'Work authorization', 'select', { options: ['US citizen', 'Green card', 'H-1B', 'L-1', 'OPT / CPT', 'TN', 'EAD', 'Other'], byCountry: { Canada: { options: ['Canadian citizen', 'Permanent resident', 'Work permit', 'Other'] }, India: { options: ['Indian citizen', 'OCI', 'Work visa', 'Other'] } } }),
    f('h1b_filing_required', 'H-1B filing required', 'select', { options: YES_NO, required: true, byCountry: { Canada: { help: 'Choose No unless the consultant is being moved to the US.' }, India: { help: 'Choose No unless the consultant is being moved to the US.' } } }),
    f('visa_expiry', 'Visa / work authorization expiry', 'date', { byCountry: { Canada: { label: 'Work permit expiry' }, India: { label: 'Visa expiry' } } }),
    f('emergency_contact', 'Emergency contact (name, relationship, phone)', 'text', { wide: true }),
    f('laptop_address', 'Address for laptop shipment', 'text', { wide: true }),
  ] },
  { key: 'placement', title: 'Placement', fields: [
    f('start_date', 'Project start date', 'date', { required: true }),
    f('duration', 'Project duration', 'text', { help: 'e.g. 12 months' }),
    f('end_client', 'End client', 'text', { required: true, help: 'As you write it in the e-mail, e.g. "CDW / OCC".' }),
    f('bill_to', 'Bill to (customer: T1 / end client)', 'text'),
    f('location', 'Project location (state and city)', 'text', { help: 'Or "Remote".', byCountry: { Canada: { label: 'Project location (province and city)' } } }),
  ] },
  { key: 'rates', title: 'Rates', fields: [
    f('bill_rate', 'Bill rate', 'number', { required: true }),
    f('bill_currency', 'Bill currency', 'select', { options: C.CURRENCIES, help: 'Blank = USD for a US consultant, the country’s currency otherwise.' }),
    f('bill_rate_basis', 'Bill rate basis', 'select', { options: RATE_BASIS }),
    f('pay_to', 'Pay to (consultant / vendor)', 'text'),
    f('pay_rate', 'Pay rate', 'number', { required: true }),
    f('pay_currency', 'Pay currency', 'select', { options: C.CURRENCIES, help: 'The final cost below is in this currency. Margin is only worked out when bill and pay currency are the same.' }),
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
    f('employer_state', 'State', 'select', { regions: true, options: US_STATES, byCountry: { Canada: { label: 'Province / territory' }, India: { label: 'State / UT' } } }),
    f('employer_zip', 'ZIP', 'text', { byCountry: { Canada: { label: 'Postal code', help: 'e.g. M5V 2T6' }, India: { label: 'PIN code', help: '6 digits' } } }),
    f('employer_fax', 'Company fax', 'phone'),
    f('employer_incorporated_state', 'Incorporated state / province', 'text'),
    f('employer_tax_id', 'Federal tax ID (EIN)', 'text', { help: 'Copied (encrypted) to the supplier company when the directory records are created.', byCountry: { Canada: { label: 'Business Number (BN) / GST-HST number' }, India: { label: 'Company PAN / GSTIN' } } }),
    f('signer_name', 'Signing authority: name', 'text'),
    f('signer_designation', 'Signing authority: designation', 'text'),
    f('signer_phone', 'Signing authority: phone', 'phone'),
    f('signer_email', 'Signing authority: email', 'email'),
  ] },
  { key: 'employment', title: 'Employment terms', types: ['W2'], fields: [
    f('job_title', 'Job title', 'text', { required: true }),
    f('employment_type', 'Employment type', 'select', { options: ['Full-time', 'Part-time'] }),
    f('flsa_status', 'Overtime status', 'select', { options: ['Non-exempt (overtime eligible)', 'Exempt'] }),
    f('pay_frequency', 'Pay frequency', 'select', { options: ['Weekly', 'Bi-weekly', 'Semi-monthly', 'Monthly'] }),
    f('work_state', 'State of work (for tax withholding)', 'select', { regions: true, options: US_STATES, required: true, byCountry: { Canada: { label: 'Province of work (for tax withholding)' }, India: { label: 'State of work (for tax)' } } }),
    f('benefits_eligible', 'Benefits eligible', 'select', { options: YES_NO }),
    f('offer_date', 'Offer letter date', 'date'),
    f('address', 'Home street address', 'text'),
    f('city', 'City', 'text'),
    f('state', 'State', 'select', { regions: true, options: US_STATES, byCountry: { Canada: { label: 'Province / territory' }, India: { label: 'State / UT' } } }),
    f('zip', 'ZIP', 'text', { byCountry: { Canada: { label: 'Postal code', help: 'e.g. M5V 2T6' }, India: { label: 'PIN code', help: '6 digits' } } }),
  ] },
  { key: 'contractor', title: 'Contractor details', types: ['1099'], fields: [
    f('business_name', 'Business name / DBA (if any)', 'text'),
    f('contract_end_date', 'Agreement end date', 'date'),
    f('payment_terms', 'Payment terms', 'select', { options: ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60'] }),
    f('address', 'Street address', 'text'),
    f('city', 'City', 'text'),
    f('state', 'State', 'select', { regions: true, options: US_STATES, byCountry: { Canada: { label: 'Province / territory' }, India: { label: 'State / UT' } } }),
    f('zip', 'ZIP', 'text', { byCountry: { Canada: { label: 'Postal code', help: 'e.g. M5V 2T6' }, India: { label: 'PIN code', help: '6 digits' } } }),
  ] },
];

// Why a consultant backed out (a required choice when an onboarding is marked Withdrawn).
const WITHDRAW_REASONS = [
  { key: 'other_offer', label: 'Accepted another offer' },
  { key: 'rate_terms', label: 'Rate or terms not acceptable' },
  { key: 'client_change', label: 'Client changed or cancelled the role' },
  { key: 'visa', label: 'Visa or work authorization problem' },
  { key: 'personal', label: 'Personal reasons' },
  { key: 'no_response', label: 'Stopped responding' },
  { key: 'other', label: 'Other (explain)' },
];
const sectionsFor = (type) => SECTIONS.filter((s) => !s.types || s.types.includes(type));
const fieldsFor = (type) => sectionsFor(type).flatMap((s) => s.fields);
// A field as it applies to one country: its label / help / options (and region list) swapped for that country's.
function effective(fld, country) {
  const out = Object.assign({}, fld, (fld.byCountry || {})[country] || {});
  if (fld.regions) out.options = REGIONS[country] || US_STATES;
  delete out.byCountry;
  return out;
}
// The currency a rate is in: what was chosen, else the country's own currency.
const currencyOf = (d, side) => (d && d[side + '_currency']) || C.CURRENCY[C.countryOf(d)];

// ---------------------------------------------------------------- checklist
// form: a fillable form in this app (auto-ticks when fully signed)
// on: 'consultant' | 'supplier'  -> which directory record the form lives on
// when: item only applies when data[key] === value
const item = (key, label, extra) => Object.assign({ key, label }, extra || {});
// answer: 'yesno'          -> HR picks Yes / No; the item is done once answered
// upload: 'required'       -> done once a document is uploaded
// upload: 'optional'       -> a document can be attached but is not needed
// optional: true           -> shown, but never blocks completion
// uploadInstead: true -> (C2C / 1099 forms) HR may upload the completed document instead of filling the form in here
// future: 'fillable-pdf'   -> later becomes a fillable PDF with e-signature (upload for now)
const COMMON_TAIL = [
  item('background_check', 'Background check cleared', { group: 'Compliance', answer: 'yesno', upload: 'optional', hint: 'Choose Yes or No. Attaching the report is optional.' }),
  item('rate_confirmation', 'Rate confirmation sent and accepted', { group: 'Commercial', answer: 'yesno', hint: 'Bill rate and pay rate agreed in writing.' }),
  item('timesheet_access', 'Timesheet process and access arranged', { group: 'Setup', answer: 'yesno' }),
  item('resume', 'Resume', { group: 'Setup', optional: true, upload: 'optional', hint: 'Copied from the pre-placement when the candidate was sent here. Optional; attach or replace it if needed.' }),
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
    item('w4', 'Form W-4 (federal withholding)', { group: 'Paperwork', form: 'w4', on: 'consultant', countries: ['United States'] }),
    item('i9', 'Form I-9 (employment eligibility)', { group: 'Paperwork', form: 'i9', on: 'consultant', countries: ['United States'], hint: 'Employee completes Section 1 by day one; the employer completes Section 2 within 3 business days of the start date.' }),
    item('state_withholding', 'State withholding form', { group: 'Paperwork', countries: ['United States'], hint: 'The state form for the state of work, if it has one.' }),
    item('td1', 'Forms TD1 (federal) and TD1 (provincial) signed', { group: 'Paperwork', countries: ['Canada'], hint: 'The consultant’s personal tax credit returns, used for payroll withholding.' }),
    item('sin', 'SIN collected and verified', { group: 'Compliance', answer: 'yesno', countries: ['Canada'], hint: 'Choose Yes once seen. The number itself is kept in payroll, not stored here.' }),
    item('work_permit', 'Proof of right to work in Canada', { group: 'Compliance', upload: 'required', countries: ['Canada'], hint: 'Upload the work permit, PR card or citizenship proof; note the expiry date.' }),
    item('pan', 'PAN collected', { group: 'Compliance', answer: 'yesno', countries: ['India'], hint: 'Choose Yes once seen. The number itself is kept in payroll, not stored here.' }),
    item('id_proof', 'ID and address proof collected', { group: 'Compliance', upload: 'required', countries: ['India'], hint: 'Upload a government ID and an address proof.' }),
    item('direct_deposit', 'Direct deposit details collected', { group: 'Paperwork', form: 'banking', on: 'consultant', formOnly: true, countries: ['United States'], hint: 'The ACH / Wire banking authorization form on the consultant, filled in and signed. Needs the directory records.' }),
    item('bank_ca', 'Bank details collected (void cheque or bank letter)', { group: 'Paperwork', upload: 'required', countries: ['Canada'], hint: 'Institution, transit and account number from a void cheque or bank letter.' }),
    item('bank_in', 'Bank account details collected (account number and IFSC)', { group: 'Paperwork', upload: 'required', countries: ['India'], hint: 'A cancelled cheque or bank statement page showing the account number and IFSC.' }),
    item('emergency_contact', 'Emergency contact collected', { group: 'Paperwork' }),
    item('handbook', 'Handbook and policies acknowledged', { group: 'Paperwork' }),
    NDA,
    item('everify', 'E-Verify case created', { group: 'Compliance', countries: ['United States'], hint: 'Only if the company is enrolled.' }),
    H1B,
    item('benefits', 'Benefits enrollment offered or waived', { group: 'Setup' }),
    item('payroll_setup', 'Added to payroll', { group: 'Setup' }),
  ].concat(COMMON_TAIL.filter((x) => x.key !== 'rate_confirmation')),
  C2C: [
    item('company_gst', 'Company Business Number / GST-HST registration', { group: 'Paperwork', upload: 'required', countries: ['Canada'], hint: 'Upload the CRA registration or a GST/HST number confirmation for the consultant’s company.' }),
    item('company_pan', 'Company PAN and GSTIN registration', { group: 'Paperwork', upload: 'required', countries: ['India'], hint: 'Upload the company’s PAN card and GST registration certificate.' }),
    item('company_w9', 'Company Form W-9', { group: 'Paperwork', form: 'w9', on: 'supplier', uploadInstead: true, countries: ['United States'], hint: 'The consultant’s company fills this in; it needs the company to exist as a supplier company (created for you).' }),
    item('vendor_agreement', 'Vendor agreement', { group: 'Paperwork', upload: 'required', future: 'fillable-pdf', hint: 'Upload the signed agreement.' }),
    item('coi', 'Certificate of insurance on file', { group: 'Paperwork', upload: 'required', hint: 'Upload the certificate; record the expiry date in the note so it can be chased.' }),
    item('employer_work_auth_intl', 'Employer confirms the consultant’s right to work', { group: 'Compliance', upload: 'required', countries: ['Canada', 'India'], hint: 'Upload the employer’s confirmation (work permit or ID proof on file).' }),
    item('employer_work_auth', 'Employer confirms the consultant’s work authorization', { group: 'Compliance', upload: 'required', countries: ['United States'], hint: 'Upload the employer’s confirmation. The consultant’s own company completes the I-9 for its employee.' }),
    NDA,
    item('remittance', 'Company banking / remittance details collected', { group: 'Paperwork', form: 'banking', on: 'supplier', uploadInstead: true, formOnly: true, countries: ['United States'], hint: 'The ACH / Wire banking authorization form, filled in and signed. Needs the supplier company (created with the directory records).' }),
    item('remittance_intl', 'Company bank details collected (void cheque / bank letter, SWIFT or IFSC)', { group: 'Paperwork', upload: 'required', countries: ['Canada', 'India'], hint: 'Bank letter or cancelled cheque for the consultant’s company, with SWIFT / IFSC where it is paid by wire.' }),
    H1B,
  ].concat(COMMON_TAIL),
  '1099': [
    item('contractor_agreement', 'Independent contractor agreement signed', { group: 'Paperwork' }),
    item('w9', 'Form W-9', { group: 'Paperwork', form: 'w9', on: 'consultant', uploadInstead: true, countries: ['United States'] }),
    item('sin', 'SIN collected and verified', { group: 'Compliance', answer: 'yesno', countries: ['Canada'], hint: 'Choose Yes once seen. The number itself is kept in payroll, not stored here.' }),
    item('work_permit', 'Proof of right to work in Canada', { group: 'Compliance', upload: 'required', countries: ['Canada'], hint: 'Upload the work permit, PR card or citizenship proof; note the expiry date.' }),
    item('pan', 'PAN collected', { group: 'Compliance', answer: 'yesno', countries: ['India'], hint: 'Choose Yes once seen. The number itself is kept in payroll, not stored here.' }),
    item('id_proof', 'ID and address proof collected', { group: 'Compliance', upload: 'required', countries: ['India'], hint: 'Upload a government ID and an address proof.' }),
    item('i9', 'Form I-9 (employment eligibility)', { group: 'Paperwork', form: 'i9', on: 'consultant', uploadInstead: true, countries: ['United States'], hint: 'Kept for contractors as company practice.' }),
    NDA,
    item('payment_details', 'Payment (ACH) details collected', { group: 'Paperwork', form: 'banking', on: 'consultant', uploadInstead: true, formOnly: true, countries: ['United States'], hint: 'The ACH / Wire banking authorization form on the consultant, filled in and signed. Needs the directory records.' }),
    item('bank_ca', 'Bank details collected (void cheque or bank letter)', { group: 'Paperwork', upload: 'required', countries: ['Canada'], hint: 'Institution, transit and account number from a void cheque or bank letter.' }),
    item('bank_in', 'Bank account details collected (account number and IFSC)', { group: 'Paperwork', upload: 'required', countries: ['India'], hint: 'A cancelled cheque or bank statement page showing the account number and IFSC.' }),
    H1B,
  ].concat(COMMON_TAIL),
};

const checklistFor = (type, data) => (CHECKLISTS[type] || []).filter((c) => (!c.when || String((data || {})[c.when.key]) === c.when.value) && (!c.countries || c.countries.includes(C.countryOf(data))));

// -------------------------------------------------------------- e-mail text
const EMAIL_ROWS = [
  ['Consultant Name', 'consultant_name'], ['Consultant Contact Number', 'phone'], ['Consultant Email', 'email'],
  ['Technical Skill', 'technical_skill'], ['Status (W2/C2C/1099)', '@type'], ['Project Start Date', '@start'],
  ['Project Duration', 'duration'], ['End Client', 'end_client'], ['Project Location (State and City)', 'location'], ['Country', 'country'],
  ['Bill To (Customer – T1/End Client)', 'bill_to'], ['Bill Rate', '@bill'], ['Pay To (Consultant/Vendor)', 'pay_to'],
  ['Pay Rate', '@pay'], ['Final Cost (if different than pay rate)', '@final'], ['Account Manager Name', 'account_manager'],
  ['Delivery Manager', 'delivery_manager'], ['Recruiter Name', 'recruiter'], ['H1B Filing Required', 'h1b_filing_required'],
  ['Invoicing – QuickBooks or Client Portal', 'invoicing_method'], ['Who should the invoice be sent to', '@invoice_to'],
  ['Timesheet sent along with the invoice (Client, Implementation partners)', 'timesheet_requirement'],
];
const fmtUsDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[2]}/${m[3]}/${m[1]}` : ''; };
const rateText = (v, basis, cur) => (v === undefined || v === null || v === '' ? '' : `${C.SYMBOL[cur] || '$'}${v}/${({ Hourly: 'hr', Daily: 'day', Monthly: 'month', Annual: 'year' })[basis] || 'hr'}`);

function buildEmail(type, data) {
  const d = data || {};
  const val = (k) => {
    if (k === '@type') return type;
    if (k === '@start') return fmtUsDate(d.start_date);
    if (k === '@bill') return rateText(d.bill_rate, d.bill_rate_basis, currencyOf(d, 'bill'));
    if (k === '@pay') return rateText(d.pay_rate, d.pay_rate_basis, currencyOf(d, 'pay'));
    if (k === '@final') return rateText(d.final_cost, d.pay_rate_basis, currencyOf(d, 'pay'));
    if (k === '@invoice_to') return [d.invoice_to_email, d.invoice_to_name].filter(Boolean).join(' – ');
    return d[k] === undefined || d[k] === null ? '' : String(d[k]);
  };
  const lines = ['PLACEMENT INFORMATION', ''];
  EMAIL_ROWS.forEach(([label, k]) => { if (k === 'country' && !d.country) return; lines.push(label + ':', val(k), ''); });
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
  [/^project\s*duration/i, 'duration'], [/^end\s*client/i, 'end_client'], [/^project\s*location/i, 'location'], [/^country\b/i, 'country'],
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
  const currency = /\bCAD\b|\bC\$|\bCA\$/i.test(t) ? 'CAD' : /\bINR\b|₹|\brs\b\.?/i.test(t) ? 'INR' : /\bUSD\b|\bUS\$/i.test(t) ? 'USD' : '';
  return { value: Number(m[1].replace(/,/g, '')), basis, currency };
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
      if (k === 'bill_rate') { fields.bill_rate_basis = r.basis; if (r.currency) fields.bill_currency = r.currency; } else if (k === 'pay_rate') { fields.pay_rate_basis = r.basis; if (r.currency) fields.pay_currency = r.currency; }
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
    if (k === 'country') { const cn = C.normalizeCountry(v); if (C.COUNTRIES.includes(cn)) { fields.country = cn; matched.push(k); } return; }
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
  if (!fields.country) { const dc = C.detectCountry(String(text || '')); if (dc) { fields.country = dc; matched.push('country'); } }
  return { fields, worker_type: fields.worker_type || '', matched: Array.from(new Set(matched)), unmatched };
}

// Old checklist JSON -> current keys: renamed keys move over (without overwriting newer data),
// removed items simply stop showing (their stored state is kept, never deleted).
function migrateChecklist(stored) {
  const out = Object.assign({}, stored || {});
  Object.entries(RENAMED).forEach(([from, to]) => { if (out[from] && !out[to]) out[to] = out[from]; delete out[from]; });
  return out;
}

module.exports = { migrateChecklist, RENAMED, REMOVED, WORKER_TYPES, SECTIONS, sectionsFor, fieldsFor, CHECKLISTS, checklistFor, buildEmail, parseEmail, RATE_BASIS, US_STATES, WITHDRAW_REASONS, REGIONS, effective, currencyOf };
