import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpRequest } from '../src/lib/http.js';

afterEach(() => vi.unstubAllGlobals());

describe('provider error messages', () => {
  it('surfaces Exotel RestException messages', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ RestException: { Status: 403, Message: 'Trial account can only call verified numbers' } }), { status: 403 }));
    await expect(httpRequest('https://x/y')).rejects.toThrow('Provider request failed: Trial account can only call verified numbers (HTTP 403)');
  });
  it('falls back to the status code', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 500 }));
    await expect(httpRequest('https://x/y')).rejects.toThrow('Provider request failed: HTTP 500');
  });
});
