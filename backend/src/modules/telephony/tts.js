/**
 * Text-to-speech abstraction. Languages are never hard-coded in flows: a flow/agent asks for
 * a logical language ("en", "hi", "hinglish", ...) and the TTS provider resolves the voice.
 *
 * - provider_native: the telephony provider speaks the text (TwiML <Say>, Plivo <Speak>)
 * - Future engines (e.g. ElevenLabs, Google TTS) can render text to an audio URL and return
 *   a `play` action instead — register them in TTS_ENGINES.
 */
const NATIVE_VOICES = {
  en: { language: 'en-IN', voice: 'Polly.Raveena' },
  hi: { language: 'hi-IN', voice: 'Polly.Aditi' },
  hinglish: { language: 'hi-IN', voice: 'Polly.Aditi' },
  'en-US': { language: 'en-US', voice: 'Polly.Joanna' },
  'en-GB': { language: 'en-GB', voice: 'Polly.Amy' },
};

const TTS_ENGINES = {
  provider_native: {
    async speak(text, language, settings = {}) {
      const v = NATIVE_VOICES[language] || NATIVE_VOICES[language?.split('-')[0]] || NATIVE_VOICES.en;
      return { type: 'say', text, language: settings.languageCode || v.language, voice: settings.voiceId || v.voice };
    },
  },
};

export function registerTtsEngine(name, engine) {
  TTS_ENGINES[name] = engine;
}

export async function speak(text, language = 'en', settings = {}) {
  const engine = TTS_ENGINES[settings.provider || 'provider_native'] || TTS_ENGINES.provider_native;
  return engine.speak(text, language, settings);
}

/** Picks the text for a language from a string or a { en, hi, ... } translation map. */
export function translate(value, language, fallbackLanguage = 'en', translations = {}) {
  if (value == null) return '';
  if (typeof value === 'string') {
    const m = value.match(/^\{\{t:([\w.-]+)\}\}$/);
    if (m && translations[m[1]]) return translate(translations[m[1]], language, fallbackLanguage);
    return value;
  }
  return value[language] ?? value[fallbackLanguage] ?? Object.values(value)[0] ?? '';
}
