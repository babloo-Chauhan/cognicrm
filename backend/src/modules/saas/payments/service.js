import {
  BillingInvoice, CompanySubscription, Coupon, nextPlatformSeq, Payment, SubscriptionPlan,
} from '../../../models/index.js';
import { env } from '../../../config/env.js';
import { audit } from '../../../lib/audit.js';
import { AppError, badRequest, NotConfiguredError } from '../../../lib/errors.js';
import { log } from '../../../lib/logger.js';
import { findPlan } from '../plans.js';
import { invalidateTenant } from '../tenant.js';
import { getPaymentProvider } from './providers.js';

/**
 * PaymentService: provider-neutral billing flow. Business logic only talks to the provider interface,
 * and a subscription is activated only after a server-side verification (client signature check or webhook).
 */

const addPeriod = (from, cycle) => {
  const d = new Date(from);
  if (cycle === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
};

export async function findCoupon(code, planCode, now = new Date()) {
  if (!code) return null;
  const c = await Coupon.findOne({ code: String(code).toUpperCase(), active: true }).lean();
  const valid = c
    && (!c.validFrom || c.validFrom <= now)
    && (!c.validUntil || c.validUntil >= now)
    && (!c.maxRedemptions || c.redemptions < c.maxRedemptions)
    && (!c.planCodes?.length || c.planCodes.includes(planCode));
  if (!valid) throw badRequest('Coupon is invalid or expired');
  return c;
}

/** Price for a plan/cycle after an optional coupon. */
export async function quote(planCode, billingCycle, couponCode) {
  const plan = await findPlan(planCode);
  if (!plan || !plan.active) throw badRequest('Unknown plan');
  if (plan.isCustom) throw badRequest('This plan is priced by our sales team. Contact us to subscribe.');
  if (!['monthly', 'yearly'].includes(billingCycle)) throw badRequest('billingCycle must be monthly or yearly');
  const price = billingCycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;
  const coupon = await findCoupon(couponCode, plan.code);
  let discount = 0;
  if (coupon?.percentOff) discount = Math.round(price * coupon.percentOff) / 100;
  if (coupon?.amountOff) discount = Math.max(discount, coupon.amountOff);
  discount = Math.min(discount, price);
  return { plan, billingCycle, price, discount, total: Math.round((price - discount) * 100) / 100, currency: plan.currency || 'INR', coupon };
}

/** Starts a checkout. Returns provider client params (Razorpay order / Stripe session) or activates a ₹0 order. */
export async function createCheckout(req, { planCode, billingCycle, provider: providerName, couponCode }) {
  const q = await quote(planCode, billingCycle, couponCode);
  if (q.price === 0) throw badRequest('Free plans do not need checkout; change plan instead');
  const payment = await Payment.create({
    organizationId: req.orgId, provider: q.total === 0 ? 'coupon' : providerName, amount: q.total, currency: q.currency,
    planId: q.plan._id, planCode: q.plan.code, billingCycle, couponCode: q.coupon?.code, discount: q.discount, userId: req.user._id,
  });
  if (q.total === 0) {
    await completePayment(payment, { paymentId: `coupon:${q.coupon.code}` }, req);
    return { payment: await Payment.findById(payment._id), activated: true };
  }
  const provider = getPaymentProvider(providerName);
  if (!provider) throw badRequest('Unknown payment provider');
  if (!provider.isConfigured()) {
    await Payment.deleteOne({ _id: payment._id });
    throw new NotConfiguredError(`Payment provider "${providerName}"`);
  }
  const order = await provider.createOrder({
    amount: q.total,
    currency: q.currency,
    receipt: String(payment._id),
    description: `${q.plan.name} plan (${billingCycle})`,
    customerEmail: req.user.email,
    metadata: { paymentId: String(payment._id), companyId: String(req.orgId), plan: q.plan.code },
    successUrl: `${env.frontendUrl}/billing?payment=${payment._id}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${env.frontendUrl}/billing?payment=${payment._id}&cancelled=1`,
  });
  payment.providerOrderId = order.orderId;
  await payment.save();
  await audit(req, 'payment.initiated', { module: 'billing', resourceType: 'Payment', resourceId: payment._id, details: { provider: providerName, plan: q.plan.code, amount: q.total } });
  return { payment, provider: providerName, clientParams: order.clientParams };
}

/**
 * Marks a payment successful and activates/extends the subscription. Idempotent: the client verification
 * and the provider webhook may both arrive; the second one is a no-op.
 */
export async function completePayment(payment, { paymentId }, req = null) {
  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, status: { $in: ['pending', 'failed'] } },
    { $set: { status: 'success', providerPaymentId: paymentId, paidAt: new Date(), failureReason: null } },
    { returnDocument: 'after' },
  );
  if (!claimed) return Payment.findById(payment._id);
  const plan = await SubscriptionPlan.findById(claimed.planId).lean();
  const now = new Date();
  const current = await CompanySubscription.findOne({ organizationId: claimed.organizationId });
  // Renewing the same plan early extends from the current end; anything else starts today.
  const sameActivePlan = current && current.status === 'active' && String(current.planId) === String(plan._id) && current.endDate > now;
  const start = sameActivePlan ? current.endDate : now;
  const endDate = addPeriod(start, claimed.billingCycle);
  await CompanySubscription.findOneAndUpdate(
    { organizationId: claimed.organizationId },
    {
      $set: {
        planId: plan._id, planCode: plan.code, status: 'active', billingCycle: claimed.billingCycle,
        startDate: sameActivePlan ? current.startDate : now, endDate, trialEnd: current?.status === 'trial' ? now : current?.trialEnd,
        autoRenew: true, cancelAtPeriodEnd: false, cancelledAt: null, paymentProvider: claimed.provider,
      },
    },
    { upsert: true },
  );
  const invoice = await BillingInvoice.create({
    organizationId: claimed.organizationId,
    number: `CINV-${String(await nextPlatformSeq('billing_invoice')).padStart(6, '0')}`,
    status: 'paid', planCode: plan.code, billingCycle: claimed.billingCycle, periodStart: start, periodEnd: endDate,
    subtotal: claimed.amount + (claimed.discount || 0), discount: claimed.discount || 0, total: claimed.amount, currency: claimed.currency, paymentId: claimed._id,
  });
  claimed.invoiceId = invoice._id;
  await claimed.save();
  if (claimed.couponCode) await Coupon.updateOne({ code: claimed.couponCode }, { $inc: { redemptions: 1 } });
  invalidateTenant(claimed.organizationId);
  const ctx = { orgId: claimed.organizationId, userId: claimed.userId, module: 'billing' };
  await audit(req, 'payment.success', { ...ctx, resourceType: 'Payment', resourceId: claimed._id, details: { amount: claimed.amount, provider: claimed.provider } });
  await audit(req, 'subscription.upgrade', { ...ctx, resourceType: 'CompanySubscription', details: { plan: plan.code, billingCycle: claimed.billingCycle, endDate } });
  log.info('payment.success', { companyId: String(claimed.organizationId), plan: plan.code, provider: claimed.provider });
  return claimed;
}

