import mongoose from 'mongoose';
import { model, ObjectId } from './plugins.js';

const { Schema } = mongoose;

const related = {
  contactId: { type: ObjectId, ref: 'Contact' },
  leadId: { type: ObjectId, ref: 'Lead' },
  accountId: { type: ObjectId, ref: 'Account' },
  dealId: { type: ObjectId, ref: 'Deal' },
  ticketId: { type: ObjectId, ref: 'Ticket' },
};

// ---------------------------------------------------------------- Phone numbers
const phoneNumberSchema = new Schema({
  number: { type: String, required: true },
  provider: { type: String, required: true },
  providerNumberId: String,
  country: { type: String, default: 'IN' },
  type: { type: String, enum: ['local', 'mobile', 'toll_free', 'national', 'sip'], default: 'local' },
  capabilities: {
    voice: { type: Boolean, default: true },
    sms: { type: Boolean, default: false },
    whatsapp: { type: Boolean, default: false },
  },
  label: String,
  assignedUserId: { type: ObjectId, ref: 'User' },
  assignedTeamId: { type: ObjectId, ref: 'Department' },
  ivrFlowId: { type: ObjectId, ref: 'IVRFlow' },
  queueId: { type: ObjectId, ref: 'CallQueue' },
  businessHoursId: { type: ObjectId, ref: 'BusinessHours' },
  isDefaultCallerId: { type: Boolean, default: false },
  status: { type: String, enum: ['active', 'inactive', 'released'], default: 'active' },
});
phoneNumberSchema.index({ number: 1, status: 1 });
export const PhoneNumber = model('PhoneNumber', phoneNumberSchema);

// ---------------------------------------------------------------- Calls
export const CALL_STATUSES = [
  'initiated', 'ringing', 'queued', 'in_progress', 'on_hold', 'transferring', 'completed',
  'failed', 'busy', 'no_answer', 'canceled', 'abandoned', 'voicemail',
];
export const TERMINAL_STATUSES = ['completed', 'failed', 'busy', 'no_answer', 'canceled', 'abandoned', 'voicemail'];

const callSchema = new Schema({
  direction: { type: String, enum: ['inbound', 'outbound'], required: true },
  status: { type: String, enum: CALL_STATUSES, default: 'initiated', index: true },
  mode: { type: String, enum: ['webrtc', 'bridge', 'native', 'ai'], default: 'bridge' },
  from: String,
  to: String,
  customerPhone: { type: String, index: true },
  agentId: { type: ObjectId, ref: 'User', index: true },
  queueId: { type: ObjectId, ref: 'CallQueue' },
  departmentId: { type: ObjectId, ref: 'Department' },
  phoneNumberId: { type: ObjectId, ref: 'PhoneNumber' },
  provider: String,
  providerCallId: { type: String, index: true },
  providerLegs: [{ _id: false, role: String, providerCallId: String, target: String, userId: { type: ObjectId, ref: 'User' } }],
  conferenceName: String,
  related,
  campaignId: { type: ObjectId, ref: 'CallCampaign' },
  campaignContactId: { type: ObjectId, ref: 'CallCampaignContact' },
  callbackId: { type: ObjectId, ref: 'Callback' },
  voiceAgentId: { type: ObjectId, ref: 'VoiceAgent' },
  ivrSessionId: { type: ObjectId, ref: 'IVRSession' },
  source: { type: String, default: 'manual' }, // manual | click_to_call | campaign | callback | ivr | voice_agent | mobile
  startedAt: { type: Date, default: Date.now, index: true },
  ringingAt: Date,
  answeredAt: Date,
  enqueuedAt: Date,
  endedAt: Date,
  durationSeconds: { type: Number, default: 0 },
  waitSeconds: { type: Number, default: 0 },
  recordingEnabled: { type: Boolean, default: false },
  hasRecording: { type: Boolean, default: false },
  hasTranscript: { type: Boolean, default: false },
  muted: { type: Boolean, default: false },
  disposition: {
    code: String,
    label: String,
    notes: String,
    at: Date,
    by: { type: ObjectId, ref: 'User' },
  },
  notes: String,
  failureReason: String,
  queueAttempts: { type: Number, default: 0 },
  triedAgentIds: [{ type: ObjectId, ref: 'User' }],
  dispatchLockedAt: Date, // prevents two dispatchers ringing agents for the same call
  events: [{ _id: false, type: { type: String }, at: Date, data: Schema.Types.Mixed }],
  metadata: Schema.Types.Mixed,
});
callSchema.index({ organizationId: 1, startedAt: -1 });
export const Call = model('Call', callSchema);

