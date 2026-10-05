import mongoose from 'mongoose';
import { AgentStatus, AGENT_STATES, Call, Organization, User } from '../../models/index.js';
import { badRequest } from '../../lib/errors.js';
import { emitToOrg, emitToSupervisors } from '../../lib/realtime.js';
import { emitEvent } from '../../lib/eventBus.js';

/**
 * Sets an agent's realtime state. Custom statuses (organization defined) map to a base state:
 * `available: true` custom statuses count as Available, others as Break.
 */
export async function setAgentStatus(orgId, userId, status, { customStatus, currentCallId, wrapUpUntil, activeCampaignId } = {}) {
  let base = status;
  let custom = customStatus || null;
  if (!AGENT_STATES.includes(status)) {
    const org = await Organization.findById(orgId).select('settings.customAgentStatuses').lean();
    const def = (org?.settings?.customAgentStatuses || []).find((s) => s.key === status);
    if (!def) throw badRequest(`Unknown agent status "${status}"`);
    base = def.available ? 'available' : 'break';
    custom = def.key;
  }
  const update = { status: base, customStatus: custom, since: new Date() };
  if (currentCallId !== undefined) update.currentCallId = currentCallId;
  if (['available', 'offline', 'break', 'online'].includes(base)) update.currentCallId = null;
  if (wrapUpUntil !== undefined) update.wrapUpUntil = wrapUpUntil;
  if (base !== 'wrap_up') update.wrapUpUntil = null;
  if (activeCampaignId !== undefined) update.activeCampaignId = activeCampaignId;

  const doc = await AgentStatus.findOneAndUpdate(
    { userId },
    { $set: update, $setOnInsert: { organizationId: orgId, userId } },
    { upsert: true, returnDocument: 'after' },
  );
  const payload = doc.toJSON();
  emitToSupervisors(String(orgId), 'agent:status', payload);
  emitToOrg(String(orgId), 'agent:status', payload);
  if (base === 'available') emitEvent('AGENT_AVAILABLE', { orgId: String(orgId), userId: String(userId) });
  return doc;
}

export async function markOnCall(orgId, userId, callId) {
  if (!userId) return null;
  return setAgentStatus(orgId, userId, 'on_call', { currentCallId: callId });
}

/** After a call: wrap-up for the configured time, then back to Available (see jobs). */
export async function startWrapUp(orgId, userId, seconds) {
  if (!userId) return null;
  if (!seconds) return setAgentStatus(orgId, userId, 'available', { currentCallId: null });
  await AgentStatus.updateOne({ userId }, { lastCallEndedAt: new Date() });
  return setAgentStatus(orgId, userId, 'wrap_up', { currentCallId: null, wrapUpUntil: new Date(Date.now() + seconds * 1000) });
}

export async function releaseAgent(orgId, userId) {
  if (!userId) return null;
  await AgentStatus.updateOne({ userId }, { lastCallEndedAt: new Date() });
  return setAgentStatus(orgId, userId, 'available', { currentCallId: null });
}

/** Ends expired wrap-up periods. */
export async function expireWrapUps(now = new Date()) {
  const due = await AgentStatus.find({ status: 'wrap_up', wrapUpUntil: { $lte: now } }).lean();
  for (const a of due) await setAgentStatus(a.organizationId, a.userId, 'available');
  return due.length;
}

/** Available agents among `userIds` with the stats queue strategies need. */
export async function getAvailableAgents(orgId, userIds, excludeIds = []) {
  const exclude = new Set(excludeIds.map(String));
  const ids = userIds.filter((id) => !exclude.has(String(id)));
  if (!ids.length) return [];
  const [statuses, users] = await Promise.all([
    AgentStatus.find({ organizationId: orgId, userId: { $in: ids }, status: 'available', currentCallId: null }).lean(),
    User.find({ _id: { $in: ids }, organizationId: orgId, active: true }).select('_id').lean(),
  ]);
  const activeIds = new Set(users.map((u) => String(u._id)));
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const counts = await Call.aggregate([
    { $match: { organizationId: new mongoose.Types.ObjectId(String(orgId)), agentId: { $in: statuses.map((s) => s.userId) }, startedAt: { $gte: startOfDay } } },
    { $group: { _id: '$agentId', n: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.n]));
  return statuses
    .filter((s) => activeIds.has(String(s.userId)))
    .map((s) => ({ userId: s.userId, since: s.since, lastCallEndedAt: s.lastCallEndedAt, callsToday: countMap.get(String(s.userId)) || 0 }));
}
