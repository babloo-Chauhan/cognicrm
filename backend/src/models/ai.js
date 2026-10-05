import mongoose from 'mongoose';
import { model, ObjectId } from './plugins.js';

const { Schema } = mongoose;

const voiceAgentSchema = new Schema({
  name: { type: String, required: true },
  profile: {
    role: { type: String, default: 'Customer support assistant' },
    companyName: String,
    greeting: { type: String, default: 'Hello! How can I help you today?' },
  },
  useCases: [{ type: String, enum: [
    'inbound', 'outbound', 'appointment_booking', 'lead_qualification', 'support', 'faq',
    'order_status', 'payment_status', 'follow_up', 'reminder',
  ] }],
  prompt: { type: String, default: '' },
  knowledgeBase: [{ _id: false, title: String, content: String }],
  tools: [String], // explicit allow-list of CRM tool names
  businessRules: [String],
  escalation: {
    onCustomerRequest: { type: Boolean, default: true },
    keywords: { type: [String], default: ['human', 'agent', 'manager', 'insaan', 'representative'] },
    maxTurns: { type: Number, default: 20 },
    queueId: { type: ObjectId, ref: 'CallQueue' },
  },
  voice: {
    provider: { type: String, default: 'provider_native' },
    voiceId: String,
    language: { type: String, default: 'en' },
  },
  languages: { type: [String], default: ['en'] },
  callLimits: {
    maxDurationSeconds: { type: Number, default: 600 },
    maxConcurrent: { type: Number, default: 5 },
    dailyLimit: { type: Number, default: 500 },
  },
  phoneNumberIds: [{ type: ObjectId, ref: 'PhoneNumber' }],
  status: { type: String, enum: ['draft', 'active', 'paused'], default: 'draft' },
});
export const VoiceAgent = model('VoiceAgent', voiceAgentSchema);

const voiceAgentSessionSchema = new Schema({
  voiceAgentId: { type: ObjectId, ref: 'VoiceAgent', required: true, index: true },
  callId: { type: ObjectId, ref: 'Call', index: true },
  channel: { type: String, enum: ['voice', 'test'], default: 'voice' },
  turns: [{ _id: false, role: String, text: String, at: Date, toolCalls: Schema.Types.Mixed }],
  collected: { type: Schema.Types.Mixed, default: {} },
  intent: String,
  summary: String,
  customer: {
    phone: String,
    contactId: ObjectId,
    leadId: ObjectId,
  },
  status: { type: String, enum: ['active', 'completed', 'escalated', 'failed'], default: 'active' },
  escalatedToQueueId: ObjectId,
  escalationContext: Schema.Types.Mixed,
});
export const VoiceAgentSession = model('VoiceAgentSession', voiceAgentSessionSchema);
