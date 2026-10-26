import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { Organization } from '../../models/index.js';
import { loadIntegration } from '../telephony/registry.js';

/**
 * LLM provider abstraction. CRM features call `complete()` / `extract()` and never a vendor SDK
 * directly, so the model vendor can be swapped. Returns null from getLlm() when no AI provider
 * is configured — AI features then report "not configured" instead of faking output.
 */
export class LlmProvider {
  /** @returns {Promise<{ text: string, toolCalls: Array<{id,name,input}>, stopReason: string, raw: any }>} */
  async complete() { throw new Error('not implemented'); }

  /** Structured extraction: returns an object matching `schema`. */
  async extract() { throw new Error('not implemented'); }
}

export class AnthropicLlm extends LlmProvider {
  constructor({ apiKey, model }) {
    super();
    this.client = new Anthropic({ apiKey });
    this.model = model || env.anthropic.model;
    this.name = 'anthropic';
  }

  async complete({ system, messages, tools, maxTokens = 1024, toolChoice }) {
    let res;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages,
        ...(tools?.length ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
      });
    } catch (err) {
      // SDK errors (bad key, rate limit, ...) would otherwise surface as a bare 500
      if (!(err instanceof Anthropic.APIError)) throw err;
      throw new AppError(502, `Anthropic request failed: ${err.error?.error?.message || err.message}`, 'AI_PROVIDER_ERROR');
    }
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const toolCalls = res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
    return { text, toolCalls, stopReason: res.stop_reason, raw: res };
  }

  async extract({ system, prompt, schema, name = 'record', maxTokens = 2048 }) {
    const res = await this.complete({
      system,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ name, description: 'Record the structured result.', input_schema: schema }],
      toolChoice: { type: 'tool', name },
      maxTokens,
    });
    return res.toolCalls[0]?.input || null;
  }
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// Gemini counts its internal "thinking" against maxOutputTokens, so leave room for it on top of the answer.
const GEMINI_THINKING_HEADROOM = 4096;
// A busy model (503 / short 429) is retried once quickly, then the fallback model is tried
const GEMINI_RETRIES = 1;
const GEMINI_TIMEOUT_MS = 25000;

function parseToolResult(content) {
  if (typeof content !== 'string') return content;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/**
 * Converts the Anthropic-shaped conversation the callers build (text / tool_use / tool_result
 * blocks) into Gemini `contents`. Blocks produced by GeminiLlm carry the original part in `gemini`
 * so its thought signature goes back unchanged, which Gemini requires for multi-step tool calls.
 */
function toGeminiContents(messages) {
  const calls = new Map();
  return messages.map((m) => {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    const parts = blocks.map((b) => {
      if (b.type === 'tool_use') {
        calls.set(b.id, { name: b.name, id: b.gemini?.functionCall?.id });
        return b.gemini || { functionCall: { name: b.name, args: b.input || {} } };
      }
      if (b.type === 'tool_result') {
        const call = calls.get(b.tool_use_id) || {};
        return { functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: { result: parseToolResult(b.content) } } };
      }
      if (b.gemini) return b.gemini;
      return b.text ? { text: b.text } : null;
    }).filter(Boolean);
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  }).filter((c) => c.parts.length);
}

export class GeminiLlm extends LlmProvider {
  constructor({ apiKey, model }) {
    super();
    this.apiKey = apiKey;
    this.model = model || env.gemini.model;
    this.fallbackModel = env.gemini.fallbackModel;
    this.name = 'gemini';
  }

