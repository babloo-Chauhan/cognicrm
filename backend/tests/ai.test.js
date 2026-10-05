import { describe, expect, it } from 'vitest';
import {
  addUser, enableTelephony, http, registerOrg, scriptedLlm, useDatabase, webhook,
} from './helpers.js';
import {
  Call, CallQueue, CallRecording, CallTranscript, Lead, Note, Organization, Task, VoiceAgent,
} from '../src/models/index.js';
import { setLlmOverride } from '../src/modules/ai/llm.js';
import { setTranscriberOverride } from '../src/modules/ai/transcription.js';
import { executeTool } from '../src/modules/ai/tools.js';
import { runCallIntelligence } from '../src/modules/ai/pipeline.js';

useDatabase();

describe('AI status & rule-based features', () => {
  it('reports which AI features are available', async () => {
    const admin = await registerOrg();
    const s = await http().get('/api/v1/ai/status').set(admin.auth);
    expect(s.body).toMatchObject({ llm: null, features: { assistant: 'rules', callSummary: 'unavailable', leadScoring: 'rules' } });
    const gen = await http().post('/api/v1/ai/email/generate').set(admin.auth).send({ purpose: 'Follow up after demo' });
    expect(gen.status).toBe(424);
  });

  it('assistant (rule mode) answers the documented commands with CRM tools', async () => {
    const admin = await registerOrg();
    const rahul = await addUser(admin, { role: 'agent', name: 'Rahul' });
    await Lead.create({ organizationId: admin.org.id, name: 'Hot Prospect', ownerId: admin.user.id, score: 85, phone: '+919800000099' });
    await Lead.create({ organizationId: admin.org.id, name: 'Cold Prospect', ownerId: admin.user.id, score: 10, createdAt: new Date(Date.now() - 20 * 86400000) });
    const ask = (message, context) => http().post('/api/v1/ai/assistant').set(admin.auth).send({ message, context });

    const hot = await ask('Show my hot leads.');
    expect(hot.body.mode).toBe('rules');
    expect(hot.body.reply).toContain('Hot Prospect');
    expect(hot.body.reply).not.toContain('Cold Prospect');

    const task = await ask('Create a task for Rahul tomorrow to send the proposal');
    expect(task.body.reply).toMatch(/Task created/);
    const t = await Task.findOne({ title: 'send the proposal' });
    expect(String(t.assigneeId)).toBe(rahul.user.id);

    const call = await ask('Call Hot Prospect');
    expect(call.body.actions[0]).toMatchObject({ type: 'call', phone: '+919800000099' });

    const stale = await ask("Find customers who haven't been contacted in 7 days");
    expect(stale.body.toolResults[0].result.leads.map((l) => l.name)).toContain('Cold Prospect');

    const help = await ask('what is the meaning of life');
    expect(help.body.reply).toMatch(/not configured/);
  });

  it('next best action and forecast are explainable', async () => {
    const admin = await registerOrg();
    const lead = await http().post('/api/v1/leads').set(admin.auth).send({ name: 'New Lead', source: 'referral' });
    const nba = await http().get(`/api/v1/ai/next-best-action/lead/${lead.body.id}`).set(admin.auth);
    expect(nba.body.suggestions[0]).toMatchObject({ action: 'call' });
    expect(nba.body.suggestions[0].reasons.length).toBeGreaterThan(0);
    await http().post('/api/v1/deals').set(admin.auth).send({ name: 'D', value: 1000, stage: 'proposal', expectedCloseDate: '2026-12-15' });
    const f = await http().get('/api/v1/ai/forecast').set(admin.auth);
    expect(f.body.months[0]).toMatchObject({ month: '2026-12', pipeline: 1000, weighted: 500 });
  });
});

