import { Router } from 'express';
import {
  Account, Appointment, Contact, Deal, Lead, Note, Order, Organization, Task, Ticket, User,
} from '../../models/index.js';
import { hasPermission, requirePermission } from '../../middleware/auth.js';
import { checkLimit } from '../saas/usage.js';
import { validateDealStage } from './pipelines.js';
import { normalizePhone } from '../../lib/phone.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { crudRouter } from './crud.js';
import { IO_SPECS } from './importExport.js';
import { FIELD_RULES } from './fieldRules.js';
import { getCustomerContext } from './lookup.js';
import { getTimeline, logActivity } from '../timeline/service.js';
import { scoreDeal, scoreLead } from '../ai/insights.js';
import { notifyTaskAssigned } from '../notifications/reminders.js';
import { notify } from '../notifications/service.js';
import { leadScope, visibleLead } from './leadAccess.js';

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
  if (lead.company) {
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

/**
 * Who may change a lead's owner: the company admin (team_leads:assign) to anyone or to nobody;
 * the person holding the lead may pass it on to a colleague. Everyone else is refused.
 */
function assertMayAssign(req, before, nextOwnerId) {
  if (hasPermission(req.user, 'team_leads:assign')) return;
  if (String(before.ownerId || '') !== String(req.user._id)) throw forbidden('Only the admin or the person this lead is assigned to can reassign it');
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
      body: owner ? `${req.user.name} assigned it to ${owner.name}. You can still see it.` : `${req.user.name} unassigned it. You can still see it.`,
      data: { leadId: String(doc._id) },
    });
  }
}

router.post('/leads/:id/score', requirePermission('leads:update'), async (req, res) => {
  if (!await visibleLead(req, req.params.id)) throw notFound('Lead');
  res.json(await scoreLead(req.orgId, req.params.id));
});

router.use('/leads', crudRouter(Lead, {
  sortable: ['createdAt', 'updatedAt', 'score'],
  rules: FIELD_RULES.leads,
  resource: 'leads',
  limit: 'leads',
  io: IO_SPECS.leads,
  searchFields: ['name', 'email', 'phone', 'company'],
  filterFields: ['status', 'source', 'ownerId', 'assignees'],
  scope: leadScope,
  onCreate: async (doc, req) => {
    // A lead without an owner belongs to whoever created it; the creator can hand it straight to someone
    if (!doc.ownerId) doc.ownerId = req.user._id;
    else await assertAssignable(req.orgId, doc.ownerId);
    doc.assignees = [];
    doc.assignments = [];
    recordAssignment(doc, null, doc.ownerId, req.user._id);
    if (String(doc.ownerId) !== String(req.user._id)) doc.assignees.push(req.user._id);
    await normalizePhoneField(doc, req);
    await applyScore(scoreLead, doc, req);
  },
  onUpdate: async (doc, before, req) => {
    // History is written by the server only
    doc.assignees = before.assignees || [];
    doc.assignments = before.assignments || [];
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
