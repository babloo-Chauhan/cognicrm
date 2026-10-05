import crypto from 'node:crypto';
import { TelephonyProvider } from '../TelephonyProvider.js';
import { CALL_EVENTS, eventFromStatus } from '../events.js';
import { telephonyWebhookUrl } from '../urls.js';
import { document, el } from '../xml.js';
import { httpRequest } from '../../../lib/http.js';
import { safeEqual } from '../../../lib/crypto.js';
import { AppError, NotConfiguredError } from '../../../lib/errors.js';

/** Plivo X-Plivo-Signature-V2: base64(HMAC-SHA256(authToken, url-without-query + nonce)). */
export function plivoSignatureV2(authToken, url, nonce) {
  const u = new URL(url);
  const base = `${u.protocol}//${u.host}${u.pathname}`;
  return crypto.createHmac('sha256', authToken).update(base + nonce).digest('base64');
}

/**
 * Plivo adapter: outbound/inbound calls, IVR via Plivo XML, DTMF and blind transfer.
 * Conference-member hold/mute/monitoring are not implemented for Plivo here.
 */
export class PlivoProvider extends TelephonyProvider {
  constructor(options) {
    super('plivo', options);
    if (!this.credentials.authId || !this.credentials.authToken) throw new NotConfiguredError('Plivo (authId/authToken)');
  }

  get capabilities() {
    return {
      outboundCall: true, inboundCall: true, ivr: true, dtmf: true, transferBlind: true, recording: true,
      queueDispatch: true, redirect: true, speechGather: false,
    };
  }

  api(path, opts = {}) {
    return httpRequest(`https://api.plivo.com/v1/Account/${this.credentials.authId}${path}`, {
      auth: { username: this.credentials.authId, password: this.credentials.authToken },
      ...opts,
    });
  }

  async createLeg(call, { to, from, leg, timeout = 30 }) {
    const res = await this.api('/Call/', {
      method: 'POST',
      json: {
        from: from.replace(/^\+/, ''),
        to: to.startsWith('client:') ? `sip:${to.slice(7)}@phone.plivo.com` : to.replace(/^\+/, ''),
        answer_url: telephonyWebhookUrl('plivo', 'answer', { callId: call._id, leg }),
        answer_method: 'POST',
        hangup_url: telephonyWebhookUrl('plivo', 'status', { callId: call._id, leg }),
        ring_url: telephonyWebhookUrl('plivo', 'status', { callId: call._id, leg, ring: 1 }),
        ring_timeout: timeout,
      },
    });
    // Plivo returns a request_uuid; the call_uuid arrives with the first callback.
    return { role: leg, providerCallId: res.request_uuid, target: to };
  }

  async makeCall({ call, agentTarget, callerId }) {
    const leg = await this.createLeg(call, { to: agentTarget, from: callerId, leg: 'agent' });
    return { providerCallId: leg.providerCallId, legs: [leg] };
  }

  async dialCustomer({ call, customerNumber, callerId }) {
    return this.createLeg(call, { to: customerNumber, from: callerId, leg: 'customer', timeout: 40 });
  }

  async connectAgent({ call, agentTarget, callerId, leg = 'agent' }) {
    return this.createLeg(call, { to: agentTarget, from: callerId, leg, timeout: 20 });
  }

  async hangup(providerCallId) {
    await this.api(`/Call/${providerCallId}/`, { method: 'DELETE' });
  }

  async redirectCall(providerCallId, url) {
    await this.api(`/Call/${providerCallId}/`, { method: 'POST', json: { legs: 'aleg', aleg_url: url, aleg_method: 'POST' } });
  }

  async transfer({ type, customerCallId, agentCallId, redirectUrl }) {
    if (type !== 'blind' || !redirectUrl) this.unsupported('transferWarm');
    await this.redirectCall(customerCallId, redirectUrl);
    if (agentCallId) await this.hangup(agentCallId).catch(() => null);
    return {};
  }

