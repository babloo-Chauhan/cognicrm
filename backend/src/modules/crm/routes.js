import { Router } from 'express';
import mongoose from 'mongoose';
import {
  Account, Activity, Appointment, Contact, Deal, Lead, Note, Order, Organization, Task, Ticket, User,
} from '../../models/index.js';
import { hasPermission, requirePermission } from '../../middleware/auth.js';
import { checkLimit } from '../saas/usage.js';
import { validateDealStage } from './pipelines.js';
import { normalizePhone } from '../../lib/phone.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { crudRouter, listFilter } from './crud.js';
import { IO_SPECS } from './importExport.js';
import { FIELD_RULES } from './fieldRules.js';
import { getCustomerContext } from './lookup.js';
import { getTimeline, logActivity } from '../timeline/service.js';
import { scoreDeal, scoreLead } from '../ai/insights.js';
import { notifyTaskAssigned } from '../notifications/reminders.js';
import { notify } from '../notifications/service.js';
import { audit } from '../../lib/audit.js';
import { bumpCompany } from '../../lib/cache.js';
import { leadScope, visibleLead } from './leadAccess.js';
import { reportPeriod } from '../reports/service.js';

const router = Router();
// Each entity checks `<resource>:<action>` (see crudRouter `resource`); extra routes check explicitly below.

// Keeps a lead's stored score in step with the record, so lists and the next-best-action card agree.
// (Deals are left alone: the forecast falls back to stage probability until a deal is scored.)
async function applyScore(score, doc, req) {
  const r = await score(req.orgId, doc, { save: false }).catch(() => null);
  if (r) { doc.score = r.score; doc.scoreFactors = r.factors; }
}

async function normalizePhoneField(doc, req) {
  if (doc.phone) {
    const org = await Organization.findById(req.orgId).select('settings.defaultCountryCode').lean();
    doc.phone = normalizePhone(doc.phone, org?.settings?.defaultCountryCode || '91');
  }
}

/**
 * Records belong to whoever creates them unless an owner is chosen (as leads and tasks already did), so
 * "my deals / my contacts" filters, the app's Mine toggle and the AI assistant's "my …" questions work.
 */
async function defaultOwner(doc, req) {
  if (!doc.ownerId) doc.ownerId = req.user._id;
  else await assertAssignable(req.orgId, doc.ownerId);
}
async function ownerChanged(doc, before, req) {
  if (doc.ownerId && String(before.ownerId || '') !== String(doc.ownerId)) await assertAssignable(req.orgId, doc.ownerId);
}

router.use('/contacts', crudRouter(Contact, {
  rules: FIELD_RULES.contacts,
  resource: 'contacts',
  limit: 'customers',
  io: IO_SPECS.contacts,
  searchFields: ['firstName', 'lastName', 'email', 'phone', 'company'],
  filterFields: ['accountId', 'ownerId'],
  onCreate: async (doc, req) => { await defaultOwner(doc, req); await normalizePhoneField(doc, req); },
  onUpdate: async (doc, before, req) => { await ownerChanged(doc, before, req); await normalizePhoneField(doc, req); },
  activity: {
    type: 'contact_created',
    title: (d) => `Contact created: ${d.firstName} ${d.lastName || ''}`.trim(),
    related: (d) => ({ contactId: d._id, accountId: d.accountId }),
  },
}));

router.use('/accounts', crudRouter(Account, {
  rules: FIELD_RULES.accounts,
  resource: 'accounts',
  limit: 'customers',
  io: IO_SPECS.accounts,
  searchFields: ['name', 'industry', 'website'],
  filterFields: ['ownerId', 'industry'],
  onCreate: defaultOwner,
  onUpdate: ownerChanged,
  activity: { type: 'account_created', title: (d) => `Account created: ${d.name}`, related: (d) => ({ accountId: d._id }) },
}));

