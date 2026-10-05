import { describe, expect, it } from 'vitest';
import { evaluateBusinessHours, isWithinWindow } from '../src/modules/routing/businessHours.js';
import { selectAgents } from '../src/modules/routing/queueStrategies.js';
import { computePredictiveDialCount } from '../src/modules/campaigns/predictive.js';
import {
  computeDealScore, computeLeadScore, DEFAULT_LEAD_SCORING, forecastDeals, suggestNextBestActions,
} from '../src/modules/ai/scoring.js';
import { runIvr, validateFlow } from '../src/modules/routing/ivrEngine.js';
import { TwilioProvider, twilioSignature } from '../src/modules/telephony/providers/twilio.js';
import { PlivoProvider, plivoSignatureV2 } from '../src/modules/telephony/providers/plivo.js';
import { eventFromStatus } from '../src/modules/telephony/events.js';
import { decryptJson, encryptJson, maskPhone, signResource, verifyResourceSignature } from '../src/lib/crypto.js';
import { isValidE164, normalizePhone } from '../src/lib/phone.js';
import { translate } from '../src/modules/telephony/tts.js';
import { interpolate } from '../src/lib/template.js';

describe('business hours', () => {
  const bh = {
    timezone: 'Asia/Kolkata',
    weekly: [1, 2, 3, 4, 5].map((day) => ({ day, open: '09:00', close: '18:00' })),
    holidays: [{ date: '2026-10-02', name: 'Gandhi Jayanti' }],
    specialHours: [{ date: '2026-10-10', open: '10:00', close: '12:00' }],
  };
  it('is open during weekday hours in the configured time zone', () => {
    // Monday 2026-10-05 10:00 IST = 04:30 UTC
    expect(evaluateBusinessHours(bh, new Date('2026-10-05T04:30:00Z'))).toBe('open');
    // Monday 19:00 IST
    expect(evaluateBusinessHours(bh, new Date('2026-10-05T13:30:00Z'))).toBe('closed');
  });
  it('detects holidays and special hours', () => {
    expect(evaluateBusinessHours(bh, new Date('2026-10-02T05:00:00Z'))).toBe('holiday');
    // Saturday 2026-10-10 11:00 IST special hours
    expect(evaluateBusinessHours(bh, new Date('2026-10-10T05:30:00Z'))).toBe('open');
    expect(evaluateBusinessHours(bh, new Date('2026-10-10T08:30:00Z'))).toBe('closed');
  });
  it('supports ranges that cross midnight', () => {
    const night = { timezone: 'UTC', weekly: [{ day: 1, open: '22:00', close: '06:00' }] };
    expect(evaluateBusinessHours(night, new Date('2026-10-05T23:00:00Z'))).toBe('open');
    expect(evaluateBusinessHours(night, new Date('2026-10-05T12:00:00Z'))).toBe('closed');
  });
  it('checks calling windows', () => {
    expect(isWithinWindow({ timezone: 'UTC', days: [1], start: '09:00', end: '17:00' }, new Date('2026-10-05T10:00:00Z'))).toBe(true);
    expect(isWithinWindow({ timezone: 'UTC', days: [2], start: '09:00', end: '17:00' }, new Date('2026-10-05T10:00:00Z'))).toBe(false);
  });
});

describe('queue strategies', () => {
  const agents = [
    { userId: 'a', lastCallEndedAt: '2026-10-01T10:00:00Z', callsToday: 5 },
    { userId: 'b', lastCallEndedAt: '2026-10-01T08:00:00Z', callsToday: 9 },
    { userId: 'c', lastCallEndedAt: '2026-10-01T09:00:00Z', callsToday: 1 },
  ];
  it('longest idle picks the agent idle the longest', () => {
    expect(selectAgents(agents, { strategy: 'longest_idle' }).selected[0].userId).toBe('b');
  });
  it('least busy picks the agent with fewest calls', () => {
    expect(selectAgents(agents, { strategy: 'least_busy' }).selected[0].userId).toBe('c');
  });
  it('ring all returns everyone', () => {
    expect(selectAgents(agents, { strategy: 'ring_all' }).selected).toHaveLength(3);
  });
  it('round robin rotates', () => {
    const first = selectAgents(agents, { strategy: 'round_robin', lastAssignedIndex: -1 });
    const second = selectAgents(agents, { strategy: 'round_robin', lastAssignedIndex: first.nextIndex });
    expect(first.selected[0].userId).toBe('a');
    expect(second.selected[0].userId).toBe('b');
  });
  it('random uses the injected random source', () => {
    expect(selectAgents(agents, { strategy: 'random' }, () => 0.99).selected[0].userId).toBe('c');
  });
  it('respects member priority', () => {
    const prio = [...agents, { userId: 'vip', priority: 10, lastCallEndedAt: '2026-10-01T11:00:00Z' }];
    expect(selectAgents(prio, { strategy: 'longest_idle' }).selected[0].userId).toBe('vip');
  });
});

