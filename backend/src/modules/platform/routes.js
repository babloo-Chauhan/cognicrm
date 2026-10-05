import { Router } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  AuditLog, BillingInvoice, CompanySubscription, Coupon, getPlatformSettings, Organization, Payment, PlatformSettings,
  PlatformUser, SubscriptionPlan, Usage, User, SUBSCRIPTION_STATUSES,
} from '../../models/index.js';
import { validate } from '../../middleware/common.js';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import { MODULE_KEYS, MODULES } from '../../lib/modules.js';
import { createCompany } from '../saas/provisioning.js';
import { findPlan } from '../saas/plans.js';
import { evaluateSubscription, invalidateTenant } from '../saas/tenant.js';
import { period, usageSummary } from '../saas/usage.js';
import { authenticatePlatform, requireSuperAdmin, signPlatformToken } from './auth.js';

/** Super-admin API (/api/v1/platform). Separate login and token from company users. */
export const platformPublicRouter = Router();
const router = Router();

const DAY = 86400000;
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const idParam = (req) => {
  if (!objectId.safeParse(req.params.id).success) throw badRequest('Invalid id');
  return req.params.id;
};
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const page = (req) => {
  const limit = Math.min(Number(req.query.limit) || 25, 200);
  return { limit, skip: (Math.max(Number(req.query.page) || 1, 1) - 1) * limit, page: Math.max(Number(req.query.page) || 1, 1) };
};

platformPublicRouter.post('/platform/auth/login', validate(z.object({ email: z.string().trim().email(), password: z.string().min(1).max(128) })), async (req, res) => {
  const admin = await PlatformUser.findOne({ email: req.body.email.toLowerCase(), active: true }).select('+passwordHash');
  if (!admin || !(await bcrypt.compare(req.body.password, admin.passwordHash))) {
    log.warn('platform.login_failed', {});
    throw unauthorized('Invalid email or password');
  }
  admin.lastLogin = new Date();
  await admin.save();
  req.platformUser = admin;
  await audit(req, 'platform.login', { module: 'platform' });
  res.json({ token: signPlatformToken(admin), admin: { id: String(admin._id), name: admin.name, email: admin.email, role: admin.role } });
});

// Only /platform/* goes through this router's guards (it is mounted on the API root).
router.use('/platform', authenticatePlatform, requireSuperAdmin);

router.get('/platform/auth/me', (req, res) => {
  const a = req.platformUser;
  res.json({ admin: { id: String(a._id), name: a.name, email: a.email, role: a.role } });
});

// ---------------------------------------------------------------- Dashboard
function monthsBack(n) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() - (n - 1), 1);
}

const byMonth = (field) => ({ $dateToString: { format: '%Y-%m', date: `$${field}` } });

function series(rows, months = 12) {
  const map = Object.fromEntries(rows.map((r) => [r._id, r]));
  const out = [];
  const start = monthsBack(months);
  for (let i = 0; i < months; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push({ month: key, ...(map[key] || {}), _id: undefined });
  }
  return out;
}