// Lead extras must be registered before the generic CRUD router (which owns "/:id")
router.post('/leads/:id/convert', requirePermission('leads:update'), requirePermission('contacts:create'), async (req, res) => {
  // Converting creates customers (and a deal), so those modules must be in the plan, not just leads
  if (!req.tenant.modules.includes('customers')) {
    throw new AppError(403, 'Converting a lead needs the customers module. Upgrade your plan.', 'MODULE_NOT_IN_PLAN', { module: 'customers' });
  }
  const withDeal = req.body?.createDeal !== false && req.tenant.modules.includes('deals');
  await checkLimit(req.orgId, 'customers', 2);
  if (withDeal) await checkLimit(req.orgId, 'deals');
  const lead = await visibleLead(req, req.params.id);
  if (!lead) throw notFound('Lead');
  if (lead.status === 'converted') throw badRequest('Lead is already converted');
  const [firstName, ...rest] = lead.name.split(' ');
  let account = null;
  // Accounts only for companies that use them (Settings → Features); otherwise the company stays a text field
  const org = await Organization.findById(req.orgId).select('settings.features').lean();
  if (lead.company && org?.settings?.features?.accounts === true) {
    account = await Account.findOne({ organizationId: req.orgId, name: lead.company })
      || await Account.create({ organizationId: req.orgId, name: lead.company, industry: lead.industry, ownerId: lead.ownerId });
  }
  const contact = await Contact.create({
    organizationId: req.orgId, firstName, lastName: rest.join(' '), email: lead.email, phone: lead.phone,
    company: lead.company, accountId: account?._id, ownerId: lead.ownerId,
  });
  let deal = null;
  if (withDeal) {
    deal = await Deal.create({
      organizationId: req.orgId, name: req.body?.dealName || `${lead.company || lead.name} deal`,
      value: lead.estimatedValue || 0, contactId: contact._id, accountId: account?._id, leadId: lead._id, ownerId: lead.ownerId,
    });
  }
  const carried = [lead.requirement && `Requirement: ${lead.requirement}`, lead.notes && `Remarks: ${lead.notes}`].filter(Boolean).join('\n');
  if (carried) {
    await Note.create({
      organizationId: req.orgId, body: carried, authorId: req.user._id,
      related: { leadId: lead._id, contactId: contact._id, dealId: deal?._id, accountId: account?._id },
    });
  }
  lead.status = 'converted';
  lead.convertedContactId = contact._id;
  await lead.save();
  await logActivity(req.orgId, {
    type: 'lead_converted', title: `Lead converted: ${lead.name}`, userId: req.user._id,
    related: { leadId: lead._id, contactId: contact._id, accountId: account?._id, dealId: deal?._id },
  });
  res.json({ lead, contact, account, deal });
});

/** The new owner must be an active member of the same company. */
async function assertAssignable(orgId, userId) {
  if (!userId) return null;
  const user = await User.findOne({ _id: userId, organizationId: orgId, active: true }).select('name').lean();
  if (!user) throw badRequest('Choose an active member of your team');
  return user;
}

/** True when this user holds the lead now or held it before: it is theirs to work and to assign on. */
const sharesLead = (lead, user) => String(lead.ownerId || '') === String(user._id) || (lead.assignees || []).some((a) => String(a) === String(user._id));

/**
 * Who may change a lead's owner: the company admin (team_leads:assign) to anyone or to nobody;
 * everyone who has held the lead may assign it on to a colleague. Only the admin can unassign.
 */
function assertMayAssign(req, before, nextOwnerId) {
  if (hasPermission(req.user, 'team_leads:assign')) return;
  if (!sharesLead(before, req.user)) throw forbidden('Only the admin or someone this lead was assigned to can reassign it');
  if (!nextOwnerId) throw forbidden('Only the admin can unassign a lead');
}

/** Adds a hand-over to the lead's history and keeps everyone who held it able to see it. */
function recordAssignment(doc, from, to, by) {
  doc.assignments.push({ from: from || null, to: to || null, by, at: new Date() });
  for (const id of [from, to]) {
    if (id && !doc.assignees.some((a) => String(a) === String(id))) doc.assignees.push(id);
  }
}

/** Records the hand-over on the timeline, tells the new owner (tap to call) and the previous one. */
async function leadAssigned(doc, req, owner, previousOwnerId) {
  await logActivity(req.orgId, {
    type: 'lead_assigned', title: owner ? `Lead assigned to ${owner.name} by ${req.user.name}` : `Lead unassigned by ${req.user.name}`,
    related: { leadId: doc._id }, refType: 'Lead', refId: doc._id, userId: req.user._id,
  });
  if (owner && String(doc.ownerId) !== String(req.user._id)) {
    await notify(req.orgId, doc.ownerId, {
      type: 'lead_assigned', title: `New lead: ${doc.name}`,
      body: `Assigned to you by ${req.user.name}${doc.phone ? ` · ${doc.phone} — tap to call` : ''}`,
      data: { leadId: String(doc._id), ...(doc.phone ? { phone: doc.phone, action: 'call' } : {}) },
    });
  }
  if (previousOwnerId && String(previousOwnerId) !== String(req.user._id) && String(previousOwnerId) !== String(doc.ownerId || '')) {
    await notify(req.orgId, previousOwnerId, {
      type: 'lead_reassigned', title: `Lead moved: ${doc.name}`,
      body: owner ? `${req.user.name} assigned it to ${owner.name}. It stays in your leads too.` : `${req.user.name} unassigned it. It stays in your leads too.`,
      data: { leadId: String(doc._id) },
    });
  }
}