const callParticipantSchema = new Schema({
  callId: { type: ObjectId, ref: 'Call', required: true, index: true },
  role: { type: String, enum: ['customer', 'agent', 'supervisor', 'external', 'ai'], required: true },
  userId: { type: ObjectId, ref: 'User' },
  phone: String,
  providerCallId: String,
  status: { type: String, enum: ['invited', 'joined', 'left'], default: 'invited' },
  muted: { type: Boolean, default: false },
  onHold: { type: Boolean, default: false },
  coaching: { type: Boolean, default: false }, // whisper
  monitorMode: { type: String, enum: ['listen', 'whisper', 'barge', null], default: null },
  joinedAt: Date,
  leftAt: Date,
});
export const CallParticipant = model('CallParticipant', callParticipantSchema);

const callRecordingSchema = new Schema({
  callId: { type: ObjectId, ref: 'Call', required: true, index: true },
  recordingId: String, // provider recording id
  duration: Number,
  recordingUrl: { type: String, select: false }, // private provider URL; clients get signed URLs only
  provider: String,
  kind: { type: String, enum: ['call', 'voicemail'], default: 'call' },
  deleteAt: Date,
  deletedAt: Date,
});
export const CallRecording = model('CallRecording', callRecordingSchema);

const callTranscriptSchema = new Schema({
  callId: { type: ObjectId, ref: 'Call', required: true, index: true },
  provider: String,
  language: String,
  transcript: String,
  segments: [{ _id: false, speaker: String, start: Number, end: Number, text: String }],
  summary: String,
  requirements: [String],
  problems: [String],
  objections: [String],
  commitments: [String],
  nextSteps: [String],
  topics: [String],
  actionItems: [String],
  sentiment: String,
  status: { type: String, enum: ['pending', 'transcribed', 'summarized', 'failed'], default: 'pending' },
  error: String,
});
export const CallTranscript = model('CallTranscript', callTranscriptSchema);

/** Disposition definitions (system defaults + organization custom ones). */
const callDispositionSchema = new Schema({
  code: { type: String, required: true },
  label: { type: String, required: true },
  category: { type: String, enum: ['connected', 'not_connected', 'outcome'], default: 'outcome' },
  isConversion: { type: Boolean, default: false },
  requiresCallback: { type: Boolean, default: false },
  system: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
});
callDispositionSchema.index({ organizationId: 1, code: 1 }, { unique: true });
export const CallDisposition = model('CallDisposition', callDispositionSchema);

// ---------------------------------------------------------------- Queues & agents
export const QUEUE_STRATEGIES = ['round_robin', 'least_busy', 'longest_idle', 'ring_all', 'random'];
const callQueueSchema = new Schema({
  name: { type: String, required: true },
  description: String,
  departmentId: { type: ObjectId, ref: 'Department' },
  strategy: { type: String, enum: QUEUE_STRATEGIES, default: 'longest_idle' },
  maxWaitTime: { type: Number, default: 300 }, // seconds
  ringTimeout: { type: Number, default: 20 },
  music: String, // hold music URL
  positionAnnouncement: { type: Boolean, default: true },
  overflow: {
    queueId: { type: ObjectId, ref: 'CallQueue' },
    afterSeconds: Number,
  },
  fallback: {
    action: { type: String, enum: ['voicemail', 'hangup', 'external', 'callback'], default: 'voicemail' },
    target: String,
  },
  lastAssignedIndex: { type: Number, default: -1 },
  active: { type: Boolean, default: true },
});
export const CallQueue = model('CallQueue', callQueueSchema);

