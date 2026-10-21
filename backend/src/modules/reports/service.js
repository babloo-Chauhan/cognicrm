import mongoose from 'mongoose';
import {
  Activity, Call, Contact, Deal, Invoice, Lead, Note, Organization, Quote, Task, User,
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

const answered = { $cond: [{ $ifNull: ['$answeredAt', false] }, 1, 0] };

const EXPORT_LIMIT = 10000;

/**
 * Every lead created in the period (optionally one employee's), one row each, for the admin's Excel export:
 * who has it and who it is shared with, where it stands, its calls with talk time and its latest remark.
 */
export async function leadExport(orgId, query) {
  const period = await reportPeriod(orgId, query);
  const match = { organizationId: oid(orgId), createdAt: { $gte: period.start, $lt: period.end } };
  if (query.ownerId && /^[a-f0-9]{24}$/i.test(query.ownerId)) match.ownerId = oid(query.ownerId);
  const leads = await Lead.find(match).sort({ createdAt: -1 }).limit(EXPORT_LIMIT)
    .select('name phone email company source status ownerId assignees estimatedValue requirement notes nextFollowUpAt lastContactedAt createdAt').lean();
  const ids = leads.map((l) => l._id);
  const [users, calls, notes] = await Promise.all([
    User.find({ organizationId: orgId }).select('name').lean(),
    Call.aggregate([
      { $match: { organizationId: oid(orgId), 'related.leadId': { $in: ids } } },
      { $group: { _id: '$related.leadId', calls: { $sum: 1 }, connected: { $sum: answered }, talk: { $sum: { $ifNull: ['$durationSeconds', 0] } }, last: { $max: '$startedAt' } } },
    ]),
    Note.aggregate([
      { $match: { organizationId: oid(orgId), 'related.leadId': { $in: ids } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$related.leadId', count: { $sum: 1 }, latest: { $first: '$body' } } },
    ]),
  ]);
  const name = new Map(users.map((u) => [String(u._id), u.name]));
  const callsOf = byId(calls);
  const notesOf = byId(notes);
  return {
    period: { from: period.from, to: period.to, timeZone: period.timeZone },
    truncated: leads.length === EXPORT_LIMIT,
    leads: leads.map((l) => {
      const c = callsOf.get(String(l._id));
      const n = notesOf.get(String(l._id));
      const owner = l.ownerId ? String(l.ownerId) : '';
      return {
        id: String(l._id), name: l.name, phone: l.phone || '', email: l.email || '', company: l.company || '',
        source: l.source || 'other', status: l.status,
        owner: name.get(owner) || '',
        sharedWith: (l.assignees || []).map(String).filter((a) => a !== owner).map((a) => name.get(a)).filter(Boolean),
        estimatedValue: l.estimatedValue || 0, requirement: l.requirement || '',
        calls: c?.calls || 0, connectedCalls: c?.connected || 0, talkSeconds: c?.talk || 0, lastCallAt: c?.last || null,
        remarks: n?.count || 0, latestRemark: n?.latest || l.notes || '',
        nextFollowUpAt: l.nextFollowUpAt || null, lastContactedAt: l.lastContactedAt || null, createdAt: l.createdAt,
      };
    }),
  };
}


/**
 * One employee's calls in the period: totals, talk time, when in the day they call, and how calls ended.
 * Calls from the mobile app go through the phone's own dialer, so their duration is the time the person
 * spent away from the app (confirmed by them) — `estimatedCalls` says how many those are.
 */
async function callSummary(orgId, userId, period) {
  const match = { organizationId: oid(orgId), agentId: oid(userId), startedAt: { $gte: period.start, $lt: period.end } };
  const [[k], byHour, byOutcome] = await Promise.all([
    Call.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          outbound: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
          inbound: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
          connected: { $sum: answered },
          talkSeconds: { $sum: { $ifNull: ['$durationSeconds', 0] } },
          longestSeconds: { $max: { $ifNull: ['$durationSeconds', 0] } },
          recorded: { $sum: { $cond: ['$hasRecording', 1, 0] } },
          estimated: { $sum: { $cond: [{ $eq: ['$mode', 'native'] }, 1, 0] } },
          first: { $min: '$startedAt' },
          last: { $max: '$startedAt' },
        },
      },
    ]),
    Call.aggregate([
      { $match: match },
      { $group: { _id: { $hour: { date: '$startedAt', timezone: period.timeZone } }, calls: { $sum: 1 }, connected: { $sum: answered } } },
    ]),
    Call.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ['$disposition.label', { $cond: [{ $ifNull: ['$answeredAt', false] }, 'Connected (no outcome chosen)', 'Not connected'] }] },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]),
  ]);
  const c = k || { total: 0, outbound: 0, inbound: 0, connected: 0, talkSeconds: 0, longestSeconds: 0, recorded: 0, estimated: 0, first: null, last: null };
  const hours = new Map(byHour.map((h) => [h._id, h]));
  return {
    total: c.total, outbound: c.outbound, inbound: c.inbound, connected: c.connected, notConnected: c.total - c.connected,
    connectRate: rate(c.connected, c.total), talkSeconds: c.talkSeconds,
    averageSeconds: c.connected ? Math.round(c.talkSeconds / c.connected) : 0, longestSeconds: c.longestSeconds,
    recorded: c.recorded, estimatedCalls: c.estimated, firstCallAt: c.first, lastCallAt: c.last,
    byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, calls: hours.get(h)?.calls || 0, connected: hours.get(h)?.connected || 0 })),
    byOutcome: byOutcome.map((o) => ({ outcome: o._id, count: o.count })),
  };
}

