import { env } from '../config/env.js';

/**
 * Structured JSON-lines logger. Callers pass only metadata: never passwords, tokens, secrets or full bodies.
 * Values under keys that look secret are redacted as a second line of defence.
 */
const SECRET_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|signature|cookie/i;

function redact(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = {};
  for (const [k, v] of Object.entries(meta)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : v;
  return out;
}

function write(level, msg, meta) {
  if (env.isTest && level !== 'error' && !process.env.LOG_IN_TESTS) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...redact(meta) });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
};

/** Request log: method, path, status, duration, tenant and user ids — no query values or bodies. */
export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    if (level === 'info' && (env.isTest || req.path === '/health')) return;
    write(level, 'request', {
      method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(ms),
      companyId: req.orgId ? String(req.orgId) : undefined, userId: req.user ? String(req.user._id) : undefined, ip: req.ip,
    });
  });
  next();
}
