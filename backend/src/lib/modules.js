/**
 * Product modules a subscription plan can switch on. Plans list module keys; `*` means all.
 * `core` is always on (auth, profile, settings, billing, team, notifications) so an expired company
 * can still sign in, pay and manage its account.
 */
export const MODULES = [
  { key: 'crm', label: 'CRM core (dashboard, notes, activities, timeline)' },
  { key: 'leads', label: 'Leads' },
  { key: 'customers', label: 'Customers (contacts & accounts)' },
  { key: 'deals', label: 'Deals & pipelines' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'calendar', label: 'Calendar & appointments' },
  { key: 'email', label: 'Email' },
  { key: 'calling', label: 'Calling & contact center' },
  { key: 'whatsapp', label: 'WhatsApp & SMS inbox' },
  { key: 'reports', label: 'Reports & analytics' },
  { key: 'invoices', label: 'Quotes, invoices & products' },
  { key: 'support', label: 'Support tickets' },
  { key: 'automation', label: 'Automation & campaigns' },
  { key: 'ai', label: 'AI assistant & voice agents' },
  { key: 'import_export', label: 'Import / export' },
  { key: 'api', label: 'API access' },
  { key: 'integrations', label: 'Integrations' },
];

export const MODULE_KEYS = MODULES.map((m) => m.key);

/**
 * First path segment of /api/v1/* → module that must be enabled. Unlisted segments belong to `core`.
 * Kept in one table so new routes are gated by adding a line here instead of touching each router.
 */
export const ROUTE_MODULES = {
  leads: 'leads',
  contacts: 'customers',
  accounts: 'customers',
  'customer-context': 'crm',
  notes: 'crm',
  timeline: 'crm',
  dashboard: 'crm',
  deals: 'deals',
  pipelines: 'deals',
  tasks: 'tasks',
  appointments: 'calendar',
  tickets: 'support',
  orders: 'invoices',
  products: 'invoices',
  quotes: 'invoices',
  invoices: 'invoices',
  sales: 'invoices',
  calls: 'calling',
  'call-queues': 'calling',
  'call-dispositions': 'calling',
  'call-campaigns': 'automation',
  callbacks: 'calling',
  agents: 'calling',
  ivr: 'calling',
  'phone-numbers': 'calling',
  'business-hours': 'calling',
  departments: 'calling',
  recordings: 'calling',
  voicemails: 'calling',
  supervisor: 'calling',
  telephony: 'calling',
  compliance: 'calling',
  alerts: 'calling',
  inbox: 'whatsapp',
  messages: 'whatsapp',
  'message-templates': 'whatsapp',
  analytics: 'reports',
  reports: 'reports',
  ai: 'ai',
  'voice-agents': 'ai',
  integrations: 'integrations',
};

/** Segments under an entity that need an extra module (e.g. /leads/export needs import_export). */
export const SUBROUTE_MODULES = { export: 'import_export', import: 'import_export' };

export function moduleForPath(path) {
  const parts = path.split('/').filter(Boolean);
  const primary = ROUTE_MODULES[parts[0]];
  const extra = parts.slice(1).map((p) => SUBROUTE_MODULES[p]).find(Boolean);
  return [primary, extra].filter(Boolean);
}

/** Modules a company can use: plan modules + platform overrides. */
export function resolveModules(planModules = [], overrides = {}) {
  const set = new Set(planModules.includes('*') ? MODULE_KEYS : planModules);
  for (const m of overrides.enabled || []) set.add(m);
  for (const m of overrides.disabled || []) set.delete(m);
  return [...set].filter((m) => MODULE_KEYS.includes(m));
}