// Leads that need no more work: never on the home page's work list
const CLOSED_LEADS = ['lost', 'unqualified', 'converted', 'won'];
const FOCUS_ORDER = { today: 0, not_updated: 1, follow_up: 2 };

/**
 * The person's leads to work on next, for the home page, in this order:
 *  1. assigned (or created) today — newest first
 *  2. from earlier days and still "new" (status never updated) — newest first
 *  3. follow-up due today or overdue — most overdue first
 * Lost / unqualified / converted / won leads are left out. Each item says why it is there (`focus`).
 */
router.get('/leads/focus', requirePermission('leads:read'), async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const today = await reportPeriod(req.orgId, {}).then((p) => p.to);
  const { start, end } = await reportPeriod(req.orgId, { from: today, to: today });
  const leads = await Lead.aggregate([
    { $match: { organizationId: req.orgId, status: { $nin: CLOSED_LEADS } } },
    { $match: leadScope(req) || {} },
    // When it reached its current holder: the latest hand-over, else when it was created
    { $addFields: { assignedAt: { $ifNull: [{ $max: '$assignments.at' }, '$createdAt'] } } },
    { $match: { $or: [{ assignedAt: { $gte: start } }, { status: 'new' }, { nextFollowUpAt: { $lt: end } }] } },
    { $project: { name: 1, phone: 1, company: 1, status: 1, score: 1, ownerId: 1, nextFollowUpAt: 1, assignedAt: 1 } },
    { $sort: { assignedAt: -1 } },
    { $limit: 1000 },
  ]);
  const focusOf = (l) => {
    if (l.assignedAt >= start) return 'today';
    if (l.status === 'new') return 'not_updated';
    return 'follow_up';
  };
  const items = leads.map((l) => ({ ...l, id: String(l._id), _id: undefined, focus: focusOf(l) }))
    .sort((a, b) => FOCUS_ORDER[a.focus] - FOCUS_ORDER[b.focus]
      || (a.focus === 'follow_up' ? a.nextFollowUpAt - b.nextFollowUpAt : b.assignedAt - a.assignedAt));
  const counts = { today: 0, not_updated: 0, follow_up: 0 };
  for (const l of items) counts[l.focus] += 1;
  res.json({ items: items.slice(0, limit), counts, total: items.length });
});

router.post('/leads/:id/score', requirePermission('leads:update'), async (req, res) => {
  if (!await visibleLead(req, req.params.id)) throw notFound('Lead');
  res.json(await scoreLead(req.orgId, req.params.id));
});

/**
 * Adds a colleague (say a senior who should talk to the client too) to a lead without moving it:
 * the owner stays, and the new person sees it and can work on it like everyone else it was assigned to.
 * Allowed for the admin and for anyone who has the lead.
 */
router.post('/leads/:id/team', requirePermission('leads:update'), async (req, res) => {
  const lead = await visibleLead(req, req.params.id);
  if (!lead) throw notFound('Lead');
  if (!hasPermission(req.user, 'team_leads:assign') && !sharesLead(lead, req.user)) throw forbidden('Only the admin or someone this lead was assigned to can add people to it');
  const member = await assertAssignable(req.orgId, req.body?.userId);
  if (!member) throw badRequest('Choose who to add');
  const id = req.body.userId;
  if (sharesLead(lead, { _id: id })) throw badRequest(`${member.name} already has this lead`);
  lead.assignees.push(id);
  lead.assignments.push({ kind: 'added', from: null, to: id, by: req.user._id, at: new Date() });
  await lead.save();
  await logActivity(req.orgId, {
    type: 'lead_assigned', title: `${member.name} added to the lead by ${req.user.name}`,
    related: { leadId: lead._id }, refType: 'Lead', refId: lead._id, userId: req.user._id,
  });
  if (String(id) !== String(req.user._id)) {
    await notify(req.orgId, id, {
      type: 'lead_assigned', title: `Lead shared with you: ${lead.name}`,
      body: `${req.user.name} added you to this lead${lead.phone ? ` · ${lead.phone} — tap to call` : ''}`,
      data: { leadId: String(lead._id), ...(lead.phone ? { phone: lead.phone, action: 'call' } : {}) },
    });
  }
  res.status(201).json(lead.toJSON());
});

