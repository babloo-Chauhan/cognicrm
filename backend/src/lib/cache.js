import { createClient } from 'redis';
import { env } from '../config/env.js';
import { log } from './logger.js';

/**
 * Short-lived cache for expensive reads (dashboards, analytics, plan/tenant data).
 *
 * With REDIS_URL it uses Redis, so several API instances share one cache (and the rate-limit counters, see
 * app.js); without it, an in-memory store per process. If Redis is down, reads fall through to the
 * database — the cache never makes a request fail.
 *
 * Freshness: every company has a version number; `bumpCompany(orgId)` (called after CRM writes) makes all
 * of that company's cached entries miss, so dashboards show new records straight away. Entries also expire.
 */

const MAX_MEMORY_ENTRIES = 5000;
const memory = new Map(); // key -> { value, expires }

let redis = null;
let redisReady = false;

export function redisClient() {
  if (!env.redisUrl || env.isTest) return null;
  if (!redis) {
    // disableOfflineQueue: while Redis is unreachable, commands fail at once (callers fall back) instead of waiting
    redis = createClient({ url: env.redisUrl, disableOfflineQueue: true, socket: { connectTimeout: 3000, reconnectStrategy: (n) => Math.min(n * 500, 5000) } });
    redis.on('ready', () => { redisReady = true; log.info('redis.ready'); });
    redis.on('end', () => { redisReady = false; });
    redis.on('error', (err) => {
      if (redisReady) log.error('redis.error', { error: err.message });
      redisReady = false;
    });
    redis.connect().catch((err) => log.error('redis.connect_failed', { error: err.message }));
  }
  return redis;
}

const PREFIX = 'crm:';

async function getRaw(key) {
  const client = redisClient();
  if (client && redisReady) {
    try {
      const v = await client.get(PREFIX + key);
      return v === null ? undefined : JSON.parse(v);
    } catch { /* fall back to memory / database */ }
  }
  const hit = memory.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { memory.delete(key); return undefined; }
  return hit.value;
}

async function setRaw(key, value, ttlSeconds) {
  const client = redisClient();
  if (client && redisReady) {
    try {
      await client.set(PREFIX + key, JSON.stringify(value), { EX: ttlSeconds });
      return;
    } catch { /* fall back to memory */ }
  }
  if (memory.size >= MAX_MEMORY_ENTRIES) {
    // Drop expired entries, then the oldest ones (Map keeps insertion order)
    const now = Date.now();
    for (const [k, v] of memory) if (v.expires < now) memory.delete(k);
    for (const k of memory.keys()) { if (memory.size < MAX_MEMORY_ENTRIES * 0.9) break; memory.delete(k); }
  }
  memory.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

async function companyVersion(orgId) {
  return (await getRaw(`v:${orgId}`)) || 0;
}

/** Makes every cached entry of this company stale (after a write). Never throws. */
export async function bumpCompany(orgId) {
  if (!orgId) return;
  try {
    const client = redisClient();
    if (client && redisReady) {
      await client.multi().incr(`${PREFIX}v:${orgId}`).expire(`${PREFIX}v:${orgId}`, 86400).exec();
      return;
    }
  } catch { /* fall back to memory */ }
  const key = `v:${orgId}`;
  memory.set(key, { value: ((memory.get(key)?.value) || 0) + 1, expires: Date.now() + 86400000 });
}

/**
 * Returns the cached value for (company, key) or computes it with `fn` and caches it for `ttlSeconds`.
 * Concurrent misses for the same key share one computation, so a burst of dashboard loads runs the
 * expensive queries once.
 */
const inflight = new Map();
export async function cached(orgId, key, ttlSeconds, fn) {
  if (env.isTest && !process.env.CACHE_IN_TESTS) return fn();
  const full = `${orgId}:${await companyVersion(orgId)}:${key}`;
  const hit = await getRaw(full);
  if (hit !== undefined) return hit;
  if (inflight.has(full)) return inflight.get(full);
  const run = (async () => {
    try {
      const value = await fn();
      await setRaw(full, value, ttlSeconds);
      return value;
    } finally {
      inflight.delete(full);
    }
  })();
  inflight.set(full, run);
  return run;
}

/** Test helper. */
export function clearMemoryCache() {
  memory.clear();
}

export const cacheBackend = () => (redisClient() && redisReady ? 'redis' : 'memory');
export const redisIsReady = () => Boolean(redis) && redisReady;
