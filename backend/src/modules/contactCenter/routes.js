import { Router } from 'express';
import { z } from 'zod';
import {
  AgentStatus, BusinessHours, Callback, CallDisposition, CallQueue, CallQueueMember, Department, IVRFlow, IVR_NODE_TYPES,
  Organization, PhoneNumber, QUEUE_STRATEGIES, User,
} from '../../models/index.js';
import { hasPermission, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/common.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { isValidE164, normalizePhone } from '../../lib/phone.js';
import { disconnectUser } from '../../lib/realtime.js';
import { requireTelephonyProvider } from '../telephony/registry.js';
import { setAgentStatus } from '../agents/service.js';
import { evaluateBusinessHours, isWithinWindow } from '../routing/businessHours.js';
import { relatedName } from '../crm/lookup.js';
import { validateFlow } from '../routing/ivrEngine.js';
import { queueStats } from '../analytics/service.js';

const router = Router();
const oidStr = z.string().regex(/^[a-f\d]{24}$/i);

// ---------------------------------------------------------------- phone numbers
const numberSchema = z.object({
  number: z.string().min(5),
  provider: z.string().min(2),
  providerNumberId: z.string().optional(),
  country: z.string().length(2).optional(),
  type: z.enum(['local', 'mobile', 'toll_free', 'national', 'sip']).optional(),
  capabilities: z.object({ voice: z.boolean().optional(), sms: z.boolean().optional(), whatsapp: z.boolean().optional() }).optional(),
  label: z.string().optional(),
  assignedUserId: oidStr.nullable().optional(),
  assignedTeamId: oidStr.nullable().optional(),
  ivrFlowId: oidStr.nullable().optional(),
  queueId: oidStr.nullable().optional(),
  businessHoursId: oidStr.nullable().optional(),
  isDefaultCallerId: z.boolean().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

router.get('/phone-numbers', async (req, res) => {
  res.json({ items: await PhoneNumber.find({ organizationId: req.orgId, status: { $ne: 'released' } }).sort({ createdAt: 1 }) });
});

router.post('/phone-numbers', requirePermission('numbers:manage'), validate(numberSchema), async (req, res) => {
  const number = normalizePhone(req.body.number);
  if (!isValidE164(number)) throw badRequest('Invalid phone number');
  if (await PhoneNumber.exists({ number, status: 'active' })) throw badRequest('This number is already registered');
  if (req.body.isDefaultCallerId) await PhoneNumber.updateMany({ organizationId: req.orgId }, { isDefaultCallerId: false });
  const doc = await PhoneNumber.create({ ...req.body, number, organizationId: req.orgId });
  await audit(req, 'phone_number.create', { resourceType: 'PhoneNumber', resourceId: doc._id });
  res.status(201).json(doc);
});

router.patch('/phone-numbers/:id', requirePermission('numbers:manage'), validate(numberSchema.partial()), async (req, res) => {
  const doc = await PhoneNumber.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!doc) throw notFound('Phone number');
  if (req.body.isDefaultCallerId) await PhoneNumber.updateMany({ organizationId: req.orgId, _id: { $ne: doc._id } }, { isDefaultCallerId: false });
  const { number: _immutable, ...rest } = req.body; // the number itself cannot be changed
  doc.set(rest);
  await doc.save();
  await audit(req, 'phone_number.update', { resourceType: 'PhoneNumber', resourceId: doc._id, details: Object.keys(req.body) });
  res.json(doc);
});

router.get('/phone-numbers/available', requirePermission('numbers:manage'), async (req, res) => {
  const provider = await requireTelephonyProvider(req.orgId);
  provider.require('numberProvisioning');
  res.json({ items: await provider.searchNumbers({ country: req.query.country || 'IN', type: req.query.type || 'Local', contains: req.query.contains }) });
});

router.post('/phone-numbers/provision', requirePermission('numbers:manage'), validate(z.object({ number: z.string(), label: z.string().optional() })), async (req, res) => {
  const provider = await requireTelephonyProvider(req.orgId);
  provider.require('numberProvisioning');
  const created = await provider.createNumber({ number: req.body.number });
  const doc = await PhoneNumber.create({
    organizationId: req.orgId, number: normalizePhone(created.number), provider: provider.name, providerNumberId: created.providerNumberId,
    label: req.body.label, capabilities: { voice: true, sms: true },
  });
  await audit(req, 'phone_number.provision', { resourceType: 'PhoneNumber', resourceId: doc._id });
  res.status(201).json(doc);
});

router.post('/phone-numbers/:id/configure-webhooks', requirePermission('numbers:manage'), async (req, res) => {
  const doc = await PhoneNumber.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!doc) throw notFound('Phone number');
  const provider = await requireTelephonyProvider(req.orgId, doc.provider);
  provider.require('numberProvisioning');
  if (!doc.providerNumberId) throw badRequest('This number has no provider id');
  await provider.configureWebhook(doc.providerNumberId);
  res.json({ configured: true });
});

router.post('/phone-numbers/:id/release', requirePermission('numbers:manage'), async (req, res) => {
  const doc = await PhoneNumber.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!doc) throw notFound('Phone number');
  if (doc.providerNumberId) {
    const provider = await requireTelephonyProvider(req.orgId, doc.provider);
    provider.require('numberProvisioning');
    await provider.releaseNumber(doc.providerNumberId);
  }
  doc.status = 'released';
  await doc.save();
  await audit(req, 'phone_number.release', { resourceType: 'PhoneNumber', resourceId: doc._id });
  res.json(doc);
});