/** Takes someone off a lead (not the owner: reassign for that). The admin can remove anyone; people can remove themselves. */
router.delete('/leads/:id/team/:userId', requirePermission('leads:update'), async (req, res) => {
  const lead = await visibleLead(req, req.params.id);
  if (!lead) throw notFound('Lead');
  const id = req.params.userId;
  const self = String(id) === String(req.user._id);
  if (!hasPermission(req.user, 'team_leads:assign') && !self) throw forbidden('Only the admin can take someone off a lead');
  if (String(lead.ownerId || '') === String(id)) throw badRequest('This person owns the lead — reassign it to someone else first');
  if (!lead.assignees.some((a) => String(a) === String(id))) throw notFound('Person on this lead');
  lead.assignees = lead.assignees.filter((a) => String(a) !== String(id));
  lead.assignments.push({ kind: 'removed', from: id, to: null, by: req.user._id, at: new Date() });
  await lead.save();
  const member = await User.findById(id).select('name').lean();
  await logActivity(req.orgId, {
    type: 'lead_assigned', title: `${member?.name || 'Someone'} removed from the lead by ${req.user.name}`,
    related: { leadId: lead._id }, refType: 'Lead', refId: lead._id, userId: req.user._id,
  });
  res.json(lead.toJSON());
});

const LEAD_SEARCH = ['name', 'email', 'phone', 'company'];
// Activity that counts as following up a lead (the list's "Last follow-up" column)
const FOLLOW_UP_TYPES = ['call', 'appointment', 'whatsapp', 'sms', 'email', 'note'];

/** ?reminder=missed | today | upcoming | none: the lead's next follow-up against today in the company's time zone. */
async function reminderFilter(req) {
  const r = req.query.reminder;
  if (!['missed', 'today', 'upcoming', 'none'].includes(r)) return null;
  if (r === 'none') return { nextFollowUpAt: null };
  const today = await reportPeriod(req.orgId, {}).then((p) => p.to);
  const { start, end } = await reportPeriod(req.orgId, { from: today, to: today });
  if (r === 'missed') return { nextFollowUpAt: { $lt: new Date(Math.min(Date.now(), end.getTime())) } };
  if (r === 'today') return { nextFollowUpAt: { $gte: start, $lt: end } };
  return { nextFollowUpAt: { $gte: end } };
}

/**
 * ?from= / ?to= (ISO date-times, either may be left out) on the lead's created time, or with
 * ?dateField=followUp on its next follow-up. The browser works out "today", "this week" … in the user's time.
 */
function dateRangeFilter(req) {
  const parse = (v) => { const d = v ? new Date(String(v)) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
  const from = parse(req.query.from);
  const to = parse(req.query.to);
  if (!from && !to) return null;
  if (from && to && from > to) throw badRequest('The start date is after the end date');
  const field = req.query.dateField === 'followUp' ? 'nextFollowUpAt' : 'createdAt';
  return { [field]: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } };
}

async function leadListFilter(req) {
  const parts = [await reminderFilter(req), dateRangeFilter(req)].filter(Boolean);
  return parts.length > 1 ? { $and: parts } : parts[0] || null;
}

/** Adds each lead's latest follow-up ({ type, at, title }) to a page of list rows. */
async function withLastFollowUp(items, req) {
  const ids = items.map((l) => new mongoose.Types.ObjectId(l.id));
  const last = await Activity.aggregate([
    { $match: { organizationId: req.orgId, 'links.leadId': { $in: ids }, type: { $in: FOLLOW_UP_TYPES } } },
    { $sort: { occurredAt: -1 } },
    { $group: { _id: '$links.leadId', type: { $first: '$type' }, at: { $first: '$occurredAt' }, title: { $first: '$title' } } },
  ]);
  const byLead = new Map(last.map((a) => [String(a._id), { type: a.type, at: a.at, title: a.title }]));
  return items.map((l) => ({ ...l, lastFollowUp: byLead.get(l.id) || null }));
}
const LEAD_FILTERS = ['status', 'source', 'ownerId', 'assignees'];
const BULK_ASSIGN_MAX = 10000;

