/**
 * Server-side form rules for records created or edited through the CRUD API (see lib/validation.js).
 * They mirror the web and app form configs, so a bad email or phone is rejected even when a client skips its check.
 */
const text = (key, label, extra = {}) => ({ key, label, ...extra });
const email = { key: 'email', label: 'Email', type: 'email' };
const phone = { key: 'phone', label: 'Phone', type: 'phone' };

export const FIELD_RULES = {
  leads: [
    text('name', 'Name', { required: true, format: 'name' }), email, phone, text('company', 'Company'),
    text('industry', 'Industry'), text('address', 'Address'), text('requirement', 'Requirement', { type: 'textarea' }), text('notes', 'Remarks', { type: 'textarea' }),
    { key: 'estimatedValue', label: 'Estimated value', type: 'number', money: true },
  ],
  contacts: [
    text('firstName', 'First name', { required: true, format: 'name' }), text('lastName', 'Last name', { format: 'name' }),
    email, phone, text('company', 'Company'), text('customerId', 'Customer ID'),
  ],
  accounts: [text('name', 'Name', { required: true }), text('website', 'Website', { format: 'url' }), phone, text('customerId', 'Customer ID')],
  deals: [
    text('name', 'Name', { required: true }), { key: 'value', label: 'Value', type: 'number', money: true },
    { key: 'probability', label: 'Probability', type: 'number', min: 0, max: 100 },
  ],
  tickets: [text('subject', 'Subject', { required: true }), text('description', 'Description', { type: 'textarea' })],
  tasks: [text('title', 'Title', { required: true }), text('description', 'Description', { type: 'textarea' })],
  appointments: [text('title', 'Title', { required: true }), text('notes', 'Notes', { type: 'textarea' })],
  orders: [text('orderNumber', 'Order number', { required: true }), { key: 'amount', label: 'Amount', type: 'number', money: true }],
  products: [
    text('name', 'Name', { required: true }), { key: 'unitPrice', label: 'Price', type: 'number', money: true },
    text('hsnSac', 'HSN / SAC code', { format: 'hsn' }), text('description', 'Description', { type: 'textarea' }),
  ],
};
