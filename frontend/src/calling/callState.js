export const TERMINAL = ['completed', 'failed', 'busy', 'no_answer', 'canceled', 'abandoned', 'voicemail'];

/** Server call status → softphone state shown to the agent. */
export function uiState(call) {
  if (!call) return 'Idle';
  switch (call.status) {
    case 'initiated': return 'Calling';
    case 'ringing':
    case 'queued': return 'Ringing';
    case 'in_progress': return 'Connected';
    case 'on_hold': return 'On Hold';
    case 'transferring': return 'Transferred';
    case 'completed':
    case 'voicemail': return 'Completed';
    default: return 'Failed';
  }
}

export const isMobileDevice = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
