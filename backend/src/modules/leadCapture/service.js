import crypto from 'node:crypto';
import {
  Lead, LeadCaptureLog, LeadSource, Note, Organization, User,
} from '../../models/index.js';
import { env } from '../../config/env.js';
import { normalizePhone, phoneVariants } from '../../lib/phone.js';
import { bumpCompany } from '../../lib/cache.js';
import { checkLimit } from '../saas/usage.js';
import { scoreLead } from '../ai/insights.js';
import { logActivity } from '../timeline/service.js';
import { notify, notifyMany } from '../notifications/service.js';

/** Lead `source` value and label each kind of source starts with (the admin can rename the value). */
export const SOURCE_DEFAULTS = {
  webhook: { leadSource: 'website', label: 'Website / API' },
  form: { leadSource: 'website', label: 'Web form' },
  justdial: { leadSource: 'justdial', label: 'Justdial' },
  indiamart: { leadSource: 'indiamart', label: 'IndiaMART' },
  meta: { leadSource: 'facebook', label: 'Facebook & Instagram' },
  google_ads: { leadSource: 'google_ads', label: 'Google Ads' },
  whatsapp: { leadSource: 'whatsapp', label: 'WhatsApp' },
};

export const newToken = () => crypto.randomBytes(18).toString('base64url');

/** The public addresses shown to the admin for pasting into Justdial, IndiaMART, Meta, Google, a website … */
export function sourceUrls(source) {
  const api = `${env.publicBaseUrl.replace(/\/$/, '')}/api/v1/capture`;
  const urls = { webhook: `${api}/${source.token}` };
  if (source.type === 'form') urls.form = `${env.frontendUrl}/f/${source.token}`;
  if (source.type === 'meta') urls.webhook = `${api}/meta/${source.token}`;
  return urls;
}

const clip = (s, n) => (s ? String(s).slice(0, n) : s);
const remarksOf = (details = {}) => Object.entries(details).map(([k, v]) => `${k}: ${v}`).join('\n');

/** Who gets the next lead: the one person, or the next active person in turn (shared counter, so never twice in a row). */
async function nextOwner(source) {
  if (source.assignMode === 'none' || !source.assignUserIds?.length) return null;
  const active = await User.find({ _id: { $in: source.assignUserIds }, organizationId: source.organizationId, active: true }).select('name').lean();
  const byId = new Map(active.map((u) => [String(u._id), u]));
  const order = source.assignUserIds.map(String).filter((id) => byId.has(id));
  if (!order.length) return null;
  if (source.assignMode === 'user') return byId.get(order[0]);
  const { nextAssignee } = await LeadSource.findOneAndUpdate({ _id: source._id }, { $inc: { nextAssignee: 1 } }, { projection: { nextAssignee: 1 } });
  return byId.get(order[(nextAssignee || 0) % order.length]);
}

async function adminsOf(orgId) {
  return (await User.find({ organizationId: orgId, role: 'admin', active: true }).select('_id').lean()).map((u) => u._id);
}

