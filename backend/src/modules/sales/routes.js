import crypto from 'node:crypto';
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  Invoice, INVOICE_STATUSES, Organization, PAYMENT_METHODS, Product, Quote, QUOTE_STATUSES,
} from '../../models/index.js';
import { env } from '../../config/env.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/common.js';
import { audit } from '../../lib/audit.js';
import { crudRouter } from '../crm/crud.js';
import * as sales from './service.js';
import { calculate } from './calc.js';
import { renderDocument } from './render.js';
import { notify } from '../notifications/service.js';

const router = Router();
// Reading needs sales:read; any change needs sales:write
router.use(['/products', '/quotes', '/invoices', '/sales'], (req, res, next) => requirePermission(req.method === 'GET' ? 'sales:read' : 'sales:write')(req, res, next));

router.use('/products', crudRouter(Product, { searchFields: ['name', 'sku', 'hsnSac'], filterFields: ['active'], defaultSort: { name: 1 } }));

// ---------------------------------------------------------------- validation

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const optionalId = objectId.nullable().optional();
const itemSchema = z.object({
  productId: optionalId,
  name: z.string().trim().max(300).optional(),
  description: z.string().max(2000).optional().nullable(),
  hsnSac: z.string().max(20).optional().nullable(),
  unit: z.string().max(20).optional().nullable(),
  quantity: z.coerce.number().min(0).optional(),
  unitPrice: z.coerce.number().min(0).optional(),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  taxRate: z.coerce.number().min(0).max(100).optional(),
}).refine((i) => i.name || i.productId, 'Each item needs a name or a product');
const partySchema = z.object({
  name: z.string().max(200).optional(), company: z.string().max(200).optional(), email: z.string().max(200).optional(),
  phone: z.string().max(40).optional(), gstin: z.string().max(20).optional(), address: z.string().max(1000).optional(),
  state: z.string().max(80).optional(),
}).partial();
const docSchema = z.object({
  title: z.string().max(300).optional(),
  dealId: optionalId,
  contactId: optionalId,
  accountId: optionalId,
  customer: partySchema.optional(),
  items: z.array(itemSchema).max(500).optional(),
  extraDiscount: z.coerce.number().min(0).optional(),
  taxMode: z.enum(['auto', 'intra', 'inter', 'none']).optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().max(5000).optional().nullable(),
  terms: z.string().max(10000).optional().nullable(),
  validUntil: z.coerce.date().optional().nullable(),
  dueDate: z.coerce.date().optional().nullable(),
});
const sendSchema = z.object({ email: z.boolean().optional(), to: z.string().email().optional(), message: z.string().max(2000).optional() });

function listQuery(req, extra = []) {
  const filter = { organizationId: req.orgId };
  for (const k of ['status', 'dealId', 'contactId', 'accountId', ...extra]) if (req.query[k]) filter[k] = req.query[k];
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ number: rx }, { title: rx }, { 'customer.name': rx }, { 'customer.company': rx }];
  }
  return filter;
}

async function page(Model, req, filter, sort) {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const pageNo = Math.max(Number(req.query.page) || 1, 1);
  const [items, total] = await Promise.all([
    Model.find(filter).sort(sort).skip((pageNo - 1) * limit).limit(limit),
    Model.countDocuments(filter),
  ]);
  return { items, total, page: pageNo, limit };
}

const withLink = (kind, doc) => ({ ...doc.toJSON(), publicUrl: sales.publicLink(kind, doc) });

// ---------------------------------------------------------------- overview & settings

router.get('/sales/overview', async (req, res) => {
  res.json(await sales.salesOverview(req.orgId));
});

router.get('/sales/settings', async (req, res) => {
  const org = await Organization.findById(req.orgId).lean();
  res.json(sales.billingOf(org));
});

/** Preview totals without saving (the editor calls this while the user types). */
router.post('/sales/calculate', validate(docSchema), async (req, res) => {
  const org = await Organization.findById(req.orgId).lean();
  const billing = sales.billingOf(org);
  const items = (req.body.items || []).map((i) => ({ ...i, name: i.name || 'Item', taxRate: i.taxRate ?? billing.defaultTaxRate }));
  res.json(calculate({ ...req.body, items, seller: billing, currency: req.body.currency || billing.currency }));
});

// ---------------------------------------------------------------- quotations

router.get('/quotes', async (req, res) => {
  const filter = listQuery(req);
  if (!req.query.status && req.query.includeRevised !== '1') filter.status = { $ne: 'revised' };
  if (req.query.status && !QUOTE_STATUSES.includes(req.query.status)) delete filter.status;
  res.json(await page(Quote, req, filter, { createdAt: -1 }));
});

