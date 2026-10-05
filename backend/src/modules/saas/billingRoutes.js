import { Router } from 'express';
import { z } from 'zod';
import {
  BillingInvoice, CompanySubscription, Payment, SubscriptionPlan, WebhookEvent,
} from '../../models/index.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/common.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import { MODULES } from '../../lib/modules.js';
import { findPlan } from './plans.js';
import { getTenantContext, invalidateTenant } from './tenant.js';
import { usageSummary } from './usage.js';
import { availableProviders, getPaymentProvider } from './payments/providers.js';
import {
  applyPaymentEvents, createCheckout, quote, verifyCheckout,
} from './payments/service.js';

const router = Router();
export const publicBillingRouter = Router();

const publicPlan = (p) => ({
  id: String(p._id), code: p.code, name: p.name, description: p.description, currency: p.currency,
  priceMonthly: p.priceMonthly, priceYearly: p.priceYearly, limits: p.limits, modules: p.modules, isCustom: p.isCustom, sortOrder: p.sortOrder,
});

/** Plan catalog for the pricing / registration page. */
publicBillingRouter.get('/public/plans', async (_req, res) => {
  const plans = await SubscriptionPlan.find({ active: true, isPublic: true }).sort({ sortOrder: 1 }).lean();
  res.json({ items: plans.map(publicPlan), modules: MODULES, providers: availableProviders() });
});

/**
 * Provider webhooks (public, signature verified, idempotent by provider event id).
 * Payment state changes from here are the source of truth; the browser redirect is only a hint.
 */
publicBillingRouter.post('/webhooks/payments/:provider', async (req, res) => {
  const provider = getPaymentProvider(req.params.provider);
  if (!provider) throw notFound('Payment provider');
  if (!provider.verifyWebhook({ rawBody: req.rawBody, headers: req.headers })) {
    log.warn('payment.webhook_rejected', { provider: req.params.provider });
    return res.status(401).json({ success: false, message: 'Invalid signature', code: 'INVALID_SIGNATURE', error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } });
  }
  const { eventId, events } = provider.parseWebhook(req.body, req.headers);
  const key = `payment:${provider.name}:${eventId}`;
  try {
    await WebhookEvent.create({ source: `payment:${provider.name}`, key, eventType: req.body?.event || req.body?.type, payload: { type: req.body?.event || req.body?.type } });
  } catch (err) {
    if (err?.code === 11000) return res.json({ received: true, duplicate: true });
    throw err;
  }
  await applyPaymentEvents(provider.name, events);
  await WebhookEvent.updateOne({ key }, { status: events.length ? 'processed' : 'ignored' });
  log.info('payment.webhook', { provider: provider.name, events: events.map((e) => e.type) });
  res.json({ received: true });
});

// ---------------------------------------------------------------- Company billing (authenticated)
router.get('/plans', async (_req, res) => {
  const plans = await SubscriptionPlan.find({ active: true, isPublic: true }).sort({ sortOrder: 1 }).lean();
  res.json({ items: plans.map(publicPlan), modules: MODULES });
});

async function billingOverview(orgId) {
  const [ctx, sub, usage] = await Promise.all([
    getTenantContext(orgId, { fresh: true }),
    CompanySubscription.findOne({ organizationId: orgId }).lean(),
    usageSummary(orgId),
  ]);
  const plan = sub ? await SubscriptionPlan.findById(sub.planId).lean() : null;
  return {
    subscription: ctx.subscription,
    plan: plan ? publicPlan(plan) : null,
    price: plan ? (sub.billingCycle === 'yearly' ? plan.priceYearly : plan.priceMonthly) : 0,
    premium: ctx.premium,
    effectivePlanCode: ctx.effectivePlanCode,
    modules: ctx.modules,
    usage,
    providers: availableProviders(),
  };
}

router.get('/billing', async (req, res) => res.json(await billingOverview(req.orgId)));
router.get('/subscriptions/current', async (req, res) => res.json(await billingOverview(req.orgId)));
router.get('/usage', async (req, res) => res.json(await usageSummary(req.orgId)));

router.get('/billing/invoices', requirePermission('billing:manage'), async (req, res) => {
  res.json({ items: await BillingInvoice.find({ organizationId: req.orgId }).sort({ createdAt: -1 }).limit(100) });
});

