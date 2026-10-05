import { AppError } from './errors.js';

/** Small fetch wrapper for provider REST APIs with timeout and error normalization. */
export async function httpRequest(url, { method = 'GET', headers = {}, body, form, json, auth, timeoutMs = 15000 } = {}) {
  const finalHeaders = { ...headers };
  let payload = body;
  if (form) {
    finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((item) => params.append(k, String(item)));
      else params.append(k, String(v));
    }
    payload = params.toString();
  } else if (json !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  if (auth) {
    finalHeaders.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: finalHeaders, body: payload, signal: controller.signal });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      // Providers wrap errors differently (Exotel/Twilio-style RestException, Plivo `error`, Meta `error.message`).
      const detail = data && typeof data === 'object'
        ? (data.RestException?.Message || data.message || data.error?.message || (typeof data.error === 'string' ? data.error : null))
        : (typeof data === 'string' && data.length < 300 ? data : null);
      const message = detail ? `${detail} (HTTP ${res.status})` : `HTTP ${res.status}`;
      throw new AppError(502, `Provider request failed: ${message}`, 'PROVIDER_ERROR', { status: res.status, data });
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new AppError(504, 'Provider request timed out', 'PROVIDER_TIMEOUT');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
