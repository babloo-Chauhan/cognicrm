/**
 * Pure money/tax helpers for quotations and invoices (no database access, unit-tested directly).
 * GST: inside one state the tax is split equally into CGST + SGST; across states it is IGST.
 */

export const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const stateKey = (s) => String(s || '').trim().toLowerCase();

/** Picks intra-state (CGST+SGST) or inter-state (IGST). GSTIN digits 1–2 are the state code, so they win over names. */
export function resolveTaxMode(taxMode, seller = {}, customer = {}) {
  if (taxMode && taxMode !== 'auto') return taxMode;
  const sCode = /^\d{2}/.test(seller.gstin || '') ? seller.gstin.slice(0, 2) : null;
  const cCode = /^\d{2}/.test(customer.gstin || '') ? customer.gstin.slice(0, 2) : null;
  if (sCode && cCode) return sCode === cCode ? 'intra' : 'inter';
  if (stateKey(seller.state) && stateKey(customer.state)) return stateKey(seller.state) === stateKey(customer.state) ? 'intra' : 'inter';
  return 'intra';
}

/**
 * Calculates line amounts and document totals. `extraDiscount` is a flat amount taken off the taxable value and
 * spread across lines in proportion to their amount, so GST is charged on the discounted value.
 * INR totals are rounded to the nearest rupee and the difference is shown as round-off.
 */
export function calculate({ items = [], extraDiscount = 0, taxMode = 'auto', seller, customer, currency = 'INR' }) {
  const mode = resolveTaxMode(taxMode, seller, customer);
  let subtotal = 0;
  let discountTotal = 0;
  const lines = items.map((raw) => {
    const item = typeof raw.toObject === 'function' ? raw.toObject() : { ...raw };
    const quantity = Number(item.quantity ?? 1);
    const unitPrice = Number(item.unitPrice ?? 0);
    const gross = r2(quantity * unitPrice);
    const discount = r2(gross * (Number(item.discountPercent || 0) / 100));
    subtotal += gross;
    discountTotal += discount;
    return { ...item, quantity, unitPrice, amount: r2(gross - discount) };
  });
  const lineSum = lines.reduce((s, l) => s + l.amount, 0);
  const extra = Math.min(Math.max(Number(extraDiscount) || 0, 0), lineSum);
  let taxable = 0;
  let taxTotal = 0;
  for (const line of lines) {
    const share = lineSum ? (extra * line.amount) / lineSum : 0;
    const lineTaxable = r2(line.amount - share);
    line.taxAmount = mode === 'none' ? 0 : r2(lineTaxable * (Number(line.taxRate || 0) / 100));
    line.total = r2(lineTaxable + line.taxAmount);
    taxable += lineTaxable;
    taxTotal += line.taxAmount;
  }
  taxable = r2(taxable);
  taxTotal = r2(taxTotal);
  const cgst = mode === 'intra' ? r2(taxTotal / 2) : 0;
  const sgst = mode === 'intra' ? r2(taxTotal - cgst) : 0;
  const igst = mode === 'inter' ? taxTotal : 0;
  const exact = r2(taxable + taxTotal);
  const total = currency === 'INR' ? Math.round(exact) : exact;
  return {
    items: lines,
    appliedTaxMode: mode,
    totals: {
      subtotal: r2(subtotal),
      discountTotal: r2(discountTotal + extra),
      taxableAmount: taxable,
      cgst,
      sgst,
      igst,
      taxTotal,
      roundOff: r2(total - exact),
      total,
    },
  };
}

/** Indian financial year label for a date: April 2026 – March 2027 → "2026-27". */
/** 17700 → "₹17,700.00" (Indian grouping); other currencies use their own symbol. */
export function formatMoney(amount, currency = 'INR') {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount || 0);
  } catch {
    return `${currency} ${Number(amount || 0).toFixed(2)}`;
  }
}

export function financialYear(date = new Date()) {
  const d = new Date(date);
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}

function belowThousand(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

/** Amount in words using the Indian system (lakh, crore), as printed on Indian invoices. */
export function amountInWords(amount, currency = 'INR') {
  const value = Math.abs(r2(amount));
  let rupees = Math.floor(value);
  const paise = Math.round((value - rupees) * 100);
  const parts = [];
  const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
  const lakh = Math.floor(rupees / 100000); rupees %= 100000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore) parts.push(`${amountInWords(crore, 'NONE')} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rupees) parts.push(belowThousand(rupees));
  const words = parts.join(' ') || 'Zero';
  if (currency === 'NONE') return words;
  if (currency !== 'INR') return `${currency} ${words}${paise ? ` and ${belowHundred(paise)} Cents` : ''} Only`;
  return `Rupees ${words}${paise ? ` and ${belowHundred(paise)} Paise` : ''} Only`;
}
