import mongoose from 'mongoose';
import {
  Call, CallParticipant, Callback, Organization, PhoneNumber, PushToken, TERMINAL_STATUSES, User,
} from '../../models/index.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { isValidE164, normalizePhone } from '../../lib/phone.js';
import { emitToOrg, emitToUser } from '../../lib/realtime.js';
import { emitEvent } from '../../lib/eventBus.js';
import { requireTelephonyProvider, getTelephonyProvider } from '../telephony/registry.js';
import { CALL_EVENTS, PUBLIC_EVENT_NAMES } from '../telephony/events.js';
import { translate } from '../telephony/tts.js';
import { assertCanCall } from '../compliance/service.js';
import { assertWithinCallLimits, inspectCompletedCall } from '../compliance/fraud.js';
import { markOnCall, releaseAgent, startWrapUp } from '../agents/service.js';
import { findCustomerByPhone } from '../crm/lookup.js';
import { upsertRefActivity } from '../timeline/service.js';
import { notify, notifyMany } from '../notifications/service.js';
import { rescoreRelated } from '../ai/insights.js';

export const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

export function broadcastCall(call) {
  const json = call.toJSON ? call.toJSON() : call;
  emitToOrg(String(call.organizationId), 'call:update', json);
  if (call.agentId) emitToUser(String(call.agentId), 'call:update', json);
}

function pushEvent(call, type, data) {
  call.events.push({ type, at: new Date(), data });
  emitEvent(type, { orgId: String(call.organizationId), callId: String(call._id), call, data });
  if (PUBLIC_EVENT_NAMES[type]) emitEvent(PUBLIC_EVENT_NAMES[type], { orgId: String(call.organizationId), callId: String(call._id) });
}

/** Keeps the call's entry on the unified timeline of every linked CRM record up to date. */
export async function syncCallActivity(call) {
  const agent = call.agentId ? await User.findById(call.agentId).select('name').lean() : null;
  return upsertRefActivity(call.organizationId, 'Call', call._id, {
    type: 'call',
    title: `${call.direction === 'inbound' ? 'Inbound' : 'Outbound'} call`,
    occurredAt: call.startedAt,
    userId: call.agentId,
    related: call.related || {},
    data: {
      direction: call.direction,
      status: call.status,
      durationSeconds: call.durationSeconds,
      agentName: agent?.name,
      disposition: call.disposition?.label,
      hasRecording: call.hasRecording,
      hasTranscript: call.hasTranscript,
      customerPhone: call.customerPhone,
    },
  });
}

export async function resolveCallerId(org, user, callerIdNumberId) {
  const filter = { organizationId: org._id, status: 'active', 'capabilities.voice': true };
  let number = null;
  if (callerIdNumberId) number = await PhoneNumber.findOne({ ...filter, _id: callerIdNumberId });
  if (!number && user) number = await PhoneNumber.findOne({ ...filter, assignedUserId: user._id });
  if (!number) number = await PhoneNumber.findOne({ ...filter, isDefaultCallerId: true });
  if (!number) number = await PhoneNumber.findOne(filter);
  return number;
}

export function consentText(org, language) {
  const rec = org.settings?.recording || {};
  if (!rec.enabled || rec.consentMode === 'disabled') return null;
  return translate(rec.consentMessage, language || org.settings?.defaultLanguage || 'en', 'en');
}

/**
 * Starts an outbound call.
 *  - mode "webrtc": rings the agent's browser softphone (provider WebRTC SDK), then the customer
 *  - mode "bridge": rings the agent's own phone, then the customer
 *  - mode "native": mobile app uses the phone's native dialer; the CRM only logs the call
 *  - mode "device": started on the web, placed from the agent's phone: the CRM logs a native call and
 *    pushes a dial request to the agent's mobile app, which opens the phone's dialer
 */
