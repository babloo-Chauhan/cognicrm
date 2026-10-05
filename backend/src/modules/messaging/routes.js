import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import {
  Call, CommunicationConversation, CommunicationMessage, MessageTemplate, Note, Organization,
} from '../../models/index.js';
import { hasPermission, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/common.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { phoneVariants } from '../../lib/phone.js';
import { receiveMessage, sendMessage } from './service.js';

const router = Router();

function conversationAccess(req) {
  return hasPermission(req.user, 'inbox:all') ? { organizationId: req.orgId } : {
    organizationId: req.orgId, $or: [{ assignedTo: req.user._id }, { assignedTo: null }],
  };
}

router.get('/inbox/conversations', async (req, res) => {
  const filter = conversationAccess(req);
  if (req.query.status) filter.status = req.query.status;
  if (req.query.channel) filter.channels = req.query.channel;
  if (req.query.mine) filter.assignedTo = req.user._id;
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$and = [{ $or: [{ 'customer.name': rx }, { 'customer.phone': rx }, { 'customer.email': rx }, { lastMessagePreview: rx }] }];
  }
  res.json({ items: await CommunicationConversation.find(filter).sort({ lastMessageAt: -1 }).limit(100).populate('assignedTo', 'name') });
});

/** Unified conversation view: messages + calls + notes for the customer, newest last. */
router.get('/inbox/conversations/:id', async (req, res) => {
  const conv = await CommunicationConversation.findOne({ _id: req.params.id, ...conversationAccess(req) });
  if (!conv) throw notFound('Conversation');
  const related = conv.related || {};
  const relatedOr = Object.entries(related.toObject?.() || related).filter(([, v]) => v).map(([k, v]) => ({ [`related.${k}`]: v }));
  const callOr = [...relatedOr];
  if (conv.customer?.phone) callOr.push({ customerPhone: { $in: phoneVariants(conv.customer.phone) } });
  const [messages, calls, notes] = await Promise.all([
    CommunicationMessage.find({ organizationId: req.orgId, conversationId: conv._id }).sort({ createdAt: 1 }).limit(500).populate('sentBy', 'name'),
    callOr.length ? Call.find({ organizationId: req.orgId, $or: callOr }).sort({ startedAt: 1 }).limit(100).select('direction status startedAt durationSeconds disposition agentId hasRecording').lean() : [],
    relatedOr.length ? Note.find({ organizationId: req.orgId, $or: relatedOr }).sort({ createdAt: 1 }).limit(100).lean() : [],
  ]);
  if (conv.unreadCount) {
    conv.unreadCount = 0;
    await conv.save();
  }
  const timeline = [
    ...messages.map((m) => ({ kind: 'message', at: m.createdAt, item: m })),
    ...calls.map((c) => ({ kind: 'call', at: c.startedAt, item: { ...c, id: String(c._id) } })),
    ...notes.map((n) => ({ kind: 'note', at: n.createdAt, item: { ...n, id: String(n._id) } })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  res.json({ conversation: conv, timeline });
});

router.patch('/inbox/conversations/:id', async (req, res) => {
  const conv = await CommunicationConversation.findOne({ _id: req.params.id, ...conversationAccess(req) });
  if (!conv) throw notFound('Conversation');
  if (req.body.status) conv.status = req.body.status;
  if (req.body.assignedTo !== undefined) {
    if (req.body.assignedTo && String(req.body.assignedTo) !== String(req.user._id) && !hasPermission(req.user, 'inbox:all')) throw forbidden();
    conv.assignedTo = req.body.assignedTo || null;
  }
  if (req.body.related) conv.related = { ...(conv.related?.toObject?.() || {}), ...req.body.related };
  await conv.save();
  res.json(conv);
});

const sendSchema = z.object({
  channel: z.enum(['sms', 'whatsapp', 'email', 'chat', 'webchat']),
  to: z.string().optional(),
  body: z.string().max(5000).optional(),
  subject: z.string().max(500).optional(),
  templateId: z.string().optional(),
  variables: z.record(z.string(), z.any()).optional(),
  related: z.record(z.string(), z.string()).optional(),
  conversationId: z.string().optional(),
  mediaUrls: z.array(z.string().url()).max(5).optional(),
});

router.post('/messages', requirePermission('messages:send'), validate(sendSchema), async (req, res) => {
  const result = await sendMessage(req.orgId, req.user, req.body);
  res.status(201).json(result);
});

// ---------------------------------------------------------------- templates
const templateSchema = z.object({
  name: z.string().min(1), channel: z.enum(['sms', 'whatsapp', 'email']), language: z.string().optional(), subject: z.string().optional(),
  body: z.string().min(1), providerTemplateName: z.string().optional(),
  approvalStatus: z.enum(['not_required', 'pending', 'approved', 'rejected']).optional(), active: z.boolean().optional(),
});
router.get('/message-templates', async (req, res) => {
  const filter = { organizationId: req.orgId, active: true };
  if (req.query.channel) filter.channel = req.query.channel;
  res.json({ items: await MessageTemplate.find(filter).sort({ name: 1 }) });
});
router.post('/message-templates', requirePermission('templates:manage'), validate(templateSchema), async (req, res) => {
  res.status(201).json(await MessageTemplate.create({ ...req.body, organizationId: req.orgId }));
});
router.patch('/message-templates/:id', requirePermission('templates:manage'), validate(templateSchema.partial()), async (req, res) => {
  const t = await MessageTemplate.findOneAndUpdate({ _id: req.params.id, organizationId: req.orgId }, req.body, { returnDocument: 'after' });
  if (!t) throw notFound('Template');
  res.json(t);
});

export default router;

// ---------------------------------------------------------------- public web chat widget
export const webchatRouter = Router();
const webchatLimiter = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false });

async function orgByKey(key) {
  const org = await Organization.findOne({ publicChatKey: key }).select('_id name').lean();
  if (!org) throw notFound('Chat');
  return org;
}

webchatRouter.post('/webchat/:key/messages', webchatLimiter, validate(z.object({
  visitorId: z.string().min(8).max(64), name: z.string().max(100).optional(), email: z.string().email().optional(), body: z.string().min(1).max(2000),
})), async (req, res) => {
  const org = await orgByKey(req.params.key);
  const { message } = await receiveMessage(org._id, {
    channel: 'webchat', from: req.body.email || req.body.visitorId, visitorId: req.body.visitorId, name: req.body.name, body: req.body.body,
  });
  res.status(201).json({ id: String(message._id) });
});

webchatRouter.get('/webchat/:key/messages', webchatLimiter, async (req, res) => {
  const org = await orgByKey(req.params.key);
  const visitorId = String(req.query.visitorId || '');
  if (visitorId.length < 8) throw notFound('Conversation');
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(0);
  const conv = await CommunicationConversation.findOne({ organizationId: org._id, 'customer.visitorId': visitorId }).lean();
  const messages = conv
    ? await CommunicationMessage.find({ organizationId: org._id, conversationId: conv._id, createdAt: { $gt: since } }).sort({ createdAt: 1 }).limit(100).lean()
    : [];
  const items = messages.map((m) => ({ id: String(m._id), body: m.body, direction: m.direction, at: m.createdAt }));
  res.json({ items, organization: org.name });
});
