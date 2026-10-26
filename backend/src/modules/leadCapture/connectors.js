import crypto from 'node:crypto';
import { LeadSource } from '../../models/index.js';
import { decryptJson, safeEqual } from '../../lib/crypto.js';
import { httpRequest } from '../../lib/http.js';
import { captureLead, sourceError } from './service.js';
import { parseIndiamart, parseMetaLead } from './parsers.js';

export const credentialsOf = async (source) => {
  const withCreds = source.credentials !== undefined ? source : await LeadSource.findById(source._id).select('+credentials').lean();
  try {
    return decryptJson(withCreds?.credentials) || {};
  } catch {
    return {}; // the server encryption key changed: the admin re-enters them
  }
};

// ---------------------------------------------------------------- IndiaMART (CRM Listing API v2, pull)

const INDIAMART_URL = 'https://mapi.indiamart.com/wservce/crm/crmListing/v2/';
const INDIAMART_EVERY_MS = 6 * 60000; // IndiaMART refuses calls less than 5 minutes apart
const INDIAMART_MAX_WINDOW_MS = 7 * 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "26-Oct-2026 21:05:00" in India time, as the IndiaMART API expects. */
export function indiamartTime(date) {
  const ist = new Date(date.getTime() + 330 * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(ist.getUTCDate())}-${MONTHS[ist.getUTCMonth()]}-${ist.getUTCFullYear()} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
}

/**
 * Fetches this source's new IndiaMART enquiries since the last pull (the last 24 hours the first time, at most
 * 7 days back) and adds them. Returns { fetched, created, duplicate, ignored, failed }.
 */
export async function pullIndiamart(source, now = new Date()) {
  const { crmKey } = await credentialsOf(source);
  if (!crmKey) throw new Error('Add the IndiaMART CRM key first');
  const from = new Date(Math.max(new Date(source.config?.lastPulledAt || now.getTime() - 86400000).getTime(), now.getTime() - INDIAMART_MAX_WINDOW_MS));
  const url = `${INDIAMART_URL}?${new URLSearchParams({ glusr_crm_key: crmKey, start_time: indiamartTime(from), end_time: indiamartTime(now) })}`;
  const data = await httpRequest(url, { timeoutMs: 30000 });
  const code = Number(data?.CODE);
  const result = { fetched: 0, created: 0, duplicate: 0, ignored: 0, failed: 0 };
  if (code !== 200 && code !== 204) throw new Error(`IndiaMART: ${data?.MESSAGE || `code ${data?.CODE}`}`);
  for (const row of Array.isArray(data?.RESPONSE) ? data.RESPONSE : []) {
    result.fetched += 1;
    const r = await captureLead(source, parseIndiamart(row), { payload: row });
    result[r.status] += 1;
  }
  await LeadSource.updateOne({ _id: source._id }, { $set: { 'config.lastPulledAt': now, 'config.lastPullOk': now }, ...(source.stats?.lastError ? { $unset: { 'stats.lastError': 1 } } : {}) });
  return result;
}

/** Scheduler job: pulls every enabled IndiaMART source whose last pull is old enough. */
export async function pullDueIndiamart(now = new Date()) {
  const due = await LeadSource.find({
    type: 'indiamart', enabled: true,
    $or: [{ 'config.lastPullAttemptAt': { $exists: false } }, { 'config.lastPullAttemptAt': { $lte: new Date(now.getTime() - INDIAMART_EVERY_MS) } }],
  }).select('+credentials').limit(50);
  for (const source of due) {
    await LeadSource.updateOne({ _id: source._id }, { $set: { 'config.lastPullAttemptAt': now } });
    try {
      await pullIndiamart(source, now);
    } catch (err) {
      await sourceError(source, err.message);
    }
  }
}

// ---------------------------------------------------------------- Meta Lead Ads (Facebook & Instagram)

const GRAPH = 'https://graph.facebook.com/v21.0';

/** X-Hub-Signature-256 check, when the admin saved the Meta app secret. */
export function validMetaSignature(appSecret, rawBody, header) {
  if (!appSecret) return true;
  if (!rawBody || !header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  return safeEqual(String(header), expected);
}

/** Reads one lead from the Graph API with the page token and adds it. */
export async function fetchMetaLead(source, leadgenId, extra = {}) {
  const { pageAccessToken } = await credentialsOf(source);
  if (!pageAccessToken) throw new Error('Add the Facebook page access token first');
  const lead = await httpRequest(`${GRAPH}/${encodeURIComponent(leadgenId)}?${new URLSearchParams({
    access_token: pageAccessToken, fields: 'id,created_time,field_data,ad_name,campaign_name,form_id,platform',
  })}`);
  return captureLead(source, parseMetaLead(lead, extra), { payload: { leadgen_id: leadgenId, ...extra, field_data: lead.field_data } });
}
