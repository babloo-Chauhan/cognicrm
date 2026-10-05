import {
  CompanySubscription, getPlatformSettings, Organization, Role, SubscriptionPlan,
} from '../../models/index.js';
import { resolveModules } from '../../lib/modules.js';
import { ROLE_PERMISSIONS } from '../../lib/permissions.js';
import { ensureDefaultPlans, findPlan } from './plans.js';

const DAY = 86400000;
const TTL_MS = 10000;
const cache = new Map();

/** Drops the cached context after a plan, status, module or role change. */
export function invalidateTenant(orgId) {
  if (orgId) cache.delete(String(orgId));
  else cache.clear();
}

/**
 * Decides what a subscription allows right now. Status is derived from dates as well as the stored value,
 * so an expired trial is restricted immediately even before the expiry job runs.
 */
export function evaluateSubscription(sub, settings, now = new Date()) {
  if (!sub) return { status: 'expired', premium: false, daysLeft: 0 };
  let { status } = sub;
  if (status === 'trial' && sub.trialEnd && sub.trialEnd < now) status = 'expired';
  if (['active', 'cancelled'].includes(status) && sub.endDate && sub.endDate < now) status = 'expired';
  let premium = status === 'trial' || status === 'active';
  if (status === 'cancelled') premium = !sub.endDate || sub.endDate > now; // paid until period end
  if (status === 'past_due') {
    const graceEnd = new Date((sub.endDate || now).getTime() + (settings?.gracePeriodDays ?? 3) * DAY);
    premium = graceEnd > now;
  }
  const end = status === 'trial' ? sub.trialEnd : sub.endDate;
  const daysLeft = end ? Math.max(0, Math.ceil((end - now) / DAY)) : null;
  return { status, premium, daysLeft };
}

async function loadContext(orgId) {
  const org = await Organization.findById(orgId).select('name companyCode tenantId status moduleOverrides settings.timezone').lean();
  if (!org) return null;
  const [sub, settings, roles] = await Promise.all([
    CompanySubscription.findOne({ organizationId: orgId }).lean(),
    getPlatformSettings(),
    Role.find({ organizationId: orgId }).select('key permissions').lean(),
  ]);
  let plan = sub ? await SubscriptionPlan.findById(sub.planId).lean() : null;
  const evaluation = evaluateSubscription(sub, settings);
  let fallbackPlan = await findPlan(settings.defaultPlanCode);
  if (!fallbackPlan) {
    await ensureDefaultPlans();
    fallbackPlan = await findPlan(settings.defaultPlanCode);
  }
  if (!plan) plan = fallbackPlan;
  // A lapsed subscription keeps its data but drops to the default (free) plan's modules and limits.
  const effectivePlan = evaluation.premium ? plan : (fallbackPlan || plan);
  const limits = { ...(effectivePlan?.limits || {}), ...(evaluation.premium ? sub?.customLimits || {} : {}) };
  return {
    orgId: String(orgId),
    company: { id: String(org._id), name: org.name, companyCode: org.companyCode, tenantId: org.tenantId, status: org.status || 'active' },
    subscription: sub ? {
      id: String(sub._id), status: evaluation.status, storedStatus: sub.status, planCode: plan?.code, planName: plan?.name,
      billingCycle: sub.billingCycle, startDate: sub.startDate, endDate: sub.endDate, trialEnd: sub.trialEnd,
      daysLeft: evaluation.daysLeft, autoRenew: sub.autoRenew, cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    } : null,
    premium: evaluation.premium,
    plan: plan ? { code: plan.code, name: plan.name, modules: plan.modules } : null,
    effectivePlanCode: effectivePlan?.code,
    modules: resolveModules(effectivePlan?.modules || [], org.moduleOverrides),
    planModules: resolveModules(plan?.modules || [], org.moduleOverrides),
    limits,
    rolePermissions: Object.fromEntries(roles.map((r) => [r.key, r.permissions])),
    loadedAt: Date.now(),
  };
}

export async function getTenantContext(orgId, { fresh = false } = {}) {
  const key = String(orgId);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.loadedAt < TTL_MS) return hit;
  const ctx = await loadContext(orgId);
  if (ctx) cache.set(key, ctx);
  return ctx;
}

/** Effective permissions of a user: their company's role definition, else the built-in default. */
export function permissionsFor(user, ctx) {
  const fromRole = ctx?.rolePermissions?.[user.role] || ROLE_PERMISSIONS[user.role] || [];
  return [...new Set([...fromRole, ...(user.extraPermissions || [])])];
}
