import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';
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
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    });
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

const overrides = { llm: undefined };

/** Tests can inject an LLM implementation. */
export function setLlmOverride(llm) {
  overrides.llm = llm;
}

export async function getLlm(orgId) {
  if (overrides.llm !== undefined) return overrides.llm;
  const integration = orgId ? await loadIntegration(orgId, 'ai', 'anthropic') : null;
  const apiKey = integration?.credentials?.apiKey || env.anthropic.apiKey;
  if (!apiKey) return null;
  return new AnthropicLlm({ apiKey, model: integration?.config?.model || env.anthropic.model });
}
