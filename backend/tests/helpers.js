import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { drainListeners } from '../src/listeners.js';
import { TelephonyProvider } from '../src/modules/telephony/TelephonyProvider.js';
import { TwilioProvider } from '../src/modules/telephony/providers/twilio.js';
import { registerTelephonyProvider } from '../src/modules/telephony/registry.js';
import { registerMessagingProvider } from '../src/modules/messaging/providers.js';
import { setLlmOverride } from '../src/modules/ai/llm.js';
import { setTranscriberOverride } from '../src/modules/ai/transcription.js';
import { Organization, PhoneNumber } from '../src/models/index.js';

/**
 * TEST DOUBLE ONLY — never registered outside the test suite.
 * Records every provider operation instead of placing real calls. It reuses Twilio's webhook
 * parser and TwiML renderer so webhook handling is exercised end-to-end.
 */
export class FakeTelephonyProvider extends TelephonyProvider {
  static ops = [];

  static caps = null;

  constructor() {
    super('fake', { credentials: { token: 'x' } });
    this.seq = 0;
  }

  get capabilities() {
    return FakeTelephonyProvider.caps || {
      outboundCall: true, inboundCall: true, webrtc: true, mute: true, hold: true, transferBlind: true, transferWarm: true,
      conference: true, dtmf: true, recording: true, recordingDelete: true, monitorListen: true, monitorWhisper: true,
      monitorBarge: true, numberProvisioning: false, ivr: true, queueDispatch: true, speechGather: true, redirect: true,
    };
  }

