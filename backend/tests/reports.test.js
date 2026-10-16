import { describe, expect, it } from 'vitest';
import { addUser, http, registerOrg, useDatabase } from './helpers.js';
import { Lead, Task } from '../src/models/index.js';

useDatabase();

// The company's day (Asia/Kolkata), not the UTC one
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

describe('employee reports', () => {
  it('only the company admin sees employee-wise reports', async () => {
    const admin = await registerOrg();
    for (const role of ['supervisor', 'sales_manager', 'sales_executive', 'employee']) {
      const u = await addUser(admin, { role });
      expect((await http().get('/api/v1/reports/team').set(u.auth)).status).toBe(403);
      expect((await http().get('/api/v1/reports/leads').set(u.auth)).status).toBe(403);
      expect((await http().get(`/api/v1/reports/employees/${admin.user.id}`).set(u.auth)).status).toBe(403);
    }
    expect((await http().get('/api/v1/reports/team').set(admin.auth)).status).toBe(200);
  });

  it('counts each employee\'s leads, remarks, tasks and wins, and stays inside the company', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    const sita = await addUser(admin, { role: 'sales_executive', name: 'Sita' });
    const other = await registerOrg('Other Co');
    await http().post('/api/v1/leads').set(other.auth).send({ name: 'Not ours' });

    const mk = (who, body) => http().post('/api/v1/leads').set(who.auth).send(body).then((r) => r.body);
    const l1 = await mk(ravi, { name: 'A One', phone: '9876500001' });
    const l2 = await mk(ravi, { name: 'B Two', phone: '9876500002' });
    await mk(ravi, { name: 'C Three' });
    await mk(sita, { name: 'D Four' });
    await http().patch(`/api/v1/leads/${l2.id}`).set(ravi.auth).send({ status: 'lost' });
    await http().post(`/api/v1/leads/${l1.id}/convert`).set(admin.auth).send({}); // creates a deal owned by Ravi
    const deal = (await http().get('/api/v1/deals').set(admin.auth)).body.items[0];
    await http().patch(`/api/v1/deals/${deal.id}`).set(admin.auth).send({ stage: 'won', value: 50000 });
    await http().post('/api/v1/notes').set(ravi.auth).send({ body: 'Called', related: { leadId: l1.id } });
    await http().post('/api/v1/notes').set(ravi.auth).send({ body: 'Called again', related: { leadId: l1.id } });
    const task = await http().post('/api/v1/tasks').set(ravi.auth).send({ title: 'Send samples', assigneeId: ravi.user.id }).then((r) => r.body);
    await http().patch(`/api/v1/tasks/${task.id}`).set(ravi.auth).send({ status: 'done' });
    await Task.create({ organizationId: admin.org.id, title: 'Late', assigneeId: sita.user.id, dueAt: new Date(Date.now() - 86400000) });
    // A lead nobody has touched for 10 days
    await Lead.collection.updateOne({ name: 'D Four' }, { $set: { createdAt: new Date(Date.now() - 10 * 86400000) } });

    const res = await http().get('/api/v1/reports/team').query({ from: '2020-01-01', to: today() }).set(admin.auth);
    expect(res.status).toBe(200);
    const r = res.body.employees.find((e) => e.name === 'Ravi');
    expect(r).toMatchObject({
      leadsAssigned: 3, leadsConverted: 1, leadsDropped: 1, leadsUntouched: 1, conversionRate: 33.3,
      remarks: 2, tasksDone: 1, dealsWon: 1, wonValue: 50000, openLeads: 1,
    });
    const s = res.body.employees.find((e) => e.name === 'Sita');
    expect(s).toMatchObject({ leadsAssigned: 1, overdueTasks: 1, staleLeads: 1 });
    expect(res.body.employees[0].name).toBe('Ravi'); // best performer first
    expect(res.body.totals.leadsAssigned).toBe(4);

    // A period before anything happened is empty, but still lists the team
    const empty = await http().get('/api/v1/reports/team').query({ from: '2020-01-01', to: '2020-01-31' }).set(admin.auth);
    expect(empty.body.totals.leadsAssigned).toBe(0);
    expect(empty.body.employees.map((e) => e.name)).toContain('Ravi');

    const leads = await http().get('/api/v1/reports/leads').query({ from: '2020-01-01', to: today() }).set(admin.auth);
    expect(leads.body.totals).toMatchObject({ leads: 4, converted: 1, dropped: 1, open: 2 });
    expect(leads.body.staleLeads.map((l) => l.name)).toEqual(['D Four']);
    // Long periods are charted by month, short ones by day
    expect(leads.body.bucket).toBe('month');
    expect(leads.body.byDay.at(-1).date).toBe(today().slice(0, 7));
    const week = await http().get('/api/v1/reports/leads').query({ from: today(), to: today() }).set(admin.auth);
    expect(week.body.byDay).toEqual([{ date: today(), new: 3, converted: 1 }]);
    const ravisLeads = await http().get('/api/v1/reports/leads').query({ from: '2020-01-01', to: today(), ownerId: ravi.user.id }).set(admin.auth);
    expect(ravisLeads.body.totals.leads).toBe(3);

    const one = await http().get(`/api/v1/reports/employees/${ravi.user.id}`).query({ from: '2020-01-01', to: today() }).set(admin.auth);
    expect(one.status).toBe(200);
    expect(one.body.employee.leadsAssigned).toBe(3);
    expect(one.body.byDay.reduce((n, d) => n + d.remarks, 0)).toBe(2);
    expect(one.body.recentActivity.length).toBeGreaterThan(0);
    // Someone from another company is not found
    expect((await http().get(`/api/v1/reports/employees/${other.user.id}`).set(admin.auth)).status).toBe(404);
  });
});
