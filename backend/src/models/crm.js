import { searchPlugin } from './search.js';
import mongoose from 'mongoose';
import { model, ObjectId } from './plugins.js';

const { Schema } = mongoose;

const commonPrefs = {
  doNotCall: { type: Boolean, default: false },
  smsOptOut: { type: Boolean, default: false },
  whatsappOptOut: { type: Boolean, default: false },
  emailOptOut: { type: Boolean, default: false },
};

const accountSchema = new Schema({
  name: { type: String, required: true },
  industry: String,
  size: String,
  website: String,
  phone: String,
  ownerId: { type: ObjectId, ref: 'User' },
  customerId: String,
  tags: [String],
});
accountSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });
accountSchema.plugin(searchPlugin, { fields: ['name', 'industry', 'website', 'phone', 'customerId'] });
export const Account = model('Account', accountSchema);

const contactSchema = new Schema({
  firstName: { type: String, required: true },
  lastName: String,
  email: String,
  phone: { type: String, index: true },
  company: String,
  accountId: { type: ObjectId, ref: 'Account' },
  ownerId: { type: ObjectId, ref: 'User' },
  customerId: { type: String, index: true },
  lastContactedAt: Date,
  tags: [String],
  ...commonPrefs,
});
contactSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });
contactSchema.index({ organizationId: 1, ownerId: 1, createdAt: -1, _id: -1 });
contactSchema.plugin(searchPlugin, { fields: ['firstName', 'lastName', 'email', 'phone', 'company', 'customerId'] });
contactSchema.index({ organizationId: 1, email: 1 });
export const Contact = model('Contact', contactSchema);

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'unqualified', 'converted'];
const leadSchema = new Schema({
  name: { type: String, required: true },
  email: String,
  phone: { type: String, index: true },
  company: String,
  source: { type: String, default: 'other' },
  status: { type: String, enum: LEAD_STATUSES, default: 'new' },
  ownerId: { type: ObjectId, ref: 'User' },
  // Everyone who has held the lead (creator and each assignee). They keep seeing it after passing it on.
  assignees: [{ type: ObjectId, ref: 'User' }],
  // Each hand-over, oldest first: who had it, who got it (null = unassigned), who did it, when.
  // kind 'added' = `to` joined the lead alongside the owner; 'removed' = `from` was taken off it.
  assignments: [{ _id: false, kind: { type: String, enum: ['added', 'removed'] }, from: { type: ObjectId, ref: 'User' }, to: { type: ObjectId, ref: 'User' }, by: { type: ObjectId, ref: 'User' }, at: Date }],
  companySize: String,
  industry: String,
  estimatedValue: Number,
  websiteVisits: { type: Number, default: 0 },
  emailOpens: { type: Number, default: 0 },
  emailReplies: { type: Number, default: 0 },
  score: { type: Number, default: 0 },
  scoreFactors: [{ _id: false, factor: String, points: Number, detail: String }],
  lastContactedAt: Date,
  convertedContactId: { type: ObjectId, ref: 'Contact' },
  requirement: String, // what the customer needs
  address: String, // city / area / full address, as the customer gave it
  nextFollowUpAt: { type: Date, default: null }, // when to follow up next (app's Follow-up tab + reminder)
  followUpReminderSentAt: { type: Date, default: null }, // reminder sent for the current nextFollowUpAt
  notes: String, // remarks typed on the lead form; later remarks are Notes linked to the lead
  tags: [String],
  ...commonPrefs,
});
leadSchema.index({ organizationId: 1, status: 1, createdAt: -1, _id: -1 });
leadSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });
leadSchema.index({ organizationId: 1, ownerId: 1, createdAt: -1, _id: -1 });
leadSchema.index({ organizationId: 1, assignees: 1, createdAt: -1, _id: -1 });
leadSchema.index({ nextFollowUpAt: 1, followUpReminderSentAt: 1 });
leadSchema.index({ organizationId: 1, ownerId: 1, nextFollowUpAt: 1 });
leadSchema.index({ organizationId: 1, score: -1, _id: -1 });
leadSchema.plugin(searchPlugin, { fields: ['name', 'email', 'phone', 'company'] });
leadSchema.index({ organizationId: 1, email: 1 });
export const Lead = model('Lead', leadSchema);