export async function initiateOutboundCall({
  orgId, user, to, mode = 'webrtc', related = {}, callerIdNumberId, campaignId, campaignContactId, callbackId,
  source = 'manual', skipCompliance = false, name,
}) {
  const org = await Organization.findById(orgId).lean();
  const customerNumber = normalizePhone(to, org.settings?.defaultCountryCode);
  if (!isValidE164(customerNumber)) throw badRequest(`"${to}" is not a valid phone number`);

  if (!skipCompliance) await assertCanCall(org, { phone: customerNumber, related });
  await assertWithinCallLimits(org, { userId: user?._id, phone: customerNumber });

  const finalRelated = { ...related };
  if (!finalRelated.contactId && !finalRelated.leadId) {
    const match = await findCustomerByPhone(orgId, customerNumber);
    if (match.contact) finalRelated.contactId = match.contact._id;
    else if (match.lead) finalRelated.leadId = match.lead._id;
    if (match.contact?.accountId) finalRelated.accountId = match.contact.accountId;
  }

  const base = {
    organizationId: orgId, direction: 'outbound', to: customerNumber, customerPhone: customerNumber,
    agentId: user?._id, related: finalRelated, campaignId, campaignContactId, callbackId, source,
  };

  if (mode === 'native' || mode === 'device') {
    if (mode === 'device' && !(await PushToken.countDocuments({ organizationId: orgId, userId: user._id }))) {
      throw badRequest('No phone is linked to your account. Open the COGNIEOS mobile app, sign in and enable notifications.');
    }
    const call = await Call.create({ ...base, mode: 'native', status: 'initiated', from: user?.phone });
    pushEvent(call, CALL_EVENTS.CALL_INITIATED);
    await call.save();
    await syncCallActivity(call);
    broadcastCall(call);
    if (mode === 'device') {
      await notify(orgId, user._id, {
        type: 'dial_request', title: `📞 Call ${name || customerNumber}`, body: 'Tap to place this call from your phone.',
        data: { callId: String(call._id), phone: customerNumber, name: name || undefined },
      });
      return { call, sentToDevice: true };
    }
    return { call, dial: `tel:${customerNumber}` };
  }

  const provider = await requireTelephonyProvider(orgId);
  provider.require('outboundCall');
  let effectiveMode = mode;
  if (mode === 'webrtc' && !provider.supports('webrtc')) effectiveMode = 'bridge';
  const agentTarget = effectiveMode === 'webrtc' ? provider.clientTarget(user._id) : normalizePhone(user?.phone, org.settings?.defaultCountryCode);
  if (!agentTarget) throw new AppError(422, 'Add your phone number to your profile to place bridge calls', 'AGENT_PHONE_REQUIRED');

  const callerNumber = await resolveCallerId(org, user, callerIdNumberId);
  if (!callerNumber) throw new AppError(422, 'No active voice phone number is available as caller ID', 'CALLER_ID_REQUIRED');

  const call = new Call({
    ...base,
    mode: effectiveMode,
    from: callerNumber.number,
    phoneNumberId: callerNumber._id,
    provider: provider.name,
    recordingEnabled: Boolean(org.settings?.recording?.enabled),
    status: 'initiated',
  });
  call.conferenceName = `call-${call._id}`;
  await call.save();

  try {
    const result = await provider.makeCall({
      call,
      agentTarget,
      customerNumber,
      callerId: callerNumber.number,
      record: call.recordingEnabled,
      consentText: consentText(org),
    });
    call.providerCallId = result.providerCallId;
    call.providerLegs = (result.legs || []).map((l) => ({ ...l, userId: l.role === 'agent' ? user._id : undefined }));
    if (result.bridgedByProvider) call.metadata = { ...(call.metadata || {}), bridgedByProvider: true };
  } catch (err) {
    call.status = 'failed';
    call.failureReason = err.message;
    call.endedAt = new Date();
    pushEvent(call, CALL_EVENTS.CALL_FAILED, { reason: err.message });
    await call.save();
    await syncCallActivity(call);
    broadcastCall(call);
    throw err;
  }
  pushEvent(call, CALL_EVENTS.CALL_INITIATED);
  await call.save();
  await CallParticipant.insertMany([
    { organizationId: orgId, callId: call._id, role: 'agent', userId: user._id, providerCallId: call.providerCallId, status: 'invited' },
    { organizationId: orgId, callId: call._id, role: 'customer', phone: customerNumber, status: 'invited' },
  ]);
  await markOnCall(orgId, user._id, call._id);
  await syncCallActivity(call);
  broadcastCall(call);
  return { call };
}

function legOf(call, providerCallId) {
  return (call.providerLegs || []).find((l) => l.providerCallId === providerCallId);
}

