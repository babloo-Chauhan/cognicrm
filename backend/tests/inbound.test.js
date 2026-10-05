import { describe, expect, it } from 'vitest';
import {
  addUser, drainListeners, enableTelephony, http, ops, registerOrg, useDatabase, webhook,
} from './helpers.js';
import {
  BusinessHours, Call, CallQueue, CallQueueMember, Callback, IVRFlow, Notification, Voicemail,
} from '../src/models/index.js';
import { checkQueueTimeouts } from '../src/modules/routing/service.js';

useDatabase();

async function setupInbound({ numberFields = {}, strategy = 'longest_idle' } = {}) {
  const admin = await registerOrg();
  const agent = await addUser(admin, { role: 'agent', name: 'Sales Agent' });
  const queue = await CallQueue.create({ organizationId: admin.org.id, name: 'Sales', strategy, maxWaitTime: 60 });
  await CallQueueMember.create({ organizationId: admin.org.id, queueId: queue._id, userId: agent.user.id });
  const flow = await IVRFlow.create({
    organizationId: admin.org.id,
    name: 'Main menu',
    status: 'published',
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'welcome', type: 'tts', data: { text: { en: 'Welcome to COGNIEOS.' } } },
      { id: 'menu', type: 'gather', data: { prompt: 'Press 1 for Sales. Press 9 to request a callback.', numDigits: 1 } },
      { id: 'sales', type: 'queue', data: { queueId: String(queue._id) } },
      { id: 'cb', type: 'callback', data: { queueId: String(queue._id) } },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'welcome' },
      { id: 'e2', source: 'welcome', target: 'menu' },
      { id: 'e3', source: 'menu', target: 'sales', sourceHandle: '1' },
      { id: 'e4', source: 'menu', target: 'cb', sourceHandle: '9' },
    ],
  });
  const number = await enableTelephony(admin.org.id, { ivrFlowId: flow._id, ...numberFields });
  return { admin, agent, queue, flow, number };
}

const inboundParams = (extra = {}) => ({ CallSid: 'CAinbound1', From: '+919811112222', To: '+918000000001', Direction: 'inbound', CallStatus: 'ringing', ...extra });

