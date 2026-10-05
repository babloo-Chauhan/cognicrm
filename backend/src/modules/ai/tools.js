import mongoose from 'mongoose';
import {
  Appointment, Call, Contact, Deal, Lead, Order, Task, Ticket, User,
} from '../../models/index.js';
import { hasPermission } from '../../middleware/auth.js';
import { forbidden, badRequest } from '../../lib/errors.js';
import { normalizePhone } from '../../lib/phone.js';
import { findCustomerByPhone, getCustomerContext } from '../crm/lookup.js';
import { logActivity } from '../timeline/service.js';
import { nextBestAction } from './insights.js';

/**
 * Explicit CRM tools for AI agents (voice agent + sales assistant).
 * - Each tool has a fixed JSON schema, a required permission and a tenant-scoped handler.
 * - AI never receives raw database access: it can only call these functions, and only the ones
 *   granted to it (voice agents: VoiceAgent.tools allow-list; assistant: the user's permissions).
 */
const str = (description) => ({ type: 'string', description });
const oid = (v) => (v && mongoose.isValidObjectId(v) ? v : undefined);
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined && obj[k] !== '').map((k) => [k, obj[k]]));
}

function summarize(doc, keys) {
  if (!doc) return null;
  return { id: String(doc._id), ...pick(doc, keys) };
}

