import crypto from 'node:crypto';
import { env } from '../config/env.js';

const key = () => crypto.createHash('sha256').update(env.encryptionKey).digest();

/** AES-256-GCM encryption for provider credentials stored in the database. */
export function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

export function decryptJson(payload) {
  if (!payload) return null;
  const [version, iv, tag, data] = payload.split(':');
  if (version !== 'v1') throw new Error('Unsupported ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/** Short-lived HMAC signatures for private resources (recordings, voicemails). */
export function signResource(resource, ttlSeconds = 300, now = Date.now()) {
  const expires = Math.floor(now / 1000) + ttlSeconds;
  const sig = hmac(`${resource}:${expires}`);
  return { expires, sig };
}

export function verifyResourceSignature(resource, expires, sig, now = Date.now()) {
  if (!expires || !sig) return false;
  if (Number(expires) < Math.floor(now / 1000)) return false;
  const expected = hmac(`${resource}:${expires}`);
  return safeEqual(expected, String(sig));
}

function hmac(value) {
  return crypto.createHmac('sha256', env.signingSecret).update(value).digest('base64url');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Masks all but the last 4 digits of a phone number. */
export function maskPhone(phone) {
  if (!phone) return phone;
  const s = String(phone);
  if (s.length <= 7) return '*'.repeat(Math.max(0, s.length - 4)) + s.slice(-4);
  return s.slice(0, 3) + '*'.repeat(s.length - 7) + s.slice(-4);
}
