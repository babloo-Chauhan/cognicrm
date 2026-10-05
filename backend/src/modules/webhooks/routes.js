import { Router } from 'express';
import express from 'express';
import mongoose from 'mongoose';
import {
  Call, CommunicationMessage, Integration, Organization, PhoneNumber, WebhookEvent,
} from '../../models/index.js';
import { env } from '../../config/env.js';
import { sha256 } from '../../lib/crypto.js';
import { normalizePhone, phoneVariants } from '../../lib/phone.js';
import { safeEqual } from '../../lib/crypto.js';
import { getTelephonyProvider } from '../telephony/registry.js';
import { CALL_EVENTS } from '../telephony/events.js';
import { handleCallEvent } from '../calls/service.js';
import {
  continueIvr, enqueueActions, fallbackActions, findNumberForInbound, handleInboundCall,
} from '../routing/service.js';
import { onRecordingReady, onVoicemailRecorded } from '../recordings/service.js';
import { handleVoiceAgentTurn, voiceAgentAnswered } from '../voiceAgents/runtime.js';
import { getMessagingProvider } from '../messaging/providers.js';
import { receiveMessage, updateMessageStatus } from '../messaging/service.js';

const router = Router();
router.use(express.urlencoded({ extended: false }));

/** Events that only notify us (safe to dedupe). Others are instruction requests that need a response. */
const NOTIFICATION_EVENTS = ['status', 'recording', 'voicemail'];
const MAX_ATTEMPTS = 5;

function fullUrl(req) {
  return new URL(req.originalUrl, env.publicBaseUrl).toString();
}

function idempotencyKey(source, req, params) {
  const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return sha256(`${source}|${req.query.evt || ''}|${req.query.callId || ''}|${req.query.leg || ''}|${sorted}`);
}

/** Finds which organization a telephony webhook belongs to. */
async function resolveTelephonyOrg(req, params) {
  if (req.query.callId && mongoose.isValidObjectId(req.query.callId)) {
    const call = await Call.findById(req.query.callId).select('organizationId').lean();
    if (call) return call.organizationId;
  }
  const providerCallId = params.CallSid || params.CallUUID;
  if (providerCallId) {
    const call = await Call.findOne({ $or: [{ providerCallId }, { 'providerLegs.providerCallId': providerCallId }] }).select('organizationId').lean();
    if (call) return call.organizationId;
  }
  const number = await findNumberForInbound(params.To);
  return number?.organizationId || null;
}

function sendActions(res, provider, actions) {
  const { contentType, body } = provider.renderResponse(actions);
  res.type(contentType).send(body);
}

// ---------------------------------------------------------------- telephony
/** Our own routing params in the webhook URL; everything else in a GET query is provider data. */
const URL_PARAMS = ['evt', 'token', 'callId', 'leg', 'sessionId', 'queueId', 'scope', 'targetId', 'ring'];

// Some providers (e.g. Exotel Passthru applets) call webhooks with GET and send data in the query string.
router.get('/webhooks/telephony/:provider', (req, res) => {
  const params = Object.fromEntries(Object.entries(req.query).filter(([k]) => !URL_PARAMS.includes(k)));
  return handleTelephonyWebhook(req, res, params);
});

router.post('/webhooks/telephony/:provider', (req, res) => handleTelephonyWebhook(req, res, { ...(req.body || {}) }));