const callQueueMemberSchema = new Schema({
  queueId: { type: ObjectId, ref: 'CallQueue', required: true, index: true },
  userId: { type: ObjectId, ref: 'User', required: true },
  priority: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
});
callQueueMemberSchema.index({ queueId: 1, userId: 1 }, { unique: true });
export const CallQueueMember = model('CallQueueMember', callQueueMemberSchema);

export const AGENT_STATES = ['online', 'available', 'busy', 'on_call', 'wrap_up', 'break', 'offline'];
const agentStatusSchema = new Schema({
  userId: { type: ObjectId, ref: 'User', required: true, unique: true },
  status: { type: String, enum: AGENT_STATES, default: 'offline' },
  customStatus: String,
  since: { type: Date, default: Date.now },
  currentCallId: { type: ObjectId, ref: 'Call' },
  lastCallEndedAt: Date,
  wrapUpUntil: Date,
  activeCampaignId: { type: ObjectId, ref: 'CallCampaign' },
});
export const AgentStatus = model('AgentStatus', agentStatusSchema);

// ---------------------------------------------------------------- Business hours
const businessHoursSchema = new Schema({
  name: { type: String, required: true },
  timezone: { type: String, default: 'Asia/Kolkata' },
  // day: 0 = Sunday ... 6 = Saturday; multiple ranges per day allowed
  weekly: [{ _id: false, day: Number, open: String, close: String }],
  holidays: [{ _id: false, date: String, name: String }], // YYYY-MM-DD
  specialHours: [{ _id: false, date: String, open: String, close: String, closed: Boolean }],
});
export const BusinessHours = model('BusinessHours', businessHoursSchema);

// ---------------------------------------------------------------- IVR
export const IVR_NODE_TYPES = [
  'start', 'play_audio', 'tts', 'gather', 'dtmf', 'route', 'queue', 'agent', 'department', 'webhook',
  'api_request', 'business_hours', 'condition', 'transfer', 'voicemail', 'record', 'set_language', 'callback', 'end',
];

/** Stored embedded inside IVRFlow. Shape matches the React Flow node format. */
export const IVRNodeSchema = new Schema({
  id: { type: String, required: true },
  type: { type: String, enum: IVR_NODE_TYPES, required: true },
  position: { x: Number, y: Number },
  data: { type: Schema.Types.Mixed, default: {} },
}, { _id: false });

const ivrFlowSchema = new Schema({
  name: { type: String, required: true },
  description: String,
  defaultLanguage: { type: String, default: 'en' },
  languages: { type: [String], default: ['en'] },
  translations: { type: Schema.Types.Mixed, default: {} }, // { key: { en: '...', hi: '...' } }
  nodes: [IVRNodeSchema],
  edges: [{ _id: false, id: String, source: String, target: String, sourceHandle: String }],
  status: { type: String, enum: ['draft', 'published'], default: 'draft' },
  version: { type: Number, default: 1 },
});
export const IVRFlow = model('IVRFlow', ivrFlowSchema);
export const IVRNode = IVRNodeSchema;

const ivrSessionSchema = new Schema({
  flowId: { type: ObjectId, ref: 'IVRFlow', required: true },
  callId: { type: ObjectId, ref: 'Call', required: true, index: true },
  currentNodeId: String,
  language: String,
  variables: { type: Schema.Types.Mixed, default: {} },
  path: [{ _id: false, nodeId: String, at: Date, input: String }],
  retries: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'completed', 'abandoned'], default: 'active' },
});
export const IVRSession = model('IVRSession', ivrSessionSchema);

// ---------------------------------------------------------------- Voicemail & callbacks
const voicemailSchema = new Schema({
  callId: { type: ObjectId, ref: 'Call' },
  scope: { type: String, enum: ['personal', 'department', 'queue', 'ivr'], default: 'ivr' },
  targetId: ObjectId,
  from: String,
  recordingId: { type: ObjectId, ref: 'CallRecording' },
  duration: Number,
  transcription: String,
  assignedUserIds: [{ type: ObjectId, ref: 'User' }],
  listened: { type: Boolean, default: false },
});
export const Voicemail = model('Voicemail', voicemailSchema);

