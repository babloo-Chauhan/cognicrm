import mongoose from 'mongoose';
import { model, ObjectId } from './plugins.js';

const { Schema } = mongoose;

/**
 * SaaS layer. "Company" in the product = `Organization` in code; every tenant-owned document carries
 * `organizationId` (the company id). Platform-level collections (plans, platform admins, settings) have no tenant.
 */

/** Platform-wide sequences (company / user / invoice numbers). */
const platformCounterSchema = new Schema({ key: { type: String, required: true, unique: true }, seq: { type: Number, default: 0 } });
export const PlatformCounter = model('PlatformCounter', platformCounterSchema, { tenant: false });

export async function nextPlatformSeq(key) {
  const c = await PlatformCounter.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return c.seq;
}

// -1 means unlimited for every numeric limit.
const limitsShape = {
  users: { type: Number, default: -1 },
  customers: { type: Number, default: -1 }, // contacts + accounts
  leads: { type: Number, default: -1 },
  deals: { type: Number, default: -1 },
  storageMb: { type: Number, default: -1 },
  apiCallsPerMonth: { type: Number, default: -1 },
  automations: { type: Number, default: -1 },
};

const subscriptionPlanSchema = new Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true }, // FREE, STARTER, ...
  name: { type: String, required: true },
  description: String,
  currency: { type: String, default: 'INR' },
  priceMonthly: { type: Number, default: 0, min: 0 }, // major units (rupees)
  priceYearly: { type: Number, default: 0, min: 0 },
  limits: { type: new Schema(limitsShape, { _id: false }), default: () => ({}) },
  modules: [String], // module keys, see src/lib/modules.js; ['*'] = everything
  isCustom: { type: Boolean, default: false }, // enterprise: priced by sales, not self-serve checkout
  isPublic: { type: Boolean, default: true },
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
});
export const SubscriptionPlan = model('SubscriptionPlan', subscriptionPlanSchema, { tenant: false });

export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'past_due', 'cancelled', 'expired', 'suspended'];

/** One current subscription per company. */
const companySubscriptionSchema = new Schema({
  planId: { type: ObjectId, ref: 'SubscriptionPlan', required: true },
  planCode: String,
  status: { type: String, enum: SUBSCRIPTION_STATUSES, default: 'trial' },
  billingCycle: { type: String, enum: ['monthly', 'yearly', 'none'], default: 'monthly' },
  startDate: { type: Date, default: Date.now },
  endDate: Date, // null = does not expire
  trialStart: Date,
  trialEnd: Date,
  autoRenew: { type: Boolean, default: true },
  cancelAtPeriodEnd: { type: Boolean, default: false },
  cancelledAt: Date,
  paymentProvider: String,
  subscriptionExternalId: String,
  // Per-company limit overrides set by the platform (e.g. a custom enterprise deal)
  customLimits: { type: Schema.Types.Mixed, default: null },
});
companySubscriptionSchema.index({ organizationId: 1 }, { unique: true });
companySubscriptionSchema.index({ status: 1, endDate: 1 });
export const CompanySubscription = model('CompanySubscription', companySubscriptionSchema);

const paymentSchema = new Schema({
  provider: { type: String, required: true }, // razorpay | stripe | manual
  status: { type: String, enum: ['pending', 'success', 'failed', 'refunded'], default: 'pending' },
  amount: { type: Number, required: true }, // major units
  currency: { type: String, default: 'INR' },
  purpose: { type: String, default: 'subscription' },
  planId: { type: ObjectId, ref: 'SubscriptionPlan' },
  planCode: String,
  billingCycle: String,
  couponCode: String,
  discount: { type: Number, default: 0 },
  providerOrderId: { type: String, index: true },
  providerPaymentId: String,
  failureReason: String,
  refundedAmount: { type: Number, default: 0 },
  userId: { type: ObjectId, ref: 'User' },
  invoiceId: { type: ObjectId, ref: 'BillingInvoice' },
  paidAt: Date,
});
paymentSchema.index({ organizationId: 1, createdAt: -1 });
export const Payment = model('Payment', paymentSchema);

