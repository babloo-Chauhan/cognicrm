import { describe, expect, it } from 'vitest';
import { addUser, http, registerOrg, useDatabase } from './helpers.js';
import { Activity, Deal, Invoice, Notification, Quote } from '../src/models/index.js';
import { amountInWords, calculate, financialYear, resolveTaxMode } from '../src/modules/sales/calc.js';
import { expireQuotes, markOverdueInvoices } from '../src/modules/sales/service.js';

useDatabase();

const FY = financialYear(new Date());

describe('sales calculations', () => {
  it('splits GST into CGST+SGST inside a state and IGST across states', () => {
    const items = [{ name: 'A', quantity: 2, unitPrice: 1000, taxRate: 18 }, { name: 'B', quantity: 1, unitPrice: 500, discountPercent: 10, taxRate: 5 }];
    const intra = calculate({ items, seller: { state: 'Maharashtra' }, customer: { state: 'maharashtra' } });
    expect(intra.appliedTaxMode).toBe('intra');
    expect(intra.totals).toMatchObject({ subtotal: 2500, discountTotal: 50, taxableAmount: 2450, taxTotal: 382.5, cgst: 191.25, sgst: 191.25, igst: 0, total: 2833, roundOff: 0.5 });
    expect(intra.items[1]).toMatchObject({ amount: 450, taxAmount: 22.5, total: 472.5 });
    const inter = calculate({ items, seller: { gstin: '27AAAAA0000A1Z5', state: 'Maharashtra' }, customer: { gstin: '29BBBBB0000B1Z5', state: 'Maharashtra' } });
    expect(inter.appliedTaxMode).toBe('inter');
    expect(inter.totals).toMatchObject({ igst: 382.5, cgst: 0, sgst: 0 });
    expect(calculate({ items, taxMode: 'none' }).totals.taxTotal).toBe(0);
  });

  it('spreads a flat extra discount before tax', () => {
    const res = calculate({ items: [{ name: 'A', quantity: 1, unitPrice: 1000, taxRate: 18 }], extraDiscount: 100 });
    expect(res.totals).toMatchObject({ taxableAmount: 900, taxTotal: 162, total: 1062, discountTotal: 100 });
    expect(resolveTaxMode('auto', {}, {})).toBe('intra');
  });

  it('writes amounts in Indian words and labels financial years', () => {
    expect(amountInWords(2833)).toBe('Rupees Two Thousand Eight Hundred Thirty Three Only');
    expect(amountInWords(12550000.5)).toBe('Rupees One Crore Twenty Five Lakh Fifty Thousand and Fifty Paise Only');
    expect(financialYear(new Date(2026, 2, 31))).toBe('2025-26');
    expect(financialYear(new Date(2026, 3, 1))).toBe('2026-27');
  });
});

async function setupOrg() {
  const admin = await registerOrg('Sharma Traders');
  await http().patch('/api/v1/organization/settings').set(admin.auth).send({
    billing: { companyName: 'Sharma Traders Pvt Ltd', state: 'Maharashtra', gstin: '27ABCDE1234F1Z5', invoicePrefix: 'ST', quotePrefix: 'Q', upiId: 'sharma@upi' },
  });
  return admin;
}

