import {
  Account, BusinessHours, Call, Callback, CallQueue, CallQueueMember, Contact, Department, IVRFlow, IVRSession,
  Order, Organization, PhoneNumber, User,
} from '../../models/index.js';
import { normalizePhone, phoneVariants } from '../../lib/phone.js';
import { httpRequest } from '../../lib/http.js';
import { AppError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/eventBus.js';
import { emitToUser } from '../../lib/realtime.js';
import { evaluateBusinessHours } from './businessHours.js';
import { runIvr } from './ivrEngine.js';
import { selectAgents } from './queueStrategies.js';
import { speak, translate } from '../telephony/tts.js';
import { telephonyWebhookUrl } from '../telephony/urls.js';
import { getTelephonyProvider } from '../telephony/registry.js';
import { CALL_EVENTS } from '../telephony/events.js';
import { findCustomerByPhone, getCustomerContext } from '../crm/lookup.js';
import { getAvailableAgents, markOnCall, releaseAgent } from '../agents/service.js';
import { broadcastCall, consentText, syncCallActivity } from '../calls/service.js';
import { notify } from '../notifications/service.js';

const DEFAULT_MESSAGES = {
  closed: {
    en: 'Thank you for calling. Our office is currently closed. Please leave a message after the beep.',
    hi: 'Call karne ke liye dhanyavaad. Hamara office abhi band hai. Kripya beep ke baad sandesh chhodein.',
  },
  holiday: {
    en: 'Thank you for calling. We are closed today for a holiday. Please leave a message after the beep.',
    hi: 'Aaj chhutti ke kaaran office band hai. Kripya beep ke baad sandesh chhodein.',
  },
  voicemail: { en: 'Please leave a message after the beep.', hi: 'Kripya beep ke baad apna sandesh chhodein.' },
  queuePosition: { en: 'You are number {{position}} in the queue.', hi: 'Queue mein aapka number {{position}} hai.' },
  callbackConfirmed: {
    en: 'Thank you. We have scheduled a callback and will call you back shortly.',
    hi: 'Dhanyavaad. Hum aapko jald hi call back karenge.',
  },
  unavailable: { en: 'Sorry, no one is available to take your call. Goodbye.', hi: 'Maaf kijiye, abhi koi uplabdh nahi hai.' },
};

async function say(org, key, language, vars = {}) {
  const lang = language || org.settings?.defaultLanguage || 'en';
  const custom = org.settings?.messages?.[key];
  const text = translate(custom || DEFAULT_MESSAGES[key], lang, 'en').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  return speak(text, lang);
}

/** Finds the PhoneNumber (and therefore organization) a call was made to. */
export async function findNumberForInbound(to) {
  if (!to) return null;
  const variants = phoneVariants(normalizePhone(to) || to);
  return PhoneNumber.findOne({ number: { $in: variants }, status: 'active' });
}

/** Builds the IVR runtime services: CRM lookups and safe outbound HTTP. */
export function ivrServices(orgId) {
  return {
    businessHoursStatus: async (id) => {
      const bh = id ? await BusinessHours.findOne({ _id: id, organizationId: orgId }).lean() : null;
      return evaluateBusinessHours(bh);
    },
    lookupCustomer: async ({ phone, customerId }) => {
      if (customerId) {
        const contact = await Contact.findOne({ organizationId: orgId, customerId: String(customerId) }).lean();
        const account = contact ? null : await Account.findOne({ organizationId: orgId, customerId: String(customerId) }).lean();
        const rec = contact || account;
        return rec
          ? { found: true, customer: { id: String(rec._id), name: contact ? `${contact.firstName} ${contact.lastName || ''}`.trim() : account.name, firstName: contact?.firstName || account?.name, company: contact?.company || account?.name } }
          : { found: false };
      }
      const match = await findCustomerByPhone(orgId, phone);
      const rec = match.contact || match.lead;
      return rec
        ? { found: true, customer: { id: String(rec._id), name: match.contact ? `${rec.firstName} ${rec.lastName || ''}`.trim() : rec.name, firstName: rec.firstName || rec.name?.split(' ')[0], company: rec.company } }
        : { found: false };
    },
    lookupOrder: async (orderNumber) => {
      if (!orderNumber) return null;
      const o = await Order.findOne({ organizationId: orgId, orderNumber: String(orderNumber) }).lean();
      return o && { orderNumber: o.orderNumber, status: o.status, paymentStatus: o.paymentStatus, expectedDelivery: o.expectedDelivery?.toDateString() };
    },
    httpCall: async ({ url, method, body }) => {
      const u = new URL(url);
      // Only public HTTPS endpoints — prevents IVR flows from probing internal services.
      if (u.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[::1\])/.test(u.hostname)) {
        throw new AppError(400, 'IVR HTTP requests must use a public https URL');
      }
      return httpRequest(url, { method, json: body, timeoutMs: 5000 });
    },
  };
}

