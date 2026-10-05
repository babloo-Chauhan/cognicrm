import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  AgentStatus, DEFAULT_SETTINGS, Notification, Organization, PushToken, User,
} from '../../models/index.js';
import { requirePermission, signToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/common.js';
import { AppError, badRequest, unauthorized } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import { getTenantContext, invalidateTenant, permissionsFor } from '../saas/tenant.js';
import { createCompany } from '../saas/provisioning.js';

const router = Router();
/** Sign-up and sign-in: mounted before authentication. Everything on `router` runs after it. */
export const publicAuthRouter = Router();

export function publicUser(user, ctx) {
  const { passwordHash: _hash, tokenVersion: _tv, permissions: _p, ...rest } = user.toJSON ? user.toJSON() : user;
  if (rest._id) { rest.id = String(rest._id); delete rest._id; }
  return { ...rest, id: String(user._id || user.id), permissions: permissionsFor(user, ctx) };
}

/** What the client needs about its company: ids, plan, status, modules and limits. */
export function companySession(ctx) {
  if (!ctx) return null;
  return {
    ...ctx.company,
    subscription: ctx.subscription,
    plan: ctx.plan,
    effectivePlanCode: ctx.effectivePlanCode,
    premium: ctx.premium,
    modules: ctx.modules,
    limits: ctx.limits,
  };
}

async function session(user, extra = {}) {
  const ctx = await getTenantContext(user.organizationId, { fresh: true });
  const org = await Organization.findById(user.organizationId);
  return { token: signToken(user, ctx), user: publicUser(user, ctx), organization: org, company: companySession(ctx), ...extra };
}

// India GSTIN (15 chars, state code + PAN + entity + Z + checksum); other countries: generic VAT/tax id
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const optional = (schema) => schema.optional().or(z.literal('').transform(() => undefined));

const registerSchema = z.object({
  // Company
  companyName: z.string().trim().min(2).max(120).optional(),
  organizationName: z.string().trim().min(2).max(120).optional(), // legacy field name
  legalName: optional(z.string().trim().max(160)),
  email: z.string().trim().email(), // business email (also the admin login unless adminEmail is given)
  phone: optional(z.string().trim().regex(/^[+0-9 ()-]{6,20}$/, 'Invalid phone number')),
  country: optional(z.string().trim().max(60)),
  state: optional(z.string().trim().max(60)),
  city: optional(z.string().trim().max(60)),
  address: optional(z.string().trim().max(300)),
  postalCode: optional(z.string().trim().max(12)),
  gstNumber: optional(z.string().trim().toUpperCase().max(20)),
  website: optional(z.string().trim().url('Invalid website URL').max(200)),
  industry: optional(z.string().trim().max(60)),
  // Admin
  name: z.string().trim().min(1).max(80).optional(),
  adminName: z.string().trim().min(1).max(80).optional(),
  adminEmail: optional(z.string().trim().email()),
  password: z.string().min(8).max(128),
  confirmPassword: z.string().optional(),
  // Plan
  planCode: optional(z.string().trim().toUpperCase()),
  trial: z.boolean().optional(),
}).superRefine((d, ctx) => {
  if (!d.companyName && !d.organizationName) ctx.addIssue({ code: 'custom', path: ['companyName'], message: 'Company name is required' });
  if (!d.adminName && !d.name) ctx.addIssue({ code: 'custom', path: ['adminName'], message: 'Admin name is required' });
  if (d.confirmPassword !== undefined && d.confirmPassword !== d.password) ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Passwords do not match' });
  const india = !d.country || /^(in|india)$/i.test(d.country);
  if (d.gstNumber && india && !GSTIN.test(d.gstNumber)) ctx.addIssue({ code: 'custom', path: ['gstNumber'], message: 'Invalid GST number' });
  if (d.gstNumber && !india && !/^[A-Z0-9-]{4,20}$/.test(d.gstNumber)) ctx.addIssue({ code: 'custom', path: ['gstNumber'], message: 'Invalid tax number' });
});

publicAuthRouter.post('/auth/register', validate(registerSchema), async (req, res) => {
  const d = req.body;
  const adminEmail = (d.adminEmail || d.email).toLowerCase();
  const { org, admin, plan, subscription } = await createCompany({
    companyName: d.companyName || d.organizationName,
    legalName: d.legalName,
    email: d.email.toLowerCase(),
    phone: d.phone,
    address: { line1: d.address, city: d.city, state: d.state, country: d.country, postalCode: d.postalCode },
    taxId: d.gstNumber,
    website: d.website,
    industry: d.industry,
    adminName: d.adminName || d.name,
    adminEmail,
    adminPhone: d.phone,
    password: d.password,
  }, { planCode: d.planCode, trial: d.trial !== false });
  await audit(req, 'company.register', {
    orgId: org._id, userId: admin._id, module: 'companies', resourceType: 'Organization', resourceId: org._id,
    details: { companyCode: org.companyCode, plan: plan.code, status: subscription.status },
  });
  log.info('company.registered', { companyCode: org.companyCode, plan: plan.code });
  res.status(201).json(await session(admin, { requestedPlan: d.planCode || null }));
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(128),
  companyCode: optional(z.string().trim().toUpperCase().max(20)), // CMP-000001 or TEN-XXXXXXXX
});

/** All active accounts with this email + password, across companies (one person, several companies). */
async function matchingAccounts(email, password) {
  const users = await User.find({ email: email.toLowerCase(), active: true }).select('+passwordHash');
  const ok = [];
  for (const u of users) if (await bcrypt.compare(password, u.passwordHash)) ok.push(u);
  return ok;
}

async function companiesOf(users) {
  const orgs = await Organization.find({ _id: { $in: users.map((u) => u.organizationId) } }).select('name companyCode status').lean();
  return orgs.map((o) => ({ companyCode: o.companyCode, name: o.name, status: o.status }));
}

async function finishLogin(req, user, accounts) {
  user.lastLogin = new Date();
  await User.updateOne({ _id: user._id }, { lastLogin: user.lastLogin });
  await audit(req, 'auth.login', { orgId: user.organizationId, userId: user._id, module: 'auth' });
  return session(user, { companies: await companiesOf(accounts) });
}

publicAuthRouter.post('/auth/login', validate(loginSchema), async (req, res) => {
  const { email, password, companyCode } = req.body;
  let accounts = await matchingAccounts(email, password);
  if (!accounts.length) {
    log.warn('auth.login_failed', { reason: 'bad_credentials' });
    throw unauthorized('Invalid email or password');
  }
  if (companyCode) {
    const org = await Organization.findOne({ $or: [{ companyCode }, { tenantId: companyCode }] }).select('_id').lean();
    const user = org && accounts.find((u) => String(u.organizationId) === String(org._id));
    if (!user) throw unauthorized('Invalid email or password'); // same message: do not reveal memberships
    return res.json(await finishLogin(req, user, accounts));
  }
  if (accounts.length > 1) {
    accounts = accounts.sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0));
    return res.json({ requiresCompany: true, companies: await companiesOf(accounts) });
  }
  return res.json(await finishLogin(req, accounts[0], accounts));
});

