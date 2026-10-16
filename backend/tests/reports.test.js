import { describe, expect, it } from 'vitest';
import { addUser, http, registerOrg, useDatabase } from './helpers.js';
import { Call, Lead, Task } from '../src/models/index.js';

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

  it('shows how many calls an employee made, for how long, and which have recordings', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    const sita = await addUser(admin, { role: 'sales_executive', name: 'Sita' });
    const lead = await http().post('/api/v1/leads').set(ravi.auth).send({ name: 'Anil Gupta', phone: '9876501234' }).then((r) => r.body);
    const at = (minsAgo) => new Date(Date.now() - minsAgo * 60000);
    const base = { organizationId: admin.org.id, agentId: ravi.user.id, direction: 'outbound', customerPhone: '+919876501234' };
    await Call.create([
      { ...base, status: 'completed', startedAt: at(30), answeredAt: at(30), durationSeconds: 120, related: { leadId: lead.id },
        disposition: { code: 'interested', label: 'Interested', notes: 'Wants a demo' }, hasRecording: true },
      { ...base, status: 'completed', mode: 'native', startedAt: at(20), answeredAt: at(20), durationSeconds: 300 },
      { ...base, status: 'no_answer', startedAt: at(10), durationSeconds: 0 },
      { ...base, direction: 'inbound', status: 'completed', startedAt: at(5), answeredAt: at(5), durationSeconds: 60 },
      { ...base, agentId: sita.user.id, status: 'completed', startedAt: at(5), answeredAt: at(5), durationSeconds: 999 },
    ]);
    const q = { from: '2020-01-01', to: today() };
    const rep = await http().get(`/api/v1/reports/employees/${ravi.user.id}`).query(q).set(admin.auth);
    expect(rep.body.calls).toMatchObject({
      total: 4, outbound: 3, inbound: 1, connected: 3, notConnected: 1, talkSeconds: 480, averageSeconds: 160,
      longestSeconds: 300, recorded: 1, estimatedCalls: 1, connectRate: 75,
    });
    expect(rep.body.calls.byHour).toHaveLength(24);
    expect(rep.body.calls.byOutcome).toEqual(expect.arrayContaining([
      { outcome: 'Interested', count: 1 }, { outcome: 'Not connected', count: 1 }, { outcome: 'Connected (no outcome chosen)', count: 2 },
    ]));

    const list = await http().get(`/api/v1/reports/employees/${ravi.user.id}/calls`).query(q).set(admin.auth);
    expect(list.body.total).toBe(4);
    expect(list.body.items.map((c) => c.durationSeconds)).toEqual([60, 0, 300, 120]); // newest first
    const first = list.body.items.at(-1);
    expect(first).toMatchObject({ customer: 'Anil Gupta', leadId: lead.id, outcome: 'Interested', notes: 'Wants a demo', hasRecording: true, connected: true });
    expect(list.body.items[2].durationEstimated).toBe(true);
    const recorded = await http().get(`/api/v1/reports/employees/${ravi.user.id}/calls`).query({ ...q, filter: 'recorded' }).set(admin.auth);
    expect(recorded.body.items.map((c) => c.id)).toEqual([first.id]);
    const missed = await http().get(`/api/v1/reports/employees/${ravi.user.id}/calls`).query({ ...q, filter: 'missed' }).set(admin.auth);
    expect(missed.body.total).toBe(1);
    expect((await http().get(`/api/v1/reports/employees/${ravi.user.id}/calls`).set(sita.auth)).status).toBe(403);
  });
});
