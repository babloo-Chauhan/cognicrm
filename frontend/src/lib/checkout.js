import { post } from './api.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the payment window. Check your connection.'));
    document.body.appendChild(s);
  });
}

/**
 * Starts a paid checkout and resolves once the server has verified the payment.
 * Razorpay: opens the hosted checkout, then the server checks the payment signature.
 * Stripe: redirects to the hosted page; the billing page verifies on return (and the webhook confirms).
 */
export async function startCheckout({ planCode, billingCycle, provider, couponCode }) {
  const co = await post('/billing/checkout', { planCode, billingCycle, provider, couponCode: couponCode || undefined });
  if (co.activated) return { activated: true };
  const paymentId = co.payment.id;
  if (provider === 'stripe') {
    window.location.assign(co.clientParams.url);
    return new Promise(() => {}); // navigating away
  }
  await loadScript('https://checkout.razorpay.com/v1/checkout.js');
  return new Promise((resolve, reject) => {
    const rzp = new window.Razorpay({
      ...co.clientParams,
      name: 'COGNIEOS CRM',
      handler: async (response) => {
        try {
          resolve(await post('/billing/verify', { paymentId, ...response }));
        } catch (err) {
          reject(err);
        }
      },
      modal: { ondismiss: () => reject(Object.assign(new Error('Payment was cancelled'), { code: 'CANCELLED' })) },
    });
    rzp.on('payment.failed', (r) => reject(new Error(r?.error?.description || 'Payment failed')));
    rzp.open();
  });
}

export function priceLabel(plan, cycle = 'monthly') {
  if (plan.isCustom) return 'Custom';
  const amount = cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;
  if (!amount) return 'Free';
  return `${new Intl.NumberFormat('en-IN', { style: 'currency', currency: plan.currency || 'INR', maximumFractionDigits: 0 }).format(amount)}/${cycle === 'yearly' ? 'yr' : 'mo'}`;
}

export const limitText = (v) => (v === undefined || v === null || v < 0 ? 'Unlimited' : v.toLocaleString());
