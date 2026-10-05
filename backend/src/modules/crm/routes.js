import { Router } from 'express';
import {
  Account, Appointment, Contact, Deal, Lead, Note, Order, Organization, Task, Ticket,
} from '../../models/index.js';
import { requirePermission } from '../../middleware/auth.js';
import { normalizePhone } from '../../lib/phone.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { crudRouter } from './crud.js';
import { IO_SPECS } from './importExport.js';
import { getCustomerContext } from './lookup.js';
import { getTimeline, logActivity } from '../timeline/service.js';
import { scoreDeal, scoreLead } from '../ai/insights.js';
import { notifyTaskAssigned } from '../notifications/reminders.js';

const router = Router();
router.use(requirePermission('crm:read', 'crm:write'));

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

router.use('/contacts', crudRouter(Contact, {
  io: IO_SPECS.contacts,
  searchFields: ['firstName', 'lastName', 'email', 'phone', 'company'],
  filterFields: ['accountId', 'ownerId'],
  onCreate: normalizePhoneField,
  onUpdate: (doc, _b, req) => normalizePhoneField(doc, req),
  activity: {
    type: 'contact_created',
    title: (d) => `Contact created: ${d.firstName} ${d.lastName || ''}`.trim(),
    related: (d) => ({ contactId: d._id, accountId: d.accountId }),
  },
}));

router.use('/accounts', crudRouter(Account, {
  io: IO_SPECS.accounts,
  searchFields: ['name', 'industry', 'website'],
  filterFields: ['ownerId', 'industry'],
  activity: { type: 'account_created', title: (d) => `Account created: ${d.name}`, related: (d) => ({ accountId: d._id }) },
}));

// Lead extras must be registered before the generic CRUD router (which owns "/:id")
router.post('/leads/:id/convert', async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, organizationId: req.orgId });
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
  if (req.body?.createDeal !== false) {
    deal = await Deal.create({
      organizationId: req.orgId, name: req.body?.dealName || `${lead.company || lead.name} deal`,
      value: lead.estimatedValue || 0, contactId: contact._id, accountId: account?._id, leadId: lead._id, ownerId: lead.ownerId,
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

router.post('/leads/:id/score', async (req, res) => {
  res.json(await scoreLead(req.orgId, req.params.id));
});

router.use('/leads', crudRouter(Lead, {
  io: IO_SPECS.leads,
  searchFields: ['name', 'email', 'phone', 'company'],
  filterFields: ['status', 'source', 'ownerId'],
  onCreate: async (doc, req) => { await normalizePhoneField(doc, req); await applyScore(scoreLead, doc, req); },
  onUpdate: async (doc, _b, req) => { await normalizePhoneField(doc, req); await applyScore(scoreLead, doc, req); },
  activity: { type: 'lead_created', title: (d) => `Lead created: ${d.name}`, related: (d) => ({ leadId: d._id }) },
}));

router.post('/deals/:id/score', async (req, res) => {
  res.json(await scoreDeal(req.orgId, req.params.id));
});

router.use('/deals', crudRouter(Deal, {
  io: IO_SPECS.deals,
  searchFields: ['name'],
  filterFields: ['stage', 'ownerId', 'accountId', 'contactId'],
  activity: {
    type: 'deal_created', title: (d) => `Deal created: ${d.name}`,
    related: (d) => ({ dealId: d._id, contactId: d.contactId, accountId: d.accountId, leadId: d.leadId }),
  },
  onUpdate: async (doc, before, req) => {
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
  io: IO_SPECS.tickets,
  searchFields: ['subject', 'description'],
  filterFields: ['status', 'priority', 'assigneeId', 'contactId', 'accountId'],
  activity: {
    type: 'ticket_created', title: (d) => `Ticket created: ${d.subject}`,
    related: (d) => ({ ticketId: d._id, contactId: d.contactId, accountId: d.accountId }),
  },
}));

router.use('/tasks', crudRouter(Task, {
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

router.use('/notes', crudRouter(Note, {
  searchFields: ['body'],
  onCreate: async (doc, req) => { doc.authorId = req.user._id; },
  activity: { type: 'note', title: (d) => d.body.slice(0, 120), related: (d) => d.related || {} },
}));

router.use('/appointments', crudRouter(Appointment, {
  searchFields: ['title'],
  filterFields: ['userId', 'status'],
  defaultSort: { startAt: 1 },
  onCreate: async (doc, req) => { if (!doc.userId) doc.userId = req.user._id; },
  onUpdate: async (doc, before) => { if (String(before.startAt) !== String(doc.startAt) || before.status !== doc.status) doc.reminderSentAt = null; },
  activity: { type: 'appointment', title: (d) => `Appointment: ${d.title}`, related: (d) => d.related || {} },
}));

router.use('/orders', crudRouter(Order, { searchFields: ['orderNumber'], filterFields: ['status', 'contactId'] }));

router.get('/timeline/:entityType/:id', async (req, res) => {
  res.json({ items: await getTimeline(req.orgId, req.params.entityType, req.params.id, req.query) });
});

router.get('/customer-context', async (req, res) => {
  const { phone, contactId, leadId } = req.query;
  if (!phone && !contactId && !leadId) throw badRequest('phone, contactId or leadId is required');
  res.json(await getCustomerContext(req.orgId, { phone, contactId, leadId }));
});

export default router;
