import { Router } from 'express';
import { checkLimit } from '../saas/usage.js';
import { z } from 'zod';
import { Readable } from 'node:stream';
import {
  Alert, AuditLog, Call, CallCampaign, CallCampaignContact, CallRecording, DncEntry, Integration, Organization, Voicemail,
} from '../../models/index.js';
import { hasPermission, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/common.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { decryptJson, encryptJson, verifyResourceSignature } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { isValidE164, normalizePhone } from '../../lib/phone.js';
import { signedRecordingUrl, streamRecording } from '../recordings/service.js';
import { callAnalytics, contactCenterSnapshot } from '../analytics/service.js';
import {
  campaignAnalytics, dialContact, importContacts, joinCampaign, previewNext, scheduleContactCallback, setCampaignStatus, skipContact,
} from '../campaigns/service.js';
import { SUPPORTED_TELEPHONY_PROVIDERS } from '../telephony/registry.js';

/** Public (signature-protected) routes — mounted before authentication. */
export const publicRouter = Router();

publicRouter.get('/recordings/:id/stream', async (req, res) => {
  const { expires, sig } = req.query;
  if (!verifyResourceSignature(`recording:${req.params.id}`, expires, sig)) throw forbidden('Link expired or invalid');
  const media = await streamRecording(req.params.id);
  if (!media) throw notFound('Recording');
  res.setHeader('Content-Type', media.headers.get('content-type') || 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, no-store');
  Readable.fromWeb(media.body).pipe(res);
});

const router = Router();

// ---------------------------------------------------------------- recordings & voicemail
router.get('/recordings', async (req, res) => {
  const filter = { organizationId: req.orgId, deletedAt: null };
  if (req.query.kind) filter.kind = req.query.kind;
  const recordings = await CallRecording.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit) || 100, 500))
    .populate({ path: 'callId', select: 'direction customerPhone agentId startedAt durationSeconds disposition', populate: { path: 'agentId', select: 'name' } })
    .lean();
  const canAll = hasPermission(req.user, 'recordings:read');
  const visible = recordings.filter((r) => canAll || (hasPermission(req.user, 'recordings:read_own') && String(r.callId?.agentId?._id) === String(req.user._id)));
  res.json({ items: visible.map((r) => ({ ...r, id: String(r._id) })) });
});

router.get('/recordings/:id/url', async (req, res) => {
  const rec = await CallRecording.findOne({ _id: req.params.id, organizationId: req.orgId, deletedAt: null }).lean();
  if (!rec) throw notFound('Recording');
  const call = await Call.findById(rec.callId).select('agentId').lean();
  const own = String(call?.agentId) === String(req.user._id) && hasPermission(req.user, 'recordings:read_own');
  const vm = rec.kind === 'voicemail' ? await Voicemail.findOne({ organizationId: req.orgId, recordingId: rec._id }).lean() : null;
  const vmRecipient = vm?.assignedUserIds?.map(String).includes(String(req.user._id));
  if (!own && !vmRecipient && !hasPermission(req.user, 'recordings:read')) throw forbidden('You are not allowed to access this recording');
  await audit(req, 'recording.access', { resourceType: 'CallRecording', resourceId: rec._id });
  res.json(signedRecordingUrl(rec._id));
});

router.get('/voicemails', async (req, res) => {
  const filter = { organizationId: req.orgId };
  if (!hasPermission(req.user, 'voicemail:all')) filter.assignedUserIds = req.user._id;
  res.json({ items: await Voicemail.find(filter).sort({ createdAt: -1 }).limit(200) });
});

router.patch('/voicemails/:id', async (req, res) => {
  const vm = await Voicemail.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!vm) throw notFound('Voicemail');
  if (!hasPermission(req.user, 'voicemail:all') && !vm.assignedUserIds.map(String).includes(String(req.user._id))) throw forbidden();
  if (req.body.listened !== undefined) vm.listened = Boolean(req.body.listened);
  await vm.save();
  res.json(vm);
});