router.post('/quotes', validate(docSchema), async (req, res) => {
  res.status(201).json(withLink('quotes', await sales.createQuote(req.orgId, req.user, req.body)));
});

router.get('/quotes/:id', async (req, res) => {
  const quote = await sales.getQuote(req.orgId, req.params.id);
  res.json({ ...withLink('quotes', quote), versions: await sales.quoteVersions(req.orgId, quote) });
});

router.patch('/quotes/:id', validate(docSchema), async (req, res) => {
  res.json(withLink('quotes', await sales.updateQuote(req.orgId, req.params.id, req.body)));
});

router.delete('/quotes/:id', async (req, res) => {
  await sales.deleteQuote(req.orgId, req.params.id);
  res.status(204).end();
});

router.post('/quotes/:id/send', validate(sendSchema), async (req, res) => {
  const result = await sales.sendQuote(req.orgId, req.user, req.params.id, req.body);
  res.json({ ...result, quote: withLink('quotes', result.quote) });
});

router.post('/quotes/:id/accept', validate(z.object({ acceptedBy: z.string().max(120).optional() })), async (req, res) => {
  const quote = await sales.acceptQuote(req.orgId, req.params.id, { by: req.body.acceptedBy || req.user.name, userId: req.user._id });
  res.json(withLink('quotes', quote));
});

router.post('/quotes/:id/reject', validate(z.object({ reason: z.string().max(500).optional() })), async (req, res) => {
  res.json(withLink('quotes', await sales.rejectQuote(req.orgId, req.params.id, { reason: req.body.reason, userId: req.user._id })));
});

router.post('/quotes/:id/revise', async (req, res) => {
  res.status(201).json(withLink('quotes', await sales.reviseQuote(req.orgId, req.user, req.params.id)));
});

router.post('/quotes/:id/invoice', async (req, res) => {
  res.status(201).json(withLink('invoices', await sales.invoiceFromQuote(req.orgId, req.user, req.params.id)));
});

// ---------------------------------------------------------------- invoices

router.get('/invoices', async (req, res) => {
  const filter = listQuery(req, ['quoteId']);
  if (req.query.status && !INVOICE_STATUSES.includes(req.query.status)) delete filter.status;
  if (req.query.status === 'unpaid') filter.status = { $in: ['issued', 'partially_paid', 'overdue'] };
  res.json(await page(Invoice, req, filter, { createdAt: -1 }));
});

router.post('/invoices', validate(docSchema), async (req, res) => {
  res.status(201).json(withLink('invoices', await sales.createInvoice(req.orgId, req.user, req.body)));
});

router.get('/invoices/:id', async (req, res) => {
  res.json(withLink('invoices', await sales.getInvoice(req.orgId, req.params.id)));
});

router.patch('/invoices/:id', validate(docSchema), async (req, res) => {
  res.json(withLink('invoices', await sales.updateInvoice(req.orgId, req.params.id, req.body)));
});

router.delete('/invoices/:id', async (req, res) => {
  await sales.deleteInvoice(req.orgId, req.params.id);
  res.status(204).end();
});

router.post('/invoices/:id/issue', requirePermission('billing:manage'), async (req, res) => {
  const invoice = await sales.issueInvoice(req.orgId, req.user, req.params.id);
  await audit(req, 'invoice.issue', { resourceType: 'Invoice', resourceId: invoice._id, details: { number: invoice.number, total: invoice.totals.total } });
  res.json(withLink('invoices', invoice));
});

router.post('/invoices/:id/send', requirePermission('billing:manage'), validate(sendSchema), async (req, res) => {
  const result = await sales.sendInvoice(req.orgId, req.user, req.params.id, req.body);
  res.json({ ...result, invoice: withLink('invoices', result.invoice) });
});

const paymentSchema = z.object({
  amount: z.coerce.number().positive(),
  date: z.coerce.date().optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  reference: z.string().max(200).optional(),
  note: z.string().max(1000).optional(),
});

router.post('/invoices/:id/payments', requirePermission('billing:manage'), validate(paymentSchema), async (req, res) => {
  const invoice = await sales.recordPayment(req.orgId, req.user, req.params.id, req.body);
  await audit(req, 'invoice.payment', { resourceType: 'Invoice', resourceId: invoice._id, details: { amount: req.body.amount, method: req.body.method } });
  res.status(201).json(withLink('invoices', invoice));
});