// ---------------------------------------------------------------- departments
router.get('/departments', async (req, res) => {
  res.json({ items: await Department.find({ organizationId: req.orgId }).sort({ name: 1 }) });
});
router.post('/departments', requirePermission('queues:manage'), async (req, res) => {
  res.status(201).json(await Department.create({ ...pickBody(req.body, ['name', 'description', 'defaultQueueId', 'voicemailEnabled', 'memberIds']), organizationId: req.orgId }));
});
router.patch('/departments/:id', requirePermission('queues:manage'), async (req, res) => {
  const doc = await Department.findOneAndUpdate({ _id: req.params.id, organizationId: req.orgId }, pickBody(req.body, ['name', 'description', 'defaultQueueId', 'voicemailEnabled', 'memberIds']), { returnDocument: 'after' });
  if (!doc) throw notFound('Department');
  res.json(doc);
});

function pickBody(body, keys) {
  return Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
}

// ---------------------------------------------------------------- queues
const queueSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  departmentId: oidStr.nullable().optional(),
  strategy: z.enum(QUEUE_STRATEGIES).optional(),
  maxWaitTime: z.number().int().min(10).max(3600).optional(),
  ringTimeout: z.number().int().min(5).max(120).optional(),
  music: z.string().url().optional().or(z.literal('')),
  positionAnnouncement: z.boolean().optional(),
  overflow: z.object({ queueId: oidStr.nullable().optional(), afterSeconds: z.number().optional() }).optional(),
  fallback: z.object({ action: z.enum(['voicemail', 'hangup', 'external', 'callback']), target: z.string().optional() }).optional(),
  agents: z.array(z.object({ userId: oidStr, priority: z.number().int().optional() })).optional(),
  active: z.boolean().optional(),
});

async function setMembers(orgId, queueId, agents) {
  if (!agents) return;
  const valid = await User.find({ organizationId: orgId, _id: { $in: agents.map((a) => a.userId) } }).select('_id').lean();
  const ok = new Set(valid.map((u) => String(u._id)));
  await CallQueueMember.deleteMany({ organizationId: orgId, queueId, userId: { $nin: [...ok] } });
  for (const a of agents.filter((x) => ok.has(String(x.userId)))) {
    await CallQueueMember.updateOne(
      { organizationId: orgId, queueId, userId: a.userId },
      { $set: { priority: a.priority || 0, active: true } },
      { upsert: true },
    );
  }
}

router.get('/call-queues', async (req, res) => {
  const queues = await CallQueue.find({ organizationId: req.orgId }).sort({ name: 1 }).lean();
  const members = await CallQueueMember.find({ organizationId: req.orgId }).populate('userId', 'name').lean();
  const statuses = await AgentStatus.find({ organizationId: req.orgId }).lean();
  const statusMap = new Map(statuses.map((s) => [String(s.userId), s.status]));
  const items = await Promise.all(queues.map(async (q) => {
    const qMembers = members.filter((m) => String(m.queueId) === String(q._id) && m.userId);
    return {
      ...q, id: String(q._id),
      agents: qMembers.map((m) => ({ userId: String(m.userId._id), name: m.userId.name, priority: m.priority, status: statusMap.get(String(m.userId._id)) || 'offline' })),
      agentsAvailable: qMembers.filter((m) => statusMap.get(String(m.userId._id)) === 'available').length,
      stats: await queueStats(req.orgId, q._id),
    };
  }));
  res.json({ items });
});