// Stages of the default pipeline. Companies add pipelines with their own stages; every pipeline has won/lost.
export const DEAL_STAGES = ['prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost'];
const dealSchema = new Schema({
  name: { type: String, required: true },
  value: { type: Number, default: 0 },
  currency: { type: String, default: 'INR' },
  pipelineId: { type: ObjectId, ref: 'Pipeline' },
  stage: { type: String, default: 'prospecting', trim: true }, // a stage key of the deal's pipeline
  probability: Number,
  expectedCloseDate: Date,
  contactId: { type: ObjectId, ref: 'Contact' },
  accountId: { type: ObjectId, ref: 'Account' },
  leadId: { type: ObjectId, ref: 'Lead' },
  ownerId: { type: ObjectId, ref: 'User' },
  score: Number,
  scoreFactors: [{ _id: false, factor: String, points: Number, detail: String }],
  lastActivityAt: Date,
});
dealSchema.index({ organizationId: 1, stage: 1, createdAt: -1, _id: -1 });
dealSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });
dealSchema.index({ organizationId: 1, ownerId: 1, createdAt: -1, _id: -1 });
dealSchema.index({ organizationId: 1, score: -1, _id: -1 });
dealSchema.plugin(searchPlugin, { fields: ['name'] });
export const Deal = model('Deal', dealSchema);

const ticketSchema = new Schema({
  subject: { type: String, required: true },
  description: String,
  status: { type: String, enum: ['open', 'pending', 'resolved', 'closed'], default: 'open' },
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  contactId: { type: ObjectId, ref: 'Contact' },
  accountId: { type: ObjectId, ref: 'Account' },
  assigneeId: { type: ObjectId, ref: 'User' },
});
ticketSchema.index({ organizationId: 1, status: 1, createdAt: -1, _id: -1 });
ticketSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });
export const Ticket = model('Ticket', ticketSchema);

const relatedRefs = {
  contactId: { type: ObjectId, ref: 'Contact' },
  leadId: { type: ObjectId, ref: 'Lead' },
  accountId: { type: ObjectId, ref: 'Account' },
  dealId: { type: ObjectId, ref: 'Deal' },
  ticketId: { type: ObjectId, ref: 'Ticket' },
};

const taskSchema = new Schema({
  title: { type: String, required: true },
  description: String,
  dueAt: Date,
  status: { type: String, enum: ['open', 'done', 'cancelled'], default: 'open' },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  assigneeId: { type: ObjectId, ref: 'User' },
  related: { ...relatedRefs, callId: { type: ObjectId, ref: 'Call' } },
  source: { type: String, default: 'manual' }, // manual | ai | call_wrap_up | voice_agent | assistant
  reminderSentAt: { type: Date, default: null }, // follow-up reminder sent for the current dueAt
});
taskSchema.index({ status: 1, reminderSentAt: 1, dueAt: 1 });
taskSchema.index({ organizationId: 1, status: 1, dueAt: 1, _id: 1 });
taskSchema.index({ organizationId: 1, assigneeId: 1, status: 1, dueAt: 1, _id: 1 });
export const Task = model('Task', taskSchema);

const noteSchema = new Schema({
  body: { type: String, required: true },
  authorId: { type: ObjectId, ref: 'User' },
  related: { ...relatedRefs, callId: { type: ObjectId, ref: 'Call' } },
});
export const Note = model('Note', noteSchema);

const appointmentSchema = new Schema({
  title: { type: String, required: true },
  startAt: { type: Date, required: true },
  endAt: { type: Date, required: true },
  userId: { type: ObjectId, ref: 'User' },
  related: relatedRefs,
  notes: String,
  status: { type: String, enum: ['scheduled', 'completed', 'cancelled'], default: 'scheduled' },
  reminderSentAt: { type: Date, default: null },
});
export const Appointment = model('Appointment', appointmentSchema);

