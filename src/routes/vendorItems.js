// What HR can ask for through a secure link, from a supplier company or from the consultant.
// A "form" item is filled in and e-signed on the supplier / consultant record; an "upload" item is a
// document on the onboarding. Consultant item keys start with "c_".
const ITEMS = {
  company: { party: 'supplier', label: 'Company details', kind: 'company', help: 'Contact person, address and payment terms' },
  w9: { party: 'supplier', label: 'Form W-9', kind: 'form', form: 'w9', entity: 'subvendors', checklistKey: 'company_w9', help: 'Fill in and e-sign online' },
  banking: { party: 'supplier', label: 'Bank / ACH / remittance details', kind: 'form', form: 'banking', entity: 'subvendors', checklistKey: 'remittance', help: 'Fill in and e-sign online (bank numbers are encrypted)' },
  coi: { party: 'supplier', label: 'Certificate of insurance', kind: 'upload', itemKey: 'coi', checklistKey: 'coi', help: 'Upload a PDF, JPG, PNG or Word file' },
  vendor_agreement: { party: 'supplier', label: 'Signed vendor agreement', kind: 'upload', itemKey: 'vendor_agreement', checklistKey: 'vendor_agreement', help: 'Upload the signed agreement' },

  c_details: { party: 'consultant', label: 'Personal details', kind: 'person', help: 'Email, phone and address' },
  c_w9: { party: 'consultant', label: 'Form W-9', kind: 'form', form: 'w9', entity: 'consultants', checklistKey: 'w9', types: ['1099'], help: 'Fill in and e-sign online (the tax ID is encrypted)' },
  c_i9: { party: 'consultant', label: 'Form I-9, Section 1', kind: 'form', form: 'i9', entity: 'consultants', checklistKey: 'i9', types: ['1099'], help: 'Fill in your part and e-sign online' },
  c_banking: { party: 'consultant', label: 'Bank / ACH details', kind: 'form', form: 'banking', entity: 'consultants', checklistKey: 'payment_details', types: ['1099'], help: 'Fill in and e-sign online (bank numbers are encrypted)' },
  c_nda: { party: 'consultant', label: 'Signed NDA', kind: 'upload', itemKey: 'nda', checklistKey: 'nda', help: 'Upload the signed NDA' },
};
const KEYS = Object.keys(ITEMS);
const keysFor = (party, type) => KEYS.filter((k) => ITEMS[k].party === party && (!type || !ITEMS[k].types || ITEMS[k].types.includes(type)));
// keeps only known item keys for the party (and worker type), in catalogue order
const clean = (list, party, type) => keysFor(party || 'supplier', type).filter((k) => Array.isArray(list) && list.includes(k));
module.exports = { ITEMS, KEYS, keysFor, clean };
