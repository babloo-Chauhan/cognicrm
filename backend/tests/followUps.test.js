import { describe, expect, it } from 'vitest';
import { addUser, http, registerOrg, useDatabase } from './helpers.js';
import { Callback } from '../src/models/index.js';
import { remindLeadFollowUps } from '../src/modules/notifications/reminders.js';

useDatabase();

// Times relative to the start of today in India, so the test passes at any hour
const istMidnight = () => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return new Date(`${day}T00:00:00+05:30`);
};
const at = (days, hours = 0) => new Date(istMidnight().getTime() + days * 86400000 + hours * 3600000).toISOString();

describe('follow-ups', () => {
  it('lists my lead follow-ups, tasks and callbacks as overdue / today / upcoming', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    const sita = await addUser(admin, { role: 'sales_executive', name: 'Sita' });
    const mk = (body) => http().post('/api/v1/leads').set(ravi.auth).send(body).then((r) => r.body);
    const late = await mk({ name: 'Late Lead', phone: '9876500101', nextFollowUpAt: at(-2, 11) });
    await mk({ name: 'Today Lead', nextFollowUpAt: at(0, 23) });
    await mk({ name: 'Next Week Lead', nextFollowUpAt: at(6, 10) });
    await mk({ name: 'No Date Lead' });
    await mk({ name: 'Won Lead', status: 'won', nextFollowUpAt: at(0, 23) }); // closed leads need no follow-up
    await http().post('/api/v1/notes').set(ravi.auth).send({ body: 'Asked to call after Diwali', related: { leadId: late.id } });
    await http().post('/api/v1/tasks').set(ravi.auth).send({ title: 'Send samples', assigneeId: ravi.user.id, dueAt: at(0, 23) });
    await Callback.create({ organizationId: admin.org.id, phone: '+919876500102', customerName: 'Callback Person', assignedAgentId: ravi.user.id, scheduledAt: at(1, 10) });
    await http().post('/api/v1/leads').set(sita.auth).send({ name: 'Sita Lead', nextFollowUpAt: at(0, 23) }); // not Ravi's

    const res = await http().get('/api/v1/follow-ups').set(ravi.auth);
    expect(res.status).toBe(200);
    const names = (list) => list.map((i) => `${i.kind}:${i.title}`);
    expect(names(res.body.overdue)).toEqual(['lead:Late Lead']);
    expect(names(res.body.today).sort()).toEqual(['lead:Today Lead', 'task:Send samples']);
    expect(names(res.body.upcoming)).toEqual(['callback:Callback Person', 'lead:Next Week Lead']);
    expect(res.body.counts).toEqual({ overdue: 1, today: 2, upcoming: 2 });
    expect(res.body.overdue[0]).toMatchObject({ phone: '+919876500101', lastRemark: 'Asked to call after Diwali' });

    // Passing the lead on keeps the follow-up with both people
    await http().patch(`/api/v1/leads/${late.id}`).set(ravi.auth).send({ ownerId: sita.user.id });
    expect(names((await http().get('/api/v1/follow-ups').set(sita.auth)).body.overdue)).toEqual(['lead:Late Lead']);
    expect(names((await http().get('/api/v1/follow-ups').set(ravi.auth)).body.overdue)).toEqual(['lead:Late Lead']);

    // Done: clearing the date takes it off the list
    await http().patch(`/api/v1/leads/${late.id}`).set(ravi.auth).send({ nextFollowUpAt: null });
    expect((await http().get('/api/v1/follow-ups').set(ravi.auth)).body.counts.overdue).toBe(0);
  });

  it('reminds the lead holder once when the follow-up is due, again after a reschedule', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    const lead = (await http().post('/api/v1/leads').set(ravi.auth).send({ name: 'Due Lead', phone: '9876500103', nextFollowUpAt: new Date(Date.now() - 60000).toISOString() })).body;
    expect(await remindLeadFollowUps()).toBe(1);
    expect(await remindLeadFollowUps()).toBe(0);
    const note = (await http().get('/api/v1/notifications').set(ravi.auth)).body.items.find((n) => n.type === 'lead_follow_up');
    expect(note.data).toMatchObject({ leadId: lead.id, phone: '+919876500103', action: 'call' });
    // Clients cannot fake the reminder state; a new time re-arms it
    await http().patch(`/api/v1/leads/${lead.id}`).set(ravi.auth).send({ followUpReminderSentAt: null });
    expect(await remindLeadFollowUps()).toBe(0);
    await http().patch(`/api/v1/leads/${lead.id}`).set(ravi.auth).send({ nextFollowUpAt: new Date(Date.now() - 1000).toISOString() });
    expect(await remindLeadFollowUps()).toBe(1);
  });
});