router.post('/call-queues', requirePermission('queues:manage'), validate(queueSchema), async (req, res) => {
  const { agents, ...data } = req.body;
  const queue = await CallQueue.create({ ...data, organizationId: req.orgId });
  await setMembers(req.orgId, queue._id, agents);
  res.status(201).json(queue);
});

router.patch('/call-queues/:id', requirePermission('queues:manage'), validate(queueSchema.partial()), async (req, res) => {
  const { agents, ...data } = req.body;
  const queue = await CallQueue.findOneAndUpdate({ _id: req.params.id, organizationId: req.orgId }, data, { returnDocument: 'after' });
  if (!queue) throw notFound('Queue');
  await setMembers(req.orgId, queue._id, agents);
  res.json(queue);
});

// ---------------------------------------------------------------- agent status
router.get('/agents/status', async (req, res) => {
  const [users, statuses] = await Promise.all([
    User.find({ organizationId: req.orgId, active: true }).select('name role email').lean(),
    AgentStatus.find({ organizationId: req.orgId }).lean(),
  ]);
  const map = new Map(statuses.map((s) => [String(s.userId), s]));
  const org = await Organization.findById(req.orgId).select('settings.customAgentStatuses').lean();
  res.json({
    items: users.map((u) => ({ userId: String(u._id), name: u.name, role: u.role, ...(map.get(String(u._id)) || { status: 'offline' }) })),
    customStatuses: org?.settings?.customAgentStatuses || [],
  });
});

router.get('/agents/me/status', async (req, res) => {
  const s = await AgentStatus.findOne({ userId: req.user._id }).lean();
  res.json(s || { status: 'offline' });
});

router.put('/agents/me/status', validate(z.object({ status: z.string().min(2) })), async (req, res) => {
  const current = await AgentStatus.findOne({ userId: req.user._id }).lean();
  if (current?.currentCallId && !['on_call', 'wrap_up'].includes(req.body.status) && current.status === 'on_call') {
    throw badRequest('Finish your current call before changing status');
  }
  res.json(await setAgentStatus(req.orgId, req.user._id, req.body.status));
});

router.put('/agents/:userId/status', requirePermission('agents:manage'), validate(z.object({ status: z.string().min(2) })), async (req, res) => {
  const user = await User.findOne({ _id: req.params.userId, organizationId: req.orgId });
  if (!user) throw notFound('Agent');
  const s = await setAgentStatus(req.orgId, user._id, req.body.status);
  await audit(req, 'supervisor.change_status', { resourceType: 'User', resourceId: user._id, details: { status: req.body.status } });
  res.json(s);
});

router.post('/agents/:userId/force-logout', requirePermission('agents:manage'), async (req, res) => {
  const user = await User.findOne({ _id: req.params.userId, organizationId: req.orgId });
  if (!user) throw notFound('Agent');
  if (user.role === 'admin' && req.user.role !== 'admin') throw forbidden('Only admins can log out admins');
  user.tokenVersion += 1;
  await user.save();
  await setAgentStatus(req.orgId, user._id, 'offline');
  disconnectUser(String(user._id));
  await audit(req, 'supervisor.force_logout', { resourceType: 'User', resourceId: user._id });
  res.json({ loggedOut: true });
});

// ---------------------------------------------------------------- business hours
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const bhSchema = z.object({
  name: z.string().min(1),
  timezone: z.string().min(1).refine((tz) => { try { Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Invalid time zone'),
  weekly: z.array(z.object({ day: z.number().int().min(0).max(6), open: hhmm, close: hhmm })).default([]),
  holidays: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().optional() })).default([]),
  specialHours: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), open: hhmm.optional(), close: hhmm.optional(), closed: z.boolean().optional() })).default([]),
});