export async function findCallForEvent(evt, orgId) {
  if (evt.callId && mongoose.isValidObjectId(evt.callId)) {
    const call = await Call.findOne({ _id: evt.callId, ...(orgId ? { organizationId: orgId } : {}) });
    if (call) return call;
  }
  if (!evt.providerCallId) return null;
  return Call.findOne({
    ...(orgId ? { organizationId: orgId } : {}),
    $or: [{ providerCallId: evt.providerCallId }, { 'providerLegs.providerCallId': evt.providerCallId }],
  });
}

/**
 * Applies a normalized provider event to the call state machine.
 * Idempotent: replaying the same event does not change the outcome.
 */
export async function handleCallEvent(orgId, evt) {
  const call = await findCallForEvent(evt, orgId);
  if (!call) return null;
  if (!evt.type) return call;

  // Providers like Plivo report a request id first and the real call id later.
  if (evt.leg && evt.providerCallId) {
    const leg = (call.providerLegs || []).find((l) => l.role === evt.leg && (l.providerCallId === evt.requestId || !l.providerCallId));
    if (leg && leg.providerCallId !== evt.providerCallId) {
      leg.providerCallId = evt.providerCallId;
      if (call.providerCallId === evt.requestId) call.providerCallId = evt.providerCallId;
      call.markModified('providerLegs');
    }
  }

  const leg = evt.leg || legOf(call, evt.providerCallId)?.role
    || (call.direction === 'inbound' && evt.providerCallId === call.providerCallId ? 'inbound' : 'customer');
  const provider = call.provider ? await getTelephonyProvider(call.organizationId, call.provider) : null;

  if (leg === 'agent') await onAgentLegEvent(call, evt, provider);
  else if (['customer', 'inbound'].includes(leg)) await onCustomerLegEvent(call, evt, provider);
  else await onParticipantLegEvent(call, evt, leg);

  if (call.isModified()) await call.save();
  return call;
}

async function onAgentLegEvent(call, evt, provider) {
  const agentLeg = legOf(call, evt.providerCallId) || (call.providerLegs || []).find((l) => l.role === 'agent');
  const legUserId = agentLeg?.userId || call.agentId;

  if (evt.type === CALL_EVENTS.CALL_RINGING) {
    if (call.direction === 'outbound' && call.status === 'initiated') call.status = 'initiated';
    return;
  }

  if (evt.type === CALL_EVENTS.CALL_ANSWERED) {
    await CallParticipant.updateOne({ callId: call._id, role: 'agent', userId: legUserId }, { status: 'joined', joinedAt: new Date(), providerCallId: evt.providerCallId });
    if (call.direction === 'outbound') {
      const hasCustomer = (call.providerLegs || []).some((l) => l.role === 'customer');
      if (!hasCustomer && !call.metadata?.bridgedByProvider && provider) {
        const org = await Organization.findById(call.organizationId).lean();
        const leg = await provider.dialCustomer({
          call, customerNumber: call.customerPhone, callerId: call.from, record: call.recordingEnabled,
          consentText: consentText(org),
        });
        call.providerLegs.push(leg);
        call.markModified('providerLegs');
        call.status = 'ringing';
        call.ringingAt = new Date();
        broadcastCall(call);
      }
      return;
    }
    // Inbound: first agent to answer wins (ring-all may have rung several agents).
    if (!call.answeredAt && !isTerminal(call.status)) {
      call.agentId = legUserId;
      call.status = 'in_progress';
      call.answeredAt = new Date();
      if (call.enqueuedAt) call.waitSeconds = Math.round((call.answeredAt - call.enqueuedAt) / 1000);
      pushEvent(call, CALL_EVENTS.CALL_ANSWERED, { agentId: legUserId });
      await markOnCall(call.organizationId, legUserId, call._id);
      for (const other of call.providerLegs.filter((l) => l.role === 'agent' && l.providerCallId !== evt.providerCallId)) {
        await provider?.hangup(other.providerCallId).catch(() => null);
        if (other.userId) await releaseAgent(call.organizationId, other.userId);
      }
      await syncCallActivity(call);
      broadcastCall(call);
    }
    return;
  }

  // Agent leg ended or failed
  await CallParticipant.updateOne({ callId: call._id, role: 'agent', userId: legUserId }, { status: 'left', leftAt: new Date() });
  if (isTerminal(call.status)) return;

  if (call.direction === 'outbound') {
    if (!call.answeredAt) {
      // Agent hung up / never answered before the customer picked up.
      const customerLeg = (call.providerLegs || []).find((l) => l.role === 'customer');
      if (customerLeg) await provider?.hangup(customerLeg.providerCallId).catch(() => null);
      await finalizeCall(call, { finalStatus: evt.finalStatus === 'completed' ? 'canceled' : evt.finalStatus || 'canceled' });
    } else if (call.status !== 'transferring' && String(legUserId) === String(call.agentId)) {
      const customerLeg = (call.providerLegs || []).find((l) => l.role === 'customer');
      if (customerLeg) await provider?.hangup(customerLeg.providerCallId).catch(() => null);
    }
    return;
  }

  // Inbound
  if (!call.answeredAt) {
    // This agent did not pick up: try another one.
    if (legUserId) {
      call.triedAgentIds.push(legUserId);
      await releaseAgent(call.organizationId, legUserId);
    }
    call.providerLegs = call.providerLegs.filter((l) => l.providerCallId !== evt.providerCallId);
    call.markModified('providerLegs');
    await call.save();
    emitEvent('QUEUE_REDISPATCH', { orgId: String(call.organizationId), callId: String(call._id) });
  } else if (call.status !== 'transferring' && String(legUserId) === String(call.agentId)) {
    await provider?.hangup(call.providerCallId).catch(() => null);
  }
}

