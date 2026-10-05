const BASE = import.meta.env.VITE_API_URL || '/api/v1';
const TOKEN_KEY = 'cognieos.token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.code || body?.error?.code;
    this.details = body?.errors?.length ? body.errors : body?.error?.details;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(path, { method = 'GET', body, query, raw } = {}) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res;
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.status === 401 && token) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const get = (path, query) => api(path, { query });
export const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });
export const patch = (path, body) => api(path, { method: 'PATCH', body });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const del = (path) => api(path, { method: 'DELETE' });

/** Downloads an authenticated file (CSV/Excel export). */
export async function download(path, query, filename) {
  const res = await api(path, { query, raw: true });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Uploads a file as the raw request body (CSV/Excel import). Options travel in the query string. */
export async function upload(path, file, query) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const headers = { 'Content-Type': file.type || 'application/octet-stream' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, body: file });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && token) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/**
 * Super-admin (platform) client. Separate token storage: a platform session never mixes with a company session.
 */
const PLATFORM_TOKEN_KEY = 'cognieos.platformToken';
let onPlatformUnauthorized = () => {};

export const platformToken = {
  get() {
    try { return localStorage.getItem(PLATFORM_TOKEN_KEY); } catch { return null; }
  },
  set(token) {
    try {
      if (token) localStorage.setItem(PLATFORM_TOKEN_KEY, token);
      else localStorage.removeItem(PLATFORM_TOKEN_KEY);
    } catch { /* storage unavailable */ }
  },
  onUnauthorized(fn) { onPlatformUnauthorized = fn; },
};

export async function platformApi(path, { method = 'GET', body, query } = {}) {
  const url = new URL(`${BASE}/platform${path}`, window.location.origin);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const headers = {};
  const token = platformToken.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.status === 401 && token) onPlatformUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const pget = (path, query) => platformApi(path, { query });
export const ppost = (path, body) => platformApi(path, { method: 'POST', body: body ?? {} });
export const pput = (path, body) => platformApi(path, { method: 'PUT', body });
export const ppatch = (path, body) => platformApi(path, { method: 'PATCH', body });
export const pdel = (path, body) => platformApi(path, { method: 'DELETE', body });
