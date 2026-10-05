import { describe, expect, it } from 'vitest';
import {
  addUser, enableTelephony, FakeTelephonyProvider, http, ops, registerOrg, useDatabase, webhook,
} from './helpers.js';
import {
  Activity, AgentStatus, Alert, Call, Callback, CallRecording, DncEntry, Organization, Task,
} from '../src/models/index.js';

useDatabase();

async function setup() {
  const admin = await registerOrg();
  const agent = await addUser(admin, { role: 'agent', name: 'Rahul Agent', phone: '9000000001' });
  await enableTelephony(admin.org.id);
  return { admin, agent };
}

async function placeCall(agent, body = {}) {
  const res = await http().post('/api/v1/calls').set(agent.auth).send({ to: '9876543210', ...body });
  return res;
}

describe('outbound calls', () => {
  it('reports when no telephony provider is configured', async () => {
    const admin = await registerOrg();
    const res = await http().post('/api/v1/calls').set(admin.auth).send({ to: '9876543210' });
    expect(res.status).toBe(424);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
    const caps = await http().get('/api/v1/telephony/capabilities').set(admin.auth);
    expect(caps.body).toMatchObject({ configured: false, nativeCalling: true });
  });

  it('runs the full outbound lifecycle with normalized events', async () => {
    const { agent } = await setup();
    const lead = await http().post('/api/v1/leads').set(agent.auth).send({ name: 'Customer', phone: '9876543210' });
    const res = await placeCall(agent, { related: { leadId: lead.body.id } });
    expect(res.status).toBe(201);
    const callId = res.body.call.id;
    expect(ops('makeCall')[0].args.agentTarget).toBe(`client:agent_${agent.user.id}`);
    expect((await AgentStatus.findOne({ userId: agent.user.id })).status).toBe('on_call');

    const agentLeg = ops('makeCall')[0];
    const call0 = await Call.findById(callId);
    const agentSid = call0.providerLegs[0].providerCallId;

    // invalid signature is rejected
    expect((await webhook({ evt: 'status', callId, leg: 'agent' }, { CallSid: agentSid, CallStatus: 'in-progress' }, { valid: false })).status).toBe(403);

    // agent answers → customer is dialed
    expect((await webhook({ evt: 'status', callId, leg: 'agent' }, { CallSid: agentSid, CallStatus: 'in-progress', SequenceNumber: '1' })).status).toBe(200);
    expect(ops('dialCustomer')).toHaveLength(1);
    expect(agentLeg).toBeTruthy();
    let call = await Call.findById(callId);
    expect(call.status).toBe('ringing');
    const custSid = call.providerLegs.find((l) => l.role === 'customer').providerCallId;

    // customer answers
    await webhook({ evt: 'status', callId, leg: 'customer' }, { CallSid: custSid, CallStatus: 'in-progress', SequenceNumber: '1' });
    call = await Call.findById(callId);
    expect(call.status).toBe('in_progress');
    expect(call.answeredAt).toBeTruthy();

    // customer hangs up; delivered twice (provider retry) → processed once
    const done = { CallSid: custSid, CallStatus: 'completed', CallDuration: '125', SequenceNumber: '3' };
    await webhook({ evt: 'status', callId, leg: 'customer' }, done);
    await webhook({ evt: 'status', callId, leg: 'customer' }, done);
    call = await Call.findById(callId);
    expect(call.status).toBe('completed');
    expect(call.durationSeconds).toBe(125);
    expect(call.events.filter((e) => e.type === 'CALL_COMPLETED')).toHaveLength(1);
    expect(call.events.map((e) => e.type)).toEqual(expect.arrayContaining(['CALL_INITIATED', 'CALL_ANSWERED', 'CALL_COMPLETED']));
    expect((await AgentStatus.findOne({ userId: agent.user.id })).status).toBe('wrap_up');

    // after-call work
    const dispo = await http().post(`/api/v1/calls/${callId}/disposition`).set(agent.auth).send({
      code: 'interested', notes: 'Wants enterprise demo',
      createTask: { title: 'Schedule demo' },
      callback: { scheduledAt: new Date(Date.now() + 86400000).toISOString() },
      leadUpdate: { status: 'qualified' },
    });
    expect(dispo.status).toBe(200);
    expect(dispo.body.call.disposition.label).toBe('Interested');
    expect(await Task.countDocuments({ title: 'Schedule demo', 'related.leadId': lead.body.id })).toBe(1);
    expect(await Callback.countDocuments({ assignedAgentId: agent.user.id })).toBe(1);
    expect((await AgentStatus.findOne({ userId: agent.user.id })).status).toBe('available');

    // call appears on the lead timeline with its disposition, lead gets rescored
    const activity = await Activity.findOne({ refType: 'Call', refId: callId });
    expect(activity.links.leadId.toString()).toBe(lead.body.id);
    expect(activity.data).toMatchObject({ status: 'completed', disposition: 'Interested', durationSeconds: 125 });
    const leadAfter = await http().get(`/api/v1/leads/${lead.body.id}`).set(agent.auth);
    expect(leadAfter.body.status).toBe('qualified');
    expect(leadAfter.body.score).toBeGreaterThan(0);
  });

  it('cancels the call when the agent never answers', async () => {
    const { agent } = await setup();
    const res = await placeCall(agent);
    const call = await Call.findById(res.body.call.id);
    await webhook({ evt: 'status', callId: call.id, leg: 'agent' }, { CallSid: call.providerLegs[0].providerCallId, CallStatus: 'no-answer' });
    const after = await Call.findById(call.id);
    expect(after.status).toBe('no_answer');
    expect(ops('dialCustomer')).toHaveLength(0);
    expect((await AgentStatus.findOne({ userId: agent.user.id })).status).toBe('available');
  });

  it('applies compliance and fraud controls', async () => {
    const { admin, agent } = await setup();
    await DncEntry.create({ organizationId: admin.org.id, phone: '+919876543210' });
    const dnc = await placeCall(agent);
    expect(dnc.status).toBe(403);
    expect(dnc.body.error.code).toBe('COMPLIANCE_BLOCKED');

    const intl = await placeCall(agent, { to: '+14155550100' });
    expect(intl.status).toBe(403);
    expect(intl.body.error.code).toBe('INTERNATIONAL_BLOCKED');
    expect(await Alert.countDocuments({ type: 'fraud.international' })).toBe(1);

    await Organization.updateOne({ _id: admin.org.id }, { $set: { 'settings.fraud.callsPerMinute': 1 } });
    expect((await placeCall(agent, { to: '9811111111' })).status).toBe(201);
    const limited = await placeCall(agent, { to: '9822222222' });
    expect(limited.status).toBe(429);

    await Organization.updateOne({ _id: admin.org.id }, { $set: { 'settings.fraud.callsPerMinute': 100, 'settings.compliance.callingHours': { enabled: true, start: '09:00', end: '18:00', days: [7], timezone: 'UTC' } } });
    const hours = await placeCall(agent, { to: '9833333333' });
    expect(hours.status).toBe(403);
    expect(hours.body.error.details.reason).toBe('calling_hours');
  });

  it('rejects invalid numbers', async () => {
    const { agent } = await setup();
    expect((await placeCall(agent, { to: '12' })).status).toBe(400);
  });

  it('controls live calls: hold, resume, mute, transfer, conference, dtmf', async () => {
    const { admin, agent } = await setup();
    const other = await addUser(admin, { role: 'agent', name: 'Second Agent' });
    const res = await placeCall(agent);
    const callId = res.body.call.id;
    const c = await Call.findById(callId);
    await webhook({ evt: 'status', callId, leg: 'agent' }, { CallSid: c.providerLegs[0].providerCallId, CallStatus: 'in-progress' });
    const custSid = (await Call.findById(callId)).providerLegs.find((l) => l.role === 'customer').providerCallId;
    await webhook({ evt: 'status', callId, leg: 'customer' }, { CallSid: custSid, CallStatus: 'in-progress' });

    expect((await http().post(`/api/v1/calls/${callId}/hold`).set(agent.auth)).body.status).toBe('on_hold');
    expect(ops('hold')[0].args.participantCallId).toBe(custSid);
    expect((await http().post(`/api/v1/calls/${callId}/resume`).set(agent.auth)).body.status).toBe('in_progress');
    expect((await http().post(`/api/v1/calls/${callId}/mute`).set(agent.auth).send({ muted: true })).body.muted).toBe(true);
    expect((await http().post(`/api/v1/calls/${callId}/dtmf`).set(agent.auth).send({ digits: '12#' })).status).toBe(200);
    expect((await http().post(`/api/v1/calls/${callId}/dtmf`).set(agent.auth).send({ digits: 'abc' })).status).toBe(400);
    expect((await http().post(`/api/v1/calls/${callId}/conference`).set(agent.auth).send({ target: { number: '9844444444' } })).status).toBe(200);

    // consult transfer: start → complete
    const start = await http().post(`/api/v1/calls/${callId}/transfer`).set(agent.auth).send({ type: 'consult', phase: 'start', target: { userId: other.user.id } });
    expect(start.body.status).toBe('on_hold');
    const complete = await http().post(`/api/v1/calls/${callId}/transfer`).set(agent.auth).send({ type: 'consult', phase: 'complete' });
    expect(complete.body.agentId).toBe(other.user.id);
    expect(complete.body.events.map((e) => e.type)).toContain('CALL_TRANSFERRED');

    // the original agent can no longer control the call; the new one can hang up
    expect((await http().post(`/api/v1/calls/${callId}/hangup`).set(agent.auth)).status).toBe(403);
    const hung = await http().post(`/api/v1/calls/${callId}/hangup`).set(other.auth);
    expect(hung.body.status).toBe('completed');
    expect((await http().post(`/api/v1/calls/${callId}/hold`).set(other.auth)).status).toBe(409);
  });

  it('checks provider capabilities before using a feature', async () => {
    const { agent } = await setup();
    FakeTelephonyProvider.caps = { outboundCall: true };
    const res = await placeCall(agent);
    // No WebRTC support → falls back to bridge mode (rings the agent's own phone)
    expect(res.status).toBe(201);
    expect(res.body.call.mode).toBe('bridge');
    expect(ops('makeCall')[0].args.agentTarget).toBe('+919000000001');
    const hold = await http().post(`/api/v1/calls/${res.body.call.id}/hold`).set(agent.auth);
    expect(hold.status).toBe(422);
    expect(hold.body.error.code).toBe('CAPABILITY_NOT_SUPPORTED');
  });

  it('logs native mobile calls without a telephony provider', async () => {
    const admin = await registerOrg();
    const res = await http().post('/api/v1/calls').set(admin.auth).send({ to: '9876543210', mode: 'native', source: 'mobile' });
    expect(res.status).toBe(201);
    expect(res.body.dial).toBe('tel:+919876543210');
    const logged = await http().post(`/api/v1/calls/${res.body.call.id}/log`).set(admin.auth).send({ durationSeconds: 61, connected: true });
    expect(logged.body).toMatchObject({ status: 'completed', durationSeconds: 61 });
  });

  it('restricts call history to own calls for agents and exports CSV safely', async () => {
    const { admin, agent } = await setup();
    const other = await addUser(admin, { role: 'agent' });
    await placeCall(agent);
    await placeCall(other, { to: '9811111111' });
    expect((await http().get('/api/v1/calls').set(agent.auth)).body.total).toBe(1);
    expect((await http().get('/api/v1/calls').set(admin.auth)).body.total).toBe(2);
    await Call.updateMany({}, { notes: 'x', 'disposition.label': '=HYPERLINK("evil")' });
    const csv = await http().get('/api/v1/calls/export?format=csv').set(admin.auth);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[0]).toBe('Date,Caller,Receiver,Direction,Agent,Duration (s),Status,Disposition,Recording,Transcript');
    expect(csv.text).toContain("'=HYPERLINK");
    const xlsx = await http().get('/api/v1/calls/export?format=xlsx').set(admin.auth).buffer(true);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
  });

  it('masks numbers for users without permission when enabled', async () => {
    const { admin, agent } = await setup();
    await Organization.updateOne({ _id: admin.org.id }, { $set: { 'settings.compliance.maskNumbers': true } });
    await placeCall(agent);
    const list = await http().get('/api/v1/calls').set(agent.auth);
    expect(list.body.items[0].customerPhone).toBe('+91******3210');
    const full = await http().get('/api/v1/calls').set(admin.auth);
    expect(full.body.items[0].customerPhone).toBe('+919876543210');
  });
});

