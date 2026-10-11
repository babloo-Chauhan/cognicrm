import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, registerOrg, useDatabase } from './helpers.js';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicLlm, GeminiLlm, getLlm, setLlmOverride } from '../src/modules/ai/llm.js';

useDatabase();

function mockGemini(...responses) {
  const queue = [...responses];
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => queue.shift() }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const sent = (fetchMock, i) => JSON.parse(fetchMock.mock.calls[i][1].body);

afterEach(() => vi.unstubAllGlobals());

describe('Gemini provider', () => {
  it('translates tool calls both ways and keeps thought signatures', async () => {
    const fetchMock = mockGemini(
      { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'search_customer', args: { phone: '+9198' } }, thoughtSignature: 'sig1' }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Found Asha.' }] } }] },
    );
    const llm = new GeminiLlm({ apiKey: 'g-key', model: 'gemini-test' });
    const tools = [{ name: 'search_customer', description: 'Find a customer', input_schema: { type: 'object', properties: { phone: { type: 'string' } } } }];
    const messages = [{ role: 'user', content: 'Who is +9198?' }];

    const first = await llm.complete({ system: 'Be brief', messages, tools, maxTokens: 100 });
    expect(first.stopReason).toBe('tool_use');
    expect(first.toolCalls).toEqual([{ id: expect.any(String), name: 'search_customer', input: { phone: '+9198' } }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/models/gemini-test:generateContent');
    expect(init.headers['x-goog-api-key']).toBe('g-key');
    expect(sent(fetchMock, 0)).toMatchObject({
      systemInstruction: { parts: [{ text: 'Be brief' }] },
      contents: [{ role: 'user', parts: [{ text: 'Who is +9198?' }] }],
      tools: [{ functionDeclarations: [{ name: 'search_customer', parametersJsonSchema: tools[0].input_schema }] }],
    });

    // Same loop the assistant and voice agents run
    messages.push({ role: 'assistant', content: first.raw.content });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: first.toolCalls[0].id, content: JSON.stringify({ name: 'Asha' }) }] });
    const second = await llm.complete({ messages, tools });
    expect(second).toMatchObject({ text: 'Found Asha.', toolCalls: [], stopReason: 'end_turn' });
    expect(sent(fetchMock, 1).contents.slice(1)).toEqual([
      { role: 'model', parts: [{ functionCall: { name: 'search_customer', args: { phone: '+9198' } }, thoughtSignature: 'sig1' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'search_customer', response: { result: { name: 'Asha' } } } }] },
    ]);
  });

  it('extract() forces the record function', async () => {
    const fetchMock = mockGemini({ candidates: [{ content: { parts: [{ functionCall: { name: 'summary', args: { summary: 'ok' } } }] } }] });
    const out = await new GeminiLlm({ apiKey: 'k' }).extract({ prompt: 'Summarise', schema: { type: 'object' }, name: 'summary' });
    expect(out).toEqual({ summary: 'ok' });
    expect(sent(fetchMock, 0).toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['summary'] } });
  });

  it('surfaces API errors', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ error: { message: 'API key not valid' } }) }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new GeminiLlm({ apiKey: 'bad' }).complete({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ status: 502, message: expect.stringContaining('API key not valid') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected Anthropic key as a provider error, not a 500', async () => {
    const llm = new AnthropicLlm({ apiKey: 'wrong' });
    llm.client.messages.create = async () => {
      throw new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, undefined, new Headers());
    };
    await expect(llm.complete({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ status: 502, message: 'Anthropic request failed: invalid x-api-key' });
  });

  it('retries when Gemini is briefly overloaded', async () => {
    const replies = [
      { ok: false, status: 503, json: async () => ({ error: { message: 'high demand' } }) },
      { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }) },
    ];
    const fetchMock = vi.fn(async () => replies.shift());
    vi.stubGlobal('fetch', fetchMock);
    const res = await new GeminiLlm({ apiKey: 'k' }).complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.text).toBe('hi');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('switches to the fallback model when the main one is out of quota, without retrying it', async () => {
    const quota = { ok: false, status: 429, json: async () => ({ error: { message: 'You exceeded your current quota. Please retry in 6h24m4.24s.' } }) };
    const replies = [quota, { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'lite' }] } }] }) }];
    const fetchMock = vi.fn(async () => replies.shift());
    vi.stubGlobal('fetch', fetchMock);
    const res = await new GeminiLlm({ apiKey: 'k', model: 'gemini-main' }).complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.text).toBe('lite');
    expect(fetchMock.mock.calls.map(([url]) => url.match(/models\/([^:]+)/)[1])).toEqual(['gemini-main', 'gemini-flash-lite-latest']);
  });

  it('explains a used-up quota in plain words', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'You exceeded your current quota. Please retry in 6h24m4.24s.' } }) }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new GeminiLlm({ apiKey: 'k' }).complete({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ status: 502, message: expect.stringMatching(/^Gemini free quota is used up \(resets in about 6h24m\)/) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a company can connect a Gemini key and it becomes the AI provider', async () => {
    setLlmOverride(undefined);
    const admin = await registerOrg();
    expect(await getLlm(admin.org.id)).toBeNull();

    const anthropic = await http().put('/api/v1/integrations/ai/anthropic').set(admin.auth).send({ credentials: { apiKey: 'a-key' } });
    expect(anthropic.status).toBe(200);
    expect((await getLlm(admin.org.id)).name).toBe('anthropic');

    await http().put('/api/v1/integrations/ai/gemini').set(admin.auth).send({ credentials: { apiKey: 'g-key' } });
    const llm = await getLlm(admin.org.id);
    expect(llm).toMatchObject({ name: 'gemini', apiKey: 'g-key', model: 'gemini-flash-latest' });

    const status = await http().get('/api/v1/ai/status').set(admin.auth);
    expect(status.body.llm).toEqual({ provider: 'gemini', model: 'gemini-flash-latest' });

    // Disconnecting Gemini falls back to the other connected key
    await http().delete('/api/v1/integrations/ai/gemini').set(admin.auth);
    expect((await getLlm(admin.org.id)).name).toBe('anthropic');
  });
});