// ---------------------------------------------------------------- inbound entry point
/**
 * Handles a new inbound call: Incoming Number → Business Hours → IVR → Department → Queue → Agent
 * → Fallback → Voicemail. Returns provider-neutral actions.
 */
export async function handleInboundCall({ number, provider, evt }) {
  const org = await Organization.findById(number.organizationId).lean();
  const orgId = org._id;
  const existing = await Call.findOne({ organizationId: orgId, providerCallId: evt.providerCallId });
  if (existing) return { call: existing, actions: await resumeActions(existing, org) };

  const caller = normalizePhone(evt.from, org.settings?.defaultCountryCode) || evt.from;
  const match = await findCustomerByPhone(orgId, caller);
  const call = new Call({
    organizationId: orgId,
    direction: 'inbound',
    status: 'ringing',
    mode: 'webrtc',
    from: caller,
    to: number.number,
    customerPhone: caller,
    provider: provider.name,
    providerCallId: evt.providerCallId,
    phoneNumberId: number._id,
    ringingAt: new Date(),
    source: 'inbound',
    recordingEnabled: Boolean(org.settings?.recording?.enabled),
    related: {
      contactId: match.contact?._id, leadId: match.contact ? undefined : match.lead?._id, accountId: match.account?._id,
    },
    events: [{ type: CALL_EVENTS.CALL_INITIATED, at: new Date() }, { type: CALL_EVENTS.CALL_RINGING, at: new Date() }],
  });
  call.conferenceName = `call-${call._id}`;
  await call.save();
  emitEvent(CALL_EVENTS.CALL_INITIATED, { orgId: String(orgId), callId: String(call._id), call });
  await syncCallActivity(call);
  broadcastCall(call);

  const actions = [];
  const consent = org.settings?.recording?.consentMode === 'always' || call.recordingEnabled ? consentText(org) : null;
  if (consent && org.settings?.recording?.consentMode !== 'disabled') actions.push(await speak(consent, org.settings?.defaultLanguage || 'en'));

  // Voice AI agent attached to this number takes the call first
  const { VoiceAgent } = await import('../../models/index.js');
  const agent = await VoiceAgent.findOne({ organizationId: orgId, status: 'active', phoneNumberIds: number._id }).lean();
  if (agent && provider.supports('speechGather')) {
    const { startVoiceAgentCall } = await import('../voiceAgents/runtime.js');
    actions.push(...(await startVoiceAgentCall({ org, call, agent, provider })));
    return { call, actions };
  }

  if (number.businessHoursId) {
    const bh = await BusinessHours.findOne({ _id: number.businessHoursId, organizationId: orgId }).lean();
    const status = evaluateBusinessHours(bh);
    call.metadata = { ...(call.metadata || {}), businessHours: status };
    if (status !== 'open' && !number.ivrFlowId) {
      actions.push(await say(org, status === 'holiday' ? 'holiday' : 'closed'));
      actions.push(...(await voicemailActions(call, provider, { scope: number.assignedUserId ? 'personal' : 'ivr', targetId: number.assignedUserId, prompt: false })));
      await call.save();
      return { call, actions };
    }
  }

  if (number.ivrFlowId) {
    actions.push(...(await startIvr(call, org, provider, number.ivrFlowId)));
  } else if (number.queueId) {
    actions.push(...(await enqueueActions(call, org, provider, number.queueId)));
  } else if (number.assignedUserId) {
    actions.push(...(await directAgentActions(call, org, provider, number.assignedUserId)));
  } else {
    actions.push(...(await voicemailActions(call, provider, { scope: 'ivr' })));
  }
  await call.save();
  return { call, actions };
}

