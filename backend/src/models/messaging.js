import mongoose from 'mongoose';
import { model, ObjectId } from './plugins.js';

const { Schema } = mongoose;

export const CHANNELS = ['voice', 'sms', 'whatsapp', 'email', 'chat', 'webchat', 'push', 'note'];

/** One conversation per customer identity; messages from every channel are threaded into it. */
const conversationSchema = new Schema({
  customer: {
    name: String,
    phone: { type: String, index: true },
    email: { type: String, index: true },
    visitorId: { type: String, index: true },
  },
  channels: [String],
  lastChannel: String,
  lastMessageAt: { type: Date, default: Date.now, index: true },
  lastMessagePreview: String,
  unreadCount: { type: Number, default: 0 },
  assignedTo: { type: ObjectId, ref: 'User' },
  status: { type: String, enum: ['open', 'pending', 'closed'], default: 'open' },
  related: {
    contactId: { type: ObjectId, ref: 'Contact' },
    leadId: { type: ObjectId, ref: 'Lead' },
    accountId: { type: ObjectId, ref: 'Account' },
    dealId: { type: ObjectId, ref: 'Deal' },
    ticketId: { type: ObjectId, ref: 'Ticket' },
  },
});
export const CommunicationConversation = model('CommunicationConversation', conversationSchema);

const messageSchema = new Schema({
  conversationId: { type: ObjectId, ref: 'CommunicationConversation', required: true, index: true },
  channel: { type: String, enum: CHANNELS, required: true },
  direction: { type: String, enum: ['inbound', 'outbound', 'internal'], required: true },
  from: String,
  to: String,
  subject: String,
  body: String,
  attachments: [{ _id: false, url: String, contentType: String, name: String }],
  templateId: { type: ObjectId, ref: 'MessageTemplate' },
  status: {
    type: String,
    enum: ['queued', 'sent', 'delivered', 'read', 'failed', 'received'],
    default: 'queued',
  },
  provider: String,
  providerMessageId: { type: String, index: true },
  error: String,
  sentBy: { type: ObjectId, ref: 'User' },
  statusHistory: [{ _id: false, status: String, at: Date }],
});
export const CommunicationMessage = model('CommunicationMessage', messageSchema);

const messageTemplateSchema = new Schema({
  name: { type: String, required: true },
  channel: { type: String, enum: ['sms', 'whatsapp', 'email'], required: true },
  language: { type: String, default: 'en' },
  subject: String,
  body: { type: String, required: true }, // supports {{variables}}
  providerTemplateName: String, // e.g. approved WhatsApp template name
  approvalStatus: { type: String, enum: ['not_required', 'pending', 'approved', 'rejected'], default: 'not_required' },
  active: { type: Boolean, default: true },
});
export const MessageTemplate = model('MessageTemplate', messageTemplateSchema);
