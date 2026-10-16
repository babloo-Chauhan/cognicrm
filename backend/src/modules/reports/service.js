import mongoose from 'mongoose';
import {
  Activity, Call, Deal, Invoice, Lead, Note, Organization, Quote, Task, User,
} from '../../models/index.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const CONVERTED = ['converted', 'won'];
const DROPPED = ['lost', 'unqualified'];
const STALE_DAYS = 7;

/** Minutes the zone is ahead of UTC at `date`, e.g. +330 for Asia/Kolkata. */
function zoneOffset(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Midnight of a YYYY-MM-DD day in the company's time zone. */
function dayStart(day, timeZone) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - zoneOffset(guess, timeZone) * 60000);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Report period: whole days `from`..`to` (inclusive) in the company's zone; defaults to the last 30 days. */
export async function reportPeriod(orgId, { from, to } = {}) {
  const org = await Organization.findById(orgId).select('settings.timezone').lean();
  const timeZone = org?.settings?.timezone || 'Asia/Kolkata';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  const toDay = DAY.test(to || '') ? to : today;
  const fromDay = DAY.test(from || '') ? from : new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(dayStart(toDay, timeZone).getTime() - 29 * 86400000));
  const start = dayStart(fromDay, timeZone);
  const end = new Date(dayStart(toDay, timeZone).getTime() + 86400000);
  if (end <= start) return { from: toDay, to: fromDay, start: end, end: start, timeZone };
  return { from: fromDay, to: toDay, start, end, timeZone };
}

const byId = (rows) => new Map(rows.map((r) => [String(r._id), r]));
const rate = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

/**
 * Per-employee numbers for the period. Lead numbers follow the leads *assigned* in the period (a cohort):
 * of those, how many are converted, dropped, or still untouched. Work numbers (calls, remarks, tasks done,
 * quotes sent, deals won, money collected) count what happened inside the period.
 */
async function employeeStats(orgId, period, userFilter = {}) {
  const org = oid(orgId);
  const { start, end } = period;
  const inPeriod = { $gte: start, $lt: end };
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_DAYS * 86400000);
  const userMatch = userFilter.userId ? { _id: oid(userFilter.userId) } : {};
  const owner = userFilter.userId ? oid(userFilter.userId) : { $ne: null };

  const [users, leads, openLeads, calls, remarks, dealsWon, pipeline, tasksDone, overdue, quotes, collected] = await Promise.all([
    User.find({ organizationId: orgId, ...userMatch }).select('name role designation department active lastLogin userCode').lean(),
    Lead.aggregate([
      { $match: { organizationId: org, ownerId: owner, createdAt: inPeriod } },
      {
        $group: {
          _id: '$ownerId',
          assigned: { $sum: 1 },
          converted: { $sum: { $cond: [{ $in: ['$status', CONVERTED] }, 1, 0] } },
          dropped: { $sum: { $cond: [{ $in: ['$status', DROPPED] }, 1, 0] } },
          untouched: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'new'] }, { $not: ['$lastContactedAt'] }] }, 1, 0] } },
          value: { $sum: { $ifNull: ['$estimatedValue', 0] } },
        },
      },
    ]),
    // Right now, regardless of period: open leads and the ones nobody has touched for a week
    Lead.aggregate([
      { $match: { organizationId: org, ownerId: owner, status: { $nin: [...CONVERTED, ...DROPPED] } } },
      {
        $group: {
          _id: '$ownerId',
          open: { $sum: 1 },
          stale: { $sum: { $cond: [{ $lt: [{ $ifNull: ['$lastContactedAt', '$createdAt'] }, staleBefore] }, 1, 0] } },
        },
      },
    ]),
    Call.aggregate([
      { $match: { organizationId: org, agentId: owner, startedAt: inPeriod } },
      {
        $group: {
          _id: '$agentId',
          calls: { $sum: 1 },
          connected: { $sum: { $cond: [{ $ifNull: ['$answeredAt', false] }, 1, 0] } },
          talkSeconds: { $sum: { $ifNull: ['$durationSeconds', 0] } },
        },
      },
    ]),
    Note.aggregate([
      { $match: { organizationId: org, authorId: owner, createdAt: inPeriod } },
      { $group: { _id: '$authorId', remarks: { $sum: 1 } } },
    ]),
    Deal.aggregate([
      { $match: { organizationId: org, ownerId: owner, stage: 'won', updatedAt: inPeriod } },
      { $group: { _id: '$ownerId', won: { $sum: 1 }, wonValue: { $sum: { $ifNull: ['$value', 0] } } } },
    ]),
    Deal.aggregate([
      { $match: { organizationId: org, ownerId: owner, stage: { $nin: ['won', 'lost'] } } },
      { $group: { _id: '$ownerId', openDeals: { $sum: 1 }, pipelineValue: { $sum: { $ifNull: ['$value', 0] } } } },
    ]),
    Task.aggregate([
      { $match: { organizationId: org, assigneeId: owner, status: 'done', updatedAt: inPeriod } },
      { $group: { _id: '$assigneeId', tasksDone: { $sum: 1 } } },
    ]),
    Task.aggregate([
      { $match: { organizationId: org, assigneeId: owner, status: 'open', dueAt: { $lt: now } } },
      { $group: { _id: '$assigneeId', overdueTasks: { $sum: 1 } } },
    ]),
    Quote.aggregate([
      { $match: { organizationId: org, ownerId: owner, sentAt: inPeriod } },
      { $group: { _id: '$ownerId', quotesSent: { $sum: 1 }, quotedValue: { $sum: { $ifNull: ['$totals.total', 0] } } } },
    ]),
    Invoice.aggregate([
      { $match: { organizationId: org, ownerId: owner, 'payments.date': inPeriod } },
      { $unwind: '$payments' },
      { $match: { 'payments.date': inPeriod } },
      { $group: { _id: '$ownerId', collected: { $sum: '$payments.amount' } } },
    ]),
  ]);

  const maps = [leads, openLeads, calls, remarks, dealsWon, pipeline, tasksDone, overdue, quotes, collected].map(byId);
  return users.map((u) => {
    const id = String(u._id);
    const [l, o, c, r, w, p, t, od, q, col] = maps.map((m) => m.get(id) || {});
    const assigned = l.assigned || 0;
    return {
      id, name: u.name, role: u.role, designation: u.designation || '', department: u.department || '',
      userCode: u.userCode || '', active: u.active !== false, lastLogin: u.lastLogin || null,
      leadsAssigned: assigned, leadsConverted: l.converted || 0, leadsDropped: l.dropped || 0, leadsUntouched: l.untouched || 0,
      conversionRate: rate(l.converted || 0, assigned), leadValue: l.value || 0,
      openLeads: o.open || 0, staleLeads: o.stale || 0,
      calls: c.calls || 0, connectedCalls: c.connected || 0, talkSeconds: c.talkSeconds || 0,
      remarks: r.remarks || 0,
      dealsWon: w.won || 0, wonValue: w.wonValue || 0, openDeals: p.openDeals || 0, pipelineValue: p.pipelineValue || 0,
      tasksDone: t.tasksDone || 0, overdueTasks: od.overdueTasks || 0,
      quotesSent: q.quotesSent || 0, quotedValue: q.quotedValue || 0, collected: col.collected || 0,
    };
  });
}

