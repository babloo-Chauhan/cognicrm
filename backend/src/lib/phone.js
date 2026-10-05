const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Normalizes a phone number to E.164. Numbers without a country code use the
 * organization default calling code (e.g. "91" for India).
 */
export function normalizePhone(input, defaultCountryCode = '91') {
  if (!input) return null;
  let s = String(input).trim();
  if (s.startsWith('client:') || s.startsWith('sip:')) return s;
  const hasPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;
  if (hasPlus) return `+${s}`;
  if (s.startsWith('00')) return `+${s.slice(2)}`;
  if (s.startsWith('0')) s = s.replace(/^0+/, '');
  if (s.length <= 10) return `+${defaultCountryCode}${s}`;
  return `+${s}`;
}

export function isValidE164(phone) {
  return E164.test(String(phone || ''));
}

/** Returns the calling-code prefix that matches one of the allowed codes, or null. */
export function matchCallingCode(phone, codes) {
  const digits = String(phone || '').replace(/^\+/, '');
  return (codes || []).find((c) => digits.startsWith(String(c).replace(/^\+/, ''))) || null;
}

/** Phone variants used for CRM lookups (stored numbers may lack the country code). */
export function phoneVariants(phone) {
  if (!phone) return [];
  const digits = String(phone).replace(/[^\d]/g, '');
  const set = new Set([phone, `+${digits}`, digits]);
  if (digits.length > 10) set.add(digits.slice(-10));
  return [...set];
}