export const TOOLS = {
  search_customer: {
    description: 'Find a customer (contact or lead) by phone number, email or name.',
    permission: 'crm:read',
    input_schema: { type: 'object', properties: { query: str('Phone, email or name') }, required: ['query'] },
    async handler({ orgId }, { query }) {
      const q = String(query || '').trim();
      if (!q) throw badRequest('query is required');
      if (/^[+\d][\d\s-]{6,}$/.test(q)) {
        const m = await findCustomerByPhone(orgId, normalizePhone(q));
        return {
          contact: summarize(m.contact, ['firstName', 'lastName', 'email', 'phone', 'company']),
          lead: summarize(m.lead, ['name', 'email', 'phone', 'company', 'status', 'score']),
        };
      }
      const rx = new RegExp(escapeRx(q), 'i');
      const [contacts, leads] = await Promise.all([
        Contact.find({ organizationId: orgId, $or: [{ firstName: rx }, { lastName: rx }, { email: rx }, { company: rx }] }).limit(5).lean(),
        Lead.find({ organizationId: orgId, $or: [{ name: rx }, { email: rx }, { company: rx }] }).limit(5).lean(),
      ]);
      return {
        contacts: contacts.map((c) => summarize(c, ['firstName', 'lastName', 'email', 'phone', 'company'])),
        leads: leads.map((l) => summarize(l, ['name', 'email', 'phone', 'company', 'status', 'score'])),
      };
    },
  },

  create_lead: {
    description: 'Create a new lead.',
    permission: 'crm:write',
    input_schema: {
      type: 'object',
      properties: { name: str('Full name'), phone: str('Phone'), email: str('Email'), company: str('Company'), source: str('Lead source'), notes: str('Notes') },
      required: ['name'],
    },
    async handler({ orgId, user, origin }, input) {
      const lead = await Lead.create({
        organizationId: orgId, ...pick(input, ['name', 'email', 'company']), phone: normalizePhone(input.phone),
        source: input.source || (origin === 'voice_agent' ? 'inbound_call' : 'other'), ownerId: user?._id,
      });
      await logActivity(orgId, { type: 'lead_created', title: `Lead created: ${lead.name}`, related: { leadId: lead._id }, userId: user?._id, data: { by: origin } });
      return { id: String(lead._id), name: lead.name };
    },
  },

  update_lead: {
    description: 'Update fields of an existing lead.',
    permission: 'crm:write',
    input_schema: {
      type: 'object',
      properties: {
        leadId: str('Lead id'), status: { type: 'string', enum: ['new', 'contacted', 'qualified', 'unqualified'] },
        email: str('Email'), company: str('Company'), estimatedValue: { type: 'number' }, industry: str('Industry'), companySize: str('Company size'),
      },
      required: ['leadId'],
    },
    async handler({ orgId }, input) {
      const res = await Lead.findOneAndUpdate(
        { _id: oid(input.leadId), organizationId: orgId },
        pick(input, ['status', 'email', 'company', 'estimatedValue', 'industry', 'companySize']),
        { returnDocument: 'after' },
      ).lean();
      if (!res) throw badRequest('Lead not found');
      return summarize(res, ['name', 'status', 'email', 'company']);
    },
  },

  create_contact: {
    description: 'Create a new contact.',
    permission: 'crm:write',
    input_schema: {
      type: 'object',
      properties: { firstName: str('First name'), lastName: str('Last name'), phone: str('Phone'), email: str('Email'), company: str('Company') },
      required: ['firstName'],
    },
    async handler({ orgId, user }, input) {
      const c = await Contact.create({ organizationId: orgId, ...pick(input, ['firstName', 'lastName', 'email', 'company']), phone: normalizePhone(input.phone), ownerId: user?._id });
      return { id: String(c._id) };
    },
  },

  update_contact: {
    description: 'Update an existing contact.',
    permission: 'crm:write',
    input_schema: {
      type: 'object',
      properties: { contactId: str('Contact id'), email: str('Email'), company: str('Company'), firstName: str('First name'), lastName: str('Last name') },
      required: ['contactId'],
    },
    async handler({ orgId }, input) {
      const res = await Contact.findOneAndUpdate({ _id: oid(input.contactId), organizationId: orgId }, pick(input, ['email', 'company', 'firstName', 'lastName']), { returnDocument: 'after' }).lean();
      if (!res) throw badRequest('Contact not found');
      return summarize(res, ['firstName', 'lastName', 'email', 'company']);
    },
  },

  create_task: {
    description: 'Create a follow-up task. dueAt is an ISO date-time. assigneeName optionally assigns it to a teammate by name.',
    permission: 'crm:write',
    input_schema: {
      type: 'object',
      properties: {
        title: str('Task title'), dueAt: str('ISO 8601 due date-time'), assigneeName: str('Teammate name'),
        leadId: str('Related lead id'), contactId: str('Related contact id'), dealId: str('Related deal id'), priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['title'],
    },
    async handler({ orgId, user, origin, callId }, input) {
      let assigneeId = user?._id;
      if (input.assigneeName) {
        const u = await User.findOne({ organizationId: orgId, name: new RegExp(`^${escapeRx(input.assigneeName)}`, 'i') }).lean();
        if (u) assigneeId = u._id;
      }
      const task = await Task.create({
        organizationId: orgId, title: input.title, dueAt: input.dueAt ? new Date(input.dueAt) : undefined, assigneeId,
        priority: input.priority || 'medium', source: origin || 'ai',
        related: { leadId: oid(input.leadId), contactId: oid(input.contactId), dealId: oid(input.dealId), callId: oid(callId) },
      });
      await logActivity(orgId, { type: 'task_created', title: `Task created: ${task.title}`, related: task.related, userId: user?._id });
      return { id: String(task._id), title: task.title, dueAt: task.dueAt, assigneeId: String(assigneeId || '') };
    },
  },

  check_availability: {
    description: 'Check free appointment slots for a date (YYYY-MM-DD). Business hours are 10:00-18:00, 30 minute slots.',
    permission: 'crm:read',
    input_schema: { type: 'object', properties: { date: str('YYYY-MM-DD'), userId: str('Optional user id') }, required: ['date'] },
    async handler({ orgId }, { date, userId }) {
      const day = new Date(`${date}T00:00:00`);
      if (Number.isNaN(day.getTime())) throw badRequest('Invalid date');
      const end = new Date(day.getTime() + 86400000);
      const booked = await Appointment.find({
        organizationId: orgId, status: 'scheduled', startAt: { $gte: day, $lt: end }, ...(oid(userId) ? { userId } : {}),
      }).lean();
      const slots = [];
      for (let h = 10; h < 18; h += 0.5) {
        const s = new Date(day.getTime() + h * 3600000);
        const e = new Date(s.getTime() + 1800000);
        if (s > new Date() && !booked.some((b) => b.startAt < e && b.endAt > s)) slots.push(s.toISOString());
      }
      return { date, freeSlots: slots.slice(0, 12) };
    },
  },

  create_appointment: {
    description: 'Book an appointment/meeting.',
    permission: 'crm:write',
    input_schema: {
      type: 'object',
      properties: { title: str('Title'), startAt: str('ISO start'), durationMinutes: { type: 'number' }, leadId: str('Lead id'), contactId: str('Contact id'), notes: str('Notes') },
      required: ['title', 'startAt'],
    },
    async handler({ orgId, user }, input) {
      const startAt = new Date(input.startAt);
      if (Number.isNaN(startAt.getTime())) throw badRequest('Invalid startAt');
      const endAt = new Date(startAt.getTime() + (input.durationMinutes || 30) * 60000);
      const clash = await Appointment.exists({ organizationId: orgId, status: 'scheduled', startAt: { $lt: endAt }, endAt: { $gt: startAt } });
      if (clash) return { booked: false, reason: 'Slot is no longer available' };
      const a = await Appointment.create({
        organizationId: orgId, title: input.title, startAt, endAt, userId: user?._id, notes: input.notes,
        related: { leadId: oid(input.leadId), contactId: oid(input.contactId) },
      });
      await logActivity(orgId, { type: 'appointment', title: `Appointment booked: ${a.title}`, related: a.related, userId: user?._id });
      return { booked: true, id: String(a._id), startAt: a.startAt };
    },
  },

  create_ticket: {
    description: 'Create a support ticket.',
    permission: 'crm:write',
    input_schema: {
      type: 'object',
      properties: { subject: str('Subject'), description: str('Details'), contactId: str('Contact id'), priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] } },
      required: ['subject'],
    },
    async handler({ orgId, user }, input) {
      const t = await Ticket.create({ organizationId: orgId, ...pick(input, ['subject', 'description', 'priority']), contactId: oid(input.contactId) });
      await logActivity(orgId, { type: 'ticket_created', title: `Ticket created: ${t.subject}`, related: { ticketId: t._id, contactId: t.contactId }, userId: user?._id });
      return { id: String(t._id), subject: t.subject };
    },
  },

  update_ticket: {
    description: 'Update a support ticket status/priority.',
    permission: 'crm:write',
    input_schema: {
      type: 'object',
      properties: { ticketId: str('Ticket id'), status: { type: 'string', enum: ['open', 'pending', 'resolved', 'closed'] }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] } },
      required: ['ticketId'],
    },
    async handler({ orgId }, input) {
      const t = await Ticket.findOneAndUpdate({ _id: oid(input.ticketId), organizationId: orgId }, pick(input, ['status', 'priority']), { returnDocument: 'after' }).lean();
      if (!t) throw badRequest('Ticket not found');
      return summarize(t, ['subject', 'status', 'priority']);
    },
  },

  search_order: {
    description: 'Look up an order and its payment status by order number.',
    permission: 'crm:read',
    input_schema: { type: 'object', properties: { orderNumber: str('Order number') }, required: ['orderNumber'] },
    async handler({ orgId }, { orderNumber }) {
      const o = await Order.findOne({ organizationId: orgId, orderNumber: String(orderNumber) }).lean();
      return o ? summarize(o, ['orderNumber', 'status', 'paymentStatus', 'amount', 'expectedDelivery']) : { found: false };
    },
  },

  send_sms: {
    description: 'Send an SMS to a phone number.',
    permission: 'messages:send',
    input_schema: { type: 'object', properties: { to: str('Phone'), body: str('Message text') }, required: ['to', 'body'] },
    async handler({ orgId, user }, { to, body }) {
      const { sendMessage } = await import('../messaging/service.js');
      const { message } = await sendMessage(orgId, user, { channel: 'sms', to, body });
      return { id: String(message._id), status: message.status };
    },
  },

  send_email: {
    description: 'Send an email.',
    permission: 'messages:send',
    input_schema: { type: 'object', properties: { to: str('Email'), subject: str('Subject'), body: str('Body') }, required: ['to', 'subject', 'body'] },
    async handler({ orgId, user }, input) {
      const { sendMessage } = await import('../messaging/service.js');
      const { message } = await sendMessage(orgId, user, { channel: 'email', ...input });
      return { id: String(message._id), status: message.status };
    },
  },

  transfer_call: {
    description: 'Transfer the current phone call to a human agent. Use when the customer asks for a human or the request is outside your scope.',
    permission: 'calls:make',
    voiceOnly: true,
    input_schema: { type: 'object', properties: { reason: str('Why the call is being transferred') }, required: ['reason'] },
    async handler(ctx, { reason }) {
      ctx.escalate = { reason };
      return { transferring: true };
    },
  },

  end_call: {
    description: 'End the phone call politely once the customer has no further questions.',
    permission: 'calls:make',
    voiceOnly: true,
    input_schema: { type: 'object', properties: { reason: str('Reason') } },
    async handler(ctx) {
      ctx.endCall = true;
      return { ending: true };
    },
  },

  // ---------------------------------------------------------- assistant read tools
  list_leads: {
    description: 'List leads. filter "hot" returns high-score leads; "mine" restricts to the current user.',
    permission: 'crm:read',
    input_schema: {
      type: 'object',
      properties: { filter: { type: 'string', enum: ['hot', 'new', 'all'] }, mine: { type: 'boolean' }, limit: { type: 'number' } },
    },
    async handler({ orgId, user }, { filter = 'all', mine = true, limit = 10 }) {
      const q = { organizationId: orgId, status: { $ne: 'converted' } };
      if (mine && user) q.ownerId = user._id;
      if (filter === 'hot') q.score = { $gte: 70 };
      if (filter === 'new') q.status = 'new';
      const leads = await Lead.find(q).sort({ score: -1 }).limit(Math.min(limit, 50)).lean();
      return leads.map((l) => summarize(l, ['name', 'company', 'phone', 'status', 'score']));
    },
  },

  list_deals: {
    description: 'List open deals. needsFollowUp=true returns deals with no activity in 7+ days or overdue close dates.',
    permission: 'crm:read',
    input_schema: { type: 'object', properties: { needsFollowUp: { type: 'boolean' }, mine: { type: 'boolean' }, limit: { type: 'number' } } },
    async handler({ orgId, user }, { needsFollowUp = false, mine = true, limit = 10 }) {
      const q = { organizationId: orgId, stage: { $nin: ['won', 'lost'] } };
      if (mine && user) q.ownerId = user._id;
      if (needsFollowUp) {
        const weekAgo = new Date(Date.now() - 7 * 86400000);
        q.$or = [{ lastActivityAt: { $lt: weekAgo } }, { lastActivityAt: null, updatedAt: { $lt: weekAgo } }, { expectedCloseDate: { $lt: new Date() } }];
      }
      const deals = await Deal.find(q).sort({ value: -1 }).limit(Math.min(limit, 50)).lean();
      return deals.map((d) => summarize(d, ['name', 'stage', 'value', 'expectedCloseDate', 'lastActivityAt']));
    },
  },

  list_calls: {
    description: 'List calls for a period ("today", "yesterday", "week").',
    permission: 'crm:read',
    input_schema: { type: 'object', properties: { period: { type: 'string', enum: ['today', 'yesterday', 'week'] }, mine: { type: 'boolean' } } },
    async handler({ orgId, user }, { period = 'today', mine = true }) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      let end = null;
      if (period === 'yesterday') { end = new Date(start); start.setDate(start.getDate() - 1); }
      if (period === 'week') start.setDate(start.getDate() - 7);
      const q = { organizationId: orgId, startedAt: { $gte: start, ...(end ? { $lt: end } : {}) } };
      // Users without calls:read_all only ever see their own calls
      if (user && (mine || !hasPermission(user, 'calls:read_all'))) q.agentId = user._id;
      const calls = await Call.find(q).sort({ startedAt: -1 }).limit(50).lean();
      return calls.map((c) => ({
        id: String(c._id), direction: c.direction, customerPhone: c.customerPhone, status: c.status,
        durationSeconds: c.durationSeconds, disposition: c.disposition?.label, startedAt: c.startedAt,
      }));
    },
  },

  find_uncontacted: {
    description: 'Find leads and contacts that have not been contacted for N days.',
    permission: 'crm:read',
    input_schema: { type: 'object', properties: { days: { type: 'number' }, limit: { type: 'number' } }, required: ['days'] },
    async handler({ orgId }, { days, limit = 20 }) {
      const cutoff = new Date(Date.now() - Number(days) * 86400000);
      const stale = { $or: [{ lastContactedAt: { $lt: cutoff } }, { lastContactedAt: null, createdAt: { $lt: cutoff } }] };
      const [leads, contacts] = await Promise.all([
        Lead.find({ organizationId: orgId, status: { $nin: ['converted', 'unqualified'] }, ...stale }).limit(limit).lean(),
        Contact.find({ organizationId: orgId, ...stale }).limit(limit).lean(),
      ]);
      return {
        leads: leads.map((l) => summarize(l, ['name', 'phone', 'lastContactedAt'])),
        contacts: contacts.map((c) => summarize(c, ['firstName', 'lastName', 'phone', 'lastContactedAt'])),
      };
    },
  },

  get_customer_summary: {
    description: 'Get a full summary of a customer: profile, recent calls, open deals and tickets.',
    permission: 'crm:read',
    input_schema: { type: 'object', properties: { contactId: str('Contact id'), leadId: str('Lead id'), phone: str('Phone') } },
    async handler({ orgId }, input) {
      const ctx = await getCustomerContext(orgId, { contactId: oid(input.contactId), leadId: oid(input.leadId), phone: input.phone });
      return {
        name: ctx.name, company: ctx.company, phone: ctx.phone,
        recentCalls: ctx.previousCalls.slice(0, 5).map((c) => ({ at: c.startedAt, status: c.status, disposition: c.disposition?.label, durationSeconds: c.durationSeconds })),
        openDeals: ctx.openDeals.map((d) => ({ name: d.name, stage: d.stage, value: d.value })),
        openTickets: ctx.openTickets.map((t) => ({ subject: t.subject, status: t.status, priority: t.priority })),
        lastInteraction: ctx.lastInteraction && { type: ctx.lastInteraction.type, title: ctx.lastInteraction.title, at: ctx.lastInteraction.occurredAt },
      };
    },
  },

  get_next_best_action: {
    description: 'Get explainable next-best-action suggestions for a lead or deal.',
    permission: 'crm:read',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['lead', 'deal'] }, id: str('Lead or deal id') }, required: ['kind', 'id'] },
    async handler({ orgId }, { kind, id }) {
      return nextBestAction(orgId, kind, oid(id));
    },
  },
};

/** Tool definitions in the Anthropic tools format, filtered by an allow-list. */
export function toolDefinitions(names) {
  return names.filter((n) => TOOLS[n]).map((name) => ({ name, description: TOOLS[name].description, input_schema: TOOLS[name].input_schema }));
}

/**
 * Executes a tool with permission checks.
 * @param ctx { orgId, user, allowed: string[], origin: 'assistant'|'voice_agent', callId }
 */
export async function executeTool(ctx, name, input = {}) {
  const tool = TOOLS[name];
  if (!tool || !ctx.allowed.includes(name)) throw forbidden(`Tool "${name}" is not permitted`);
  if (ctx.user && !hasPermission(ctx.user, tool.permission)) throw forbidden(`Missing permission for tool "${name}"`);
  return tool.handler(ctx, input || {});
}

export const ASSISTANT_TOOLS = Object.keys(TOOLS).filter((n) => !TOOLS[n].voiceOnly);
export const VOICE_AGENT_TOOLS = [
  'search_customer', 'create_lead', 'update_lead', 'create_contact', 'update_contact', 'create_task', 'create_appointment',
  'check_availability', 'create_ticket', 'update_ticket', 'search_order', 'send_sms', 'send_email', 'transfer_call', 'end_call',
];
