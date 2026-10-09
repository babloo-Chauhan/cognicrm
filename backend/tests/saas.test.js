import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addUser, http, registerOrg, setPlan, useDatabase,
} from './helpers.js';
import {
  AuditLog, CompanySubscription, Organization, Payment, PlatformSettings, Role, User,
} from '../src/models/index.js';
import { createPlatformUser } from '../src/modules/platform/auth.js';
import { invalidateTenant } from '../src/modules/saas/tenant.js';
import { expireSubscriptions } from '../src/modules/saas/jobs.js';
import { registerPaymentProvider, RazorpayService, StripeService } from '../src/modules/saas/payments/providers.js';
import { runSaasMigrations } from '../src/modules/saas/migrate.js';

useDatabase();

/** TEST DOUBLE ONLY — payment provider that records orders and accepts `{ ok: true }` as proof of payment. */
class FakePay {
  constructor() { this.name = 'fakepay'; }

  isConfigured() { return true; }

  async createOrder({ amount, receipt }) { return { orderId: `order_${receipt}`, clientParams: { amount } }; }

  async verifyClientPayment(body) {
    if (!body.ok) throw Object.assign(new Error('not paid'), { status: 400 });
    return { paymentId: `pay_${Date.now()}` };
  }

  verifyWebhook({ headers }) { return headers['x-fake-signature'] === 'valid'; }

  parseWebhook(body) { return { eventId: body.id, events: body.events }; }
}
registerPaymentProvider('fakepay', () => new FakePay());

const api = (p) => `/api/v1${p}`;

