import { describe, expect, it } from 'vitest';
import { addUser, http, registerOrg, useDatabase } from './helpers.js';
import { Callback, Notification, Organization, PushToken } from '../src/models/index.js';
import { remindDueTasks, remindUpcomingAppointments } from '../src/modules/notifications/reminders.js';

useDatabase();

const mine = (user, type) => Notification.find({ userId: user.id, type }).lean();

describe('follow-up reminders', () => {
  it('reminds the assignee once when a task falls due, and again after it is rescheduled', async () => {
    const admin = await registerOrg();
    const past = new Date(Date.now() - 60000).toISOString();
    const task = await http().post('/api/v1/tasks').set(admin.auth).send({ title: 'Send quote', dueAt: past });
    expect(String(task.body.assigneeId)).toBe(String(admin.user.id));

    expect(await remindDueTasks()).toBe(1);
    expect(await remindDueTasks()).toBe(0);
    const [n] = await mine(admin.user, 'task_due');
    expect(n).toMatchObject({ title: '⏰ Follow-up due: Send quote', data: { taskId: task.body.id } });

    await http().patch(`/api/v1/tasks/${task.body.id}`).set(admin.auth).send({ dueAt: new Date(Date.now() - 1000).toISOString() });
    expect(await remindDueTasks()).toBe(1);

    await http().patch(`/api/v1/tasks/${task.body.id}`).set(admin.auth).send({ status: 'done' });
    expect(await remindDueTasks()).toBe(0);
  });

  it('does not remind tasks that are not due yet', async () => {
    const admin = await registerOrg();
    await http().post('/api/v1/tasks').set(admin.auth).send({ title: 'Later', dueAt: new Date(Date.now() + 3600000).toISOString() });
    expect(await remindDueTasks()).toBe(0);
  });

  it('tells a teammate when a task is assigned to them, but not the person assigning to themself', async () => {
    const admin = await registerOrg();
    const agent = await addUser(admin);
    await http().post('/api/v1/tasks').set(admin.auth).send({ title: 'Call Mehta', assigneeId: agent.user.id });
    await http().post('/api/v1/tasks').set(admin.auth).send({ title: 'My own task' });
    expect(await mine(agent.user, 'task_assigned')).toHaveLength(1);
    expect(await mine(admin.user, 'task_assigned')).toHaveLength(0);
  });

  it('reminds the owner shortly before an appointment', async () => {
    const admin = await registerOrg();
    const in10 = new Date(Date.now() + 10 * 60000);
    await http().post('/api/v1/appointments').set(admin.auth).send({ title: 'Demo', startAt: in10, endAt: new Date(in10.getTime() + 3600000) });
    const in2h = new Date(Date.now() + 2 * 3600000);
    await http().post('/api/v1/appointments').set(admin.auth).send({ title: 'Later demo', startAt: in2h, endAt: new Date(in2h.getTime() + 3600000) });
    expect(await remindUpcomingAppointments()).toBe(1);
    expect(await remindUpcomingAppointments()).toBe(0);
    const [n] = await mine(admin.user, 'appointment_reminder');
    expect(n.title).toBe('📅 Demo');
    expect(n.body).toMatch(/Starts in (9|10) min/);
  });
});

describe('push devices', () => {
  it('registers, counts and removes a phone', async () => {
    const admin = await registerOrg();
    await http().post('/api/v1/push-tokens').set(admin.auth).send({ token: 'fcm-token-abcdef', platform: 'android', provider: 'fcm' }).expect(204);
    expect((await http().get('/api/v1/push-tokens').set(admin.auth)).body).toEqual({ devices: 1, platforms: ['android'] });
    await http().delete('/api/v1/push-tokens').set(admin.auth).send({ token: 'fcm-token-abcdef' }).expect(204);
    expect(await PushToken.countDocuments({ userId: admin.user.id })).toBe(0);
  });

  it('a web click-to-call is sent to the linked phone as a dial request', async () => {
    const admin = await registerOrg();
    const none = await http().post('/api/v1/calls').set(admin.auth).send({ to: '9876543210', mode: 'device' });
    expect(none.status).toBe(400);

    await http().post('/api/v1/push-tokens').set(admin.auth).send({ token: 'fcm-token-abcdef', platform: 'android', provider: 'fcm' });
    const res = await http().post('/api/v1/calls').set(admin.auth).send({ to: '9876543210', mode: 'device', name: 'Rahul' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sentToDevice: true, call: { mode: 'native', status: 'initiated' } });
    const [n] = await mine(admin.user, 'dial_request');
    expect(n).toMatchObject({ title: '📞 Call Rahul', data: { callId: res.body.call.id, phone: '+919876543210' } });
  });
});

describe('callbacks at the time the customer asked for', () => {
  it('schedules, names the customer, warns outside calling hours and re-arms the reminder on reschedule', async () => {
    const admin = await registerOrg();
    const lead = await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Priya Verma', phone: '9123456780' });
    const past = await http().post('/api/v1/callbacks').set(admin.auth)
      .send({ phone: '9123456780', scheduledAt: new Date(Date.now() - 3600000).toISOString() });
    expect(past.status).toBe(400);

    const in2h = new Date(Date.now() + 2 * 3600000).toISOString();
    const cb = await http().post('/api/v1/callbacks').set(admin.auth)
      .send({ phone: '9123456780', related: { leadId: lead.body.id }, scheduledAt: in2h, notes: 'After 6 pm' });
    expect(cb.status).toBe(201);
    expect(cb.body).toMatchObject({ customerName: 'Priya Verma', phone: '+919123456780', status: 'pending', outsideCallingHours: false });

    // Calling hours that never include this time → saved, with a warning.
    await Organization.updateOne({ _id: admin.org.id }, { $set: { 'settings.compliance.callingHours': { enabled: true, start: '09:00', end: '18:00', days: [7], timezone: 'UTC' } } });
    await Callback.updateOne({ _id: cb.body.id }, { status: 'notified', notifiedAt: new Date() });
    const late = await http().patch(`/api/v1/callbacks/${cb.body.id}`).set(admin.auth).send({ scheduledAt: new Date(Date.now() + 3 * 3600000).toISOString() });
    expect(late.status).toBe(200);
    expect(late.body.outsideCallingHours).toBe(true);
    expect(late.body.status).toBe('pending');
    expect(late.body.notifiedAt).toBeUndefined();
  });
});