router.get('/billing/payments', requirePermission('billing:manage'), async (req, res) => {
  res.json({ items: await Payment.find({ organizationId: req.orgId }).sort({ createdAt: -1 }).limit(100) });
});

const cycle = z.enum(['monthly', 'yearly']);

router.post('/billing/quote', validate(z.object({ planCode: z.string(), billingCycle: cycle, couponCode: z.string().optional() })), async (req, res) => {
  const q = await quote(req.body.planCode, req.body.billingCycle, req.body.couponCode);
  res.json({ plan: publicPlan(q.plan), billingCycle: q.billingCycle, price: q.price, discount: q.discount, total: q.total, currency: q.currency, coupon: q.coupon?.code || null });
});

router.post('/billing/checkout', requirePermission('billing:manage'), validate(z.object({
  planCode: z.string().trim().toUpperCase(),
  billingCycle: cycle,
  provider: z.string().default('razorpay'),
  couponCode: z.string().trim().optional(),
})), async (req, res) => {
  res.status(201).json(await createCheckout(req, req.body));
});

router.post('/billing/verify', requirePermission('billing:manage'), validate(z.object({ paymentId: z.string().regex(/^[a-f0-9]{24}$/i) }).passthrough()), async (req, res) => {
  const payment = await verifyCheckout(req, req.body.paymentId, req.body);
  res.json({ payment, billing: await billingOverview(req.orgId) });
});

/** Switch to a free plan immediately (paid plans go through checkout). Data above the new limits is kept. */
router.post('/billing/change-plan', requirePermission('billing:manage'), validate(z.object({ planCode: z.string().trim().toUpperCase() })), async (req, res) => {
  const plan = await findPlan(req.body.planCode);
  if (!plan || !plan.active) throw badRequest('Unknown plan');
  if (plan.priceMonthly > 0 || plan.priceYearly > 0 || plan.isCustom) throw badRequest('Paid plans are activated through checkout');
  const before = await CompanySubscription.findOne({ organizationId: req.orgId }).lean();
  await CompanySubscription.findOneAndUpdate(
    { organizationId: req.orgId },
    { $set: { planId: plan._id, planCode: plan.code, status: 'active', billingCycle: 'none', startDate: new Date(), endDate: null, autoRenew: false, cancelAtPeriodEnd: false } },
    { upsert: true },
  );
  invalidateTenant(req.orgId);
  await audit(req, 'subscription.downgrade', { module: 'billing', details: { from: before?.planCode, to: plan.code } });
  res.json(await billingOverview(req.orgId));
});

/** Cancels at period end: paid modules stay on until the end date, nothing renews afterwards. */
router.post('/billing/cancel', requirePermission('billing:manage'), async (req, res) => {
  const sub = await CompanySubscription.findOne({ organizationId: req.orgId });
  if (!sub || !['active', 'trial', 'past_due'].includes(sub.status)) throw badRequest('There is no active subscription to cancel');
  sub.status = 'cancelled';
  sub.cancelAtPeriodEnd = true;
  sub.autoRenew = false;
  sub.cancelledAt = new Date();
  if (!sub.endDate) sub.endDate = sub.trialEnd || new Date();
  await sub.save();
  invalidateTenant(req.orgId);
  await audit(req, 'subscription.cancelled', { module: 'billing', details: { plan: sub.planCode, endDate: sub.endDate } });
  res.json(await billingOverview(req.orgId));
});

router.post('/billing/resume', requirePermission('billing:manage'), async (req, res) => {
  const sub = await CompanySubscription.findOne({ organizationId: req.orgId });
  if (!sub || sub.status !== 'cancelled' || !sub.endDate || sub.endDate < new Date()) throw badRequest('Nothing to resume; choose a plan instead');
  sub.status = sub.trialEnd && sub.trialEnd >= sub.endDate ? 'trial' : 'active';
  sub.cancelAtPeriodEnd = false;
  sub.autoRenew = sub.status === 'active';
  sub.cancelledAt = null;
  await sub.save();
  invalidateTenant(req.orgId);
  await audit(req, 'subscription.resumed', { module: 'billing' });
  res.json(await billingOverview(req.orgId));
});

export default router;
