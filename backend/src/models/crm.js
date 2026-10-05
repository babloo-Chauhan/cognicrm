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
accountSchema.index({ organizationId: 1, createdAt: -1 });
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
contactSchema.index({ organizationId: 1, createdAt: -1 });
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
  notes: String,
  tags: [String],
  ...commonPrefs,
});
leadSchema.index({ organizationId: 1, status: 1 });
leadSchema.index({ organizationId: 1, createdAt: -1 });
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
dealSchema.index({ organizationId: 1, stage: 1 });
dealSchema.index({ organizationId: 1, createdAt: -1 });
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
ticketSchema.index({ organizationId: 1, status: 1 });
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
taskSchema.index({ organizationId: 1, status: 1, dueAt: 1 });
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
