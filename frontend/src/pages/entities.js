import { validateForm } from '../lib/validation.js';

/**
 * Field configuration for CRM entities: drives list columns, create/edit forms and detail views.
 * type: text | email | phone | number | select | date | textarea | ref | user (a team member)
 * Validation (lib/validation.js): required, format (name | url | hsn …), money (no negatives), min / max.
 */
export const ENTITY_CONFIG = {
  leads: {
    title: 'Leads', singular: 'Lead', type: 'lead', nameOf: (r) => r.name,
    fields: [
      { key: 'name', label: 'Name', required: true, format: 'name' },
      { key: 'phone', label: 'Phone', type: 'phone' },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'company', label: 'Company' },
      { key: 'ownerId', label: 'Assigned to', type: 'user' },
      { key: 'source', label: 'Source', type: 'select', options: ['website', 'referral', 'inbound_call', 'campaign', 'social', 'event', 'cold', 'other'] },
      { key: 'status', label: 'Status', type: 'select', options: ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'unqualified'] },
      { key: 'requirement', label: 'Requirement', type: 'textarea', placeholder: 'What does the customer need? Product, quantity, budget…' },
      { key: 'notes', label: 'Remarks', type: 'textarea', placeholder: 'Anything the team should know' },
      { key: 'nextFollowUpAt', label: 'Next follow-up', type: 'datetime' },
      { key: 'industry', label: 'Industry' },
      { key: 'companySize', label: 'Company size', type: 'select', options: ['', '1-10', '11-50', '51-200', '201-1000', '1000+'] },
      { key: 'estimatedValue', label: 'Estimated value', type: 'number', money: true },
    ],
    columns: ['name', 'company', 'phone', 'status', 'score', 'nextFollowUpAt', 'ownerId'],
    ownerFilter: true,
    filters: [{ key: 'status', options: ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'unqualified', 'converted'] }],
  },
  contacts: {
    title: 'Contacts', singular: 'Contact', type: 'contact', nameOf: (r) => `${r.firstName} ${r.lastName || ''}`.trim(),
    fields: [
      { key: 'firstName', label: 'First name', required: true, format: 'name' },
      { key: 'lastName', label: 'Last name', format: 'name' },
      { key: 'phone', label: 'Phone', type: 'phone' },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'company', label: 'Company' },
      { key: 'accountId', label: 'Account', type: 'ref', ref: 'accounts' },
      { key: 'ownerId', label: 'Assigned to', type: 'user' },
      { key: 'customerId', label: 'Customer ID (IVR lookup)' },
      { key: 'doNotCall', label: 'Do not call', type: 'checkbox' },
      { key: 'smsOptOut', label: 'SMS opt-out', type: 'checkbox' },
      { key: 'whatsappOptOut', label: 'WhatsApp opt-out', type: 'checkbox' },
    ],
    columns: ['name', 'company', 'phone', 'email', 'ownerId', 'lastContactedAt'],
  },
  accounts: {
    title: 'Accounts', singular: 'Account', type: 'account', nameOf: (r) => r.name,
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'industry', label: 'Industry' },
      { key: 'size', label: 'Size' },
      { key: 'website', label: 'Website', format: 'url' },
      { key: 'phone', label: 'Phone', type: 'phone' },
      { key: 'ownerId', label: 'Assigned to', type: 'user' },
      { key: 'customerId', label: 'Customer ID' },
    ],
    columns: ['name', 'industry', 'phone', 'website', 'ownerId'],
  },
  deals: {
    title: 'Deals', singular: 'Deal', type: 'deal', nameOf: (r) => r.name,
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'value', label: 'Value', type: 'number', money: true },
      { key: 'stage', label: 'Stage', type: 'select', options: ['prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost'] },
      { key: 'expectedCloseDate', label: 'Expected close', type: 'date' },
      { key: 'contactId', label: 'Contact', type: 'ref', ref: 'contacts' },
      { key: 'accountId', label: 'Account', type: 'ref', ref: 'accounts' },
      { key: 'ownerId', label: 'Assigned to', type: 'user' },
    ],
    columns: ['name', 'stage', 'value', 'score', 'expectedCloseDate', 'ownerId'],
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
      { key: 'unitPrice', label: 'Price (excl. GST)', type: 'number', money: true },
      { key: 'unit', label: 'Unit (nos, hrs, user…)' },
      { key: 'taxRate', label: 'GST %', type: 'select', options: ['0', '0.25', '3', '5', '12', '18', '28'] },
      { key: 'hsnSac', label: 'HSN / SAC code', format: 'hsn' },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'active', label: 'Active (available on quotations)', type: 'checkbox' },
    ],
    columns: ['name', 'sku', 'unitPrice', 'taxRate', 'hsnSac', 'active'],
  },
};

/** Field problems for a create / edit form ({ key: message }); empty when it can be saved. */
export const validateEntity = (entity, value) => validateForm(ENTITY_CONFIG[entity].fields, value);
