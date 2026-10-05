import { money } from '../../lib/format.js';

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'];
export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'overdue', 'paid', 'void'];
export const PAYMENT_METHODS = ['bank_transfer', 'upi', 'card', 'cash', 'cheque', 'other'];

export const docNumber = (d, kind) => {
  if (kind === 'quote') return `${d.number}${d.version > 1 ? ` · Rev ${d.version}` : ''}`;
  return d.number || 'Draft invoice';
};
export const customerName = (d) => d.customer?.company || d.customer?.name || '—';

/** Copies text; falls back silently when the clipboard is blocked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function whatsappShare(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export function quoteStep(q) {
  if (q.status === 'accepted') return q.invoiceId ? 4 : 3;
  if (['sent', 'rejected', 'expired'].includes(q.status)) return 2;
  return q.dealId ? 2 : 1;
}

export function invoiceStep(inv) {
  return inv.status === 'paid' ? 6 : 4;
}

export function money2(v, currency = 'INR') {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0);
  } catch {
    return money(v, currency);
  }
}
