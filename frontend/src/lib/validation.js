/**
 * Form validation rules shared by the API, the web app and the mobile app.
 * The same file lives at backend/src/lib/validation.js, frontend/src/lib/validation.js and app/src/validation.js —
 * change all three together (a backend test checks the web copy matches).
 *
 * A field is { key, label, type, required, min, max, maxLength, format }:
 *   type   text | textarea | email | phone | number | date | datetime | select | …
 *   format a FORMATS key for extra checks on text (name, e164, url, https, gstin, pan, ifsc, pincode, hsn, upi, bankAccount)
 */

const LETTER = /[A-Za-zÀ-ɏऄ-हक़-ॡ]/; // Latin and Devanagari letters (not vowel signs)

export const FORMATS = {
  email: { test: (v) => /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(v), message: 'Enter a valid email, like name@company.com' },
  // 10 digits, or a country code / leading 0 in front; spaces, dashes and brackets are ignored
  phone: { test: (v) => /^\+?\d{10,15}$/.test(v.replace(/[\s\-().]/g, '')), message: 'Enter a valid phone number: 10 digits, or with country code (+91…)' },
  url: { test: (v) => /^(https?:\/\/)?([\w-]+\.)+[A-Za-z]{2,}(:\d+)?(\/\S*)?$/.test(v), message: 'Enter a valid website, like www.company.com' },
  name: { test: (v) => LETTER.test(v), message: 'Use letters, not only numbers or symbols' },
  e164: { test: (v) => /^\+[1-9]\d{7,14}$/.test(v.replace(/[\s-]/g, '')), message: 'Use international format with country code, like +918012345678' },
  gstin: { test: (v) => /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v.toUpperCase()), message: 'GSTIN has 15 characters, like 27ABCDE1234F1Z5' },
  pan: { test: (v) => /^[A-Z]{5}\d{4}[A-Z]$/.test(v.toUpperCase()), message: 'PAN has 10 characters, like ABCDE1234F' },
  ifsc: { test: (v) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.toUpperCase()), message: 'IFSC has 11 characters, like HDFC0001234' },
  pincode: { test: (v) => /^[1-9]\d{5}$/.test(v), message: 'PIN code has 6 digits' },
  hsn: { test: (v) => /^\d{4,8}$/.test(v), message: 'HSN / SAC code has 4 to 8 digits' },
  upi: { test: (v) => /^[\w.-]{2,}@[A-Za-z][A-Za-z0-9]+$/.test(v), message: 'UPI ID looks like name@bank' },
  bankAccount: { test: (v) => /^\d{9,18}$/.test(v.replace(/\s/g, '')), message: 'Bank account number has 9 to 18 digits' },
  https: { test: (v) => /^https:\/\/\S+\.\S+/.test(v), message: 'Use a full https:// link' },
};

const MAX_LENGTH = { textarea: 5000, email: 254, phone: 20 };
const DEFAULT_MAX_LENGTH = 200;

/** Keeps only characters a phone number can contain (digits, +, spaces, dashes, brackets), max 20. */
export const phoneChars = (v) => String(v ?? '').replace(/[^\d+\s\-()]/g, '').slice(0, 20);

export const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Returns an error message for one value, or null when it is fine. Blank optional values are fine. */
export function validateField(field, value) {
  const name = field.label || field.key;
  if (isBlank(value)) return field.required ? `${name} is required` : null;
  const type = field.type || 'text';

  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
    if (!Number.isFinite(n)) return `${name} must be a number`;
    const min = field.min ?? (field.money ? 0 : undefined);
    if (min !== undefined && n < min) return min === 0 ? `${name} cannot be negative` : `${name} must be at least ${min}`;
    if (field.max !== undefined && n > field.max) return `${name} must be at most ${field.max}`;
    if (field.integer && !Number.isInteger(n)) return `${name} must be a whole number`;
    return null;
  }
  if (type === 'date' || type === 'datetime') {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? `${name} is not a valid date` : null;
  }
  if (typeof value !== 'string') return null; // selects, checkboxes, references

  const text = value.trim();
  // The format message ("Enter a valid phone number…") says more than "too long", so it comes first
  const format = FORMATS[field.format] || FORMATS[type];
  if (format && !format.test(text)) return format.message;
  const maxLength = field.maxLength ?? MAX_LENGTH[type] ?? DEFAULT_MAX_LENGTH;
  if (text.length > maxLength) return `${name} is too long (max ${maxLength} characters)`;
  if (field.minLength && text.length < field.minLength) return `${name} must be at least ${field.minLength} characters`;
  return null;
}

/** Validates a whole form; returns { key: message } for the fields with problems (empty when valid). */
export function validateForm(fields, values) {
  const errors = {};
  for (const field of fields) {
    const message = validateField(field, values?.[field.key]);
    if (message) errors[field.key] = message;
  }
  return errors;
}

/** "Name is required" — the first problem, for a single error banner. */
export const firstError = (errors) => Object.values(errors)[0] || null;
