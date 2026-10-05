import crypto from 'node:crypto';
import { env } from '../../../config/env.js';
import { httpRequest } from '../../../lib/http.js';
import { badRequest } from '../../../lib/errors.js';

/**
 * Payment provider interface (implemented by RazorpayService and StripeService):
 *   name, isConfigured()
 *   createOrder({ amount, currency, receipt, description, customerEmail, successUrl, cancelUrl, metadata })
 *     → { orderId, clientParams }               amount in major units (₹), converted per provider
 *   verifyClientPayment(body, payment) → { paymentId }   server-side check; throws when not paid
 *   verifyWebhook({ rawBody, headers }) → boolean          signature check
 *   parseWebhook(body) → { eventId, events: [{ type, orderId?, paymentId?, amount?, reason? }] }
 * Event types: payment.succeeded | payment.failed | payment.refunded | subscription.cancelled
 */

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const minor = (amount) => Math.round(amount * 100);

export class RazorpayService {
  constructor(cfg = env.razorpay) {
    this.name = 'razorpay';
    this.cfg = cfg;
  }

  isConfigured() { return Boolean(this.cfg.keyId && this.cfg.keySecret); }

  async createOrder({ amount, currency, receipt, metadata, description, customerEmail }) {
    const order = await httpRequest('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      auth: { username: this.cfg.keyId, password: this.cfg.keySecret },
      json: { amount: minor(amount), currency, receipt, notes: metadata },
    });
    // Public checkout options for checkout.razorpay.com (key id is public; the secret never leaves the server)
    return {
      orderId: order.id,
      clientParams: { key: this.cfg.keyId, order_id: order.id, amount: order.amount, currency, description, prefill: { email: customerEmail } },
    };
  }

  /** Razorpay Checkout returns order id, payment id and signature = HMAC(order_id|payment_id, key_secret). */
  async verifyClientPayment(body, payment) {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = body || {};
    if (!orderId || !paymentId || !signature) throw badRequest('razorpay_order_id, razorpay_payment_id and razorpay_signature are required');
    if (orderId !== payment.providerOrderId) throw badRequest('Order does not match this payment');
    if (!safeEqual(hmac(this.cfg.keySecret, `${orderId}|${paymentId}`), signature)) throw badRequest('Payment signature verification failed');
    return { paymentId };
  }

  verifyWebhook({ rawBody, headers }) {
    if (!this.cfg.webhookSecret || !rawBody) return false;
    return safeEqual(hmac(this.cfg.webhookSecret, rawBody), headers['x-razorpay-signature']);
  }

  parseWebhook(body, headers = {}) {
    const p = body?.payload || {};
    const pay = p.payment?.entity;
    const events = [];
    switch (body?.event) {
      case 'payment.captured':
      case 'order.paid':
        events.push({ type: 'payment.succeeded', orderId: pay?.order_id || p.order?.entity?.id, paymentId: pay?.id });
        break;
      case 'payment.failed':
        events.push({ type: 'payment.failed', orderId: pay?.order_id, paymentId: pay?.id, reason: pay?.error_description });
        break;
      case 'refund.processed':
      case 'refund.created':
        events.push({ type: 'payment.refunded', paymentId: p.refund?.entity?.payment_id, amount: (p.refund?.entity?.amount || 0) / 100 });
        break;
      case 'subscription.cancelled':
        events.push({ type: 'subscription.cancelled', subscriptionId: p.subscription?.entity?.id });
        break;
      default:
    }
    return { eventId: headers['x-razorpay-event-id'] || `${body?.event}:${pay?.id || p.refund?.entity?.id || body?.created_at}`, events };
  }
}

export class StripeService {
  constructor(cfg = env.stripe) {
    this.name = 'stripe';
    this.cfg = cfg;
  }

  isConfigured() { return Boolean(this.cfg.secretKey); }

  api(path, opts = {}) {
    return httpRequest(`https://api.stripe.com/v1${path}`, { ...opts, headers: { Authorization: `Bearer ${this.cfg.secretKey}` } });
  }

  async createOrder({ amount, currency, receipt, metadata, description, customerEmail, successUrl, cancelUrl }) {
    const form = {
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: receipt,
      customer_email: customerEmail,
      'line_items[0][quantity]': 1,
      'line_items[0][price_data][currency]': currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': minor(amount),
      'line_items[0][price_data][product_data][name]': description,
    };
    for (const [k, v] of Object.entries(metadata || {})) form[`metadata[${k}]`] = v;
    const session = await this.api('/checkout/sessions', { method: 'POST', form });
    return { orderId: session.id, clientParams: { sessionId: session.id, url: session.url } };
  }

  /** Never trusts the redirect: re-reads the Checkout Session from Stripe. */
  async verifyClientPayment(body, payment) {
    const sessionId = body?.sessionId || payment.providerOrderId;
    if (sessionId !== payment.providerOrderId) throw badRequest('Session does not match this payment');
    const session = await this.api(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
    if (session.payment_status !== 'paid') throw badRequest('Payment is not completed yet');
    return { paymentId: session.payment_intent };
  }

  /** Stripe-Signature: t=timestamp,v1=HMAC(`${t}.${rawBody}`, whsec); 5 minute tolerance against replays. */
  verifyWebhook({ rawBody, headers }, now = Date.now()) {
    if (!this.cfg.webhookSecret || !rawBody) return false;
    const parts = Object.fromEntries(String(headers['stripe-signature'] || '').split(',').map((kv) => kv.split('=')).filter((kv) => kv.length === 2).map(([k, v]) => [k, v]));
    const signatures = String(headers['stripe-signature'] || '').split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
    const t = Number(parts.t);
    if (!t || Math.abs(now / 1000 - t) > 300) return false;
    const expected = hmac(this.cfg.webhookSecret, `${t}.${rawBody}`);
    return signatures.some((s) => safeEqual(s, expected));
  }

  parseWebhook(body) {
    const obj = body?.data?.object || {};
    const events = [];
    switch (body?.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        if (obj.payment_status === 'paid') events.push({ type: 'payment.succeeded', orderId: obj.id, paymentId: obj.payment_intent });
        break;
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired':
        events.push({ type: 'payment.failed', orderId: obj.id, reason: body.type });
        break;
      case 'charge.refunded':
        events.push({ type: 'payment.refunded', paymentId: obj.payment_intent, amount: (obj.amount_refunded || 0) / 100 });
        break;
      case 'customer.subscription.deleted':
        events.push({ type: 'subscription.cancelled', subscriptionId: obj.id });
        break;
      default:
    }
    return { eventId: body?.id, events };
  }
}

const factories = {
  razorpay: () => new RazorpayService(),
  stripe: () => new StripeService(),
};

/** Tests register a fake provider here; production only has the real adapters. */
export function registerPaymentProvider(name, factory) {
  factories[name] = factory;
}

export function getPaymentProvider(name) {
  const make = factories[name];
  return make ? make() : null;
}

export function availableProviders() {
  return Object.keys(factories).filter((n) => getPaymentProvider(n).isConfigured());
}
