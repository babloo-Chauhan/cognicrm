import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { model, ObjectId } from './plugins.js';

const { Schema } = mongoose;

export const DEFAULT_SETTINGS = () => ({
  defaultCountryCode: '91',
  timezone: 'Asia/Kolkata',
  defaultLanguage: 'en',
  languages: ['en', 'hi', 'hinglish'],
  telephonyProvider: null,
  smsProvider: null,
  whatsappProvider: null,
  wrapUpSeconds: 30,
  recording: {
    enabled: false,
    consentMode: 'conditional', // always | conditional | disabled
    consentMessage: {
      en: 'This call may be recorded for quality and training purposes.',
      hi: 'Gunvatta aur prashikshan ke liye yeh call record ki ja sakti hai.',
    },
    retentionDays: 90,
  },
  transcription: { enabled: false, autoSummary: true, autoCreateTasks: true },
  compliance: {
    respectDnc: true,
    maskNumbers: false,
    callLogRetentionDays: null,
    callingHours: { enabled: false, start: '09:00', end: '21:00', days: [1, 2, 3, 4, 5, 6], timezone: null },
  },
  fraud: {
    callsPerMinute: 10,
    callsPerHour: 200,
    dailyLimit: 1000,
    maxDurationSeconds: 7200,
    maxConcurrent: 50,
    blockUnexpectedInternational: true,
    allowedCountryCodes: ['91'],
    failedCallThreshold: 10,
  },
  customAgentStatuses: [],
  leadScoring: null,
  billing: DEFAULT_BILLING(),
  // Tenant branding & localisation (never global)
  branding: { brandName: '', logoUrl: '', primaryColor: '#4f46e5' },
  currency: 'INR',
  dateFormat: 'DD/MM/YYYY',
  emailSettings: { fromName: '', replyTo: '' },
  notificationSettings: { email: true, push: true, inApp: true },
  invoiceSettings: { footer: '', showLogo: true },
  taxSettings: { taxName: 'GST', defaultRate: 18, pricesIncludeTax: false },
});

/** Seller details and defaults printed on quotations and invoices. */
export const DEFAULT_BILLING = () => ({
  companyName: '',
  address: '',
  state: '', // place of business; decides CGST+SGST vs IGST
  gstin: '',
  pan: '',
  email: '',
  phone: '',
  logoUrl: '',
  bank: { accountName: '', accountNumber: '', ifsc: '', bankName: '', branch: '' },
  upiId: '',
  currency: 'INR',
  quotePrefix: 'QT',
  invoicePrefix: 'INV',
  quoteValidityDays: 15,
  paymentTermsDays: 15,
  defaultTaxRate: 18,
  defaultNotes: 'Thank you for your business.',
  defaultTerms: '',
});

export const COMPANY_STATUSES = ['pending', 'active', 'suspended'];

/** A company (tenant). `organizationId` on every tenant document points here — it is the company id. */
const organizationSchema = new Schema({
  name: { type: String, required: true },
  slug: { type: String, unique: true },
  companyCode: { type: String, unique: true, sparse: true }, // CMP-000001 (human-facing company id)
  tenantId: { type: String, unique: true, sparse: true }, // TEN-8F72K91X (opaque tenant key)
  legalName: String,
  email: { type: String, lowercase: true, trim: true },
  phone: String,
  address: { line1: String, city: String, state: String, country: String, postalCode: String },
  taxId: String, // GST / VAT number
  website: String,
  logoUrl: String,
  industry: String,
  status: { type: String, enum: COMPANY_STATUSES, default: 'active', index: true },
  suspendedReason: String,
  // Platform overrides on top of the plan's modules
  moduleOverrides: { enabled: { type: [String], default: [] }, disabled: { type: [String], default: [] } },
  publicChatKey: { type: String, unique: true, default: () => crypto.randomBytes(12).toString('hex') },
  settings: { type: Schema.Types.Mixed, default: DEFAULT_SETTINGS },
});
export const Organization = model('Organization', organizationSchema, { tenant: false });

// Built-in role keys (companies can add custom roles; see the Role model)
export const ROLES = ['admin', 'supervisor', 'agent', 'user'];

