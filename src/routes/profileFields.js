// Field definitions for the record profile / intake forms. Modelled on the
// contact + account + staffing records of US CRM and ATS products
// (Salesforce Contact/Account, HubSpot Contact/Company, Zoho Contact/Account,
// Bullhorn Candidate/ClientCorporation, Dynamics 365): identity, contact,
// address, role/engagement, commercial terms, compliance, banking, ownership,
// notes.
//
// Field kinds: text, textarea, email, phone, url, date, number, select
// (options), bool, record (pick another directory record), secret
// (encrypted at rest, write-only, shown as last 4 only).
// `core` fields live in the directory table itself (name/status/email/phone/
// address); everything else is stored in record_profiles.data.

const WORKER_TYPES = ['W2', '1099', 'Subvendor', 'Corp-to-Corp', 'Other'];
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','PR'];
const PAY_TERMS = ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60', 'Net 90', 'Other'];
const f = (key, label, kind, extra) => Object.assign({ key, label, kind }, extra || {});

const SPEC = {
  consultants: {
    singular: 'Consultant', plural: 'Consultants', table: 'consultants',
    sections: [
      { title: 'Identity', fields: [
        f('name', 'Full name', 'text', { core: true, required: true, readOnlyAfterCreate: true, help: 'Name is the key hours and roster files match on, so it cannot be changed after the record exists.' }),
        f('preferred_name', 'Preferred name', 'text'),
        f('date_of_birth', 'Date of birth', 'date'),
        f('status', 'Status', 'select', { core: true, options: ['active', 'inactive'] }),
        f('worker_type', 'Worker type', 'select', { options: WORKER_TYPES }),
        f('employee_id', 'Employee / vendor ID', 'text'),
      ] },
      { title: 'Contact', fields: [
        f('email', 'Work email', 'email', { core: true }),
        f('personal_email', 'Personal email', 'email'),
        f('phone', 'Mobile phone', 'phone', { core: true }),
        f('alt_phone', 'Alternate phone', 'phone'),
        f('linkedin_url', 'LinkedIn URL', 'url'),
      ] },
      { title: 'Address', fields: [
        f('address', 'Street address', 'text', { core: true }),
        f('city', 'City', 'text'),
        f('state', 'State', 'select', { options: US_STATES }),
        f('postal_code', 'ZIP / postal code', 'text'),
        f('country', 'Country', 'text'),
      ] },
      { title: 'Professional profile', fields: [
        f('job_title', 'Job title / role', 'text'),
        f('skills', 'Key skills / technologies', 'textarea'),
        f('years_experience', 'Years of experience', 'number'),
        f('highest_education', 'Highest education', 'select', { options: ['High school', 'Associate', 'Bachelor', 'Master', 'Doctorate', 'Other'] }),
        f('certifications', 'Certifications', 'textarea'),
        f('preferred_location', 'Preferred work location', 'text'),
        f('work_mode', 'Work mode', 'select', { options: ['On-site', 'Hybrid', 'Remote'] }),
        f('available_from', 'Available from', 'date'),
      ] },
      { title: 'Engagement', fields: [
        f('hire_date', 'Hire / onboarding date', 'date'),
        f('supplier_id', 'Supplier company', 'record', { source: 'subvendors', help: 'Fill in when this person works through a supplier company.' }),
        f('recruiter', 'Recruiter / account owner', 'text'),
        f('lead_source', 'Source', 'select', { options: ['Referral', 'Job board', 'LinkedIn', 'Supplier', 'Direct', 'Other'] }),
        f('manager', 'Reporting manager at client', 'text'),
      ] },
      { title: 'Compensation', fields: [
        f('pay_rate', 'Pay rate', 'number'),
        f('pay_rate_type', 'Rate basis', 'select', { options: ['Hourly', 'Daily', 'Monthly', 'Annual'] }),
        f('payment_terms', 'Payment terms', 'text'),
        f('currency', 'Currency', 'select', { options: ['USD', 'CAD', 'INR', 'EUR', 'GBP'] }),
      ] },
      { title: 'Work authorization & compliance', fields: [
        f('work_authorization', 'Work authorization', 'select', { options: ['US citizen', 'Green card', 'H-1B', 'L-1', 'OPT / CPT', 'TN', 'EAD', 'Other'] }),
        f('work_auth_expiry', 'Authorization expires', 'date'),
        f('i9_verified', 'I-9 verified', 'bool'),
        f('background_check', 'Background check', 'select', { options: ['Not started', 'In progress', 'Clear', 'Flagged'] }),
        f('background_check_date', 'Background check date', 'date'),
        f('ssn', 'Social Security number', 'secret', { secretKind: 'ssn', help: 'Encrypted. Only the last 4 digits are ever shown.' }),
      ] },
      { title: 'Banking (direct deposit)', fields: [
        f('bank_name', 'Bank name', 'text'),
        f('bank_account_holder', 'Account holder name', 'text'),
        f('bank_account_type', 'Account type', 'select', { options: ['Checking', 'Savings'] }),
        f('bank_routing', 'Routing number', 'secret', { secretKind: 'routing', help: 'Encrypted. Only the last 4 digits are ever shown.' }),
        f('bank_account', 'Account number', 'secret', { secretKind: 'account', help: 'Encrypted. Only the last 4 digits are ever shown.' }),
      ] },
      { title: 'Emergency contact', fields: [
        f('emergency_name', 'Name', 'text'),
        f('emergency_relationship', 'Relationship', 'text'),
        f('emergency_phone', 'Phone', 'phone'),
      ] },
      { title: 'Notes', fields: [ f('description', 'Internal description', 'textarea') ] },
    ],
  },

  clients: {
    singular: 'Client', plural: 'Clients', table: 'clients',
    sections: [
      { title: 'Account', fields: [
        f('name', 'Client name', 'text', { core: true, required: true, readOnlyAfterCreate: true, help: 'Name is the key hours and roster files match on, so it cannot be changed after the record exists.' }),
        f('legal_name', 'Legal entity name', 'text'),
        f('status', 'Status', 'select', { core: true, options: ['active', 'inactive'] }),
        f('account_stage', 'Relationship stage', 'select', { options: ['Lead', 'Prospect', 'Active customer', 'Dormant', 'Churned'] }),
        f('industry', 'Industry', 'select', { options: ['Government', 'Education', 'Healthcare', 'Financial services', 'Technology', 'Manufacturing', 'Retail', 'Non-profit', 'Other'] }),
        f('company_size', 'Company size', 'select', { options: ['1-50', '51-200', '201-1,000', '1,001-5,000', '5,000+'] }),
        f('website', 'Website', 'url'),
        f('parent_company', 'Parent company', 'text'),
        f('lead_source', 'Source', 'select', { options: ['Referral', 'Existing relationship', 'Procurement portal', 'Marketing', 'Other'] }),
        f('account_owner', 'Account owner', 'text'),
      ] },
      { title: 'Primary contact', fields: [
        f('contact_name', 'Contact name', 'text'),
        f('contact_title', 'Title', 'text'),
        f('email', 'Email', 'email', { core: true }),
        f('phone', 'Phone', 'phone', { core: true }),
        f('alt_phone', 'Alternate phone', 'phone'),
      ] },
      { title: 'Address', fields: [
        f('address', 'Street address', 'text', { core: true }),
        f('city', 'City', 'text'),
        f('state', 'State', 'select', { options: US_STATES }),
        f('postal_code', 'ZIP / postal code', 'text'),
        f('country', 'Country', 'text'),
      ] },
      { title: 'Billing & accounts payable', fields: [
        f('billing_contact', 'Billing contact', 'text'),
        f('billing_email', 'Invoice delivery email', 'email'),
        f('billing_phone', 'Billing phone', 'phone'),
        f('billing_address', 'Billing address', 'textarea'),
        f('payment_terms', 'Payment terms', 'select', { options: PAY_TERMS }),
        f('currency', 'Currency', 'select', { options: ['USD', 'CAD', 'INR', 'EUR', 'GBP'] }),
        f('invoice_frequency', 'Invoice frequency', 'select', { options: ['Monthly', 'Bi-weekly', 'Weekly', 'Per milestone'] }),
        f('po_required', 'PO number required', 'bool'),
        f('timesheet_approver', 'Timesheet approver', 'text'),
        f('tax_exempt', 'Tax exempt', 'bool'),
        f('tax_id', 'Tax ID (EIN)', 'secret', { secretKind: 'taxid', help: 'Encrypted. Only the last 4 characters are ever shown.' }),
      ] },
      { title: 'Contract', fields: [
        f('contract_type', 'Contract vehicle', 'select', { options: ['MSA', 'Master contract', 'PO only', 'Task order', 'Other'] }),
        f('contract_start', 'Contract start', 'date'),
        f('contract_end', 'Contract end / renewal', 'date'),
        f('contract_reference', 'Contract / MSA number', 'text'),
      ] },
      { title: 'Notes', fields: [ f('description', 'Internal description', 'textarea') ] },
    ],
  },

  programs: {
    singular: 'Vendor', plural: 'Vendors', table: 'programs',
    sections: [
      { title: 'Vendor', fields: [
        f('client_id', 'Client', 'record', { source: 'clients', required: true, readOnlyAfterCreate: true, core: true }),
        f('name', 'Vendor name', 'text', { core: true, required: true, readOnlyAfterCreate: true, help: 'Name is the key hours and roster files match on, so it cannot be changed after the record exists.' }),
        f('legal_name', 'Legal entity name', 'text'),
        f('status', 'Status', 'select', { core: true, options: ['active', 'inactive'] }),
        f('vendor_type', 'Vendor type', 'select', { options: ['Prime', 'Subcontractor', 'Staffing partner', 'Other'] }),
        f('website', 'Website', 'url'),
        f('account_owner', 'Relationship owner', 'text'),
      ] },
      { title: 'Primary contact', fields: [
        f('contact_name', 'Contact name', 'text'),
        f('contact_title', 'Title', 'text'),
        f('email', 'Email', 'email', { core: true }),
        f('phone', 'Phone', 'phone', { core: true }),
        f('alt_phone', 'Alternate phone', 'phone'),
      ] },
      { title: 'Address', fields: [
        f('address', 'Street address', 'text', { core: true }),
        f('city', 'City', 'text'),
        f('state', 'State', 'select', { options: US_STATES }),
        f('postal_code', 'ZIP / postal code', 'text'),
        f('country', 'Country', 'text'),
      ] },
      { title: 'Billing & payment', fields: [
        f('billing_email', 'Invoice delivery email', 'email'),
        f('payment_terms', 'Payment terms', 'select', { options: PAY_TERMS }),
        f('currency', 'Currency', 'select', { options: ['USD', 'CAD', 'INR', 'EUR', 'GBP'] }),
        f('po_number', 'PO / reference number', 'text'),
        f('tax_id', 'Tax ID (EIN)', 'secret', { secretKind: 'taxid', help: 'Encrypted. Only the last 4 characters are ever shown.' }),
        f('bank_name', 'Bank name', 'text'),
        f('bank_routing', 'Routing number', 'secret', { secretKind: 'routing', help: 'Encrypted. Only the last 4 digits are ever shown.' }),
        f('bank_account', 'Account number', 'secret', { secretKind: 'account', help: 'Encrypted. Only the last 4 digits are ever shown.' }),
      ] },
      { title: 'Contract & compliance', fields: [
        f('contract_start', 'Contract start', 'date'),
        f('contract_end', 'Contract end / renewal', 'date'),
        f('contract_reference', 'Contract / agreement number', 'text'),
        f('w9_on_file', 'W-9 on file', 'bool'),
        f('coi_expiry', 'Insurance certificate expires', 'date'),
        f('msa_signed', 'Agreement signed', 'bool'),
      ] },
      { title: 'Notes', fields: [ f('description', 'Internal description', 'textarea') ] },
    ],
  },
  subvendors: {
    singular: 'Supplier company', plural: 'Supplier companies', table: 'subvendors',
    sections: [
      { title: 'Supplier company', fields: [
        f('name', 'Supplier company name', 'text', { core: true, required: true, readOnlyAfterCreate: true, help: 'Name is the key payment and roster files match on, so it cannot be changed after the record exists.' }),
        f('legal_name', 'Legal entity name', 'text'),
        f('status', 'Status', 'select', { core: true, options: ['active', 'inactive'] }),
        f('supplier_type', 'Supplier type', 'select', { options: ['Staffing agency', 'IT services', 'Consulting firm', 'Individual / sole proprietor', 'Other'] }),
        f('website', 'Website', 'url'),
        f('account_owner', 'Relationship owner', 'text'),
        f('lead_source', 'Source', 'select', { options: ['Referral', 'Job board', 'LinkedIn', 'Direct', 'Other'] }),
      ] },
      { title: 'Primary contact', fields: [
        f('contact_name', 'Contact name', 'text'),
        f('contact_title', 'Title', 'text'),
        f('email', 'Email', 'email', { core: true }),
        f('phone', 'Phone', 'phone', { core: true }),
        f('alt_phone', 'Alternate phone', 'phone'),
      ] },
      { title: 'Address', fields: [
        f('address', 'Street address', 'text', { core: true }),
        f('city', 'City', 'text'),
        f('state', 'State', 'select', { options: US_STATES }),
        f('postal_code', 'ZIP / postal code', 'text'),
        f('country', 'Country', 'text'),
      ] },
      { title: 'Billing & payment', fields: [
        f('billing_contact', 'Accounts receivable contact', 'text'),
        f('billing_email', 'Invoice email', 'email'),
        f('payment_terms', 'Payment terms', 'select', { options: PAY_TERMS }),
        f('currency', 'Currency', 'select', { options: ['USD', 'CAD', 'INR', 'EUR', 'GBP'] }),
        f('payment_method', 'Payment method', 'select', { options: ['ACH', 'Wire', 'Check', 'Other'] }),
        f('tax_id', 'Tax ID (EIN)', 'secret', { secretKind: 'taxid', help: 'Encrypted. Only the last 4 characters are ever shown.' }),
        f('bank_name', 'Bank name', 'text'),
        f('bank_routing', 'Routing number', 'secret', { secretKind: 'routing', help: 'Encrypted. Only the last 4 digits are ever shown.' }),
        f('bank_account', 'Account number', 'secret', { secretKind: 'account', help: 'Encrypted. Only the last 4 digits are ever shown.' }),
      ] },
      { title: 'Contract & compliance', fields: [
        f('contract_type', 'Agreement', 'select', { options: ['MSA', 'Subcontractor agreement', 'PO only', 'Other'] }),
        f('contract_start', 'Agreement start', 'date'),
        f('contract_end', 'Agreement end / renewal', 'date'),
        f('contract_reference', 'Agreement number', 'text'),
        f('w9_on_file', 'W-9 on file', 'bool'),
        f('coi_expiry', 'Insurance certificate expires', 'date'),
        f('msa_signed', 'Agreement signed', 'bool'),
      ] },
      { title: 'Notes', fields: [ f('description', 'Internal description', 'textarea') ] },
    ],
  },
};

const fieldsOf = (entity) => SPEC[entity].sections.flatMap((s) => s.fields);

module.exports = { SPEC, fieldsOf };
