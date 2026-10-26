import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addUser, http, registerOrg, useDatabase } from './helpers.js';
import { Lead, LeadSource } from '../src/models/index.js';
import { receiveMessage } from '../src/modules/messaging/service.js';
import { indiamartTime, pullDueIndiamart } from '../src/modules/leadCapture/connectors.js';

useDatabase();
afterEach(() => vi.restoreAllMocks());

const createSource = async (admin, body) => {
  const res = await http().post('/api/v1/lead-sources').set(admin.auth).send(body);
  expect(res.status).toBe(201);
  return res.body;
};
const capture = (token) => `/api/v1/capture/${token}`;
const leads = async (who, query = {}) => (await http().get('/api/v1/leads').query(query).set(who.auth)).body.items;
const notes = async (who) => (await http().get('/api/v1/notifications').set(who.auth)).body.items;

describe('lead capture: website / API webhook', () => {
  it('turns any JSON or form post into a lead, assigned in turn, and tells the person', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    const sita = await addUser(admin, { role: 'sales_executive', name: 'Sita' });
    const src = await createSource(admin, { type: 'webhook', name: 'Website', assignMode: 'round_robin', assignUserIds: [ravi.user.id, sita.user.id] });
    expect(src.urls.webhook).toContain(`/api/v1/capture/${src.token}`);

    const a = await http().post(capture(src.token)).send({ 'your-name': 'Rahul Sharma', mobile: '98765 43210', email: 'Rahul@Example.com', message: '50 office chairs', city: 'Pune', utm_campaign: 'diwali' });
    expect(a.status).toBe(201);
    const b = await http().post(capture(src.token)).type('form').send({ first_name: 'Neha', last_name: 'Gupta', phone: '9876500011' });
    expect(b.status).toBe(201);

    const lead = (await http().get(`/api/v1/leads/${a.body.leadId}`).set(admin.auth)).body;
    expect(lead).toMatchObject({ name: 'Rahul Sharma', phone: '+919876543210', email: 'rahul@example.com', requirement: '50 office chairs', source: 'website', ownerId: ravi.user.id });
    expect(lead.notes).toContain('City: Pune');
    expect(lead.notes).toContain('Utm campaign: diwali');
    expect(lead.nextFollowUpAt).toBeTruthy();
    expect((await http().get(`/api/v1/leads/${b.body.leadId}`).set(admin.auth)).body).toMatchObject({ name: 'Neha Gupta', ownerId: sita.user.id });

    const n = (await notes(ravi)).find((x) => x.type === 'lead_assigned');
    expect(n.title).toBe('New lead from Website: Rahul Sharma');
    expect(n.data).toMatchObject({ phone: '+919876543210', action: 'call' });
    expect((await leads(ravi)).map((l) => l.name)).toEqual(['Rahul Sharma']);

    const sources = (await http().get('/api/v1/lead-sources').set(admin.auth)).body.items;
    expect(sources[0].stats.total).toBe(2);
    const logs = (await http().get(`/api/v1/lead-sources/${src.id}/logs`).set(admin.auth)).body.items;
    expect(logs.map((l) => l.status)).toEqual(['created', 'created']);
  });

  it('adds a repeat enquiry to the existing lead instead of duplicating it', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    const src = await createSource(admin, { type: 'webhook', assignMode: 'user', assignUserIds: [ravi.user.id] });
    const first = await http().post(capture(src.token)).send({ name: 'Mehta', phone: '9876500077' });
    await http().patch(`/api/v1/leads/${first.body.leadId}`).set(admin.auth).send({ status: 'lost' });
    const again = await http().post(capture(src.token)).send({ name: 'Mehta Steels', phone: '+91 98765 00077', message: 'Need a quote again' });
    expect(again.body).toMatchObject({ status: 'duplicate', leadId: first.body.leadId });
    expect(await Lead.countDocuments({ organizationId: admin.org.id })).toBe(1);
    const lead = await Lead.findById(first.body.leadId).lean();
    expect(lead.status).toBe('new'); // back in play
    const remarks = (await http().get('/api/v1/notes').query({ 'related.leadId': first.body.leadId }).set(admin.auth)).body.items;
    expect(remarks[0].body).toContain('Need a quote again');
    expect((await notes(ravi)).some((x) => x.type === 'lead_enquiry')).toBe(true);
  });

  it('answers a plain HTML form with a thank-you page or redirect, drops honeypot spam, and needs a phone or email', async () => {
    const admin = await registerOrg();
    const src = await createSource(admin, { type: 'form', config: { thankYou: 'Shukriya!' } });
    const page = await http().post(capture(src.token)).type('form').set('Accept', 'text/html').send({ name: 'Asha', phone: '9876500022' });
    expect(page.status).toBe(200);
    expect(page.text).toContain('Shukriya!');
    const redirect = await http().post(capture(src.token)).type('form').set('Accept', 'text/html').send({ name: 'B', phone: '9876500023', redirect: 'https://example.com/thanks' });
    expect(redirect.status).toBe(303);
    expect(redirect.headers.location).toBe('https://example.com/thanks');
    await http().post(capture(src.token)).send({ name: 'Bot', phone: '9876500024', _gotcha: 'http://spam' });
    expect((await http().post(capture(src.token)).send({ name: 'No contact' })).status).toBe(422);
    expect(await Lead.countDocuments({ organizationId: admin.org.id })).toBe(2);

    // Unassigned leads tell the admin
    expect((await notes(admin)).some((x) => x.title.startsWith('New lead from Web form'))).toBe(true);
    // The hosted form reads its settings without signing in
    const form = await http().get(`/api/v1/capture/form/${src.token}`);
    expect(form.body.fields.map((f) => f.key)).toEqual(['name', 'phone', 'email', 'requirement']);
    // Websites on any domain may post (CORS preflight)
    const pre = await http().options(capture(src.token)).set('Origin', 'https://shop.example.in').set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');
    expect(pre.headers['access-control-allow-origin']).toBe('https://shop.example.in');
  });

  it('stops working when switched off or the address is changed', async () => {
    const admin = await registerOrg();
    const src = await createSource(admin, { type: 'webhook' });
    await http().patch(`/api/v1/lead-sources/${src.id}`).set(admin.auth).send({ enabled: false });
    expect((await http().post(capture(src.token)).send({ name: 'X', phone: '9876500031' })).status).toBe(404);
    await http().patch(`/api/v1/lead-sources/${src.id}`).set(admin.auth).send({ enabled: true });
    const rotated = (await http().post(`/api/v1/lead-sources/${src.id}/rotate`).set(admin.auth)).body;
    expect(rotated.token).not.toBe(src.token);
    expect((await http().post(capture(src.token)).send({ name: 'X', phone: '9876500031' })).status).toBe(404);
    expect((await http().post(capture(rotated.token)).send({ name: 'X', phone: '9876500031' })).status).toBe(201);
  });
});

