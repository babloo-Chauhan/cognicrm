import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { loadIntegration } from '../telephony/registry.js';

/**
 * Speech-to-text provider abstraction.
 * transcribe({ audio: Buffer, contentType, language }) → { text, language, segments: [{speaker,start,end,text}] }
 */
export class TranscriptionProvider {
  async transcribe() { throw new Error('not implemented'); }
}

export class DeepgramTranscriber extends TranscriptionProvider {
  constructor({ apiKey, model = 'nova-3' }) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.name = 'deepgram';
  }

  async transcribe({ audio, contentType = 'audio/mpeg', language }) {
    const qs = new URLSearchParams({ model: this.model, smart_format: 'true', diarize: 'true', paragraphs: 'true' });
    if (language) qs.set('language', language);
    else qs.set('detect_language', 'true');
    const res = await fetch(`https://api.deepgram.com/v1/listen?${qs}`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': contentType },
      body: audio,
    });
    if (!res.ok) throw new AppError(502, `Transcription failed (${res.status})`, 'PROVIDER_ERROR');
    const json = await res.json();
    const channel = json?.results?.channels?.[0];
    const alt = channel?.alternatives?.[0] || {};
    const segments = (alt.paragraphs?.paragraphs || []).map((p) => ({
      speaker: `Speaker ${p.speaker ?? 0}`,
      start: p.start,
      end: p.end,
      text: (p.sentences || []).map((s) => s.text).join(' '),
    }));
    return { text: alt.transcript || '', language: channel?.detected_language || language, segments };
  }
}

const overrides = { transcriber: undefined };
export function setTranscriberOverride(t) {
  overrides.transcriber = t;
}

export async function getTranscriber(orgId) {
  if (overrides.transcriber !== undefined) return overrides.transcriber;
  const integration = await loadIntegration(orgId, 'transcription', 'deepgram');
  const apiKey = integration?.credentials?.apiKey || env.deepgram.apiKey;
  return apiKey ? new DeepgramTranscriber({ apiKey, model: integration?.config?.model }) : null;
}
