/**
 * Field configuration for CRM entities: drives list columns, create/edit forms and detail views.
 * type: text | email | phone | number | select | date | textarea | ref
 */
export const ENTITY_CONFIG = {
  leads: {
    title: 'Leads', singular: 'Lead', type: 'lead', nameOf: (r) => r.name,
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'phone', label: 'Phone', type: 'phone' },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'company', label: 'Company' },
      { key: 'source', label: 'Source', type: 'select', options: ['website', 'referral', 'inbound_call', 'campaign', 'social', 'event', 'cold', 'other'] },
      { key: 'status', label: 'Status', type: 'select', options: ['new', 'contacted', 'qualified', 'unqualified'] },
      { key: 'industry', label: 'Industry' },
      { key: 'companySize', label: 'Company size', type: 'select', options: ['', '1-10', '11-50', '51-200', '201-1000', '1000+'] },
      { key: 'estimatedValue', label: 'Estimated value', type: 'number' },
    ],
    columns: ['name', 'company', 'phone', 'status', 'score', 'source'],
    filters: [{ key: 'status', options: ['new', 'contacted', 'qualified', 'unqualified', 'converted'] }],
  },
  contacts: {
    title: 'Contacts', singular: 'Contact', type: 'contact', nameOf: (r) => `${r.firstName} ${r.lastName || ''}`.trim(),
    fields: [
      { key: 'firstName', label: 'First name', required: true },
      { key: 'lastName', label: 'Last name' },
      { key: 'phone', label: 'Phone', type: 'phone' },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'company', label: 'Company' },
      { key: 'accountId', label: 'Account', type: 'ref', ref: 'accounts' },
      { key: 'customerId', label: 'Customer ID (IVR lookup)' },
      { key: 'doNotCall', label: 'Do not call', type: 'checkbox' },
      { key: 'smsOptOut', label: 'SMS opt-out', type: 'checkbox' },
      { key: 'whatsappOptOut', label: 'WhatsApp opt-out', type: 'checkbox' },
    ],
    columns: ['name', 'company', 'phone', 'email', 'lastContactedAt'],
  },
  accounts: {
    title: 'Accounts', singular: 'Account', type: 'account', nameOf: (r) => r.name,
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'industry', label: 'Industry' },
      { key: 'size', label: 'Size' },
      { key: 'website', label: 'Website' },
      { key: 'phone', label: 'Phone', type: 'phone' },
      { key: 'customerId', label: 'Customer ID' },
    ],
    columns: ['name', 'industry', 'phone', 'website'],
  },
  deals: {
    title: 'Deals', singular: 'Deal', type: 'deal', nameOf: (r) => r.name,
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'value', label: 'Value', type: 'number' },
      { key: 'stage', label: 'Stage', type: 'select', options: ['prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost'] },
      { key: 'expectedCloseDate', label: 'Expected close', type: 'date' },
      { key: 'contactId', label: 'Contact', type: 'ref', ref: 'contacts' },
      { key: 'accountId', label: 'Account', type: 'ref', ref: 'accounts' },
    ],
    columns: ['name', 'stage', 'value', 'score', 'expectedCloseDate'],
    filters: [{ key: 'stage', options: ['prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost'] }],
  },
  tickets: {
    title: 'Tickets', singular: 'Ticket', type: 'ticket', nameOf: (r) => r.subject,
    fields: [
      { key: 'subject', label: 'Subject', required: true },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'status', label: 'Status', type: 'select', options: ['open', 'pending', 'resolved', 'closed'] },
      { key: 'priority', label: 'Priority', type: 'select', options: ['low', 'medium', 'high', 'urgent'] },
      { key: 'contactId', label: 'Contact', type: 'ref', ref: 'contacts' },
    ],
    columns: ['subject', 'status', 'priority', 'createdAt'],
    filters: [{ key: 'status', options: ['open', 'pending', 'resolved', 'closed'] }],
  },
  tasks: {
    title: 'Tasks', singular: 'Task', type: 'task', nameOf: (r) => r.title,
    fields: [
      { key: 'title', label: 'Title', required: true },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'dueAt', label: 'Due', type: 'datetime' },
      { key: 'priority', label: 'Priority', type: 'select', options: ['low', 'medium', 'high'] },
      { key: 'status', label: 'Status', type: 'select', options: ['open', 'done', 'cancelled'] },
    ],
    columns: ['title', 'dueAt', 'priority', 'status', 'source'],
    filters: [{ key: 'status', options: ['open', 'done', 'cancelled'] }],
  },
  products: {
    title: 'Products', singular: 'Product', type: 'product', nameOf: (r) => r.name, noDetail: true, noImportExport: true,
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'sku', label: 'SKU / code' },
      { key: 'unitPrice', label: 'Price (excl. GST)', type: 'number' },
      { key: 'unit', label: 'Unit (nos, hrs, user…)' },
      { key: 'taxRate', label: 'GST %', type: 'select', options: ['0', '0.25', '3', '5', '12', '18', '28'] },
      { key: 'hsnSac', label: 'HSN / SAC code' },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'active', label: 'Active (available on quotations)', type: 'checkbox' },
    ],
    columns: ['name', 'sku', 'unitPrice', 'taxRate', 'hsnSac', 'active'],
  },
};