router.get('/auth/me', async (req, res) => {
  const org = await Organization.findById(req.orgId);
  res.json({ user: publicUser(req.user, req.tenant), organization: org, company: companySession(req.tenant) });
});

/**
 * Switches to another company the same person belongs to. The target account's password is required:
 * a shared email alone never proves ownership (any company admin can create a user with any email).
 */
router.post('/auth/switch-company', validate(z.object({ companyCode: z.string().trim().toUpperCase(), password: z.string().min(1) })), async (req, res) => {
  const org = await Organization.findOne({ companyCode: req.body.companyCode }).select('_id').lean();
  const target = org && await User.findOne({ organizationId: org._id, email: req.user.email, active: true }).select('+passwordHash');
  if (!target || !(await bcrypt.compare(req.body.password, target.passwordHash))) throw new AppError(403, 'You do not have access to that company', 'FORBIDDEN');
  await audit(req, 'auth.switch_company', { orgId: target.organizationId, userId: target._id, module: 'auth', details: { from: String(req.orgId) } });
  res.json(await finishLogin(req, target, await matchingAccounts(req.user.email, req.body.password)));
});

/** Ends the session. `all: true` also revokes every other token of this user (all devices). */
router.post('/auth/logout', async (req, res) => {
  if (req.body?.all) await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  await audit(req, 'auth.logout', { module: 'auth', details: { all: Boolean(req.body?.all) } });
  res.status(204).end();
});

// ---------------------------------------------------------------- Company profile & settings
router.get('/organization', async (req, res) => {
  res.json(await Organization.findById(req.orgId));
});