const CALL_FILTERS = {
  connected: { answeredAt: { $ne: null } },
  missed: { answeredAt: null },
  recorded: { hasRecording: true },
  outbound: { direction: 'outbound' },
  inbound: { direction: 'inbound' },
};

/** One employee's calls, newest first, with who they spoke to. */
export async function employeeCalls(orgId, userId, query) {
  const period = await reportPeriod(orgId, query);
  const filter = {
    organizationId: orgId, agentId: userId, startedAt: { $gte: period.start, $lt: period.end }, ...(CALL_FILTERS[query.filter] || {}),
  };
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
  const page = Math.max(Number(query.page) || 1, 1);
  const [total, calls] = await Promise.all([
    Call.countDocuments(filter),
    Call.find(filter).sort({ startedAt: -1 }).skip((page - 1) * limit).limit(limit)
      .select('direction status mode customerPhone startedAt answeredAt durationSeconds disposition notes hasRecording hasTranscript related source').lean(),
  ]);
  const ids = (key) => [...new Set(calls.map((c) => c.related?.[key]).filter(Boolean).map(String))];
  const [leads, contacts] = await Promise.all([
    Lead.find({ organizationId: orgId, _id: { $in: ids('leadId') } }).select('name company').lean(),
    Contact.find({ organizationId: orgId, _id: { $in: ids('contactId') } }).select('firstName lastName company').lean(),
  ]);
  const leadName = new Map(leads.map((l) => [String(l._id), l.name]));
  const contactName = new Map(contacts.map((c) => [String(c._id), `${c.firstName} ${c.lastName || ''}`.trim()]));
  return {
    period: { from: period.from, to: period.to, timeZone: period.timeZone },
    total, page, limit,
    items: calls.map((c) => {
      const leadId = c.related?.leadId ? String(c.related.leadId) : null;
      const contactId = c.related?.contactId ? String(c.related.contactId) : null;
      return {
        id: String(c._id), direction: c.direction, status: c.status, startedAt: c.startedAt, connected: Boolean(c.answeredAt),
        durationSeconds: c.durationSeconds || 0, durationEstimated: c.mode === 'native', phone: c.customerPhone || '',
        customer: (contactId && contactName.get(contactId)) || (leadId && leadName.get(leadId)) || '', leadId, contactId,
        outcome: c.disposition?.label || '', notes: c.disposition?.notes || c.notes || '',
        hasRecording: Boolean(c.hasRecording), hasTranscript: Boolean(c.hasTranscript), source: c.source || '',
      };
    }),
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
  const [leadsByDay, callsByDay, remarksByDay, leadStatus, recent, overdueTasks, leads, calls] = await Promise.all([
    countsByDay(Lead, { organizationId: org, ownerId: me, createdAt: inPeriod }, 'createdAt', period),
    countsByDay(Call, { organizationId: org, agentId: me, startedAt: inPeriod }, 'startedAt', period),
    countsByDay(Note, { organizationId: org, authorId: me, createdAt: inPeriod }, 'createdAt', period),
    Lead.aggregate([{ $match: { organizationId: org, ownerId: me, createdAt: inPeriod } }, { $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Activity.find({ organizationId: orgId, userId, occurredAt: inPeriod }).sort({ occurredAt: -1 }).limit(30).select('type title occurredAt links').lean(),
    Task.find({ organizationId: orgId, assigneeId: userId, status: 'open', dueAt: { $lt: new Date() } }).sort({ dueAt: 1 }).limit(20).select('title dueAt priority related').lean(),
    leadReport(orgId, { ...query, ownerId: userId }).then((r) => r.staleLeads),
    callSummary(orgId, userId, period),
  ]);
  return {
    period: { from: period.from, to: period.to, timeZone: period.timeZone },
    employee: stats,
    calls,
    bucket: bucketOf(period),
    byDay: fillDays(period, { leads: leadsByDay, calls: callsByDay, remarks: remarksByDay }),
    leadsByStatus: leadStatus.map((x) => ({ status: x._id, count: x.count })),
    recentActivity: recent.map((a) => ({ id: String(a._id), type: a.type, title: a.title, occurredAt: a.occurredAt, leadId: a.links?.leadId ? String(a.links.leadId) : null })),
    overdueTasks: overdueTasks.map((t) => ({ id: String(t._id), title: t.title, dueAt: t.dueAt, priority: t.priority })),
    staleLeads: leads,
  };
}
