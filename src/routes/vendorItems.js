// What HR can ask a supplier for through a secure link. A "form" item is filled in and
// e-signed on the supplier company record; an "upload" item is a document on the onboarding.
const ITEMS = {
  company: { label: 'Company details', kind: 'company', help: 'Contact person, address and payment terms' },
  w9: { label: 'Form W-9', kind: 'form', form: 'w9', checklistKey: 'company_w9', help: 'Fill in and e-sign online' },
  banking: { label: 'Bank / ACH / remittance details', kind: 'form', form: 'banking', checklistKey: 'remittance', help: 'Fill in and e-sign online (bank numbers are encrypted)' },
  coi: { label: 'Certificate of insurance', kind: 'upload', itemKey: 'coi', checklistKey: 'coi', help: 'Upload a PDF, JPG, PNG or Word file' },
  vendor_agreement: { label: 'Signed vendor agreement', kind: 'upload', itemKey: 'vendor_agreement', checklistKey: 'vendor_agreement', help: 'Upload the signed agreement' },
};
const KEYS = Object.keys(ITEMS);
const clean = (list) => KEYS.filter((k) => Array.isArray(list) && list.includes(k));
module.exports = { ITEMS, KEYS, clean };
