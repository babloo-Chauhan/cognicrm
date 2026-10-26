import { Router } from 'express';
import {
  Account, Activity, Appointment, Contact, Deal, Invoice, Lead, Organization, Task, User,
} from '../../models/index.js';
import { hasPermission } from '../../middleware/auth.js';
import { defaultPipeline } from './pipelines.js';
import { cached } from '../../lib/cache.js';
import { leadScopeFor } from './leadAccess.js';

const router = Router();

/**
 * Company dashboard. Every query is filtered by the caller's organizationId (from the session),
 * so numbers are always tenant-specific. Sections the user cannot read are omitted.
 */
router.get('/dashboard', async (req, res) => {
  // Per user: sections depend on the user's permissions. Fresh after any CRM write (bumpCompany), else 60 s.
  res.json(await cached(req.orgId, `dashboard:${req.user._id}`, 60, () => buildDashboard(req)));
});

async function buildDashboard(req) {
  const org = { organizationId: req.orgId };
  const can = (p) => hasPermission(req.user, p);
  const now = new Date();
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekAhead = new Date(now.getTime() + 7 * 86400000);
  const modules = req.tenant.modules;
  const on = (m) => modules.includes(m);

  const [leadStats, customers, dealStats, pipeline, pendingTasks, todaysActivities, upcomingMeetings, paid] = await Promise.all([
    // Three index-backed counts instead of reading every lead
    on('leads') && can('leads:read') ? Promise.all([
      Lead.countDocuments({ ...org, ...leadScopeFor(req.user) }),
      Lead.countDocuments({ ...org, ...leadScopeFor(req.user), createdAt: { $gte: monthStart } }),
      Lead.countDocuments({ ...org, ...leadScopeFor(req.user), status: { $in: ['converted', 'won'] } }),
    ]).then(([total, newThisMonth, converted]) => [{ total, newThisMonth, converted }]) : null,
    on('customers') && can('contacts:read') ? Promise.all([Contact.countDocuments(org), Account.countDocuments(org)]) : null,
    on('deals') && can('deals:read') ? Deal.aggregate([
      { $match: org },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          won: { $sum: { $cond: [{ $eq: ['$stage', 'won'] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ['$stage', 'lost'] }, 1, 0] } },
          wonValue: { $sum: { $cond: [{ $eq: ['$stage', 'won'] }, '$value', 0] } },
          openValue: { $sum: { $cond: [{ $in: ['$stage', ['won', 'lost']] }, 0, '$value'] } },
        },
      },
    ]) : null,
    on('deals') && can('deals:read') ? Deal.aggregate([{ $match: org }, { $group: { _id: '$stage', count: { $sum: 1 }, value: { $sum: '$value' } } }]) : null,
    on('tasks') ? Task.countDocuments({ ...org, status: 'open', ...(can('tasks:read') ? {} : { assigneeId: req.user._id }) }) : null,
    Activity.countDocuments({ ...org, occurredAt: { $gte: dayStart, $lt: dayEnd } }),
    on('calendar') ? Appointment.find({ ...org, status: 'scheduled', startAt: { $gte: now, $lte: weekAhead } }).sort({ startAt: 1 }).limit(5).lean() : null,
    on('invoices') && can('sales:read') ? Invoice.aggregate([{ $match: org }, { $group: { _id: null, paid: { $sum: '$amountPaid' } } }]).catch(() => []) : null,
  ]);

  const leads = leadStats?.[0] || { total: 0, newThisMonth: 0, converted: 0 };
  const deals = dealStats?.[0] || { total: 0, won: 0, lost: 0, wonValue: 0, openValue: 0 };
  let stages = null;
  if (pipeline) {
    const def = await defaultPipeline(req.orgId);
    const byKey = Object.fromEntries(pipeline.map((p) => [p._id, p]));
    stages = def.stages.map((s) => ({ key: s.key, label: s.label, count: byKey[s.key]?.count || 0, value: byKey[s.key]?.value || 0 }));
  }
  const closed = deals.won + deals.lost;
  return {
    leads: leadStats ? { total: leads.total, newThisMonth: leads.newThisMonth, converted: leads.converted } : null,
    customers: customers ? { contacts: customers[0], accounts: customers[1], total: customers[0] + customers[1] } : null,
    deals: dealStats ? { total: deals.total, won: deals.won, lost: deals.lost, open: deals.total - closed, openValue: deals.openValue } : null,
    revenue: { wonDeals: deals.wonValue, invoicesPaid: paid?.[0]?.paid || 0 },
    pendingTasks,
    todaysActivities,
    upcomingMeetings,
    pipeline: stages,
    conversionRate: {
      leads: leads.total ? Math.round((leads.converted / leads.total) * 1000) / 10 : 0,
      deals: closed ? Math.round((deals.won / closed) * 1000) / 10 : 0,
    },
  };
}

const PERIODS = { week: 7, month: 30, year: 365 };

/**
 * Dashboard widgets: latest activity, recent tasks with counts, task completion for a period, and month by
 * month leads and won deals for a year. Employees see their own tasks / activity / leads; the admin sees the company.
 */
router.get('/dashboard/insights', async (req, res) => {
  const year = Math.min(Math.max(Number(req.query.year) || new Date().getFullYear(), 2000), 2100);
  const period = PERIODS[req.query.period] ? req.query.period : 'year';
  res.json(await cached(req.orgId, `insights:${req.user._id}:${year}:${period}`, 60, () => buildInsights(req, year, period)));
});