router.get('/business-hours', async (req, res) => {
  const items = await BusinessHours.find({ organizationId: req.orgId }).lean();
  res.json({ items: items.map((b) => ({ ...b, id: String(b._id), currentStatus: evaluateBusinessHours(b) })) });
});
router.post('/business-hours', requirePermission('business_hours:manage'), validate(bhSchema), async (req, res) => {
  res.status(201).json(await BusinessHours.create({ ...req.body, organizationId: req.orgId }));
});
router.put('/business-hours/:id', requirePermission('business_hours:manage'), validate(bhSchema), async (req, res) => {
  const doc = await BusinessHours.findOneAndUpdate({ _id: req.params.id, organizationId: req.orgId }, req.body, { returnDocument: 'after' });
  if (!doc) throw notFound('Business hours');
  res.json(doc);
});

// ---------------------------------------------------------------- IVR
const ivrSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  defaultLanguage: z.string().default('en'),
  languages: z.array(z.string()).default(['en']),
  translations: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  nodes: z.array(z.object({
    id: z.string().min(1),
    type: z.enum(IVR_NODE_TYPES),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    data: z.record(z.string(), z.any()).default({}),
  })).default([]),
  edges: z.array(z.object({ id: z.string().optional(), source: z.string(), target: z.string(), sourceHandle: z.string().nullable().optional() })).default([]),
  status: z.enum(['draft', 'published']).default('draft'),
});

router.get('/ivr', async (req, res) => {
  res.json({ items: await IVRFlow.find({ organizationId: req.orgId }).sort({ updatedAt: -1 }) });
});
router.get('/ivr/:id', async (req, res) => {
  const flow = await IVRFlow.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!flow) throw notFound('IVR flow');
  res.json(flow);
});

function assertPublishable(body) {
  if (body.status !== 'published') return;
  const problems = validateFlow(body);
  if (problems.length) throw badRequest('IVR flow has problems', problems);
}

