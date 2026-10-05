import { Router } from 'express';
import { z } from 'zod';
import { sendTable } from '../../lib/spreadsheet.js';
import {
  Call, CallParticipant, CallRecording, CallTranscript, Organization, User,
} from '../../models/index.js';
import { hasPermission, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/common.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { phoneVariants } from '../../lib/phone.js';
import { serializeCallForUser } from '../compliance/service.js';
import { getTelephonyProvider, requireTelephonyProvider } from '../telephony/registry.js';
import { CAPABILITIES } from '../telephony/TelephonyProvider.js';
import { getCustomerContext } from '../crm/lookup.js';
import { runCallIntelligence } from '../ai/pipeline.js';
import {
  addParticipant, getCallForControl, hangupCall, holdCall, initiateOutboundCall, logNativeCallOutcome, monitorCall, muteCall,
  sendDtmf, transferCall,
} from './service.js';
import { applyDisposition, dispositionSchema } from './wrapup.js';

const router = Router();

const relatedSchema = z.object({
  contactId: z.string().optional(), leadId: z.string().optional(), accountId: z.string().optional(),
  dealId: z.string().optional(), ticketId: z.string().optional(),
}).default({});

const createCallSchema = z.object({
  to: z.string().min(3),
  mode: z.enum(['webrtc', 'bridge', 'native', 'device']).default('webrtc'),
  name: z.string().max(200).optional(),
  related: relatedSchema,
  callerIdNumberId: z.string().optional(),
  source: z.enum(['manual', 'click_to_call', 'mobile']).default('click_to_call'),
});

async function loadOrg(req) {
  req.org ||= await Organization.findById(req.orgId).lean();
  return req.org;
}

async function ownCallOr(req, permission) {
  const call = await getCallForControl(req.orgId, req.params.id);
  const mine = String(call.agentId) === String(req.user._id);
  if (!mine && !hasPermission(req.user, permission)) throw forbidden();
  return call;
}

function callFilter(req) {
  const q = req.query;
  const filter = { organizationId: req.orgId };
  if (!hasPermission(req.user, 'calls:read_all')) filter.agentId = req.user._id;
  else if (q.agentId) filter.agentId = q.agentId;
  if (q.direction) filter.direction = q.direction;
  if (q.status) filter.status = { $in: String(q.status).split(',') };
  if (q.disposition) filter['disposition.code'] = q.disposition;
  if (q.queueId) filter.queueId = q.queueId;
  if (q.departmentId) filter.departmentId = q.departmentId;
  if (q.campaignId) filter.campaignId = q.campaignId;
  if (q.from || q.to) filter.startedAt = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(q.to) } : {}) };
  if (q.minDuration || q.maxDuration) {
    filter.durationSeconds = { ...(q.minDuration ? { $gte: Number(q.minDuration) } : {}), ...(q.maxDuration ? { $lte: Number(q.maxDuration) } : {}) };
  }
  if (q.phone) filter.customerPhone = { $in: phoneVariants(String(q.phone)) };
  for (const k of ['contactId', 'leadId', 'accountId', 'dealId', 'ticketId']) if (q[k]) filter[`related.${k}`] = q[k];
  return filter;
}

// ---------------------------------------------------------------- telephony info for clients
router.get('/telephony/capabilities', async (req, res) => {
  let provider = null;
  let error = null;
  try {
    provider = await getTelephonyProvider(req.orgId);
  } catch (err) {
    // Misconfigured provider: report it instead of silently looking "not connected".
    error = { code: err.code || 'PROVIDER_ERROR', message: err.message };
  }
  const capabilities = Object.fromEntries(CAPABILITIES.map((c) => [c, Boolean(provider?.supports(c))]));
  res.json({ configured: Boolean(provider), provider: provider?.name || null, capabilities, nativeCalling: true, error });
});

router.get('/telephony/token', requirePermission('calls:make'), async (req, res) => {
  const provider = await requireTelephonyProvider(req.orgId);
  provider.require('webrtc');
  res.json(await provider.createClientToken(`agent_${req.user._id}`));
});

