import { Call, CallRecording, CallTranscript, Organization, Task } from '../../models/index.js';
import { emitEvent } from '../../lib/eventBus.js';
import { CALL_EVENTS } from '../telephony/events.js';
import { getTelephonyProvider } from '../telephony/registry.js';
import { broadcastCall, syncCallActivity } from '../calls/service.js';
import { logActivity } from '../timeline/service.js';
import { getTranscriber } from './transcription.js';
import { getLlm } from './llm.js';
import { summarizeCallTranscript } from './summaries.js';

/**
 * Recording → Speech-to-text → Transcript → Summary → Topics/sentiment → CRM activity + tasks.
 * Each stage only runs when its provider is configured; nothing is fabricated.
 */
export async function runCallIntelligence(orgId, callId, { force = false } = {}) {
  const org = await Organization.findById(orgId).lean();
  const settings = org.settings?.transcription || {};
  if (!settings.enabled && !force) return { skipped: 'transcription disabled' };

  const call = await Call.findOne({ _id: callId, organizationId: orgId });
  if (!call) return { skipped: 'call not found' };
  const recording = await CallRecording.findOne({ organizationId: orgId, callId, kind: 'call', deletedAt: null }).select('+recordingUrl');
  if (!recording) return { skipped: 'no recording' };

  const transcriber = await getTranscriber(orgId);
  if (!transcriber) return { skipped: 'no transcription provider configured' };

  let transcriptDoc = await CallTranscript.findOne({ organizationId: orgId, callId });
  if (transcriptDoc?.status === 'summarized' && !force) return { transcript: transcriptDoc };
  transcriptDoc ||= new CallTranscript({ organizationId: orgId, callId, status: 'pending' });

  try {
    if (transcriptDoc.status === 'pending' || force) {
      const provider = await getTelephonyProvider(orgId, recording.provider);
      const media = await provider.fetchRecordingMedia(recording.provider === 'twilio' ? recording.recordingId : recording.recordingUrl);
      const audio = Buffer.from(await media.arrayBuffer());
      const result = await transcriber.transcribe({ audio, contentType: media.headers?.get?.('content-type') || 'audio/mpeg' });
      transcriptDoc.set({
        provider: transcriber.name, transcript: result.text, segments: result.segments, language: result.language, status: 'transcribed',
      });
      await transcriptDoc.save();
      call.hasTranscript = true;
      call.events.push({ type: CALL_EVENTS.CALL_TRANSCRIPT_READY, at: new Date() });
      await call.save();
      emitEvent(CALL_EVENTS.CALL_TRANSCRIPT_READY, { orgId: String(orgId), callId: String(callId) });
    }

    if (settings.autoSummary !== false && transcriptDoc.transcript && (await getLlm(orgId))) {
      const summary = await summarizeCallTranscript(orgId, {
        transcript: transcriptDoc.transcript,
        context: { direction: call.direction, disposition: call.disposition?.label },
      });
      if (summary) {
        transcriptDoc.set({
          ...summary,
          actionItems: (summary.actionItems || []).map((a) => (typeof a === 'string' ? a : a.title)),
          status: 'summarized',
        });
        await transcriptDoc.save();
        if (settings.autoCreateTasks !== false) {
          for (const item of summary.actionItems || []) {
            const title = typeof item === 'string' ? item : item.title;
            const dueInDays = typeof item === 'object' && item.dueInDays != null ? item.dueInDays : 1;
            await Task.create({
              organizationId: orgId, title, assigneeId: call.agentId, source: 'ai',
              dueAt: new Date(Date.now() + dueInDays * 86400000),
              related: { ...(call.related?.toObject?.() || call.related || {}), callId: call._id },
            });
          }
        }
        await logActivity(orgId, {
          type: 'call_summary', title: 'AI call summary', related: call.related || {}, refType: 'CallTranscript',
          refId: transcriptDoc._id, userId: call.agentId, data: { summary: summary.summary, nextSteps: summary.nextSteps },
        });
      }
    }
    await syncCallActivity(call);
    broadcastCall(call);
    return { transcript: transcriptDoc };
  } catch (err) {
    transcriptDoc.status = transcriptDoc.transcript ? 'transcribed' : 'failed';
    transcriptDoc.error = err.message;
    await transcriptDoc.save();
    return { error: err.message };
  }
}