export async function failPayment(payment, reason, req = null) {
  const updated = await Payment.findOneAndUpdate({ _id: payment._id, status: 'pending' }, { $set: { status: 'failed', failureReason: reason || 'Payment failed' } }, { returnDocument: 'after' });
  if (updated) {
    await audit(req, 'payment.failed', { orgId: updated.organizationId, module: 'billing', resourceType: 'Payment', resourceId: updated._id, details: { reason } });
    log.warn('payment.failed', { companyId: String(updated.organizationId), provider: updated.provider });
  }
  return updated;
}

/** Client-side completion (e.g. Razorpay handler): verified with the provider's signature, never trusted as-is. */
export async function verifyCheckout(req, paymentId, body) {
  const payment = await Payment.findOne({ _id: paymentId, organizationId: req.orgId });
  if (!payment) throw new AppError(404, 'Payment not found', 'NOT_FOUND');
  if (payment.status === 'success') return payment;
  const provider = getPaymentProvider(payment.provider);
  if (!provider?.isConfigured()) throw new NotConfiguredError(`Payment provider "${payment.provider}"`);
  const verified = await provider.verifyClientPayment(body, payment);
  return completePayment(payment, verified, req);
}

/** Applies normalized webhook events. */
export async function applyPaymentEvents(providerName, events) {
  for (const e of events) {
    if (e.type === 'payment.succeeded' || e.type === 'payment.failed') {
      const payment = await Payment.findOne({ provider: providerName, providerOrderId: e.orderId });
      if (!payment) continue;
      if (e.type === 'payment.succeeded') await completePayment(payment, { paymentId: e.paymentId });
      else await failPayment(payment, e.reason);
    } else if (e.type === 'payment.refunded') {
      const payment = await Payment.findOne({ provider: providerName, providerPaymentId: e.paymentId });
      if (!payment) continue;
      payment.refundedAmount = e.amount || payment.amount;
      if (payment.refundedAmount >= payment.amount) {
        payment.status = 'refunded';
        // A full refund ends the paid period it bought
        await CompanySubscription.updateOne({ organizationId: payment.organizationId, status: 'active' }, { $set: { status: 'cancelled', endDate: new Date(), autoRenew: false, cancelledAt: new Date() } });
        invalidateTenant(payment.organizationId);
      }
      await payment.save();
      if (payment.invoiceId && payment.status === 'refunded') await BillingInvoice.updateOne({ _id: payment.invoiceId }, { status: 'void' });
      await audit(null, 'payment.refunded', { orgId: payment.organizationId, module: 'billing', resourceType: 'Payment', resourceId: payment._id, details: { amount: payment.refundedAmount } });
    } else if (e.type === 'subscription.cancelled') {
      const sub = await CompanySubscription.findOneAndUpdate({ subscriptionExternalId: e.subscriptionId }, { $set: { status: 'cancelled', autoRenew: false, cancelledAt: new Date() } });
      if (sub) {
        invalidateTenant(sub.organizationId);
        await audit(null, 'subscription.cancelled', { orgId: sub.organizationId, module: 'billing', details: { source: providerName } });
      }
    }
  }
}
