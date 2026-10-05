import { Call } from '../models/index.js';
import { expireWrapUps } from '../modules/agents/service.js';
import { checkQueueTimeouts, dispatchWaitingCalls } from '../modules/routing/service.js';
import { processDueCallbacks, markMissedCallbacks } from '../modules/callbacks/service.js';
import { runDialerTick } from '../modules/campaigns/service.js';
import { applyCallLogRetention, applyRecordingRetention } from '../modules/recordings/service.js';
import { retryFailedWebhooks } from '../modules/webhooks/routes.js';
import { getTelephonyProvider } from '../modules/telephony/registry.js';
import { createAlert } from '../modules/compliance/fraud.js';
import { Organization } from '../models/index.js';
import { expireQuotes, markOverdueInvoices } from '../modules/sales/service.js';
import { remindDueTasks, remindUpcomingAppointments } from '../modules/notifications/reminders.js';
import { expireSubscriptions } from '../modules/saas/jobs.js';

/** Hangs up calls that exceed the organization's maximum call duration (fraud control). */
export async function enforceMaxDuration(now = new Date()) {
  const live = await Call.find({ status: { $in: ['in_progress', 'on_hold', 'transferring'] }, answeredAt: { $ne: null } });
  let ended = 0;
  for (const call of live) {
    const org = await Organization.findById(call.organizationId).select('settings.fraud').lean();
    const max = org?.settings?.fraud?.maxDurationSeconds;
    if (!max || (now - call.answeredAt) / 1000 < max) continue;
    const provider = await getTelephonyProvider(call.organizationId, call.provider);
    const legs = [call.providerCallId, ...call.providerLegs.map((l) => l.providerCallId)].filter(Boolean);
    for (const id of new Set(legs)) await provider?.hangup(id).catch(() => null);
    await createAlert(call.organizationId, {
      type: 'fraud.max_duration', userId: call.agentId, message: `Call ended after exceeding ${max}s`, data: { callId: String(call._id) }, dedupeMinutes: 0,
    });
    ended += 1;
  }
  return ended;
}

const JOBS = [
  { name: 'wrap-up expiry', everyMs: 5000, run: expireWrapUps },
  { name: 'queue timeouts', everyMs: 10000, run: checkQueueTimeouts },
  { name: 'queue dispatch', everyMs: 5000, run: dispatchWaitingCalls },
  { name: 'dialer', everyMs: 5000, run: runDialerTick },
  { name: 'callbacks', everyMs: 30000, run: processDueCallbacks },
  { name: 'task follow-up reminders', everyMs: 30000, run: remindDueTasks },
  { name: 'appointment reminders', everyMs: 30000, run: remindUpcomingAppointments },
  { name: 'missed callbacks', everyMs: 3600000, run: markMissedCallbacks },
  { name: 'webhook retries', everyMs: 30000, run: retryFailedWebhooks },
  { name: 'max call duration', everyMs: 60000, run: enforceMaxDuration },
  { name: 'recording retention', everyMs: 3600000, run: applyRecordingRetention },
  { name: 'call log retention', everyMs: 6 * 3600000, run: applyCallLogRetention },
  { name: 'quote expiry', everyMs: 3600000, run: expireQuotes },
  { name: 'overdue invoices', everyMs: 3600000, run: markOverdueInvoices },
  { name: 'subscription expiry', everyMs: 300000, run: expireSubscriptions },
];

/** Simple in-process scheduler. Each job never overlaps with itself. */
export function startJobs() {
  const timers = JOBS.map((job) => {
    let running = false;
    return setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await job.run(new Date());
      } catch (err) {
        console.error(`[job:${job.name}]`, err.message);
      } finally {
        running = false;
      }
    }, job.everyMs);
  });
  return () => timers.forEach(clearInterval);
}