describe('predictive dialer pacing', () => {
  const base = { availableAgents: 4, answerRate: 0.4, sampleSize: 200 };
  it('dials 1:1 unless explicitly enabled and acknowledged', () => {
    expect(computePredictiveDialCount({ ...base, settings: { enabled: true } }).ratio).toBe(1);
    expect(computePredictiveDialCount({ ...base, settings: {} }).dialCount).toBe(4);
  });
  it('over-dials based on answer rate, capped by max ratio', () => {
    const r = computePredictiveDialCount({ ...base, settings: { enabled: true, complianceAcknowledged: true, maxDialRatio: 2 } });
    expect(r.ratio).toBe(2);
    expect(r.dialCount).toBe(8);
  });
  it('throttles to 1:1 when abandon rate exceeds the limit', () => {
    const r = computePredictiveDialCount({ ...base, abandonRate: 0.08, settings: { enabled: true, complianceAcknowledged: true } });
    expect(r.ratio).toBe(1);
  });
  it('stays 1:1 without enough history', () => {
    expect(computePredictiveDialCount({ ...base, sampleSize: 5, settings: { enabled: true, complianceAcknowledged: true } }).ratio).toBe(1);
  });
});

describe('scoring and next best action', () => {
  it('scores leads with explainable factors', () => {
    const r = computeLeadScore(
      { source: 'referral', emailOpens: 10, emailReplies: 2, websiteVisits: 4, companySize: '201-1000', industry: 'SaaS', estimatedValue: 500000, lastContactedAt: new Date() },
      { connectedCalls: 2, positiveDispositions: 1 },
      DEFAULT_LEAD_SCORING,
    );
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.label).toBe('hot');
    expect(r.factors.map((f) => f.factor)).toEqual(expect.arrayContaining(['source', 'email_replies', 'calls', 'call_outcome', 'deal_value']));
  });
  it('penalises inactivity', () => {
    const r = computeLeadScore({ source: 'website', lastContactedAt: new Date(Date.now() - 60 * 86400000) }, {}, DEFAULT_LEAD_SCORING);
    expect(r.factors.find((f) => f.factor === 'inactivity').points).toBeLessThan(0);
  });
  it('scores deals by stage and activity', () => {
    const fresh = computeDealScore({ stage: 'negotiation', lastActivityAt: new Date() });
    const stale = computeDealScore({ stage: 'negotiation', lastActivityAt: new Date(Date.now() - 30 * 86400000) });
    expect(fresh.score).toBeGreaterThan(stale.score);
  });
  it('suggests explainable next actions', () => {
    const s = suggestNextBestActions({ kind: 'lead', record: { status: 'new', createdAt: new Date() }, score: 75, openTasks: [] });
    expect(s[0].action).toBe('call');
    expect(s.every((x) => x.reasons.length > 0)).toBe(true);
    const deal = suggestNextBestActions({ kind: 'deal', record: { stage: 'proposal', lastActivityAt: new Date(Date.now() - 6 * 86400000) }, openTasks: [] });
    expect(deal.map((x) => x.action)).toContain('send_email');
  });
  it('builds a weighted forecast', () => {
    const f = forecastDeals([
      { stage: 'proposal', value: 1000, expectedCloseDate: '2026-11-15' },
      { stage: 'won', value: 500, expectedCloseDate: '2026-11-01' },
      { stage: 'lost', value: 9999, expectedCloseDate: '2026-11-01' },
    ]);
    expect(f[0]).toMatchObject({ month: '2026-11', pipeline: 1000, weighted: 500, won: 500 });
  });
});