/**
 * The admin hands many leads out at once: the ticked `ids`, or every lead matching the list's `filter`
 * (search, status, owner — `ownerId: 'none'` for the unassigned ones). One person in `userIds` gets them all;
 * several share them in turn (round-robin, newest lead first); none unassigns them. Each lead keeps its trail
 * like a single reassign, and each person gets one notification for their batch instead of one per lead.
 */
router.post('/leads/bulk-assign', requirePermission('leads:update'), requirePermission('team_leads:assign'), async (req, res) => {
  const { ids, filter, userIds } = req.body || {};
  if (!Array.isArray(userIds)) throw badRequest('Choose who gets the leads');
  const members = await Promise.all([...new Set(userIds.map(String))].map((id) => assertAssignable(req.orgId, id)));
  const owners = [...new Set(userIds.map(String))];
  let match;
  if (Array.isArray(ids)) {
    if (!ids.length) throw badRequest('Select at least one lead');
    if (ids.some((id) => !/^[a-f0-9]{24}$/i.test(String(id)))) throw badRequest('Invalid lead ID');
    match = { organizationId: req.orgId, _id: { $in: ids } };
  } else if (filter && typeof filter === 'object') {
    const query = Object.fromEntries(['q', ...LEAD_FILTERS].filter((k) => typeof filter[k] === 'string' && filter[k]).map((k) => [k, filter[k]]));
    match = listFilter({ orgId: req.orgId, query }, LEAD_SEARCH, LEAD_FILTERS, Lead);
  } else throw badRequest('Send the selected lead ids or the list filter');

  const total = await Lead.countDocuments(match);
  if (total > BULK_ASSIGN_MAX) throw badRequest(`At most ${BULK_ASSIGN_MAX.toLocaleString('en-IN')} leads at a time; narrow the filter`);
  const leads = await Lead.find(match).sort({ createdAt: -1, _id: -1 });
  const now = new Date();
  const changed = [];
  const received = new Map(); // owner id → their leads
  const lost = new Map(); // previous owner id → how many moved away
  leads.forEach((lead, i) => {
    const to = owners.length ? owners[i % owners.length] : null;
    const from = lead.ownerId ? String(lead.ownerId) : null;
    if (from === to) return;
    lead.ownerId = to;
    lead.assignments.push({ from, to, by: req.user._id, at: now });
    for (const id of [from, to]) if (id && !lead.assignees.some((a) => String(a) === id)) lead.assignees.push(id);
    changed.push(lead);
    if (to) { if (!received.has(to)) received.set(to, []); received.get(to).push(lead); }
    if (from && from !== String(req.user._id)) lost.set(from, (lost.get(from) || 0) + 1);
  });
  if (changed.length) await Lead.bulkSave(changed);
  bumpCompany(req.orgId);
  await audit(req, 'leads.bulk_assign', { resourceType: 'Lead', details: { matched: leads.length, assigned: changed.length, userIds: owners } });

  const nameOf = new Map(owners.map((id, i) => [id, members[i]?.name]));
  await Activity.insertMany(changed.map((lead) => ({
    organizationId: req.orgId, type: 'lead_assigned', userId: req.user._id, occurredAt: now, refType: 'Lead', refId: lead._id, links: { leadId: lead._id },
    title: lead.ownerId ? `Lead assigned to ${nameOf.get(String(lead.ownerId))} by ${req.user.name}` : `Lead unassigned by ${req.user.name}`,
  })));
  for (const [id, mine] of received) {
    if (id === String(req.user._id)) continue;
    const one = mine.length === 1 ? mine[0] : null;
    await notify(req.orgId, id, one ? {
      type: 'lead_assigned', title: `New lead: ${one.name}`,
      body: `Assigned to you by ${req.user.name}${one.phone ? ` · ${one.phone} — tap to call` : ''}`,
      data: { leadId: String(one._id), ...(one.phone ? { phone: one.phone, action: 'call' } : {}) },
    } : {
      type: 'lead_assigned', title: `${mine.length} new leads assigned to you`,
      body: `By ${req.user.name}. Open Leads to start calling.`, data: { count: mine.length },
    });
  }
  for (const [id, count] of lost) {
    if (received.has(id)) continue;
    await notify(req.orgId, id, {
      type: 'lead_reassigned', title: count === 1 ? 'A lead was moved' : `${count} leads were moved`,
      body: `${req.user.name} reassigned ${count === 1 ? 'it' : 'them'}. ${count === 1 ? 'It stays' : 'They stay'} in your leads too.`, data: { count },
    });
  }
  res.json({
    matched: leads.length,
    assigned: changed.length,
    unchanged: leads.length - changed.length,
    perUser: owners.map((id) => ({ userId: id, name: nameOf.get(id), count: received.get(id)?.length || 0 })),
  });
});