const SUM_KEYS = ['leadsAssigned', 'leadsConverted', 'leadsDropped', 'leadsUntouched', 'leadValue', 'openLeads', 'staleLeads', 'calls',
  'connectedCalls', 'talkSeconds', 'remarks', 'dealsWon', 'wonValue', 'openDeals', 'pipelineValue', 'tasksDone', 'overdueTasks',
  'quotesSent', 'quotedValue', 'collected'];

/** Did this person do or own anything in the period (or still own open work)? */
const hasWork = (e) => SUM_KEYS.some((k) => e[k] > 0);

/** Team performance: one row per employee, best performers first, plus company totals. */
export async function teamReport(orgId, query) {
  const period = await reportPeriod(orgId, query);
  const rows = (await employeeStats(orgId, period))
    .filter((e) => e.active || hasWork(e))
    .sort((a, b) => b.wonValue - a.wonValue || b.leadsConverted - a.leadsConverted || b.calls - a.calls || a.name.localeCompare(b.name));
  const totals = Object.fromEntries(SUM_KEYS.map((k) => [k, rows.reduce((s, e) => s + e[k], 0)]));
  totals.conversionRate = rate(totals.leadsConverted, totals.leadsAssigned);
  return { period: { from: period.from, to: period.to, timeZone: period.timeZone }, totals, employees: rows };
}

/** Charts show days for periods up to ~3 months, months for longer ones. */
const bucketOf = (period) => ((period.end - period.start) / 86400000 > 92 ? 'month' : 'day');
const bucketKey = (field, period) => ({
  $dateToString: { format: bucketOf(period) === 'month' ? '%Y-%m' : '%Y-%m-%d', date: field, timezone: period.timeZone },
});

/** Every day (or month) of the period, so charts show quiet ones as zero instead of skipping them. */
function fillDays(period, series) {
  const out = [];
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: period.timeZone });
  const monthly = bucketOf(period) === 'month';
  const seen = new Set();
  for (let t = period.start.getTime(); t < period.end.getTime(); t += 86400000) {
    let date = fmt.format(new Date(t + 3600000)); // +1h keeps DST shifts on the right day
    if (monthly) date = date.slice(0, 7);
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, ...Object.fromEntries(Object.entries(series).map(([k, m]) => [k, m.get(date) || 0])) });
  }
  return out;
}

const countsByDay = async (Model, match, field, period) => new Map(
  (await Model.aggregate([{ $match: match }, { $group: { _id: bucketKey(`$${field}`, period), n: { $sum: 1 } } }])).map((d) => [d._id, d.n]),
);

