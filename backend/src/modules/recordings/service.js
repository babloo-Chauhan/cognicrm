import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Call, CallRecording, Organization, Voicemail } from '../../models/index.js';
import { env } from '../../config/env.js';
import { signResource } from '../../lib/crypto.js';
import { emitEvent } from '../../lib/eventBus.js';
import { CALL_EVENTS } from '../telephony/events.js';
import { getTelephonyProvider } from '../telephony/registry.js';
import { broadcastCall, isTerminal, syncCallActivity } from '../calls/service.js';
import { voicemailRecipients } from '../routing/service.js';
import { notifyMany } from '../notifications/service.js';

function retentionDate(org, from = new Date()) {
  const days = org.settings?.recording?.retentionDays;
  return days ? new Date(from.getTime() + days * 86400000) : null;
}

/** Stores a finished call recording (provider-side) and kicks off transcription. */
export async function onRecordingReady(call, recording) {
  if (!recording?.recordingId && !recording?.url) return null;
  const existing = await CallRecording.findOne({ organizationId: call.organizationId, callId: call._id, recordingId: recording.recordingId });
  if (existing) return existing;
  const org = await Organization.findById(call.organizationId).lean();
  const rec = await CallRecording.create({
    organizationId: call.organizationId,
    callId: call._id,
    recordingId: recording.recordingId,
    recordingUrl: recording.url,
    duration: recording.duration,
    provider: recording.provider || call.provider,
    kind: 'call',
    deleteAt: retentionDate(org),
  });
  call.hasRecording = true;
  call.events.push({ type: CALL_EVENTS.CALL_RECORDING_READY, at: new Date(), data: { recordingId: String(rec._id) } });
  await call.save();
  await syncCallActivity(call);
  broadcastCall(call);
  emitEvent(CALL_EVENTS.CALL_RECORDING_READY, { orgId: String(call.organizationId), callId: String(call._id), recordingId: String(rec._id) });
  return rec;
}

/** Stores a voicemail and notifies the people responsible for it. */
export async function onVoicemailRecorded(call, recording, { scope = 'ivr', targetId } = {}) {
  const org = await Organization.findById(call.organizationId).lean();
  let rec = await CallRecording.findOne({ organizationId: call.organizationId, callId: call._id, kind: 'voicemail' });
  if (!rec) {
    rec = await CallRecording.create({
      organizationId: call.organizationId,
      callId: call._id,
      recordingId: recording.recordingId,
      recordingUrl: recording.url,
      duration: recording.duration,
      provider: call.provider,
      kind: 'voicemail',
      deleteAt: retentionDate(org),
    });
  }
  const recipients = await voicemailRecipients(call, scope, targetId);
  const existingVm = await Voicemail.findOne({ organizationId: call.organizationId, callId: call._id });
  const vm = existingVm || await Voicemail.create({
    organizationId: call.organizationId, callId: call._id, scope, targetId: targetId || undefined, from: call.from,
    recordingId: rec._id, duration: recording.duration, assignedUserIds: recipients,
  });
  call.hasRecording = true;
  // The recording callback can arrive before or after the call-ended webhook.
  if (isTerminal(call.status)) {
    call.status = 'voicemail';
    await call.save();
    await syncCallActivity(call);
    broadcastCall(call);
  } else {
    call.metadata = { ...(call.metadata || {}), voicemailLeft: true };
    call.markModified('metadata');
    await call.save();
  }
  if (!existingVm) {
    await notifyMany(call.organizationId, recipients, {
      type: 'voicemail', title: 'New voicemail', body: `Voicemail from ${call.from} (${recording.duration || 0}s)`,
      data: { voicemailId: String(vm._id), callId: String(call._id) },
    });
  }
  emitEvent(CALL_EVENTS.CALL_RECORDING_READY, { orgId: String(call.organizationId), callId: String(call._id), recordingId: String(rec._id), voicemail: true });
  return vm;
}

// Recordings made by the phone's own call recorder and uploaded by the mobile app live on our disk
export const DEVICE = 'device';
const AUDIO_TYPES = {
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/amr': 'amr', 'audio/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm',
};
// The first (standard) type listed for an extension, e.g. m4a → audio/mp4, so browsers play it
const MIME_OF = Object.fromEntries(Object.entries(AUDIO_TYPES).reverse().map(([mime, ext]) => [ext, mime]));
const devicePath = (rec) => path.join(env.recordingsDir, rec.recordingUrl.replace(/^file:/, ''));