router.use('/leads', crudRouter(Lead, {
  sortable: ['createdAt', 'updatedAt', 'score'],
  rules: FIELD_RULES.leads,
  resource: 'leads',
  limit: 'leads',
  io: IO_SPECS.leads,
  searchFields: LEAD_SEARCH,
  filterFields: LEAD_FILTERS,
  scope: leadScope,
  queryFilter: leadListFilter,
  decorate: withLastFollowUp,
  onCreate: async (doc, req) => {
    // A lead without an owner belongs to whoever created it; the creator can hand it straight to someone
    if (!doc.ownerId) doc.ownerId = req.user._id;
    else await assertAssignable(req.orgId, doc.ownerId);
    doc.assignees = [];
    doc.assignments = [];
    doc.followUpReminderSentAt = null;
    recordAssignment(doc, null, doc.ownerId, req.user._id);
    if (String(doc.ownerId) !== String(req.user._id)) doc.assignees.push(req.user._id);
    await normalizePhoneField(doc, req);
    await applyScore(scoreLead, doc, req);
  },
  onUpdate: async (doc, before, req) => {
    // History and reminder state are written by the server only
    doc.assignees = before.assignees || [];
    doc.assignments = before.assignments || [];
    doc.followUpReminderSentAt = before.followUpReminderSentAt || null;
    // A new follow-up time gets a fresh reminder
    if (String(before.nextFollowUpAt || '') !== String(doc.nextFollowUpAt || '')) doc.followUpReminderSentAt = null;
    if (String(before.ownerId || '') !== String(doc.ownerId || '')) {
      assertMayAssign(req, before, doc.ownerId);
      const owner = await assertAssignable(req.orgId, doc.ownerId);
      recordAssignment(doc, before.ownerId, doc.ownerId, req.user._id);
      req.leadAssignment = { owner, previousOwnerId: before.ownerId };
    }
    await normalizePhoneField(doc, req);
    await applyScore(scoreLead, doc, req);
  },
  afterUpdate: async (doc, req) => {
    if (req.leadAssignment) await leadAssigned(doc, req, req.leadAssignment.owner, req.leadAssignment.previousOwnerId);
  },
  afterCreate: async (doc, req) => {
    if (String(doc.ownerId) !== String(req.user._id)) await leadAssigned(doc, req, await User.findById(doc.ownerId).select('name').lean());
  },
  activity: { type: 'lead_created', title: (d) => `Lead created: ${d.name}`, related: (d) => ({ leadId: d._id }) },
}));

router.post('/deals/:id/score', requirePermission('deals:update'), async (req, res) => {
  res.json(await scoreDeal(req.orgId, req.params.id));
});

router.use('/deals', crudRouter(Deal, {
  sortable: ['createdAt', 'updatedAt', 'score'],
  rules: FIELD_RULES.deals,
  resource: 'deals',
  limit: 'deals',
  io: IO_SPECS.deals,
  searchFields: ['name'],
  filterFields: ['stage', 'ownerId', 'accountId', 'contactId', 'pipelineId'],
  onCreate: async (doc, req) => { await defaultOwner(doc, req); await validateDealStage(doc, req.orgId); },
  activity: {
    type: 'deal_created', title: (d) => `Deal created: ${d.name}`,
    related: (d) => ({ dealId: d._id, contactId: d.contactId, accountId: d.accountId, leadId: d.leadId }),
  },
  onUpdate: async (doc, before, req) => {
    await ownerChanged(doc, before, req);
    if (before.stage !== doc.stage || String(before.pipelineId) !== String(doc.pipelineId)) await validateDealStage(doc, req.orgId);
    if (before.stage !== doc.stage) {
      doc.lastActivityAt = new Date();
      await logActivity(req.orgId, {
        type: 'stage_changed', title: `Deal moved from ${before.stage} to ${doc.stage}`, userId: req.user._id,
        related: { dealId: doc._id, contactId: doc.contactId, accountId: doc.accountId },
        data: { from: before.stage, to: doc.stage },
      });
    }
  },
}));