describe('lead → quotation → invoice → payment', () => {
  it('runs the full sales process', async () => {
    const admin = await setupOrg();

    // 1. New lead, converted into contact + account + deal
    const lead = await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Rahul Mehta', email: 'rahul@infra.in', phone: '9876543210', company: 'Infra Co', estimatedValue: 50000 });
    const converted = await http().post(`/api/v1/leads/${lead.body.id}/convert`).set(admin.auth).send({});
    const dealId = converted.body.deal.id;
    expect(converted.body.deal.stage).toBe('prospecting');

    // 2. Catalog product + quotation from the deal: customer details are filled in from the CRM
    const product = await http().post('/api/v1/products').set(admin.auth).send({ name: 'CRM licence', unitPrice: 12000, taxRate: 18, hsnSac: '997331', unit: 'user' });
    const created = await http().post('/api/v1/quotes').set(admin.auth).send({
      dealId,
      customer: { state: 'Maharashtra', gstin: '27ZZZZZ9999Z1Z5', address: 'Andheri, Mumbai' },
      items: [{ productId: product.body.id, quantity: 3 }, { name: 'Onboarding', unitPrice: 5000, taxRate: 18, discountPercent: 20 }],
    });
    expect(created.status).toBe(201);
    const quote = created.body;
    expect(quote).toMatchObject({ number: `Q/${FY}/0001`, version: 1, status: 'draft', appliedTaxMode: 'intra' });
    expect(quote.customer).toMatchObject({ name: 'Rahul Mehta', company: 'Infra Co', email: 'rahul@infra.in', gstin: '27ZZZZZ9999Z1Z5' });
    expect(quote.items[0]).toMatchObject({ name: 'CRM licence', hsnSac: '997331', amount: 36000, taxAmount: 6480 });
    expect(quote.totals).toMatchObject({ taxableAmount: 40000, cgst: 3600, sgst: 3600, total: 47200 });
    expect(quote.contactId).toBe(converted.body.contact.id);
    expect(quote.publicUrl).toContain(`/api/v1/public/quotes/${quote.publicToken}`);

    // Draft can be edited
    const edited = await http().patch(`/api/v1/quotes/${quote.id}`).set(admin.auth).send({ notes: 'Prices valid for this order only' });
    expect(edited.body.notes).toBe('Prices valid for this order only');

    // 3. Send: no email provider is configured, so the link is returned for sharing and the deal moves to proposal
    const sent = await http().post(`/api/v1/quotes/${quote.id}/send`).set(admin.auth).send({});
    expect(sent.body).toMatchObject({ emailed: false, quote: { status: 'sent' } });
    expect(sent.body.emailError).toBeTruthy();
    expect((await Deal.findById(dealId)).stage).toBe('proposal');
    expect((await http().patch(`/api/v1/quotes/${quote.id}`).set(admin.auth).send({ notes: 'x' })).status).toBe(409);

    // 4. Client opens the link and accepts online
    const page = await http().get(`/api/v1/public/quotes/${quote.publicToken}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`Q/${FY}/0001`);
    expect(page.text).toContain('Accept quotation');
    expect(page.text).toContain('Rupees Forty Seven Thousand Two Hundred Only');
    expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-/);
    expect((await Quote.findById(quote.id)).viewedAt).toBeTruthy();
    const accept = await http().post(`/api/v1/public/quotes/${quote.publicToken}/accept`).type('form').send({ name: 'Rahul Mehta' });
    expect(accept.status).toBe(303);
    expect(accept.headers.location).toBe(`../${quote.publicToken}?done=accepted`);
    const acceptedQuote = await Quote.findById(quote.id);
    expect(acceptedQuote).toMatchObject({ status: 'accepted', acceptedBy: 'Rahul Mehta' });
    const deal = await Deal.findById(dealId);
    expect(deal).toMatchObject({ stage: 'won', value: 47200, probability: 100 });
    expect(await Notification.countDocuments({ type: 'quote_accepted' })).toBe(1);
    // Accepting twice is harmless; declining after acceptance is refused
    const late = await http().post(`/api/v1/public/quotes/${quote.publicToken}/reject`).type('form').send({ reason: 'x' });
    expect(late.headers.location).toContain('done=error');

    // 5. Invoice from the accepted quotation: a draft without a number until issued
    const inv = await http().post(`/api/v1/quotes/${quote.id}/invoice`).set(admin.auth);
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({ status: 'draft', quoteId: quote.id, balanceDue: 47200 });
    expect(inv.body.number).toBeUndefined();
    expect((await http().post(`/api/v1/quotes/${quote.id}/invoice`).set(admin.auth)).status).toBe(409);

    const issued = await http().post(`/api/v1/invoices/${inv.body.id}/issue`).set(admin.auth);
    expect(issued.body).toMatchObject({ number: `ST/${FY}/0001`, status: 'issued' });
    expect(new Date(issued.body.dueDate) > new Date()).toBe(true);
    expect((await http().patch(`/api/v1/invoices/${inv.body.id}`).set(admin.auth).send({ notes: 'x' })).status).toBe(409);

    const invPage = await http().get(`/api/v1/public/invoices/${issued.body.publicToken}`);
    expect(invPage.text).toContain('TAX INVOICE');
    expect(invPage.text).toContain('sharma@upi');

    // 6. Payments: partial, over-payment refused, then the rest
    const p1 = await http().post(`/api/v1/invoices/${inv.body.id}/payments`).set(admin.auth).send({ amount: 20000, method: 'upi', reference: 'UTR123' });
    expect(p1.body).toMatchObject({ status: 'partially_paid', amountPaid: 20000, balanceDue: 27200 });
    expect((await http().post(`/api/v1/invoices/${inv.body.id}/payments`).set(admin.auth).send({ amount: 30000 })).status).toBe(400);
    expect((await http().post(`/api/v1/invoices/${inv.body.id}/void`).set(admin.auth).send({})).status).toBe(409);
    const p2 = await http().post(`/api/v1/invoices/${inv.body.id}/payments`).set(admin.auth).send({ amount: 27200, method: 'bank_transfer' });
    expect(p2.body).toMatchObject({ status: 'paid', balanceDue: 0 });
    expect(p2.body.paidAt).toBeTruthy();

    // Everything is on the deal timeline
    const types = (await Activity.find({ 'links.dealId': dealId })).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(['quote_created', 'quote_sent', 'quote_accepted', 'stage_changed', 'invoice_issued', 'payment_received']));

    // 7. Funnel overview
    const overview = await http().get('/api/v1/sales/overview').set(admin.auth);
    expect(overview.body.funnel.map((f) => f.count)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(overview.body.invoices).toMatchObject({ invoiced: 47200, collected: 47200, outstanding: 0 });
    expect(overview.body.quotes.acceptanceRate).toBe(1);
  });

  it('revises rejected quotations as new versions with the same number', async () => {
    const admin = await setupOrg();
    const q = await http().post('/api/v1/quotes').set(admin.auth).send({ customer: { name: 'Walk-in' }, items: [{ name: 'Service', unitPrice: 1000 }] });
    await http().post(`/api/v1/quotes/${q.body.id}/send`).set(admin.auth).send({ email: false });
    const rejected = await http().post(`/api/v1/quotes/${q.body.id}/reject`).set(admin.auth).send({ reason: 'Too costly' });
    expect(rejected.body).toMatchObject({ status: 'rejected', rejectionReason: 'Too costly' });
    const rev = await http().post(`/api/v1/quotes/${q.body.id}/revise`).set(admin.auth);
    expect(rev.body).toMatchObject({ number: q.body.number, version: 2, status: 'draft', previousVersionId: q.body.id });
    expect(rev.body.publicToken).not.toBe(q.body.publicToken);
    const detail = await http().get(`/api/v1/quotes/${rev.body.id}`).set(admin.auth);
    expect(detail.body.versions.map((v) => v.version)).toEqual([2, 1]);
    const list = await http().get('/api/v1/quotes').set(admin.auth);
    expect(list.body.items.map((i) => i.version)).toEqual([2]);
    expect((await http().post(`/api/v1/quotes/${rev.body.id}/invoice`).set(admin.auth)).status).toBe(409);
    expect((await http().delete(`/api/v1/quotes/${rev.body.id}`).set(admin.auth)).status).toBe(204);
  });

  it('only numbers invoices when issued and supports direct invoices, void and payment removal', async () => {
    const admin = await setupOrg();
    const body = { customer: { name: 'Direct Customer', state: 'Karnataka' }, items: [{ name: 'Goods', unitPrice: 100, quantity: 10 }] };
    const draft1 = await http().post('/api/v1/invoices').set(admin.auth).send(body);
    const draft2 = await http().post('/api/v1/invoices').set(admin.auth).send(body);
    expect(draft1.body.appliedTaxMode).toBe('inter');
    expect(draft1.body.totals).toMatchObject({ igst: 180, total: 1180 });
    const second = await http().post(`/api/v1/invoices/${draft2.body.id}/send`).set(admin.auth).send({ email: false });
    expect(second.body.invoice.number).toBe(`ST/${FY}/0001`);
    expect((await http().delete(`/api/v1/invoices/${draft1.body.id}`).set(admin.auth)).status).toBe(204);
    const paid = await http().post(`/api/v1/invoices/${draft2.body.id}/payments`).set(admin.auth).send({ amount: 100 });
    const removed = await http().delete(`/api/v1/invoices/${draft2.body.id}/payments/${paid.body.payments[0].id}`).set(admin.auth);
    expect(removed.body).toMatchObject({ status: 'issued', amountPaid: 0, balanceDue: 1180 });
    const voided = await http().post(`/api/v1/invoices/${draft2.body.id}/void`).set(admin.auth).send({ reason: 'Duplicate' });
    expect(voided.body).toMatchObject({ status: 'void', balanceDue: 0 });
    expect((await http().post(`/api/v1/invoices/${draft2.body.id}/payments`).set(admin.auth).send({ amount: 1 })).status).toBe(409);
  });

  it('expires quotations and flags overdue invoices', async () => {
    const admin = await setupOrg();
    const q = await http().post('/api/v1/quotes').set(admin.auth).send({ customer: { name: 'X' }, items: [{ name: 'A', unitPrice: 10 }] });
    await http().post(`/api/v1/quotes/${q.body.id}/send`).set(admin.auth).send({ email: false });
    await Quote.updateOne({ _id: q.body.id }, { validUntil: new Date(Date.now() - 1000) });
    expect(await expireQuotes()).toBe(1);
    expect((await Quote.findById(q.body.id)).status).toBe('expired');
    const page = await http().get(`/api/v1/public/quotes/${q.body.publicToken}`);
    expect(page.text).not.toContain('Accept quotation');

    const inv = await http().post('/api/v1/invoices').set(admin.auth).send({ customer: { name: 'Y' }, items: [{ name: 'A', unitPrice: 10 }], dueDate: '2020-01-01' });
    await http().post(`/api/v1/invoices/${inv.body.id}/issue`).set(admin.auth);
    expect((await Invoice.findById(inv.body.id)).status).toBe('overdue');
    await Invoice.updateOne({ _id: inv.body.id }, { status: 'issued' });
    expect(await markOverdueInvoices()).toBe(1);
    expect(await Notification.countDocuments({ type: 'invoice_overdue' })).toBe(1);
    const overview = await http().get('/api/v1/sales/overview').set(admin.auth);
    expect(overview.body.invoices.overdueCount).toBe(1);
    expect(overview.body.overdue[0].customer.name).toBe('Y');
  });

  it('enforces permissions, tenancy and validation', async () => {
    const admin = await setupOrg();
    const agent = await addUser(admin, { role: 'agent' });
    const other = await registerOrg('Other Org');
    const inv = await http().post('/api/v1/invoices').set(agent.auth).send({ customer: { name: 'Z' }, items: [{ name: 'A', unitPrice: 10 }] });
    expect(inv.status).toBe(201);
    expect((await http().post(`/api/v1/invoices/${inv.body.id}/issue`).set(agent.auth)).status).toBe(403);
    expect((await http().get(`/api/v1/invoices/${inv.body.id}`).set(other.auth)).status).toBe(404);
    expect((await http().post('/api/v1/quotes').set(admin.auth).send({ items: [] })).status).toBe(400);
    expect((await http().post('/api/v1/quotes').set(admin.auth).send({ items: [{ unitPrice: 5 }] })).status).toBe(400);
    expect((await http().post('/api/v1/quotes').set(other.auth).send({ dealId: '0123456789abcdef01234567', items: [{ name: 'A' }] })).status).toBe(404);
    expect((await http().get('/api/v1/public/quotes/not-a-real-token')).status).toBe(404);
    // Totals preview for the editor
    const calc = await http().post('/api/v1/sales/calculate').set(admin.auth).send({ items: [{ name: 'A', unitPrice: 100 }], customer: { state: 'Maharashtra' } });
    expect(calc.body.totals).toMatchObject({ taxTotal: 18, cgst: 9, total: 118 });
  });
});