/** Platform → company invoice (subscription billing). Distinct from the CRM's own sales `Invoice`. */
const billingInvoiceSchema = new Schema({
  number: { type: String, required: true, unique: true },
  status: { type: String, enum: ['paid', 'open', 'void'], default: 'paid' },
  planCode: String,
  billingCycle: String,
  periodStart: Date,
  periodEnd: Date,
  subtotal: Number,
  discount: { type: Number, default: 0 },
  total: Number,
  currency: { type: String, default: 'INR' },
  paymentId: { type: ObjectId, ref: 'Payment' },
  issuedAt: { type: Date, default: Date.now },
});
billingInvoiceSchema.index({ organizationId: 1, createdAt: -1 });
export const BillingInvoice = model('BillingInvoice', billingInvoiceSchema);

const couponSchema = new Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  percentOff: { type: Number, min: 0, max: 100 },
  amountOff: { type: Number, min: 0 },
  planCodes: [String], // empty = all plans
  validFrom: Date,
  validUntil: Date,
  maxRedemptions: Number,
  redemptions: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
});
export const Coupon = model('Coupon', couponSchema, { tenant: false });

/** Monthly usage counters per company (period = YYYY-MM). Record counts are computed live. */
const usageSchema = new Schema({
  period: { type: String, required: true },
  apiCalls: { type: Number, default: 0 },
  automationRuns: { type: Number, default: 0 },
  storageBytes: { type: Number, default: 0 },
});
usageSchema.index({ organizationId: 1, period: 1 }, { unique: true });
export const Usage = model('Usage', usageSchema);

/** Company-defined roles. `key` is what `User.role` stores. */
const roleSchema = new Schema({
  key: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  description: String,
  permissions: [String],
  system: { type: Boolean, default: false }, // built-in roles can be edited but not deleted
});
roleSchema.index({ organizationId: 1, key: 1 }, { unique: true });
export const Role = model('Role', roleSchema);

/** Sales pipelines. Every pipeline keeps a `won` and a `lost` stage so reports stay comparable. */
const pipelineSchema = new Schema({
  name: { type: String, required: true },
  isDefault: { type: Boolean, default: false },
  stages: [{
    _id: false,
    key: { type: String, required: true },
    label: { type: String, required: true },
    probability: { type: Number, min: 0, max: 100, default: 0 },
  }],
});
pipelineSchema.index({ organizationId: 1, name: 1 }, { unique: true });
export const Pipeline = model('Pipeline', pipelineSchema);

/** Platform operators (super admins). Separate collection and token audience from company users. */
const platformUserSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['super_admin', 'support'], default: 'super_admin' },
  active: { type: Boolean, default: true },
  tokenVersion: { type: Number, default: 0 },
  lastLogin: Date,
});
export const PlatformUser = model('PlatformUser', platformUserSchema, { tenant: false });

/** Singleton platform configuration (key = 'global'). */
const platformSettingsSchema = new Schema({
  key: { type: String, default: 'global', unique: true },
  trialEnabled: { type: Boolean, default: true },
  trialDays: { type: Number, default: 14, min: 0 },
  trialPlanCode: { type: String, default: 'PROFESSIONAL' },
  defaultPlanCode: { type: String, default: 'FREE' }, // what a company falls back to when it has no paid plan
  requireApproval: { type: Boolean, default: false }, // new companies start as `pending` until approved
  gracePeriodDays: { type: Number, default: 3 }, // past_due keeps paid modules this long
});
export const PlatformSettings = model('PlatformSettings', platformSettingsSchema, { tenant: false });

export async function getPlatformSettings() {
  return PlatformSettings.findOneAndUpdate({ key: 'global' }, { $setOnInsert: { key: 'global' } }, { upsert: true, returnDocument: 'after' }).lean();
}

/** A company's uploaded logo (one per company), served publicly so apps and invoices can show it. */
const brandAssetSchema = new Schema({
  organizationId: { type: ObjectId, ref: 'Organization', required: true, unique: true },
  contentType: { type: String, enum: ['image/png', 'image/jpeg', 'image/webp'], required: true },
  data: { type: Buffer, required: true },
  size: Number,
});
export const BrandAsset = model('BrandAsset', brandAssetSchema, { tenant: false });
