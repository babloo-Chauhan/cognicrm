import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// Firebase Cloud Messaging (HTTP v1) for native Android device tokens.
// Credentials: a Firebase service account JSON, from FIREBASE_SERVICE_ACCOUNT (inline JSON)
// or FIREBASE_SERVICE_ACCOUNT_FILE (path).

let account;
let accessToken = null;

function serviceAccount() {
  if (account !== undefined) return account;
  try {
    const raw = env.firebase.serviceAccount || (env.firebase.serviceAccountFile && fs.readFileSync(env.firebase.serviceAccountFile, 'utf8'));
    account = raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('FCM: could not read Firebase service account', err.message);
    account = null;
  }
  return account;
}

export const fcmConfigured = () => Boolean(serviceAccount());

async function getAccessToken() {
  if (accessToken && accessToken.expiresAt > Date.now() + 60000) return accessToken.value;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: sa.token_uri, iat: now, exp: now + 3600 },
    sa.private_key,
    { algorithm: 'RS256' },
  );
  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`FCM auth failed: ${json.error_description || json.error || res.status}`);
  accessToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return accessToken.value;
}

/**
 * Sends one notification to one FCM device token.
 * Returns { ok: true } or { ok: false, unregistered } — unregistered tokens should be deleted.
 */
export async function sendFcm(token, { title, body, data = {}, highPriority = false }) {
  const sa = serviceAccount();
  if (!sa) return { ok: false, unregistered: false };
  const message = {
    token,
    notification: { title, body },
    // FCM data values must be strings
    data: Object.fromEntries(Object.entries(data).filter(([, v]) => v != null).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
    android: { priority: highPriority ? 'HIGH' : 'NORMAL', notification: { channel_id: 'calls', sound: 'default' } },
  };
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (res.ok) return { ok: true };
  const json = await res.json().catch(() => ({}));
  const code = json.error?.details?.find((d) => d.errorCode)?.errorCode;
  const unregistered = res.status === 404 || code === 'UNREGISTERED' || (code === 'INVALID_ARGUMENT' && /token/i.test(json.error?.message || ''));
  if (!unregistered) console.error('FCM send failed', res.status, json.error?.message);
  return { ok: false, unregistered };
}
