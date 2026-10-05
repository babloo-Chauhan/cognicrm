import { eventBus } from './lib/eventBus.js';
import { Call, CallQueueMember } from './models/index.js';
import { dispatchCall } from './modules/routing/service.js';
import { onCampaignCallFinished } from './modules/campaigns/service.js';
import { runCallIntelligence } from './modules/ai/pipeline.js';
import { CALL_EVENTS } from './modules/telephony/events.js';

const pending = new Set();

/** Tracks async listener work so tests (and graceful shutdown) can wait for it. */
function track(promise) {
  pending.add(promise);
  promise.catch((err) => console.error('listener error:', err.message)).finally(() => pending.delete(promise));
}

export async function drainListeners() {
  while (pending.size) await Promise.allSettled([...pending]);
}

let registered = false;

export function registerListeners() {
  if (registered) return;
  registered = true;

  eventBus.on('QUEUE_DISPATCH', ({ callId }) => track(dispatchCall(callId)));
  eventBus.on('QUEUE_REDISPATCH', ({ callId }) => track(dispatchCall(callId)));

  // When an agent becomes available, ring them for the longest-waiting call in their queues.
  eventBus.on('AGENT_AVAILABLE', ({ orgId, userId }) => track((async () => {
    const memberships = await CallQueueMember.find({ organizationId: orgId, userId, active: true }).lean();
    const waiting = await Call.find({
      organizationId: orgId,
      status: 'queued',
      $or: [{ queueId: { $in: memberships.map((m) => m.queueId) } }, { 'metadata.targetUserIds': String(userId) }],
    }).sort({ enqueuedAt: 1 }).limit(1).lean();
    if (waiting[0]) await dispatchCall(waiting[0]._id);
  })()));

  eventBus.on('CALL_FINALIZED', ({ call }) => track(onCampaignCallFinished(call)));

  eventBus.on(CALL_EVENTS.CALL_RECORDING_READY, ({ orgId, callId, voicemail }) => {
    if (!voicemail) track(runCallIntelligence(orgId, callId));
  });
}
