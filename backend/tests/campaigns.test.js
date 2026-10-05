import { describe, expect, it } from 'vitest';
import {
  addUser, drainListeners, enableTelephony, http, ops, registerOrg, useDatabase, webhook,
} from './helpers.js';
import { AgentStatus, Call, Callback, CallCampaignContact, DncEntry } from '../src/models/index.js';
import { runDialerTick } from '../src/modules/campaigns/service.js';
import { processDueCallbacks } from '../src/modules/callbacks/service.js';

useDatabase();

const allDay = { timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00' };

async function setup(mode = 'preview') {
  const admin = await registerOrg();
  const agent = await addUser(admin, { role: 'agent', name: 'Dialer Agent' });
  const number = await enableTelephony(admin.org.id);
  await DncEntry.create({ organizationId: admin.org.id, phone: '+919800000003' });
  const lead = await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Lead One', phone: '9800000001' });
  const campaign = await http().post('/api/v1/call-campaigns').set(admin.auth).send({
    name: 'October outreach', mode, agentIds: [agent.user.id], schedule: allDay,
    retryPolicy: { maxAttempts: 2, retryDelayMinutes: 30 }, dispositionRules: [{ code: 'not_interested', action: 'dnc' }],
  });
  return { admin, agent, number, lead, campaign: campaign.body };
}

describe('call campaigns', () => {
  it('imports contacts with validation, DNC filtering and de-duplication', async () => {
    const { admin, lead, campaign } = await setup();
    const res = await http().post(`/api/v1/call-campaigns/${campaign.id}/contacts`).set(admin.auth).send({
      leadIds: [lead.body.id],
      rows: [{ name: 'Two', phone: '9800000002' }, { name: 'Dup', phone: '+919800000002' }, { name: 'Bad', phone: '12' }, { name: 'DNC', phone: '9800000003' }],
    });
    expect(res.body).toEqual({ added: 2, invalid: 1, dnc: 1, duplicates: 1 });
  });

  it('requires a caller ID to start and runs the preview dialer with retries', async () => {
    const { admin, agent, number, lead, campaign } = await setup();
    await http().post(`/api/v1/call-campaigns/${campaign.id}/contacts`).set(admin.auth).send({ leadIds: [lead.body.id] });
    expect((await http().post(`/api/v1/call-campaigns/${campaign.id}/start`).set(admin.auth)).status).toBe(400);
    await http().patch(`/api/v1/call-campaigns/${campaign.id}`).set(admin.auth).send({ callerIdNumberId: String(number._id) });
    expect((await http().post(`/api/v1/call-campaigns/${campaign.id}/start`).set(admin.auth)).body.status).toBe('running');

    const next = await http().get(`/api/v1/call-campaigns/${campaign.id}/next`).set(agent.auth);
    expect(next.body.contact.name).toBe('Lead One');
    expect(next.body.context.lead.id ?? String(next.body.context.lead._id)).toBe(lead.body.id);

    const dial = await http().post(`/api/v1/call-campaigns/${campaign.id}/contacts/${next.body.contact.id}/dial`).set(agent.auth).send({});
    expect(dial.status).toBe(201);
    const call = await Call.findById(dial.body.call.id);
    expect(String(call.campaignId)).toBe(campaign.id);

    // agent answers, customer doesn't → retry scheduled
    await webhook({ evt: 'status', callId: call.id, leg: 'agent' }, { CallSid: call.providerLegs[0].providerCallId, CallStatus: 'in-progress' });
    const cust = (await Call.findById(call.id)).providerLegs.find((l) => l.role === 'customer');
    await webhook({ evt: 'status', callId: call.id, leg: 'customer' }, { CallSid: cust.providerCallId, CallStatus: 'no-answer' });
    await drainListeners();
    const entry = await CallCampaignContact.findById(next.body.contact.id);
    expect(entry.status).toBe('pending');
    expect(entry.attempts).toBe(1);
    expect(entry.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 25 * 60000);

    // not due yet → nothing to preview
    expect((await http().get(`/api/v1/call-campaigns/${campaign.id}/next`).set(agent.auth)).body.contact).toBeNull();

    const stats = await http().get(`/api/v1/call-campaigns/${campaign.id}`).set(admin.auth);
    expect(stats.body).toMatchObject({ calls: 1, connected: 0 });
  });

  it('applies disposition rules (DNC) and skip/callback actions', async () => {
    const { admin, agent, number, campaign } = await setup();
    await http().patch(`/api/v1/call-campaigns/${campaign.id}`).set(admin.auth).send({ callerIdNumberId: String(number._id) });
    await http().post(`/api/v1/call-campaigns/${campaign.id}/contacts`).set(admin.auth).send({ rows: [{ name: 'A', phone: '9800000011' }, { name: 'B', phone: '9800000012' }, { name: 'C', phone: '9800000013' }] });
    await http().post(`/api/v1/call-campaigns/${campaign.id}/start`).set(admin.auth);

    const first = (await http().get(`/api/v1/call-campaigns/${campaign.id}/next`).set(agent.auth)).body.contact;
    const dial = await http().post(`/api/v1/call-campaigns/${campaign.id}/contacts/${first.id}/dial`).set(agent.auth).send({});
    await http().post(`/api/v1/calls/${dial.body.call.id}/disposition`).set(agent.auth).send({ code: 'not_interested' });
    expect((await CallCampaignContact.findById(first.id)).status).toBe('dnc');
    expect(await DncEntry.exists({ phone: first.phone })).toBeTruthy();
    await http().post(`/api/v1/calls/${dial.body.call.id}/hangup`).set(agent.auth);

    const second = (await http().get(`/api/v1/call-campaigns/${campaign.id}/next`).set(agent.auth)).body.contact;
    expect((await http().post(`/api/v1/call-campaigns/${campaign.id}/contacts/${second.id}/skip`).set(agent.auth)).body.status).toBe('skipped');
    const third = (await http().get(`/api/v1/call-campaigns/${campaign.id}/next`).set(agent.auth)).body.contact;
    const cb = await http().post(`/api/v1/call-campaigns/${campaign.id}/contacts/${third.id}/callback`).set(agent.auth).send({ scheduledAt: new Date(Date.now() - 1000).toISOString() });
    expect(cb.body.contact.status).toBe('callback');

    // callback is due → agent gets notified
    expect(await processDueCallbacks()).toBe(1);
    expect((await Callback.findById(cb.body.callback.id)).status).toBe('notified');
  });

  it('power dialer calls the next contact automatically for joined agents', async () => {
    const { admin, agent, number, campaign } = await setup('power');
    await http().patch(`/api/v1/call-campaigns/${campaign.id}`).set(admin.auth).send({ callerIdNumberId: String(number._id) });
    await http().post(`/api/v1/call-campaigns/${campaign.id}/contacts`).set(admin.auth).send({ rows: [{ name: 'P1', phone: '9800000021' }, { name: 'P2', phone: '9800000022' }] });
    await http().post(`/api/v1/call-campaigns/${campaign.id}/start`).set(admin.auth);
    expect(await runDialerTick()).toBe(0); // agent has not joined
    await http().post(`/api/v1/call-campaigns/${campaign.id}/join`).set(agent.auth);
    await drainListeners();
    expect(await runDialerTick()).toBe(1);
    expect(ops('makeCall')).toHaveLength(1);
    expect((await AgentStatus.findOne({ userId: agent.user.id })).status).toBe('on_call');
    expect(await runDialerTick()).toBe(0); // busy agent is not dialed again
  });

  it('refuses predictive mode without compliance acknowledgement and respects calling windows', async () => {
    const { admin, number, campaign } = await setup('predictive');
    await http().patch(`/api/v1/call-campaigns/${campaign.id}`).set(admin.auth).send({ callerIdNumberId: String(number._id), predictive: { enabled: true } });
    const start = await http().post(`/api/v1/call-campaigns/${campaign.id}/start`).set(admin.auth);
    expect(start.status).toBe(400);
    expect(start.body.error.message).toMatch(/compliance acknowledgement/);
    await http().patch(`/api/v1/call-campaigns/${campaign.id}`).set(admin.auth).send({ predictive: { enabled: true, complianceAcknowledged: true } });
    const ok = await http().post(`/api/v1/call-campaigns/${campaign.id}/start`).set(admin.auth);
    expect(ok.body).toMatchObject({ status: 'running', mode: 'predictive' });

    // outside the calling window nothing can be dialed
    await http().patch(`/api/v1/call-campaigns/${campaign.id}`).set(admin.auth).send({ mode: 'preview', schedule: { ...allDay, startDate: new Date(Date.now() + 86400000).toISOString() } });
    await http().post(`/api/v1/call-campaigns/${campaign.id}/contacts`).set(admin.auth).send({ rows: [{ name: 'W', phone: '9800000031' }] });
    const entry = await CallCampaignContact.findOne({ campaignId: campaign.id });
    const dial = await http().post(`/api/v1/call-campaigns/${campaign.id}/contacts/${entry.id}/dial`).set(admin.auth).send({});
    expect(dial.status).toBe(409);
    expect(dial.body.error.message).toMatch(/calling window/);
  });
});
