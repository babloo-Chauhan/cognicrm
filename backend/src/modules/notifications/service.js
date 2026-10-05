import { Notification, PushToken } from '../../models/index.js';
import { emitToUser } from '../../lib/realtime.js';
import { env } from '../../config/env.js';
import { sendFcm } from '../../lib/fcm.js';

/**
 * Delivers a notification in-app (DB + realtime socket) and to the user's mobile devices
 * through Expo push (Expo tokens) or FCM (native Android tokens). Push failures are logged, never thrown.
 */
export async function notify(orgId, userId, { type, title, body, data = {} }) {
  if (!userId) return null;
  const notification = await Notification.create({ organizationId: orgId, userId, type, title, body, data });
  emitToUser(String(userId), 'notification', notification.toJSON());
  if (!env.isTest) sendPush(orgId, userId, { title, body, data: { ...data, type } }).catch((err) => console.error('push failed', err.message));
  return notification;
}

export async function notifyMany(orgId, userIds, payload) {
  return Promise.all([...new Set((userIds || []).map(String))].map((id) => notify(orgId, id, payload)));
}

// Time-critical pushes: an incoming call, or a call started on the web to be placed from the phone.
const HIGH_PRIORITY = ['incoming_call', 'dial_request'];
const isExpoToken = (token) => token.startsWith('ExponentPushToken') || token.startsWith('ExpoPushToken');

async function sendPush(orgId, userId, payload) {
  const tokens = await PushToken.find({ organizationId: orgId, userId }).lean();
  await Promise.all([
    sendExpoPush(orgId, tokens.filter((t) => isExpoToken(t.token)), payload),
    ...tokens.filter((t) => t.provider === 'fcm' && !isExpoToken(t.token)).map(async (t) => {
      const r = await sendFcm(t.token, { ...payload, highPriority: HIGH_PRIORITY.includes(payload.data.type) });
      if (r.unregistered) await PushToken.deleteOne({ organizationId: orgId, token: t.token });
    }),
  ]);
}

async function sendExpoPush(orgId, tokens, { title, body, data }) {
  const messages = tokens.map((t) => ({ to: t.token, title, body, data, sound: 'default', priority: HIGH_PRIORITY.includes(data.type) ? 'high' : 'default' }));
  if (!messages.length) return;
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });
  const json = await res.json().catch(() => ({}));
  // Remove tokens Expo reports as no longer registered
  const results = Array.isArray(json.data) ? json.data : [];
  await Promise.all(results.map((r, i) => (r.details?.error === 'DeviceNotRegistered'
    ? PushToken.deleteOne({ organizationId: orgId, token: messages[i].to })
    : null)));
}