describe('IVR engine', () => {
  const flow = {
    defaultLanguage: 'en',
    translations: { welcome: { en: 'Welcome to COGNIEOS.', hi: 'COGNIEOS mein aapka swagat hai.' } },
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'hours', type: 'business_hours', data: { businessHoursId: 'bh1' } },
      { id: 'welcome', type: 'tts', data: { text: '{{t:welcome}}' } },
      { id: 'menu', type: 'gather', data: { prompt: 'Press 1 for Sales, 2 for Support.', numDigits: 1, maxRetries: 1 } },
      { id: 'sales', type: 'queue', data: { queueId: 'q-sales' } },
      { id: 'support', type: 'queue', data: { queueId: 'q-support' } },
      { id: 'closed', type: 'voicemail', data: { message: 'We are closed.' } },
    ],
    edges: [
      { source: 'start', target: 'hours' },
      { source: 'hours', target: 'welcome', sourceHandle: 'open' },
      { source: 'hours', target: 'closed', sourceHandle: 'closed' },
      { source: 'welcome', target: 'menu' },
      { source: 'menu', target: 'sales', sourceHandle: '1' },
      { source: 'menu', target: 'support', sourceHandle: '2' },
    ],
  };
  const services = { businessHoursStatus: async () => 'open' };
  const urls = { gather: (id) => `https://x/ivr/${id}` };

  it('plays the welcome and waits for input', async () => {
    const r = await runIvr(flow, {}, { services, urls });
    expect(r.awaitingInput).toBe(true);
    expect(r.actions[0]).toMatchObject({ type: 'say', text: 'Welcome to COGNIEOS.' });
    expect(r.actions[1]).toMatchObject({ type: 'gather', numDigits: 1, actionUrl: 'https://x/ivr/menu' });
    expect(r.session.currentNodeId).toBe('menu');
  });
  it('routes DTMF input to the matching queue', async () => {
    const first = await runIvr(flow, {}, { services, urls });
    const second = await runIvr(flow, first.session, { input: '2', services, urls });
    expect(second.outcome).toEqual({ type: 'queue', queueId: 'q-support' });
  });
  it('re-prompts on invalid input and then gives up', async () => {
    const first = await runIvr(flow, {}, { services, urls });
    const retry = await runIvr(flow, first.session, { input: '9', services, urls });
    expect(retry.awaitingInput).toBe(true);
    expect(retry.actions[0].text).toMatch(/did not get that/);
    const giveUp = await runIvr(flow, retry.session, { input: '9', services, urls });
    expect(giveUp.outcome).toEqual({ type: 'hangup' });
  });
  it('uses the session language for translations', async () => {
    const r = await runIvr(flow, { language: 'hi' }, { services, urls });
    expect(r.actions[0].text).toBe('COGNIEOS mein aapka swagat hai.');
    expect(r.actions[0].language).toBe('hi-IN');
  });
  it('branches on business hours', async () => {
    const r = await runIvr(flow, {}, { services: { businessHoursStatus: async () => 'closed' }, urls });
    expect(r.outcome.type).toBe('voicemail');
    expect(r.actions[0].text).toBe('We are closed.');
  });
  it('performs CRM lookups and interpolates variables', async () => {
    const lookupFlow = {
      nodes: [
        { id: 's', type: 'start' },
        { id: 'ask', type: 'gather', data: { prompt: 'Enter your customer ID', variable: 'customerId', collect: true } },
        { id: 'lookup', type: 'api_request', data: { operation: 'customer_lookup', inputVariable: 'customerId' } },
        { id: 'hello', type: 'tts', data: { text: 'Hello {{vars.customer.firstName}}' } },
        { id: 'end', type: 'end' },
        { id: 'nf', type: 'end', data: { message: 'Not found' } },
      ],
      edges: [
        { source: 's', target: 'ask' }, { source: 'ask', target: 'lookup' },
        { source: 'lookup', target: 'hello', sourceHandle: 'success' }, { source: 'lookup', target: 'nf', sourceHandle: 'error' },
        { source: 'hello', target: 'end' },
      ],
    };
    const svc = { lookupCustomer: async ({ customerId }) => (customerId === '42' ? { found: true, customer: { firstName: 'Rahul' } } : { found: false }) };
    const first = await runIvr(lookupFlow, {}, { services: svc, urls });
    const done = await runIvr(lookupFlow, first.session, { input: '42', services: svc, urls });
    expect(done.actions[0].text).toBe('Hello Rahul');
    const missing = await runIvr(lookupFlow, first.session, { input: '7', services: svc, urls });
    expect(missing.actions[0].text).toBe('Not found');
  });
  it('validates flows before publishing', () => {
    expect(validateFlow(flow)).toEqual([]);
    expect(validateFlow({ nodes: [{ id: 'x', type: 'queue', data: {} }], edges: [] })).toEqual(
      expect.arrayContaining(['Flow needs a Start node', expect.stringMatching(/no queue selected/)]),
    );
  });
});