router.use('/tickets', crudRouter(Ticket, {
  rules: FIELD_RULES.tickets,
  resource: 'tickets',
  io: IO_SPECS.tickets,
  searchFields: ['subject', 'description'],
  filterFields: ['status', 'priority', 'assigneeId', 'contactId', 'accountId'],
  activity: {
    type: 'ticket_created', title: (d) => `Ticket created: ${d.subject}`,
    related: (d) => ({ ticketId: d._id, contactId: d.contactId, accountId: d.accountId }),
  },
}));

router.use('/tasks', crudRouter(Task, {
  rules: FIELD_RULES.tasks,
  resource: 'tasks',
  io: IO_SPECS.tasks,
  searchFields: ['title', 'description'],
  filterFields: ['status', 'assigneeId', 'priority', 'related.leadId', 'related.contactId', 'related.dealId'],
  defaultSort: { dueAt: 1 },
  // Unassigned tasks belong to their creator, so they show under "my tasks" and get reminders.
  onCreate: async (doc, req) => { if (!doc.assigneeId) doc.assigneeId = req.user._id; },
  onUpdate: async (doc, before, req) => {
    if (String(before.dueAt) !== String(doc.dueAt) || before.status !== doc.status) doc.reminderSentAt = null;
    if (String(before.assigneeId) !== String(doc.assigneeId)) await notifyTaskAssigned(doc, req.user);
  },
  afterCreate: (doc, req) => notifyTaskAssigned(doc, req.user),
  activity: { type: 'task_created', title: (d) => `Task created: ${d.title}`, related: (d) => d.related || {} },
}));

// Remarks of a lead someone may not see stay hidden from them, and they cannot add any
router.use('/notes', async (req, res, next) => {
  const leadId = req.method === 'GET' ? req.query['related.leadId'] : req.method === 'POST' ? req.body?.related?.leadId : null;
  if (leadId && typeof leadId === 'string' && /^[a-f0-9]{24}$/i.test(leadId) && !await visibleLead(req, leadId)) throw notFound('Lead');
  next();
});
router.use('/notes', crudRouter(Note, {
  resource: 'notes',
  searchFields: ['body'],
  filterFields: ['related.leadId', 'related.contactId', 'related.dealId', 'related.accountId', 'related.ticketId'],
  onCreate: async (doc, req) => {
    doc.body = String(doc.body || '').trim();
    if (!doc.body) throw badRequest('Write a remark first');
    doc.authorId = req.user._id;
  },
  activity: { type: 'note', title: (d) => d.body.slice(0, 120), related: (d) => d.related || {} },
}));

router.use('/appointments', crudRouter(Appointment, {
  rules: FIELD_RULES.appointments,
  resource: 'appointments',
  searchFields: ['title'],
  filterFields: ['userId', 'status'],
  defaultSort: { startAt: 1 },
  onCreate: async (doc, req) => { if (!doc.userId) doc.userId = req.user._id; },
  onUpdate: async (doc, before) => { if (String(before.startAt) !== String(doc.startAt) || before.status !== doc.status) doc.reminderSentAt = null; },
  activity: { type: 'appointment', title: (d) => `Appointment: ${d.title}`, related: (d) => d.related || {} },
}));

router.use('/orders', crudRouter(Order, {
  rules: FIELD_RULES.orders,
  resource: 'orders', searchFields: ['orderNumber'], filterFields: ['status', 'contactId'] }));

router.get('/timeline/:entityType/:id', requirePermission('crm:read'), async (req, res) => {
  if (req.params.entityType === 'lead' && /^[a-f0-9]{24}$/i.test(req.params.id) && !await visibleLead(req, req.params.id)) throw notFound('Lead');
  res.json({ items: await getTimeline(req.orgId, req.params.entityType, req.params.id, req.query) });
});

router.get('/customer-context', requirePermission('crm:read'), async (req, res) => {
  const { phone, contactId, leadId } = req.query;
  if (!phone && !contactId && !leadId) throw badRequest('phone, contactId or leadId is required');
  res.json(await getCustomerContext(req.orgId, { phone, contactId, leadId }));
});

export default router;