async function platformAdmin() {
  await createPlatformUser({ email: 'owner@platform.test', password: 'super-secret-pass', name: 'Owner' });
  const res = await http().post(api('/platform/auth/login')).send({ email: 'owner@platform.test', password: 'super-secret-pass' });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.token}` };
}

describe('company registration', () => {
  it('creates company, tenant id, admin, roles, pipeline, trial and audit entry', async () => {
    const res = await http().post(api('/auth/register')).send({
      companyName: 'Alpha Traders', legalName: 'Alpha Traders Pvt Ltd', email: 'Owner@Alpha.test', phone: '+91 98765 43210',
      password: 'password123', confirmPassword: 'password123', adminName: 'Asha', country: 'India', state: 'Maharashtra', city: 'Pune',
      address: '1 MG Road', gstNumber: '27AAPFU0939F1ZV', website: 'https://alpha.test', industry: 'Retail',
    });
    expect(res.status).toBe(201);
    expect(res.body.company.companyCode).toMatch(/^CMP-\d{6}$/);
    expect(res.body.company.tenantId).toMatch(/^TEN-[A-Z0-9]{8}$/);
    expect(res.body.user.userCode).toMatch(/^USR-\d{6}$/);
    expect(res.body.user.email).toBe('owner@alpha.test');
    expect(res.body.user.permissions).toEqual(['*']);
    expect(res.body.company.subscription).toMatchObject({ status: 'trial', planCode: 'PROFESSIONAL', daysLeft: 14 });
    const orgId = res.body.organization.id;
    expect(await Role.countDocuments({ organizationId: orgId })).toBeGreaterThanOrEqual(9);
    expect(await AuditLog.exists({ organizationId: orgId, action: 'company.register' })).toBeTruthy();
    const pipelines = await http().get(api('/pipelines')).set({ Authorization: `Bearer ${res.body.token}` });
    expect(pipelines.body.items[0].stages.map((s) => s.key)).toContain('won');
  });

  it('validates input', async () => {
    const bad = await http().post(api('/auth/register')).send({ companyName: 'X Co', email: 'not-an-email', password: 'short', confirmPassword: 'nope', name: 'A', gstNumber: 'BAD' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ success: false, code: 'BAD_REQUEST' });
    const paths = bad.body.errors.map((e) => e.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['email', 'password', 'confirmPassword', 'gstNumber']));
  });

  it('sequential company codes', async () => {
    const a = await registerOrg('Company A', { plan: null });
    const b = await registerOrg('Company B', { plan: null });
    expect(Number(b.company.companyCode.slice(4))).toBe(Number(a.company.companyCode.slice(4)) + 1);
  });
});

describe('login & company switching', () => {
  it('logs in with email or company id, JWT carries tenant claims', async () => {
    const a = await registerOrg('Company A', { plan: null });
    const login = await http().post(api('/auth/login')).send({ email: a.email, password: 'password123' });
    expect(login.status).toBe(200);
    const claims = JSON.parse(Buffer.from(login.body.token.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ companyId: a.org.id, tenantId: a.company.tenantId, role: 'admin', permissions: ['*'], subscriptionStatus: 'trial' });
    const withCode = await http().post(api('/auth/login')).send({ email: a.email, password: 'password123', companyCode: a.company.companyCode });
    expect(withCode.status).toBe(200);
    const wrongCode = await http().post(api('/auth/login')).send({ email: a.email, password: 'password123', companyCode: 'CMP-999999' });
    expect(wrongCode.status).toBe(401);
  });

  it('one person in two companies chooses and switches with password', async () => {
    const a = await registerOrg('Company A', { plan: null });
    const b = await registerOrg('Company B', { plan: null, email: a.email });
    const login = await http().post(api('/auth/login')).send({ email: a.email, password: 'password123' });
    expect(login.body.requiresCompany).toBe(true);
    expect(login.body.companies).toHaveLength(2);
    const sw = await http().post(api('/auth/switch-company')).set(a.auth).send({ companyCode: b.company.companyCode, password: 'password123' });
    expect(sw.status).toBe(200);
    expect(sw.body.company.id).toBe(b.org.id);
    const bad = await http().post(api('/auth/switch-company')).set(a.auth).send({ companyCode: b.company.companyCode, password: 'wrong-pass' });
    expect(bad.status).toBe(403);
  });

  it('a same-email account created by another admin does not grant access', async () => {
    const victim = await registerOrg('Victim', { plan: null });
    const attacker = await registerOrg('Attacker', { plan: null });
    // Attacker creates a user with the victim's email (and a password the attacker knows)
    await http().post(api('/users')).set(attacker.auth).send({ name: 'Fake', email: victim.email, password: 'attacker-pass', role: 'admin' });
    const login = await http().post(api('/auth/login')).send({ email: victim.email, password: 'attacker-pass' });
    expect(login.status).toBe(200);
    expect(login.body.company.id).toBe(attacker.org.id);
    const sw = await http().post(api('/auth/switch-company')).set({ Authorization: `Bearer ${login.body.token}` }).send({ companyCode: victim.company.companyCode, password: 'attacker-pass' });
    expect(sw.status).toBe(403);
  });

  it('rejects tampered tokens and platform tokens', async () => {
    const a = await registerOrg('Company A');
    const b = await registerOrg('Company B');
    const [h, p, s] = a.token.split('.');
    const forged = JSON.parse(Buffer.from(p, 'base64url').toString());
    forged.org = b.org.id;
    forged.companyId = b.org.id;
    const tampered = `${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`;
    expect((await http().get(api('/leads')).set('Authorization', `Bearer ${tampered}`)).status).toBe(401);
    const platform = await platformAdmin();
    expect((await http().get(api('/leads')).set(platform)).status).toBe(401);
    expect((await http().get(api('/platform/companies')).set(a.auth)).status).toBe(401);
  });

  it('changes the own password and signs out other devices', async () => {
    const a = await registerOrg('Company A');
    const wrong = await http().post(api('/auth/change-password')).set(a.auth).send({ currentPassword: 'nope', newPassword: 'newpass1234' });
    expect(wrong.status).toBe(400);
    const ok = await http().post(api('/auth/change-password')).set(a.auth).send({ currentPassword: 'password123', newPassword: 'newpass1234' });
    expect(ok.status).toBe(200);
    expect((await http().get(api('/auth/me')).set(a.auth)).status).toBe(401);
    expect((await http().get(api('/auth/me')).set({ Authorization: `Bearer ${ok.body.token}` })).status).toBe(200);
    expect((await http().post(api('/auth/login')).send({ email: a.email, password: 'password123' })).status).toBe(401);
    expect((await http().post(api('/auth/login')).send({ email: a.email, password: 'newpass1234' })).status).toBe(200);
  });

  it('logout everywhere revokes the token', async () => {
    const a = await registerOrg('Company A');
    expect((await http().post(api('/auth/logout')).set(a.auth).send({ all: true })).status).toBe(204);
    expect((await http().get(api('/auth/me')).set(a.auth)).status).toBe(401);
  });
});

describe('tenant isolation', () => {
  const RESOURCES = [
    ['leads', { name: 'Lead A' }],
    ['contacts', { firstName: 'Cust A' }],
    ['accounts', { name: 'Acct A' }],
    ['deals', { name: 'Deal A', value: 10 }],
    ['tasks', { title: 'Task A' }],
    ['tickets', { subject: 'Ticket A' }],
    ['notes', { body: 'Note A' }],
    ['appointments', { title: 'Meet', startAt: '2030-01-01T10:00:00Z', endAt: '2030-01-01T11:00:00Z' }],
    ['products', { name: 'Prod A', unitPrice: 100 }],
  ];

  it('company B can neither list, read, update nor delete company A records', async () => {
    const a = await registerOrg('Company A');
    const b = await registerOrg('Company B');
    for (const [path, body] of RESOURCES) {
      const created = await http().post(api(`/${path}`)).set(a.auth).send(body);
      expect(created.status, path).toBe(201);
      const id = created.body.id;
      expect((await http().get(api(`/${path}/${id}`)).set(a.auth)).status, path).toBe(200);
      expect((await http().get(api(`/${path}/${id}`)).set(b.auth)).status, path).toBe(404);
      expect((await http().patch(api(`/${path}/${id}`)).set(b.auth).send({ name: 'x' })).status, path).toBe(404);
      expect((await http().delete(api(`/${path}/${id}`)).set(b.auth)).status, path).toBe(404);
      const list = await http().get(api(`/${path}`)).set(b.auth).query({ organizationId: a.org.id, companyId: a.org.id });
      expect(list.body.items.map((i) => i.id), path).not.toContain(id);
    }
  });

  it('users, roles, pipelines, invoices, settings, audit and dashboard stay inside the tenant', async () => {
    const a = await registerOrg('Company A');
    const b = await registerOrg('Company B');
    const agent = await addUser(a, { role: 'agent' });
    expect((await http().get(api(`/users/${agent.user.id}`)).set(b.auth)).status).toBe(404);
    expect((await http().patch(api(`/users/${agent.user.id}`)).set(b.auth).send({ active: false })).status).toBe(404);
    expect((await http().get(api('/users')).set(b.auth)).body.items.map((u) => u.email)).not.toContain(agent.user.email);

    const role = await http().post(api('/roles')).set(a.auth).send({ name: 'Interns', permissions: ['leads:read'] });
    expect((await http().patch(api(`/roles/${role.body.id}`)).set(b.auth).send({ name: 'Hijack' })).status).toBe(404);
    expect((await http().get(api('/roles')).set(b.auth)).body.items.map((r) => r.key)).not.toContain('interns');

    const pipe = await http().post(api('/pipelines')).set(a.auth).send({ name: 'A only', stages: [{ label: 'One' }, { label: 'Two' }] });
    expect((await http().get(api('/pipelines')).set(b.auth)).body.items.map((p) => p.id)).not.toContain(pipe.body.id);
    // B cannot attach its deal to A's pipeline
    expect((await http().post(api('/deals')).set(b.auth).send({ name: 'x', pipelineId: pipe.body.id, stage: 'one' })).status).toBe(400);

    const contact = await http().post(api('/contacts')).set(a.auth).send({ firstName: 'Buyer' });
    const inv = await http().post(api('/invoices')).set(a.auth).send({ contactId: contact.body.id, customer: { name: 'Buyer' }, items: [{ name: 'Svc', quantity: 1, unitPrice: 100 }] });
    expect(inv.status).toBe(201);
    expect((await http().get(api(`/invoices/${inv.body.id}`)).set(b.auth)).status).toBe(404);

    await http().patch(api('/organization/settings')).set(a.auth).send({ currency: 'USD', branding: { primaryColor: '#ff0000' } });
    expect((await http().get(api('/organization')).set(b.auth)).body.settings.currency).toBe('INR');

    expect((await http().get(api('/audit-logs')).set(b.auth)).body.items.every((l) => String(l.organizationId) === b.org.id)).toBe(true);
    await http().post(api('/leads')).set(a.auth).send({ name: 'Only A' });
    expect((await http().get(api('/dashboard')).set(b.auth)).body.leads.total).toBe(0);
  });

  it('strips Mongo operators from bodies', async () => {
    const a = await registerOrg('Company A');
    const res = await http().post(api('/auth/login')).send({ email: { $gt: '' }, password: { $gt: '' } });
    expect(res.status).toBe(400);
    const lead = await http().post(api('/leads')).set(a.auth).send({ name: 'X', $where: 'sleep(1000)', organizationId: '0'.repeat(24) });
    expect(lead.body.organizationId).toBe(a.org.id);
    expect((await http().get(api('/leads/not-an-id')).set(a.auth)).status).toBe(400);
  });
});

describe('RBAC', () => {
  it('custom roles restrict CRUD per resource', async () => {
    const admin = await registerOrg('Company A');
    const role = await http().post(api('/roles')).set(admin.auth).send({ name: 'Lead viewer', permissions: ['leads:read'] });
    expect(role.status).toBe(201);
    const viewer = await addUser(admin, { role: 'lead_viewer' });
    expect((await http().get(api('/leads')).set(viewer.auth)).status).toBe(200);
    expect((await http().post(api('/leads')).set(viewer.auth).send({ name: 'x' })).status).toBe(403);
    expect((await http().get(api('/contacts')).set(viewer.auth)).status).toBe(403);
    expect((await http().get(api('/deals')).set(viewer.auth)).status).toBe(403);
    // Role edits apply to existing sessions
    await http().patch(api(`/roles/${role.body.id}`)).set(admin.auth).send({ permissions: ['leads:read', 'leads:create'] });
    expect((await http().post(api('/leads')).set(viewer.auth).send({ name: 'ok' })).status).toBe(201);
  });

  it('prevents privilege escalation', async () => {
    const admin = await registerOrg('Company A');
    const hr = await addUser(admin, { role: 'hr_manager' });
    // HR can create employees but not admins, not edit the admin, and not create powerful roles
    expect((await http().post(api('/users')).set(hr.auth).send({ name: 'E', email: 'e@x.test', password: 'password123', role: 'employee' })).status).toBe(201);
    expect((await http().post(api('/users')).set(hr.auth).send({ name: 'Boss', email: 'b@x.test', password: 'password123', role: 'admin' })).status).toBe(403);
    expect((await http().patch(api(`/users/${admin.user.id}`)).set(hr.auth).send({ active: false })).status).toBe(403);
    expect((await http().patch(api(`/users/${hr.user.id}`)).set(hr.auth).send({ role: 'admin' })).status).toBe(403);
    expect((await http().post(api('/roles')).set(hr.auth).send({ name: 'Root', permissions: ['*'] })).status).toBe(403);
    expect((await http().post(api('/roles')).set(admin.auth).send({ name: 'Bad', permissions: ['nope:fly'] })).status).toBe(400);
    // Last admin cannot be removed
    expect((await http().patch(api(`/users/${admin.user.id}`)).set(admin.auth).send({ role: 'employee' })).status).toBe(400);
  });

  it('built-in roles cannot be deleted; roles in use cannot be deleted', async () => {
    const admin = await registerOrg('Company A');
    const roles = await http().get(api('/roles')).set(admin.auth);
    const sys = roles.body.items.find((r) => r.key === 'employee');
    expect((await http().delete(api(`/roles/${sys.id}`)).set(admin.auth)).status).toBe(400);
    const custom = await http().post(api('/roles')).set(admin.auth).send({ name: 'Temp', permissions: ['tasks:read'] });
    await addUser(admin, { role: 'temp' });
    expect((await http().delete(api(`/roles/${custom.body.id}`)).set(admin.auth)).status).toBe(409);
  });
});

describe('subscriptions, modules and limits', () => {
  it('module access follows the plan', async () => {
    const a = await registerOrg('Company A', { plan: 'FREE' });
    expect((await http().get(api('/leads')).set(a.auth)).status).toBe(200);
    const deals = await http().get(api('/deals')).set(a.auth);
    expect(deals.status).toBe(403);
    expect(deals.body.code).toBe('MODULE_NOT_IN_PLAN');
    expect((await http().get(api('/calls')).set(a.auth)).body.code).toBe('MODULE_NOT_IN_PLAN');
    await setPlan(a.org.id, 'STARTER');
    expect((await http().get(api('/deals')).set(a.auth)).status).toBe(200);
    expect((await http().get(api('/calls')).set(a.auth)).status).toBe(403);
    // Platform overrides
    await Organization.updateOne({ _id: a.org.id }, { moduleOverrides: { enabled: ['calling'], disabled: ['deals'] } });
    invalidateTenant(a.org.id);
    expect((await http().get(api('/deals')).set(a.auth)).status).toBe(403);
    expect((await http().get(api('/calls')).set(a.auth)).status).toBe(200);
  });

  it('lead conversion needs the customers module; deals only when in plan', async () => {
    const a = await registerOrg('Company A', { plan: 'FREE' });
    const lead = await http().post(api('/leads')).set(a.auth).send({ name: 'Convert me', company: 'Acme' });
    const blocked = await http().post(api(`/leads/${lead.body.id}/convert`)).set(a.auth).send({});
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('MODULE_NOT_IN_PLAN');
    await Organization.updateOne({ _id: a.org.id }, { moduleOverrides: { enabled: ['customers'], disabled: [] } });
    invalidateTenant(a.org.id);
    const ok = await http().post(api(`/leads/${lead.body.id}/convert`)).set(a.auth).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.contact).toBeTruthy();
    expect(ok.body.deal).toBeNull(); // deals module not in FREE
  });

  it('returns PLAN_LIMIT_REACHED at the limit', async () => {
    const a = await registerOrg('Company A', { plan: 'FREE' }); // 2 users, 100 leads
    await addUser(a, { role: 'employee' });
    const third = await http().post(api('/users')).set(a.auth).send({ name: 'x', email: 'third@x.test', password: 'password123', role: 'employee' });
    expect(third.status).toBe(403);
    expect(third.body).toMatchObject({ success: false, code: 'PLAN_LIMIT_REACHED' });
    expect(third.body.message).toMatch(/User limit reached/);
    await CompanySubscription.updateOne({ organizationId: a.org.id }, { customLimits: { leads: 2 } });
    invalidateTenant(a.org.id);
    expect((await http().post(api('/leads')).set(a.auth).send({ name: '1' })).status).toBe(201);
    expect((await http().post(api('/leads')).set(a.auth).send({ name: '2' })).status).toBe(201);
    const over = await http().post(api('/leads')).set(a.auth).send({ name: '3' });
    expect(over.body.code).toBe('PLAN_LIMIT_REACHED');
    // Import that would exceed the limit is rejected up front
    const csv = 'Name\nA\nB\n';
    await setPlan(a.org.id, 'STARTER', { customLimits: { leads: 3 } });
    const imp = await http().post(api('/leads/import')).set(a.auth).set('Content-Type', 'text/csv').send(csv);
    expect(imp.body.code).toBe('PLAN_LIMIT_REACHED');
    const usage = await http().get(api('/usage')).set(a.auth);
    expect(usage.body.leads).toEqual({ used: 2, limit: 3 });
    expect(usage.body.users.used).toBe(2);
  });

  it('expired trial keeps login, billing and free modules but restricts premium ones', async () => {
    const a = await registerOrg('Company A', { plan: null });
    expect((await http().get(api('/deals')).set(a.auth)).status).toBe(200); // trial = PROFESSIONAL
    await CompanySubscription.updateOne({ organizationId: a.org.id }, { trialEnd: new Date(Date.now() - 1000), endDate: new Date(Date.now() - 1000) });
    invalidateTenant(a.org.id);
    expect((await http().get(api('/auth/me')).set(a.auth)).body.company.subscription.status).toBe('expired');
    expect((await http().get(api('/billing')).set(a.auth)).status).toBe(200);
    expect((await http().get(api('/leads')).set(a.auth)).status).toBe(200); // FREE module
    const deals = await http().get(api('/deals')).set(a.auth);
    expect(deals.status).toBe(402);
    expect(deals.body.code).toBe('SUBSCRIPTION_INACTIVE');
    expect(await expireSubscriptions()).toBe(1);
    expect((await CompanySubscription.findOne({ organizationId: a.org.id })).status).toBe('expired');
    expect(await AuditLog.exists({ organizationId: a.org.id, action: 'subscription.expired' })).toBeTruthy();
  });

  it('suspended company is blocked except session and billing', async () => {
    const a = await registerOrg('Company A');
    await Organization.updateOne({ _id: a.org.id }, { status: 'suspended' });
    invalidateTenant(a.org.id);
    expect((await http().get(api('/leads')).set(a.auth)).body.code).toBe('COMPANY_SUSPENDED');
    expect((await http().get(api('/auth/me')).set(a.auth)).status).toBe(200);
  });

  it('respects platform trial settings and approval', async () => {
    await PlatformSettings.updateOne({ key: 'global' }, { trialDays: 7, requireApproval: true }, { upsert: true });
    invalidateTenant();
    const a = await registerOrg('Company A', { plan: null });
    expect(a.company.subscription.daysLeft).toBe(7);
    expect((await http().get(api('/leads')).set(a.auth)).body.code).toBe('COMPANY_PENDING_APPROVAL');
  });

  it('counts API calls and enforces the monthly API limit', async () => {
    const a = await registerOrg('Company A', { plan: 'FREE' });
    await CompanySubscription.updateOne({ organizationId: a.org.id }, { customLimits: { apiCallsPerMonth: 3 } });
    invalidateTenant(a.org.id);
    for (let i = 0; i < 3; i += 1) expect((await http().get(api('/leads')).set(a.auth)).status).toBe(200);
    const res = await http().get(api('/leads')).set(a.auth);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
  });
});

describe('billing & payments', () => {
  it('checkout → verified payment activates plan and issues invoice', async () => {
    const a = await registerOrg('Company A', { plan: null });
    const quote = await http().post(api('/billing/quote')).set(a.auth).send({ planCode: 'BUSINESS', billingCycle: 'yearly' });
    expect(quote.body.total).toBe(79990);
    const co = await http().post(api('/billing/checkout')).set(a.auth).send({ planCode: 'BUSINESS', billingCycle: 'monthly', provider: 'fakepay' });
    expect(co.status).toBe(201);
    const paymentId = co.body.payment.id;
    // Client claims success without proof → rejected, nothing activated
    expect((await http().post(api('/billing/verify')).set(a.auth).send({ paymentId })).status).toBeGreaterThanOrEqual(400);
    expect((await http().get(api('/calls')).set(a.auth)).status).toBe(403);
    const ok = await http().post(api('/billing/verify')).set(a.auth).send({ paymentId, ok: true });
    expect(ok.status).toBe(200);
    expect(ok.body.billing.subscription).toMatchObject({ status: 'active', planCode: 'BUSINESS', billingCycle: 'monthly' });
    expect((await http().get(api('/calls')).set(a.auth)).status).toBe(200);
    const invoices = await http().get(api('/billing/invoices')).set(a.auth);
    expect(invoices.body.items[0]).toMatchObject({ status: 'paid', total: 7999, planCode: 'BUSINESS' });
    // Webhook for the same order is idempotent
    const hook = { id: 'evt_1', events: [{ type: 'payment.succeeded', orderId: co.body.payment.providerOrderId || `order_${paymentId}`, paymentId: 'p1' }] };
    expect((await http().post(api('/webhooks/payments/fakepay')).set('x-fake-signature', 'valid').send(hook)).status).toBe(200);
    expect((await http().post(api('/webhooks/payments/fakepay')).set('x-fake-signature', 'valid').send(hook)).body.duplicate).toBe(true);
    expect((await http().get(api('/billing/invoices')).set(a.auth)).body.items).toHaveLength(1);
  });

  it('webhooks drive payment state; bad signatures are rejected', async () => {
    const a = await registerOrg('Company A', { plan: null });
    const co = await http().post(api('/billing/checkout')).set(a.auth).send({ planCode: 'STARTER', billingCycle: 'monthly', provider: 'fakepay' });
    const orderId = `order_${co.body.payment.id}`;
    expect((await http().post(api('/webhooks/payments/fakepay')).set('x-fake-signature', 'forged').send({ id: 'e', events: [{ type: 'payment.succeeded', orderId }] })).status).toBe(401);
    expect((await Payment.findById(co.body.payment.id)).status).toBe('pending');
    await http().post(api('/webhooks/payments/fakepay')).set('x-fake-signature', 'valid').send({ id: 'e2', events: [{ type: 'payment.succeeded', orderId, paymentId: 'pay_9' }] });
    expect((await http().get(api('/billing')).set(a.auth)).body.subscription).toMatchObject({ status: 'active', planCode: 'STARTER' });
    await http().post(api('/webhooks/payments/fakepay')).set('x-fake-signature', 'valid').send({ id: 'e3', events: [{ type: 'payment.refunded', paymentId: 'pay_9', amount: 999 }] });
    expect((await Payment.findById(co.body.payment.id)).status).toBe('refunded');
    expect((await http().get(api('/billing')).set(a.auth)).body.premium).toBe(false);
  });

  it('coupons, free downgrade, cancel and resume', async () => {
    const admin = await platformAdmin();
    await http().post(api('/platform/coupons')).set(admin).send({ code: 'FULL100', percentOff: 100 });
    const a = await registerOrg('Company A', { plan: null });
    const co = await http().post(api('/billing/checkout')).set(a.auth).send({ planCode: 'STARTER', billingCycle: 'monthly', provider: 'fakepay', couponCode: 'full100' });
    expect(co.body.activated).toBe(true);
    expect((await http().get(api('/billing')).set(a.auth)).body.subscription.planCode).toBe('STARTER');
    const cancel = await http().post(api('/billing/cancel')).set(a.auth);
    expect(cancel.body.subscription.status).toBe('cancelled');
    expect(cancel.body.premium).toBe(true); // paid until period end
    expect((await http().post(api('/billing/resume')).set(a.auth)).body.subscription.status).toBe('active');
    const down = await http().post(api('/billing/change-plan')).set(a.auth).send({ planCode: 'FREE' });
    expect(down.body.subscription.planCode).toBe('FREE');
    expect((await http().post(api('/billing/change-plan')).set(a.auth).send({ planCode: 'BUSINESS' })).status).toBe(400);
    expect((await http().post(api('/billing/checkout')).set(a.auth).send({ planCode: 'BUSINESS', billingCycle: 'monthly', provider: 'razorpay' })).body.code).toBe('NOT_CONFIGURED');
  });

  it('only billing managers can pay', async () => {
    const a = await registerOrg('Company A');
    const emp = await addUser(a, { role: 'employee' });
    expect((await http().post(api('/billing/checkout')).set(emp.auth).send({ planCode: 'STARTER', billingCycle: 'monthly', provider: 'fakepay' })).status).toBe(403);
  });

  it('Razorpay and Stripe signature verification', async () => {
    const rzp = new RazorpayService({ keyId: 'rzp_test', keySecret: 'secret', webhookSecret: 'whsec' });
    const sig = crypto.createHmac('sha256', 'secret').update('order_1|pay_1').digest('hex');
    await expect(rzp.verifyClientPayment({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: sig }, { providerOrderId: 'order_1' })).resolves.toEqual({ paymentId: 'pay_1' });
    await expect(rzp.verifyClientPayment({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_2', razorpay_signature: sig }, { providerOrderId: 'order_1' })).rejects.toThrow(/signature/);
    const raw = Buffer.from('{"event":"payment.captured"}');
    expect(rzp.verifyWebhook({ rawBody: raw, headers: { 'x-razorpay-signature': crypto.createHmac('sha256', 'whsec').update(raw).digest('hex') } })).toBe(true);
    expect(rzp.verifyWebhook({ rawBody: raw, headers: { 'x-razorpay-signature': 'bad' } })).toBe(false);
    expect(rzp.parseWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1' } } } }).events[0]).toMatchObject({ type: 'payment.succeeded', orderId: 'order_1' });

    const stripe = new StripeService({ secretKey: 'sk_test', webhookSecret: 'whsec_s' });
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', 'whsec_s').update(`${t}.${raw}`).digest('hex');
    expect(stripe.verifyWebhook({ rawBody: raw, headers: { 'stripe-signature': `t=${t},v1=${v1}` } })).toBe(true);
    expect(stripe.verifyWebhook({ rawBody: raw, headers: { 'stripe-signature': `t=${t - 1000},v1=${v1}` } })).toBe(false);
    expect(stripe.parseWebhook({ id: 'evt', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1' } } }).events[0]).toMatchObject({ type: 'payment.succeeded', orderId: 'cs_1' });
  });
});

describe('super admin', () => {
  it('grants the picked plan directly when created without a trial', async () => {
    const admin = await platformAdmin();
    const direct = await http().post(api('/platform/companies')).set(admin).send({
      companyName: 'Delta', email: 'hello@delta.test', adminName: 'Dev', adminEmail: 'dev@delta.test', password: 'password123', planCode: 'ENTERPRISE', trial: false,
    });
    expect(direct.status).toBe(201);
    expect(direct.body.company.subscription).toMatchObject({ planCode: 'ENTERPRISE', status: 'active' });

    const login = await http().post(api('/auth/login')).send({ email: 'dev@delta.test', password: 'password123' });
    expect((await http().get(api('/calls')).set({ Authorization: `Bearer ${login.body.token}` })).status).toBe(200);
  });

  it('manages companies, plans, subscriptions and modules', async () => {
    const admin = await platformAdmin();
    const created = await http().post(api('/platform/companies')).set(admin).send({
      companyName: 'Gamma', email: 'hello@gamma.test', adminName: 'Gita', adminEmail: 'gita@gamma.test', password: 'password123', planCode: 'STARTER',
    });
    expect(created.status).toBe(201);
    const id = created.body.company.id;
    await registerOrg('Other', { plan: null });

    const list = await http().get(api('/platform/companies')).set(admin).query({ q: 'gam' });
    expect(list.body.items.map((c) => c.name)).toEqual(['Gamma']);
    expect((await http().get(api('/platform/companies')).set(admin).query({ subscriptionStatus: 'trial' })).body.total).toBe(2);

    const login = await http().post(api('/auth/login')).send({ email: 'gita@gamma.test', password: 'password123' });
    const gAuth = { Authorization: `Bearer ${login.body.token}` };
    expect((await http().get(api('/calls')).set(gAuth)).status).toBe(403);

    await http().put(api(`/platform/companies/${id}/subscription`)).set(admin).send({ planCode: 'BUSINESS' });
    expect((await http().get(api('/calls')).set(gAuth)).status).toBe(200);
    await http().put(api(`/platform/companies/${id}/modules`)).set(admin).send({ disabled: ['calling'] });
    expect((await http().get(api('/calls')).set(gAuth)).status).toBe(403);

    const ext = await http().post(api(`/platform/companies/${id}/subscription/extend`)).set(admin).send({ days: 30 });
    expect(new Date(ext.body.endDate) > new Date()).toBe(true);

    await http().post(api(`/platform/companies/${id}/suspend`)).set(admin).send({ reason: 'Unpaid' });
    expect((await http().get(api('/leads')).set(gAuth)).status).toBe(401); // sessions revoked
    const relog = await http().post(api('/auth/login')).send({ email: 'gita@gamma.test', password: 'password123' });
    expect((await http().get(api('/leads')).set({ Authorization: `Bearer ${relog.body.token}` })).body.code).toBe('COMPANY_SUSPENDED');
    await http().post(api(`/platform/companies/${id}/activate`)).set(admin);
    expect((await http().get(api('/leads')).set({ Authorization: `Bearer ${relog.body.token}` })).status).toBe(200);

    const detail = await http().get(api(`/platform/companies/${id}`)).set(admin);
    expect(detail.body.usage.users.used).toBe(1);
    expect((await http().get(api(`/platform/companies/${id}/users`)).set(admin)).body.items[0].passwordHash).toBeUndefined();

    const plan = await http().post(api('/platform/plans')).set(admin).send({ code: 'STARTUP', name: 'Startup', priceMonthly: 499, priceYearly: 4990, limits: { users: 3 }, modules: ['crm', 'leads'] });
    expect(plan.status).toBe(201);
    expect((await http().get(api('/public/plans'))).body.items.map((p) => p.code)).toContain('STARTUP');

    const dash = await http().get(api('/platform/dashboard')).set(admin);
    expect(dash.body.cards).toMatchObject({ totalCompanies: 2, totalUsers: 2 });
    expect(dash.body.charts.revenue).toHaveLength(12);
    const logs = await http().get(api('/platform/audit-logs')).set(admin).query({ companyId: id });
    expect(logs.body.items.map((l) => l.action)).toEqual(expect.arrayContaining(['company.create', 'subscription.changed', 'company.suspended']));
    expect((await http().get(api('/platform/system/health')).set(admin)).body.database).toBe('connected');

    expect((await http().delete(api(`/platform/companies/${id}`)).set(admin).send({ confirm: 'wrong' })).status).toBe(400);
    expect((await http().delete(api(`/platform/companies/${id}`)).set(admin).send({ confirm: created.body.company.companyCode })).status).toBe(204);
    expect(await User.countDocuments({ organizationId: id })).toBe(0);
    expect(await AuditLog.exists({ organizationId: id, action: 'company.deleted' })).toBeTruthy();
  });

  it('support platform users are read-only', async () => {
    const admin = await platformAdmin();
    await http().post(api('/platform/admins')).set(admin).send({ name: 'S', email: 'support@platform.test', password: 'support-password', role: 'support' });
    const s = await http().post(api('/platform/auth/login')).send({ email: 'support@platform.test', password: 'support-password' });
    const auth = { Authorization: `Bearer ${s.body.token}` };
    expect((await http().get(api('/platform/companies')).set(auth)).status).toBe(200);
    expect((await http().post(api('/platform/plans')).set(auth).send({})).status).toBe(403);
  });
});

describe('health, errors and migration', () => {
  it('health reports database without secrets', async () => {
    const res = await http().get('/health');
    expect(res.body).toMatchObject({ status: 'ok', database: 'connected', environment: 'test' });
    expect(JSON.stringify(res.body)).not.toMatch(/mongodb:\/\//);
  });

  it('errors use the documented shape', async () => {
    const res = await http().get(api('/nope'));
    expect(res.body).toMatchObject({ success: false, code: 'UNAUTHORIZED', message: expect.any(String), errors: [] });
  });

  it('grandfathers pre-SaaS companies on ENTERPRISE with roles and codes', async () => {
    const org = await Organization.create({ name: 'Legacy', slug: 'legacy-1' });
    await User.create({ organizationId: org._id, name: 'Old', email: 'old@legacy.test', passwordHash: 'x', role: 'admin' });
    await Organization.collection.updateOne({ _id: org._id }, { $unset: { status: '' } });
    await runSaasMigrations();
    const after = await Organization.findById(org._id).lean();
    expect(after.companyCode).toMatch(/^CMP-/);
    expect(after.status).toBe('active');
    expect((await CompanySubscription.findOne({ organizationId: org._id })).planCode).toBe('ENTERPRISE');
    expect(await Role.exists({ organizationId: org._id, key: 'sales_manager' })).toBeTruthy();
    expect((await User.findOne({ email: 'old@legacy.test' })).userCode).toMatch(/^USR-/);
    expect(await runSaasMigrations()).toBe(0);
  });
});
