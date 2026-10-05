import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { model, ObjectId } from './plugins.js';

const { Schema } = mongoose;

const publicToken = () => crypto.randomBytes(24).toString('base64url');

const productSchema = new Schema({
  name: { type: String, required: true },
  sku: String,
  description: String,
  unitPrice: { type: Number, default: 0, min: 0 },
  unit: { type: String, default: 'nos' },
  taxRate: { type: Number, default: 18, min: 0, max: 100 }, // GST %
  hsnSac: String,
  active: { type: Boolean, default: true },
});
export const Product = model('Product', productSchema);

/** Per-organization sequence for gap-free document numbers (GST requires consecutive invoice numbers). */
const counterSchema = new Schema({
  key: { type: String, required: true }, // e.g. "invoice:2026-27"
  seq: { type: Number, default: 0 },
});
counterSchema.index({ organizationId: 1, key: 1 }, { unique: true });
export const Counter = model('Counter', counterSchema);

const lineItemSchema = new Schema({
  productId: { type: ObjectId, ref: 'Product' },
  name: { type: String, required: true },
  description: String,
  hsnSac: String,
  quantity: { type: Number, default: 1, min: 0 },
  unit: String,
  unitPrice: { type: Number, default: 0, min: 0 },
  discountPercent: { type: Number, default: 0, min: 0, max: 100 },
  taxRate: { type: Number, default: 0, min: 0, max: 100 },
  // Calculated by the server
  amount: Number, // quantity × price − discount (taxable value)
  taxAmount: Number,
  total: Number,
}, { _id: false });

const totalsSchema = new Schema({
  subtotal: Number, // before discounts
  discountTotal: Number,
  taxableAmount: Number,
  cgst: Number,
  sgst: Number,
  igst: Number,
  taxTotal: Number,
  roundOff: Number,
  total: Number,
}, { _id: false });

/** Who the document is addressed to. Copied onto the document so later CRM edits don't change issued paperwork. */
const partySchema = new Schema({
  name: String,
  company: String,
  email: String,
  phone: String,
  gstin: String,
  address: String,
  state: String, // place of supply; decides CGST+SGST vs IGST
}, { _id: false });

const commonDocFields = {
  title: String,
  dealId: { type: ObjectId, ref: 'Deal', index: true },
  contactId: { type: ObjectId, ref: 'Contact', index: true },
  accountId: { type: ObjectId, ref: 'Account', index: true },
  ownerId: { type: ObjectId, ref: 'User' },
  customer: { type: partySchema, default: () => ({}) },
  currency: { type: String, default: 'INR' },
  taxMode: { type: String, enum: ['auto', 'intra', 'inter', 'none'], default: 'auto' },
  appliedTaxMode: { type: String, enum: ['intra', 'inter', 'none'] },
  items: [lineItemSchema],
  extraDiscount: { type: Number, default: 0, min: 0 }, // flat amount off the taxable value
  totals: { type: totalsSchema, default: () => ({}) },
  notes: String,
  terms: String,
  publicToken: { type: String, default: publicToken, index: true },
  sentAt: Date,
  viewedAt: Date, // first time the customer opened the link
};

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired', 'revised'];
const quoteSchema = new Schema({
  ...commonDocFields,
  number: { type: String, required: true },
  version: { type: Number, default: 1 },
  previousVersionId: { type: ObjectId, ref: 'Quote' },
  status: { type: String, enum: QUOTE_STATUSES, default: 'draft', index: true },
  issueDate: { type: Date, default: Date.now },
  validUntil: Date,
  acceptedAt: Date,
  acceptedBy: String, // name typed by the client (or the user who marked it accepted)
  rejectedAt: Date,
  rejectionReason: String,
  invoiceId: { type: ObjectId, ref: 'Invoice' },
});
quoteSchema.index({ organizationId: 1, number: 1, version: 1 }, { unique: true });
export const Quote = model('Quote', quoteSchema);

export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void'];
export const PAYMENT_METHODS = ['bank_transfer', 'upi', 'card', 'cash', 'cheque', 'other'];
const paymentSchema = new Schema({
  amount: { type: Number, required: true, min: 0.01 },
  date: { type: Date, default: Date.now },
  method: { type: String, enum: PAYMENT_METHODS, default: 'bank_transfer' },
  reference: String,
  note: String,
  recordedBy: { type: ObjectId, ref: 'User' },
}, { timestamps: true });
paymentSchema.set('toJSON', { virtuals: true, versionKey: false, transform: (_, ret) => { delete ret._id; return ret; } });

const invoiceSchema = new Schema({
  ...commonDocFields,
  number: String, // assigned when issued, so drafts never consume a number
  quoteId: { type: ObjectId, ref: 'Quote', index: true },
  status: { type: String, enum: INVOICE_STATUSES, default: 'draft', index: true },
  issueDate: Date,
  dueDate: Date,
  payments: [paymentSchema],
  amountPaid: { type: Number, default: 0 },
  balanceDue: { type: Number, default: 0 },
  paidAt: Date,
  voidedAt: Date,
  voidReason: String,
  lastReminderAt: Date,
});
invoiceSchema.index({ organizationId: 1, number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } });
export const Invoice = model('Invoice', invoiceSchema);
