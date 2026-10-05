import { Router } from 'express';
import {
  Account, Activity, Appointment, Contact, Deal, Invoice, Lead, Task,
} from '../../models/index.js';
import { hasPermission } from '../../middleware/auth.js';
import { defaultPipeline } from './pipelines.js';

const router = Router();

/**
 * Company dashboard. Every query is filtered by the caller's organizationId (from the session),
 * so numbers are always tenant-specific. Sections the user cannot read are omitted.
 */
router.get('/dashboard', async (req, res) => {
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
    on('leads') && can('leads:read') ? Lead.aggregate([
      { $match: org },
      { $group: { _id: null, total: { $sum: 1 }, newThisMonth: { $sum: { $cond: [{ $gte: ['$createdAt', monthStart] }, 1, 0] } }, converted: { $sum: { $cond: [{ $in: ['$status', ['converted', 'won']] }, 1, 0] } } } },
    ]) : null,
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
  res.json({
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
  });
});

export default router;
