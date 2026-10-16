// Field definitions for the fillable tax / employment-eligibility forms:
//   w9  (IRS Form W-9, Request for Taxpayer Identification Number)  -> vendors
//   w4  (IRS Form W-4, Employee's Withholding Certificate)           -> consultants / employees
//   i9  (USCIS Form I-9, Employment Eligibility Verification)        -> consultants / employees
//
// These capture the fields the official forms ask for, in the same order and
// wording, with an electronic signature step. They are an in-app record, not
// a replacement for the government's own form layout: confirm the current
// edition at irs.gov / uscis.gov. Identifying numbers (TIN, SSN, A-number,
// I-94, document numbers) are `secret` fields: encrypted at rest, write-only,
// shown as last 4 only (see src/crypto.js).
//
// A section with `signKey` is locked once that signature is applied.
// `requiredIf: { key, in: [...] }` makes a field required only for some
// answers; `required: true` always applies when its section is signed.

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','PR','GU','VI','AS','MP'];
const f = (key, label, kind, extra) => Object.assign({ key, label, kind }, extra || {});
const addr = (req) => [
  f('address', 'Address (number and street)', 'text', { required: req }),
  f('apt', 'Apt. number', 'text'),
  f('city', 'City or town', 'text', { required: req }),
  f('state', 'State', 'select', { options: US_STATES, required: req }),
  f('zip', 'ZIP code', 'text', { required: req }),
];

