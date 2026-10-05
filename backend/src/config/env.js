import 'dotenv/config';
import dns from 'node:dns';

// Node's resolver on some Windows/ISP setups refuses SRV queries (querySrv ECONNREFUSED)
// for mongodb+srv URIs. Use public DNS unless overridden via DNS_SERVERS (comma-separated, 'system' to skip).
if (process.env.DNS_SERVERS !== 'system') {
  dns.setServers((process.env.DNS_SERVERS || '8.8.8.8,1.1.1.1').split(',').map((x) => x.trim()));
}

const isTest = process.env.NODE_ENV === 'test';

function required(name, fallbackForDev) {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return fallbackForDev;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isTest,
  port: Number(process.env.PORT || 5000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cognieos',
  jwtSecret: required('JWT_SECRET', 'dev-only-jwt-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  // 32-byte key (hex or any string, it is hashed to 32 bytes) used for credential encryption
  encryptionKey: required('ENCRYPTION_KEY', 'dev-only-encryption-key-change-me'),
  // Secret used to sign short-lived recording URLs
  signingSecret: required('URL_SIGNING_SECRET', 'dev-only-url-signing-secret'),
  // Public base URL the telephony providers can reach for webhooks (e.g. https://crm.example.com)
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:5000',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  jobsEnabled: process.env.JOBS_ENABLED !== 'false' && !isTest,

  // Firebase service account for FCM push to native Android tokens (inline JSON or a file path)
  firebase: {
    serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT,
    serviceAccountFile: process.env.FIREBASE_SERVICE_ACCOUNT_FILE,
  },

  // Optional global provider credentials (organizations may override via encrypted integrations)
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    apiKeySid: process.env.TWILIO_API_KEY_SID,
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET,
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID,
  },
  exotel: {
    accountSid: process.env.EXOTEL_ACCOUNT_SID,
    apiKey: process.env.EXOTEL_API_KEY,
    apiToken: process.env.EXOTEL_API_TOKEN,
    subdomain: process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com',
    webhookToken: process.env.EXOTEL_WEBHOOK_TOKEN,
  },
  plivo: {
    authId: process.env.PLIVO_AUTH_ID,
    authToken: process.env.PLIVO_AUTH_TOKEN,
  },
  metaWhatsApp: {
    accessToken: process.env.META_WA_ACCESS_TOKEN,
    phoneNumberId: process.env.META_WA_PHONE_NUMBER_ID,
    appSecret: process.env.META_WA_APP_SECRET,
    verifyToken: process.env.META_WA_VERIFY_TOKEN,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.AI_MODEL || 'claude-opus-5-5',
  },
  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY,
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM,
  },
};
