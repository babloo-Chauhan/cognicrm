import mongoose from 'mongoose';
import { Activity, Contact, Deal, Lead, Ticket } from '../../models/index.js';
import { emitToOrg } from '../../lib/realtime.js';

const LINK_KEYS = ['contactId', 'leadId', 'accountId', 'dealId', 'ticketId'];
export const ENTITY_LINK_KEY = { contact: 'contactId', lead: 'leadId', account: 'accountId', deal: 'dealId', ticket: 'ticketId' };

/** Expands related ids so an activity also shows on parent records (e.g. contact → account). */
export async function expandLinks(orgId, related = {}) {
  const links = {};
  for (const k of LINK_KEYS) if (related[k]) links[k] = related[k];
  if (links.contactId && !links.accountId) {
    const c = await Contact.findOne({ _id: links.contactId, organizationId: orgId }).select('accountId').lean();
    if (c?.accountId) links.accountId = c.accountId;
  }
  if (links.dealId && (!links.accountId || !links.contactId)) {
    const d = await Deal.findOne({ _id: links.dealId, organizationId: orgId }).select('accountId contactId').lean();
    if (d?.accountId && !links.accountId) links.accountId = d.accountId;
    if (d?.contactId && !links.contactId) links.contactId = d.contactId;
  }
  if (links.ticketId && !links.contactId) {
    const t = await Ticket.findOne({ _id: links.ticketId, organizationId: orgId }).select('contactId accountId').lean();
    if (t?.contactId) links.contactId = t.contactId;
    if (t?.accountId && !links.accountId) links.accountId = t.accountId;
  }
  return links;
}

export async function logActivity(orgId, { type, title, related, refType, refId, data, userId, occurredAt }) {
  const links = await expandLinks(orgId, related);
  const activity = await Activity.create({
    organizationId: orgId, type, title, links, refType, refId, data, userId, occurredAt: occurredAt || new Date(),
  });
  emitToOrg(String(orgId), 'timeline:activity', activity.toJSON());
  // Keep "last contacted" fresh for engagement scoring / next-best-action
  if (['call', 'sms', 'whatsapp', 'email'].includes(type)) {
    const now = occurredAt || new Date();
    if (links.leadId) await Lead.updateOne({ _id: links.leadId, organizationId: orgId }, { lastContactedAt: now });
    if (links.contactId) await Contact.updateOne({ _id: links.contactId, organizationId: orgId }, { lastContactedAt: now });
    if (links.dealId) await Deal.updateOne({ _id: links.dealId, organizationId: orgId }, { lastActivityAt: now });
  }
  return activity;
}

/** Upserts the timeline entry for a referenced object (used for calls, whose state changes). */
export async function upsertRefActivity(orgId, refType, refId, fields) {
  const links = await expandLinks(orgId, fields.related);
  const update = { ...fields, links };
  delete update.related;
  return Activity.findOneAndUpdate(
    { organizationId: orgId, refType, refId },
    { $set: update, $setOnInsert: { organizationId: orgId, refType, refId } },
    { upsert: true, returnDocument: 'after' },
  );
}

export async function getTimeline(orgId, entityType, entityId, { limit = 100, before } = {}) {
  const key = ENTITY_LINK_KEY[entityType];
  if (!key) return [];
  const filter = { organizationId: orgId, [`links.${key}`]: new mongoose.Types.ObjectId(String(entityId)) };
  if (before) filter.occurredAt = { $lt: new Date(before) };
  return Activity.find(filter).sort({ occurredAt: -1 }).limit(Math.min(Number(limit) || 100, 500)).lean();
}