/** Lead report: what came in, from where, where it stands now, and what is being neglected. */
export async function leadReport(orgId, query) {
  const period = await reportPeriod(orgId, query);
  const org = oid(orgId);
  const match = { organizationId: org, createdAt: { $gte: period.start, $lt: period.end } };
  if (query.ownerId && /^[a-f0-9]{24}$/i.test(query.ownerId)) match.ownerId = oid(query.ownerId);
  const staleBefore = new Date(Date.now() - STALE_DAYS * 86400000);

  const [byStatus, bySource, newByDay, convertedByDay, stale] = await Promise.all([
    Lead.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: { $ifNull: ['$estimatedValue', 0] } } } }, { $sort: { count: -1 } }]),
    Lead.aggregate([
      { $match: match },
      { $group: { _id: { $ifNull: ['$source', 'other'] }, count: { $sum: 1 }, converted: { $sum: { $cond: [{ $in: ['$status', CONVERTED] }, 1, 0] } } } },
      { $sort: { count: -1 } },
    ]),
    countsByDay(Lead, match, 'createdAt', period),
    countsByDay(Activity, {
      organizationId: org, type: 'lead_converted', occurredAt: { $gte: period.start, $lt: period.end },
      ...(match.ownerId ? { 'links.leadId': { $in: await Lead.find({ organizationId: orgId, ownerId: match.ownerId }).distinct('_id') } } : {}),
    }, 'occurredAt', period),
    Lead.find({
      organizationId: orgId, status: { $nin: [...CONVERTED, ...DROPPED] }, ...(match.ownerId ? { ownerId: match.ownerId } : {}),
      $or: [{ lastContactedAt: { $lt: staleBefore } }, { lastContactedAt: null, createdAt: { $lt: staleBefore } }],
    }).sort({ score: -1, createdAt: 1 }).limit(25).select('name company phone status score ownerId lastContactedAt createdAt').lean(),
  ]);

  const total = byStatus.reduce((s, x) => s + x.count, 0);
  const count = (statuses) => byStatus.filter((x) => statuses.includes(x._id)).reduce((s, x) => s + x.count, 0);
  const converted = count(CONVERTED);
  return {
    period: { from: period.from, to: period.to, timeZone: period.timeZone },
    totals: {
      leads: total, converted, dropped: count(DROPPED), open: total - converted - count(DROPPED),
      untouched: await Lead.countDocuments({ ...match, status: 'new', lastContactedAt: null }),
      conversionRate: rate(converted, total), value: byStatus.reduce((s, x) => s + x.value, 0),
    },
    byStatus: byStatus.map((x) => ({ status: x._id, count: x.count, value: x.value })),
    bySource: bySource.map((x) => ({ source: x._id, count: x.count, converted: x.converted, conversionRate: rate(x.converted, x.count) })),
    bucket: bucketOf(period),
    byDay: fillDays(period, { new: newByDay, converted: convertedByDay }),
    staleLeads: stale.map((l) => ({
      id: String(l._id), name: l.name, company: l.company || '', phone: l.phone || '', status: l.status, score: l.score || 0,
      ownerId: l.ownerId ? String(l.ownerId) : null, lastContactedAt: l.lastContactedAt || null, createdAt: l.createdAt,
    })),
    staleDays: STALE_DAYS,
  };
}

/** One employee: their numbers, day-by-day work, leads by status, recent activity and what is overdue. */
export async function employeeReport(orgId, userId, query) {
  const period = await reportPeriod(orgId, query);
  const [stats] = await employeeStats(orgId, period, { userId });
  if (!stats) return null;
  const org = oid(orgId);
  const me = oid(userId);
  const inPeriod = { $gte: period.start, $lt: period.end };
  const [leadsByDay, callsByDay, remarksByDay, leadStatus, recent, overdueTasks, leads] = await Promise.all([
    countsByDay(Lead, { organizationId: org, ownerId: me, createdAt: inPeriod }, 'createdAt', period),
    countsByDay(Call, { organizationId: org, agentId: me, startedAt: inPeriod }, 'startedAt', period),
    countsByDay(Note, { organizationId: org, authorId: me, createdAt: inPeriod }, 'createdAt', period),
    Lead.aggregate([{ $match: { organizationId: org, ownerId: me, createdAt: inPeriod } }, { $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Activity.find({ organizationId: orgId, userId, occurredAt: inPeriod }).sort({ occurredAt: -1 }).limit(30).select('type title occurredAt links').lean(),
    Task.find({ organizationId: orgId, assigneeId: userId, status: 'open', dueAt: { $lt: new Date() } }).sort({ dueAt: 1 }).limit(20).select('title dueAt priority related').lean(),
    (await leadReport(orgId, { ...query, ownerId: userId })).staleLeads,
  ]);
  return {
    period: { from: period.from, to: period.to, timeZone: period.timeZone },
    employee: stats,
    bucket: bucketOf(period),
    byDay: fillDays(period, { leads: leadsByDay, calls: callsByDay, remarks: remarksByDay }),
    leadsByStatus: leadStatus.map((x) => ({ status: x._id, count: x.count })),
    recentActivity: recent.map((a) => ({ id: String(a._id), type: a.type, title: a.title, occurredAt: a.occurredAt, leadId: a.links?.leadId ? String(a.links.leadId) : null })),
    overdueTasks: overdueTasks.map((t) => ({ id: String(t._id), title: t.title, dueAt: t.dueAt, priority: t.priority })),
    staleLeads: leads,
  };
}