const orderSchema = new Schema({
  orderNumber: { type: String, required: true },
  contactId: { type: ObjectId, ref: 'Contact' },
  accountId: { type: ObjectId, ref: 'Account' },
  status: { type: String, default: 'processing' },
  paymentStatus: { type: String, default: 'pending' },
  amount: Number,
  expectedDelivery: Date,
});
orderSchema.index({ organizationId: 1, orderNumber: 1 }, { unique: true });
export const Order = model('Order', orderSchema);

/** Unified timeline entries. Each activity can be linked to several CRM records. */
const activitySchema = new Schema({
  type: { type: String, required: true }, // lead_created, call, sms, whatsapp, email, task_created, note, deal_created, ...
  title: String,
  occurredAt: { type: Date, default: Date.now, index: true },
  userId: { type: ObjectId, ref: 'User' },
  refType: String, // Call, CommunicationMessage, Task, ...
  refId: ObjectId,
  data: Schema.Types.Mixed,
  links: {
    contactId: { type: ObjectId, index: true },
    leadId: { type: ObjectId, index: true },
    accountId: { type: ObjectId, index: true },
    dealId: { type: ObjectId, index: true },
    ticketId: { type: ObjectId, index: true },
  },
});
export const Activity = model('Activity', activitySchema);

/**
 * Where leads come in from on their own: a website form, Justdial, IndiaMART, Facebook / Instagram ads,
 * Google Ads, WhatsApp or any app that can call a webhook. Each has an unguessable `token` that is its public
 * URL, and says who gets the leads (one person, or several in turn).
 */
export const LEAD_SOURCE_TYPES = ['webhook', 'form', 'justdial', 'indiamart', 'meta', 'google_ads', 'whatsapp'];
const leadSourceSchema = new Schema({
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: LEAD_SOURCE_TYPES, required: true },
  token: { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: true },
  leadSource: { type: String, trim: true }, // stored on each lead's `source`
  // none: unassigned (the admin hands them out); user / round_robin: assignUserIds[0], or each in turn
  assignMode: { type: String, enum: ['none', 'user', 'round_robin'], default: 'none' },
  assignUserIds: [{ type: ObjectId, ref: 'User' }],
  nextAssignee: { type: Number, default: 0 },
  // An enquiry from a phone / email already in the CRM: add it to that lead (default) or make a new lead
  onDuplicate: { type: String, enum: ['merge', 'create'], default: 'merge' },
  config: { type: Schema.Types.Mixed, default: {} }, // per type: form fields, IndiaMART pull state, Meta page …
  credentials: { type: String, select: false }, // encrypted: IndiaMART CRM key, Meta page token / app secret
  stats: {
    total: { type: Number, default: 0 },
    duplicates: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    lastLeadAt: Date,
    lastError: String,
    lastErrorAt: Date,
  },
});
leadSourceSchema.index({ organizationId: 1, type: 1 });
export const LeadSource = model('LeadSource', leadSourceSchema);

/** One received enquiry and what became of it (kept 60 days); `key` stops the same enquiry being added twice. */
const leadCaptureLogSchema = new Schema({
  sourceId: { type: ObjectId, ref: 'LeadSource', required: true },
  key: { type: String },
  status: { type: String, enum: ['created', 'duplicate', 'failed', 'ignored'], required: true },
  leadId: { type: ObjectId, ref: 'Lead' },
  name: String,
  phone: String,
  email: String,
  error: String,
  payload: Schema.Types.Mixed,
});
leadCaptureLogSchema.index({ organizationId: 1, sourceId: 1, createdAt: -1 });
leadCaptureLogSchema.index({ sourceId: 1, key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });
leadCaptureLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 86400 });
export const LeadCaptureLog = model('LeadCaptureLog', leadCaptureLogSchema);
