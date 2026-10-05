/**
 * Permission catalog and built-in roles. Permissions are `resource:action`; `*` grants everything and
 * `resource:*` grants every action on a resource. Companies create custom roles from this catalog.
 */
const crud = (resource, label) => ['create', 'read', 'update', 'delete'].map((a) => ({ key: `${resource}:${a}`, label: `${label}: ${a}` }));

export const PERMISSION_GROUPS = [
  { group: 'Team', permissions: [...crud('users', 'Users'), { key: 'roles:manage', label: 'Manage roles & permissions' }] },
  { group: 'Leads', permissions: crud('leads', 'Leads') },
  { group: 'Customers', permissions: [...crud('contacts', 'Contacts'), ...crud('accounts', 'Accounts')] },
  { group: 'Deals', permissions: [...crud('deals', 'Deals'), { key: 'pipelines:manage', label: 'Manage pipelines' }] },
  { group: 'Work', permissions: [...crud('tasks', 'Tasks'), ...crud('notes', 'Notes'), ...crud('appointments', 'Appointments')] },
  { group: 'Support', permissions: crud('tickets', 'Tickets') },
  { group: 'Sales documents', permissions: [{ key: 'sales:read', label: 'View quotes, invoices, products' }, { key: 'sales:write', label: 'Create & edit quotes, invoices, products' }, ...crud('orders', 'Orders')] },
  { group: 'Data', permissions: [{ key: 'crm:read', label: 'Read CRM (assistant tools)' }, { key: 'crm:write', label: 'Write CRM (assistant tools)' }, { key: 'crm:import', label: 'Import data' }, { key: 'crm:export', label: 'Export data' }] },
  { group: 'Reports', permissions: [{ key: 'analytics:read', label: 'Reports & analytics' }, { key: 'audit:read', label: 'Audit log' }] },
  {
    group: 'Calling',
    permissions: [
      { key: 'calls:make', label: 'Make calls' }, { key: 'calls:read_all', label: 'See all calls' }, { key: 'calls:control_all', label: 'Control any call' },
      { key: 'recordings:read', label: 'All recordings' }, { key: 'recordings:read_own', label: 'Own recordings' }, { key: 'transcripts:read', label: 'Transcripts' },
      { key: 'queues:manage', label: 'Queues' }, { key: 'agents:manage', label: 'Agents' }, { key: 'supervisor:*', label: 'Supervisor tools' },
      { key: 'campaigns:manage', label: 'Campaigns' }, { key: 'callbacks:manage', label: 'Callbacks' }, { key: 'numbers:manage', label: 'Phone numbers' },
      { key: 'numbers:view_full', label: 'See full numbers' }, { key: 'ivr:manage', label: 'IVR' }, { key: 'business_hours:manage', label: 'Business hours' },
      { key: 'dispositions:manage', label: 'Dispositions' }, { key: 'voicemail:all', label: 'All voicemail' }, { key: 'compliance:manage', label: 'Compliance' },
      { key: 'alerts:read', label: 'Fraud alerts' },
    ],
  },
  { group: 'Messaging', permissions: [{ key: 'inbox:all', label: 'Whole inbox' }, { key: 'messages:send', label: 'Send messages' }, { key: 'templates:manage', label: 'Message templates' }] },
  { group: 'AI', permissions: [{ key: 'ai:use', label: 'Use AI assistant' }, { key: 'voice_agents:manage', label: 'Voice agents' }] },
  { group: 'Administration', permissions: [{ key: 'settings:manage', label: 'Company settings' }, { key: 'billing:manage', label: 'Subscription & billing' }] },
];

export const PERMISSION_KEYS = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));

/** True when `permission` is a catalog key or a wildcard over one. */
export function isValidPermission(permission) {
  if (permission === '*') return true;
  if (permission.endsWith(':*')) return PERMISSION_KEYS.some((k) => k.startsWith(permission.slice(0, -1)));
  return PERMISSION_KEYS.includes(permission);
}

