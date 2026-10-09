import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  CompanySubscription, DEFAULT_SETTINGS, getPlatformSettings, nextPlatformSeq, Organization, Pipeline, Role, User,
} from '../../models/index.js';
import { DEFAULT_ROLES } from '../../lib/permissions.js';
import { badRequest } from '../../lib/errors.js';
import { seedOrganization } from '../auth/seed.js';
import { ensureDefaultPlans, findPlan } from './plans.js';
import { invalidateTenant } from './tenant.js';

const DAY = 86400000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export const DEFAULT_PIPELINE = {
  name: 'Sales pipeline',
  isDefault: true,
  stages: [
    { key: 'prospecting', label: 'Prospecting', probability: 10 },
    { key: 'qualification', label: 'Qualification', probability: 25 },
    { key: 'proposal', label: 'Proposal', probability: 50 },
    { key: 'negotiation', label: 'Negotiation', probability: 75 },
    { key: 'won', label: 'Won', probability: 100 },
    { key: 'lost', label: 'Lost', probability: 0 },
  ],
};

export function randomTenantId() {
  const bytes = crypto.randomBytes(8);
  return `TEN-${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`;
}

const pad = (n) => String(n).padStart(6, '0');
export const nextCompanyCode = async () => `CMP-${pad(await nextPlatformSeq('company'))}`;
export const nextUserCode = async () => `USR-${pad(await nextPlatformSeq('user'))}`;

function slugify(name) {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Built-in roles, default pipeline and the per-company calling defaults. Idempotent. */
export async function seedCompanyDefaults(orgId) {
  await Role.bulkWrite(DEFAULT_ROLES.map((r) => ({
    updateOne: { filter: { organizationId: orgId, key: r.key }, update: { $setOnInsert: { ...r, organizationId: orgId, system: true } }, upsert: true },
  })));
  if (!(await Pipeline.exists({ organizationId: orgId }))) await Pipeline.create({ ...DEFAULT_PIPELINE, organizationId: orgId });
}

/**
 * Starts a subscription: the requested plan if it is free, otherwise the platform trial (if enabled),
 * otherwise the default free plan. Paid plans become active only after a verified payment.
 */
/**
 * `assigned`: the plan was picked by a super admin, so with no trial it is granted directly
 * instead of falling back to the default (free) plan that unpaid self-signups get.
 */
export async function startSubscription(orgId, { planCode, trial = true, assigned = false } = {}) {
  await ensureDefaultPlans();
  const settings = await getPlatformSettings();
  const now = new Date();
  const requested = planCode ? await findPlan(planCode) : null;
  if (planCode && (!requested || !requested.active)) throw badRequest('Unknown plan');
  let plan; let status; let trialEnd = null; let endDate = null;
  if (requested && ((requested.priceMonthly === 0 && !requested.isCustom) || (assigned && !trial))) {
    plan = requested; status = 'active';
  } else if (trial && settings.trialEnabled && settings.trialDays > 0) {
    // Trial runs on the plan the company picked (if any), else the platform's trial plan
    plan = requested || await findPlan(settings.trialPlanCode) || await findPlan('PROFESSIONAL');
    status = 'trial';
    trialEnd = new Date(now.getTime() + settings.trialDays * DAY);
    endDate = trialEnd;
  } else {
    plan = await findPlan(settings.defaultPlanCode) || await findPlan('FREE');
    status = 'active';
  }
  const sub = await CompanySubscription.findOneAndUpdate(
    { organizationId: orgId },
    {
      $set: {
        planId: plan._id, planCode: plan.code, status, billingCycle: status === 'trial' ? 'none' : 'monthly',
        startDate: now, endDate, trialStart: status === 'trial' ? now : null, trialEnd, autoRenew: false, cancelAtPeriodEnd: false,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  invalidateTenant(orgId);
  return { subscription: sub, plan };
}

/**
 * Creates a company with its admin, roles, pipeline, settings and subscription.
 * Caller is responsible for checking that the admin email is not already registered.
 */
export async function createCompany(input, { status, planCode, trial = true, assigned = false } = {}) {
  const settings = await getPlatformSettings();
  const companyStatus = status || (settings.requireApproval ? 'pending' : 'active');
  const defaults = DEFAULT_SETTINGS();
  defaults.billing = {
    ...defaults.billing, companyName: input.legalName || input.companyName, gstin: input.taxId || '', email: input.email || '', phone: input.phone || '',
    state: input.address?.state || '', address: [input.address?.line1, input.address?.city, input.address?.state].filter(Boolean).join(', '),
  };
  defaults.branding = { ...defaults.branding, brandName: input.companyName };
  const org = await Organization.create({
    name: input.companyName,
    legalName: input.legalName,
    slug: slugify(input.companyName),
    companyCode: await nextCompanyCode(),
    tenantId: randomTenantId(),
    email: input.email,
    phone: input.phone,
    address: input.address,
    taxId: input.taxId,
    website: input.website,
    industry: input.industry,
    status: companyStatus,
    settings: defaults,
  });
  try {
    const admin = await User.create({
      organizationId: org._id,
      userCode: await nextUserCode(),
      name: input.adminName,
      email: input.adminEmail,
      phone: input.adminPhone,
      passwordHash: await bcrypt.hash(input.password, 10),
      role: 'admin',
      designation: 'Administrator',
    });
    await seedCompanyDefaults(org._id);
    await seedOrganization(org._id);
    const { subscription, plan } = await startSubscription(org._id, { planCode, trial, assigned });
    return { org, admin, subscription, plan };
  } catch (err) {
    // Do not leave a half-created tenant behind
    await Promise.all([
      Organization.deleteOne({ _id: org._id }), User.deleteMany({ organizationId: org._id }),
      Role.deleteMany({ organizationId: org._id }), Pipeline.deleteMany({ organizationId: org._id }),
      CompanySubscription.deleteMany({ organizationId: org._id }),
    ]).catch(() => null);
    throw err;
  }
}