async function resumeActions(call, org) {
  // Provider retried the initial request: keep the caller in its waiting room.
  if (call.status === 'queued') {
    return [{ type: 'conference', name: call.conferenceName, startOnEnter: false, endOnExit: true }];
  }
  return [await say(org, 'unavailable'), { type: 'hangup' }];
}

// ---------------------------------------------------------------- IVR
export async function startIvr(call, org, provider, flowId) {
  const flow = await IVRFlow.findOne({ _id: flowId, organizationId: org._id }).lean();
  if (!flow || flow.status !== 'published') {
    return voicemailActions(call, provider, { scope: 'ivr' });
  }
  const session = await IVRSession.create({
    organizationId: org._id, flowId: flow._id, callId: call._id, language: flow.defaultLanguage,
  });
  call.ivrSessionId = session._id;
  return stepIvr(call, org, provider, flow, session, undefined);
}

export async function continueIvr(call, provider, { sessionId, input }) {
  const org = await Organization.findById(call.organizationId).lean();
  const session = await IVRSession.findOne({ _id: sessionId, organizationId: org._id, callId: call._id });
  if (!session || session.status !== 'active') return [await say(org, 'unavailable'), { type: 'hangup' }];
  const flow = await IVRFlow.findOne({ _id: session.flowId, organizationId: org._id }).lean();
  const actions = await stepIvr(call, org, provider, flow, session, input ?? '');
  await call.save();
  return actions;
}

async function stepIvr(call, org, provider, flow, session, input) {
  const result = await runIvr(flow, session.toObject(), {
    input,
    caller: { phone: call.from, name: '' },
    services: ivrServices(org._id),
    urls: { gather: () => telephonyWebhookUrl(provider.name, 'ivr', { callId: call._id, sessionId: session._id }) },
  });
  session.set({
    currentNodeId: result.session.currentNodeId,
    language: result.session.language,
    variables: result.session.variables,
    retries: result.session.retries,
    path: result.session.path.slice(-200),
    status: result.session.status || 'active',
  });
  session.markModified('variables');
  await session.save();
  const actions = [...result.actions];
  if (result.outcome) actions.push(...(await applyOutcome(call, org, provider, result.outcome, result.session.language)));
  return actions;
}

async function applyOutcome(call, org, provider, outcome, language) {
  switch (outcome.type) {
    case 'queue':
      return enqueueActions(call, org, provider, outcome.queueId, language);
    case 'department': {
      const dept = await Department.findOne({ _id: outcome.departmentId, organizationId: org._id }).lean();
      call.departmentId = dept?._id;
      if (dept?.defaultQueueId) return enqueueActions(call, org, provider, dept.defaultQueueId, language);
      if (dept?.memberIds?.length) return directAgentActions(call, org, provider, dept.memberIds, language);
      return voicemailActions(call, provider, { scope: 'department', targetId: dept?._id, language });
    }
    case 'agent':
      return directAgentActions(call, org, provider, outcome.userId, language);
    case 'transfer': {
      const to = normalizePhone(outcome.number, org.settings?.defaultCountryCode);
      call.metadata = { ...(call.metadata || {}), externalTransfer: to };
      call.markModified('metadata');
      return [{ type: 'dial', targets: [to], callerId: call.to, timeout: 30, record: call.recordingEnabled }];
    }
    case 'voicemail':
      return voicemailActions(call, provider, { scope: outcome.scope, targetId: outcome.targetId, maxLength: outcome.maxLength, language });
    case 'callback': {
      await createCallbackRequest(call, org, { queueId: outcome.queueId, source: 'ivr' });
      return [await say(org, 'callbackConfirmed', language), { type: 'hangup' }];
    }
    case 'hangup':
    default:
      return [{ type: 'hangup' }];
  }
}