async function buildInsights(req, year, period) {
  const org = { organizationId: req.orgId };
  const can = (p) => hasPermission(req.user, p);
  const on = (m) => req.tenant.modules.includes(m);
  const now = new Date();
  const settings = await Organization.findById(req.orgId).select('settings.timezone').lean();
  const timezone = settings?.settings?.timezone || 'Asia/Kolkata';
  const seeAll = can('team_leads:view_all');
  const taskScope = { ...org, ...(seeAll && can('tasks:read') ? {} : { assigneeId: req.user._id }) };
  const leadScope = { ...org, ...(leadScopeFor(req.user) || {}) };
  // Calendar year and month in the company's time zone
  const inYear = (field) => ({ $expr: { $eq: [{ $year: { date: `$${field}`, timezone } }, year] } });
  const monthOf = (field) => ({ $month: { date: `$${field}`, timezone } });
  const since = new Date(now.getTime() - PERIODS[period] * 86400000);
  const leadsOn = on('leads') && can('leads:read');
  const dealsOn = on('deals') && can('deals:read');

  const [activity, taskCounts, recentTasks, performance, leadMonths, leadStatus, dealMonths, dealStages] = await Promise.all([
    Activity.find({ ...org, ...(seeAll ? {} : { userId: req.user._id }) }).sort({ occurredAt: -1 }).limit(8).select('type title occurredAt userId links').lean(),
    on('tasks') ? Task.aggregate([
      { $match: taskScope },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
          overdue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'open'] }, { $gt: ['$dueAt', null] }, { $lt: ['$dueAt', now] }] }, 1, 0] } },
          done: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } },
        },
      },
    ]) : null,
    on('tasks') ? Task.find({ ...taskScope, status: 'open' }).sort({ dueAt: 1, _id: 1 }).limit(5).select('title dueAt priority assigneeId').lean() : null,
    // Completion for the period: tasks due in it (or created in it, when undated) that are done
    on('tasks') ? Task.aggregate([
      { $match: { ...taskScope, status: { $ne: 'cancelled' }, $or: [{ dueAt: { $gte: since, $lte: now } }, { dueAt: null, createdAt: { $gte: since } }] } },
      { $group: { _id: null, total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } } } },
    ]) : null,
    leadsOn ? Lead.aggregate([
      { $match: { ...leadScope, ...inYear('createdAt') } },
      { $group: { _id: monthOf('createdAt'), leads: { $sum: 1 }, won: { $sum: { $cond: [{ $in: ['$status', ['won', 'converted']] }, 1, 0] } } } },
    ]) : null,
    leadsOn ? Lead.aggregate([{ $match: { ...leadScope, ...inYear('createdAt') } }, { $group: { _id: '$status', count: { $sum: 1 } } }]) : null,
    dealsOn ? Deal.aggregate([
      { $match: { ...org, stage: 'won', ...inYear('updatedAt') } },
      { $group: { _id: monthOf('updatedAt'), won: { $sum: 1 }, value: { $sum: { $ifNull: ['$value', 0] } } } },
    ]) : null,
    dealsOn ? Deal.aggregate([{ $match: { ...org, ...inYear('createdAt') } }, { $group: { _id: '$stage', count: { $sum: 1 } } }]) : null,
  ]);

  const userIds = [...new Set([...activity.map((a) => a.userId), ...(recentTasks || []).map((t) => t.assigneeId)].filter(Boolean).map(String))];
  const names = new Map((await User.find({ ...org, _id: { $in: userIds } }).select('name').lean()).map((u) => [String(u._id), u.name]));
  const nameOf = (id) => (id ? names.get(String(id)) || null : null);
  const months = (rows, pick) => Array.from({ length: 12 }, (_, i) => pick(rows.find((r) => r._id === i + 1) || {}));
  const counts = taskCounts?.[0] || { total: 0, open: 0, overdue: 0, done: 0 };
  const perf = performance?.[0] || { total: 0, done: 0 };
  const stages = Object.fromEntries((dealStages || []).map((s) => [s._id, s.count]));
  const idOf = (v) => (v ? String(v) : null);
  return {
    year,
    period,
    activity: activity.map((a) => ({
      id: String(a._id), type: a.type, title: a.title, at: a.occurredAt, user: nameOf(a.userId),
      leadId: idOf(a.links?.leadId), dealId: idOf(a.links?.dealId), contactId: idOf(a.links?.contactId),
    })),
    tasks: recentTasks ? {
      total: counts.total, open: counts.open, overdue: counts.overdue, done: counts.done,
      recent: recentTasks.map((t) => ({ id: String(t._id), title: t.title, dueAt: t.dueAt, priority: t.priority, assigneeId: idOf(t.assigneeId), assignee: nameOf(t.assigneeId) })),
    } : null,
    taskPerformance: performance ? { total: perf.total, done: perf.done, percent: perf.total ? Math.round((perf.done / perf.total) * 10000) / 100 : 0 } : null,
    leads: leadMonths ? {
      byMonth: months(leadMonths, (r) => ({ leads: r.leads || 0, won: r.won || 0 })),
      byStatus: Object.fromEntries(leadStatus.map((s) => [s._id, s.count])),
    } : null,
    deals: dealMonths ? {
      byMonth: months(dealMonths, (r) => ({ won: r.won || 0, value: r.value || 0 })),
      open: Object.entries(stages).filter(([k]) => !['won', 'lost'].includes(k)).reduce((a, [, c]) => a + c, 0),
      won: stages.won || 0,
      lost: stages.lost || 0,
    } : null,
  };
}

export default router;
