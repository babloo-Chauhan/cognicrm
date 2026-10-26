/**
 * Turns what each lead source sends into one shape:
 * { externalId?, name, phone, email, company, requirement, details: { label: value }, test? }.
 * `details` (city, campaign, form answers …) become the lead's remarks.
 */

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const text = (v) => (v === undefined || v === null ? '' : String(Array.isArray(v) ? v.join(', ') : v).trim());

// Field names used by website builders, form plugins, Zapier / Pabbly / Make, Meta and Google forms
const ALIASES = {
  name: ['name', 'fullname', 'yourname', 'contactname', 'customername', 'clientname', 'leadname', 'sendername', 'username'],
  firstName: ['firstname', 'fname', 'givenname'],
  lastName: ['lastname', 'lname', 'surname', 'familyname'],
  phone: ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'mobileno', 'phoneno', 'contactnumber', 'contactno', 'contact', 'tel', 'telephone', 'whatsapp', 'whatsappnumber', 'yourphone', 'yourmobile', 'cell', 'sendermobile'],
  email: ['email', 'emailaddress', 'youremail', 'mail', 'emailid', 'workemail', 'senderemail'],
  company: ['company', 'companyname', 'organization', 'organisation', 'business', 'businessname', 'firm', 'sendercompany'],
  requirement: ['message', 'requirement', 'requirements', 'enquiry', 'inquiry', 'query', 'comments', 'comment', 'yourmessage', 'description', 'details', 'need', 'subject', 'productinterest', 'product', 'service', 'interest'],
};
const LOOKUP = new Map(Object.entries(ALIASES).flatMap(([field, names]) => names.map((n) => [n, field])));
// Form plumbing that is never shown on the lead
const SKIP = new Set(['token', 'redirect', 'hp', 'gotcha', 'honeypot', 'formid', 'submit', 'gclid', 'fbclid', 'test', 'istest', 'apiversion', 'googlekey', 'source']);

const pretty = (key) => String(key).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());

/** Flat key → value pairs, from a website form, JSON body, Meta field_data or Google user_column_data. */
export function fromPairs(pairs) {
  const out = { details: {} };
  const first = {};
  for (const [key, raw] of pairs) {
    const value = text(raw);
    if (!value || typeof raw === 'object' && !Array.isArray(raw)) continue;
    const k = norm(key);
    if (SKIP.has(k) || String(key).startsWith('_')) continue;
    const field = LOOKUP.get(k);
    if (field === 'firstName' || field === 'lastName') first[field] = value;
    else if (field && !out[field]) out[field] = value;
    else out.details[pretty(key)] = value;
  }
  if (!out.name && (first.firstName || first.lastName)) out.name = `${first.firstName || ''} ${first.lastName || ''}`.trim();
  return out;
}

/** A website / Zapier / Google Sheets webhook: JSON or form-encoded, flat or `{ lead: {...} }` / `{ data: {...} }`. */
export function parseWebhook(body = {}) {
  const inner = [body.lead, body.data, body.fields].find((v) => v && typeof v === 'object' && !Array.isArray(v)) || body;
  const out = fromPairs(Object.entries(inner));
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'page', 'page_url', 'referrer']) {
    if (body[k] && inner !== body) out.details[pretty(k)] = text(body[k]);
  }
  out.externalId = text(body.id || body.lead_id || body.leadId || inner.id) || undefined;
  out.test = ['1', 'true', 'yes'].includes(text(body.test).toLowerCase());
  return out;
}

/**
 * Justdial "lead push": GET or POST with leadid, prefix, name, mobile, phone, email, category, city, area,
 * brancharea, pincode, company, date, time.
 */
export function parseJustdial(p = {}) {
  const details = {};
  for (const [k, l] of [['city', 'City'], ['area', 'Area'], ['brancharea', 'Branch area'], ['pincode', 'Pincode'], ['date', 'Date'], ['time', 'Time'], ['leadtype', 'Lead type']]) {
    if (text(p[k])) details[l] = text(p[k]);
  }
  return {
    externalId: text(p.leadid) || undefined,
    name: [text(p.prefix), text(p.name)].filter(Boolean).join(' '),
    phone: text(p.mobile) || text(p.phone),
    email: text(p.email),
    company: text(p.company),
    requirement: text(p.category),
    details: { ...details, ...(text(p.phone) && text(p.mobile) && text(p.phone) !== text(p.mobile) ? { 'Other phone': text(p.phone) } : {}) },
  };
}

/** One IndiaMART enquiry (push webhook `RESPONSE`, or a row of the CRM Listing pull API). */
export function parseIndiamart(r = {}) {
  const details = {};
  const add = (label, v) => { if (text(v)) details[label] = text(v); };
  add('Enquiry type', { W: 'Direct', B: 'Buy lead', P: 'Phone call', V: 'Phone call', WA: 'WhatsApp', BIZ: 'Catalogue' }[r.QUERY_TYPE] || r.QUERY_TYPE);
  add('Product', r.QUERY_PRODUCT_NAME);
  add('Category', r.QUERY_MCAT_NAME);
  add('City', r.SENDER_CITY);
  add('State', r.SENDER_STATE);
  add('Pincode', r.SENDER_PINCODE);
  add('Address', r.SENDER_ADDRESS);
  add('Other phone', r.SENDER_MOBILE_ALT || r.SENDER_PHONE);
  add('Other email', r.SENDER_EMAIL_ALT);
  add('Received', r.QUERY_TIME);
  const message = text(r.QUERY_MESSAGE).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  return {
    externalId: text(r.UNIQUE_QUERY_ID) || undefined,
    name: text(r.SENDER_NAME),
    phone: text(r.SENDER_MOBILE).replace(/^\+(\d+)-/, '+$1'),
    email: text(r.SENDER_EMAIL),
    company: text(r.SENDER_COMPANY),
    requirement: [text(r.SUBJECT), message].filter(Boolean).join('\n').slice(0, 2000),
    details,
  };
}

/** A Meta (Facebook / Instagram) lead from the Graph API: `{ id, field_data: [{ name, values }], ad_name, form_id }`. */
export function parseMetaLead(lead = {}, extra = {}) {
  const out = fromPairs((lead.field_data || []).map((f) => [f.name, f.values]));
  for (const [k, l] of [['ad_name', 'Ad'], ['campaign_name', 'Campaign'], ['form_name', 'Form'], ['platform', 'Platform']]) {
    const v = text(lead[k] || extra[k]);
    if (v) out.details[l] = v === 'ig' ? 'Instagram' : v === 'fb' ? 'Facebook' : v;
  }
  out.externalId = text(lead.id) || undefined;
  return out;
}

// Google Ads lead form column ids → our fields
const GOOGLE_COLUMNS = {
  FULL_NAME: 'name', FIRST_NAME: 'firstName', LAST_NAME: 'lastName', PHONE_NUMBER: 'phone', EMAIL: 'email', WORK_EMAIL: 'email',
  WORK_PHONE: 'phone', COMPANY_NAME: 'company',
};

/** Google Ads lead form webhook: `{ lead_id, google_key, is_test, campaign_id, user_column_data: [...] }`. */
export function parseGoogleAds(body = {}) {
  const pairs = (body.user_column_data || []).map((c) => [GOOGLE_COLUMNS[c.column_id] || c.column_name || c.column_id, c.string_value]);
  const out = fromPairs(pairs);
  if (body.campaign_id) out.details.Campaign = text(body.campaign_id);
  if (body.form_id) out.details.Form = text(body.form_id);
  out.externalId = text(body.lead_id) || undefined;
  out.test = body.is_test === true || body.is_test === 'true';
  return out;
}
