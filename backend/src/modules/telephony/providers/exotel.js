import { TelephonyProvider } from '../TelephonyProvider.js';
import { CALL_EVENTS, eventFromStatus } from '../events.js';
import { telephonyWebhookUrl } from '../urls.js';
import { httpRequest } from '../../../lib/http.js';
import { safeEqual } from '../../../lib/crypto.js';
import { AppError, NotConfiguredError } from '../../../lib/errors.js';

/**
 * Exotel adapter (India). Exotel's Connect API bridges the agent's phone and the customer
 * natively (agent first). IVR, queues and transfers are configured inside Exotel's own flow
 * builder, so those capabilities are reported as unsupported here.
 *
 * Exotel does not sign webhooks, so callbacks carry a per-organization secret `token`.
 */
export class ExotelProvider extends TelephonyProvider {
  constructor(options) {
    super('exotel', options);
    const { accountSid, apiKey, apiToken } = this.credentials;
    if (!accountSid || !apiKey || !apiToken) throw new NotConfiguredError('Exotel (accountSid/apiKey/apiToken)');
    if (!this.credentials.webhookToken) throw new NotConfiguredError('Exotel webhook token');
  }

  get capabilities() {
    return { outboundCall: true, inboundCall: true, recording: true };
  }

  get base() {
    const sub = this.credentials.subdomain || 'api.exotel.com';
    return `https://${sub}/v1/Accounts/${this.credentials.accountSid}`;
  }

  api(path, opts = {}) {
    return httpRequest(`${this.base}${path}`, {
      auth: { username: this.credentials.apiKey, password: this.credentials.apiToken },
      ...opts,
    });
  }

  callbackUrl(call, leg = 'customer') {
    return telephonyWebhookUrl('exotel', 'status', { callId: call._id, leg }, { token: this.credentials.webhookToken });
  }

  async makeCall({ call, agentTarget, customerNumber, callerId, record }) {
    if (!agentTarget || agentTarget.startsWith('client:')) {
      throw new AppError(422, 'Exotel calls ring the agent phone. Add a phone number to your user profile.', 'AGENT_PHONE_REQUIRED');
    }
    const res = await this.api('/Calls/connect.json', {
      method: 'POST',
      form: {
        From: agentTarget,
        To: customerNumber,
        CallerId: callerId,
        Record: record ? 'true' : 'false',
        StatusCallback: this.callbackUrl(call),
        'StatusCallbackEvents[0]': 'terminal',
        'StatusCallbackEvents[1]': 'answered',
        StatusCallbackContentType: 'application/json',
      },
    });
    const sid = res?.Call?.Sid;
    return { providerCallId: sid, legs: [{ role: 'customer', providerCallId: sid, target: customerNumber }], bridgedByProvider: true };
  }

  async getCall(providerCallId) {
    const res = await this.api(`/Calls/${providerCallId}.json`);
    return { providerCallId, status: eventFromStatus(res?.Call?.Status).finalStatus || res?.Call?.Status, raw: res };
  }

  async fetchRecordingMedia(recordingUrl) {
    const res = await fetch(recordingUrl, {
      headers: { Authorization: `Basic ${Buffer.from(`${this.credentials.apiKey}:${this.credentials.apiToken}`).toString('base64')}` },
    });
    if (!res.ok) throw new AppError(502, 'Could not fetch recording from provider', 'PROVIDER_ERROR');
    return res;
  }

  validateWebhook({ query }) {
    return Boolean(query.token) && safeEqual(query.token, this.credentials.webhookToken);
  }

  parseWebhook({ query, params }) {
    const status = params.Status || params.CallStatus || params.EventType;
    const base = {
      providerCallId: params.CallSid,
      callId: query.callId,
      leg: query.leg || 'customer',
      from: params.From,
      to: params.To,
      raw: params,
    };
    if (query.evt === 'passthru') {
      return { ...base, type: CALL_EVENTS.CALL_RINGING, direction: 'inbound', leg: 'inbound' };
    }
    const mapped = eventFromStatus(status);
    const events = [{
      ...base, ...mapped, status, durationSeconds: Number(params.ConversationDuration || params.DialCallDuration || 0),
    }];
    if (params.RecordingUrl) {
      events.push({
        ...base,
        type: CALL_EVENTS.CALL_RECORDING_READY,
        recording: { recordingId: params.CallSid, url: params.RecordingUrl, duration: Number(params.ConversationDuration || 0) },
      });
    }
    return events;
  }

  renderResponse() {
    // Exotel Passthru applets only need a 200 OK.
    return { contentType: 'text/plain', body: 'OK' };
  }
}