async function onCustomerLegEvent(call, evt, provider) {
  if (evt.type === CALL_EVENTS.CALL_INITIATED) return;
  if (evt.type === CALL_EVENTS.CALL_RINGING) {
    if (['initiated'].includes(call.status)) {
      call.status = 'ringing';
      call.ringingAt = new Date();
      pushEvent(call, CALL_EVENTS.CALL_RINGING);
      broadcastCall(call);
    }
    return;
  }
  if (evt.type === CALL_EVENTS.CALL_ANSWERED) {
    if (call.direction === 'outbound' && !call.answeredAt) {
      call.status = 'in_progress';
      call.answeredAt = new Date();
      pushEvent(call, CALL_EVENTS.CALL_ANSWERED);
      await CallParticipant.updateOne({ callId: call._id, role: 'customer' }, { status: 'joined', joinedAt: new Date(), providerCallId: evt.providerCallId });
      await syncCallActivity(call);
      broadcastCall(call);
    }
    return;
  }
  // Completed / failed
  await CallParticipant.updateOne({ callId: call._id, role: 'customer' }, { status: 'left', leftAt: new Date() });
  if (call.metadata?.bridgedByProvider && evt.finalStatus === 'completed' && !call.answeredAt && evt.durationSeconds > 0) {
    // Exotel reports a single terminal event for bridged calls
    call.answeredAt = new Date(Date.now() - evt.durationSeconds * 1000);
  }
  // Hang up any agent legs still ringing
  for (const l of (call.providerLegs || []).filter((x) => x.role !== 'customer' && x.providerCallId !== call.providerCallId)) {
    if (!call.answeredAt || call.direction === 'inbound') await provider?.hangup(l.providerCallId).catch(() => null);
  }
  await finalizeCall(call, { finalStatus: evt.finalStatus, durationSeconds: evt.durationSeconds });
}

async function onParticipantLegEvent(call, evt, role) {
  const update = {};
  if (evt.type === CALL_EVENTS.CALL_ANSWERED) Object.assign(update, { status: 'joined', joinedAt: new Date() });
  else if ([CALL_EVENTS.CALL_COMPLETED, CALL_EVENTS.CALL_FAILED].includes(evt.type)) Object.assign(update, { status: 'left', leftAt: new Date() });
  if (Object.keys(update).length) {
    await CallParticipant.updateOne({ callId: call._id, providerCallId: evt.providerCallId }, update);
  }
  if (role === 'transfer' && evt.type === CALL_EVENTS.CALL_ANSWERED) {
    const p = await CallParticipant.findOne({ callId: call._id, providerCallId: evt.providerCallId }).lean();
    if (p?.userId) {
      const previous = call.agentId;
      call.agentId = p.userId;
      call.status = 'in_progress';
      pushEvent(call, CALL_EVENTS.CALL_TRANSFERRED, { from: previous, to: p.userId });
      await markOnCall(call.organizationId, p.userId, call._id);
    }
  }
  broadcastCall(call);
}