async function findExisting(orgId, { phone, email }) {
  const or = [];
  if (phone) or.push({ phone: { $in: phoneVariants(phone) } });
  if (email) or.push({ email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
  if (!or.length) return null;
  return Lead.findOne({ organizationId: orgId, $or: or }).sort({ createdAt: -1 });
}

const tapToCall = (lead) => (lead.phone ? { phone: lead.phone, action: 'call' } : {});

/**
 * Adds one enquiry from a lead source. `input` is a parsed enquiry (parsers.js).
 * The same enquiry sent twice (same externalId) is recorded once. An enquiry from a phone or email already
 * in the CRM is added to that lead (a remark, its owner is told) unless the source says to make a new lead.
 * Returns { status: created | duplicate | ignored, lead }.
 */
export async function captureLead(source, input, { payload } = {}) {
  const orgId = source.organizationId;
  const label = source.name || SOURCE_DEFAULTS[source.type]?.label;
  const key = input.externalId ? `ext:${input.externalId}` : undefined;
  if (key && await LeadCaptureLog.exists({ sourceId: source._id, key })) return { status: 'ignored', reason: 'already received' };

  const org = await Organization.findById(orgId).select('settings.defaultCountryCode').lean();
  const phone = input.phone ? normalizePhone(input.phone, org?.settings?.defaultCountryCode || '91') || input.phone : undefined;
  const email = input.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ? input.email.toLowerCase() : undefined;
  const name = clip(input.name || '', 120) || phone || email;
  const base = { organizationId: orgId, sourceId: source._id, key, name, phone, email, payload };
  const log = async (fields) => LeadCaptureLog.create({ ...base, ...fields }).catch((err) => { if (err.code !== 11000) throw err; });

  if (!phone && !email) {
    await log({ status: 'failed', error: 'No phone number or email in the enquiry' });
    await LeadSource.updateOne({ _id: source._id }, { $inc: { 'stats.failed': 1 }, $set: { 'stats.lastError': 'An enquiry came without a phone number or email', 'stats.lastErrorAt': new Date() } });
    return { status: 'failed', reason: 'no phone or email' };
  }
  const remarks = [input.requirement && `Requirement: ${input.requirement}`, remarksOf(input.details)].filter(Boolean).join('\n');

  const existing = source.onDuplicate === 'create' ? null : await findExisting(orgId, { phone, email });
  if (existing) {
    await Note.create({ organizationId: orgId, body: clip(`Enquired again via ${label}${remarks ? `\n${remarks}` : ''}`, 4000), related: { leadId: existing._id } });
    if (['lost', 'unqualified'].includes(existing.status)) existing.status = 'new'; // a fresh enquiry puts it back in play
    existing.nextFollowUpAt = existing.nextFollowUpAt || new Date();
    await existing.save();
    await logActivity(orgId, { type: 'lead_enquiry', title: `Enquired again via ${label}`, related: { leadId: existing._id }, refType: 'Lead', refId: existing._id });
    const tell = existing.ownerId ? [existing.ownerId] : await adminsOf(orgId);
    await notifyMany(orgId, tell, {
      type: 'lead_enquiry', title: `${existing.name} enquired again`, body: `Via ${label}${existing.phone ? ` · ${existing.phone} — tap to call` : ''}`,
      data: { leadId: String(existing._id), ...tapToCall(existing) },
    });
    await log({ status: 'duplicate', leadId: existing._id });
    await LeadSource.updateOne({ _id: source._id }, { $inc: { 'stats.duplicates': 1 }, $set: { 'stats.lastLeadAt': new Date() } });
    bumpCompany(orgId);
    return { status: 'duplicate', lead: existing };
  }

  try {
    await checkLimit(orgId, 'leads');
  } catch (err) {
    await log({ status: 'failed', error: err.message });
    await LeadSource.updateOne({ _id: source._id }, { $inc: { 'stats.failed': 1 }, $set: { 'stats.lastError': err.message, 'stats.lastErrorAt': new Date() } });
    await notifyMany(orgId, await adminsOf(orgId), { type: 'lead_capture_failed', title: `A lead from ${label} could not be added`, body: err.message, data: { sourceId: String(source._id) } });
    return { status: 'failed', reason: err.message };
  }

  const owner = await nextOwner(source);
  const lead = new Lead({
    organizationId: orgId, name, phone, email, company: clip(input.company, 200), address: clip(input.address, 300) || undefined, requirement: clip(input.requirement, 2000),
    notes: clip(remarksOf(input.details), 4000) || undefined, source: source.leadSource || SOURCE_DEFAULTS[source.type]?.leadSource || 'other',
    ownerId: owner?._id || null, assignees: owner ? [owner._id] : [],
    assignments: owner ? [{ from: null, to: owner._id, by: null, at: new Date() }] : [],
    nextFollowUpAt: new Date(), // a fresh enquiry is due a call now
  });
  const scored = await scoreLead(orgId, lead, { save: false }).catch(() => null);
  if (scored) { lead.score = scored.score; lead.scoreFactors = scored.factors; }
  await lead.save();
  await logActivity(orgId, {
    type: 'lead_created', title: `Lead from ${label}${owner ? `, assigned to ${owner.name}` : ''}`, related: { leadId: lead._id }, refType: 'Lead', refId: lead._id,
  });
  const payloadOut = {
    type: 'lead_assigned', title: `New lead from ${label}: ${lead.name}`,
    body: owner ? `${lead.requirement ? `${clip(lead.requirement, 80)} · ` : ''}${lead.phone ? `${lead.phone} — tap to call` : lead.email || ''}` : 'Nobody gets leads from this source yet: open it to assign',
    data: { leadId: String(lead._id), ...tapToCall(lead) },
  };
  if (owner) await notify(orgId, owner._id, payloadOut);
  else await notifyMany(orgId, await adminsOf(orgId), payloadOut);
  await log({ status: 'created', leadId: lead._id });
  await LeadSource.updateOne({ _id: source._id }, { $inc: { 'stats.total': 1 }, $set: { 'stats.lastLeadAt': new Date() } });
  bumpCompany(orgId);
  return { status: 'created', lead };
}

/** Records a problem with a source (bad credentials, IndiaMART refusing …) so the admin sees it on the source. */
export async function sourceError(source, message) {
  await LeadSource.updateOne({ _id: source._id }, { $set: { 'stats.lastError': clip(message, 500), 'stats.lastErrorAt': new Date() } });
}

/** First WhatsApp message from an unknown number: the lead is created (or found) and linked to the chat. */
export async function captureFromWhatsApp(orgId, conversation, { name, phone, body }) {
  const source = await LeadSource.findOne({ organizationId: orgId, type: 'whatsapp', enabled: true });
  if (!source) return null;
  const r = await captureLead(source, { name, phone, requirement: clip(body, 500), details: {} }, { payload: { phone, body: clip(body, 500) } });
  if (r.lead) {
    conversation.related = { ...(conversation.related?.toObject?.() || conversation.related || {}), leadId: r.lead._id };
    await conversation.save();
  }
  return r;
}