const userSchema = new Schema({
  name: { type: String, required: true },
  // Unique per company, so one person can belong to several companies (company switching)
  email: { type: String, required: true, lowercase: true, trim: true },
  userCode: { type: String, unique: true, sparse: true }, // USR-000001
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, default: 'agent', trim: true }, // a Role.key of the user's company
  department: String,
  designation: String,
  avatarUrl: String,
  lastLogin: Date,
  phone: String, // agent's own phone, used for bridge (callback) calling
  extension: String,
  departmentIds: [{ type: ObjectId, ref: 'Department' }],
  language: { type: String, default: 'en' },
  active: { type: Boolean, default: true },
  tokenVersion: { type: Number, default: 0 },
  extraPermissions: [String],
});
userSchema.index({ organizationId: 1, email: 1 }, { unique: true });
userSchema.index({ email: 1 });
export const User = model('User', userSchema);

const departmentSchema = new Schema({
  name: { type: String, required: true },
  description: String,
  defaultQueueId: { type: ObjectId, ref: 'CallQueue' },
  voicemailEnabled: { type: Boolean, default: true },
  memberIds: [{ type: ObjectId, ref: 'User' }],
});
export const Department = model('Department', departmentSchema);

/** Encrypted provider credentials. `credentials` is ciphertext and never returned by the API. */
const integrationSchema = new Schema({
  kind: { type: String, enum: ['telephony', 'sms', 'whatsapp', 'email', 'ai', 'transcription'], required: true },
  provider: { type: String, required: true },
  credentials: { type: String, select: false },
  config: { type: Schema.Types.Mixed, default: {} },
  enabled: { type: Boolean, default: true },
});
integrationSchema.index({ organizationId: 1, kind: 1, provider: 1 }, { unique: true });
export const Integration = model('Integration', integrationSchema);

/** Security log. Company actions carry organizationId; platform-only actions (plans, settings) do not. */
const auditLogSchema = new Schema({
  organizationId: { type: ObjectId, ref: 'Organization' },
  userId: { type: ObjectId, ref: 'User' },
  platformUserId: { type: ObjectId, ref: 'PlatformUser' },
  actorType: { type: String, enum: ['user', 'platform', 'system'], default: 'user' },
  action: { type: String, required: true },
  module: String,
  resourceType: String,
  resourceId: String,
  ip: String,
  userAgent: String,
  details: Schema.Types.Mixed,
});
auditLogSchema.index({ organizationId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
export const AuditLog = model('AuditLog', auditLogSchema, { tenant: false });

const alertSchema = new Schema({
  type: { type: String, required: true }, // fraud.volume, fraud.failed_calls, fraud.international, ...
  severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'warning' },
  message: String,
  userId: { type: ObjectId, ref: 'User' },
  data: Schema.Types.Mixed,
  acknowledged: { type: Boolean, default: false },
});
export const Alert = model('Alert', alertSchema);

const pushTokenSchema = new Schema({
  userId: { type: ObjectId, ref: 'User', required: true },
  token: { type: String, required: true },
  platform: String,
  provider: { type: String, enum: ['expo', 'fcm'], default: 'expo' },
});
pushTokenSchema.index({ userId: 1, token: 1 }, { unique: true });
export const PushToken = model('PushToken', pushTokenSchema);

const notificationSchema = new Schema({
  userId: { type: ObjectId, ref: 'User', required: true, index: true },
  type: String,
  title: String,
  body: String,
  data: Schema.Types.Mixed,
  read: { type: Boolean, default: false },
});
export const Notification = model('Notification', notificationSchema);

/** Raw inbound webhook log; `key` makes processing idempotent. */
const webhookEventSchema = new Schema({
  organizationId: { type: ObjectId, ref: 'Organization', index: true },
  source: { type: String, required: true }, // telephony:twilio, sms:twilio, whatsapp:meta ...
  key: { type: String, required: true, unique: true },
  eventType: String,
  payload: Schema.Types.Mixed,
  status: { type: String, enum: ['received', 'processed', 'failed', 'ignored'], default: 'received' },
  attempts: { type: Number, default: 0 },
  lastError: String,
  nextRetryAt: Date,
});
export const WebhookEvent = model('WebhookEvent', webhookEventSchema, { tenant: false });
