// Countries Mentour places consultants in, with the regions, labels and currency each one uses.
// Shared by the onboarding form, the e-mail reader and the Directory lists.
const COUNTRIES = ['United States', 'Canada', 'India'];
const CURRENCY = { 'United States': 'USD', Canada: 'CAD', India: 'INR' };
const CA_PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
const IN_STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'];
const CURRENCIES = ['USD', 'CAD', 'INR'];
const SYMBOL = { USD: '$', CAD: 'CA$', INR: '₹' };

// Free text from a profile / form ("USA", "us", "CA", "Canada ", "IN") -> one of COUNTRIES, else the trimmed text ('' when blank).
function normalizeCountry(v) {
  const t = String(v === undefined || v === null ? '' : v).trim();
  if (!t) return '';
  const k = t.toLowerCase().replace(/[.\s]/g, '');
  if (['us', 'usa', 'unitedstates', 'unitedstatesofamerica', 'america'].includes(k)) return 'United States';
  if (['ca', 'can', 'canada'].includes(k)) return 'Canada';
  if (['in', 'ind', 'india', 'bharat'].includes(k)) return 'India';
  return t;
}
// A record with no country is a United States one (everything before this feature was).
const countryOf = (data) => { const c = normalizeCountry(data && data.country); return COUNTRIES.includes(c) ? c : 'United States'; };

// Looks for Canada / India in pasted text (addresses, the location line, a currency). Returns the country only when
// exactly one of the two is mentioned, otherwise '' (the recruiter picks).
function detectCountry(text) {
  const t = String(text || '');
  const ca = /\bcanada\b|\bCAD\b|\bC\$|\bCA\$|\b(?:ontario|british columbia|alberta|quebec|manitoba|saskatchewan|nova scotia|new brunswick|toronto|vancouver|calgary|ottawa|mississauga|brampton|edmonton|montreal|winnipeg|markham)\b/i.test(t) || /,\s*(?:ON|BC|AB|QC|MB|SK|NS|NB|NL|PE)\b/.test(t);
  const ind = /\bindia\b|\bINR\b|₹|\bRs\.?\s?\d|\b(?:hyderabad|bangalore|bengaluru|chennai|pune|mumbai|new delhi|noida|gurgaon|gurugram|kolkata|ahmedabad|kochi|coimbatore|visakhapatnam|telangana|karnataka|maharashtra|tamil nadu)\b|\bPIN(?:\s*code)?\s*[:\-]?\s*\d{6}\b/i.test(t);
  if (ca && !ind) return 'Canada';
  if (ind && !ca) return 'India';
  return '';
}
module.exports = { COUNTRIES, CURRENCY, CURRENCIES, SYMBOL, CA_PROVINCES, IN_STATES, normalizeCountry, countryOf, detectCountry };
