import { env } from '../../config/env.js';

/**
 * Builds the single inbound webhook URL (POST /api/v1/webhooks/telephony/:provider) with an
 * `evt` discriminator and context params. Providers call it for status updates, voice
 * instructions, IVR input, recordings, voicemail, etc.
 */
export function telephonyWebhookUrl(provider, evt, params = {}, extra = {}) {
  const url = new URL(`/api/v1/webhooks/telephony/${provider}`, env.publicBaseUrl);
  url.searchParams.set('evt', evt);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  if (extra.token) url.searchParams.set('token', extra.token);
  return url.toString();
}

export function messagingWebhookUrl(provider) {
  return new URL(`/api/v1/webhooks/messaging/${provider}`, env.publicBaseUrl).toString();
}
