import { SubscriptionPlan } from '../../models/index.js';

const GB = 1024;

/**
 * Starting catalog, inserted only when a plan code does not exist yet. After that the platform owner edits
 * plans from the super-admin UI; nothing in the app reads these constants for limits.
 */
export const DEFAULT_PLANS = [
  {
    code: 'FREE', name: 'Free', sortOrder: 1, priceMonthly: 0, priceYearly: 0,
    description: 'Get started with leads and tasks',
    limits: { users: 2, customers: 100, leads: 100, deals: 100, storageMb: 1 * GB, apiCallsPerMonth: 10000, automations: 0 },
    modules: ['crm', 'leads', 'tasks'],
  },
  {
    code: 'STARTER', name: 'Starter', sortOrder: 2, priceMonthly: 999, priceYearly: 9990,
    description: 'Small teams managing customers and deals',
    limits: { users: 5, customers: 1000, leads: 1000, deals: 1000, storageMb: 10 * GB, apiCallsPerMonth: 100000, automations: 5 },
    modules: ['crm', 'leads', 'customers', 'deals', 'tasks', 'calendar', 'email', 'import_export'],
  },
  {
    code: 'PROFESSIONAL', name: 'Professional', sortOrder: 3, priceMonthly: 2999, priceYearly: 29990,
    description: 'Growing sales teams with reports and automation',
    limits: { users: 20, customers: 10000, leads: 10000, deals: 10000, storageMb: 50 * GB, apiCallsPerMonth: 1000000, automations: 50 },
    modules: ['crm', 'leads', 'customers', 'deals', 'tasks', 'calendar', 'email', 'import_export', 'reports', 'automation', 'invoices', 'support', 'whatsapp'],
  },
  {
    code: 'BUSINESS', name: 'Business', sortOrder: 4, priceMonthly: 7999, priceYearly: 79990,
    description: 'Contact center, AI and API for larger teams',
    limits: { users: 100, customers: -1, leads: -1, deals: -1, storageMb: 250 * GB, apiCallsPerMonth: 5000000, automations: -1 },
    modules: ['crm', 'leads', 'customers', 'deals', 'tasks', 'calendar', 'email', 'import_export', 'reports', 'automation', 'invoices', 'support', 'whatsapp', 'calling', 'ai', 'api', 'integrations'],
  },
  {
    code: 'ENTERPRISE', name: 'Enterprise', sortOrder: 5, priceMonthly: 0, priceYearly: 0, isCustom: true,
    description: 'Everything, custom limits and pricing',
    limits: { users: -1, customers: -1, leads: -1, deals: -1, storageMb: -1, apiCallsPerMonth: -1, automations: -1 },
    modules: ['*'],
  },
];

export async function ensureDefaultPlans() {
  for (const plan of DEFAULT_PLANS) {
    await SubscriptionPlan.updateOne({ code: plan.code }, { $setOnInsert: plan }, { upsert: true });
  }
}

export async function findPlan(code) {
  if (!code) return null;
  return SubscriptionPlan.findOne({ code: String(code).toUpperCase() }).lean();
}