describe('AI with a configured model (scripted test LLM)', () => {
  it('assistant runs a tool loop', async () => {
    const admin = await registerOrg();
    const llm = scriptedLlm([
      { tools: [{ name: 'create_task', input: { title: 'Call back Mehta', dueAt: new Date(Date.now() + 86400000).toISOString() } }] },
      { text: 'Done — I created the task for tomorrow.' },
    ]);
    setLlmOverride(llm);
    const res = await http().post('/api/v1/ai/assistant').set(admin.auth).send({ message: 'Remind me to call back Mehta tomorrow' });
    expect(res.body).toMatchObject({ mode: 'ai', reply: 'Done — I created the task for tomorrow.' });
    expect(await Task.countDocuments({ title: 'Call back Mehta' })).toBe(1);
    expect(llm.calls[0].tools.map((t) => t.name)).not.toContain('transfer_call');
  });

  it('voice agent uses only allowed tools and escalates on request', async () => {
    const admin = await registerOrg();
    const agent = await VoiceAgent.create({
      organizationId: admin.org.id, name: 'Asha', status: 'active', tools: ['create_lead', 'search_order'],
      profile: { greeting: 'Hi, this is Asha from COGNIEOS.' },
    });
    // a tool outside the allow-list is refused
    await expect(executeTool({ orgId: admin.org.id, allowed: ['create_lead'] }, 'create_ticket', { subject: 'x' })).rejects.toThrow(/not permitted/);

    setLlmOverride(scriptedLlm([
      { tools: [{ name: 'create_lead', input: { name: 'Vikram', phone: '9811100000' } }] },
      { text: 'Thanks Vikram, I have noted your details.' },
    ]));
    const first = await http().post(`/api/v1/voice-agents/${agent.id}/test`).set(admin.auth).send({});
    expect(first.body.reply).toBe('Hi, this is Asha from COGNIEOS.');
    const turn = await http().post(`/api/v1/voice-agents/${agent.id}/test`).set(admin.auth).send({ sessionId: first.body.sessionId, message: 'I am Vikram, interested in your CRM' });
    expect(turn.body.reply).toBe('Thanks Vikram, I have noted your details.');
    expect(await Lead.countDocuments({ name: 'Vikram', source: 'inbound_call' })).toBe(1);

    const esc = await http().post(`/api/v1/voice-agents/${agent.id}/test`).set(admin.auth).send({ sessionId: first.body.sessionId, message: 'Please connect me to a human' });
    expect(esc.body.escalate.reason).toMatch(/human/);
  });

  it('voice agent answers inbound calls and hands off to a queue with context', async () => {
    const admin = await registerOrg();
    const queue = await CallQueue.create({ organizationId: admin.org.id, name: 'Support', positionAnnouncement: false });
    const number = await enableTelephony(admin.org.id);
    await VoiceAgent.create({
      organizationId: admin.org.id, name: 'Asha', status: 'active', tools: [], phoneNumberIds: [number._id],
      escalation: { queueId: queue._id }, profile: { greeting: 'Namaste! How can I help?' },
    });
    setLlmOverride(scriptedLlm([{ tools: [{ name: 'transfer_call', input: { reason: 'Billing dispute' } }] }], { summary: 'Customer disputes invoice', intent: 'billing' }));
    const voice = await webhook({ evt: 'voice' }, { CallSid: 'CAai', From: '+919811112222', To: '+918000000001', Direction: 'inbound' });
    expect(voice.text).toContain('Namaste! How can I help?');
    expect(voice.text).toContain('input="speech"');
    const url = new URL(voice.text.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&'));
    const turn = await webhook(Object.fromEntries(url.searchParams), { CallSid: 'CAai', SpeechResult: 'My invoice is wrong' });
    expect(turn.text).toContain('connect you with a member of our team');
    expect(turn.text).toContain('<Conference');
    const call = await Call.findOne({ providerCallId: 'CAai' });
    expect(call.status).toBe('queued');
    expect(call.metadata.aiEscalation).toMatchObject({ reason: 'Billing dispute', summary: 'Customer disputes invoice', intent: 'billing' });
    expect(await Note.countDocuments({ 'related.callId': call._id })).toBe(1);
  });

  it('runs the post-call intelligence pipeline', async () => {
    const admin = await registerOrg();
    const agent = await addUser(admin, { role: 'agent' });
    await enableTelephony(admin.org.id);
    await Organization.updateOne({ _id: admin.org.id }, { $set: { 'settings.transcription.enabled': true } });
    const call = await Call.create({ organizationId: admin.org.id, direction: 'outbound', status: 'completed', agentId: agent.user.id, provider: 'fake', answeredAt: new Date() });
    await CallRecording.create({ organizationId: admin.org.id, callId: call._id, recordingId: 'RE1', provider: 'fake' });

    // without a transcriber nothing is fabricated
    expect((await runCallIntelligence(admin.org.id, call._id)).skipped).toMatch(/no transcription provider/);

    setTranscriberOverride({ name: 'test-stt', transcribe: async () => ({ text: 'Customer wants an enterprise demo tomorrow.', segments: [], language: 'en' }) });
    setLlmOverride(scriptedLlm([], {
      summary: 'Customer wants enterprise CRM demo.', requirements: ['Enterprise plan'], problems: [], objections: ['Price'],
      commitments: ['Send deck'], nextSteps: ['Schedule demo tomorrow'], actionItems: [{ title: 'Schedule demo', dueInDays: 1 }],
      topics: ['demo', 'pricing'], sentiment: 'positive',
    }));
    const result = await runCallIntelligence(admin.org.id, call._id);
    expect(result.transcript.status).toBe('summarized');
    const t = await CallTranscript.findOne({ callId: call._id });
    expect(t).toMatchObject({ summary: 'Customer wants enterprise CRM demo.', topics: ['demo', 'pricing'], actionItems: ['Schedule demo'] });
    expect(await Task.countDocuments({ title: 'Schedule demo', source: 'ai', assigneeId: agent.user.id })).toBe(1);
    expect((await Call.findById(call._id)).hasTranscript).toBe(true);
  });
});