router.post('/ivr', requirePermission('ivr:manage'), validate(ivrSchema), async (req, res) => {
  assertPublishable(req.body);
  const edges = req.body.edges.map((e, i) => ({ ...e, id: e.id || `e${i}`, sourceHandle: e.sourceHandle || undefined }));
  res.status(201).json(await IVRFlow.create({ ...req.body, edges, organizationId: req.orgId }));
});
router.put('/ivr/:id', requirePermission('ivr:manage'), validate(ivrSchema), async (req, res) => {
  assertPublishable(req.body);
  const edges = req.body.edges.map((e, i) => ({ ...e, id: e.id || `e${i}`, sourceHandle: e.sourceHandle || undefined }));
  const flow = await IVRFlow.findOneAndUpdate(
    { _id: req.params.id, organizationId: req.orgId },
    { ...req.body, edges, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
  if (!flow) throw notFound('IVR flow');
  await audit(req, 'ivr.update', { resourceType: 'IVRFlow', resourceId: flow._id, details: { status: flow.status } });
  res.json(flow);
});
router.post('/ivr/:id/validate', async (req, res) => {
  const flow = await IVRFlow.findOne({ _id: req.params.id, organizationId: req.orgId }).lean();
  if (!flow) throw notFound('IVR flow');
  res.json({ problems: validateFlow(flow) });
});
router.post('/ivr/:id/simulate', requirePermission('ivr:manage'), async (req, res) => {
  const { runIvr } = await import('../routing/ivrEngine.js');
  const { ivrServices } = await import('../routing/service.js');
  const flow = await IVRFlow.findOne({ _id: req.params.id, organizationId: req.orgId }).lean();
  if (!flow) throw notFound('IVR flow');
  // Same CRM lookups as live calls; outbound webhooks/HTTP are not executed in the simulator.
  const services = { ...ivrServices(req.orgId), httpCall: async () => ({ simulated: true }) };
  const result = await runIvr(flow, req.body.session || {}, {
    input: req.body.input,
    caller: { phone: req.body.callerPhone || '+910000000000' },
    services,
    urls: { gather: () => 'simulator' },
  });
  res.json(result);
});

// ---------------------------------------------------------------- dispositions
router.get('/call-dispositions', async (req, res) => {
  res.json({ items: await CallDisposition.find({ organizationId: req.orgId, ...(req.query.all ? {} : { active: true }) }).sort({ order: 1 }) });
});
router.post('/call-dispositions', requirePermission('dispositions:manage'), validate(z.object({
  code: z.string().regex(/^[a-z0-9_]+$/), label: z.string().min(1), category: z.enum(['connected', 'not_connected', 'outcome']).optional(),
  isConversion: z.boolean().optional(), requiresCallback: z.boolean().optional(),
})), async (req, res) => {
  const order = await CallDisposition.countDocuments({ organizationId: req.orgId });
  res.status(201).json(await CallDisposition.create({ ...req.body, organizationId: req.orgId, order }));
});
router.patch('/call-dispositions/:id', requirePermission('dispositions:manage'), async (req, res) => {
  const doc = await CallDisposition.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!doc) throw notFound('Disposition');
  for (const k of ['label', 'active', 'isConversion', 'requiresCallback', 'order', 'category']) if (req.body[k] !== undefined) doc[k] = req.body[k];
  await doc.save();
  res.json(doc);
});

// ---------------------------------------------------------------- callbacks
const callbackSchema = z.object({
  customerName: z.string().optional(),
  phone: z.string().min(5),
  related: z.record(z.string(), z.string()).optional(),
  assignedAgentId: oidStr.optional(),
  queueId: oidStr.optional(),
  scheduledAt: z.string(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  notes: z.string().optional(),
  autoDial: z.boolean().optional(),
});

router.get('/callbacks', async (req, res) => {
  const filter = { organizationId: req.orgId };
  if (!hasPermission(req.user, 'callbacks:manage') || req.query.mine) filter.assignedAgentId = req.user._id;
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  res.json({ items: await Callback.find(filter).sort({ scheduledAt: 1 }).limit(200).populate('assignedAgentId', 'name') });
});
// A callback time the customer asked for: valid, not in the past (a minute of clock skew is fine).
function callbackTime(value) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw badRequest('Invalid scheduledAt');
  if (at.getTime() < Date.now() - 60000) throw badRequest('The callback time is in the past');
  return at;
}

// Callbacks may be scheduled outside calling hours (the customer chose the time), but the agent is told.
function outsideCallingHours(org, at) {
  const hours = org.settings?.compliance?.callingHours;
  if (!hours?.enabled) return false;
  return !isWithinWindow({ timezone: hours.timezone || org.settings?.timezone || 'UTC', days: hours.days, start: hours.start, end: hours.end }, at);
}

router.post('/callbacks', validate(callbackSchema), async (req, res) => {
  const org = await Organization.findById(req.orgId).lean();
  const phone = normalizePhone(req.body.phone, org.settings?.defaultCountryCode);
  if (!isValidE164(phone)) throw badRequest('Invalid phone number');
  const at = callbackTime(req.body.scheduledAt);
  const assignedAgentId = hasPermission(req.user, 'callbacks:manage') ? (req.body.assignedAgentId || req.user._id) : req.user._id;
  const customerName = req.body.customerName || await relatedName(req.orgId, req.body.related || {});
  const cb = await Callback.create({ ...req.body, customerName, phone, scheduledAt: at, assignedAgentId, organizationId: req.orgId, source: 'agent' });
  res.status(201).json({ ...cb.toJSON(), outsideCallingHours: outsideCallingHours(org, at) });
});
router.patch('/callbacks/:id', async (req, res) => {
  const cb = await Callback.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!cb) throw notFound('Callback');
  if (String(cb.assignedAgentId) !== String(req.user._id) && !hasPermission(req.user, 'callbacks:manage')) throw forbidden();
  for (const k of ['status', 'notes', 'priority', 'autoDial']) if (req.body[k] !== undefined) cb[k] = req.body[k];
  if (req.body.scheduledAt) {
    // Rescheduled: pending again, so the reminder fires at the new time.
    cb.scheduledAt = callbackTime(req.body.scheduledAt);
    cb.status = 'pending';
    cb.notifiedAt = undefined;
  }
  if (req.body.assignedAgentId && hasPermission(req.user, 'callbacks:manage')) cb.assignedAgentId = req.body.assignedAgentId;
  const changed = cb.modifiedPaths().filter((p) => ['status', 'scheduledAt', 'assignedAgentId'].includes(p));
  await cb.save();
  if (changed.length) {
    await audit(req, 'callback.update', { resourceType: 'Callback', resourceId: cb._id, details: Object.fromEntries(changed.map((p) => [p, cb[p]])) });
  }
  const org = await Organization.findById(req.orgId).lean();
  res.json({ ...cb.toJSON(), outsideCallingHours: outsideCallingHours(org, cb.scheduledAt) });
});

export default router;