describe('inbound routing', () => {
  it('runs IVR → queue → agent → completed', async () => {
    const { agent } = await setupInbound();
    await http().put('/api/v1/agents/me/status').set(agent.auth).send({ status: 'available' });
    await drainListeners();

    const voice = await webhook({ evt: 'voice' }, inboundParams());
    expect(voice.status).toBe(200);
    expect(voice.headers['content-type']).toMatch(/xml/);
    expect(voice.text).toContain('Welcome to COGNIEOS.');
    expect(voice.text).toContain('<Gather');
    const call = await Call.findOne({ providerCallId: 'CAinbound1' });
    expect(call).toMatchObject({ direction: 'inbound', status: 'ringing', customerPhone: '+919811112222' });

    const gatherUrl = new URL(voice.text.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&'));
    const ivr = await webhook(Object.fromEntries(gatherUrl.searchParams), { CallSid: 'CAinbound1', Digits: '1' });
    expect(ivr.text).toContain('You are number 1 in the queue.');
    expect(ivr.text).toContain(`<Conference startConferenceOnEnter="false" endConferenceOnExit="true"`);
    await drainListeners();

    expect(ops('connectAgent')[0].args.agentTarget).toBe(`client:agent_${agent.user.id}`);
    const incoming = await Notification.findOne({ userId: agent.user.id, type: 'incoming_call' });
    expect(incoming).toBeTruthy();
    let queued = await Call.findById(call.id);
    expect(queued.status).toBe('queued');
    const agentLeg = queued.providerLegs.find((l) => l.role === 'agent');

    await webhook({ evt: 'status', callId: call.id, leg: 'agent' }, { CallSid: agentLeg.providerCallId, CallStatus: 'in-progress' });
    queued = await Call.findById(call.id);
    expect(queued.status).toBe('in_progress');
    expect(String(queued.agentId)).toBe(agent.user.id);

    await webhook({ evt: 'status' }, { CallSid: 'CAinbound1', CallStatus: 'completed', CallDuration: '90', Direction: 'inbound' });
    const done = await Call.findById(call.id);
    expect(done.status).toBe('completed');
    expect(done.waitSeconds).toBeGreaterThanOrEqual(0);
  });

  it('marks queued calls abandoned and notifies about the missed call', async () => {
    const { number } = await setupInbound({ numberFields: { ivrFlowId: null } });
    await CallQueue.updateOne({}, { positionAnnouncement: false });
    await number.updateOne({ queueId: (await CallQueue.findOne())._id, ivrFlowId: null });
    const voice = await webhook({ evt: 'voice' }, inboundParams({ CallSid: 'CAab' }));
    expect(voice.text).toContain('<Conference');
    await drainListeners();
    expect(ops('connectAgent')).toHaveLength(0); // nobody available
    await webhook({ evt: 'status' }, { CallSid: 'CAab', CallStatus: 'completed', Direction: 'inbound' });
    const call = await Call.findOne({ providerCallId: 'CAab' });
    expect(call.status).toBe('abandoned');
  });

  it('creates callback requests from the IVR', async () => {
    await setupInbound();
    const voice = await webhook({ evt: 'voice' }, inboundParams({ CallSid: 'CAcb' }));
    const gatherUrl = new URL(voice.text.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&'));
    const ivr = await webhook(Object.fromEntries(gatherUrl.searchParams), { CallSid: 'CAcb', Digits: '9' });
    expect(ivr.text).toContain('call you back');
    expect(await Callback.findOne({ phone: '+919811112222', source: 'ivr' })).toBeTruthy();
  });

  it('sends after-hours calls to voicemail and notifies the owner', async () => {
    const admin = await registerOrg();
    const owner = await addUser(admin, { role: 'agent', name: 'Owner' });
    const bh = await BusinessHours.create({ organizationId: admin.org.id, name: 'Never open', timezone: 'UTC', weekly: [] });
    await enableTelephony(admin.org.id, { businessHoursId: bh._id, assignedUserId: owner.user.id });

    const voice = await webhook({ evt: 'voice' }, inboundParams({ CallSid: 'CAvm' }));
    expect(voice.text).toContain('office is currently closed');
    expect(voice.text).toContain('<Record');
    const call = await Call.findOne({ providerCallId: 'CAvm' });
    expect(call.metadata.voicemail.scope).toBe('personal');

    await webhook({ evt: 'voicemail-done', callId: call.id }, { CallSid: 'CAvm', RecordingSid: 'REvm', RecordingUrl: 'https://p/rec', RecordingDuration: '12' });
    await webhook({ evt: 'status' }, { CallSid: 'CAvm', CallStatus: 'completed', Direction: 'inbound' });
    const vm = await Voicemail.findOne({ callId: call.id });
    expect(vm.assignedUserIds.map(String)).toEqual([owner.user.id]);
    expect((await Call.findById(call.id)).status).toBe('voicemail');
    expect(await Notification.findOne({ userId: owner.user.id, type: 'voicemail' })).toBeTruthy();

    // late recording callback is deduplicated
    await webhook({ evt: 'voicemail', callId: call.id, scope: 'personal' }, { CallSid: 'CAvm', RecordingSid: 'REvm', RecordingUrl: 'https://p/rec', RecordingDuration: '12' });
    expect(await Voicemail.countDocuments({ callId: call.id })).toBe(1);

    const list = await http().get('/api/v1/voicemails').set(owner.auth);
    expect(list.body.items).toHaveLength(1);
  });

  it('redirects to the queue fallback after the max wait time', async () => {
    const { number, queue } = await setupInbound();
    await number.updateOne({ queueId: queue._id, ivrFlowId: null });
    await webhook({ evt: 'voice' }, inboundParams({ CallSid: 'CAto' }));
    await drainListeners();
    const handled = await checkQueueTimeouts(new Date(Date.now() + 61000));
    expect(handled).toBe(1);
    const redirect = ops('redirectCall')[0];
    expect(redirect.args.url).toContain('evt=fallback');
    const fb = await webhook(Object.fromEntries(new URL(redirect.args.url).searchParams), { CallSid: 'CAto' });
    expect(fb.text).toContain('<Record');
  });

  it('tries the next agent when one does not answer (ring order)', async () => {
    const { admin, queue, number } = await setupInbound();
    const second = await addUser(admin, { role: 'agent', name: 'Second' });
    await CallQueueMember.create({ organizationId: admin.org.id, queueId: queue._id, userId: second.user.id });
    await number.updateOne({ queueId: queue._id, ivrFlowId: null });
    const agents = await http().get('/api/v1/users').set(admin.auth);
    for (const u of agents.body.items.filter((x) => x.role === 'agent')) {
      await http().put(`/api/v1/agents/${u.id}/status`).set(admin.auth).send({ status: 'available' });
    }
    await drainListeners();
    await webhook({ evt: 'voice' }, inboundParams({ CallSid: 'CArr' }));
    await drainListeners();
    expect(ops('connectAgent')).toHaveLength(1);
    const call = await Call.findOne({ providerCallId: 'CArr' });
    const firstLeg = call.providerLegs.find((l) => l.role === 'agent');
    await webhook({ evt: 'status', callId: call.id, leg: 'agent' }, { CallSid: firstLeg.providerCallId, CallStatus: 'no-answer' });
    await drainListeners();
    expect(ops('connectAgent')).toHaveLength(2);
    expect(ops('connectAgent')[1].args.agentTarget).not.toBe(ops('connectAgent')[0].args.agentTarget);
  });

  it('rejects calls to unknown numbers and unsigned requests', async () => {
    await setupInbound();
    expect((await webhook({ evt: 'voice' }, inboundParams({ To: '+911111111111', CallSid: 'CAunk' }))).status).toBe(404);
    expect((await webhook({ evt: 'voice' }, inboundParams({ CallSid: 'CAbad' }), { valid: false })).status).toBe(403);
    expect(await Call.countDocuments({ providerCallId: 'CAbad' })).toBe(0);
  });
});

describe('IVR management API', () => {
  it('validates flows on publish and simulates them', async () => {
    const admin = await registerOrg();
    const bad = await http().post('/api/v1/ivr').set(admin.auth).send({ name: 'Broken', status: 'published', nodes: [{ id: 'q', type: 'queue', data: {} }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual(expect.arrayContaining(['Flow needs a Start node']));
    const ok = await http().post('/api/v1/ivr').set(admin.auth).send({
      name: 'Simple', status: 'draft',
      nodes: [{ id: 's', type: 'start' }, { id: 't', type: 'tts', data: { text: 'Hello' } }, { id: 'e', type: 'end' }],
      edges: [{ source: 's', target: 't' }, { source: 't', target: 'e' }],
    });
    expect(ok.status).toBe(201);
    const sim = await http().post(`/api/v1/ivr/${ok.body.id}/simulate`).set(admin.auth).send({});
    expect(sim.body.actions[0]).toMatchObject({ type: 'say', text: 'Hello' });
    expect(sim.body.outcome).toEqual({ type: 'hangup' });
    const put = await http().put(`/api/v1/ivr/${ok.body.id}`).set(admin.auth).send({ ...ok.body, status: 'published' });
    expect(put.body.version).toBe(2);
  });
});

describe('GET webhooks (Exotel Passthru style)', () => {
  it('logs an inbound call delivered as a GET request', async () => {
    const { number } = await setupInbound();
    await number.updateOne({ ivrFlowId: null });
    const qs = new URLSearchParams({ evt: 'passthru', CallSid: 'EXget1', From: '09811112222', To: '+918000000001' });
    const res = await http().get(`/api/v1/webhooks/telephony/fake?${qs}`).set('x-test-signature', 'valid');
    expect(res.status).toBe(200);
    const call = await Call.findOne({ providerCallId: 'EXget1' });
    expect(call).toMatchObject({ direction: 'inbound', customerPhone: '+919811112222' });
  });
});