router.get('/platform/dashboard', async (_req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const since = monthsBack(12);
  const settings = await getPlatformSettings();
  const [companyCounts, subs, totalUsers, revenueMonth, revenueYear, revenueSeries, companySeries, userSeries, subSeries, churnSeries, usageSeries] = await Promise.all([
    Organization.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    CompanySubscription.find({}).select('status trialEnd endDate').lean(),
    User.countDocuments({ active: true }),
    Payment.aggregate([{ $match: { status: 'success', paidAt: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Payment.aggregate([{ $match: { status: 'success', paidAt: { $gte: yearStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Payment.aggregate([{ $match: { status: 'success', paidAt: { $gte: since } } }, { $group: { _id: byMonth('paidAt'), revenue: { $sum: '$amount' }, payments: { $sum: 1 } } }]),
    Organization.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: byMonth('createdAt'), companies: { $sum: 1 } } }]),
    User.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: byMonth('createdAt'), users: { $sum: 1 } } }]),
    AuditLog.aggregate([{ $match: { action: 'subscription.upgrade', createdAt: { $gte: since } } }, { $group: { _id: byMonth('createdAt'), subscriptions: { $sum: 1 } } }]),
    AuditLog.aggregate([{ $match: { action: { $in: ['subscription.cancelled', 'subscription.expired'] }, createdAt: { $gte: since } } }, { $group: { _id: byMonth('createdAt'), churned: { $sum: 1 } } }]),
    Usage.aggregate([{ $match: { period: { $gte: since.toISOString().slice(0, 7) } } }, { $group: { _id: '$period', apiCalls: { $sum: '$apiCalls' } } }]),
  ]);
  const byStatus = Object.fromEntries(companyCounts.map((c) => [c._id || 'active', c.n]));
  const evaluated = subs.map((s) => ({ ...s, eff: evaluateSubscription(s, settings, now).status }));
  const weekAhead = new Date(now.getTime() + 7 * DAY);
  res.json({
    cards: {
      totalCompanies: companyCounts.reduce((a, c) => a + c.n, 0),
      activeCompanies: byStatus.active || 0,
      pendingCompanies: byStatus.pending || 0,
      suspendedCompanies: byStatus.suspended || 0,
      trialCompanies: evaluated.filter((s) => s.eff === 'trial').length,
      expiredCompanies: evaluated.filter((s) => s.eff === 'expired').length,
      activeSubscriptions: evaluated.filter((s) => s.eff === 'active').length,
      expiringSubscriptions: evaluated.filter((s) => ['active', 'trial'].includes(s.eff) && (s.status === 'trial' ? s.trialEnd : s.endDate) && (s.status === 'trial' ? s.trialEnd : s.endDate) <= weekAhead).length,
      totalUsers,
      monthlyRevenue: revenueMonth[0]?.total || 0,
      annualRevenue: revenueYear[0]?.total || 0,
    },
    charts: {
      revenue: series(revenueSeries),
      newCompanies: series(companySeries),
      userGrowth: series(userSeries),
      subscriptionGrowth: series(subSeries),
      churn: series(churnSeries),
      usage: series(usageSeries),
    },
  });
});

// ---------------------------------------------------------------- Companies
async function attachSubscriptions(orgs) {
  const ids = orgs.map((o) => o._id);
  const settings = await getPlatformSettings();
  const [subs, userCounts] = await Promise.all([
    CompanySubscription.find({ organizationId: { $in: ids } }).lean(),
    User.aggregate([{ $match: { organizationId: { $in: ids }, active: true } }, { $group: { _id: '$organizationId', n: { $sum: 1 } } }]),
  ]);
  const subBy = Object.fromEntries(subs.map((s) => [String(s.organizationId), s]));
  const usersBy = Object.fromEntries(userCounts.map((u) => [String(u._id), u.n]));
  return orgs.map((o) => {
    const s = subBy[String(o._id)];
    const ev = s ? evaluateSubscription(s, settings) : null;
    return {
      id: String(o._id), name: o.name, legalName: o.legalName, companyCode: o.companyCode, tenantId: o.tenantId, email: o.email, phone: o.phone,
      industry: o.industry, status: o.status || 'active', createdAt: o.createdAt, users: usersBy[String(o._id)] || 0,
      subscription: s ? { planCode: s.planCode, status: ev.status, storedStatus: s.status, billingCycle: s.billingCycle, endDate: s.endDate, trialEnd: s.trialEnd, daysLeft: ev.daysLeft } : null,
    };
  });
}

router.get('/platform/companies', async (req, res) => {
  const { limit, skip, page: p } = page(req);
  const filter = {};
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(String(req.query.q)), 'i');
    filter.$or = [{ name: rx }, { legalName: rx }, { email: rx }, { companyCode: rx }, { tenantId: rx }];
  }
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.plan || req.query.subscriptionStatus) {
    const subFilter = {};
    if (req.query.plan) subFilter.planCode = String(req.query.plan).toUpperCase();
    if (req.query.subscriptionStatus) subFilter.status = String(req.query.subscriptionStatus);
    filter._id = { $in: (await CompanySubscription.find(subFilter).select('organizationId').lean()).map((s) => s.organizationId) };
  }
  const [orgs, total] = await Promise.all([
    Organization.find(filter).select('-settings').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Organization.countDocuments(filter),
  ]);
  res.json({ items: await attachSubscriptions(orgs), total, page: p, limit });
});

const createCompanySchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(160).optional(),
  email: z.string().trim().email(),
  phone: z.string().trim().max(20).optional(),
  industry: z.string().trim().max(60).optional(),
  website: z.string().trim().url().optional().or(z.literal('')),
  taxId: z.string().trim().max(20).optional(),
  address: z.object({ line1: z.string().optional(), city: z.string().optional(), state: z.string().optional(), country: z.string().optional() }).optional(),
  adminName: z.string().trim().min(1).max(80),
  adminEmail: z.string().trim().email(),
  password: z.string().min(8).max(128),
  planCode: z.string().trim().toUpperCase().optional(),
  trial: z.boolean().optional(),
});

router.post('/platform/companies', validate(createCompanySchema), async (req, res) => {
  const d = req.body;
  const { org, admin, plan } = await createCompany({ ...d, website: d.website || undefined, adminEmail: d.adminEmail.toLowerCase() }, { status: 'active', planCode: d.planCode, trial: d.trial !== false });
  await audit(req, 'company.create', { orgId: org._id, module: 'companies', resourceType: 'Organization', resourceId: org._id, details: { plan: plan.code } });
  res.status(201).json({ company: (await attachSubscriptions([org.toObject()]))[0], admin: { id: String(admin._id), email: admin.email, userCode: admin.userCode } });
});

