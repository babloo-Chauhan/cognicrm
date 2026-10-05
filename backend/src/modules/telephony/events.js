/** Normalized internal call events. Provider-specific events are always converted to these. */
export const CALL_EVENTS = {
  CALL_INITIATED: 'CALL_INITIATED',
  CALL_RINGING: 'CALL_RINGING',
  CALL_ANSWERED: 'CALL_ANSWERED',
  CALL_HOLD: 'CALL_HOLD',
  CALL_RESUMED: 'CALL_RESUMED',
  CALL_TRANSFERRED: 'CALL_TRANSFERRED',
  CALL_COMPLETED: 'CALL_COMPLETED',
  CALL_FAILED: 'CALL_FAILED',
  CALL_RECORDING_READY: 'CALL_RECORDING_READY',
  CALL_TRANSCRIPT_READY: 'CALL_TRANSCRIPT_READY',
};

/** Public webhook-style event names (for outbound integrations / docs). */
export const PUBLIC_EVENT_NAMES = {
  CALL_INITIATED: 'call.started',
  CALL_RINGING: 'call.ringing',
  CALL_ANSWERED: 'call.answered',
  CALL_COMPLETED: 'call.completed',
  CALL_FAILED: 'call.failed',
  CALL_RECORDING_READY: 'call.recording.ready',
  CALL_TRANSCRIPT_READY: 'call.transcript.ready',
};

/**
 * Maps a provider "status" vocabulary onto normalized event + terminal status.
 * Terminal statuses use the Call model's status enum.
 */
export function eventFromStatus(status) {
  switch (String(status || '').toLowerCase().replace(/[\s_]/g, '-')) {
    case 'queued':
    case 'initiated':
      return { type: CALL_EVENTS.CALL_INITIATED };
    case 'ringing':
    case 'ring':
      return { type: CALL_EVENTS.CALL_RINGING };
    case 'in-progress':
    case 'answered':
    case 'answer':
      return { type: CALL_EVENTS.CALL_ANSWERED };
    case 'completed':
    case 'hangup':
      return { type: CALL_EVENTS.CALL_COMPLETED, finalStatus: 'completed' };
    case 'busy':
      return { type: CALL_EVENTS.CALL_FAILED, finalStatus: 'busy' };
    case 'no-answer':
    case 'timeout':
      return { type: CALL_EVENTS.CALL_FAILED, finalStatus: 'no_answer' };
    case 'canceled':
    case 'cancel':
      return { type: CALL_EVENTS.CALL_FAILED, finalStatus: 'canceled' };
    case 'failed':
    case 'rejected':
    default:
      return { type: CALL_EVENTS.CALL_FAILED, finalStatus: 'failed' };
  }
}