const SETTINGS_KEYS = [
  'defaultCountryCode', 'timezone', 'defaultLanguage', 'languages', 'telephonyProvider', 'smsProvider',
  'whatsappProvider', 'wrapUpSeconds', 'recording', 'transcription', 'compliance', 'fraud', 'customAgentStatuses', 'leadScoring', 'billing',
  'branding', 'currency', 'dateFormat', 'emailSettings', 'notificationSettings', 'invoiceSettings', 'taxSettings',
];

router.patch('/organization/settings', requirePermission('settings:manage'), async (req, res) => {
  const org = await Organization.findById(req.orgId);
  const settings = { ...DEFAULT_SETTINGS(), ...(org.settings || {}) };
  for (const key of SETTINGS_KEYS) {
    if (req.body[key] === undefined) continue;
    const value = req.body[key];
    settings[key] = value && typeof value === 'object' && !Array.isArray(value) && settings[key] && typeof settings[key] === 'object'
      ? { ...settings[key], ...value }
      : value;
  }
  org.settings = settings;
  org.markModified('settings');
  if (req.body.name) org.name = req.body.name;
  await org.save();
  invalidateTenant(req.orgId);
  await audit(req, 'settings.update', { module: 'settings', resourceType: 'Organization', resourceId: org._id, details: { keys: Object.keys(req.body) } });
  res.json(org);
});

const profileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  legalName: z.string().trim().max(160).optional(),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string().trim().max(20).optional(),
  address: z.object({ line1: z.string().max(300).optional(), city: z.string().max(60).optional(), state: z.string().max(60).optional(), country: z.string().max(60).optional(), postalCode: z.string().max(12).optional() }).optional(),
  taxId: z.string().trim().toUpperCase().max(20).optional(),
  website: z.string().trim().url().optional().or(z.literal('')),
  logoUrl: z.string().trim().url().optional().or(z.literal('')),
  industry: z.string().trim().max(60).optional(),
}).strict();

/** Business details of the signed-in company. Platform fields (status, codes, modules) are not editable here. */
router.patch('/company/profile', requirePermission('settings:manage'), validate(profileSchema), async (req, res) => {
  const org = await Organization.findById(req.orgId);
  for (const [k, v] of Object.entries(req.body)) org[k] = v;
  await org.save();
  invalidateTenant(req.orgId);
  await audit(req, 'company.update', { module: 'settings', resourceType: 'Organization', resourceId: org._id, details: { fields: Object.keys(req.body) } });
  res.json(org);
});

// ---------------------------------------------------------------- Push tokens & notifications
router.post('/push-tokens', validate(z.object({ token: z.string().min(10), platform: z.string().optional(), provider: z.enum(['expo', 'fcm']).optional() })), async (req, res) => {
  await PushToken.updateOne(
    { organizationId: req.orgId, userId: req.user._id, token: req.body.token },
    { $set: { platform: req.body.platform, provider: req.body.provider || 'expo' } },
    { upsert: true },
  );
  res.status(204).end();
});

// How many phones can receive pushes (and dial requests) for the signed-in user.
router.get('/push-tokens', async (req, res) => {
  const tokens = await PushToken.find({ organizationId: req.orgId, userId: req.user._id }, 'platform provider').lean();
  res.json({ devices: tokens.length, platforms: [...new Set(tokens.map((t) => t.platform).filter(Boolean))] });
});

router.delete('/push-tokens', async (req, res) => {
  await PushToken.deleteMany({ organizationId: req.orgId, userId: req.user._id, token: req.body?.token });
  res.status(204).end();
});

router.get('/notifications', async (req, res) => {
  const items = await Notification.find({ organizationId: req.orgId, userId: req.user._id }).sort({ createdAt: -1 }).limit(50);
  res.json({ items, unread: await Notification.countDocuments({ organizationId: req.orgId, userId: req.user._id, read: false }) });
});

router.post('/notifications/read', async (req, res) => {
  const filter = { organizationId: req.orgId, userId: req.user._id };
  if (req.body?.ids?.length) {
    if (!req.body.ids.every((id) => /^[a-f0-9]{24}$/i.test(String(id)))) throw badRequest('Invalid notification id');
    filter._id = { $in: req.body.ids };
  }
  await Notification.updateMany(filter, { read: true });
  res.status(204).end();
});

// Agent status document is created lazily for each user
export async function ensureAgentStatus(orgId, userId) {
  return AgentStatus.findOneAndUpdate(
    { userId },
    { $setOnInsert: { organizationId: orgId, userId, status: 'offline', since: new Date() } },
    { upsert: true, returnDocument: 'after' },
  );
}

export default router;