router.get('/platform/companies/:id', async (req, res) => {
  const org = await Organization.findById(idParam(req)).lean();
  if (!org) throw notFound('Company');
  const [company] = await attachSubscriptions([org]);
  const [subscription, usage, recentAudit, payments] = await Promise.all([
    CompanySubscription.findOne({ organizationId: org._id }).lean(),
    usageSummary(org._id),
    AuditLog.find({ organizationId: org._id }).sort({ createdAt: -1 }).limit(20).populate('userId', 'name email').lean(),
    Payment.find({ organizationId: org._id }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  res.json({
    company: { ...company, website: org.website, address: org.address, taxId: org.taxId, moduleOverrides: org.moduleOverrides, suspendedReason: org.suspendedReason },
    subscription, usage, recentAudit, payments,
  });
});

router.patch('/platform/companies/:id', validate(z.object({
  name: z.string().trim().min(2).max(120).optional(), legalName: z.string().max(160).optional(), email: z.string().email().optional(),
  phone: z.string().max(20).optional(), industry: z.string().max(60).optional(), website: z.string().max(200).optional(), taxId: z.string().max(20).optional(),
}).strict()), async (req, res) => {
  const org = await Organization.findByIdAndUpdate(idParam(req), { $set: req.body }, { returnDocument: 'after' }).lean();
  if (!org) throw notFound('Company');
  invalidateTenant(org._id);
  await audit(req, 'company.update', { orgId: org._id, module: 'companies', details: { fields: Object.keys(req.body) } });
  res.json((await attachSubscriptions([org]))[0]);
});

async function setCompanyStatus(req, status, action, reason) {
  const org = await Organization.findByIdAndUpdate(idParam(req), { $set: { status, suspendedReason: status === 'suspended' ? reason : null } }, { returnDocument: 'after' }).lean();
  if (!org) throw notFound('Company');
  invalidateTenant(org._id);
  await audit(req, action, { orgId: org._id, module: 'companies', resourceType: 'Organization', resourceId: org._id, details: { reason } });
  log.info(action, { companyCode: org.companyCode });
  return (await attachSubscriptions([org]))[0];
}

router.post('/platform/companies/:id/approve', async (req, res) => res.json(await setCompanyStatus(req, 'active', 'company.approved')));
router.post('/platform/companies/:id/activate', async (req, res) => res.json(await setCompanyStatus(req, 'active', 'company.activated')));
router.post('/platform/companies/:id/suspend', validate(z.object({ reason: z.string().max(300).optional() })), async (req, res) => {
  const result = await setCompanyStatus(req, 'suspended', 'company.suspended', req.body.reason);
  // Signs every user of the company out immediately
  await User.updateMany({ organizationId: req.params.id }, { $inc: { tokenVersion: 1 } });
  res.json(result);
});

/**
 * Permanently deletes a company and all of its tenant data. The body must repeat the company code.
 * Audit entries are kept for the platform's records.
 */
router.delete('/platform/companies/:id', validate(z.object({ confirm: z.string() })), async (req, res) => {
  const org = await Organization.findById(idParam(req)).lean();
  if (!org) throw notFound('Company');
  if (req.body.confirm !== org.companyCode) throw badRequest('Type the company code to confirm deletion');
  let deleted = 0;
  for (const Model of Object.values(mongoose.models)) {
    if (Model.modelName === 'AuditLog' || !Model.schema.path('organizationId')) continue;
    deleted += (await Model.deleteMany({ organizationId: org._id })).deletedCount || 0;
  }
  await Organization.deleteOne({ _id: org._id });
  invalidateTenant(org._id);
  await audit(req, 'company.deleted', { orgId: org._id, module: 'companies', details: { companyCode: org.companyCode, name: org.name, documents: deleted } });
  log.warn('company.deleted', { companyCode: org.companyCode, documents: deleted });
  res.status(204).end();
});

router.get('/platform/companies/:id/users', async (req, res) => {
  const users = await User.find({ organizationId: idParam(req) }).sort({ name: 1 }).lean();
  res.json({ items: users.map(({ passwordHash: _p, tokenVersion: _t, ...u }) => ({ ...u, id: String(u._id) })) });
});

router.get('/platform/companies/:id/usage', async (req, res) => res.json(await usageSummary(idParam(req))));

const limitsSchema = z.object({
  users: z.number().int().min(-1), customers: z.number().int().min(-1), leads: z.number().int().min(-1), deals: z.number().int().min(-1),
  storageMb: z.number().int().min(-1), apiCallsPerMonth: z.number().int().min(-1), automations: z.number().int().min(-1),
}).partial();

router.put('/platform/companies/:id/subscription', validate(z.object({
  planCode: z.string().trim().toUpperCase(),
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  billingCycle: z.enum(['monthly', 'yearly', 'none']).optional(),
  endDate: z.coerce.date().nullable().optional(),
  customLimits: limitsSchema.nullable().optional(),
})), async (req, res) => {
  const orgId = idParam(req);
  if (!(await Organization.exists({ _id: orgId }))) throw notFound('Company');
  const plan = await findPlan(req.body.planCode);
  if (!plan) throw badRequest('Unknown plan');
  const before = await CompanySubscription.findOne({ organizationId: orgId }).lean();
  const status = req.body.status || 'active';
  const set = {
    planId: plan._id, planCode: plan.code, status, billingCycle: req.body.billingCycle || before?.billingCycle || 'monthly',
    paymentProvider: 'manual', cancelAtPeriodEnd: false,
  };
  // A manual plan change runs until the given end date, or open-ended; a stale past end date is never carried over
  if (status === 'trial') {
    set.trialEnd = req.body.endDate || (before?.trialEnd > new Date() ? before.trialEnd : new Date(Date.now() + 14 * DAY));
    set.endDate = set.trialEnd;
  } else {
    set.endDate = req.body.endDate ?? null;
  }
  if (req.body.customLimits !== undefined) set.customLimits = req.body.customLimits;
  const sub = await CompanySubscription.findOneAndUpdate({ organizationId: orgId }, { $set: set, $setOnInsert: { startDate: new Date() } }, { upsert: true, returnDocument: 'after' });
  invalidateTenant(orgId);
  await audit(req, 'subscription.changed', { orgId, module: 'subscriptions', details: { from: before?.planCode, to: plan.code, status, endDate: sub.endDate } });
  res.json(sub);
});

router.post('/platform/companies/:id/subscription/extend', validate(z.object({ days: z.number().int().min(1).max(3650) })), async (req, res) => {
  const sub = await CompanySubscription.findOne({ organizationId: idParam(req) });
  if (!sub) throw notFound('Subscription');
  const now = new Date();
  const field = sub.status === 'trial' ? 'trialEnd' : 'endDate';
  const base = sub[field] && sub[field] > now ? sub[field] : now;
  sub[field] = new Date(base.getTime() + req.body.days * DAY);
  if (field === 'trialEnd') sub.endDate = sub.trialEnd;
  if (['expired', 'past_due'].includes(sub.status)) sub.status = 'active';
  await sub.save();
  invalidateTenant(sub.organizationId);
  await audit(req, 'subscription.extended', { orgId: sub.organizationId, module: 'subscriptions', details: { days: req.body.days, until: sub[field] } });
  res.json(sub);
});

router.post('/platform/companies/:id/subscription/cancel', validate(z.object({ immediate: z.boolean().optional() })), async (req, res) => {
  const sub = await CompanySubscription.findOne({ organizationId: idParam(req) });
  if (!sub) throw notFound('Subscription');
  sub.status = 'cancelled';
  sub.autoRenew = false;
  sub.cancelledAt = new Date();
  if (req.body.immediate || !sub.endDate) sub.endDate = new Date();
  await sub.save();
  invalidateTenant(sub.organizationId);
  await audit(req, 'subscription.cancelled', { orgId: sub.organizationId, module: 'subscriptions', details: { immediate: Boolean(req.body.immediate), by: 'platform' } });
  res.json(sub);
});

router.put('/platform/companies/:id/modules', validate(z.object({
  enabled: z.array(z.enum(MODULE_KEYS)).default([]),
  disabled: z.array(z.enum(MODULE_KEYS)).default([]),
})), async (req, res) => {
  const org = await Organization.findByIdAndUpdate(idParam(req), { $set: { moduleOverrides: req.body } }, { returnDocument: 'after' }).lean();
  if (!org) throw notFound('Company');
  invalidateTenant(org._id);
  await audit(req, 'company.modules_changed', { orgId: org._id, module: 'modules', details: req.body });
  res.json({ moduleOverrides: org.moduleOverrides });
});

// ---------------------------------------------------------------- Plans, coupons, modules
router.get('/platform/modules', (_req, res) => res.json({ items: MODULES }));

const planSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,29}$/),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(300).optional(),
  currency: z.string().length(3).optional(),
  priceMonthly: z.number().min(0),
  priceYearly: z.number().min(0),
  limits: limitsSchema,
  modules: z.array(z.union([z.enum(MODULE_KEYS), z.literal('*')])),
  isCustom: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

router.get('/platform/plans', async (_req, res) => {
  const [plans, counts] = await Promise.all([
    SubscriptionPlan.find({}).sort({ sortOrder: 1 }).lean(),
    CompanySubscription.aggregate([{ $group: { _id: '$planId', n: { $sum: 1 } } }]),
  ]);
  const by = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  res.json({ items: plans.map((p) => ({ ...p, id: String(p._id), companies: by[String(p._id)] || 0 })) });
});

router.post('/platform/plans', validate(planSchema), async (req, res) => {
  if (await SubscriptionPlan.exists({ code: req.body.code })) throw conflict('Plan code already exists');
  const plan = await SubscriptionPlan.create(req.body);
  await audit(req, 'plan.create', { module: 'plans', resourceType: 'SubscriptionPlan', resourceId: plan._id, details: { code: plan.code } });
  res.status(201).json(plan);
});

router.patch('/platform/plans/:id', validate(planSchema.partial().omit({ code: true })), async (req, res) => {
  const plan = await SubscriptionPlan.findByIdAndUpdate(idParam(req), { $set: req.body }, { returnDocument: 'after', runValidators: true });
  if (!plan) throw notFound('Plan');
  invalidateTenant(); // limits/modules of every company on this plan may change
  await audit(req, 'plan.update', { module: 'plans', resourceType: 'SubscriptionPlan', resourceId: plan._id, details: { fields: Object.keys(req.body) } });
  res.json(plan);
});

/** Plans in use are deactivated (hidden from sale), never deleted. */
router.delete('/platform/plans/:id', async (req, res) => {
  const plan = await SubscriptionPlan.findById(idParam(req));
  if (!plan) throw notFound('Plan');
  if (await CompanySubscription.exists({ planId: plan._id })) {
    plan.active = false;
    plan.isPublic = false;
    await plan.save();
  } else {
    await plan.deleteOne();
  }
  invalidateTenant();
  await audit(req, 'plan.delete', { module: 'plans', resourceType: 'SubscriptionPlan', resourceId: plan._id, details: { code: plan.code } });
  res.status(204).end();
});

const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/),
  percentOff: z.number().min(0).max(100).optional(),
  amountOff: z.number().min(0).optional(),
  planCodes: z.array(z.string().toUpperCase()).optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
  maxRedemptions: z.number().int().min(1).optional(),
  active: z.boolean().optional(),
}).refine((c) => c.percentOff !== undefined || c.amountOff !== undefined, { message: 'percentOff or amountOff is required' });

