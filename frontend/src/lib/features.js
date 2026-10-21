/**
 * Optional parts of a plan module a company can switch off so its team sees only what it uses
 * (organization settings `features`; Settings → Company → Features your team uses). `on`: the default.
 */
export const FEATURES = {
  accounts: { module: 'customers', on: false, label: 'Accounts', hint: 'customer companies with several contacts and deals (B2B). Off: a contact’s company is just a text field.' },
  appointments: { module: 'calendar', on: true, label: 'Appointments', hint: 'meetings and site visits at a fixed time, with a reminder before they start.' },
  sales: { module: 'invoices', on: true, label: 'Quotations, invoices & products', hint: 'price list, GST quotations and invoices sent from the CRM, and the sales pipeline.' },
};
