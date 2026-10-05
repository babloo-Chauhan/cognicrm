import mongoose from 'mongoose';
import {
  AgentStatus, Call, Callback, CallCampaign, CallCampaignContact, CallDisposition, Contact, DncEntry, Lead, Note, Organization, User,
} from '../../models/index.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { isValidE164, normalizePhone } from '../../lib/phone.js';
import { emitToUser, emitToSupervisors } from '../../lib/realtime.js';
import { isOnDnc } from '../compliance/service.js';
import { isWithinWindow } from '../routing/businessHours.js';
import { getCustomerContext } from '../crm/lookup.js';
import { initiateOutboundCall } from '../calls/service.js';
import { requireTelephonyProvider } from '../telephony/registry.js';
import { telephonyWebhookUrl } from '../telephony/urls.js';
import { computePredictiveDialCount } from './predictive.js';
import { setAgentStatus } from '../agents/service.js';

/** True when the campaign may dial now: inside its date range and its daily calling window. */
export function campaignWindowOpen(campaign, org, now = new Date()) {
  const sch = campaign.schedule?.toObject?.() || campaign.schedule || {};
  if (sch.startDate && new Date(sch.startDate) > now) return false;
  if (sch.endDate && new Date(sch.endDate) < now) return false;
  return isWithinWindow({ ...sch, timezone: sch.timezone || org?.settings?.timezone }, now);
}

export async function importContacts(orgId, campaignId, { contactIds = [], leadIds = [], rows = [] }) {
  const campaign = await CallCampaign.findOne({ _id: campaignId, organizationId: orgId });
  if (!campaign) throw notFound('Campaign');
  const org = await Organization.findById(orgId).lean();
  const cc = org.settings?.defaultCountryCode;
  const entries = [];
  const contacts = contactIds.length ? await Contact.find({ organizationId: orgId, _id: { $in: contactIds } }).lean() : [];
  const leads = leadIds.length ? await Lead.find({ organizationId: orgId, _id: { $in: leadIds } }).lean() : [];
  for (const c of contacts) entries.push({ name: `${c.firstName} ${c.lastName || ''}`.trim(), phone: c.phone, related: { contactId: c._id, accountId: c.accountId }, optedOut: c.doNotCall });
  for (const l of leads) entries.push({ name: l.name, phone: l.phone, related: { leadId: l._id }, optedOut: l.doNotCall });
  for (const r of rows) entries.push({ name: r.name, phone: r.phone, related: {} });

  const existing = new Set((await CallCampaignContact.find({ campaignId }).select('phone').lean()).map((e) => e.phone));
  const docs = [];
  const summary = { added: 0, invalid: 0, dnc: 0, duplicates: 0 };
  for (const e of entries) {
    const phone = normalizePhone(e.phone, cc);
    if (phone && existing.has(phone)) { summary.duplicates += 1; continue; }
    let status = 'pending';
    if (!phone || !isValidE164(phone)) { status = 'invalid'; summary.invalid += 1; }
    else if (e.optedOut || await isOnDnc(orgId, phone)) { status = 'dnc'; summary.dnc += 1; }
    else summary.added += 1;
    if (phone) existing.add(phone);
    docs.push({ organizationId: orgId, campaignId, name: e.name, phone: phone || String(e.phone || ''), related: e.related, status });
  }
  if (docs.length) await CallCampaignContact.insertMany(docs);
  campaign.stats.total = await CallCampaignContact.countDocuments({ campaignId });
  await campaign.save();
  return summary;
}

export async function setCampaignStatus(orgId, campaignId, action) {
  const campaign = await CallCampaign.findOne({ _id: campaignId, organizationId: orgId });
  if (!campaign) throw notFound('Campaign');
  const transitions = { start: ['draft', 'paused'], pause: ['running'], resume: ['paused'], complete: ['draft', 'running', 'paused'] };
  if (!transitions[action]?.includes(campaign.status)) throw conflict(`Cannot ${action} a ${campaign.status} campaign`);
  if (action === 'start' || action === 'resume') {
    if (campaign.mode === 'predictive' && campaign.predictive?.enabled && !campaign.predictive?.complianceAcknowledged) {
      throw badRequest('Predictive dialing requires the compliance acknowledgement to be accepted');
    }
    if (!campaign.callerIdNumberId) throw badRequest('Select a caller ID number before starting the campaign');
  }
  campaign.status = { start: 'running', pause: 'paused', resume: 'running', complete: 'completed' }[action];
  await campaign.save();
  emitToSupervisors(String(orgId), 'campaign:update', campaign.toJSON());
  return campaign;
}