  async complete({ system, messages, tools, maxTokens = 1024, toolChoice, fast = false }) {
    const body = {
      contents: toGeminiContents(messages),
      generationConfig: {
        maxOutputTokens: maxTokens + GEMINI_THINKING_HEADROOM,
        // Chat replies: think briefly. Models that do not take a thinking level get the request without it.
        ...(fast ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
      },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(tools?.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }] } : {}),
      ...(toolChoice?.type === 'tool' ? { toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.name] } } } : {}),
    };
    const data = await this.generate(body);
    const candidate = data.candidates?.[0];
    if (!candidate) throw new AppError(502, `Gemini returned no answer${data.promptFeedback?.blockReason ? ` (${data.promptFeedback.blockReason})` : ''}`, 'AI_PROVIDER_ERROR');

    // Normalise to Anthropic-style blocks so callers can push `raw.content` back into the conversation.
    const content = (candidate.content?.parts || []).map((part, i) => (part.functionCall
      ? { type: 'tool_use', id: part.functionCall.id || `gemini_${Date.now()}_${i}`, name: part.functionCall.name, input: part.functionCall.args || {}, gemini: part }
      : { type: 'text', text: part.thought ? '' : part.text || '', gemini: part }));
    const text = content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n').trim();
    const toolCalls = content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
    const stopReason = toolCalls.length ? 'tool_use' : candidate.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
    return { text, toolCalls, stopReason, raw: { ...data, content } };
  }

  async extract({ system, prompt, schema, name = 'record', maxTokens = 2048 }) {
    const res = await this.complete({
      system,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ name, description: 'Record the structured result.', input_schema: schema }],
      toolChoice: { type: 'tool', name },
      maxTokens,
    });
    return res.toolCalls[0]?.input || null;
  }

  /** Calls the configured model; when it is overloaded or out of quota, tries the fallback model once. */
  async generate(body) {
    const models = [this.model, this.fallbackModel].filter((m, i, all) => m && all.indexOf(m) === i);
    let failure;
    for (const model of models) {
      failure = await this.request(model, body);
      if (failure.ok) return failure.data;
      if (![429, 500, 503].includes(failure.status)) break;
    }
    const { status, data } = failure;
    const message = data.error?.message || failure.statusText;
    if (status === 429 && /quota/i.test(message)) {
      // "Please retry in 6h24m4.24s." -> "6h24m"; seconds only -> "a minute"
      const wait = message.match(/retry in ((?:\d+h)?(?:\d+m)?)/i)?.[1] || (/retry in/i.test(message) ? 'a minute' : '');
      throw new AppError(502, `Gemini free quota is used up${wait ? ` (resets in about ${wait})` : ''}. Try again later, or enable billing in Google AI Studio for higher limits.`, 'AI_PROVIDER_ERROR');
    }
    if (status === 503) throw new AppError(502, 'Gemini is busy right now. Please try again in a minute.', 'AI_PROVIDER_ERROR');
    throw new AppError(502, `Gemini request failed: ${message}`, 'AI_PROVIDER_ERROR');
  }

  async request(model, body) {
    let res;
    let data;
    // Gemini often answers 503 "high demand" / 429 for a few seconds; retry those briefly.
    // A used-up quota (429 mentioning quota) does not recover in seconds, so it is not retried.
    for (let attempt = 0; attempt <= GEMINI_RETRIES; attempt += 1) {
      if (attempt) await new Promise((r) => { setTimeout(r, 800 * attempt); });
      try {
        res = await fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        });
      } catch (err) {
        // Timed out: treat like "busy" so the fallback model gets a turn
        if (err.name !== 'TimeoutError' && err.name !== 'AbortError') throw err;
        return { ok: false, status: 503, statusText: 'timeout', data: { error: { message: 'The model took too long to answer' } } };
      }
      data = await res.json().catch(() => ({}));
      if (res.status === 400 && body.generationConfig?.thinkingConfig && /thinking/i.test(data.error?.message || '')) {
        // This model does not take a thinking level (e.g. older 2.5 models): ask again without it
        delete body.generationConfig.thinkingConfig;
        attempt -= 1;
        continue;
      }
      if (![429, 500, 503].includes(res.status) || /quota/i.test(data.error?.message || '')) break;
    }
    return { ok: res.ok, status: res.status, statusText: res.statusText, data };
  }
}

const PROVIDERS = { gemini: GeminiLlm, anthropic: AnthropicLlm };

const overrides = { llm: undefined };

/** Tests can inject an LLM implementation. */
export function setLlmOverride(llm) {
  overrides.llm = llm;
}

/** Provider names to try, preferred first, then the rest in PROVIDERS order. */
function providerOrder(preferred) {
  return [preferred, ...Object.keys(PROVIDERS)].filter((p, i, all) => p && PROVIDERS[p] && all.indexOf(p) === i);
}

/**
 * Resolves the AI provider: the organization's own keys first (its chosen provider, then any other
 * connected one), then server-wide environment keys (AI_PROVIDER, else Gemini, else Anthropic).
 */
export async function getLlm(orgId) {
  if (overrides.llm !== undefined) return overrides.llm;
  if (orgId) {
    const org = await Organization.findById(orgId).select('settings.aiProvider').lean();
    for (const provider of providerOrder(org?.settings?.aiProvider)) {
      const integration = await loadIntegration(orgId, 'ai', provider);
      const apiKey = integration?.credentials?.apiKey || (integration && env[provider].apiKey);
      if (apiKey) return new PROVIDERS[provider]({ apiKey, model: integration.config?.model });
    }
  }
  const provider = providerOrder(env.aiProvider).find((p) => env[p].apiKey);
  return provider ? new PROVIDERS[provider]({ apiKey: env[provider].apiKey }) : null;
}