// ---------------------------------------------------------------- calls
router.post('/calls', requirePermission('calls:make'), validate(createCallSchema), async (req, res) => {
  const { to, mode, related, callerIdNumberId, source, name } = req.body;
  const result = await initiateOutboundCall({
    orgId: req.orgId, user: req.user, to, mode, related, callerIdNumberId, source, name,
  });
  await audit(req, 'call.create', { resourceType: 'Call', resourceId: result.call._id, details: { mode } });
  res.status(201).json({ call: serializeCallForUser(result.call, req.user, await loadOrg(req), true), dial: result.dial, sentToDevice: result.sentToDevice });
});

router.get('/calls', async (req, res) => {
  const filter = callFilter(req);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const [items, total, org] = await Promise.all([
    Call.find(filter).sort({ startedAt: -1 }).skip((page - 1) * limit).limit(limit).populate('agentId', 'name'),
    Call.countDocuments(filter),
    loadOrg(req),
  ]);
  const full = hasPermission(req.user, 'numbers:view_full');
  res.json({ items: items.map((c) => serializeCallForUser(c, req.user, org, full)), total, page, limit });
});

router.get('/calls/active', async (req, res) => {
  const filter = { ...callFilter({ ...req, query: {} }), status: { $in: ['initiated', 'ringing', 'queued', 'in_progress', 'on_hold', 'transferring'] } };
  const org = await loadOrg(req);
  const items = await Call.find(filter).sort({ startedAt: -1 }).populate('agentId', 'name');
  res.json({ items: items.map((c) => serializeCallForUser(c, req.user, org, hasPermission(req.user, 'numbers:view_full'))) });
});

router.get('/calls/export', async (req, res) => {
  const filter = callFilter(req);
  const org = await loadOrg(req);
  const calls = await Call.find(filter).sort({ startedAt: -1 }).limit(50000).populate('agentId', 'name').lean();
  const full = hasPermission(req.user, 'numbers:view_full');
  const rows = calls.map((c) => {
    const s = serializeCallForUser({ ...c }, req.user, org, full);
    return {
      Date: new Date(c.startedAt).toISOString(),
      Caller: s.from || '',
      Receiver: s.to || '',
      Direction: c.direction,
      Agent: c.agentId?.name || '',
      'Duration (s)': c.durationSeconds || 0,
      Status: c.status,
      Disposition: c.disposition?.label || '',
      Recording: c.hasRecording ? 'Yes' : 'No',
      Transcript: c.hasTranscript ? 'Yes' : 'No',
    };
  });
  await audit(req, 'calls.export', { details: { count: rows.length, format: req.query.format || 'csv' } });
  const headers = ['Date', 'Caller', 'Receiver', 'Direction', 'Agent', 'Duration (s)', 'Status', 'Disposition', 'Recording', 'Transcript'];
  await sendTable(res, { headers, rows, name: 'calls', format: req.query.format === 'xlsx' ? 'xlsx' : 'csv', sheet: 'Calls' });
});

router.get('/calls/:id', async (req, res) => {
  const call = await ownCallOr(req, 'calls:read_all');
  const [participants, recordings, transcript, org] = await Promise.all([
    CallParticipant.find({ callId: call._id, organizationId: req.orgId }).populate('userId', 'name').lean(),
    CallRecording.find({ callId: call._id, organizationId: req.orgId, deletedAt: null }).lean(),
    hasPermission(req.user, 'transcripts:read') ? CallTranscript.findOne({ callId: call._id, organizationId: req.orgId }).lean() : null,
    loadOrg(req),
  ]);
  const agent = call.agentId ? await User.findById(call.agentId).select('name').lean() : null;
  res.json({
    call: serializeCallForUser(call, req.user, org, hasPermission(req.user, 'numbers:view_full')),
    agent, participants, recordings: recordings.map((r) => ({ id: String(r._id), duration: r.duration, kind: r.kind, createdAt: r.createdAt })),
    transcript,
  });
});