router.get('/platform/coupons', async (_req, res) => res.json({ items: await Coupon.find({}).sort({ createdAt: -1 }) }));
router.post('/platform/coupons', validate(couponSchema), async (req, res) => {
  if (await Coupon.exists({ code: req.body.code })) throw conflict('Coupon code already exists');
  const coupon = await Coupon.create(req.body);
  await audit(req, 'coupon.create', { module: 'coupons', resourceType: 'Coupon', resourceId: coupon._id, details: { code: coupon.code } });
  res.status(201).json(coupon);
});
router.patch('/platform/coupons/:id', validate(z.object({ active: z.boolean().optional(), validUntil: z.coerce.date().optional(), maxRedemptions: z.number().int().min(1).optional() })), async (req, res) => {
  const coupon = await Coupon.findByIdAndUpdate(idParam(req), { $set: req.body }, { returnDocument: 'after' });
  if (!coupon) throw notFound('Coupon');
  await audit(req, 'coupon.update', { module: 'coupons', resourceType: 'Coupon', resourceId: coupon._id, details: req.body });
  res.json(coupon);
});
router.delete('/platform/coupons/:id', async (req, res) => {
  const coupon = await Coupon.findByIdAndDelete(idParam(req));
  if (!coupon) throw notFound('Coupon');
  await audit(req, 'coupon.delete', { module: 'coupons', details: { code: coupon.code } });
  res.status(204).end();
});

