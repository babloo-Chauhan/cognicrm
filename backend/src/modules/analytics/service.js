import mongoose from 'mongoose';
import {
  AgentStatus, Call, CallDisposition, CallQueue, Department, User,
} from '../../models/index.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));

function buildMatch(orgId, { from, to, agentId, queueId, departmentId, direction }) {
  const match = { organizationId: oid(orgId) };
  const start = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const end = to ? new Date(to) : new Date();
  match.startedAt = { $gte: start, $lte: end };
  if (agentId) match.agentId = oid(agentId);
  if (queueId) match.queueId = oid(queueId);
  if (departmentId) match.departmentId = oid(departmentId);
  if (direction) match.direction = direction;
  return match;
}

const answered = { $cond: [{ $ifNull: ['$answeredAt', false] }, 1, 0] };

/** Call analytics: KPIs + chart series. */
export async function callAnalytics(orgId, filters = {}) {
  const match = buildMatch(orgId, filters);
  const conversionCodes = (await CallDisposition.find({ organizationId: orgId, isConversion: true }).lean()).map((d) => d.code);
  const tz = filters.timezone || 'Asia/Kolkata';

  const [kpi] = await Call.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        inbound: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
        outbound: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
        connected: { $sum: answered },
        missed: { $sum: { $cond: [{ $and: [{ $eq: ['$direction', 'inbound'] }, { $in: ['$status', ['no_answer', 'voicemail', 'abandoned']] }] }, 1, 0] } },
        abandoned: { $sum: { $cond: [{ $eq: ['$status', 'abandoned'] }, 1, 0] } },
        talkTime: { $sum: '$durationSeconds' },
        waitTime: { $sum: '$waitSeconds' },
        queued: { $sum: { $cond: [{ $ifNull: ['$enqueuedAt', false] }, 1, 0] } },
        conversions: { $sum: { $cond: [{ $in: ['$disposition.code', conversionCodes] }, 1, 0] } },
      },
    },
  ]);
  const k = kpi || { total: 0, inbound: 0, outbound: 0, connected: 0, missed: 0, abandoned: 0, talkTime: 0, waitTime: 0, queued: 0, conversions: 0 };

  const [byDay, byAgent, byDepartment, byDisposition] = await Promise.all([
    Call.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: tz } },
          total: { $sum: 1 },
          inbound: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
          outbound: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
          connected: { $sum: answered },
          talkTime: { $sum: '$durationSeconds' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Call.aggregate([
      { $match: { ...match, agentId: { $ne: null } } },
      {
        $group: {
          _id: '$agentId',
          total: { $sum: 1 },
          connected: { $sum: answered },
          talkTime: { $sum: '$durationSeconds' },
          conversions: { $sum: { $cond: [{ $in: ['$disposition.code', conversionCodes] }, 1, 0] } },
        },
      },
      { $sort: { total: -1 } },
    ]),
    Call.aggregate([
      { $match: { ...match, departmentId: { $ne: null } } },
      { $group: { _id: '$departmentId', total: { $sum: 1 }, connected: { $sum: answered } } },
    ]),
    Call.aggregate([
      { $match: { ...match, 'disposition.code': { $ne: null } } },
      { $group: { _id: '$disposition.label', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);

  const [users, departments] = await Promise.all([
    User.find({ _id: { $in: byAgent.map((a) => a._id) } }).select('name').lean(),
    Department.find({ _id: { $in: byDepartment.map((d) => d._id) } }).select('name').lean(),
  ]);
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  const deptNames = new Map(departments.map((d) => [String(d._id), d.name]));

  return {
    kpis: {
      totalCalls: k.total,
      inboundCalls: k.inbound,
      outboundCalls: k.outbound,
      connectedCalls: k.connected,
      missedCalls: k.missed,
      abandonedCalls: k.abandoned,
      averageDuration: k.connected ? Math.round(k.talkTime / k.connected) : 0,
      averageWaitTime: k.queued ? Math.round(k.waitTime / k.queued) : 0,
      answerRate: k.total ? k.connected / k.total : 0,
      conversionRate: k.connected ? k.conversions / k.connected : 0,
      conversions: k.conversions,
    },
    byDay: byDay.map((d) => ({ date: d._id, total: d.total, inbound: d.inbound, outbound: d.outbound, connected: d.connected, averageDuration: d.connected ? Math.round(d.talkTime / d.connected) : 0 })),
    byAgent: byAgent.map((a) => ({
      agentId: String(a._id), name: names.get(String(a._id)) || 'Unknown', total: a.total, connected: a.connected,
      averageDuration: a.connected ? Math.round(a.talkTime / a.connected) : 0, conversions: a.conversions,
      conversionRate: a.connected ? a.conversions / a.connected : 0,
    })),
    byDepartment: byDepartment.map((d) => ({ departmentId: String(d._id), name: deptNames.get(String(d._id)) || 'Unknown', total: d.total, connected: d.connected })),
    byDisposition: byDisposition.map((d) => ({ disposition: d._id, count: d.count })),
  };
}

/** Realtime contact-center snapshot for the supervisor dashboard. */
export async function contactCenterSnapshot(orgId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const org = oid(orgId);
  const [statuses, users, waiting, active, today, queues] = await Promise.all([
    AgentStatus.find({ organizationId: org }).lean(),
    User.find({ organizationId: org, active: true, role: { $in: ['agent', 'supervisor', 'admin'] } }).select('name role').lean(),
    Call.find({ organizationId: org, status: 'queued' }).select('queueId enqueuedAt from').lean(),
    Call.find({ organizationId: org, status: { $in: ['ringing', 'in_progress', 'on_hold', 'transferring'] } }).lean(),
    callAnalytics(orgId, { from: startOfDay }),
    CallQueue.find({ organizationId: org, active: true }).lean(),
  ]);
  const statusByUser = new Map(statuses.map((s) => [String(s.userId), s]));
  const perAgent = new Map(today.byAgent.map((a) => [a.agentId, a]));
  const activeByAgent = new Map(active.filter((c) => c.agentId).map((c) => [String(c.agentId), c]));

  const agents = users.map((u) => {
    const s = statusByUser.get(String(u._id));
    const call = activeByAgent.get(String(u._id));
    const stats = perAgent.get(String(u._id));
    return {
      userId: String(u._id), name: u.name, role: u.role,
      status: s?.status || 'offline', customStatus: s?.customStatus, since: s?.since,
      currentCall: call ? { id: String(call._id), customerPhone: call.customerPhone, direction: call.direction, startedAt: call.answeredAt || call.startedAt, queueId: call.queueId } : null,
      callsToday: stats?.total || 0,
      conversionRate: stats?.conversionRate || 0,
    };
  });
  const count = (fn) => agents.filter(fn).length;
  const handled = today.kpis.connectedCalls;
  return {
    agentsOnline: count((a) => a.status !== 'offline'),
    agentsAvailable: count((a) => a.status === 'available'),
    agentsBusy: count((a) => ['busy', 'on_call', 'wrap_up'].includes(a.status)),
    callsWaiting: waiting.length,
    activeCalls: active.length,
    callsToday: today.kpis.totalCalls,
    missedCalls: today.kpis.missedCalls,
    abandonedCalls: today.kpis.abandonedCalls,
    averageWait: today.kpis.averageWaitTime,
    averageHandleTime: handled ? today.kpis.averageDuration + (await wrapUpAverage(orgId)) : 0,
    agents,
    queues: queues.map((q) => {
      const qWaiting = waiting.filter((c) => String(c.queueId) === String(q._id));
      return {
        id: String(q._id), name: q.name, strategy: q.strategy, waiting: qWaiting.length,
        longestWaitSeconds: qWaiting.length ? Math.round((Date.now() - Math.min(...qWaiting.map((c) => new Date(c.enqueuedAt).getTime()))) / 1000) : 0,
      };
    }),
    activeCallList: active.map((c) => ({
      id: String(c._id), direction: c.direction, status: c.status, customerPhone: c.customerPhone, agentId: c.agentId ? String(c.agentId) : null,
      startedAt: c.answeredAt || c.startedAt, queueId: c.queueId ? String(c.queueId) : null, mode: c.mode,
    })),
  };
}

async function wrapUpAverage(orgId) {
  const { Organization } = await import('../../models/index.js');
  const org = await Organization.findById(orgId).select('settings.wrapUpSeconds').lean();
  return org?.settings?.wrapUpSeconds || 0;
}

export async function queueStats(orgId, queueId) {
  const match = { organizationId: oid(orgId), queueId: oid(queueId), startedAt: { $gte: new Date(Date.now() - 86400000) } };
  const [s] = await Call.aggregate([
    { $match: match },
    {
      $group: {
        _id: null, total: { $sum: 1 }, answered: { $sum: answered },
        abandoned: { $sum: { $cond: [{ $eq: ['$status', 'abandoned'] }, 1, 0] } }, wait: { $sum: '$waitSeconds' },
      },
    },
  ]);
  const waiting = await Call.countDocuments({ organizationId: orgId, queueId, status: 'queued' });
  return {
    waitingCalls: waiting,
    callsLast24h: s?.total || 0,
    answered: s?.answered || 0,
    abandonedCalls: s?.abandoned || 0,
    averageWait: s?.total ? Math.round(s.wait / s.total) : 0,
  };
}
