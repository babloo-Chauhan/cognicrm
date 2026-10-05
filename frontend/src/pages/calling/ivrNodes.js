export const NODE_TYPES = {
  start: { title: 'Start', icon: '▶' },
  tts: { title: 'Text to speech', icon: '🗣' },
  play_audio: { title: 'Play audio', icon: '🔊' },
  gather: { title: 'Gather input', icon: '⌨️' },
  dtmf: { title: 'DTMF menu', icon: '🔢' },
  set_language: { title: 'Set language', icon: '🌐' },
  business_hours: { title: 'Business hours', icon: '🕘' },
  condition: { title: 'Condition', icon: '❓' },
  route: { title: 'Route (rules)', icon: '🔀' },
  api_request: { title: 'API request / lookup', icon: '🔎' },
  webhook: { title: 'Webhook', icon: '🪝' },
  queue: { title: 'Queue', icon: '👥' },
  agent: { title: 'Agent', icon: '🧑‍💼' },
  department: { title: 'Department', icon: '🏢' },
  transfer: { title: 'Transfer (external)', icon: '↪' },
  voicemail: { title: 'Voicemail', icon: '📼' },
  record: { title: 'Record message', icon: '⏺' },
  callback: { title: 'Request callback', icon: '🔁' },
  end: { title: 'End call', icon: '⏹' },
};

export const TERMINAL = ['queue', 'agent', 'department', 'transfer', 'voicemail', 'record', 'callback', 'end'];

/** Output handles for a node: these become edge.sourceHandle values the engine branches on. */
export function outputsFor(type, data = {}) {
  if (TERMINAL.includes(type)) return [];
  if (type === 'gather' || type === 'dtmf') {
    const opts = String(data.options || '').split(',').map((s) => s.trim()).filter(Boolean);
    return opts.length ? [...opts, 'timeout', 'invalid'] : ['next', 'timeout'];
  }
  if (type === 'business_hours') return ['open', 'closed', 'holiday'];
  if (type === 'condition') return ['true', 'false'];
  if (type === 'api_request') return ['success', 'error'];
  if (type === 'route') return [...(data.rules || []).map((r) => r.handle).filter(Boolean), 'default'];
  return ['next'];
}