// ---------------------------------------------------------------- Payments, invoices, users, usage, audit
async function withCompanies(items) {
  const orgs = await Organization.find({ _id: { $in: [...new Set(items.filter((i) => i.organizationId).map((i) => String(i.organizationId)))] } }).select('name companyCode').lean();
  const by = Object.fromEntries(orgs.map((o) => [String(o._id), { id: String(o._id), name: o.name, companyCode: o.companyCode }]));
  return items.map((i) => ({ ...i, id: String(i._id), company: by[String(i.organizationId)] || null }));
}

router.get('/platform/payments', async (req, res) => {
  const { limit, skip, page: p } = page(req);
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.companyId && objectId.safeParse(req.query.companyId).success) filter.organizationId = req.query.companyId;
  const [items, total] = await Promise.all([Payment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), Payment.countDocuments(filter)]);
  res.json({ items: await withCompanies(items), total, page: p, limit });
});

router.get('/platform/invoices', async (req, res) => {
  const { limit, skip, page: p } = page(req);
  const [items, total] = await Promise.all([BillingInvoice.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), BillingInvoice.countDocuments({})]);
  res.json({ items: await withCompanies(items), total, page: p, limit });
});

router.get('/platform/users', async (req, res) => {
  const { limit, skip, page: p } = page(req);
  const filter = {};
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(String(req.query.q)), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { userCode: rx }];
  }
  const [items, total] = await Promise.all([
    User.find(filter).select('name email role active lastLogin userCode organizationId createdAt').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ]);
  res.json({ items: await withCompanies(items), total, page: p, limit });
});