describe('lead capture: Justdial, IndiaMART, Google Ads', () => {
  it('Justdial lead push (GET) answers RECEIVED and is not added twice', async () => {
    const admin = await registerOrg();
    const src = await createSource(admin, { type: 'justdial' });
    const q = { leadid: 'JD123', prefix: 'Mr', name: 'Sunil', mobile: '9876500041', category: 'Packers and movers', city: 'Delhi', area: 'Rohini' };
    const res = await http().get(capture(src.token)).query(q);
    expect(res.text).toBe('RECEIVED');
    await http().get(capture(src.token)).query(q);
    const [lead] = await leads(admin);
    expect(lead).toMatchObject({ name: 'Mr Sunil', phone: '+919876500041', requirement: 'Packers and movers', source: 'justdial' });
    expect(await Lead.countDocuments({ organizationId: admin.org.id })).toBe(1);
  });

  it('IndiaMART push webhook', async () => {
    const admin = await registerOrg();
    const src = await createSource(admin, { type: 'indiamart' });
    const res = await http().post(capture(src.token)).send({
      CODE: 200, STATUS: 'SUCCESS',
      RESPONSE: { UNIQUE_QUERY_ID: '2650001', QUERY_TYPE: 'W', SENDER_NAME: 'Anil Traders', SENDER_MOBILE: '+91-9876500051', SENDER_EMAIL: 'anil@x.in', SUBJECT: 'Requirement for PVC pipes', SENDER_COMPANY: 'Anil Traders Pvt Ltd', SENDER_CITY: 'Surat', QUERY_PRODUCT_NAME: 'PVC Pipe', QUERY_MESSAGE: 'Need 500 pcs<br>Urgent' },
    });
    expect(res.status).toBe(201);
    const lead = (await http().get(`/api/v1/leads/${res.body.leadId}`).set(admin.auth)).body;
    expect(lead).toMatchObject({ name: 'Anil Traders', phone: '+919876500051', company: 'Anil Traders Pvt Ltd', source: 'indiamart' });
    expect(lead.requirement).toBe('Requirement for PVC pipes\nNeed 500 pcs\nUrgent');
    expect(lead.notes).toContain('Product: PVC Pipe');
  });

  it('IndiaMART pull API: fetches new enquiries with the saved key, which is never sent back', async () => {
    const admin = await registerOrg();
    const src = await createSource(admin, { type: 'indiamart', credentials: { crmKey: 'SECRETKEY' } });
    expect(src.saved).toEqual({ crmKey: true });
    expect(JSON.stringify(src)).not.toContain('SECRETKEY');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      CODE: 200, STATUS: 'SUCCESS', TOTAL_RECORDS: 2,
      RESPONSE: [
        { UNIQUE_QUERY_ID: 'A1', SENDER_NAME: 'One', SENDER_MOBILE: '+91-9876500061', SUBJECT: 'Chairs' },
        { UNIQUE_QUERY_ID: 'A2', SENDER_NAME: 'Two', SENDER_MOBILE: '+91-9876500062', SUBJECT: 'Tables' },
      ],
    }), { status: 200 }));
    const res = await http().post(`/api/v1/lead-sources/${src.id}/pull`).set(admin.auth);
    expect(res.body).toMatchObject({ fetched: 2, created: 2 });
    expect(String(fetchMock.mock.calls[0][0])).toContain('glusr_crm_key=SECRETKEY');
    // The scheduled pull skips a source pulled moments ago; the same enquiries again are ignored
    await pullDueIndiamart(new Date());
    await LeadSource.updateOne({ _id: src.id }, { $unset: { 'config.lastPullAttemptAt': 1 } });
    await pullDueIndiamart(new Date());
    expect(await Lead.countDocuments({ organizationId: admin.org.id })).toBe(2);
    expect(indiamartTime(new Date('2026-10-26T15:30:00Z'))).toBe('26-Oct-2026 21:00:00');
  });

  it('Google Ads lead form webhook checks the key', async () => {
    const admin = await registerOrg();
    const src = await createSource(admin, { type: 'google_ads' });
    const body = {
      lead_id: 'G-1', google_key: src.config.googleKey, campaign_id: 99, is_test: false,
      user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Kiran Rao' }, { column_id: 'PHONE_NUMBER', string_value: '+919876500071' }, { column_id: 'CITY', column_name: 'City', string_value: 'Mysuru' }],
    };
    expect((await http().post(capture(src.token)).send({ ...body, google_key: 'wrong' })).status).toBe(403);
    const res = await http().post(capture(src.token)).send(body);
    expect(res.status).toBe(201);
    const lead = (await http().get(`/api/v1/leads/${res.body.leadId}`).set(admin.auth)).body;
    expect(lead).toMatchObject({ name: 'Kiran Rao', phone: '+919876500071', source: 'google_ads' });
    expect(lead.notes).toContain('City: Mysuru');
  });
});

