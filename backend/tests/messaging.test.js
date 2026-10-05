import { describe, expect, it } from 'vitest';
import {
  enableTelephony, FakeMessagingProvider, http, registerOrg, useDatabase,
} from './helpers.js';
import { Activity, CommunicationMessage, Contact, Organization } from '../src/models/index.js';

useDatabase();

function smsWebhook(params, valid = true) {
  return http().post('/api/v1/webhooks/messaging/fakesms').set('x-test-signature', valid ? 'valid' : 'no').type('form').send(params);
}

describe('SMS / WhatsApp / unified inbox', () => {
  it('reports unconfigured providers', async () => {
    const admin = await registerOrg();
    const res = await http().post('/api/v1/messages').set(admin.auth).send({ channel: 'sms', to: '9876543210', body: 'Hi' });
    expect(res.status).toBe(424);
  });

  it('sends, receives and threads messages per customer', async () => {
    const admin = await registerOrg();
    await enableTelephony(admin.org.id);
    const contact = await http().post('/api/v1/contacts').set(admin.auth).send({ firstName: 'Asha', phone: '9876543210' });

    const sent = await http().post('/api/v1/messages').set(admin.auth).send({ channel: 'sms', to: '9876543210', body: 'Your demo is confirmed' });
    expect(sent.status).toBe(201);
    expect(FakeMessagingProvider.sent[0]).toMatchObject({ channel: 'sms', to: '+919876543210', from: '+918000000001' });
    expect(sent.body.conversation.related.contactId).toBe(contact.body.id);

    const wa = await http().post('/api/v1/messages').set(admin.auth).send({ channel: 'whatsapp', conversationId: sent.body.conversation.id, body: 'Sharing the brochure' });
    expect(wa.body.conversation.id).toBe(sent.body.conversation.id);
    expect(wa.body.conversation.channels).toEqual(['sms', 'whatsapp']);

    expect((await smsWebhook({ From: '+919876543210', To: '+918000000001', Body: 'Thanks!', MessageSid: 'SMin1' }, false)).status).toBe(403);
    expect((await smsWebhook({ From: '+919876543210', To: '+918000000001', Body: 'Thanks!', MessageSid: 'SMin1' })).status).toBe(200);
    await smsWebhook({ From: '+919876543210', To: '+918000000001', Body: 'Thanks!', MessageSid: 'SMin1' }); // duplicate
    expect(await CommunicationMessage.countDocuments({ providerMessageId: 'SMin1' })).toBe(1);

    const list = await http().get('/api/v1/inbox/conversations').set(admin.auth);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].unreadCount).toBe(1);
    const view = await http().get(`/api/v1/inbox/conversations/${sent.body.conversation.id}`).set(admin.auth);
    expect(view.body.timeline.map((t) => t.item.body)).toEqual(['Your demo is confirmed', 'Sharing the brochure', 'Thanks!']);

    const tl = await http().get(`/api/v1/timeline/contact/${contact.body.id}`).set(admin.auth);
    expect(tl.body.items.map((i) => i.type)).toEqual(expect.arrayContaining(['sms', 'whatsapp']));
  });

  it('never moves delivery status backwards', async () => {
    const admin = await registerOrg();
    await enableTelephony(admin.org.id);
    const sent = await http().post('/api/v1/messages').set(admin.auth).send({ channel: 'sms', to: '9876543210', body: 'Hello' });
    const id = sent.body.message.providerMessageId;
    await smsWebhook({ MessageSid: id, MessageStatus: 'delivered', To: '+919876543210' });
    await smsWebhook({ MessageSid: id, MessageStatus: 'sent', To: '+919876543210', x: '1' });
    const msg = await CommunicationMessage.findOne({ providerMessageId: id });
    expect(msg.status).toBe('delivered');
  });

  it('handles STOP opt-outs', async () => {
    const admin = await registerOrg();
    await enableTelephony(admin.org.id);
    const contact = await http().post('/api/v1/contacts').set(admin.auth).send({ firstName: 'Vik', phone: '9876543210' });
    await smsWebhook({ From: '+919876543210', To: '+918000000001', Body: 'STOP', MessageSid: 'SMstop' });
    expect((await Contact.findById(contact.body.id)).smsOptOut).toBe(true);
    const blocked = await http().post('/api/v1/messages').set(admin.auth).send({ channel: 'sms', to: '9876543210', body: 'Offer', related: { contactId: contact.body.id } });
    expect(blocked.status).toBe(403);
  });

  it('renders templates', async () => {
    const admin = await registerOrg();
    await enableTelephony(admin.org.id);
    const t = await http().post('/api/v1/message-templates').set(admin.auth).send({ name: 'Reminder', channel: 'sms', body: 'Hi {{name}}, your appointment is at {{time}}.' });
    await http().post('/api/v1/messages').set(admin.auth).send({ channel: 'sms', to: '9876543210', templateId: t.body.id, variables: { name: 'Asha', time: '4 PM' } });
    expect(FakeMessagingProvider.sent[0].body).toBe('Hi Asha, your appointment is at 4 PM.');
  });

  it('supports the public web chat widget', async () => {
    const admin = await registerOrg();
    const org = await Organization.findById(admin.org.id);
    const visitorId = 'visitor-123456';
    const post = await http().post(`/api/v1/webchat/${org.publicChatKey}/messages`).send({ visitorId, name: 'Guest', body: 'Do you have a free trial?' });
    expect(post.status).toBe(201);
    const convs = await http().get('/api/v1/inbox/conversations').set(admin.auth);
    const conv = convs.body.items[0];
    expect(conv.channels).toEqual(['webchat']);
    await http().post('/api/v1/messages').set(admin.auth).send({ channel: 'webchat', conversationId: conv.id, body: 'Yes, 14 days!' });
    const poll = await http().get(`/api/v1/webchat/${org.publicChatKey}/messages?visitorId=${visitorId}`);
    expect(poll.body.items.map((m) => m.body)).toEqual(['Do you have a free trial?', 'Yes, 14 days!']);
    expect((await http().post('/api/v1/webchat/wrong-key/messages').send({ visitorId, body: 'x' })).status).toBe(404);
    expect(await Activity.countDocuments({ type: 'webchat' })).toBe(2);
  });
});