const FORMS = {
  w9: {
    title: 'Form W-9', subtitle: 'Request for Taxpayer Identification Number and Certification',
    edition: 'Layout reference: IRS Form W-9 (Rev. March 2024)', entities: ['programs', 'subvendors', 'consultants'],
    signatures: { payee: { label: 'Payee signature' } },
    sections: [
      { title: 'Part I — Taxpayer information', signKey: 'payee', fields: [
        f('name', '1. Name of entity/individual (as shown on your income tax return)', 'text', { required: true }),
        f('business_name', '2. Business name / disregarded entity name, if different', 'text'),
        f('tax_class', '3a. Federal tax classification', 'select', { required: true, options: ['Individual/sole proprietor', 'C corporation', 'S corporation', 'Partnership', 'Trust/estate', 'Limited liability company', 'Other'] }),
        f('llc_class', 'LLC tax classification (C = C corp, S = S corp, P = Partnership)', 'select', { options: ['C', 'S', 'P'], requiredIf: { key: 'tax_class', in: ['Limited liability company'] } }),
        f('other_class', 'Other (see instructions)', 'text', { requiredIf: { key: 'tax_class', in: ['Other'] } }),
        f('foreign_partners', '3b. Has partners, owners or beneficiaries that are foreign (partnership / trust / estate)', 'bool'),
        f('exempt_payee_code', '4. Exempt payee code (if any)', 'text'),
        f('fatca_code', '4. Exemption from FATCA reporting code (if any)', 'text'),
      ].concat(addr(true).map((x) => Object.assign({}, x, { label: '5/6. ' + x.label }))).concat([
        f('account_numbers', '7. List account number(s) here (optional)', 'text'),
        f('tin_type', 'Part I. Taxpayer identification number type', 'select', { required: true, options: ['Social security number', 'Employer identification number'] }),
        f('tin', 'Taxpayer identification number', 'secret', { secretKind: 'taxid', required: true, help: 'Encrypted. Only the last 4 are ever shown.' }),
      ]) },
      { title: 'Part II — Certification', signKey: 'payee', fields: [
        f('cert1', '1. The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me)', 'attest', { required: true }),
        f('cert2_backup', '2. I am subject to backup withholding (leave unchecked if you are NOT subject to backup withholding)', 'bool', {
          help: 'Unchecked means you certify you are not subject to backup withholding, or that the IRS has notified you that you are no longer subject.' }),
        f('cert3', '3. I am a U.S. citizen or other U.S. person', 'attest', { required: true }),
        f('cert4', '4. The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct', 'attest', { required: true }),
      ] },
    ],
  },

  w4: {
    title: 'Form W-4', subtitle: 'Employee’s Withholding Certificate',
    edition: 'Layout reference: IRS Form W-4 (Steps 1–5 and employer section)', entities: ['consultants'],
    signatures: { employee: { label: 'Employee signature' }, employer: { label: 'Employer sign-off' } },
    sections: [
      { title: 'Step 1 — Personal information', signKey: 'employee', fields: [
        f('first_name', '(a) First name and middle initial', 'text', { required: true }),
        f('last_name', 'Last name', 'text', { required: true }),
      ].concat(addr(true)).concat([
        f('ssn', '(b) Social security number', 'secret', { secretKind: 'ssn', required: true, help: 'Encrypted. Only the last 4 are ever shown.' }),
        f('filing_status', '(c) Filing status', 'select', { required: true, options: ['Single or Married filing separately', 'Married filing jointly or Qualifying surviving spouse', 'Head of household'] }),
      ]) },
      { title: 'Step 2 — Multiple jobs or spouse works', signKey: 'employee', fields: [
        f('multiple_jobs', '(c) Two jobs total, or spouse also works and the pay is similar (check the box if this applies)', 'bool'),
        f('step2_note', 'Notes on Step 2 (worksheet / estimator result)', 'textarea'),
      ] },
      { title: 'Step 3 — Claim dependent and other credits', signKey: 'employee', fields: [
        f('qualifying_children', 'Qualifying children under age 17 (number)', 'number'),
        f('other_dependents', 'Other dependents (number)', 'number'),
        f('step3_total', 'Step 3 total credit amount ($) — per the form’s instructions', 'number'),
      ] },
      { title: 'Step 4 — Other adjustments (optional)', signKey: 'employee', fields: [
        f('other_income', '(a) Other income not from jobs ($)', 'number'),
        f('deductions', '(b) Deductions beyond the standard deduction ($)', 'number'),
        f('extra_withholding', '(c) Extra withholding per pay period ($)', 'number'),
        f('exempt', 'Claim exemption from withholding (only if you meet both conditions on the form)', 'bool'),
      ] },
      { title: 'Step 5 — Sign here', signKey: 'employee', fields: [
        f('employee_attest', 'Under penalties of perjury, I declare that this certificate, to the best of my knowledge and belief, is true, correct, and complete.', 'attest', { required: true }),
      ] },
      { title: 'Employers only', signKey: 'employer', fields: [
        f('employer_name', 'Employer’s name', 'text', { required: true }),
        f('employer_address', 'Employer’s address', 'text', { required: true }),
        f('first_date_employment', 'First date of employment', 'date', { required: true }),
        f('employer_ein', 'Employer identification number (EIN)', 'secret', { secretKind: 'taxid', help: 'Encrypted. Only the last 4 are ever shown.' }),
      ] },
    ],
  },

  i9: {
    title: 'Form I-9', subtitle: 'Employment Eligibility Verification',
    edition: 'Layout reference: USCIS Form I-9 (Section 1, Section 2, Supplement/Section 3)', entities: ['consultants'],
    signatures: { employee: { label: 'Employee signature (Section 1)' }, employer: { label: 'Employer representative (Section 2)' }, reverify: { label: 'Employer representative (Section 3)' } },
    sections: [
      { title: 'Section 1 — Employee information and attestation', signKey: 'employee', fields: [
        f('last_name', 'Last name (family name)', 'text', { required: true }),
        f('first_name', 'First name (given name)', 'text', { required: true }),
        f('middle_initial', 'Middle initial', 'text'),
        f('other_last_names', 'Other last names used (if any)', 'text'),
      ].concat(addr(true)).concat([
        f('dob', 'Date of birth', 'date', { required: true }),
        f('ssn', 'U.S. Social Security number', 'secret', { secretKind: 'ssn', help: 'Optional unless the employer uses E-Verify. Encrypted. Only the last 4 are ever shown.' }),
        f('email', 'Employee’s email address', 'email'),
        f('phone', 'Employee’s telephone number', 'phone'),
        f('citizenship', 'I attest, under penalty of perjury, that I am', 'select', { required: true, options: ['A citizen of the United States', 'A noncitizen national of the United States', 'A lawful permanent resident', 'A noncitizen authorized to work'] }),
        f('lpr_a_number', 'USCIS A-Number (lawful permanent resident)', 'secret', { secretKind: 'anumber', help: 'Encrypted. Only the last 4 are ever shown.' }),
        f('work_until', 'Authorized to work until (date) — noncitizen authorized to work', 'date', { requiredIf: { key: 'citizenship', in: ['A noncitizen authorized to work'] } }),
        f('auth_a_number', 'USCIS A-Number — noncitizen authorized to work', 'secret', { secretKind: 'anumber', help: 'Provide A-Number, or Form I-94 admission number, or foreign passport details below.' }),
        f('auth_i94', 'Form I-94 admission number', 'secret', { secretKind: 'docnumber' }),
        f('auth_passport', 'Foreign passport number', 'secret', { secretKind: 'docnumber' }),
        f('auth_passport_country', 'Country of issuance (foreign passport)', 'text'),
        f('preparer_used', 'A preparer and/or translator assisted the employee in completing Section 1', 'bool'),
        f('preparer_details', 'Preparer/translator: name, address, date (the preparer also signs the paper supplement)', 'textarea', { requiredIf: { key: 'preparer_used', in: [true] } }),
        f('employee_attest', 'I am aware that federal law provides for imprisonment and/or fines for false statements or use of false documents in connection with the completion of this form. I attest, under penalty of perjury, that the information provided is true and correct.', 'attest', { required: true }),
      ]) },
      { title: 'Section 2 — Employer or authorized representative review', signKey: 'employer', fields: [
        f('first_day', 'Employee’s first day of employment', 'date', { required: true }),
        f('doc_route', 'Documents examined', 'select', { required: true, options: ['One List A document', 'One List B and one List C document'] }),
        f('docs_in_person', 'Documents examined in person (or by an authorized alternative procedure — note it below)', 'bool'),
        f('alt_procedure', 'Alternative procedure used (e.g., authorized remote examination)', 'text'),
        f('a_title', 'List A — Document title', 'text', { requiredIf: { key: 'doc_route', in: ['One List A document'] } }),
        f('a_authority', 'List A — Issuing authority', 'text', { requiredIf: { key: 'doc_route', in: ['One List A document'] } }),
        f('a_number', 'List A — Document number', 'secret', { secretKind: 'docnumber', help: 'Encrypted. Only the last 4 are ever shown.' }),
        f('a_expiry', 'List A — Expiration date (if any)', 'date'),
        f('b_title', 'List B — Document title', 'text', { requiredIf: { key: 'doc_route', in: ['One List B and one List C document'] } }),
        f('b_authority', 'List B — Issuing authority', 'text', { requiredIf: { key: 'doc_route', in: ['One List B and one List C document'] } }),
        f('b_number', 'List B — Document number', 'secret', { secretKind: 'docnumber' }),
        f('b_expiry', 'List B — Expiration date (if any)', 'date'),
        f('c_title', 'List C — Document title', 'text', { requiredIf: { key: 'doc_route', in: ['One List B and one List C document'] } }),
        f('c_authority', 'List C — Issuing authority', 'text', { requiredIf: { key: 'doc_route', in: ['One List B and one List C document'] } }),
        f('c_number', 'List C — Document number', 'secret', { secretKind: 'docnumber' }),
        f('c_expiry', 'List C — Expiration date (if any)', 'date'),
        f('additional_info', 'Additional information', 'textarea'),
        f('employer_attest', 'I attest, under penalty of perjury, that (1) I have examined the document(s) presented by the above-named employee, (2) the document(s) appear to be genuine and to relate to the employee named, and (3) to the best of my knowledge the employee is authorized to work in the United States.', 'attest', { required: true }),
        f('employer_title', 'Title of employer or authorized representative', 'text', { required: true }),
        f('employer_business', 'Employer’s business or organization name', 'text', { required: true }),
        f('employer_address', 'Employer’s business address', 'text', { required: true }),
      ] },
      { title: 'Section 3 — Reverification and rehires (if needed)', signKey: 'reverify', fields: [
        f('rehire_date', 'Date of rehire (if applicable)', 'date'),
        f('new_name', 'New name (if applicable)', 'text'),
        f('reverify_title', 'Document title', 'text', { required: true }),
        f('reverify_number', 'Document number', 'secret', { secretKind: 'docnumber' }),
        f('reverify_expiry', 'Expiration date (if any)', 'date'),
        f('reverify_attest', 'I attest, under penalty of perjury, that to the best of my knowledge this employee is authorized to work in the United States, and if the employee presented document(s), the document(s) I have examined appear to be genuine and to relate to the individual.', 'attest', { required: true }),
      ] },
    ],
  },
  banking: {
    title: 'ACH / Wire banking authorization', subtitle: 'Bank details for payments (ACH or wire transfer)',
    edition: 'Mentour Corp payment authorization', entities: ['subvendors', 'consultants'],
    signatures: { payee: { label: 'Authorized signer' } },
    sections: [
      { title: 'Payment method', signKey: 'payee', fields: [
        f('method', 'How should we pay you?', 'select', { required: true, options: ['ACH', 'Wire'] }),
        f('bank_name', 'Bank name', 'text', { required: true }),
        f('remit_email', 'Remittance advice email (optional)', 'email'),
      ] },
      { title: 'ACH details', signKey: 'payee', showIf: { key: 'method', in: ['ACH'] }, fields: [
        f('ach_holder', 'Account holder name', 'text', { requiredIf: { key: 'method', in: ['ACH'] } }),
        f('ach_routing', 'Routing number (ABA, 9 digits)', 'secret', { secretKind: 'routing', requiredIf: { key: 'method', in: ['ACH'] }, help: 'Encrypted. Only the last 4 are ever shown.' }),
        f('ach_account', 'Account number', 'secret', { secretKind: 'account', requiredIf: { key: 'method', in: ['ACH'] }, help: 'Encrypted. Only the last 4 are ever shown.' }),
        f('ach_type', 'Account type', 'select', { options: ['Checking', 'Savings'], requiredIf: { key: 'method', in: ['ACH'] } }),
      ] },
      { title: 'Wire details', signKey: 'payee', showIf: { key: 'method', in: ['Wire'] }, fields: [
        f('wire_beneficiary', 'Beneficiary name', 'text', { requiredIf: { key: 'method', in: ['Wire'] } }),
        f('wire_account', 'Account number / IBAN', 'secret', { secretKind: 'wireaccount', requiredIf: { key: 'method', in: ['Wire'] }, help: 'Encrypted. Only the last 4 are ever shown.' }),
        f('wire_aba', 'ABA / routing number (US banks)', 'secret', { secretKind: 'routing', oneOf: 'wire_code', help: 'Give the ABA number or the SWIFT/BIC (or both). Encrypted.' }),
        f('wire_swift', 'SWIFT / BIC code', 'secret', { secretKind: 'swift', oneOf: 'wire_code', help: 'Encrypted. Only the last 4 are ever shown.' }),
        f('wire_bank_address', 'Bank address', 'textarea', { requiredIf: { key: 'method', in: ['Wire'] } }),
        f('wire_intermediary', 'Intermediary bank (optional: name, SWIFT/ABA)', 'textarea'),
      ] },
      { title: 'Authorization', signKey: 'payee', fields: [
        f('payee_attest', 'I authorize Mentour Corp to send payments to the account above and confirm I am authorized on this account. This stays in effect until I give written notice of a change.', 'attest', { required: true }),
      ] },
    ],
  },
};

const fieldsOfForm = (form) => FORMS[form].sections.flatMap((s) => s.fields.map((x) => Object.assign({}, x, { signKey: s.signKey })));

module.exports = { FORMS, fieldsOfForm };