export async function createCallbackRequest(call, org, { queueId, source = 'ivr', scheduledAt } = {}) {
  const cb = await Callback.create({
    organizationId: org._id,
    phone: call.from,
    related: call.related,
    queueId,
    scheduledAt: scheduledAt || new Date(),
    priority: 'high',
    source,
    originCallId: call._id,
    notes: 'Callback requested by caller',
  });
  emitEvent('CALLBACK_CREATED', { orgId: String(org._id), callbackId: String(cb._id) });
  return cb;
}

// ---------------------------------------------------------------- queues
export async function enqueueActions(call, org, provider, queueId, language) {
  const queue = await CallQueue.findOne({ _id: queueId, organizationId: org._id, active: true }).lean();
  if (!queue) return voicemailActions(call, provider, { scope: 'ivr', language });
  call.status = 'queued';
  call.queueId = queue._id;
  if (queue.departmentId) call.departmentId = queue.departmentId;
  call.enqueuedAt = call.enqueuedAt || new Date();
  call.metadata = { ...(call.metadata || {}), targetUserIds: undefined };
  call.markModified('metadata');
  await call.save();

  const actions = [];
  if (queue.positionAnnouncement) {
    const ahead = await Call.countDocuments({
      organizationId: org._id, queueId: queue._id, status: 'queued', enqueuedAt: { $lt: call.enqueuedAt },
    });
    actions.push(await say(org, 'queuePosition', language, { position: ahead + 1 }));
  }
  actions.push(waitingRoom(call, provider, queue.music));
  broadcastCall(call);
  emitEvent('QUEUE_DISPATCH', { orgId: String(org._id), callId: String(call._id) });
  return actions;
}

function waitingRoom(call, provider, music) {
  return {
    type: 'conference',
    name: call.conferenceName,
    startOnEnter: false,
    endOnExit: true,
    waitUrl: music || undefined,
    record: call.recordingEnabled,
    recordingCallbackUrl: call.recordingEnabled ? telephonyWebhookUrl(provider.name, 'recording', { callId: call._id }) : undefined,
  };
}

/** Direct agent / department ring without a queue: same waiting room, explicit target list. */
async function directAgentActions(call, org, provider, userIds, language) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String);
  call.status = 'queued';
  call.enqueuedAt = call.enqueuedAt || new Date();
  call.metadata = { ...(call.metadata || {}), targetUserIds: ids, directLanguage: language };
  call.markModified('metadata');
  await call.save();
  broadcastCall(call);
  emitEvent('QUEUE_DISPATCH', { orgId: String(org._id), callId: String(call._id) });
  return [waitingRoom(call, provider)];
}

/**
 * Rings the next agent(s) for a waiting call, using the queue strategy.
 * Called when a call is queued, when an agent becomes available and periodically by the job runner.
 */