router.delete('/invoices/:id/payments/:paymentId', requirePermission('billing:manage'), async (req, res) => {
  const invoice = await sales.deletePayment(req.orgId, req.params.id, req.params.paymentId);
  await audit(req, 'invoice.payment_delete', { resourceType: 'Invoice', resourceId: invoice._id, details: { paymentId: req.params.paymentId } });
  res.json(withLink('invoices', invoice));
});

router.post('/invoices/:id/void', requirePermission('billing:manage'), validate(z.object({ reason: z.string().max(500).optional() })), async (req, res) => {
  const invoice = await sales.voidInvoice(req.orgId, req.user, req.params.id, req.body);
  await audit(req, 'invoice.void', { resourceType: 'Invoice', resourceId: invoice._id, details: { reason: req.body.reason } });
  res.json(withLink('invoices', invoice));
});

export default router;

// ---------------------------------------------------------------- public customer links (no login)

export const publicSalesRouter = Router();
const publicLimiter = rateLimit({ windowMs: 60000, limit: env.isTest ? 10000 : 60, standardHeaders: true, legacyHeaders: false });
publicSalesRouter.use('/public', publicLimiter, express.urlencoded({ extended: false, limit: '20kb' }));

const KINDS = { quotes: { Model: Quote, kind: 'quote' }, invoices: { Model: Invoice, kind: 'invoice' } };

function sendPage(res, html, nonce) {
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(html);
}

function notFoundPage(res) {
  res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font-family:sans-serif;padding:40px">This link is invalid or no longer available.</p>');
}

const FLASH = {
  accepted: { tone: 'ok', text: 'Thank you! You have accepted this quotation. We will be in touch shortly.' },
  rejected: { tone: 'info', text: 'You have declined this quotation. Thank you for letting us know.' },
  error: { tone: 'bad', text: 'This quotation can no longer be accepted or declined.' },
};

for (const [path, { Model, kind }] of Object.entries(KINDS)) {
  publicSalesRouter.get(`/public/${path}/:token`, async (req, res) => {
    const doc = await Model.findOne({ publicToken: String(req.params.token) });
    if (!doc) return notFoundPage(res);
    const print = req.query.print === '1';
    // Staff open the link with ?preview=1 or ?print=1, which must not count as the customer viewing it
    if (!print && req.query.preview !== '1' && !doc.viewedAt && doc.status !== 'draft') {
      doc.viewedAt = new Date();
      await doc.save();
      // First open by the customer: a good moment for the owner to follow up.
      if (doc.ownerId) {
        await notify(doc.organizationId, doc.ownerId, {
          type: `${kind}_viewed`,
          title: `👀 ${doc.customer?.company || doc.customer?.name || 'Customer'} opened ${kind === 'quote' ? 'quotation' : 'invoice'} ${doc.number}`,
          body: 'Good time to follow up.',
          data: { [`${kind}Id`]: String(doc._id), ...(doc.dealId ? { dealId: String(doc.dealId) } : {}) },
        }).catch(() => null);
      }
    }
    const org = await Organization.findById(doc.organizationId).lean();
    const nonce = crypto.randomBytes(16).toString('base64');
    return sendPage(res, renderDocument({
      kind, doc: doc.toObject(), billing: sales.billingOf(org), token: doc.publicToken, print, flash: FLASH[req.query.done], nonce,
    }), nonce);
  });
}

publicSalesRouter.post('/public/quotes/:token/:action', async (req, res) => {
  const { token, action } = req.params;
  if (!['accept', 'reject'].includes(action)) return notFoundPage(res);
  const quote = await Quote.findOne({ publicToken: String(token) });
  if (!quote) return notFoundPage(res);
  try {
    if (action === 'accept') {
      const name = String(req.body?.name || '').trim().slice(0, 120);
      if (!name) return res.redirect(303, `../${token}?done=error`);
      await sales.acceptQuote(quote.organizationId, quote._id, { by: name, viaPortal: true });
    } else {
      await sales.rejectQuote(quote.organizationId, quote._id, { reason: String(req.body?.reason || '').slice(0, 500), by: 'customer', viaPortal: true });
    }
    await audit(null, `quote.${action}ed_by_customer`, { orgId: quote.organizationId, resourceType: 'Quote', resourceId: quote._id, details: { ip: req.ip } });
    return res.redirect(303, `../${token}?done=${action}ed`);
  } catch {
    return res.redirect(303, `../${token}?done=error`);
  }
});