async function handleTelephonyWebhook(req, res, params) {
  const providerName = req.params.provider;
  const evt = String(req.query.evt || 'status');
  const source = `telephony:${providerName}`;

  const orgId = await resolveTelephonyOrg(req, params);
  if (!orgId) {
    await WebhookEvent.create({ source, key: idempotencyKey(source, req, params), eventType: evt, payload: params, status: 'ignored', lastError: 'Unknown organization' }).catch(() => null);
    return res.status(404).json({ error: 'unknown destination' });
  }
  const provider = await getTelephonyProvider(orgId, providerName);
  if (!provider) return res.status(404).json({ error: 'provider not configured' });

  const valid = provider.validateWebhook({ url: fullUrl(req), params, headers: req.headers, query: req.query });
  if (!valid) {
    await WebhookEvent.create({ organizationId: orgId, source, key: `invalid:${Date.now()}:${Math.random()}`, eventType: evt, status: 'ignored', lastError: 'Invalid signature' }).catch(() => null);
    return res.status(403).json({ error: 'invalid signature' });
  }

  const key = idempotencyKey(source, req, params);
  const isNotification = NOTIFICATION_EVENTS.includes(evt);
  let logged = await WebhookEvent.findOne({ key });
  if (logged && isNotification && ['processed', 'ignored'].includes(logged.status)) {
    return sendActions(res, provider, []); // duplicate delivery: acknowledge only
  }
  if (!logged) {
    logged = await WebhookEvent.create({ organizationId: orgId, source, key, eventType: evt, payload: { query: req.query, params } })
      .catch(async (err) => (err.code === 11000 ? WebhookEvent.findOne({ key }) : Promise.reject(err)));
  }

  try {
    const actions = await processTelephonyEvent({ orgId, provider, evt, req, params });
    logged.status = 'processed';
    logged.attempts += 1;
    await logged.save();
    return sendActions(res, provider, actions || []);
  } catch (err) {
    logged.status = 'failed';
    logged.attempts += 1;
    logged.lastError = err.message;
    logged.nextRetryAt = logged.attempts < MAX_ATTEMPTS ? new Date(Date.now() + 2 ** logged.attempts * 30000) : null;
    await logged.save();
    console.error('telephony webhook failed', evt, err);
    // Instruction requests must still return valid markup so the caller is not left in silence.
    if (!isNotification) {
      try { return sendActions(res, provider, [{ type: 'say', text: 'Sorry, we are experiencing technical difficulties. Please try again later.' }, { type: 'hangup' }]); } catch { /* fall through */ }
    }
    return res.status(500).json({ error: 'processing failed' });
  }
}

