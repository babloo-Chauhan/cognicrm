import { describe, expect, it } from 'vitest';
import { addUser, http, registerOrg, useDatabase } from './helpers.js';
import { CallDisposition } from '../src/models/index.js';

useDatabase();

describe('auth & tenancy', () => {
  it('registers an organization with defaults and logs in', async () => {
    const admin = await registerOrg('Acme');
    expect(admin.user.role).toBe('admin');
    expect(await CallDisposition.countDocuments({ organizationId: admin.org.id })).toBe(14);
    const me = await http().get('/api/v1/auth/me').set(admin.auth);
    expect(me.status).toBe(200);
    expect(me.body.user.passwordHash).toBeUndefined();
    const bad = await http().post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'x' });
    expect(bad.status).toBe(401);
  });

  it('requires authentication', async () => {
    expect((await http().get('/api/v1/leads')).status).toBe(401);
    expect((await http().get('/api/v1/leads').set('Authorization', 'Bearer junk')).status).toBe(401);
  });

  it('isolates tenants', async () => {
    const a = await registerOrg('Org A');
    const b = await registerOrg('Org B');
    const lead = await http().post('/api/v1/leads').set(a.auth).send({ name: 'Secret Lead', phone: '9876543210' });
    expect(lead.status).toBe(201);
    expect((await http().get(`/api/v1/leads/${lead.body.id}`).set(b.auth)).status).toBe(404);
    expect((await http().get('/api/v1/leads').set(b.auth)).body.total).toBe(0);
    expect((await http().patch(`/api/v1/leads/${lead.body.id}`).set(b.auth).send({ name: 'x' })).status).toBe(404);
    // organizationId cannot be overridden through the body
    const sneaky = await http().post('/api/v1/leads').set(b.auth).send({ name: 'X', organizationId: a.org.id });
    expect(sneaky.body.organizationId).toBe(b.org.id);
  });

  it('enforces role permissions', async () => {
    const admin = await registerOrg();
    const agent = await addUser(admin, { role: 'agent' });
    const res = await http().post('/api/v1/users').set(agent.auth).send({ name: 'x', email: 'x@example.com', password: 'password123' });
    expect(res.status).toBe(403);
    expect((await http().patch('/api/v1/organization/settings').set(agent.auth).send({ wrapUpSeconds: 5 })).status).toBe(403);
    expect((await http().patch('/api/v1/organization/settings').set(admin.auth).send({ wrapUpSeconds: 5 })).body.settings.wrapUpSeconds).toBe(5);
  });
});

