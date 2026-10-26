import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { addUser, http, registerOrg, useDatabase } from './helpers.js';
import { Deal, Lead, Task } from '../src/models/index.js';

useDatabase();

describe('dashboard insights', () => {
  it('counts leads and won deals by month, tasks and completion, and the latest activity', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    const year = new Date().getFullYear();
    const orgId = new mongoose.Types.ObjectId(admin.org.id);
    await http().post('/api/v1/leads').set(admin.auth).send({ name: 'L1' });
    await http().post('/api/v1/leads').set(admin.auth).send({ name: 'L2', ownerId: ravi.user.id });
    // Raw inserts keep the chosen createdAt (timestamps would overwrite it)
    const jan = new Date(Date.UTC(year, 0, 15, 6));
    await Lead.collection.insertMany([
      { organizationId: orgId, name: 'Jan', status: 'won', createdAt: jan, updatedAt: jan },
      { organizationId: orgId, name: 'Old', status: 'new', createdAt: new Date(Date.UTC(year - 1, 5, 1)), updatedAt: jan },
    ]);
    await Deal.create({ organizationId: admin.org.id, name: 'D1', stage: 'won', value: 5000 });
    await Deal.create({ organizationId: admin.org.id, name: 'D2', stage: 'qualification', value: 100 });
    const past = new Date(Date.now() - 86400000);
    await Task.create({ organizationId: admin.org.id, title: 'Done one', status: 'done', dueAt: past, assigneeId: admin.user.id });
    await Task.create({ organizationId: admin.org.id, title: 'Late one', status: 'open', dueAt: past, priority: 'high', assigneeId: ravi.user.id });
    await Task.create({ organizationId: admin.org.id, title: 'Later', status: 'open', dueAt: new Date(Date.now() + 86400000) });

    const res = await http().get('/api/v1/dashboard/insights').query({ year, period: 'week' }).set(admin.auth);
    expect(res.status).toBe(200);
    const b = res.body;
    const month = Number(new Intl.DateTimeFormat('en', { month: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date())) - 1;
    expect(b.leads.byMonth).toHaveLength(12);
    expect(b.leads.byMonth[0].won).toBeGreaterThanOrEqual(1);
    expect(b.leads.byMonth.reduce((a, m) => a + m.leads, 0)).toBe(3); // last year's lead is left out
    expect(b.leads.byStatus.won).toBe(1);
    expect(b.deals).toMatchObject({ open: 1, won: 1, lost: 0 });
    expect(b.deals.byMonth[month]).toEqual({ won: 1, value: 5000 });
    expect(b.tasks).toMatchObject({ total: 3, open: 2, overdue: 1, done: 1 });
    expect(b.tasks.recent[0]).toMatchObject({ title: 'Late one', priority: 'high', assignee: 'Ravi' });
    expect(b.taskPerformance).toMatchObject({ total: 2, done: 1, percent: 50 });
    expect(b.activity[0].title).toContain('Lead');

    // Ravi sees only his own tasks and leads
    const mine = (await http().get('/api/v1/dashboard/insights').query({ year }).set(ravi.auth)).body;
    expect(mine.tasks).toMatchObject({ total: 1, open: 1 });
    expect(mine.leads.byMonth.reduce((a, m) => a + m.leads, 0)).toBe(1);
  });
});