router.get('/calls/:id/context', async (req, res) => {
  const call = await ownCallOr(req, 'calls:read_all');
  const context = await getCustomerContext(req.orgId, { phone: call.customerPhone, contactId: call.related?.contactId, leadId: call.related?.leadId });
  res.json({ ...context, aiEscalation: call.metadata?.aiEscalation || null });
});

router.patch('/calls/:id', async (req, res) => {
  const call = await ownCallOr(req, 'calls:control_all');
  if (typeof req.body.notes === 'string') call.notes = req.body.notes;
  if (req.body.related) call.related = { ...(call.related?.toObject?.() || {}), ...req.body.related };
  await call.save();
  res.json(call);
});

router.post('/calls/:id/hangup', async (req, res) => {
  const call = await ownCallOr(req, 'calls:control_all');
  res.json(await hangupCall(call));
});

router.post('/calls/:id/hold', async (req, res) => {
  const call = await ownCallOr(req, 'calls:control_all');
  res.json(await holdCall(call, true));
});

router.post('/calls/:id/resume', async (req, res) => {
  const call = await ownCallOr(req, 'calls:control_all');
  res.json(await holdCall(call, false));
});

router.post('/calls/:id/mute', validate(z.object({ muted: z.boolean() })), async (req, res) => {
  const call = await ownCallOr(req, 'calls:control_all');
  res.json(await muteCall(call, req.body.muted, req.user._id));
});

const targetSchema = z.object({ userId: z.string().optional(), number: z.string().optional(), queueId: z.string().optional() }).default({});

router.post('/calls/:id/transfer', validate(z.object({
  type: z.enum(['blind', 'warm', 'consult']).default('blind'),
  phase: z.enum(['start', 'complete', 'cancel']).default('start'),
  target: targetSchema,
})), async (req, res) => {
  const call = await ownCallOr(req, 'calls:control_all');
  const result = await transferCall(call, req.body, req.user);
  await audit(req, 'call.transfer', { resourceType: 'Call', resourceId: call._id, details: req.body });
  res.json(result);
});

router.post('/calls/:id/conference', validate(z.object({ target: targetSchema })), async (req, res) => {
  const call = await ownCallOr(req, 'calls:control_all');
  res.json(await addParticipant(call, req.body.target));
});

router.post('/calls/:id/dtmf', validate(z.object({ digits: z.string().min(1).max(32) })), async (req, res) => {
  const call = await ownCallOr(req, 'calls:control_all');
  await sendDtmf(call, req.body.digits);
  res.json({ sent: true });
});

router.post('/calls/:id/disposition', validate(dispositionSchema), async (req, res) => {
  await ownCallOr(req, 'calls:control_all');
  res.json(await applyDisposition(req.orgId, req.user, req.params.id, req.body));
});

router.post('/calls/:id/log', validate(z.object({ durationSeconds: z.number().min(0).max(86400), connected: z.boolean().optional() })), async (req, res) => {
  const call = await ownCallOr(req, 'calls:control_all');
  res.json(await logNativeCallOutcome(call, req.body));
});

router.post('/calls/:id/monitor', requirePermission('supervisor:monitor'), validate(z.object({ mode: z.enum(['listen', 'whisper', 'barge']) })), async (req, res) => {
  const call = await getCallForControl(req.orgId, req.params.id);
  await monitorCall(call, req.user, req.body.mode);
  await audit(req, `supervisor.${req.body.mode}`, { resourceType: 'Call', resourceId: call._id });
  res.json({ monitoring: req.body.mode });
});

router.post('/calls/:id/intelligence', requirePermission('transcripts:read'), async (req, res) => {
  const call = await ownCallOr(req, 'calls:read_all');
  const result = await runCallIntelligence(req.orgId, call._id, { force: true });
  if (result.skipped) throw notFound(`Transcript (${result.skipped})`);
  res.json(result);
});

export default router;
