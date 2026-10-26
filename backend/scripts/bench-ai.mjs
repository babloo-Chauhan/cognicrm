// Times one assistant round against the configured Gemini model with different thinking settings.
// node scripts/bench-ai.mjs   (uses GEMINI_API_KEY / GEMINI_MODEL from backend/.env; a few small requests)
import 'dotenv/config';
import { ASSISTANT_TOOLS, toolDefinitions } from '../src/modules/ai/tools.js';

const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const tools = toolDefinitions(ASSISTANT_TOOLS).map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema }));
const system = 'You are the COGNIEOS CRM assistant. Use the provided tools to read or change CRM data. Answer concisely in the user\'s language.';

async function round(label, thinkingConfig, text) {
  const body = {
    contents: [{ role: 'user', parts: [{ text }] }],
    systemInstruction: { parts: [{ text: system }] },
    tools: [{ functionDeclarations: tools }],
    generationConfig: { maxOutputTokens: 5120, ...(thinkingConfig ? { thinkingConfig } : {}) },
  };
  const t = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${globalThis.MODEL || model}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
  });
  const data = await res.json();
  const ms = Date.now() - t;
  const parts = data.candidates?.[0]?.content?.parts || [];
  const out = parts.map((p) => (p.functionCall ? `tool:${p.functionCall.name}` : p.thought ? '' : (p.text || '').slice(0, 40))).filter(Boolean).join(' | ');
  console.log(`${label.padEnd(16)} ${String(ms).padStart(6)} ms  status ${res.status}  thoughtTokens ${data.usageMetadata?.thoughtsTokenCount ?? 0}  -> ${out || data.error?.message?.slice(0, 80)}`);
  return data.modelVersion;
}

const q = 'mere hot leads dikhao';
for (const m of (process.argv[2] || model).split(',')) {
  globalThis.MODEL = m;
  console.log('== ' + m);
  await round('default', null, q);
  await round('think low', { thinkingLevel: 'low' }, q);
  await round('think low again', { thinkingLevel: 'low' }, q);
}