/** Atomically claims the next dialable contact for an agent. */
async function claimNextContact(campaign, userId, now = new Date()) {
  return CallCampaignContact.findOneAndUpdate(
    {
      campaignId: campaign._id,
      status: 'pending',
      $and: [
        { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
        { $or: [{ lockedBy: null }, { lockedAt: { $lt: new Date(now.getTime() - 10 * 60000) } }, { lockedBy: userId }] },
        { $or: [{ assignedAgentId: null }, { assignedAgentId: userId }] },
      ],
    },
    { lockedBy: userId, lockedAt: now },
    { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after' },
  );
}

function assertAgentInCampaign(campaign, user) {
  if (campaign.agentIds?.length && !campaign.agentIds.map(String).includes(String(user._id)) && !['admin', 'supervisor'].includes(user.role)) {
    throw badRequest('You are not assigned to this campaign');
  }
}

/** Preview dialer: next contact with full customer profile. */
export async function previewNext(orgId, campaignId, user) {
  const campaign = await CallCampaign.findOne({ _id: campaignId, organizationId: orgId });
  if (!campaign) throw notFound('Campaign');
  if (campaign.status !== 'running') throw conflict('Campaign is not running');
  assertAgentInCampaign(campaign, user);
  const entry = await claimNextContact(campaign, user._id);
  if (!entry) return { contact: null };
  const context = await getCustomerContext(orgId, { phone: entry.phone, contactId: entry.related?.contactId, leadId: entry.related?.leadId });
  const notes = await Note.find({
    organizationId: orgId,
    $or: [
      entry.related?.contactId && { 'related.contactId': entry.related.contactId },
      entry.related?.leadId && { 'related.leadId': entry.related.leadId },
    ].filter(Boolean),
  }).sort({ createdAt: -1 }).limit(10).lean().catch(() => []);
  return { contact: entry, context, notes };
}

export async function dialContact(orgId, campaignId, contactEntryId, user, { mode = 'webrtc' } = {}) {
  const campaign = await CallCampaign.findOne({ _id: campaignId, organizationId: orgId });
  if (!campaign) throw notFound('Campaign');
  if (campaign.status !== 'running') throw conflict('Campaign is not running');
  assertAgentInCampaign(campaign, user);
  const org = await Organization.findById(orgId).lean();
  if (!campaignWindowOpen(campaign, org)) throw conflict('Outside the campaign calling window');
  const entry = await CallCampaignContact.findOne({ _id: contactEntryId, campaignId, organizationId: orgId });
  if (!entry) throw notFound('Campaign contact');
  if (!['pending', 'callback'].includes(entry.status)) throw conflict(`Contact is ${entry.status}`);
  entry.status = 'dialing';
  entry.attempts += 1;
  entry.lockedBy = user._id;
  entry.lockedAt = new Date();
  await entry.save();
  try {
    const { call } = await initiateOutboundCall({
      orgId, user, to: entry.phone, mode, related: entry.related?.toObject?.() || entry.related || {},
      callerIdNumberId: campaign.callerIdNumberId, campaignId: campaign._id, campaignContactId: entry._id, source: 'campaign',
    });
    entry.lastCallId = call._id;
    await entry.save();
    return { call, contact: entry };
  } catch (err) {
    entry.status = err.code === 'COMPLIANCE_BLOCKED' ? 'dnc' : 'pending';
    entry.lockedBy = null;
    if (entry.status === 'pending') entry.nextAttemptAt = new Date(Date.now() + campaign.retryPolicy.retryDelayMinutes * 60000);
    await entry.save();
    throw err;
  }
}

export async function skipContact(orgId, campaignId, contactEntryId) {
  const entry = await CallCampaignContact.findOneAndUpdate(
    { _id: contactEntryId, campaignId, organizationId: orgId },
    { status: 'skipped', lockedBy: null },
    { returnDocument: 'after' },
  );
  if (!entry) throw notFound('Campaign contact');
  return entry;
}

export async function scheduleContactCallback(orgId, campaignId, contactEntryId, user, { scheduledAt, notes }) {
  const entry = await CallCampaignContact.findOne({ _id: contactEntryId, campaignId, organizationId: orgId });
  if (!entry) throw notFound('Campaign contact');
  const at = new Date(scheduledAt);
  if (Number.isNaN(at.getTime())) throw badRequest('Invalid scheduledAt');
  const cb = await Callback.create({
    organizationId: orgId, customerName: entry.name, phone: entry.phone, related: entry.related,
    assignedAgentId: user._id, scheduledAt: at, notes, source: 'campaign',
  });
  entry.status = 'callback';
  entry.nextAttemptAt = at;
  entry.lockedBy = null;
  await entry.save();
  return { contact: entry, callback: cb };
}

/** Updates the campaign contact once its call has ended (retry policy). */
export async function onCampaignCallFinished(call) {
  if (!call.campaignContactId) return;
  const entry = await CallCampaignContact.findById(call.campaignContactId);
  const campaign = entry && await CallCampaign.findById(entry.campaignId);
  if (!entry || !campaign) return;
  entry.lockedBy = null;
  if (call.answeredAt) {
    entry.status = 'completed';
    campaign.stats.connected += 1;
  } else if (call.metadata?.abandoned) {
    entry.status = 'completed';
    campaign.stats.abandoned += 1;
  } else if (campaign.retryPolicy.retryOn.includes(call.status) && entry.attempts < campaign.retryPolicy.maxAttempts) {
    entry.status = 'pending';
    entry.nextAttemptAt = new Date(Date.now() + campaign.retryPolicy.retryDelayMinutes * 60000);
  } else {
    entry.status = 'failed';
  }
  await entry.save();
  campaign.stats.completed = await CallCampaignContact.countDocuments({ campaignId: campaign._id, status: { $in: ['completed', 'failed', 'skipped', 'dnc', 'invalid'] } });
  await campaign.save();
  if (campaign.status === 'running' && !(await CallCampaignContact.exists({ campaignId: campaign._id, status: { $in: ['pending', 'dialing', 'callback'] } }))) {
    campaign.status = 'completed';
    await campaign.save();
  }
  emitToSupervisors(String(campaign.organizationId), 'campaign:update', campaign.toJSON());
}

/** Applies campaign disposition rules (complete / retry / dnc / callback). */
export async function onCampaignDisposition(call, code) {
  if (!call.campaignContactId) return;
  const entry = await CallCampaignContact.findById(call.campaignContactId);
  const campaign = entry && await CallCampaign.findById(entry.campaignId);
  if (!entry || !campaign) return;
  entry.lastDisposition = code;
  const rule = (campaign.dispositionRules || []).find((r) => r.code === code);
  if (rule?.action === 'retry' && entry.attempts < campaign.retryPolicy.maxAttempts) {
    entry.status = 'pending';
    entry.nextAttemptAt = new Date(Date.now() + campaign.retryPolicy.retryDelayMinutes * 60000);
  } else if (rule?.action === 'dnc') {
    entry.status = 'dnc';
    await DncEntry.updateOne({ organizationId: campaign.organizationId, phone: entry.phone }, { $setOnInsert: { reason: `Campaign disposition ${code}`, source: 'disposition' } }, { upsert: true });
  } else if (rule?.action === 'callback') {
    entry.status = 'callback';
  }
  await entry.save();
  const def = await CallDisposition.findOne({ organizationId: campaign.organizationId, code }).lean();
  if (def?.isConversion) {
    campaign.stats.converted += 1;
    await campaign.save();
  }
}

export async function joinCampaign(orgId, campaignId, user, join = true) {
  const campaign = await CallCampaign.findOne({ _id: campaignId, organizationId: orgId });
  if (!campaign) throw notFound('Campaign');
  if (join) assertAgentInCampaign(campaign, user);
  await setAgentStatus(orgId, user._id, join ? 'available' : 'online', { activeCampaignId: join ? campaign._id : null });
  return { joined: join };
}

/**
 * Power / predictive dialer engine. Runs on a short interval.
 *  - power: one call per joined, available agent (agent-first, so the agent hears every connect)
 *  - predictive: computePredictiveDialCount() with compliance safeguards; answered calls with no
 *    free agent receive an abandonment message and are counted against the abandon rate.
 */
export async function runDialerTick(now = new Date()) {
  const campaigns = await CallCampaign.find({ status: 'running', mode: { $in: ['power', 'predictive'] } });
  let placed = 0;
  for (const campaign of campaigns) {
    const org = await Organization.findById(campaign.organizationId).lean();
    if (!campaignWindowOpen(campaign, org, now)) continue;
    const agents = await AgentStatus.find({
      organizationId: campaign.organizationId, activeCampaignId: campaign._id, status: 'available', currentCallId: null,
    }).lean();
    if (!agents.length) continue;

    if (campaign.mode === 'power' || !campaign.predictive?.enabled) {
      for (const a of agents) {
        const user = await User.findById(a.userId).lean();
        const entry = await claimNextContact(campaign, a.userId, now);
        if (!entry) break;
        await dialContact(campaign.organizationId, campaign._id, entry._id, user).then(() => { placed += 1; }).catch((err) => {
          emitToUser(String(a.userId), 'campaign:error', { campaignId: String(campaign._id), message: err.message });
        });
      }
      continue;
    }
    placed += await predictiveTick(campaign, agents, now);
  }
  return placed;
}

async function predictiveTick(campaign, agents, now) {
  const since = new Date(now.getTime() - 2 * 3600000);
  const recent = await Call.find({ campaignId: campaign._id, startedAt: { $gte: since }, status: { $nin: ['initiated', 'ringing', 'in_progress', 'queued'] } })
    .select('answeredAt metadata').lean();
  const answered = recent.filter((c) => c.answeredAt || c.metadata?.abandoned).length;
  const abandoned = recent.filter((c) => c.metadata?.abandoned).length;
  const inFlight = await Call.countDocuments({ campaignId: campaign._id, status: { $in: ['initiated', 'ringing'] } });
  const pacing = computePredictiveDialCount({
    availableAgents: agents.length,
    inFlightCalls: inFlight,
    answerRate: recent.length ? answered / recent.length : 0,
    abandonRate: answered ? abandoned / answered : 0,
    sampleSize: recent.length,
    settings: campaign.predictive,
  });
  if (!pacing.dialCount) return 0;
  const provider = await requireTelephonyProvider(campaign.organizationId);
  const org = await Organization.findById(campaign.organizationId).lean();
  const { resolveCallerId } = await import('../calls/service.js');
  const callerId = await resolveCallerId(org, null, campaign.callerIdNumberId);
  let placed = 0;
  for (let i = 0; i < pacing.dialCount; i += 1) {
    const entry = await claimNextContact(campaign, new mongoose.Types.ObjectId(), now);
    if (!entry) break;
    if (await isOnDnc(campaign.organizationId, entry.phone)) {
      entry.status = 'dnc';
      await entry.save();
      continue;
    }
    entry.status = 'dialing';
    entry.attempts += 1;
    const call = new Call({
      organizationId: campaign.organizationId, direction: 'outbound', mode: 'bridge', status: 'initiated', from: callerId.number,
      to: entry.phone, customerPhone: entry.phone, provider: provider.name, related: entry.related, campaignId: campaign._id,
      campaignContactId: entry._id, source: 'campaign', phoneNumberId: callerId._id, metadata: { predictive: true },
    });
    call.conferenceName = `call-${call._id}`;
    await call.save();
    try {
      const leg = await provider.makeAutomatedCall({
        call, to: entry.phone, callerId: callerId.number,
        url: telephonyWebhookUrl(provider.name, 'campaign-answer', { callId: call._id }),
      });
      call.providerCallId = leg.providerCallId;
      call.providerLegs = [leg];
      await call.save();
      entry.lastCallId = call._id;
      await entry.save();
      placed += 1;
    } catch (err) {
      call.status = 'failed';
      call.failureReason = err.message;
      await call.save();
      entry.status = 'pending';
      entry.nextAttemptAt = new Date(now.getTime() + campaign.retryPolicy.retryDelayMinutes * 60000);
      await entry.save();
    }
  }
  return placed;
}

export async function campaignAnalytics(orgId, campaignId) {
  const campaign = await CallCampaign.findOne({ _id: campaignId, organizationId: orgId }).lean();
  if (!campaign) throw notFound('Campaign');
  const cid = new mongoose.Types.ObjectId(String(campaignId));
  const [byStatus, byDisposition, callStats] = await Promise.all([
    CallCampaignContact.aggregate([{ $match: { campaignId: cid } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Call.aggregate([{ $match: { campaignId: cid, 'disposition.code': { $ne: null } } }, { $group: { _id: '$disposition.label', count: { $sum: 1 } } }]),
    Call.aggregate([
      { $match: { campaignId: cid } },
      {
        $group: {
          _id: null, calls: { $sum: 1 }, connected: { $sum: { $cond: [{ $ifNull: ['$answeredAt', false] }, 1, 0] } },
          talkTime: { $sum: '$durationSeconds' },
        },
      },
    ]),
  ]);
  const s = callStats[0] || { calls: 0, connected: 0, talkTime: 0 };
  return {
    campaign,
    contactsByStatus: Object.fromEntries(byStatus.map((b) => [b._id, b.count])),
    dispositions: Object.fromEntries(byDisposition.map((b) => [b._id, b.count])),
    calls: s.calls,
    connected: s.connected,
    connectRate: s.calls ? s.connected / s.calls : 0,
    averageTalkTime: s.connected ? Math.round(s.talkTime / s.connected) : 0,
    conversions: campaign.stats.converted,
  };
}
