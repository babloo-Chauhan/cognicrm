import { Router } from 'express';
import mongoose from 'mongoose';
import { Callback, Lead, Note, Task } from '../../models/index.js';
import { reportPeriod } from '../reports/service.js';

/**
 * The signed-in person's follow-ups, for the app's Follow-up tab: lead follow-up dates on leads they
 * have or had, their open tasks with a due time, and their pending callbacks — split into overdue,
 * today and upcoming (the next 30 days), in the company's time zone.
 */
const router = Router();
const UPCOMING_DAYS = 30;

router.get('/follow-ups', async (req, res) => {
  const now = new Date();
  const { timeZone } = await reportPeriod(req.orgId);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  const today = await reportPeriod(req.orgId, { from: day, to: day });
  const until = new Date(today.end.getTime() + UPCOMING_DAYS * 86400000);
  const me = req.user._id;
  const [leads, tasks, callbacks] = await Promise.all([
    Lead.find({
      organizationId: req.orgId, nextFollowUpAt: { $ne: null, $lt: until }, status: { $nin: ['converted', 'won', 'lost', 'unqualified'] },
      $or: [{ ownerId: me }, { assignees: me }],
    }).sort({ nextFollowUpAt: 1 }).limit(200).select('name company phone status score nextFollowUpAt ownerId').lean(),
    Task.find({ organizationId: req.orgId, assigneeId: me, status: 'open', dueAt: { $ne: null, $lt: until } })
      .sort({ dueAt: 1 }).limit(200).select('title description dueAt priority related').lean(),
    Callback.find({ organizationId: req.orgId, assignedAgentId: me, status: { $in: ['pending', 'notified'] }, scheduledAt: { $lt: until } })
      .sort({ scheduledAt: 1 }).limit(200).select('customerName phone scheduledAt priority notes related').lean(),
  ]);

  // Latest remark on each lead, so the list says where things stand
  const lastRemarks = leads.length ? await Note.aggregate([
    { $match: { organizationId: new mongoose.Types.ObjectId(String(req.orgId)), 'related.leadId': { $in: leads.map((l) => l._id) } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$related.leadId', body: { $first: '$body' }, at: { $first: '$createdAt' } } },
  ]) : [];
  const remarkOf = new Map(lastRemarks.map((r) => [String(r._id), r]));

  const items = [
    ...leads.map((l) => ({
      kind: 'lead', id: String(l._id), leadId: String(l._id), title: l.name, subtitle: l.company || '', phone: l.phone || '',
      at: l.nextFollowUpAt, status: l.status, score: l.score || 0, mine: String(l.ownerId) === String(me),
      lastRemark: remarkOf.get(String(l._id))?.body || '',
    })),
    ...tasks.map((t) => ({
      kind: 'task', id: String(t._id), title: t.title, subtitle: t.description || '', at: t.dueAt, priority: t.priority,
      leadId: t.related?.leadId ? String(t.related.leadId) : null, contactId: t.related?.contactId ? String(t.related.contactId) : null,
    })),
    ...callbacks.map((c) => ({
      kind: 'callback', id: String(c._id), title: c.customerName || c.phone, subtitle: c.notes || '', phone: c.phone, at: c.scheduledAt,
      priority: c.priority, leadId: c.related?.leadId ? String(c.related.leadId) : null, contactId: c.related?.contactId ? String(c.related.contactId) : null,
    })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at)).map((i) => ({ ...i, late: new Date(i.at) < now }));

  const overdue = items.filter((i) => new Date(i.at) < today.start);
  const todays = items.filter((i) => new Date(i.at) >= today.start && new Date(i.at) < today.end);
  const upcoming = items.filter((i) => new Date(i.at) >= today.end);
  // Earlier today but already past still counts as today, marked late
  res.json({
    overdue, today: todays, upcoming,
    counts: { overdue: overdue.length, today: todays.length, upcoming: upcoming.length },
    timeZone: today.timeZone,
  });
});

export default router;