// ---------------------------------------------------------------- compliance
router.get('/compliance/dnc', requirePermission('compliance:manage'), async (req, res) => {
  res.json({ items: await DncEntry.find({ organizationId: req.orgId }).sort({ createdAt: -1 }).limit(1000) });
});
router.post('/compliance/dnc', requirePermission('compliance:manage'), validate(z.object({
  phones: z.array(z.string()).min(1).max(10000), reason: z.string().optional(),
})), async (req, res) => {
  const org = await Organization.findById(req.orgId).lean();
  let added = 0;
  const invalid = [];
  for (const p of req.body.phones) {
    const phone = normalizePhone(p, org.settings?.defaultCountryCode);
    if (!isValidE164(phone)) { invalid.push(p); continue; }
    const r = await DncEntry.updateOne(
      { organizationId: req.orgId, phone },
      { $setOnInsert: { reason: req.body.reason, source: req.body.phones.length > 1 ? 'import' : 'manual', addedBy: req.user._id } },
      { upsert: true },
    );
    added += r.upsertedCount;
  }
  await audit(req, 'dnc.add', { details: { added } });
  res.status(201).json({ added, invalid });
});
router.delete('/compliance/dnc/:id', requirePermission('compliance:manage'), async (req, res) => {
  const r = await DncEntry.deleteOne({ _id: req.params.id, organizationId: req.orgId });
  if (!r.deletedCount) throw notFound('DNC entry');
  await audit(req, 'dnc.remove', { resourceId: req.params.id });
  res.status(204).end();
});

router.get('/alerts', requirePermission('alerts:read'), async (req, res) => {
  const filter = { organizationId: req.orgId };
  if (req.query.open) filter.acknowledged = false;
  res.json({ items: await Alert.find(filter).sort({ createdAt: -1 }).limit(200) });
});
router.post('/alerts/:id/ack', requirePermission('alerts:read'), async (req, res) => {
  const a = await Alert.findOneAndUpdate({ _id: req.params.id, organizationId: req.orgId }, { acknowledged: true }, { returnDocument: 'after' });
  if (!a) throw notFound('Alert');
  res.json(a);
});

router.get('/audit-logs', requirePermission('audit:read'), async (req, res) => {
  const filter = { organizationId: req.orgId };
  if (req.query.action) filter.action = req.query.action;
  res.json({ items: await AuditLog.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit) || 200, 1000)).populate('userId', 'name') });
});

// ---------------------------------------------------------------- analytics & supervisor
router.get('/analytics/calls', requirePermission('analytics:read'), async (req, res) => {
  const org = await Organization.findById(req.orgId).select('settings.timezone').lean();
  res.json(await callAnalytics(req.orgId, { ...req.query, timezone: org?.settings?.timezone }));
});

router.get('/analytics/me', async (req, res) => {
  const org = await Organization.findById(req.orgId).select('settings.timezone').lean();
  res.json(await callAnalytics(req.orgId, { ...req.query, agentId: req.user._id, timezone: org?.settings?.timezone }));
});

router.get('/supervisor/dashboard', requirePermission('supervisor:monitor'), async (req, res) => {
  res.json(await contactCenterSnapshot(req.orgId));
});

// ---------------------------------------------------------------- campaigns
const campaignSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  // No zod defaults here: this schema is also used (partially) for PATCH, and defaults would
  // overwrite stored values. Mongoose applies defaults on create.
  mode: z.enum(['preview', 'power', 'predictive']).optional(),
  agentIds: z.array(z.string()).optional(),
  callerIdNumberId: z.string().optional(),
  schedule: z.object({
    timezone: z.string().optional(), days: z.array(z.number().int().min(0).max(6)).optional(),
    start: z.string().regex(/^\d{2}:\d{2}$/).optional(), end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    startDate: z.string().optional(), endDate: z.string().optional(),
  }).optional(),
  retryPolicy: z.object({
    maxAttempts: z.number().int().min(1).max(10).optional(), retryDelayMinutes: z.number().int().min(1).max(10080).optional(),
    retryOn: z.array(z.enum(['no_answer', 'busy', 'failed', 'canceled'])).optional(),
  }).optional(),
  dispositionRules: z.array(z.object({ code: z.string(), action: z.enum(['complete', 'retry', 'dnc', 'callback']) })).optional(),
  predictive: z.object({
    enabled: z.boolean().optional(), complianceAcknowledged: z.boolean().optional(),
    maxAbandonRate: z.number().min(0).max(0.1).optional(), maxDialRatio: z.number().min(1).max(3).optional(),
  }).optional(),
});

