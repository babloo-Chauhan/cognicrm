import { Integration, Organization } from '../../models/index.js';
import { decryptJson } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { AppError, NotConfiguredError } from '../../lib/errors.js';
import { TwilioProvider } from './providers/twilio.js';
import { ExotelProvider } from './providers/exotel.js';
import { PlivoProvider } from './providers/plivo.js';

/**
 * Provider adapters that are implemented against real provider APIs. Other providers
 * (Vonage, Telnyx, Amazon Connect, Asterisk/FreeSWITCH via ARI/ESL, ...) plug in by adding a class
 * that extends TelephonyProvider and registering it here.
 */
const FACTORIES = {
  twilio: (opts) => new TwilioProvider(opts),
  exotel: (opts) => new ExotelProvider(opts),
  plivo: (opts) => new PlivoProvider(opts),
};

const ENV_CREDENTIALS = {
  twilio: () => env.twilio,
  exotel: () => ({ ...env.exotel, webhookToken: env.exotel.webhookToken }),
  plivo: () => env.plivo,
};

export const SUPPORTED_TELEPHONY_PROVIDERS = () => Object.keys(FACTORIES);

/** Used by tests (and future plugins) to register an adapter. */
export function registerTelephonyProvider(name, factory, envCredentials) {
  FACTORIES[name] = factory;
  if (envCredentials) ENV_CREDENTIALS[name] = envCredentials;
}

export async function loadIntegration(orgId, kind, provider) {
  const integration = await Integration.findOne({ organizationId: orgId, kind, provider, enabled: true }).select('+credentials').lean();
  if (!integration) return null;
  try {
    return { credentials: decryptJson(integration.credentials) || {}, config: integration.config || {} };
  } catch {
    // Happens when ENCRYPTION_KEY changed after the credentials were saved.
    throw new AppError(424, `Saved ${provider} credentials can no longer be decrypted (the server encryption key changed). Re-enter them in Calling → Settings.`, 'CREDENTIALS_UNREADABLE', { kind, provider });
  }
}

function hasEnvCredentials(name) {
  const creds = ENV_CREDENTIALS[name]?.();
  return creds && Object.values(creds).some(Boolean);
}

/**
 * Resolves the telephony provider for an organization: organization integration (encrypted
 * credentials) first, then global environment credentials. Returns null when nothing is configured.
 */
export async function getTelephonyProvider(orgId, name) {
  let providerName = name;
  if (!providerName) {
    const org = await Organization.findById(orgId).select('settings.telephonyProvider').lean();
    providerName = org?.settings?.telephonyProvider;
  }
  if (!providerName || !FACTORIES[providerName]) return null;
  const integration = await loadIntegration(orgId, 'telephony', providerName);
  if (integration) return FACTORIES[providerName](integration);
  if (hasEnvCredentials(providerName)) return FACTORIES[providerName]({ credentials: ENV_CREDENTIALS[providerName](), config: {} });
  return null;
}

export async function requireTelephonyProvider(orgId, name) {
  const provider = await getTelephonyProvider(orgId, name);
  if (!provider) throw new NotConfiguredError('A telephony provider');
  return provider;
}