describe('providers', () => {
  it('validates Twilio signatures and rejects tampering', () => {
    const p = new TwilioProvider({ credentials: { accountSid: 'AC1', authToken: 'secret' } });
    const url = 'https://crm.test/api/v1/webhooks/telephony/twilio?evt=status';
    const params = { CallSid: 'CA1', CallStatus: 'completed' };
    const sig = twilioSignature('secret', url, params);
    expect(p.validateWebhook({ url, params, headers: { 'x-twilio-signature': sig } })).toBe(true);
    expect(p.validateWebhook({ url, params: { ...params, CallStatus: 'busy' }, headers: { 'x-twilio-signature': sig } })).toBe(false);
    expect(p.validateWebhook({ url, params, headers: {} })).toBe(false);
  });
  it('validates Plivo V2 signatures', () => {
    const p = new PlivoProvider({ credentials: { authId: 'MA1', authToken: 'tok' } });
    const url = 'https://crm.test/hook?evt=status';
    const sig = plivoSignatureV2('tok', url, 'nonce1');
    expect(p.validateWebhook({ url, headers: { 'x-plivo-signature-v2': sig, 'x-plivo-signature-v2-nonce': 'nonce1' } })).toBe(true);
    expect(p.validateWebhook({ url, headers: { 'x-plivo-signature-v2': sig, 'x-plivo-signature-v2-nonce': 'other' } })).toBe(false);
  });
  it('renders TwiML from provider-neutral actions', () => {
    const p = new TwilioProvider({ credentials: { accountSid: 'AC1', authToken: 'secret' } });
    const { body, contentType } = p.renderResponse([
      { type: 'say', text: 'Hi & welcome', language: 'en-IN', voice: 'Polly.Raveena' },
      { type: 'gather', numDigits: 1, actionUrl: 'https://x/ivr', prompts: [{ type: 'say', text: 'Press 1' }] },
      { type: 'dial', targets: ['client:agent_1', '+919999999999'], timeout: 20 },
      { type: 'hangup' },
    ]);
    expect(contentType).toBe('text/xml');
    expect(body).toContain('<Say language="en-IN" voice="Polly.Raveena">Hi &amp; welcome</Say>');
    expect(body).toContain('<Gather input="dtmf" numDigits="1" timeout="5" action="https://x/ivr" method="POST" actionOnEmptyResult="true"><Say>Press 1</Say></Gather>');
    expect(body).toContain('<Client>agent_1</Client><Number>+919999999999</Number>');
  });
  it('renders Plivo XML', () => {
    const p = new PlivoProvider({ credentials: { authId: 'MA1', authToken: 'tok' } });
    const { body } = p.renderResponse([{ type: 'say', text: 'Namaste' }, { type: 'gather', numDigits: 1, actionUrl: 'https://x' }]);
    expect(body).toContain('<Speak>Namaste</Speak>');
    expect(body).toContain('<GetDigits action="https://x"');
  });
  it('maps provider statuses to normalized events', () => {
    expect(eventFromStatus('in-progress').type).toBe('CALL_ANSWERED');
    expect(eventFromStatus('no-answer')).toMatchObject({ type: 'CALL_FAILED', finalStatus: 'no_answer' });
    expect(eventFromStatus('completed')).toMatchObject({ type: 'CALL_COMPLETED', finalStatus: 'completed' });
  });
  it('refuses to build a provider without credentials', () => {
    expect(() => new TwilioProvider({ credentials: {} })).toThrow(/not configured/);
  });
});

describe('security helpers', () => {
  it('encrypts and decrypts credentials', () => {
    const c = encryptJson({ authToken: 'shh' });
    expect(c).not.toContain('shh');
    expect(decryptJson(c)).toEqual({ authToken: 'shh' });
  });
  it('signs URLs that expire', () => {
    const now = Date.now();
    const { expires, sig } = signResource('recording:1', 60, now);
    expect(verifyResourceSignature('recording:1', expires, sig, now)).toBe(true);
    expect(verifyResourceSignature('recording:2', expires, sig, now)).toBe(false);
    expect(verifyResourceSignature('recording:1', expires, sig, now + 120000)).toBe(false);
  });
  it('masks and normalizes phone numbers', () => {
    expect(maskPhone('+919876543210')).toBe('+91******3210');
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('09876543210')).toBe('+919876543210');
    expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100');
    expect(isValidE164('+919876543210')).toBe(true);
    expect(isValidE164('12345')).toBe(false);
  });
  it('translates and interpolates', () => {
    expect(translate({ en: 'Hi', hi: 'Namaste' }, 'hi')).toBe('Namaste');
    expect(translate({ en: 'Hi' }, 'ta')).toBe('Hi');
    expect(interpolate('Order {{order.status}}', { order: { status: 'shipped' } })).toBe('Order shipped');
  });
});