router.get('/call-campaigns', async (req, res) => {
  const filter = { organizationId: req.orgId };
  if (!hasPermission(req.user, 'campaigns:manage')) filter.agentIds = req.user._id;
  res.json({ items: await CallCampaign.find(filter).sort({ createdAt: -1 }) });
});
router.post('/call-campaigns', requirePermission('campaigns:manage'), validate(campaignSchema), async (req, res) => {
  await checkLimit(req.orgId, 'automations');
  const campaign = await CallCampaign.create({ ...req.body, organizationId: req.orgId });
  await audit(req, 'campaign.create', { resourceType: 'CallCampaign', resourceId: campaign._id, details: { mode: campaign.mode } });
  res.status(201).json(campaign);
});
router.get('/call-campaigns/:id', async (req, res) => {
  res.json(await campaignAnalytics(req.orgId, req.params.id));
});
router.patch('/call-campaigns/:id', requirePermission('campaigns:manage'), validate(campaignSchema.partial()), async (req, res) => {
  const c = await CallCampaign.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!c) throw notFound('Campaign');
  c.set(req.body);
  await c.save();
  if (req.body.predictive) await audit(req, 'campaign.predictive_settings', { resourceType: 'CallCampaign', resourceId: c._id, details: req.body.predictive });
  res.json(c);
});
router.post('/call-campaigns/:id/contacts', requirePermission('campaigns:manage'), validate(z.object({
  contactIds: z.array(z.string()).optional(), leadIds: z.array(z.string()).optional(),
  rows: z.array(z.object({ name: z.string().optional(), phone: z.string() })).max(50000).optional(),
})), async (req, res) => {
  res.json(await importContacts(req.orgId, req.params.id, req.body));
});
router.get('/call-campaigns/:id/contacts', async (req, res) => {
  const filter = { organizationId: req.orgId, campaignId: req.params.id };
  if (req.query.status) filter.status = req.query.status;
  res.json({ items: await CallCampaignContact.find(filter).sort({ createdAt: 1 }).limit(Math.min(Number(req.query.limit) || 200, 1000)) });
});
for (const action of ['start', 'pause', 'resume', 'complete']) {
  router.post(`/call-campaigns/:id/${action}`, requirePermission('campaigns:manage'), async (req, res) => {
    const c = await setCampaignStatus(req.orgId, req.params.id, action);
    await audit(req, `campaign.${action}`, { resourceType: 'CallCampaign', resourceId: c._id });
    res.json(c);
  });
}
router.post('/call-campaigns/:id/join', async (req, res) => res.json(await joinCampaign(req.orgId, req.params.id, req.user, true)));
router.post('/call-campaigns/:id/leave', async (req, res) => res.json(await joinCampaign(req.orgId, req.params.id, req.user, false)));
router.get('/call-campaigns/:id/next', async (req, res) => res.json(await previewNext(req.orgId, req.params.id, req.user)));
router.post('/call-campaigns/:id/contacts/:contactId/dial', requirePermission('calls:make'), async (req, res) => {
  res.status(201).json(await dialContact(req.orgId, req.params.id, req.params.contactId, req.user, { mode: req.body?.mode || 'webrtc' }));
});
router.post('/call-campaigns/:id/contacts/:contactId/skip', async (req, res) => res.json(await skipContact(req.orgId, req.params.id, req.params.contactId)));
router.post('/call-campaigns/:id/contacts/:contactId/callback', validate(z.object({ scheduledAt: z.string(), notes: z.string().optional() })), async (req, res) => {
  res.json(await scheduleContactCallback(req.orgId, req.params.id, req.params.contactId, req.user, req.body));
});

