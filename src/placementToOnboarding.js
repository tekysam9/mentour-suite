// Turns the details parsed from a "PRE-PLACEMENT INFORMATION" e-mail (see routes/prePlacementSpec.js) into onboarding form values.
// Used by "paste an e-mail" on a new onboarding and by "send a legacy pre-placement to onboarding", so both read the e-mail the same way.
function visaToAuthorization(visa) {
  const v = String(visa || '');
  return /citizen/i.test(v) && /\b(us|u\.s\.?|american)\b/i.test(v) ? 'US citizen' : /green\s*card|permanent/i.test(v) ? 'Green card' : /h-?1b/i.test(v) ? 'H-1B'
    : /\bl-?1\b/i.test(v) ? 'L-1' : /opt|cpt/i.test(v) ? 'OPT / CPT' : /\btn\b/i.test(v) ? 'TN' : /\bead\b/i.test(v) ? 'EAD' : v ? 'Other' : '';
}
// d: pre-placement style data. Returns plain onboarding input (the caller runs it through onboarding's clean()).
function toOnboardingInput(d, workerType, recruiter) {
  const input = {
    consultant_name: d.consultant_name, phone: d.consultant_phone, email: d.consultant_email, technical_skill: d.technical_skill,
    work_authorization: visaToAuthorization(d.visa_status), visa_expiry: d.visa_expiry, emergency_contact: d.emergency_contact, laptop_address: d.laptop_address,
    start_date: d.start_date, duration: d.project_duration, end_client: d.end_client_name || d.client_name, bill_to: d.client_name, location: d.work_location,
    bill_rate: d.bill_rate, bill_rate_basis: d.bill_basis, pay_rate: d.pay_rate, pay_rate_basis: d.pay_basis, recruiter: recruiter || undefined,
  };
  if (!workerType || workerType === 'C2C') {
    Object.assign(input, {
      employer_name: d.vendor_name, employer_contact: d.signer_name, employer_email: d.vendor_email || d.signer_email, employer_phone: d.vendor_phone || d.signer_phone,
      employer_address: d.vendor_address, employer_fax: d.vendor_fax, employer_incorporated_state: d.incorporated_state, employer_tax_id: d.fed_tax_id,
      signer_name: d.signer_name, signer_designation: d.signer_designation, signer_phone: d.signer_phone, signer_email: d.signer_email,
    });
  }
  Object.keys(input).forEach((k) => { if (input[k] === undefined || input[k] === null || input[k] === '') delete input[k]; });
  return input;
}
module.exports = { toOnboardingInput, visaToAuthorization };