  async sendDTMF({ customerCallId, digits }) {
    await this.api(`/Call/${customerCallId}/DTMF/`, { method: 'POST', json: { digits: String(digits), leg: 'aleg' } });
  }

  async getCall(providerCallId) {
    const res = await this.api(`/Call/${providerCallId}/`);
    return { providerCallId, status: res?.call_state || res?.hangup_cause_name, raw: res };
  }

  async fetchRecordingMedia(recordingUrl) {
    const res = await fetch(recordingUrl);
    if (!res.ok) throw new AppError(502, 'Could not fetch recording from provider', 'PROVIDER_ERROR');
    return res;
  }

  async deleteRecording(recordingId) {
    await this.api(`/Recording/${recordingId}/`, { method: 'DELETE' });
  }

  validateWebhook({ url, headers }) {
    const signature = headers['x-plivo-signature-v2'];
    const nonce = headers['x-plivo-signature-v2-nonce'];
    if (!signature || !nonce) return false;
    return safeEqual(plivoSignatureV2(this.credentials.authToken, url, nonce), signature);
  }

  parseWebhook({ query, params }) {
    const base = {
      providerCallId: params.CallUUID,
      requestId: params.RequestUUID,
      callId: query.callId,
      leg: query.leg,
      from: params.From,
      to: params.To,
      direction: params.Direction,
      raw: params,
    };
    if (query.evt === 'recording' || query.evt === 'voicemail') {
      return {
        ...base,
        type: CALL_EVENTS.CALL_RECORDING_READY,
        recording: { recordingId: params.RecordingID, url: params.RecordUrl, duration: Number(params.RecordingDuration || 0) },
      };
    }
    if (query.evt === 'status') {
      const status = query.ring ? 'ringing' : (params.CallStatus || params.Event);
      const mapped = eventFromStatus(status);
      return { ...base, ...mapped, status, durationSeconds: Number(params.Duration || params.BillDuration || 0) };
    }
    if (query.evt === 'answer') {
      return { ...base, type: CALL_EVENTS.CALL_ANSWERED, status: 'in-progress' };
    }
    return { ...base, type: null, digits: params.Digits, dialStatus: params.DialStatus };
  }

  renderResponse(actions) {
    return { contentType: 'text/xml', body: document(actions.map(renderPlivo)) };
  }
}

function renderPlivo(a) {
  switch (a.type) {
    case 'say':
      return el('Speak', { language: a.language, voice: a.voice }, a.text);
    case 'play':
      return el('Play', { loop: a.loop }, a.url);
    case 'pause':
      return el('Wait', { length: a.seconds || 1 });
    case 'gather':
      return el('GetDigits', {
        action: a.actionUrl, method: 'POST', numDigits: a.numDigits || 99, timeout: a.timeout || 5,
        finishOnKey: a.finishOnKey, redirect: 'true',
      }, (a.prompts || []).map(renderPlivo));
    case 'dial':
      return el('Dial', { action: a.actionUrl, method: 'POST', timeout: a.timeout || 20, callerId: a.callerId },
        a.targets.map((t) => (t.startsWith('client:') ? el('User', {}, `sip:${t.slice(7)}@phone.plivo.com`) : el('Number', {}, t.replace(/^\+/, '')))));
    case 'conference':
      return el('Conference', {
        startConferenceOnEnter: String(a.startOnEnter ?? true),
        endConferenceOnExit: String(a.endOnExit ?? false),
        waitSound: a.waitUrl || undefined,
        record: a.record ? 'true' : undefined,
        callbackUrl: a.recordingCallbackUrl,
        callbackMethod: 'POST',
      }, a.name);
    case 'record':
      return el('Record', {
        action: a.actionUrl, method: 'POST', maxLength: a.maxLength || 120, playBeep: 'true', finishOnKey: '#',
        callbackUrl: a.recordingCallbackUrl,
      });
    case 'redirect':
      return el('Redirect', { method: 'POST' }, a.url);
    case 'reject':
    case 'hangup':
    default:
      return el('Hangup');
  }
}