const callbackSchema = new Schema({
  customerName: String,
  phone: { type: String, required: true },
  related,
  assignedAgentId: { type: ObjectId, ref: 'User' },
  queueId: { type: ObjectId, ref: 'CallQueue' },
  scheduledAt: { type: Date, required: true, index: true },
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
  notes: String,
  status: { type: String, enum: ['pending', 'notified', 'in_progress', 'completed', 'cancelled', 'missed'], default: 'pending' },
  autoDial: { type: Boolean, default: false },
  source: { type: String, default: 'agent' }, // agent | ivr | web | campaign | voice_agent
  callId: { type: ObjectId, ref: 'Call' },
  originCallId: { type: ObjectId, ref: 'Call' },
  notifiedAt: Date,
});
export const Callback = model('Callback', callbackSchema);

// ---------------------------------------------------------------- Compliance
const dncEntrySchema = new Schema({
  phone: { type: String, required: true },
  reason: String,
  source: { type: String, default: 'manual' }, // manual | opt_out | disposition | import
  addedBy: { type: ObjectId, ref: 'User' },
});
dncEntrySchema.index({ organizationId: 1, phone: 1 }, { unique: true });
export const DncEntry = model('DncEntry', dncEntrySchema);

// ---------------------------------------------------------------- Campaigns
const callCampaignSchema = new Schema({
  name: { type: String, required: true },
  description: String,
  mode: { type: String, enum: ['preview', 'power', 'predictive'], default: 'preview' },
  status: { type: String, enum: ['draft', 'running', 'paused', 'completed'], default: 'draft' },
  agentIds: [{ type: ObjectId, ref: 'User' }],
  callerIdNumberId: { type: ObjectId, ref: 'PhoneNumber' },
  schedule: {
    timezone: { type: String, default: 'Asia/Kolkata' },
    days: { type: [Number], default: [1, 2, 3, 4, 5] },
    start: { type: String, default: '10:00' },
    end: { type: String, default: '18:00' },
    startDate: Date,
    endDate: Date,
  },
  retryPolicy: {
    maxAttempts: { type: Number, default: 3 },
    retryDelayMinutes: { type: Number, default: 60 },
    retryOn: { type: [String], default: ['no_answer', 'busy', 'failed'] },
  },
  dispositionRules: [{ _id: false, code: String, action: { type: String, enum: ['complete', 'retry', 'dnc', 'callback'] } }],
  predictive: {
    enabled: { type: Boolean, default: false },
    complianceAcknowledged: { type: Boolean, default: false },
    maxAbandonRate: { type: Number, default: 0.03 },
    maxDialRatio: { type: Number, default: 1.5 },
  },
  stats: {
    total: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    connected: { type: Number, default: 0 },
    converted: { type: Number, default: 0 },
    abandoned: { type: Number, default: 0 },
  },
});
export const CallCampaign = model('CallCampaign', callCampaignSchema);

const callCampaignContactSchema = new Schema({
  campaignId: { type: ObjectId, ref: 'CallCampaign', required: true, index: true },
  name: String,
  phone: { type: String, required: true },
  related,
  status: {
    type: String,
    enum: ['pending', 'dialing', 'completed', 'failed', 'skipped', 'dnc', 'invalid', 'callback'],
    default: 'pending',
  },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: Date,
  lastCallId: { type: ObjectId, ref: 'Call' },
  lastDisposition: String,
  assignedAgentId: { type: ObjectId, ref: 'User' },
  lockedBy: { type: ObjectId, ref: 'User' },
  lockedAt: Date,
});
callCampaignContactSchema.index({ campaignId: 1, status: 1, nextAttemptAt: 1 });
export const CallCampaignContact = model('CallCampaignContact', callCampaignContactSchema);