export async function dispatchCall(callId) {
  // Atomic lock: concurrent triggers (agent available, redispatch, job tick) must not double-ring.
  const call = await Call.findOneAndUpdate(
    {
      _id: callId, status: 'queued', answeredAt: null,
      $or: [{ dispatchLockedAt: null }, { dispatchLockedAt: { $lt: new Date(Date.now() - 30000) } }],
    },
    { $set: { dispatchLockedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!call) return null;
  try {
    return await dispatchLocked(call);
  } finally {
    await Call.updateOne({ _id: callId }, { $set: { dispatchLockedAt: null } });
  }
}

/** Periodic safety net: dispatches waiting calls that have no agent ringing. */
export async function dispatchWaitingCalls() {
  const waiting = await Call.find({ status: 'queued', answeredAt: null, 'providerLegs.role': { $ne: 'agent' } }).select('_id').lean();
  for (const c of waiting) await dispatchCall(c._id);
  return waiting.length;
}

async function dispatchLocked(call) {
  const orgId = call.organizationId;
  const provider = await getTelephonyProvider(orgId, call.provider);
  if (!provider) return null;

  const ringing = (call.providerLegs || []).filter((l) => l.role === 'agent');
  let candidates;
  let queue = null;
  if (call.queueId) {
    queue = await CallQueue.findById(call.queueId);
    const members = await CallQueueMember.find({ organizationId: orgId, queueId: call.queueId, active: true }).lean();
    candidates = members.map((m) => ({ userId: m.userId, priority: m.priority }));
  } else {
    candidates = (call.metadata?.targetUserIds || []).map((id) => ({ userId: id, priority: 0 }));
  }
  const exclude = [...(call.triedAgentIds || []), ...ringing.map((l) => l.userId).filter(Boolean)];
  const available = await getAvailableAgents(orgId, candidates.map((c) => c.userId), exclude);
  const priorityMap = new Map(candidates.map((c) => [String(c.userId), c.priority || 0]));
  const pool = available.map((a) => ({ ...a, priority: priorityMap.get(String(a.userId)) || 0 }));

  if (!pool.length) {
    const everyoneTried = candidates.length > 0 && candidates.every((c) => (call.triedAgentIds || []).map(String).includes(String(c.userId)));
    if (!ringing.length && (everyoneTried || !candidates.length) && !call.queueId) {
      // Direct-agent call nobody answered: send to voicemail now.
      await redirectToFallback(call, provider);
    }
    return null;
  }
  if (ringing.length && queue?.strategy !== 'ring_all') return null;

  const { selected, nextIndex } = selectAgents(pool, queue || { strategy: call.metadata?.targetUserIds?.length > 1 ? 'ring_all' : 'longest_idle' });
  if (queue && nextIndex !== undefined) await CallQueue.updateOne({ _id: queue._id }, { lastAssignedIndex: nextIndex });

  const context = await getCustomerContext(orgId, { phone: call.from, contactId: call.related?.contactId, leadId: call.related?.leadId });
  for (const agent of selected) {
    const user = await User.findById(agent.userId).lean();
    const target = provider.supports('webrtc') ? provider.clientTarget(user._id) : normalizePhone(user.phone);
    if (!target) {
      call.triedAgentIds.push(user._id);
      continue;
    }
    // Reserve the agent so other calls don't ring them at the same time.
    await markOnCall(orgId, user._id, call._id);
    try {
      const leg = await provider.connectAgent({
        call, agentTarget: target, callerId: target.startsWith('client:') ? call.from : call.to,
      });
      call.providerLegs.push({ ...leg, userId: user._id });
      call.markModified('providerLegs');
      emitToUser(String(user._id), 'call:incoming', { call: call.toJSON(), context });
      await notify(orgId, user._id, {
        type: 'incoming_call',
        title: 'Incoming call',
        body: `${context.name || call.from}${context.company ? ` (${context.company})` : ''}`,
        data: { callId: String(call._id), phone: call.from },
      });
    } catch (err) {
      call.triedAgentIds.push(user._id);
      await releaseAgent(orgId, user._id);
      console.error('connectAgent failed', err.message);
    }
  }
  call.queueAttempts += 1;
  await call.save();
  broadcastCall(call);
  return call;
}

/** Queue timeouts: overflow to another queue or run the queue fallback. */
export async function checkQueueTimeouts(now = new Date()) {
  const waiting = await Call.find({ status: 'queued', enqueuedAt: { $ne: null } });
  let handled = 0;
  for (const call of waiting) {
    const queue = call.queueId ? await CallQueue.findById(call.queueId).lean() : null;
    const maxWait = queue?.maxWaitTime || 120;
    const waited = (now - call.enqueuedAt) / 1000;
    const provider = await getTelephonyProvider(call.organizationId, call.provider);
    if (!provider) continue;
    if (queue?.overflow?.queueId && !call.metadata?.overflowed && waited >= (queue.overflow.afterSeconds || maxWait)) {
      call.queueId = queue.overflow.queueId;
      call.triedAgentIds = [];
      call.metadata = { ...(call.metadata || {}), overflowed: true };
      call.markModified('metadata');
      await call.save();
      await dispatchCall(call._id);
      handled += 1;
    } else if (waited >= maxWait) {
      await redirectToFallback(call, provider);
      handled += 1;
    }
  }
  return handled;
}

async function redirectToFallback(call, provider) {
  for (const leg of (call.providerLegs || []).filter((l) => l.role === 'agent')) {
    await provider.hangup(leg.providerCallId).catch(() => null);
    if (leg.userId) await releaseAgent(call.organizationId, leg.userId);
  }
  call.providerLegs = (call.providerLegs || []).filter((l) => l.role !== 'agent');
  call.status = 'ringing';
  call.markModified('providerLegs');
  await call.save();
  if (provider.supports('redirect')) {
    await provider.redirectCall(call.providerCallId, telephonyWebhookUrl(provider.name, 'fallback', { callId: call._id }))
      .catch((err) => console.error('fallback redirect failed', err.message));
  }
}

/** Instructions returned when a queued call is redirected to its fallback. */
export async function fallbackActions(call, provider) {
  const org = await Organization.findById(call.organizationId).lean();
  const queue = call.queueId ? await CallQueue.findById(call.queueId).lean() : null;
  const fb = queue?.fallback || { action: 'voicemail' };
  const lang = call.metadata?.directLanguage;
  if (fb.action === 'hangup') return [await say(org, 'unavailable', lang), { type: 'hangup' }];
  if (fb.action === 'external' && fb.target) {
    return [{ type: 'dial', targets: [normalizePhone(fb.target, org.settings?.defaultCountryCode)], callerId: call.to, timeout: 30 }];
  }
  if (fb.action === 'callback') {
    await createCallbackRequest(call, org, { queueId: queue?._id, source: 'ivr' });
    call.status = 'ringing';
    await call.save();
    return [await say(org, 'callbackConfirmed', lang), { type: 'hangup' }];
  }
  const targetUserIds = call.metadata?.targetUserIds || [];
  return voicemailActions(call, provider, {
    scope: queue ? 'queue' : targetUserIds.length === 1 ? 'personal' : 'ivr',
    targetId: queue?._id || targetUserIds[0],
    language: lang,
  });
}

// ---------------------------------------------------------------- voicemail
export async function voicemailActions(call, provider, { scope = 'ivr', targetId, maxLength = 120, language, prompt = true } = {}) {
  const org = await Organization.findById(call.organizationId).lean();
  call.metadata = { ...(call.metadata || {}), voicemail: { scope, targetId: targetId ? String(targetId) : undefined } };
  call.markModified('metadata');
  if (call.status === 'queued') call.status = 'ringing';
  const actions = [];
  if (prompt) actions.push(await say(org, 'voicemail', language));
  actions.push({
    type: 'record',
    maxLength,
    actionUrl: telephonyWebhookUrl(provider.name, 'voicemail-done', { callId: call._id }),
    recordingCallbackUrl: telephonyWebhookUrl(provider.name, 'voicemail', { callId: call._id, scope, targetId }),
  });
  actions.push({ type: 'hangup' });
  return actions;
}

export async function voicemailRecipients(call, scope, targetId) {
  const orgId = call.organizationId;
  if (scope === 'personal' && targetId) return [targetId];
  if (scope === 'queue' && targetId) {
    return (await CallQueueMember.find({ organizationId: orgId, queueId: targetId, active: true }).lean()).map((m) => m.userId);
  }
  if (scope === 'department' && targetId) {
    return (await Department.findOne({ _id: targetId, organizationId: orgId }).lean())?.memberIds || [];
  }
  const number = call.phoneNumberId ? await PhoneNumber.findById(call.phoneNumberId).lean() : null;
  if (number?.assignedUserId) return [number.assignedUserId];
  return (await User.find({ organizationId: orgId, role: { $in: ['admin', 'supervisor'] }, active: true }).select('_id').lean()).map((u) => u._id);
}

