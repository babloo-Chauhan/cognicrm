import { describe, expect, it } from 'vitest';
import { http, useDatabase } from './helpers.js';
import { CompanySubscription } from '../src/models/index.js';
import { createPlatformUser } from '../src/modules/platform/auth.js';
import { invalidateTenant } from '../src/modules/saas/tenant.js';

useDatabase();

const api = (p) => `/api/v1${p}`;
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

/** The 21-step acceptance scenario from the SaaS specification, run through the public HTTP API only. */
describe('end-to-end SaaS scenario', () => {
  it('runs steps 1–21', async () => {
    // STEP 1–2: register Company A (creates the company admin)
    const regA = await http().post(api('/auth/register')).send({
      companyName: 'Company A', email: 'admin@a.test', adminName: 'Anil', password: 'password123', confirmPassword: 'password123', country: 'India', industry: 'IT',
    });
    expect(regA.status).toBe(201);
    expect(regA.body.company).toMatchObject({ companyCode: expect.stringMatching(/^CMP-/), tenantId: expect.stringMatching(/^TEN-/) });

    // STEP 3: login Company A
    const loginA = await http().post(api('/auth/login')).send({ email: 'admin@a.test', password: 'password123' });
    expect(loginA.status).toBe(200);
    const A = bearer(loginA.body.token);

    // STEP 4: create users
    for (const [i, role] of ['sales_manager', 'sales_executive'].entries()) {
      expect((await http().post(api('/users')).set(A).send({ name: `User ${i}`, email: `u${i}@a.test`, password: 'password123', role })).status).toBe(201);
    }

    // STEP 5–8: customer, lead, deal, pipeline
    const customerA = await http().post(api('/contacts')).set(A).send({ firstName: 'Customer', lastName: 'A', phone: '9876500001' });
    expect(customerA.status).toBe(201);
    expect((await http().post(api('/leads')).set(A).send({ name: 'Lead A', status: 'qualified', estimatedValue: 50000 })).status).toBe(201);
    const pipeline = await http().post(api('/pipelines')).set(A).send({ name: 'Enterprise', stages: [{ label: 'Lead' }, { label: 'Qualified' }, { label: 'Demo' }, { label: 'Proposal' }, { label: 'Negotiation' }] });
    expect(pipeline.status).toBe(201);
    expect(pipeline.body.stages.map((s) => s.key)).toEqual(['lead', 'qualified', 'demo', 'proposal', 'negotiation', 'won', 'lost']);
    const deal = await http().post(api('/deals')).set(A).send({ name: 'Deal A', value: 100000, pipelineId: pipeline.body.id, stage: 'demo', contactId: customerA.body.id });
    expect(deal.status).toBe(201);
    expect((await http().patch(api(`/deals/${deal.body.id}`)).set(A).send({ stage: 'won' })).status).toBe(200);
    expect((await http().patch(api(`/deals/${deal.body.id}`)).set(A).send({ stage: 'not_a_stage' })).status).toBe(400);

    // STEP 9: dashboard
    const dash = await http().get(api('/dashboard')).set(A);
    expect(dash.status).toBe(200);
    expect(dash.body).toMatchObject({ leads: { total: 1 }, customers: { contacts: 1 }, deals: { total: 1, won: 1 }, revenue: { wonDeals: 100000 } });

    // STEP 10: usage
    const usage = await http().get(api('/usage')).set(A);
    expect(usage.body).toMatchObject({ users: { used: 3, limit: 20 }, leads: { used: 1 }, customers: { used: 1 }, deals: { used: 1 } });

    // STEP 11–12: register + login Company B
    await http().post(api('/auth/register')).send({ companyName: 'Company B', email: 'admin@b.test', name: 'Bina', password: 'password123' });
    const loginB = await http().post(api('/auth/login')).send({ email: 'admin@b.test', password: 'password123' });
    const B = bearer(loginB.body.token);

    // STEP 13: Company B sees zero Company A data
    for (const path of ['/leads', '/contacts', '/deals', '/tasks', '/accounts']) {
      expect((await http().get(api(path)).set(B)).body.total, path).toBe(0);
    }
    expect((await http().get(api('/users')).set(B)).body.items).toHaveLength(1);
    expect((await http().get(api('/pipelines')).set(B)).body.items.map((p) => p.name)).not.toContain('Enterprise');
    expect((await http().get(api('/dashboard')).set(B)).body.deals.total).toBe(0);

    // STEP 14: Company B customer
    const customerB = await http().post(api('/contacts')).set(B).send({ firstName: 'Customer', lastName: 'B' });
    expect(customerB.status).toBe(201);

    // STEP 15: Company A's customer with Company B's token → denied (404: existence is not revealed)
    expect((await http().get(api(`/contacts/${customerA.body.id}`)).set(B)).status).toBe(404);
    expect((await http().get(api(`/contacts/${customerA.body.id}`)).set(A)).status).toBe(200);
    expect((await http().get(api(`/contacts/${customerB.body.id}`)).set(B)).status).toBe(200);

    // STEP 16–17: change Company A's plan (super admin) → feature availability changes
    await createPlatformUser({ email: 'owner@platform.test', password: 'super-secret-pass', name: 'Owner' });
    const P = bearer((await http().post(api('/platform/auth/login')).send({ email: 'owner@platform.test', password: 'super-secret-pass' })).body.token);
    expect((await http().get(api('/calls')).set(A)).body.code).toBe('MODULE_NOT_IN_PLAN'); // PROFESSIONAL trial
    expect((await http().put(api(`/platform/companies/${regA.body.organization.id}/subscription`)).set(P).send({ planCode: 'BUSINESS' })).status).toBe(200);
    expect((await http().get(api('/calls')).set(A)).status).toBe(200);
    expect((await http().put(api(`/platform/companies/${regA.body.organization.id}/subscription`)).set(P).send({ planCode: 'FREE' })).status).toBe(200);
    expect((await http().get(api('/contacts')).set(A)).body.code).toBe('MODULE_NOT_IN_PLAN');

    // STEP 18–19: reach the plan limit → PLAN_LIMIT_REACHED (FREE allows 2 users; A already has 3)
    const overLimit = await http().post(api('/users')).set(A).send({ name: 'Extra', email: 'extra@a.test', password: 'password123', role: 'employee' });
    expect(overLimit.status).toBe(403);
    expect(overLimit.body).toMatchObject({ success: false, code: 'PLAN_LIMIT_REACHED', message: expect.stringMatching(/User limit reached/) });

    // STEP 20–21: expire Company B's trial → premium modules restricted, login + billing + free modules still work
    expect((await http().get(api('/contacts')).set(B)).status).toBe(200);
    await CompanySubscription.updateOne({ organizationId: loginB.body.company.id }, { trialEnd: new Date(Date.now() - 60000), endDate: new Date(Date.now() - 60000) });
    invalidateTenant(loginB.body.company.id);
    const relogin = await http().post(api('/auth/login')).send({ email: 'admin@b.test', password: 'password123' });
    expect(relogin.status).toBe(200);
    expect(relogin.body.company.subscription.status).toBe('expired');
    expect((await http().get(api('/contacts')).set(B)).body.code).toBe('SUBSCRIPTION_INACTIVE');
    expect((await http().get(api('/billing')).set(B)).status).toBe(200);
    expect((await http().get(api('/leads')).set(B)).status).toBe(200);
    // Data is kept: the customer is still there once access returns
    await http().put(api(`/platform/companies/${loginB.body.company.id}/subscription`)).set(P).send({ planCode: 'STARTER' });
    expect((await http().get(api('/contacts')).set(B)).body.total).toBe(1);
  });
});
