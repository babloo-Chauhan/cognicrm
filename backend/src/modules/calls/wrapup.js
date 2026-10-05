import { z } from 'zod';
import {
  AgentStatus, Callback, CallDisposition, Deal, DEAL_STAGES, DncEntry, Lead, LEAD_STATUSES, Note, Task, Ticket,
} from '../../models/index.js';
import { badRequest } from '../../lib/errors.js';
import { logActivity } from '../timeline/service.js';
import { setAgentStatus } from '../agents/service.js';
import { onCampaignDisposition } from '../campaigns/service.js';
import { rescoreRelated } from '../ai/insights.js';
import { sendMessage } from '../messaging/service.js';
import { broadcastCall, getCallForControl, syncCallActivity } from './service.js';
import { relatedName } from '../crm/lookup.js';

export const dispositionSchema = z.object({
  code: z.string().min(1),
  notes: z.string().max(10000).optional(),
  createTask: z.object({ title: z.string().min(1), dueAt: z.string().optional(), priority: z.enum(['low', 'medium', 'high']).optional() }).optional(),
  callback: z.object({ scheduledAt: z.string(), notes: z.string().optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), autoDial: z.boolean().optional() }).optional(),
  leadUpdate: z.object({ status: z.enum(LEAD_STATUSES).optional() }).optional(),
  dealUpdate: z.object({ stage: z.enum(DEAL_STAGES).optional(), value: z.number().optional() }).optional(),
  createTicket: z.object({ subject: z.string().min(1), description: z.string().optional(), priority: z.enum(['low', 'medium', 'high', 'urgent']).optional() }).optional(),
  sendEmail: z.object({ to: z.string().email().optional(), subject: z.string().min(1), body: z.string().min(1) }).optional(),
  sendWhatsApp: z.object({ body: z.string().optional(), templateId: z.string().optional(), variables: z.record(z.string(), z.any()).optional() }).optional(),
  addToDnc: z.boolean().optional(),
  endWrapUp: z.boolean().default(true),
});

/**
 * Wrap-up (after-call work): disposition + notes + any follow-up actions in one request.
 * Partial failures of optional actions (e.g. messaging provider down) are reported, not fatal.
 */
export async function applyDisposition(orgId, user, callId, input) {
  const call = await getCallForControl(orgId, callId);
  const def = await CallDisposition.findOne({ organizationId: orgId, code: input.code, active: true }).lean();
  if (!def) throw badRequest(`Unknown disposition "${input.code}"`);
  const related = call.related?.toObject?.() || call.related || {};
  const created = {};
  const errors = {};

  call.disposition = { code: def.code, label: def.label, notes: input.notes, at: new Date(), by: user._id };
  if (input.notes) call.notes = input.notes;
  await call.save();

  if (input.notes) {
    created.note = await Note.create({ organizationId: orgId, body: input.notes, authorId: user._id, related: { ...related, callId: call._id } });
  }
  if (input.createTask) {
    created.task = await Task.create({
      organizationId: orgId, title: input.createTask.title, priority: input.createTask.priority || 'medium',
      dueAt: input.createTask.dueAt ? new Date(input.createTask.dueAt) : new Date(Date.now() + 86400000),
      assigneeId: user._id, related: { ...related, callId: call._id }, source: 'call_wrap_up',
    });
    await logActivity(orgId, { type: 'task_created', title: `Task created: ${created.task.title}`, related, userId: user._id });
  }
  if (input.callback || def.requiresCallback) {
    const cb = input.callback || { scheduledAt: new Date(Date.now() + 86400000).toISOString() };
    created.callback = await Callback.create({
      organizationId: orgId, customerName: await relatedName(orgId, related), phone: call.customerPhone, related, assignedAgentId: user._id,
      scheduledAt: new Date(cb.scheduledAt), notes: cb.notes, priority: cb.priority || 'normal', autoDial: Boolean(cb.autoDial),
      source: 'agent', originCallId: call._id,
    });
  }
  if (input.leadUpdate?.status && related.leadId) {
    created.lead = await Lead.findOneAndUpdate({ _id: related.leadId, organizationId: orgId }, { status: input.leadUpdate.status }, { returnDocument: 'after' });
  }
  if (input.dealUpdate && related.dealId) {
    const deal = await Deal.findOne({ _id: related.dealId, organizationId: orgId });
    if (deal) {
      const before = deal.stage;
      if (input.dealUpdate.stage) deal.stage = input.dealUpdate.stage;
      if (input.dealUpdate.value != null) deal.value = input.dealUpdate.value;
      deal.lastActivityAt = new Date();
      await deal.save();
      created.deal = deal;
      if (before !== deal.stage) {
        await logActivity(orgId, { type: 'stage_changed', title: `Deal moved from ${before} to ${deal.stage}`, related: { dealId: deal._id }, userId: user._id });
      }
    }
  }
  if (input.createTicket) {
    created.ticket = await Ticket.create({
      organizationId: orgId, ...input.createTicket, contactId: related.contactId, accountId: related.accountId, assigneeId: user._id,
    });
    await logActivity(orgId, { type: 'ticket_created', title: `Ticket created: ${created.ticket.subject}`, related: { ...related, ticketId: created.ticket._id }, userId: user._id });
  }
  if (input.sendEmail) {
    try {
      created.email = (await sendMessage(orgId, user, { channel: 'email', ...input.sendEmail, related })).message;
    } catch (err) { errors.email = err.message; }
  }
  if (input.sendWhatsApp) {
    try {
      created.whatsapp = (await sendMessage(orgId, user, { channel: 'whatsapp', to: call.customerPhone, ...input.sendWhatsApp, related })).message;
    } catch (err) { errors.whatsapp = err.message; }
  }
  if (input.addToDnc || def.code === 'wrong_number') {
    if (input.addToDnc) {
      await DncEntry.updateOne({ organizationId: orgId, phone: call.customerPhone }, { $setOnInsert: { reason: `Disposition ${def.label}`, source: 'disposition', addedBy: user._id } }, { upsert: true });
      created.dnc = true;
    }
  }

  await onCampaignDisposition(call, def.code);
  await syncCallActivity(call);
  await rescoreRelated(orgId, related);
  if (input.endWrapUp) {
    const status = await AgentStatus.findOne({ userId: user._id }).lean();
    if (status?.status === 'wrap_up') await setAgentStatus(orgId, user._id, 'available');
  }
  broadcastCall(call);
  return { call, created, errors };
}