/** Saves a recording uploaded from the phone for this call (once per call) and attaches it like a provider one. */
export async function storeDeviceRecording(call, { data, contentType, duration }) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = AUDIO_TYPES[type];
  if (!ext) return { error: 'Send the recording as an audio file (m4a, mp3, amr, aac, ogg, wav)' };
  if (!data?.length) return { error: 'The recording is empty' };
  const existing = await CallRecording.findOne({ organizationId: call.organizationId, callId: call._id, provider: DEVICE, deletedAt: null });
  if (existing) return { recording: existing, duplicate: true };
  const relative = path.join(String(call.organizationId), `${call._id}.${ext}`);
  await fs.promises.mkdir(path.join(env.recordingsDir, String(call.organizationId)), { recursive: true });
  await fs.promises.writeFile(path.join(env.recordingsDir, relative), data);
  const recording = await onRecordingReady(call, {
    recordingId: `${DEVICE}:${call._id}`, url: `file:${relative}`, provider: DEVICE,
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : call.durationSeconds || undefined,
  });
  return { recording };
}

/** The audio of a recording as a fetch Response (body stream, content-type, arrayBuffer()), or null. */
export async function recordingMedia(rec) {
  if (rec.provider === DEVICE) {
    const file = devicePath(rec);
    if (!fs.existsSync(file)) return null;
    const type = MIME_OF[path.extname(file).slice(1)] || 'audio/mpeg';
    return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { 'content-type': type } });
  }
  const provider = await getTelephonyProvider(rec.organizationId, rec.provider);
  if (!provider) return null;
  // Twilio fetches by recording SID; others fetch by URL.
  return provider.fetchRecordingMedia(rec.provider === 'twilio' ? rec.recordingId : rec.recordingUrl);
}

export function signedRecordingUrl(recordingId, ttlSeconds = 300) {
  const { expires, sig } = signResource(`recording:${recordingId}`, ttlSeconds);
  const url = new URL(`/api/v1/recordings/${recordingId}/stream`, env.publicBaseUrl);
  url.searchParams.set('expires', String(expires));
  url.searchParams.set('sig', sig);
  return { url: url.toString(), expiresAt: new Date(expires * 1000) };
}

/** Streams recording audio through the server so provider credentials never reach the browser. */
export async function streamRecording(recordingId) {
  const rec = await CallRecording.findById(recordingId).select('+recordingUrl');
  if (!rec || rec.deletedAt) return null;
  return recordingMedia(rec);
}

/** Applies recording retention: deletes provider media and our reference after `deleteAt`. */
export async function applyRecordingRetention(now = new Date()) {
  const due = await CallRecording.find({ deleteAt: { $lte: now }, deletedAt: null }).select('+recordingUrl');
  for (const rec of due) {
    if (rec.provider === DEVICE && rec.recordingUrl) {
      await fs.promises.unlink(devicePath(rec)).catch(() => null);
    } else {
      const provider = await getTelephonyProvider(rec.organizationId, rec.provider);
      if (provider?.supports('recordingDelete') && rec.recordingId) await provider.deleteRecording(rec.recordingId).catch(() => null);
    }
    rec.deletedAt = now;
    rec.recordingUrl = undefined;
    await rec.save();
    const remaining = await CallRecording.countDocuments({ callId: rec.callId, deletedAt: null });
    if (!remaining) await Call.updateOne({ _id: rec.callId }, { hasRecording: false });
  }
  return due.length;
}

/** Call-log retention (optional, per organization). */
export async function applyCallLogRetention(now = new Date()) {
  const orgs = await Organization.find({ 'settings.compliance.callLogRetentionDays': { $gt: 0 } }).lean();
  let removed = 0;
  for (const org of orgs) {
    const cutoff = new Date(now.getTime() - org.settings.compliance.callLogRetentionDays * 86400000);
    const res = await Call.deleteMany({ organizationId: org._id, startedAt: { $lt: cutoff } });
    removed += res.deletedCount;
  }
  return removed;
}