/** Moves a call to its terminal state and runs all post-call work. Idempotent. */
export async function finalizeCall(call, { finalStatus, durationSeconds } = {}) {
  if (isTerminal(call.status)) return call;
  const org = await Organization.findById(call.organizationId).lean();
  const now = new Date();
  call.endedAt = now;

  let status;
  if (call.metadata?.voicemailLeft) status = 'voicemail';
  else if (call.answeredAt) status = 'completed';
  else if (call.direction === 'inbound') status = call.enqueuedAt ? 'abandoned' : (call.ivrSessionId ? 'completed' : 'no_answer');
  else status = finalStatus && finalStatus !== 'completed' ? finalStatus : 'no_answer';
  call.status = status;
  // Prefer the provider-reported talk time; fall back to our own clock.
  call.durationSeconds = call.answeredAt
    ? (durationSeconds > 0 ? durationSeconds : Math.max(Math.round((now - call.answeredAt) / 1000), 0))
    : 0;
  if (call.enqueuedAt && !call.answeredAt) call.waitSeconds = Math.round((now - call.enqueuedAt) / 1000);

  pushEvent(call, status === 'completed' || status === 'voicemail' ? CALL_EVENTS.CALL_COMPLETED : CALL_EVENTS.CALL_FAILED, { status });
  await call.save();

  if (call.agentId) {
    if (call.answeredAt) await startWrapUp(call.organizationId, call.agentId, org.settings?.wrapUpSeconds ?? 30);
    else await releaseAgent(call.organizationId, call.agentId);
  }
  if (call.callbackId) {
    await Callback.updateOne({ _id: call.callbackId }, { status: call.answeredAt ? 'completed' : 'pending', callId: call._id });
  }
  if (call.direction === 'inbound' && !call.answeredAt && status !== 'completed') {
    await notifyMissedCall(call);
  }
  emitEvent('CALL_FINALIZED', { orgId: String(call.organizationId), callId: String(call._id), call });
  await syncCallActivity(call);
  await inspectCompletedCall(org, call).catch(() => null);
  await rescoreRelated(call.organizationId, call.related || {});
  broadcastCall(call);
  return call;
}

async function notifyMissedCall(call) {
  const recipients = new Set();
  if (call.agentId) recipients.add(String(call.agentId));
  if (call.phoneNumberId) {
    const number = await PhoneNumber.findById(call.phoneNumberId).lean();
    if (number?.assignedUserId) recipients.add(String(number.assignedUserId));
  }
  for (const id of call.triedAgentIds || []) recipients.add(String(id));
  await notifyMany(call.organizationId, [...recipients], {
    type: 'missed_call',
    title: 'Missed call',
    body: `Missed call from ${call.from}`,
    data: { callId: String(call._id), phone: call.from },
  });
}

// ---------------------------------------------------------------- call controls
export async function getCallForControl(orgId, callId) {
  const call = await Call.findOne({ _id: callId, organizationId: orgId });
  if (!call) throw notFound('Call');
  return call;
}

function requireActive(call) {
  if (isTerminal(call.status)) throw new AppError(409, 'Call has already ended', 'CALL_ENDED');
}

function customerLegId(call) {
  if (call.direction === 'inbound') return call.providerCallId;
  return (call.providerLegs || []).find((l) => l.role === 'customer')?.providerCallId;
}

function agentLegId(call, userId = call.agentId) {
  return (call.providerLegs || []).filter((l) => l.role === 'agent' && (!userId || String(l.userId) === String(userId))).pop()?.providerCallId
    || (call.direction === 'outbound' ? call.providerCallId : undefined);
}

