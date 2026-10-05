import {
  Account, Contact, Counter, DEFAULT_BILLING, Deal, Invoice, Lead, Organization, Product, Quote,
} from '../../models/index.js';
import { env } from '../../config/env.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { logActivity } from '../timeline/service.js';
import { notify } from '../notifications/service.js';
import { sendMessage } from '../messaging/service.js';
import { calculate, financialYear, formatMoney, r2 } from './calc.js';

const DAY = 86400000;

export function billingOf(org) {
  const saved = org?.settings?.billing || {};
  const defaults = DEFAULT_BILLING();
  return { ...defaults, ...saved, bank: { ...defaults.bank, ...(saved.bank || {}) } };
}

async function loadBilling(orgId) {
  const org = await Organization.findById(orgId).lean();
  if (!org) throw notFound('Organization');
  return { org, billing: billingOf(org) };
}

/** Next gap-free number for the financial year, e.g. INV/2026-27/0001. */
export async function nextNumber(orgId, kind, prefix, date = new Date()) {
  const fy = financialYear(date);
  const counter = await Counter.findOneAndUpdate(
    { organizationId: orgId, key: `${kind}:${fy}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return `${prefix}/${fy}/${String(counter.seq).padStart(4, '0')}`;
}

export const publicLink = (kind, doc) => `${env.publicBaseUrl}/api/v1/public/${kind}/${doc.publicToken}`;

const relatedOf = (doc) => ({ dealId: doc.dealId, contactId: doc.contactId, accountId: doc.accountId });

/** Fills customer details and links from the deal / contact / account so the user doesn't retype them. */
async function resolveParty(orgId, { dealId, contactId, accountId, customer = {} }) {
  const deal = dealId ? await Deal.findOne({ _id: dealId, organizationId: orgId }).lean() : null;
  if (dealId && !deal) throw notFound('Deal');
  const cId = contactId || deal?.contactId;
  const contact = cId ? await Contact.findOne({ _id: cId, organizationId: orgId }).lean() : null;
  if (contactId && !contact) throw notFound('Contact');
  const aId = accountId || deal?.accountId || contact?.accountId;
  const account = aId ? await Account.findOne({ _id: aId, organizationId: orgId }).lean() : null;
  if (accountId && !account) throw notFound('Account');
  const contactName = contact ? `${contact.firstName} ${contact.lastName || ''}`.trim() : undefined;
  const filled = {
    name: contactName || account?.name,
    company: account?.name || contact?.company,
    email: contact?.email,
    phone: contact?.phone || account?.phone,
  };
  for (const [k, v] of Object.entries(customer || {})) if (v !== undefined && v !== null && v !== '') filled[k] = v;
  return { deal, dealId: deal?._id, contactId: contact?._id, accountId: account?._id, customer: filled };
}

/** Fills line items from the product catalog when only a productId is given. */
async function resolveItems(orgId, items = [], billing) {
  const ids = items.map((i) => i.productId).filter(Boolean);
  const products = ids.length ? await Product.find({ organizationId: orgId, _id: { $in: ids } }).lean() : [];
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return items.map((i) => {
    const p = i.productId ? byId.get(String(i.productId)) : null;
    if (i.productId && !p) throw notFound('Product');
    return {
      productId: p?._id,
      name: i.name || p?.name,
      description: i.description ?? p?.description,
      hsnSac: i.hsnSac ?? p?.hsnSac,
      unit: i.unit ?? p?.unit,
      quantity: i.quantity ?? 1,
      unitPrice: i.unitPrice ?? p?.unitPrice ?? 0,
      discountPercent: i.discountPercent ?? 0,
      taxRate: i.taxRate ?? p?.taxRate ?? billing.defaultTaxRate,
    };
  });
}

function applyTotals(doc, billing) {
  const result = calculate({
    items: doc.items, extraDiscount: doc.extraDiscount, taxMode: doc.taxMode, seller: billing, customer: doc.customer, currency: doc.currency,
  });
  doc.items = result.items;
  doc.totals = result.totals;
  doc.appliedTaxMode = result.appliedTaxMode;
}

const EDITABLE = ['title', 'items', 'extraDiscount', 'taxMode', 'notes', 'terms', 'currency'];

async function applyInput(orgId, doc, input, billing) {
  for (const k of EDITABLE) if (input[k] !== undefined && k !== 'items') doc[k] = input[k];
  if (input.items) doc.items = await resolveItems(orgId, input.items, billing);
  if (input.dealId !== undefined || input.contactId !== undefined || input.accountId !== undefined || input.customer) {
    const party = await resolveParty(orgId, {
      dealId: input.dealId === undefined ? doc.dealId : input.dealId,
      contactId: input.contactId === undefined ? doc.contactId : input.contactId,
      accountId: input.accountId === undefined ? doc.accountId : input.accountId,
      customer: { ...(doc.customer?.toObject?.() || doc.customer || {}), ...(input.customer || {}) },
    });
    Object.assign(doc, { dealId: party.dealId, contactId: party.contactId, accountId: party.accountId, customer: party.customer });
  }
  applyTotals(doc, billing);
}

async function setDealStage(orgId, dealId, stage, userId, extra = {}) {
  if (!dealId) return;
  const deal = await Deal.findOne({ _id: dealId, organizationId: orgId });
  if (!deal) return;
  const from = deal.stage;
  Object.assign(deal, extra);
  if (stage && from !== stage) deal.stage = stage;
  deal.lastActivityAt = new Date();
  await deal.save();
  if (stage && from !== stage) {
    await logActivity(orgId, {
      type: 'stage_changed', title: `Deal moved from ${from} to ${stage}`, userId,
      related: { dealId: deal._id, contactId: deal.contactId, accountId: deal.accountId }, data: { from, to: stage },
    });
  }
}

// ---------------------------------------------------------------- Quotations

export async function createQuote(orgId, user, input) {
  const { billing } = await loadBilling(orgId);
  if (!input.items?.length) throw badRequest('Add at least one line item');
  const quote = new Quote({
    organizationId: orgId,
    number: await nextNumber(orgId, 'quote', billing.quotePrefix),
    ownerId: user._id,
    currency: billing.currency,
    notes: billing.defaultNotes,
    terms: billing.defaultTerms,
    issueDate: new Date(),
    validUntil: input.validUntil || new Date(Date.now() + billing.quoteValidityDays * DAY),
  });
  await applyInput(orgId, quote, input, billing);
  if (!quote.title) quote.title = quote.customer?.company ? `Quotation for ${quote.customer.company}` : 'Quotation';
  await quote.save();
  await logActivity(orgId, {
    type: 'quote_created', title: `Quotation ${quote.number} created (${formatMoney(quote.totals.total, quote.currency)})`,
    related: relatedOf(quote), refType: 'Quote', refId: quote._id, userId: user._id,
  });
  return quote;
}

export async function getQuote(orgId, id) {
  const quote = await Quote.findOne({ _id: id, organizationId: orgId });
  if (!quote) throw notFound('Quotation');
  return quote;
}

export async function updateQuote(orgId, id, input) {
  const quote = await getQuote(orgId, id);
  if (quote.status !== 'draft') throw conflict('Only draft quotations can be edited. Create a revision instead.');
  const { billing } = await loadBilling(orgId);
  await applyInput(orgId, quote, input, billing);
  if (input.validUntil !== undefined) quote.validUntil = input.validUntil;
  if (!quote.items.length) throw badRequest('Add at least one line item');
  await quote.save();
  return quote;
}

export async function deleteQuote(orgId, id) {
  const quote = await getQuote(orgId, id);
  if (quote.status !== 'draft') throw conflict('Only draft quotations can be deleted');
  await quote.deleteOne();
}

/** Emails a document link when an email provider is set up. Failure to email never blocks sending. */
async function emailDocument(orgId, user, { to, subject, body, related }) {
  if (!to) return { emailed: false, emailError: 'The customer has no email address' };
  try {
    await sendMessage(orgId, user, { channel: 'email', to, subject, body, related });
    return { emailed: true };
  } catch (err) {
    return { emailed: false, emailError: err.message };
  }
}

export async function sendQuote(orgId, user, id, { email = true, to, message } = {}) {
  const quote = await getQuote(orgId, id);
  if (!['draft', 'sent'].includes(quote.status)) throw conflict(`A ${quote.status} quotation cannot be sent`);
  if (quote.validUntil && quote.validUntil < new Date()) throw conflict('The quotation has expired; update the validity date or create a revision');
  const { billing } = await loadBilling(orgId);
  const link = publicLink('quotes', quote);
  const firstSend = quote.status === 'draft';
  quote.status = 'sent';
  quote.sentAt = new Date();
  await quote.save();
  let delivery = { emailed: false };
  if (email) {
    const seller = billing.companyName || 'us';
    delivery = await emailDocument(orgId, user, {
      to: to || quote.customer?.email,
      subject: `Quotation ${quote.number}${quote.version > 1 ? ` (rev ${quote.version})` : ''} from ${seller}`,
      body: `${message ? `${message}\n\n` : ''}Dear ${quote.customer?.name || 'Customer'},\n\nPlease find our quotation ${quote.number} for ${formatMoney(quote.totals.total, quote.currency)}.\nView, download or accept it here: ${link}\n\nRegards,\n${seller}`,
      related: relatedOf(quote),
    });
  }
  if (firstSend) {
    await logActivity(orgId, {
      type: 'quote_sent', title: `Quotation ${quote.number} sent to customer`, related: relatedOf(quote), refType: 'Quote', refId: quote._id, userId: user._id,
    });
    const deal = quote.dealId ? await Deal.findOne({ _id: quote.dealId, organizationId: orgId }).lean() : null;
    if (deal && ['prospecting', 'qualification'].includes(deal.stage)) await setDealStage(orgId, deal._id, 'proposal', user._id);
  }
  return { quote, link, ...delivery };
}

/** Marks a quotation accepted (by the client through the link, or by a user). The deal becomes won. */
export async function acceptQuote(orgId, id, { by, userId, viaPortal = false } = {}) {
  const quote = await getQuote(orgId, id);
  if (quote.status === 'accepted') return quote;
  if (quote.status !== 'sent') throw conflict(`A ${quote.status} quotation cannot be accepted`);
  if (quote.validUntil && quote.validUntil < new Date()) throw conflict('This quotation has expired');
  quote.status = 'accepted';
  quote.acceptedAt = new Date();
  quote.acceptedBy = by;
  await quote.save();
  await logActivity(orgId, {
    type: 'quote_accepted', title: `Quotation ${quote.number} accepted${by ? ` by ${by}` : ''}${viaPortal ? ' online' : ''}`,
    related: relatedOf(quote), refType: 'Quote', refId: quote._id, userId,
  });
  await setDealStage(orgId, quote.dealId, 'won', userId, { value: quote.totals.total, probability: 100, currency: quote.currency });
  if (viaPortal && quote.ownerId) {
    await notify(orgId, quote.ownerId, {
      type: 'quote_accepted', title: `Quotation ${quote.number} accepted`, body: `${by || 'The customer'} accepted ${formatMoney(quote.totals.total, quote.currency)}`,
      data: { quoteId: String(quote._id) },
    });
  }
  return quote;
}

export async function rejectQuote(orgId, id, { reason, by, userId, viaPortal = false } = {}) {
  const quote = await getQuote(orgId, id);
  if (quote.status !== 'sent') throw conflict(`A ${quote.status} quotation cannot be rejected`);
  quote.status = 'rejected';
  quote.rejectedAt = new Date();
  quote.rejectionReason = reason;
  await quote.save();
  await logActivity(orgId, {
    type: 'quote_rejected', title: `Quotation ${quote.number} rejected${by ? ` by ${by}` : ''}${reason ? `: ${reason}` : ''}`,
    related: relatedOf(quote), refType: 'Quote', refId: quote._id, userId,
  });
  if (viaPortal && quote.ownerId) {
    await notify(orgId, quote.ownerId, {
      type: 'quote_rejected', title: `Quotation ${quote.number} rejected`, body: reason || 'No reason given', data: { quoteId: String(quote._id) },
    });
  }
  return quote;
}

/** Copies a sent / rejected / expired quotation into a new draft version with the same number. */
export async function reviseQuote(orgId, user, id) {
  const old = await getQuote(orgId, id);
  if (!['sent', 'rejected', 'expired'].includes(old.status)) throw conflict(`A ${old.status} quotation cannot be revised`);
  const { billing } = await loadBilling(orgId);
  const data = old.toObject();
  for (const k of ['_id', 'id', 'createdAt', 'updatedAt', 'publicToken', 'sentAt', 'viewedAt', 'acceptedAt', 'acceptedBy', 'rejectedAt', 'rejectionReason', 'invoiceId']) delete data[k];
  const latest = await Quote.findOne({ organizationId: orgId, number: old.number }).sort({ version: -1 }).select('version').lean();
  const revision = new Quote({
    ...data, status: 'draft', version: latest.version + 1, previousVersionId: old._id, ownerId: user._id,
    issueDate: new Date(), validUntil: new Date(Date.now() + billing.quoteValidityDays * DAY),
  });
  await revision.save();
  old.status = 'revised';
  await old.save();
  return revision;
}

export async function quoteVersions(orgId, quote) {
  return Quote.find({ organizationId: orgId, number: quote.number }).sort({ version: -1 }).select('number version status totals createdAt').lean();
}

// ---------------------------------------------------------------- Invoices

export async function getInvoice(orgId, id) {
  const invoice = await Invoice.findOne({ _id: id, organizationId: orgId });
  if (!invoice) throw notFound('Invoice');
  return invoice;
}

export async function createInvoice(orgId, user, input) {
  const { billing } = await loadBilling(orgId);
  if (!input.items?.length) throw badRequest('Add at least one line item');
  const invoice = new Invoice({
    organizationId: orgId, ownerId: user._id, currency: billing.currency, notes: billing.defaultNotes, terms: billing.defaultTerms,
  });
  await applyInput(orgId, invoice, input, billing);
  if (input.dueDate) invoice.dueDate = input.dueDate;
  if (!invoice.title) invoice.title = 'Tax Invoice';
  invoice.balanceDue = invoice.totals.total;
  await invoice.save();
  return invoice;
}

/** Turns an accepted quotation into a draft invoice with the same items and prices. */
export async function invoiceFromQuote(orgId, user, quoteId) {
  const quote = await getQuote(orgId, quoteId);
  if (quote.status !== 'accepted') throw conflict('Only accepted quotations can be invoiced');
  if (quote.invoiceId) {
    const existing = await Invoice.findOne({ _id: quote.invoiceId, organizationId: orgId, status: { $ne: 'void' } });
    if (existing) throw new AppError(409, 'This quotation already has an invoice', 'CONFLICT', { invoiceId: String(existing._id) });
  }
  const q = quote.toObject();
  const invoice = new Invoice({
    organizationId: orgId, ownerId: user._id, quoteId: quote._id, title: 'Tax Invoice',
    dealId: q.dealId, contactId: q.contactId, accountId: q.accountId, customer: q.customer, currency: q.currency,
    taxMode: q.taxMode, items: q.items, extraDiscount: q.extraDiscount, notes: q.notes, terms: q.terms,
  });
  const { billing } = await loadBilling(orgId);
  applyTotals(invoice, billing);
  invoice.balanceDue = invoice.totals.total;
  await invoice.save();
  quote.invoiceId = invoice._id;
  await quote.save();
  return invoice;
}

export async function updateInvoice(orgId, id, input) {
  const invoice = await getInvoice(orgId, id);
  if (invoice.status !== 'draft') throw conflict('Issued invoices cannot be edited; void it and create a new one');
  const { billing } = await loadBilling(orgId);
  await applyInput(orgId, invoice, input, billing);
  if (input.dueDate !== undefined) invoice.dueDate = input.dueDate;
  if (!invoice.items.length) throw badRequest('Add at least one line item');
  invoice.balanceDue = invoice.totals.total;
  await invoice.save();
  return invoice;
}

export async function deleteInvoice(orgId, id) {
  const invoice = await getInvoice(orgId, id);
  if (invoice.status !== 'draft') throw conflict('Only draft invoices can be deleted; void issued invoices instead');
  await invoice.deleteOne();
  if (invoice.quoteId) await Quote.updateOne({ _id: invoice.quoteId, organizationId: orgId }, { $unset: { invoiceId: 1 } });
}

function paymentStatus(invoice, now = new Date()) {
  if (invoice.balanceDue <= 0.005) return 'paid';
  if (invoice.dueDate && invoice.dueDate < now) return 'overdue';
  return invoice.amountPaid > 0 ? 'partially_paid' : 'issued';
}

/** Assigns the invoice number (only now, so numbers stay consecutive) and fixes the issue and due dates. */
export async function issueInvoice(orgId, user, id) {
  const invoice = await getInvoice(orgId, id);
  if (invoice.status !== 'draft') return invoice;
  if (!invoice.customer?.name && !invoice.customer?.company) throw badRequest('Add the customer name before issuing');
  const { billing } = await loadBilling(orgId);
  const now = new Date();
  invoice.number = await nextNumber(orgId, 'invoice', billing.invoicePrefix, now);
  invoice.issueDate = now;
  if (!invoice.dueDate) invoice.dueDate = new Date(now.getTime() + billing.paymentTermsDays * DAY);
  invoice.amountPaid = 0;
  invoice.balanceDue = invoice.totals.total;
  invoice.status = paymentStatus(invoice, now);
  await invoice.save();
  await logActivity(orgId, {
    type: 'invoice_issued', title: `Invoice ${invoice.number} issued (${formatMoney(invoice.totals.total, invoice.currency)})`,
    related: relatedOf(invoice), refType: 'Invoice', refId: invoice._id, userId: user._id,
  });
  return invoice;
}

export async function sendInvoice(orgId, user, id, { email = true, to, message } = {}) {
  let invoice = await getInvoice(orgId, id);
  if (invoice.status === 'void') throw conflict('A void invoice cannot be sent');
  if (invoice.status === 'draft') invoice = await issueInvoice(orgId, user, id);
  const { billing } = await loadBilling(orgId);
  const link = publicLink('invoices', invoice);
  invoice.sentAt = new Date();
  await invoice.save();
  let delivery = { emailed: false };
  if (email) {
    const seller = billing.companyName || 'us';
    delivery = await emailDocument(orgId, user, {
      to: to || invoice.customer?.email,
      subject: `Invoice ${invoice.number} from ${seller}`,
      body: `${message ? `${message}\n\n` : ''}Dear ${invoice.customer?.name || 'Customer'},\n\nInvoice ${invoice.number} for ${formatMoney(invoice.totals.total, invoice.currency)} is due on ${invoice.dueDate.toDateString()}.\nView and download it here: ${link}\n\nRegards,\n${seller}`,
      related: relatedOf(invoice),
    });
  }
  return { invoice, link, ...delivery };
}

export async function recordPayment(orgId, user, id, { amount, date, method, reference, note }) {
  const invoice = await getInvoice(orgId, id);
  if (['draft', 'void'].includes(invoice.status)) throw conflict(`Payments cannot be recorded on a ${invoice.status} invoice`);
  const value = r2(amount);
  if (!(value > 0)) throw badRequest('Amount must be more than zero');
  if (value > r2(invoice.balanceDue) + 0.005) throw badRequest(`Amount is more than the balance due (${invoice.balanceDue})`);
  invoice.payments.push({ amount: value, date: date || new Date(), method, reference, note, recordedBy: user._id });
  invoice.amountPaid = r2(invoice.amountPaid + value);
  invoice.balanceDue = r2(invoice.totals.total - invoice.amountPaid);
  invoice.status = paymentStatus(invoice);
  if (invoice.status === 'paid') invoice.paidAt = new Date();
  await invoice.save();
  await logActivity(orgId, {
    type: 'payment_received',
    title: `Payment of ${formatMoney(value, invoice.currency)} received for ${invoice.number}${invoice.status === 'paid' ? ' — fully paid' : ''}`,
    related: relatedOf(invoice), refType: 'Invoice', refId: invoice._id, userId: user._id, data: { method, reference },
  });
  return invoice;
}

export async function deletePayment(orgId, id, paymentId) {
  const invoice = await getInvoice(orgId, id);
  const payment = invoice.payments.id(paymentId);
  if (!payment) throw notFound('Payment');
  payment.deleteOne();
  invoice.amountPaid = r2(invoice.payments.reduce((s, p) => s + p.amount, 0));
  invoice.balanceDue = r2(invoice.totals.total - invoice.amountPaid);
  invoice.status = paymentStatus(invoice);
  invoice.paidAt = invoice.status === 'paid' ? invoice.paidAt : undefined;
  await invoice.save();
  return invoice;
}

export async function voidInvoice(orgId, user, id, { reason } = {}) {
  const invoice = await getInvoice(orgId, id);
  if (invoice.status === 'draft') throw conflict('Delete draft invoices instead of voiding them');
  if (invoice.status === 'void') return invoice;
  if (invoice.amountPaid > 0) throw conflict('Remove recorded payments (or refund them) before voiding this invoice');
  invoice.status = 'void';
  invoice.voidedAt = new Date();
  invoice.voidReason = reason;
  invoice.balanceDue = 0;
  await invoice.save();
  await logActivity(orgId, {
    type: 'invoice_void', title: `Invoice ${invoice.number} voided${reason ? `: ${reason}` : ''}`,
    related: relatedOf(invoice), refType: 'Invoice', refId: invoice._id, userId: user._id,
  });
  return invoice;
}

// ---------------------------------------------------------------- Jobs

export async function expireQuotes(now = new Date()) {
  const res = await Quote.updateMany({ status: 'sent', validUntil: { $lt: now } }, { $set: { status: 'expired' } });
  return res.modifiedCount;
}

export async function markOverdueInvoices(now = new Date()) {
  const due = await Invoice.find({ status: { $in: ['issued', 'partially_paid'] }, dueDate: { $lt: now } });
  for (const inv of due) {
    inv.status = 'overdue';
    await inv.save();
    if (inv.ownerId) {
      await notify(inv.organizationId, inv.ownerId, {
        type: 'invoice_overdue', title: `Invoice ${inv.number} is overdue`, body: `${formatMoney(inv.balanceDue, inv.currency)} due from ${inv.customer?.company || inv.customer?.name || 'customer'}`,
        data: { invoiceId: String(inv._id) },
      });
    }
  }
  return due.length;
}

// ---------------------------------------------------------------- Overview

/** Lead → deal → quotation → invoice → payment funnel with money totals. */
export async function salesOverview(orgId) {
  const org = { organizationId: orgId };
  const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const [leadRows, dealRows, quoteRows, invoiceRows, quotedDeals, invoicedDeals, overdue] = await Promise.all([
    Lead.aggregate([{ $match: org }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Deal.aggregate([{ $match: org }, { $group: { _id: '$stage', count: { $sum: 1 }, value: { $sum: '$value' } } }]),
    Quote.aggregate([{ $match: { ...org, status: { $ne: 'revised' } } }, { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$totals.total' } } }]),
    Invoice.aggregate([{ $match: { ...org, status: { $nin: ['draft', 'void'] } } }, {
      $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$totals.total' }, paid: { $sum: '$amountPaid' }, due: { $sum: '$balanceDue' } },
    }]),
    Quote.distinct('dealId', { ...org, dealId: { $ne: null } }),
    Invoice.distinct('dealId', { ...org, dealId: { $ne: null }, status: { $nin: ['draft', 'void'] } }),
    Invoice.find({ ...org, status: 'overdue' }).sort({ dueDate: 1 }).limit(10).select('number customer balanceDue dueDate currency').lean(),
  ]);
  const by = (rows) => Object.fromEntries(rows.map((r) => [r._id, r]));
  const leads = by(leadRows);
  const deals = by(dealRows);
  const quotes = by(quoteRows);
  const invoices = by(invoiceRows);
  const totalLeads = sum(leadRows, 'count');
  const decided = (quotes.accepted?.count || 0) + (quotes.rejected?.count || 0) + (quotes.expired?.count || 0);
  const paidDeals = await Invoice.distinct('dealId', { ...org, dealId: { $ne: null }, status: 'paid' });
  return {
    funnel: [
      { key: 'leads', label: 'Leads', count: totalLeads },
      { key: 'converted', label: 'Converted', count: leads.converted?.count || 0 },
      { key: 'deals', label: 'Deals', count: sum(dealRows, 'count') },
      { key: 'quoted', label: 'Quoted', count: quotedDeals.length },
      { key: 'won', label: 'Won', count: deals.won?.count || 0 },
      { key: 'invoiced', label: 'Invoiced', count: invoicedDeals.length },
      { key: 'paid', label: 'Paid', count: paidDeals.length },
    ],
    leads: { total: totalLeads, byStatus: Object.fromEntries(leadRows.map((r) => [r._id, r.count])), conversionRate: totalLeads ? r2((leads.converted?.count || 0) / totalLeads) : 0 },
    deals: {
      open: sum(dealRows.filter((r) => !['won', 'lost'].includes(r._id)), 'count'),
      openValue: sum(dealRows.filter((r) => !['won', 'lost'].includes(r._id)), 'value'),
      won: deals.won?.count || 0,
      wonValue: deals.won?.value || 0,
      lost: deals.lost?.count || 0,
    },
    quotes: {
      byStatus: Object.fromEntries(quoteRows.map((r) => [r._id, { count: r.count, value: r.value }])),
      acceptanceRate: decided ? r2((quotes.accepted?.count || 0) / decided) : 0,
      pendingValue: quotes.sent?.value || 0,
    },
    invoices: {
      byStatus: Object.fromEntries(invoiceRows.map((r) => [r._id, { count: r.count, value: r.value }])),
      invoiced: r2(sum(invoiceRows, 'value')),
      collected: r2(sum(invoiceRows, 'paid')),
      outstanding: r2(sum(invoiceRows, 'due')),
      overdueAmount: r2(invoices.overdue?.due || 0),
      overdueCount: invoices.overdue?.count || 0,
    },
    overdue,
  };
}