  record(op, args) {
    FakeTelephonyProvider.ops.push({ op, args });
    return `FAKE${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  }

  async makeCall(p) {
    const id = this.record('makeCall', { agentTarget: p.agentTarget, customerNumber: p.customerNumber, callerId: p.callerId });
    return { providerCallId: id, legs: [{ role: 'agent', providerCallId: id, target: p.agentTarget }] };
  }

  async dialCustomer(p) {
    return { role: 'customer', providerCallId: this.record('dialCustomer', { customerNumber: p.customerNumber, consentText: p.consentText }), target: p.customerNumber };
  }

  async connectAgent(p) {
    return { role: 'agent', providerCallId: this.record('connectAgent', { agentTarget: p.agentTarget }), target: p.agentTarget };
  }

  async makeAutomatedCall(p) {
    return { role: 'customer', providerCallId: this.record('makeAutomatedCall', { to: p.to, url: p.url }), target: p.to };
  }

  async hangup(id) { this.record('hangup', { id }); }

  async redirectCall(id, url) { this.record('redirectCall', { id, url }); }

  async hold(p) { this.record('hold', { participantCallId: p.participantCallId }); }

  async resume(p) { this.record('resume', { participantCallId: p.participantCallId }); }

  async mute(p) { this.record('mute', { muted: p.muted }); }

  async transfer(p) {
    this.record('transfer', { type: p.type, phase: p.phase, target: p.target, redirectUrl: p.redirectUrl });
    if (p.redirectUrl || p.phase !== 'start') return {};
    return { leg: { role: p.type === 'blind' ? 'transfer' : 'consult', providerCallId: this.record('transferLeg', {}), target: p.target } };
  }

  async conference(p) {
    return { role: 'participant', providerCallId: this.record('conference', { to: p.to }), target: p.to };
  }

  async sendDTMF(p) { this.record('sendDTMF', { digits: p.digits }); }

  async monitor(p) {
    return { role: 'supervisor', providerCallId: this.record('monitor', { mode: p.mode }), target: p.supervisorTarget };
  }

  async fetchRecordingMedia() {
    return new Response(Buffer.from('fake-audio'), { headers: { 'content-type': 'audio/mpeg' } });
  }

  async deleteRecording(id) { this.record('deleteRecording', { id }); }

  async createClientToken(identity) { return { token: 'fake-token', identity, provider: 'fake' }; }

  validateWebhook({ headers }) { return headers['x-test-signature'] === 'valid'; }

  parseWebhook(args) { return TwilioProvider.prototype.parseWebhook.call(this, args); }

  renderResponse(actions) { return TwilioProvider.prototype.renderResponse.call(this, actions); }
}

/** TEST DOUBLE ONLY — fake SMS/WhatsApp provider. */
export class FakeMessagingProvider {
  static sent = [];

  constructor() {
    this.name = 'fakesms';
    this.channels = ['sms', 'whatsapp'];
  }

  async send(msg) {
    FakeMessagingProvider.sent.push(msg);
    return { providerMessageId: `SM${Date.now()}${Math.random()}`, status: 'sent' };
  }

  validateWebhook({ headers }) { return headers['x-test-signature'] === 'valid'; }

  parseWebhook({ params }) {
    if (params.MessageStatus) return [{ kind: 'status', providerMessageId: params.MessageSid, status: params.MessageStatus }];
    return [{ kind: 'inbound', channel: 'sms', from: params.From, to: params.To, body: params.Body, providerMessageId: params.MessageSid }];
  }
}

registerTelephonyProvider('fake', () => new FakeTelephonyProvider(), () => ({ token: 'x' }));
registerMessagingProvider('sms', 'fakesms', () => new FakeMessagingProvider(), () => ({ token: 'x' }));
registerMessagingProvider('whatsapp', 'fakesms', () => new FakeMessagingProvider(), () => ({ token: 'x' }));

let mongo;
export const app = createApp();
export const http = () => request(app);

export function useDatabase() {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
  });
  afterAll(async () => {
    await drainListeners();
    await mongoose.disconnect();
    await mongo?.stop();
  });
  beforeEach(async () => {
    await drainListeners();
    FakeTelephonyProvider.ops = [];
    FakeTelephonyProvider.caps = null;
    FakeMessagingProvider.sent = [];
    setLlmOverride(null);
    setTranscriberOverride(null);
    const collections = await mongoose.connection.db.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  });
}

let counter = 0;

/** Registers an organization and returns { token, user, org, auth } for the admin. */
export async function registerOrg(name = 'Acme') {
  counter += 1;
  const res = await http().post('/api/v1/auth/register').send({
    organizationName: name, name: 'Admin User', email: `admin${counter}@example.com`, password: 'password123',
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, user: res.body.user, org: res.body.organization, auth: { Authorization: `Bearer ${res.body.token}` } };
}

export async function addUser(admin, { role = 'agent', name = 'Agent', phone } = {}) {
  counter += 1;
  const email = `user${counter}@example.com`;
  const res = await http().post('/api/v1/users').set(admin.auth).send({ name, email, password: 'password123', role, phone });
  if (res.status !== 201) throw new Error(`add user failed: ${JSON.stringify(res.body)}`);
  const login = await http().post('/api/v1/auth/login').send({ email, password: 'password123' });
  return { token: login.body.token, user: login.body.user, auth: { Authorization: `Bearer ${login.body.token}` } };
}

/** Configures the fake telephony provider + a voice/SMS number for an organization. */
export async function enableTelephony(orgId, numberFields = {}) {
  await Organization.updateOne({ _id: orgId }, { $set: { 'settings.telephonyProvider': 'fake', 'settings.smsProvider': 'fakesms', 'settings.whatsappProvider': 'fakesms' } });
  return PhoneNumber.create({
    organizationId: orgId, number: '+918000000001', provider: 'fake', capabilities: { voice: true, sms: true, whatsapp: true },
    isDefaultCallerId: true, ...numberFields,
  });
}

/** Posts a telephony webhook as the fake provider (Twilio-style params). */
export function webhook(query, params, { valid = true } = {}) {
  const qs = new URLSearchParams(query).toString();
  return http().post(`/api/v1/webhooks/telephony/fake?${qs}`)
    .set('x-test-signature', valid ? 'valid' : 'nope')
    .type('form')
    .send(params);
}

export function ops(name) {
  return FakeTelephonyProvider.ops.filter((o) => o.op === name);
}

export { drainListeners };

/** Scripted LLM for tests: pops responses in order. */
export function scriptedLlm(responses, extractResult) {
  const queue = [...responses];
  const calls = [];
  return {
    name: 'scripted',
    model: 'test',
    calls,
    async complete(args) {
      calls.push(args);
      const next = queue.shift() || { text: 'ok' };
      const content = [];
      if (next.text) content.push({ type: 'text', text: next.text });
      for (const t of next.tools || []) content.push({ type: 'tool_use', id: `tu_${Math.random()}`, name: t.name, input: t.input });
      return {
        text: next.text || '',
        toolCalls: content.filter((c) => c.type === 'tool_use').map((c) => ({ id: c.id, name: c.name, input: c.input })),
        stopReason: next.tools?.length ? 'tool_use' : 'end_turn',
        raw: { content },
      };
    },
    async extract() {
      return typeof extractResult === 'function' ? extractResult() : extractResult;
    },
  };
}