// ---------------------------------------------------------------- integrations (encrypted credentials)
const INTEGRATION_FIELDS = {
  telephony: { twilio: ['accountSid', 'authToken', 'apiKeySid', 'apiKeySecret', 'twimlAppSid'], exotel: ['accountSid', 'apiKey', 'apiToken', 'subdomain', 'webhookToken'], plivo: ['authId', 'authToken'] },
  sms: { twilio: ['accountSid', 'authToken'] },
  whatsapp: { twilio: ['accountSid', 'authToken'], meta: ['accessToken', 'phoneNumberId', 'appSecret', 'verifyToken'] },
  email: { smtp: ['host', 'port', 'user', 'pass', 'from'] },
  ai: { anthropic: ['apiKey'] },
  transcription: { deepgram: ['apiKey'] },
};

router.get('/integrations', requirePermission('settings:manage'), async (req, res) => {
  const items = await Integration.find({ organizationId: req.orgId }).select('+credentials').lean();
  const readable = (ciphertext) => {
    try { decryptJson(ciphertext); return true; } catch { return false; }
  };
  res.json({
    // `readable: false` means the server encryption key changed: credentials must be re-entered.
    items: items.map((i) => ({ id: String(i._id), kind: i.kind, provider: i.provider, enabled: i.enabled, config: i.config, hasCredentials: true, readable: readable(i.credentials) })),
    publicBaseUrl: env.publicBaseUrl,
    available: INTEGRATION_FIELDS,
    telephonyProviders: SUPPORTED_TELEPHONY_PROVIDERS(),
  });
});

router.put('/integrations/:kind/:provider', requirePermission('settings:manage'), validate(z.object({
  credentials: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  config: z.record(z.string(), z.any()).optional(),
  enabled: z.boolean().default(true),
  makeDefault: z.boolean().default(true),
})), async (req, res) => {
  const { kind, provider } = req.params;
  const fields = INTEGRATION_FIELDS[kind]?.[provider];
  if (!fields) throw badRequest(`Unsupported integration ${kind}/${provider}`);
  const existing = await Integration.findOne({ organizationId: req.orgId, kind, provider }).select('+credentials');
  const update = { enabled: req.body.enabled, config: req.body.config || existing?.config || {} };
  if (req.body.credentials) {
    const creds = Object.fromEntries(Object.entries(req.body.credentials).filter(([k]) => fields.includes(k)));
    update.credentials = encryptJson(creds);
    // Non-secret routing key used to match inbound WhatsApp webhooks to this organization
    if (kind === 'whatsapp' && provider === 'meta' && creds.phoneNumberId) update.config = { ...update.config, phoneNumberId: String(creds.phoneNumberId) };
  } else if (!existing) {
    throw badRequest('credentials are required');
  }
  await Integration.updateOne({ organizationId: req.orgId, kind, provider }, { $set: update }, { upsert: true });
  if (req.body.makeDefault && req.body.enabled) {
    const key = { telephony: 'telephonyProvider', sms: 'smsProvider', whatsapp: 'whatsappProvider', email: 'emailProvider' }[kind];
    if (key) await Organization.updateOne({ _id: req.orgId }, { $set: { [`settings.${key}`]: provider } });
  }
  await audit(req, 'integration.update', { resourceType: 'Integration', details: { kind, provider, enabled: req.body.enabled } });
  res.json({ kind, provider, enabled: req.body.enabled });
});

router.delete('/integrations/:kind/:provider', requirePermission('settings:manage'), async (req, res) => {
  await Integration.deleteOne({ organizationId: req.orgId, kind: req.params.kind, provider: req.params.provider });
  await audit(req, 'integration.delete', { details: req.params });
  res.status(204).end();
});

export default router;