describe('CRM records & timeline', () => {
  it('normalizes phones, logs timeline activity and converts leads', async () => {
    const admin = await registerOrg();
    const lead = await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Rahul Sharma', phone: '98765 43210', company: 'Infra Co', estimatedValue: 250000 });
    expect(lead.body.phone).toBe('+919876543210');
    const tl = await http().get(`/api/v1/timeline/lead/${lead.body.id}`).set(admin.auth);
    expect(tl.body.items[0].type).toBe('lead_created');

    // Accounts are off by default: the company stays on the contact as text
    const conv = await http().post(`/api/v1/leads/${lead.body.id}/convert`).set(admin.auth).send({});
    expect(conv.status).toBe(200);
    expect(conv.body.contact).toMatchObject({ firstName: 'Rahul', company: 'Infra Co' });
    expect(conv.body.account).toBeNull();
    expect(conv.body.deal.value).toBe(250000);
    const again = await http().post(`/api/v1/leads/${lead.body.id}/convert`).set(admin.auth).send({});
    expect(again.status).toBe(400);

    // A company that uses Accounts (Settings → Features) gets one on convert
    expect((await http().patch('/api/v1/organization/settings').set(admin.auth).send({ features: { accounts: true } })).body.settings.features).toEqual({ accounts: true });
    const b2b = await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Sita Rao', phone: '98765 43211', company: 'Infra Co' });
    const conv2 = await http().post(`/api/v1/leads/${b2b.body.id}/convert`).set(admin.auth).send({});
    expect(conv2.body.account.name).toBe('Infra Co');
    const acctTl = await http().get(`/api/v1/timeline/account/${conv2.body.account.id}`).set(admin.auth);
    expect(acctTl.body.items.map((i) => i.type)).toContain('lead_converted');
  });

  it('keeps a lead\'s requirement and remarks, and carries them over on convert', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    const lead = await http().post('/api/v1/leads').set(ravi.auth)
      .send({ name: 'Anil Gupta', phone: '9876501234', company: 'Gupta Steels', requirement: '50 office chairs, budget 2 lakh', notes: 'Prefers WhatsApp' });
    expect(lead.status).toBe(201);
    expect(lead.body.requirement).toBe('50 office chairs, budget 2 lakh');
    expect(lead.body.notes).toBe('Prefers WhatsApp');

    // Remarks added later: listed newest first for this lead only, with the author, and on the timeline
    expect((await http().post('/api/v1/notes').set(ravi.auth).send({ body: '   ', related: { leadId: lead.body.id } })).status).toBe(400);
    await http().post('/api/v1/notes').set(ravi.auth).send({ body: 'Called, wants a demo', related: { leadId: lead.body.id } });
    await http().post('/api/v1/notes').set(admin.auth).send({ body: '  Demo fixed for Monday ', related: { leadId: lead.body.id } });
    const other = await http().post('/api/v1/leads').set(ravi.auth).send({ name: 'Other' });
    await http().post('/api/v1/notes').set(ravi.auth).send({ body: 'Not this lead', related: { leadId: other.body.id } });
    const remarks = await http().get('/api/v1/notes').query({ 'related.leadId': lead.body.id }).set(ravi.auth);
    expect(remarks.body.items.map((n) => n.body)).toEqual(['Demo fixed for Monday', 'Called, wants a demo']);
    expect(remarks.body.items[1].authorId).toBe(ravi.user.id);
    const tl = await http().get(`/api/v1/timeline/lead/${lead.body.id}`).set(ravi.auth);
    expect(tl.body.items.filter((i) => i.type === 'note').map((i) => i.title)).toContain('Called, wants a demo');

    // Editing the requirement works for the owner
    const edited = await http().patch(`/api/v1/leads/${lead.body.id}`).set(ravi.auth).send({ requirement: '60 office chairs' });
    expect(edited.body.requirement).toBe('60 office chairs');

    const conv = await http().post(`/api/v1/leads/${lead.body.id}/convert`).set(admin.auth).send({});
    const dealNotes = await http().get('/api/v1/notes').query({ 'related.dealId': conv.body.deal.id }).set(admin.auth);
    expect(dealNotes.body.items[0].body).toBe('Requirement: 60 office chairs\nRemarks: Prefers WhatsApp');
  });

  it('logs deal stage changes', async () => {
    const admin = await registerOrg();
    const deal = await http().post('/api/v1/deals').set(admin.auth).send({ name: 'Big deal', value: 1000 });
    await http().patch(`/api/v1/deals/${deal.body.id}`).set(admin.auth).send({ stage: 'proposal' });
    const tl = await http().get(`/api/v1/timeline/deal/${deal.body.id}`).set(admin.auth);
    expect(tl.body.items[0]).toMatchObject({ type: 'stage_changed', data: { from: 'prospecting', to: 'proposal' } });
  });

  it('builds caller context by phone', async () => {
    const admin = await registerOrg();
    const acct = await http().post('/api/v1/accounts').set(admin.auth).send({ name: 'Globex' });
    const contact = await http().post('/api/v1/contacts').set(admin.auth).send({ firstName: 'Priya', lastName: 'Nair', phone: '+919811111111', accountId: acct.body.id });
    await http().post('/api/v1/deals').set(admin.auth).send({ name: 'Globex renewal', contactId: contact.body.id, accountId: acct.body.id });
    await http().post('/api/v1/tickets').set(admin.auth).send({ subject: 'Login issue', contactId: contact.body.id });
    const ctx = await http().get('/api/v1/customer-context?phone=9811111111').set(admin.auth);
    expect(ctx.body).toMatchObject({ name: 'Priya Nair', company: 'Globex' });
    expect(ctx.body.openDeals).toHaveLength(1);
    expect(ctx.body.openTickets).toHaveLength(1);
  });

  it('searches and paginates', async () => {
    const admin = await registerOrg();
    for (let i = 0; i < 5; i += 1) await http().post('/api/v1/contacts').set(admin.auth).send({ firstName: `Person${i}`, company: i % 2 ? 'Odd' : 'Even' });
    const res = await http().get('/api/v1/contacts?q=odd&limit=1').set(admin.auth);
    expect(res.body.total).toBe(2);
    expect(res.body.items).toHaveLength(1);
  });
});

describe('lead assignment', () => {
  it('admin assigns, an employee reassigns, the new owner is notified', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    const sita = await addUser(admin, { role: 'sales_executive', name: 'Sita' });

    // Without an owner the creator owns it; the admin can create it already assigned
    const own = await http().post('/api/v1/leads').set(ravi.auth).send({ name: 'Walk-in' });
    expect(own.body.ownerId).toBe(ravi.user.id);
    const lead = await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Mehta', phone: '9876500010', ownerId: ravi.user.id });
    expect(lead.status).toBe(201);
    expect(lead.body.ownerId).toBe(ravi.user.id);
    let notes = await http().get('/api/v1/notifications').set(ravi.auth);
    expect(notes.body.items.some((n) => n.type === 'lead_assigned' && n.data.leadId === lead.body.id)).toBe(true);

    // Ravi hands it to Sita
    const moved = await http().patch(`/api/v1/leads/${lead.body.id}`).set(ravi.auth).send({ ownerId: sita.user.id });
    expect(moved.status).toBe(200);
    expect(moved.body.ownerId).toBe(sita.user.id);
    notes = await http().get('/api/v1/notifications').set(sita.auth);
    expect(notes.body.items.find((n) => n.type === 'lead_assigned').body).toContain('Ravi');
    const mine = await http().get('/api/v1/leads').query({ ownerId: sita.user.id }).set(sita.auth);
    expect(mine.body.items.map((l) => l.name)).toEqual(['Mehta']);
    const timeline = await http().get(`/api/v1/timeline/lead/${lead.body.id}`).set(admin.auth);
    expect(JSON.stringify(timeline.body)).toContain('Lead assigned to Sita by Ravi');

    // Only members of the same company can own it
    const other = await registerOrg('Other');
    expect((await http().patch(`/api/v1/leads/${lead.body.id}`).set(admin.auth).send({ ownerId: other.user.id })).status).toBe(400);
    // Read-only employees cannot reassign
    const emp = await addUser(admin, { role: 'employee' });
    expect((await http().patch(`/api/v1/leads/${lead.body.id}`).set(emp.auth).send({ ownerId: emp.user.id })).status).toBe(403);
  });
});
