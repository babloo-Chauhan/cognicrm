import { AgentStatus, Callback, CallQueueMember, User } from '../../models/index.js';
import { notifyMany } from '../notifications/service.js';
import { initiateOutboundCall } from '../calls/service.js';

/**
 * Processes due callbacks: notifies the assigned agent (or the queue / supervisors when
 * unassigned) and optionally places the call automatically when the agent is available.
 */
export async function processDueCallbacks(now = new Date()) {
  const due = await Callback.find({ status: 'pending', scheduledAt: { $lte: now } }).limit(100);
  for (const cb of due) {
    let recipients = [];
    if (cb.assignedAgentId) recipients = [cb.assignedAgentId];
    else if (cb.queueId) recipients = (await CallQueueMember.find({ queueId: cb.queueId, active: true }).lean()).map((m) => m.userId);
    if (!recipients.length) {
      recipients = (await User.find({ organizationId: cb.organizationId, role: { $in: ['admin', 'supervisor'] }, active: true }).select('_id').lean()).map((u) => u._id);
    }
    cb.status = 'notified';
    cb.notifiedAt = now;
    await cb.save();
    await notifyMany(cb.organizationId, recipients, {
      type: 'callback_reminder',
      title: `Callback due${cb.priority === 'urgent' || cb.priority === 'high' ? ' (high priority)' : ''}`,
      body: `${cb.customerName || cb.phone}${cb.notes ? ` — ${cb.notes}` : ''}`,
      data: { callbackId: String(cb._id), phone: cb.phone },
    });

    if (cb.autoDial && cb.assignedAgentId) {
      const status = await AgentStatus.findOne({ userId: cb.assignedAgentId }).lean();
      if (status?.status === 'available' && !status.currentCallId) {
        const user = await User.findById(cb.assignedAgentId).lean();
        try {
          const { call } = await initiateOutboundCall({
            orgId: cb.organizationId, user, to: cb.phone, mode: 'webrtc', related: cb.related || {}, callbackId: cb._id, source: 'callback',
          });
          cb.status = 'in_progress';
          cb.callId = call._id;
          await cb.save();
        } catch (err) {
          cb.notes = `${cb.notes || ''}\nAuto-dial failed: ${err.message}`.trim();
          await cb.save();
        }
      }
    }
  }
  return due.length;
}

/** Marks notified callbacks that nobody handled within `graceHours` as missed. */
export async function markMissedCallbacks(now = new Date(), graceHours = 24) {
  const res = await Callback.updateMany(
    { status: 'notified', notifiedAt: { $lt: new Date(now.getTime() - graceHours * 3600000) } },
    { status: 'missed' },
  );
  return res.modifiedCount;
}