describe('recordings', () => {
  it('stores recordings privately and serves short-lived signed URLs with permission checks', async () => {
    const { admin, agent } = await setup();
    const other = await addUser(admin, { role: 'agent' });
    await Organization.updateOne({ _id: admin.org.id }, { $set: { 'settings.recording.enabled': true, 'settings.recording.retentionDays': 30 } });
    const res = await placeCall(agent);
    const callId = res.body.call.id;
    const c = await Call.findById(callId);
    await webhook({ evt: 'status', callId, leg: 'agent' }, { CallSid: c.providerLegs[0].providerCallId, CallStatus: 'in-progress' });
    expect(ops('dialCustomer')[0].args.consentText).toMatch(/may be recorded/);

    await webhook({ evt: 'recording', callId }, { CallSid: 'CAx', RecordingSid: 'RE1', RecordingUrl: 'https://provider/rec/RE1', RecordingDuration: '30', RecordingStatus: 'completed' });
    const rec = await CallRecording.findOne({ callId });
    expect(rec).toBeTruthy();
    expect(rec.deleteAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
    expect((await Call.findById(callId)).hasRecording).toBe(true);

    const list = await http().get(`/api/v1/calls/${callId}`).set(agent.auth);
    expect(JSON.stringify(list.body)).not.toContain('https://provider/rec');

    expect((await http().get(`/api/v1/recordings/${rec.id}/url`).set(other.auth)).status).toBe(403);
    const signed = await http().get(`/api/v1/recordings/${rec.id}/url`).set(agent.auth);
    expect(signed.status).toBe(200);
    const url = new URL(signed.body.url);
    const stream = await http().get(`${url.pathname}${url.search}`);
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toBe('audio/mpeg');
    const tampered = await http().get(`${url.pathname}?expires=${url.searchParams.get('expires')}&sig=bad`);
    expect(tampered.status).toBe(403);

    const { applyRecordingRetention } = await import('../src/modules/recordings/service.js');
    await applyRecordingRetention(new Date(Date.now() + 31 * 86400000));
    expect((await CallRecording.findById(rec.id)).deletedAt).toBeTruthy();
    expect(ops('deleteRecording')[0].args.id).toBe('RE1');
  });
});

describe('analytics & supervisor', () => {
  it('computes KPIs and the realtime dashboard', async () => {
    const { admin, agent } = await setup();
    const res = await placeCall(agent);
    const call = await Call.findById(res.body.call.id);
    call.status = 'completed';
    call.answeredAt = new Date(Date.now() - 60000);
    call.durationSeconds = 60;
    call.disposition = { code: 'converted', label: 'Converted' };
    await call.save();
    await Call.create({ organizationId: admin.org.id, direction: 'inbound', status: 'abandoned', from: '+919800000000', enqueuedAt: new Date(), waitSeconds: 40 });

    const a = await http().get('/api/v1/analytics/calls').set(admin.auth);
    expect(a.body.kpis).toMatchObject({ totalCalls: 2, inboundCalls: 1, outboundCalls: 1, connectedCalls: 1, abandonedCalls: 1, averageDuration: 60, conversions: 1 });
    expect(a.body.byAgent[0]).toMatchObject({ name: 'Rahul Agent', conversions: 1 });
    expect((await http().get('/api/v1/analytics/calls').set(agent.auth)).status).toBe(403);

    const dash = await http().get('/api/v1/supervisor/dashboard').set(admin.auth);
    expect(dash.status).toBe(200);
    expect(dash.body).toHaveProperty('agentsOnline');
    expect(dash.body.agents.find((x) => x.name === 'Rahul Agent').callsToday).toBe(1);
  });

  it('lets supervisors change status and force logout', async () => {
    const { admin, agent } = await setup();
    await Organization.updateOne({ _id: admin.org.id }, { $set: { 'settings.customAgentStatuses': [{ key: 'training', label: 'Training', available: false }] } });
    expect((await http().put('/api/v1/agents/me/status').set(agent.auth).send({ status: 'training' })).body).toMatchObject({ status: 'break', customStatus: 'training' });
    expect((await http().put('/api/v1/agents/me/status').set(agent.auth).send({ status: 'nonsense' })).status).toBe(400);
    expect((await http().put(`/api/v1/agents/${agent.user.id}/status`).set(admin.auth).send({ status: 'available' })).body.status).toBe('available');
    expect((await http().post(`/api/v1/agents/${admin.user.id}/force-logout`).set(agent.auth)).status).toBe(403);
    expect((await http().post(`/api/v1/agents/${agent.user.id}/force-logout`).set(admin.auth)).status).toBe(200);
    expect((await http().get('/api/v1/auth/me').set(agent.auth)).status).toBe(401);
  });

  it('allows supervisor monitoring only with the permission', async () => {
    const { admin, agent } = await setup();
    const res = await placeCall(agent);
    const callId = res.body.call.id;
    const c = await Call.findById(callId);
    await webhook({ evt: 'status', callId, leg: 'agent' }, { CallSid: c.providerLegs[0].providerCallId, CallStatus: 'in-progress' });
    expect((await http().post(`/api/v1/calls/${callId}/monitor`).set(agent.auth).send({ mode: 'listen' })).status).toBe(403);
    const m = await http().post(`/api/v1/calls/${callId}/monitor`).set(admin.auth).send({ mode: 'whisper' });
    expect(m.status).toBe(200);
    expect(ops('monitor')[0].args.mode).toBe('whisper');
  });
});

describe('provider credential problems', () => {
  it('reports unreadable credentials instead of looking unconfigured', async () => {
    const admin = await registerOrg();
    const { Integration } = await import('../src/models/index.js');
    await Organization.updateOne({ _id: admin.org.id }, { $set: { 'settings.telephonyProvider': 'exotel' } });
    await Integration.create({ organizationId: admin.org.id, kind: 'telephony', provider: 'exotel', credentials: 'v1:AAAA:BBBB:CCCC' });
    const caps = await http().get('/api/v1/telephony/capabilities').set(admin.auth);
    expect(caps.body.configured).toBe(false);
    expect(caps.body.error.code).toBe('CREDENTIALS_UNREADABLE');
    const call = await http().post('/api/v1/calls').set(admin.auth).send({ to: '9876543210', mode: 'bridge' });
    expect(call.status).toBe(424);
    expect(call.body.error.message).toMatch(/Re-enter them/);
  });
});