export async function hangupCall(call) {
  if (isTerminal(call.status)) return call;
  // A native call cancelled before it was logged as connected is recorded as canceled, not "no answer".
  if (call.mode === 'native') return finalizeCall(call, { finalStatus: call.answeredAt ? 'completed' : 'canceled' });
  const provider = await requireTelephonyProvider(call.organizationId, call.provider);
  const legs = new Set([customerLegId(call), ...call.providerLegs.map((l) => l.providerCallId)].filter(Boolean));
  for (const id of legs) await provider.hangup(id).catch(() => null);
  return finalizeCall(call, { finalStatus: call.answeredAt ? 'completed' : 'canceled' });
}

export async function holdCall(call, hold = true) {
  requireActive(call);
  const provider = await requireTelephonyProvider(call.organizationId, call.provider);
  provider.require('hold');
  const participantCallId = customerLegId(call);
  if (hold) await provider.hold({ call, participantCallId });
  else await provider.resume({ call, participantCallId });
  call.status = hold ? 'on_hold' : 'in_progress';
  pushEvent(call, hold ? CALL_EVENTS.CALL_HOLD : CALL_EVENTS.CALL_RESUMED);
  await call.save();
  await CallParticipant.updateOne({ callId: call._id, role: 'customer' }, { onHold: hold });
  broadcastCall(call);
  return call;
}

export async function muteCall(call, muted, userId) {
  requireActive(call);
  const provider = await requireTelephonyProvider(call.organizationId, call.provider);
  provider.require('mute');
  await provider.mute({ call, participantCallId: agentLegId(call, userId), muted });
  call.muted = Boolean(muted);
  await call.save();
  broadcastCall(call);
  return call;
}

/** Resolves a transfer/conference target: agent (userId), queue (queueId) or external number. */
export async function resolveTarget(orgId, provider, { userId, number, queueId }) {
  if (userId) {
    const u = await User.findOne({ _id: userId, organizationId: orgId }).lean();
    if (!u) throw notFound('Target agent');
    return { to: provider.supports('webrtc') ? provider.clientTarget(u._id) : u.phone, userId: u._id };
  }
  if (queueId) return { queueId };
  if (number) {
    const n = normalizePhone(number);
    if (!isValidE164(n)) throw badRequest('Invalid transfer number');
    return { to: n };
  }
  throw badRequest('A transfer target (userId, queueId or number) is required');
}

export async function transferCall(call, { type = 'blind', phase = 'start', target = {} }, actingUser) {
  requireActive(call);
  const provider = await requireTelephonyProvider(call.organizationId, call.provider);
  provider.require(type === 'blind' ? 'transferBlind' : 'transferWarm');
  const { telephonyWebhookUrl } = await import('../telephony/urls.js');
  const resolved = phase === 'start' ? await resolveTarget(call.organizationId, provider, target) : {};
  const customerCallId = customerLegId(call);
  const agentCallId = agentLegId(call, actingUser?._id);
  const consult = (call.metadata?.consult) || {};

  if (resolved.queueId) {
    // Blind transfer to a queue: move the customer into queue routing.
    await provider.transfer({
      call, type: 'blind', customerCallId, agentCallId,
      redirectUrl: telephonyWebhookUrl(provider.name, 'enqueue', { callId: call._id, queueId: resolved.queueId }),
    });
    const previous = call.agentId;
    if (previous) await releaseAgent(call.organizationId, previous);
    call.agentId = null;
    call.answeredAt = null;
    call.status = 'queued';
    call.direction = call.direction || 'inbound';
    pushEvent(call, CALL_EVENTS.CALL_TRANSFERRED, { type, queueId: resolved.queueId, from: previous });
    await call.save();
    broadcastCall(call);
    return call;
  }

  const result = await provider.transfer({
    call, type, phase, target: resolved.to, callerId: call.from, customerCallId, agentCallId,
    consultCallId: consult.providerCallId,
  });

  if (result?.leg) {
    call.providerLegs.push(result.leg);
    call.markModified('providerLegs');
    await CallParticipant.create({
      organizationId: call.organizationId, callId: call._id, role: resolved.userId ? 'agent' : 'external',
      userId: resolved.userId, phone: resolved.userId ? undefined : resolved.to, providerCallId: result.leg.providerCallId,
    });
  }

  if (type === 'blind') {
    call.status = 'transferring';
    const previous = call.agentId;
    if (previous) await releaseAgent(call.organizationId, previous);
    if (resolved.userId) call.agentId = resolved.userId;
    pushEvent(call, CALL_EVENTS.CALL_TRANSFERRED, { type, from: previous, to: resolved.userId || resolved.to });
  } else if (phase === 'start') {
    call.status = type === 'consult' ? 'on_hold' : 'transferring';
    call.metadata = { ...(call.metadata || {}), consult: { type, providerCallId: result?.leg?.providerCallId, userId: resolved.userId, to: resolved.to } };
  } else if (phase === 'complete') {
    const previous = call.agentId;
    if (previous) await startWrapUp(call.organizationId, previous, 0);
    call.agentId = consult.userId || null;
    call.status = 'in_progress';
    if (consult.userId) await markOnCall(call.organizationId, consult.userId, call._id);
    call.metadata = { ...(call.metadata || {}), consult: null };
    pushEvent(call, CALL_EVENTS.CALL_TRANSFERRED, { type, from: previous, to: consult.userId || consult.to });
  } else if (phase === 'cancel') {
    call.status = 'in_progress';
    call.metadata = { ...(call.metadata || {}), consult: null };
  }
  call.markModified('metadata');
  await call.save();
  broadcastCall(call);
  return call;
}