/** Processes one telephony webhook. Exported for the retry job. */
export async function processTelephonyEvent({ orgId, provider, evt, req, params }) {
  const parsed = provider.parseWebhook({ query: req.query, params });
  const events = Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
  const first = events[0] || {};
  const call = req.query.callId && mongoose.isValidObjectId(req.query.callId)
    ? await Call.findOne({ _id: req.query.callId, organizationId: orgId })
    : null;

  switch (evt) {
    case 'status':
    case 'passthru': {
      if (evt === 'passthru' || (!call && first.direction === 'inbound')) {
        const number = await findNumberForInbound(first.to);
        if (number && !(await Call.exists({ organizationId: orgId, providerCallId: first.providerCallId }))) {
          await handleInboundCall({ number, provider, evt: first });
        }
      }
      for (const e of events) {
        if (e.type === CALL_EVENTS.CALL_RECORDING_READY) {
          const target = call || await Call.findOne({ organizationId: orgId, providerCallId: e.providerCallId });
          if (target) await onRecordingReady(target, e.recording);
        } else {
          await handleCallEvent(orgId, e);
        }
      }
      return [];
    }
    case 'voice': {
      // New inbound call on one of our numbers
      const number = await findNumberForInbound(params.To || first.to);
      if (!number || String(number.organizationId) !== String(orgId)) return [{ type: 'reject' }];
      const { actions } = await handleInboundCall({ number, provider, evt: first });
      return actions;
    }
    case 'client': {
      // Browser softphone joined via the provider SDK (TwiML App)
      const target = params.callId && mongoose.isValidObjectId(params.callId) ? await Call.findOne({ _id: params.callId, organizationId: orgId }) : null;
      if (!target) return [{ type: 'hangup' }];
      return [{ type: 'conference', name: target.conferenceName, startOnEnter: true, endOnExit: false }];
    }
    case 'answer': {
      // Plivo leg answered: put the leg into the call's conference
      if (!call) return [{ type: 'hangup' }];
      await handleCallEvent(orgId, { ...first, type: CALL_EVENTS.CALL_ANSWERED });
      const fresh = await Call.findById(call._id);
      const isCustomer = req.query.leg === 'customer';
      const { consentText } = await import('../calls/service.js');
      const org = await Organization.findById(orgId).lean();
      const consent = isCustomer ? consentText(org) : null;
      return [
        ...(consent ? [{ type: 'say', text: consent }] : []),
        { type: 'conference', name: fresh.conferenceName, startOnEnter: true, endOnExit: isCustomer, record: isCustomer && fresh.recordingEnabled },
      ];
    }
    case 'ivr': {
      if (!call) return [{ type: 'hangup' }];
      return continueIvr(call, provider, { sessionId: req.query.sessionId, input: first.digits ?? first.speech ?? '' });
    }
    case 'enqueue': {
      if (!call) return [{ type: 'hangup' }];
      const org = await Organization.findById(orgId).lean();
      return enqueueActions(call, org, provider, req.query.queueId);
    }
    case 'fallback': {
      if (!call) return [{ type: 'hangup' }];
      const actions = await fallbackActions(call, provider);
      await call.save();
      return actions;
    }
    case 'voicemail-done': {
      // <Record> finished: the caller left a message
      if (call && Number(params.RecordingDuration || 0) > 0 && (params.RecordingUrl || params.RecordUrl)) {
        const vm = call.metadata?.voicemail || {};
        await onVoicemailRecorded(call, {
          recordingId: params.RecordingSid || params.RecordingID, url: params.RecordingUrl || params.RecordUrl, duration: Number(params.RecordingDuration || 0),
        }, { scope: vm.scope, targetId: vm.targetId });
      }
      return [{ type: 'say', text: 'Thank you. Goodbye.' }, { type: 'hangup' }];
    }
    case 'voicemail': {
      if (call && first.recording?.recordingId) {
        await onVoicemailRecorded(call, first.recording, { scope: req.query.scope, targetId: req.query.targetId });
      }
      return [];
    }
    case 'recording': {
      if (call && first.recording) await onRecordingReady(call, first.recording);
      return [];
    }
    case 'voice-agent': {
      if (!call) return [{ type: 'hangup' }];
      return handleVoiceAgentTurn(call, provider, { sessionId: req.query.sessionId, speech: first.speech });
    }
    case 'voice-agent-start': {
      if (!call) return [{ type: 'hangup' }];
      return voiceAgentAnswered(call, provider);
    }
    case 'campaign-answer': {
      // Predictive dialer: customer answered — connect to a free campaign agent or abandon politely.
      if (!call) return [{ type: 'hangup' }];
      const { CallCampaign } = await import('../../models/index.js');
      const { getAvailableAgents } = await import('../agents/service.js');
      const campaign = await CallCampaign.findById(call.campaignId).lean();
      const free = campaign ? await getAvailableAgents(orgId, campaign.agentIds) : [];
      if (!free.length) {
        call.metadata = { ...(call.metadata || {}), abandoned: true };
        call.markModified('metadata');
        await call.save();
        return [{ type: 'say', text: 'Sorry, all our agents are busy. We will call you back.' }, { type: 'hangup' }];
      }
      call.direction = 'outbound';
      call.metadata = { ...(call.metadata || {}), targetUserIds: campaign.agentIds.map(String) };
      call.markModified('metadata');
      call.status = 'queued';
      call.enqueuedAt = new Date();
      await call.save();
      const { emitEvent } = await import('../../lib/eventBus.js');
      emitEvent('QUEUE_DISPATCH', { orgId: String(orgId), callId: String(call._id) });
      return [{ type: 'conference', name: call.conferenceName, startOnEnter: false, endOnExit: true }];
    }
    case 'dial': {
      // <Dial> to an external number finished
      if (call && ['completed', 'answered'].includes(String(first.dialStatus || '').toLowerCase())) {
        call.answeredAt = call.answeredAt || new Date();
        await call.save();
      }
      return [{ type: 'hangup' }];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------- messaging (SMS / WhatsApp)
router.get('/webhooks/messaging/meta', async (req, res) => {
  // Meta webhook verification handshake
  const mode = req.query['hub.mode'];
  const token = String(req.query['hub.verify_token'] || '');
  if (mode !== 'subscribe' || !token) return res.status(403).end();
  let ok = Boolean(env.metaWhatsApp.verifyToken) && safeEqual(token, env.metaWhatsApp.verifyToken);
  if (!ok) {
    const { loadIntegration } = await import('../telephony/registry.js');
    const candidates = await Integration.find({ kind: 'whatsapp', provider: 'meta', enabled: true }).select('organizationId').lean();
    for (const c of candidates) {
      const integ = await loadIntegration(c.organizationId, 'whatsapp', 'meta');
      if (integ?.credentials?.verifyToken && safeEqual(token, integ.credentials.verifyToken)) { ok = true; break; }
    }
  }
  return ok ? res.type('text/plain').send(String(req.query['hub.challenge'] || '')) : res.status(403).end();
});

async function resolveMessagingOrg(providerName, params, body) {
  if (providerName === 'meta') {
    const value = body?.entry?.[0]?.changes?.[0]?.value || {};
    const phoneNumberId = value.metadata?.phone_number_id;
    if (phoneNumberId) {
      const integ = await Integration.findOne({ kind: 'whatsapp', provider: 'meta', 'config.phoneNumberId': String(phoneNumberId) }).lean();
      if (integ) return { orgId: integ.organizationId, channel: 'whatsapp' };
    }
    const display = value.metadata?.display_phone_number;
    const number = display ? await PhoneNumber.findOne({ number: { $in: phoneVariants(normalizePhone(display)) }, status: 'active' }).lean() : null;
    return number ? { orgId: number.organizationId, channel: 'whatsapp' } : null;
  }
  const channel = String(params.From || params.To || '').startsWith('whatsapp:') ? 'whatsapp' : 'sms';
  if (params.MessageSid && params.MessageStatus && params.MessageStatus !== 'received') {
    const msg = await CommunicationMessage.findOne({ providerMessageId: params.MessageSid }).select('organizationId').lean();
    if (msg) return { orgId: msg.organizationId, channel };
  }
  const to = String(params.To || '').replace(/^whatsapp:/, '');
  const number = await findNumberForInbound(to);
  return number ? { orgId: number.organizationId, channel } : null;
}

router.post('/webhooks/messaging/:provider', async (req, res) => {
  const providerName = req.params.provider;
  const params = { ...(req.body || {}) };
  const source = `messaging:${providerName}`;
  const resolved = await resolveMessagingOrg(providerName, params, req.body);
  if (!resolved) return res.status(404).json({ error: 'unknown destination' });
  const org = await Organization.findById(resolved.orgId).lean();
  const provider = await getMessagingProvider(org, resolved.channel);
  if (!provider || provider.name !== providerName) return res.status(404).json({ error: 'provider not configured' });
  if (!provider.validateWebhook({ url: fullUrl(req), params, headers: req.headers, rawBody: req.rawBody })) {
    return res.status(403).json({ error: 'invalid signature' });
  }
  const key = sha256(`${source}|${req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(params)}`);
  let logged = await WebhookEvent.findOne({ key });
  if (logged?.status === 'processed') return res.status(200).type('text/xml').send('<Response/>');
  logged ||= await WebhookEvent.create({ organizationId: org._id, source, key, eventType: 'message', payload: req.body });
  try {
    await processMessagingEvent(org._id, provider, { params, body: req.body });
    logged.status = 'processed';
    logged.attempts += 1;
    await logged.save();
    return res.status(200).type('text/xml').send('<Response/>');
  } catch (err) {
    logged.status = 'failed';
    logged.attempts += 1;
    logged.lastError = err.message;
    logged.nextRetryAt = logged.attempts < MAX_ATTEMPTS ? new Date(Date.now() + 2 ** logged.attempts * 30000) : null;
    await logged.save();
    console.error('messaging webhook failed', err);
    return res.status(500).json({ error: 'processing failed' });
  }
});

export async function processMessagingEvent(orgId, provider, { params, body }) {
  for (const e of provider.parseWebhook({ params, body })) {
    if (e.kind === 'inbound') await receiveMessage(orgId, { ...e, provider: provider.name });
    else if (e.kind === 'status') await updateMessageStatus(orgId, e);
  }
}

/** Retries failed webhook processing (exponential backoff). */
export async function retryFailedWebhooks(now = new Date()) {
  const due = await WebhookEvent.find({ status: 'failed', nextRetryAt: { $lte: now }, attempts: { $lt: MAX_ATTEMPTS } }).limit(50);
  for (const ev of due) {
    try {
      const [kind, providerName] = ev.source.split(':');
      if (kind === 'telephony') {
        const provider = await getTelephonyProvider(ev.organizationId, providerName);
        if (!provider) throw new Error('provider not configured');
        const { query, params } = ev.payload || {};
        // Only notification events are replayed: instruction requests are tied to a live call.
        if (!NOTIFICATION_EVENTS.includes(query?.evt || 'status')) { ev.status = 'ignored'; await ev.save(); continue; }
        await processTelephonyEvent({ orgId: ev.organizationId, provider, evt: query?.evt || 'status', req: { query: query || {} }, params: params || {} });
      } else if (kind === 'messaging') {
        const org = await Organization.findById(ev.organizationId).lean();
        const channel = providerName === 'meta' ? 'whatsapp' : 'sms';
        const provider = await getMessagingProvider(org, channel);
        if (!provider) throw new Error('provider not configured');
        await processMessagingEvent(ev.organizationId, provider, { params: ev.payload || {}, body: ev.payload });
      }
      ev.status = 'processed';
    } catch (err) {
      ev.lastError = err.message;
      ev.nextRetryAt = ev.attempts + 1 < MAX_ATTEMPTS ? new Date(now.getTime() + 2 ** (ev.attempts + 1) * 30000) : null;
    }
    ev.attempts += 1;
    await ev.save();
  }
  return due.length;
}

export default router;
