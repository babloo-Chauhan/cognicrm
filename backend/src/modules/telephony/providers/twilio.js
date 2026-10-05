import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { TelephonyProvider } from '../TelephonyProvider.js';
import { eventFromStatus, CALL_EVENTS } from '../events.js';
import { messagingWebhookUrl, telephonyWebhookUrl } from '../urls.js';
import { document, el } from '../xml.js';
import { httpRequest } from '../../../lib/http.js';
import { safeEqual } from '../../../lib/crypto.js';
import { AppError, NotConfiguredError } from '../../../lib/errors.js';

const API = 'https://api.twilio.com/2010-04-01';

/** Twilio X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted(key+value)...)) */
export function twilioSignature(authToken, url, params = {}) {
  const data = Object.keys(params).sort().reduce((acc, key) => {
    const value = params[key];
    return acc + (Array.isArray(value) ? value.map((v) => key + v).join('') : key + value);
  }, url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

/**
 * Twilio adapter. Every call is built around a named conference (`call-<id>`), which is what
 * makes hold, warm/consult transfer, three-way calls and supervisor monitoring possible.
 */
export class TwilioProvider extends TelephonyProvider {
  constructor(options) {
    super('twilio', options);
    const { accountSid, authToken } = this.credentials;
    if (!accountSid || !authToken) throw new NotConfiguredError('Twilio (accountSid/authToken)');
  }

  get capabilities() {
    const webrtc = Boolean(this.credentials.apiKeySid && this.credentials.apiKeySecret && this.credentials.twimlAppSid);
    return {
      outboundCall: true, inboundCall: true, webrtc, mute: true, hold: true, transferBlind: true, transferWarm: true,
      conference: true, dtmf: true, recording: true, recordingDelete: true, monitorListen: true, monitorWhisper: true,
      monitorBarge: true, numberProvisioning: true, ivr: true, queueDispatch: true, speechGather: true, redirect: true,
    };
  }

  get auth() {
    return { username: this.credentials.accountSid, password: this.credentials.authToken };
  }

  api(path, opts = {}) {
    return httpRequest(`${API}/Accounts/${this.credentials.accountSid}${path}`, { auth: this.auth, ...opts });
  }

  statusCallback(call, leg) {
    return telephonyWebhookUrl('twilio', 'status', { callId: call._id, leg });
  }

  conferenceTwiml(call, { record, startOnEnter = true, endOnExit = false, waitUrl, prefix = [], muted, beep } = {}) {
    const conf = el('Conference', {
      startConferenceOnEnter: String(startOnEnter),
      endConferenceOnExit: String(endOnExit),
      beep: beep === undefined ? 'false' : String(beep),
      muted: muted ? 'true' : undefined,
      waitUrl: waitUrl ?? '',
      record: record ? 'record-from-start' : undefined,
      recordingStatusCallback: record ? telephonyWebhookUrl('twilio', 'recording', { callId: call._id }) : undefined,
      recordingStatusCallbackEvent: record ? 'completed' : undefined,
    }, call.conferenceName);
    return document([...prefix, el('Dial', {}, [conf])]);
  }

  async createLeg(call, { to, from, twiml, leg, timeout = 30, extra = {} }) {
    const res = await this.api('/Calls.json', {
      method: 'POST',
      form: {
        To: to,
        From: from,
        Twiml: twiml,
        Timeout: timeout,
        StatusCallback: this.statusCallback(call, leg),
        StatusCallbackMethod: 'POST',
        StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        ...extra,
      },
    });
    return { role: leg, providerCallId: res.sid, target: to };
  }

  async makeCall({ call, agentTarget, callerId }) {
    // Agent leg first; the customer is dialed when the agent answers (see dialCustomer).
    const agentLeg = await this.createLeg(call, {
      to: agentTarget,
      from: callerId,
      leg: 'agent',
      twiml: this.conferenceTwiml(call, { record: false, startOnEnter: true, endOnExit: false }),
    });
    return { providerCallId: agentLeg.providerCallId, legs: [agentLeg] };
  }

  async dialCustomer({ call, customerNumber, callerId, record, consentText, language, voice }) {
    const prefix = consentText ? [el('Say', { language, voice }, consentText)] : [];
    return this.createLeg(call, {
      to: customerNumber,
      from: callerId,
      leg: 'customer',
      twiml: this.conferenceTwiml(call, { record, startOnEnter: true, endOnExit: true, prefix }),
      timeout: 40,
    });
  }

  async makeAutomatedCall({ call, to, callerId, url }) {
    const res = await this.api('/Calls.json', {
      method: 'POST',
      form: {
        To: to,
        From: callerId,
        Url: url,
        Method: 'POST',
        StatusCallback: this.statusCallback(call, 'customer'),
        StatusCallbackMethod: 'POST',
        StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      },
    });
    return { role: 'customer', providerCallId: res.sid, target: to };
  }

  async connectAgent({ call, agentTarget, callerId, leg = 'agent' }) {
    return this.createLeg(call, {
      to: agentTarget,
      from: callerId,
      leg,
      timeout: 20,
      twiml: this.conferenceTwiml(call, { startOnEnter: true, endOnExit: false }),
    });
  }

  async hangup(providerCallId) {
    await this.api(`/Calls/${providerCallId}.json`, { method: 'POST', form: { Status: 'completed' } });
  }

  async redirectCall(providerCallId, url) {
    await this.api(`/Calls/${providerCallId}.json`, { method: 'POST', form: { Url: url, Method: 'POST' } });
  }

  async findConferenceSid(call) {
    const res = await this.api(`/Conferences.json?FriendlyName=${encodeURIComponent(call.conferenceName)}&Status=in-progress`);
    const sid = res?.conferences?.[0]?.sid;
    if (!sid) throw new AppError(409, 'The call conference is not active', 'CALL_NOT_ACTIVE');
    return sid;
  }

  async updateParticipant(call, participantCallId, form) {
    const conf = await this.findConferenceSid(call);
    await this.api(`/Conferences/${conf}/Participants/${participantCallId}.json`, { method: 'POST', form });
  }

  async hold({ call, participantCallId, musicUrl }) {
    await this.updateParticipant(call, participantCallId, { Hold: 'true', HoldUrl: musicUrl || undefined });
  }

  async resume({ call, participantCallId }) {
    await this.updateParticipant(call, participantCallId, { Hold: 'false' });
  }

  async mute({ call, participantCallId, muted }) {
    await this.updateParticipant(call, participantCallId, { Muted: String(Boolean(muted)) });
  }

  async addParticipant({ call, to, callerId, label, muted = false, coachCallId, role = 'participant' }) {
    const conf = await this.findConferenceSid(call);
    const res = await this.api(`/Conferences/${conf}/Participants.json`, {
      method: 'POST',
      form: {
        From: callerId,
        To: to,
        Label: label,
        Muted: String(muted),
        Coaching: coachCallId ? 'true' : undefined,
        CallSidToCoach: coachCallId,
        EndConferenceOnExit: 'false',
        StatusCallback: this.statusCallback(call, role),
        StatusCallbackEvent: ['ringing', 'answered', 'completed'],
      },
    });
    return { role, providerCallId: res.call_sid, target: to };
  }

  async conference({ call, to, callerId }) {
    return this.addParticipant({ call, to, callerId, label: `p-${Date.now()}`, role: 'participant' });
  }

  async transfer({ call, type, phase = 'start', target, callerId, customerCallId, agentCallId, consultCallId, redirectUrl }) {
    if (type === 'blind') {
      if (redirectUrl) {
        await this.redirectCall(customerCallId, redirectUrl);
      } else {
        // Ring the new target into the conference, then drop the current agent.
        const leg = await this.addParticipant({ call, to: target, callerId, label: `t-${Date.now()}`, role: 'transfer' });
        if (agentCallId) await this.hangup(agentCallId).catch(() => null);
        return { leg };
      }
      if (agentCallId) await this.hangup(agentCallId).catch(() => null);
      return {};
    }
    // warm / consult
    if (phase === 'start') {
      if (type === 'consult') await this.hold({ call, participantCallId: customerCallId });
      const leg = await this.addParticipant({ call, to: target, callerId, label: `c-${Date.now()}`, role: 'consult' });
      return { leg };
    }
    if (phase === 'complete') {
      if (type === 'consult') await this.resume({ call, participantCallId: customerCallId }).catch(() => null);
      if (agentCallId) await this.hangup(agentCallId);
      return {};
    }
    if (phase === 'cancel') {
      if (consultCallId) await this.hangup(consultCallId).catch(() => null);
      if (type === 'consult') await this.resume({ call, participantCallId: customerCallId }).catch(() => null);
      return {};
    }
    throw new AppError(400, `Unknown transfer phase ${phase}`);
  }

  async sendDTMF({ call, customerCallId, digits }) {
    // Plays the digits to the customer leg, then puts it back into the conference.
    const twiml = document([
      el('Play', { digits: String(digits).replace(/[^0-9*#wW]/g, '') }),
      el('Dial', {}, [el('Conference', { endConferenceOnExit: 'true', beep: 'false', waitUrl: '' }, call.conferenceName)]),
    ]);
    await this.api(`/Calls/${customerCallId}.json`, { method: 'POST', form: { Twiml: twiml } });
  }

  async monitor({ call, mode, supervisorTarget, agentCallId, callerId }) {
    return this.addParticipant({
      call,
      to: supervisorTarget,
      callerId,
      label: `sup-${Date.now()}`,
      muted: mode === 'listen',
      coachCallId: mode === 'whisper' ? agentCallId : undefined,
      role: 'supervisor',
    });
  }

  async getCall(providerCallId) {
    const res = await this.api(`/Calls/${providerCallId}.json`);
    return { providerCallId: res.sid, status: eventFromStatus(res.status).finalStatus || res.status, raw: res };
  }

  async getRecording(recordingId) {
    return this.api(`/Recordings/${recordingId}.json`);
  }

  async fetchRecordingMedia(recordingId) {
    const url = `${API}/Accounts/${this.credentials.accountSid}/Recordings/${recordingId}.mp3`;
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64')}` },
    });
    if (!res.ok) throw new AppError(502, 'Could not fetch recording from provider', 'PROVIDER_ERROR');
    return res;
  }

  async deleteRecording(recordingId) {
    await this.api(`/Recordings/${recordingId}.json`, { method: 'DELETE' });
  }

  async searchNumbers({ country = 'IN', type = 'Local', contains, limit = 20 }) {
    const qs = new URLSearchParams({ PageSize: String(limit) });
    if (contains) qs.set('Contains', contains);
    const res = await this.api(`/AvailablePhoneNumbers/${country}/${type}.json?${qs}`);
    return (res.available_phone_numbers || []).map((n) => ({
      number: n.phone_number, country: n.iso_country, capabilities: { voice: n.capabilities?.voice, sms: n.capabilities?.SMS },
    }));
  }

  async createNumber({ number }) {
    const res = await this.api('/IncomingPhoneNumbers.json', {
      method: 'POST',
      form: {
        PhoneNumber: number,
        VoiceUrl: telephonyWebhookUrl('twilio', 'voice'),
        VoiceMethod: 'POST',
        StatusCallback: telephonyWebhookUrl('twilio', 'status'),
        SmsUrl: messagingWebhookUrl('twilio'),
      },
    });
    return { providerNumberId: res.sid, number: res.phone_number };
  }

  async releaseNumber(providerNumberId) {
    await this.api(`/IncomingPhoneNumbers/${providerNumberId}.json`, { method: 'DELETE' });
  }

  async configureWebhook(providerNumberId) {
    await this.api(`/IncomingPhoneNumbers/${providerNumberId}.json`, {
      method: 'POST',
      form: {
        VoiceUrl: telephonyWebhookUrl('twilio', 'voice'),
        VoiceMethod: 'POST',
        StatusCallback: telephonyWebhookUrl('twilio', 'status'),
        SmsUrl: messagingWebhookUrl('twilio'),
      },
    });
  }

  async createClientToken(identity, ttlSeconds = 3600) {
    const { accountSid, apiKeySid, apiKeySecret, twimlAppSid } = this.credentials;
    if (!apiKeySid || !apiKeySecret || !twimlAppSid) this.unsupported('webrtc');
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({
      jti: `${apiKeySid}-${now}`,
      grants: { identity, voice: { incoming: { allow: true }, outgoing: { application_sid: twimlAppSid } } },
    }, apiKeySecret, {
      issuer: apiKeySid,
      subject: accountSid,
      expiresIn: ttlSeconds,
      header: { cty: 'twilio-fpa;v=1', typ: 'JWT', alg: 'HS256' },
    });
    return { token, identity, provider: 'twilio', expiresIn: ttlSeconds };
  }

  clientTarget(userId) {
    return `client:agent_${userId}`;
  }

  validateWebhook({ url, params, headers }) {
    const signature = headers['x-twilio-signature'];
    if (!signature) return false;
    return safeEqual(twilioSignature(this.credentials.authToken, url, params), signature);
  }

  parseWebhook({ query, params }) {
    const evt = query.evt;
    const base = {
      providerCallId: params.CallSid,
      callId: query.callId,
      leg: query.leg,
      from: params.From,
      to: params.To,
      direction: params.Direction,
      raw: params,
    };
    if (evt === 'recording' || evt === 'voicemail') {
      return {
        ...base,
        type: CALL_EVENTS.CALL_RECORDING_READY,
        recording: {
          recordingId: params.RecordingSid,
          url: params.RecordingUrl,
          duration: Number(params.RecordingDuration || 0),
          status: params.RecordingStatus,
        },
      };
    }
    if (evt === 'status') {
      const mapped = eventFromStatus(params.CallStatus);
      return { ...base, ...mapped, status: params.CallStatus, durationSeconds: Number(params.CallDuration || 0) };
    }
    return {
      ...base,
      type: null,
      digits: params.Digits,
      speech: params.SpeechResult,
      dialStatus: params.DialCallStatus,
      sequence: params.SequenceNumber,
    };
  }

  renderResponse(actions) {
    return { contentType: 'text/xml', body: document(actions.map((a) => renderTwiml(a))) };
  }
}

function renderTwiml(a) {
  switch (a.type) {
    case 'say':
      return el('Say', { language: a.language, voice: a.voice }, a.text);
    case 'play':
      return el('Play', { loop: a.loop }, a.url);
    case 'pause':
      return el('Pause', { length: a.seconds || 1 });
    case 'gather':
      return el('Gather', {
        input: a.input || 'dtmf',
        numDigits: a.numDigits,
        timeout: a.timeout || 5,
        finishOnKey: a.finishOnKey,
        action: a.actionUrl,
        method: 'POST',
        language: a.language,
        speechTimeout: a.input?.includes('speech') ? (a.speechTimeout || 'auto') : undefined,
        actionOnEmptyResult: 'true',
      }, (a.prompts || []).map(renderTwiml));
    case 'dial':
      return el('Dial', {
        timeout: a.timeout || 20,
        action: a.actionUrl,
        method: 'POST',
        callerId: a.callerId,
        record: a.record ? 'record-from-answer' : undefined,
      }, a.targets.map((t) => {
        if (t.startsWith('client:')) return el('Client', {}, t.slice(7));
        if (t.startsWith('sip:')) return el('Sip', {}, t);
        return el('Number', {}, t);
      }));
    case 'conference':
      return el('Dial', { action: a.actionUrl, method: 'POST' }, [el('Conference', {
        startConferenceOnEnter: String(a.startOnEnter ?? true),
        endConferenceOnExit: String(a.endOnExit ?? false),
        waitUrl: a.waitUrl ?? '',
        beep: 'false',
        record: a.record ? 'record-from-start' : undefined,
        recordingStatusCallback: a.recordingCallbackUrl,
        recordingStatusCallbackEvent: a.record ? 'completed' : undefined,
      }, a.name)]);
    case 'record':
      return el('Record', {
        action: a.actionUrl,
        method: 'POST',
        maxLength: a.maxLength || 120,
        playBeep: 'true',
        finishOnKey: '#',
        recordingStatusCallback: a.recordingCallbackUrl,
        recordingStatusCallbackEvent: a.recordingCallbackUrl ? 'completed' : undefined,
      });
    case 'redirect':
      return el('Redirect', { method: 'POST' }, a.url);
    case 'reject':
      return el('Reject');
    case 'hangup':
    default:
      return el('Hangup');
  }
}
