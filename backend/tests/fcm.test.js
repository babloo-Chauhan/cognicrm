import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';

// A throwaway service account: FCM calls are intercepted, nothing leaves the machine
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
env.firebase.serviceAccount = JSON.stringify({
  project_id: 'crm-test', client_email: 'push@crm-test.iam.gserviceaccount.com', token_uri: 'https://oauth.test/token',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

function interceptFcm() {
  const sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (url === 'https://oauth.test/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    sent.push(JSON.parse(init.body).message);
    return new Response('{}', { status: 200 });
  }));
  return sent;
}

describe('FCM messages', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a call started on the web goes to the phone as data only, so the app dials it even when closed', async () => {
    const { sendFcm } = await import('../src/lib/fcm.js');
    const sent = interceptFcm();
    await sendFcm('device-token', { title: '📞 Call Ravi', body: 'Tap', data: { type: 'dial_request', callId: 'c1', phone: '+919876543210' }, highPriority: true, silent: true });
    expect(sent[0].notification).toBeUndefined();
    expect(sent[0].android).toEqual({ priority: 'HIGH' });
    expect(sent[0].data).toEqual({ type: 'dial_request', callId: 'c1', phone: '+919876543210' });

    // Everything else still shows as a notification
    await sendFcm('device-token', { title: 'New lead', body: 'Assigned to you', data: { type: 'lead_assigned', leadId: 'l1' } });
    expect(sent[1].notification).toEqual({ title: 'New lead', body: 'Assigned to you' });
    expect(sent[1].android.notification.channel_id).toBe('calls');
  });
});