describe('lead capture: Meta lead ads and WhatsApp', () => {
  it('verifies the Meta webhook, checks the signature and reads the lead from the Graph API', async () => {
    const admin = await registerOrg();
    const src = await createSource(admin, { type: 'meta', credentials: { pageAccessToken: 'PAGE_TOKEN', appSecret: 'APP_SECRET' } });
    const url = `/api/v1/capture/meta/${src.token}`;
    expect((await http().get(url).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '42' })).status).toBe(403);
    const ok = await http().get(url).query({ 'hub.mode': 'subscribe', 'hub.verify_token': src.config.verifyToken, 'hub.challenge': '42' });
    expect(ok.text).toBe('42');

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'LG1', field_data: [{ name: 'full_name', values: ['Pooja Nair'] }, { name: 'phone_number', values: ['+919876500081'] }, { name: 'which_course?', values: ['MBA'] }], platform: 'ig', ad_name: 'Admissions',
    }), { status: 200 }));
    const payload = JSON.stringify({ object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'LG1', form_id: 'F1', page_id: 'P1' } }] }] });
    const sig = `sha256=${crypto.createHmac('sha256', 'APP_SECRET').update(payload).digest('hex')}`;
    expect((await http().post(url).set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=bad').send(payload)).status).toBe(403);
    const res = await http().post(url).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(payload);
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/LG1?access_token=PAGE_TOKEN');
    const [lead] = await leads(admin);
    expect(lead).toMatchObject({ name: 'Pooja Nair', phone: '+919876500081', source: 'facebook' });
    expect(lead.notes).toContain('Which course?: MBA');
    expect(lead.notes).toContain('Platform: Instagram');
  });

  it('a WhatsApp message from an unknown number becomes a lead linked to the chat', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    await receiveMessage(admin.org.id, { channel: 'whatsapp', from: '+919876500091', body: 'Before capture is on' });
    expect(await Lead.countDocuments({ organizationId: admin.org.id })).toBe(0);
    await createSource(admin, { type: 'whatsapp', assignMode: 'user', assignUserIds: [ravi.user.id] });
    expect((await http().post('/api/v1/lead-sources').set(admin.auth).send({ type: 'whatsapp' })).status).toBe(400);

    const { conversation } = await receiveMessage(admin.org.id, { channel: 'whatsapp', from: '+919876500092', name: 'Farhan', body: 'Price of 2BHK?' });
    await receiveMessage(admin.org.id, { channel: 'whatsapp', from: '+919876500092', body: 'Hello?' });
    const all = await Lead.find({ organizationId: admin.org.id }).lean();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: 'Farhan', phone: '+919876500092', requirement: 'Price of 2BHK?', source: 'whatsapp' });
    expect(String(all[0].ownerId)).toBe(ravi.user.id);
    expect(String(conversation.related.leadId)).toBe(String(all[0]._id));
  });
});

describe('lead sources admin', () => {
  it('is for the admin only and checks who gets the leads', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    const other = await registerOrg();
    expect((await http().get('/api/v1/lead-sources').set(ravi.auth)).status).toBe(403);
    expect((await http().post('/api/v1/lead-sources').set(admin.auth).send({ type: 'fax' })).status).toBe(400);
    expect((await http().post('/api/v1/lead-sources').set(admin.auth).send({ type: 'webhook', assignMode: 'user' })).status).toBe(400);
    expect((await http().post('/api/v1/lead-sources').set(admin.auth).send({ type: 'webhook', assignMode: 'user', assignUserIds: [other.user.id] })).status).toBe(400);
    const src = await createSource(admin, { type: 'webhook' });
    expect((await http().patch(`/api/v1/lead-sources/${src.id}`).set(other.auth).send({ name: 'x' })).status).toBe(404);
    const test = await http().post(`/api/v1/lead-sources/${src.id}/test`).set(admin.auth);
    expect(test.body.status).toBe('created');
    expect((await http().delete(`/api/v1/lead-sources/${src.id}`).set(admin.auth)).status).toBe(204);
  });
});