export async function addParticipant(call, target) {
  requireActive(call);
  const provider = await requireTelephonyProvider(call.organizationId, call.provider);
  provider.require('conference');
  const resolved = await resolveTarget(call.organizationId, provider, target);
  if (!resolved.to) throw badRequest('Conference target must be an agent or a phone number');
  const leg = await provider.conference({ call, to: resolved.to, callerId: call.from });
  call.providerLegs.push(leg);
  call.markModified('providerLegs');
  await call.save();
  await CallParticipant.create({
    organizationId: call.organizationId, callId: call._id, role: resolved.userId ? 'agent' : 'external',
    userId: resolved.userId, phone: resolved.userId ? undefined : resolved.to, providerCallId: leg.providerCallId,
  });
  broadcastCall(call);
  return call;
}

export async function sendDtmf(call, digits) {
  requireActive(call);
  if (!/^[0-9*#wW]+$/.test(String(digits || ''))) throw badRequest('Digits may only contain 0-9, *, # and w');
  const provider = await requireTelephonyProvider(call.organizationId, call.provider);
  provider.require('dtmf');
  await provider.sendDTMF({ call, customerCallId: customerLegId(call), digits });
  return call;
}

export async function monitorCall(call, supervisor, mode) {
  requireActive(call);
  const provider = await requireTelephonyProvider(call.organizationId, call.provider);
  const capability = { listen: 'monitorListen', whisper: 'monitorWhisper', barge: 'monitorBarge' }[mode];
  if (!capability) throw badRequest('mode must be listen, whisper or barge');
  provider.require(capability);
  const supervisorTarget = provider.supports('webrtc') ? provider.clientTarget(supervisor._id) : normalizePhone(supervisor.phone);
  if (!supervisorTarget) throw new AppError(422, 'Supervisor needs a softphone or phone number', 'AGENT_PHONE_REQUIRED');
  const leg = await provider.monitor({ call, mode, supervisorTarget, agentCallId: agentLegId(call), callerId: call.from });
  call.providerLegs.push(leg);
  call.markModified('providerLegs');
  await call.save();
  await CallParticipant.create({
    organizationId: call.organizationId, callId: call._id, role: 'supervisor', userId: supervisor._id,
    providerCallId: leg.providerCallId, monitorMode: mode, coaching: mode === 'whisper', muted: mode === 'listen',
  });
  return call;
}

/** Mobile/native calls: the app reports what happened on the phone's own dialer. */
export async function logNativeCallOutcome(call, { durationSeconds = 0, connected }) {
  if (call.mode !== 'native') throw badRequest('Only native calls can be logged manually');
  if (isTerminal(call.status)) return call;
  if (connected || durationSeconds > 0) {
    call.answeredAt = new Date(Date.now() - durationSeconds * 1000);
  }
  await finalizeCall(call, { finalStatus: connected || durationSeconds > 0 ? 'completed' : 'no_answer' });
  if (call.answeredAt) {
    call.durationSeconds = Math.round(durationSeconds);
    await call.save();
    await syncCallActivity(call);
  }
  return call;
}