export function permissionMatches(granted, permission) {
  return granted.some((p) => p === '*' || p === permission || (p.endsWith(':*') && permission.startsWith(p.slice(0, -1))));
}

const CRM_ALL = ['crm:*', 'leads:*', 'contacts:*', 'accounts:*', 'deals:*', 'tickets:*', 'tasks:*', 'notes:*', 'appointments:*', 'orders:*', 'sales:*'];
const WORK = ['tasks:*', 'notes:*', 'appointments:*'];

/** Built-in roles every company gets. Keys are stable (stored on users); names and permissions are editable. */
export const DEFAULT_ROLES = [
  { key: 'admin', name: 'Company Admin', description: 'Full access to the company workspace', permissions: ['*'] },
  {
    key: 'supervisor',
    name: 'Manager',
    description: 'Runs the team: CRM, reports, contact center supervision',
    permissions: [
      ...CRM_ALL, 'users:read', 'pipelines:manage', 'calls:make', 'calls:read_all', 'calls:control_all', 'recordings:read', 'transcripts:read',
      'queues:manage', 'agents:manage', 'supervisor:*', 'campaigns:manage', 'callbacks:manage', 'analytics:read',
      'inbox:all', 'messages:send', 'numbers:view_full', 'ivr:manage', 'business_hours:manage', 'dispositions:manage',
      'voicemail:all', 'compliance:manage', 'ai:use', 'alerts:read', 'billing:manage',
    ],
  },
  { key: 'sales_manager', name: 'Sales Manager', description: 'Owns the sales pipeline and team reports', permissions: [...CRM_ALL, 'users:read', 'pipelines:manage', 'analytics:read', 'calls:make', 'calls:read_all', 'messages:send', 'ai:use', 'campaigns:manage'] },
  {
    key: 'sales_executive',
    name: 'Sales Executive',
    description: 'Works leads, customers and deals',
    permissions: ['crm:read', 'crm:write', 'leads:*', 'contacts:*', 'accounts:*', 'deals:create', 'deals:read', 'deals:update', ...WORK, 'sales:*', 'calls:make', 'messages:send', 'ai:use', 'recordings:read_own'],
  },
  { key: 'support_manager', name: 'Support Manager', description: 'Runs support tickets and the inbox', permissions: ['crm:*', 'tickets:*', 'contacts:*', 'accounts:read', ...WORK, 'analytics:read', 'inbox:all', 'messages:send', 'templates:manage', 'calls:make', 'calls:read_all', 'ai:use'] },
  { key: 'support_agent', name: 'Support Agent', description: 'Handles tickets and customer messages', permissions: ['crm:read', 'tickets:create', 'tickets:read', 'tickets:update', 'contacts:read', 'contacts:update', 'accounts:read', ...WORK, 'messages:send', 'calls:make', 'ai:use'] },
  { key: 'hr_manager', name: 'HR Manager', description: 'Manages people records', permissions: ['users:create', 'users:read', 'users:update', 'leads:read', 'contacts:read', 'accounts:read', 'deals:read', ...WORK] },
  { key: 'accountant', name: 'Accountant', description: 'Quotes, invoices, payments and subscription billing', permissions: ['sales:*', 'orders:*', 'accounts:read', 'contacts:read', 'deals:read', 'analytics:read', 'billing:manage', ...WORK] },
  { key: 'employee', name: 'Employee', description: 'Own tasks and read-only CRM', permissions: ['leads:read', 'contacts:read', 'accounts:read', 'deals:read', ...WORK] },
  // Legacy built-in roles kept for existing users
  { key: 'agent', name: 'Agent', description: 'Contact-center agent', permissions: [...CRM_ALL, 'calls:make', 'messages:send', 'ai:use', 'recordings:read_own', 'transcripts:read'] },
  { key: 'user', name: 'User', description: 'Standard CRM user', permissions: [...CRM_ALL, 'ai:use'] },
];

export const ROLE_PERMISSIONS = Object.fromEntries(DEFAULT_ROLES.map((r) => [r.key, r.permissions]));