router.get('/platform/usage', async (req, res) => {
  const p = String(req.query.period || period());
  const rows = await Usage.find({ period: p }).sort({ apiCalls: -1 }).limit(100).lean();
  res.json({ period: p, items: await withCompanies(rows) });
});

router.get('/platform/audit-logs', async (req, res) => {
  const { limit, skip, page: p } = page(req);
  const filter = {};
  if (req.query.action) filter.action = String(req.query.action);
  if (req.query.actorType) filter.actorType = String(req.query.actorType);
  if (req.query.module) filter.module = String(req.query.module);
  if (req.query.companyId && objectId.safeParse(req.query.companyId).success) filter.organizationId = req.query.companyId;
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('userId', 'name email').populate('platformUserId', 'name email').lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ items: await withCompanies(items), total, page: p, limit });
});

router.get('/platform/login-activity', async (req, res) => {
  const { limit, skip, page: p } = page(req);
  const filter = { action: { $in: ['auth.login', 'auth.switch_company', 'platform.login'] } };
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('userId', 'name email').lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ items: await withCompanies(items), total, page: p, limit });
});

router.get('/platform/system/health', async (_req, res) => {
  const state = ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown';
  let dbPingMs = null;
  try {
    const t = Date.now();
    await mongoose.connection.db.admin().ping();
    dbPingMs = Date.now() - t;
  } catch { /* reported as null */ }
  const mem = process.memoryUsage();
  res.json({
    status: state === 'connected' ? 'ok' : 'degraded',
    database: state,
    dbPingMs,
    environment: process.env.NODE_ENV || 'development',
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    apiCallsThisMonth: (await Usage.aggregate([{ $match: { period: period() } }, { $group: { _id: null, n: { $sum: '$apiCalls' } } }]))[0]?.n || 0,
  });
});

router.get('/platform/settings', async (_req, res) => res.json(await getPlatformSettings()));
router.patch('/platform/settings', validate(z.object({
  trialEnabled: z.boolean(), trialDays: z.number().int().min(0).max(365), trialPlanCode: z.string().toUpperCase(),
  defaultPlanCode: z.string().toUpperCase(), requireApproval: z.boolean(), gracePeriodDays: z.number().int().min(0).max(60),
}).partial()), async (req, res) => {
  for (const key of ['trialPlanCode', 'defaultPlanCode']) {
    if (req.body[key] && !(await findPlan(req.body[key]))) throw badRequest(`Unknown plan ${req.body[key]}`);
  }
  const settings = await PlatformSettings.findOneAndUpdate({ key: 'global' }, { $set: req.body }, { upsert: true, returnDocument: 'after' });
  invalidateTenant();
  await audit(req, 'platform.settings_update', { module: 'platform', details: req.body });
  res.json(settings);
});

router.get('/platform/admins', async (_req, res) => res.json({ items: await PlatformUser.find({}).sort({ createdAt: 1 }) }));
router.post('/platform/admins', validate(z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(12), role: z.enum(['super_admin', 'support']).default('support') })), async (req, res) => {
  if (await PlatformUser.exists({ email: req.body.email.toLowerCase() })) throw conflict('Email already exists');
  const admin = await PlatformUser.create({ ...req.body, email: req.body.email.toLowerCase(), passwordHash: await bcrypt.hash(req.body.password, 12) });
  await audit(req, 'platform.admin_create', { module: 'platform', details: { email: admin.email, role: admin.role } });
  res.status(201).json(admin);
});

router.use('/platform', (_req, _res) => {
  throw new AppError(404, 'Platform route not found', 'NOT_FOUND');
});

export default router;
