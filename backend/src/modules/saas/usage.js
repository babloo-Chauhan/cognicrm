import {
  Account, CallCampaign, Contact, Deal, Lead, Usage, User,
} from '../../models/index.js';
import { AppError } from '../../lib/errors.js';
import { getTenantContext } from './tenant.js';

export const period = (d = new Date()) => d.toISOString().slice(0, 7);

const LIMIT_LABELS = { users: 'User', customers: 'Customer', leads: 'Lead', deals: 'Deal', apiCallsPerMonth: 'Monthly API call', automations: 'Automation' };

/** Live record counts for the limited resources. */
const COUNTERS = {
  users: (orgId) => User.countDocuments({ organizationId: orgId, active: true }),
  customers: async (orgId) => (await Contact.countDocuments({ organizationId: orgId })) + (await Account.countDocuments({ organizationId: orgId })),
  leads: (orgId) => Lead.countDocuments({ organizationId: orgId }),
  deals: (orgId) => Deal.countDocuments({ organizationId: orgId }),
  automations: (orgId) => CallCampaign.countDocuments({ organizationId: orgId }), // campaigns are the automations
};

export class PlanLimitError extends AppError {
  constructor(resource, limit, used) {
    super(403, `${LIMIT_LABELS[resource] || resource} limit reached (${used}/${limit}). Upgrade your plan.`, 'PLAN_LIMIT_REACHED', { resource, limit, used });
  }
}

/** Throws PLAN_LIMIT_REACHED when adding `adding` records would pass the company's plan limit. */
export async function checkLimit(orgId, resource, adding = 1) {
  const ctx = await getTenantContext(orgId);
  const limit = ctx?.limits?.[resource];
  if (limit === undefined || limit === null || limit < 0) return;
  const used = await COUNTERS[resource](orgId);
  if (used + adding > limit) throw new PlanLimitError(resource, limit, used);
}

/** Remaining capacity (Infinity when unlimited); used by bulk import to reject oversized files up front. */
export async function remaining(orgId, resource) {
  const ctx = await getTenantContext(orgId);
  const limit = ctx?.limits?.[resource];
  if (limit === undefined || limit === null || limit < 0) return Infinity;
  return Math.max(0, limit - await COUNTERS[resource](orgId));
}

// API calls are counted in memory and flushed in batches, so counting never adds a write per request.
const pendingApiCalls = new Map();
const knownApiCalls = new Map(); // `${org}:${period}` → count at last flush/load

export function recordApiCall(orgId) {
  const key = `${orgId}:${period()}`;
  pendingApiCalls.set(key, (pendingApiCalls.get(key) || 0) + 1);
}

export async function flushUsage() {
  const entries = [...pendingApiCalls.entries()];
  pendingApiCalls.clear();
  await Promise.all(entries.map(async ([key, n]) => {
    const [orgId, p] = key.split(':');
    const doc = await Usage.findOneAndUpdate({ organizationId: orgId, period: p }, { $inc: { apiCalls: n } }, { upsert: true, returnDocument: 'after' });
    knownApiCalls.set(key, doc.apiCalls);
  }));
}

export async function apiCallsThisMonth(orgId) {
  const key = `${orgId}:${period()}`;
  if (!knownApiCalls.has(key)) {
    const doc = await Usage.findOne({ organizationId: orgId, period: period() }).lean();
    knownApiCalls.set(key, doc?.apiCalls || 0);
  }
  return knownApiCalls.get(key) + (pendingApiCalls.get(key) || 0);
}

export function resetUsageCounters() {
  pendingApiCalls.clear();
  knownApiCalls.clear();
}

/** Used / limit for every tracked resource (billing page and super-admin company view). */
export async function usageSummary(orgId) {
  const ctx = await getTenantContext(orgId);
  const [users, customers, leads, deals, automations, apiCalls, usageDoc] = await Promise.all([
    COUNTERS.users(orgId), COUNTERS.customers(orgId), COUNTERS.leads(orgId), COUNTERS.deals(orgId), COUNTERS.automations(orgId),
    apiCallsThisMonth(orgId), Usage.findOne({ organizationId: orgId, period: period() }).lean(),
  ]);
  const l = ctx?.limits || {};
  const row = (used, limit) => ({ used, limit: limit ?? -1 });
  return {
    period: period(),
    users: row(users, l.users),
    customers: row(customers, l.customers),
    leads: row(leads, l.leads),
    deals: row(deals, l.deals),
    storageMb: row(Math.round((usageDoc?.storageBytes || 0) / 1048576), l.storageMb),
    apiCalls: row(apiCalls, l.apiCallsPerMonth),
    automations: row(automations, l.automations),
  };
}
