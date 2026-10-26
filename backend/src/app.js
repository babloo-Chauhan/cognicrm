import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import rateLimit, { ipKeyGenerator, MemoryStore } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redisClient, redisIsReady } from './lib/cache.js';
import { env } from './config/env.js';
import {
  apiUsage, authenticate, moduleGuard, tenantGuard,
} from './middleware/auth.js';
import { errorHandler, notFoundHandler, sanitizeBody } from './middleware/common.js';
import { requestLogger } from './lib/logger.js';
import authRoutes, { publicAuthRouter } from './modules/auth/routes.js';
import crmRoutes from './modules/crm/routes.js';
import pipelineRoutes from './modules/crm/pipelines.js';
import dashboardRoutes from './modules/crm/dashboard.js';
import reportRoutes from './modules/reports/routes.js';
import followUpRoutes from './modules/crm/followUps.js';
import callRoutes from './modules/calls/routes.js';
import contactCenterRoutes from './modules/contactCenter/routes.js';
import opsRoutes, { publicRouter as recordingPublicRoutes } from './modules/contactCenter/opsRoutes.js';
import messagingRoutes, { webchatRouter } from './modules/messaging/routes.js';
import aiRoutes from './modules/ai/routes.js';
import webhookRoutes from './modules/webhooks/routes.js';
import salesRoutes, { publicSalesRouter } from './modules/sales/routes.js';
import teamRoutes from './modules/saas/teamRoutes.js';
import billingRoutes, { publicBillingRouter } from './modules/saas/billingRoutes.js';
import platformRoutes, { platformPublicRouter } from './modules/platform/routes.js';
import { capturePublicRouter, leadSourceRouter } from './modules/leadCapture/routes.js';
import { registerListeners } from './listeners.js';

const DB_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

/**
 * Rate-limit counters in Redis, falling back to this process's memory while Redis is unreachable, so an
 * outage neither blocks requests nor writes an error line for every request.
 */
class FallbackStore {
  constructor(redisStore) {
    this.redis = redisStore;
    this.memory = new MemoryStore();
  }

  init(options) {
    this.redis.init?.(options);
    this.memory.init(options);
  }

  async use(method, key) {
    if (redisIsReady()) {
      try {
        return await this.redis[method](key);
      } catch { /* fall through to memory */ }
    }
    return this.memory[method](key);
  }

  increment(key) { return this.use('increment', key); }

  decrement(key) { return this.use('decrement', key); }

  resetKey(key) { return this.use('resetKey', key); }
}

export function createApp() {
  registerListeners();
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  // Lead capture takes enquiries from the company's own website, so any site may post to it (no cookies involved)
  const corsOrigins = env.corsOrigin.split(',').map((o) => o.trim());
  app.use(cors((req, cb) => cb(null, req.path.startsWith('/api/v1/capture/') ? { origin: true } : { origin: corsOrigins, credentials: true })));
  app.use(requestLogger);
  // Keep the raw body for webhook signature validation (Meta X-Hub-Signature-256, Razorpay, Stripe)
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(sanitizeBody);

  // Liveness + database check for load balancers / Render. Never includes secrets or connection strings.
  app.get('/health', (_req, res) => {
    const database = DB_STATES[mongoose.connection.readyState] || 'unknown';
    res.status(database === 'connected' ? 200 : 503).json({ status: database === 'connected' ? 'ok' : 'degraded', ok: database === 'connected', database, environment: env.nodeEnv });
  });

  const api = express.Router();
  // Rate limits. A whole office usually shares one public IP, so the normal API limit is per signed-in
  // session (bearer token) and sign-in attempts are limited per account; per-IP limits are only a flood guard.
  const ip = (req) => ipKeyGenerator(req.ip);
  const session = (req) => {
    const auth = req.headers.authorization;
    return auth?.startsWith('Bearer ') ? `s:${createHash('sha256').update(auth.slice(7)).digest('base64url').slice(0, 22)}` : `ip:${ip(req)}`;
  };
  const account = (req) => `${ip(req)}:${String(req.body?.email || req.body?.employeeId || '').trim().toLowerCase()}`;
  // With Redis the counters are shared by all API instances; without it each instance counts on its own
  const redis = redisClient();
  let storeNo = 0;
  const limiterOptions = (windowMs, limit, keyGenerator) => ({
    windowMs, limit: env.isTest ? 100000 : limit, keyGenerator, standardHeaders: true, legacyHeaders: false,
    ...(redis ? { store: new FallbackStore(new RedisStore({ prefix: `crm:rl${(storeNo += 1)}:`, sendCommand: (...args) => redis.sendCommand(args) })) } : {}),
    passOnStoreError: true,
  });
  const limiter = (windowMs, limit, keyGenerator) => rateLimit(limiterOptions(windowMs, limit, keyGenerator));
  const ipFloodLimiter = limiter(60000, env.rateLimit.ipPerMinute, ip);
  const AUTH_PATHS = ['/auth/login', '/auth/register', '/platform/auth/login', '/auth/switch-company'];
  // Sign-in routes have their own per-account limits below; counting them here too would let one
  // person's wrong passwords block everyone else signing in from the same office IP
  const apiLimiter = rateLimit({ ...limiterOptions(60000, env.rateLimit.perMinute, session), skip: (req) => AUTH_PATHS.includes(req.path) });
  const authLimiter = limiter(15 * 60000, 30, account); // wrong-password guessing on one account
  const authIpLimiter = limiter(15 * 60000, 600, ip); // many accounts from one IP

  // Public endpoints: provider webhooks (signature validated), web chat widget, signed recording links
  api.use(publicBillingRouter); // plan catalog + payment webhooks
  api.use(webhookRoutes);
  api.use(webchatRouter);
  api.use(recordingPublicRoutes);
  api.use(ipFloodLimiter);
  // Lead capture (website forms, Justdial, IndiaMART, Meta, Google Ads): unguessable token per source
  api.use('/capture', limiter(60000, 120, ip), capturePublicRouter);
  api.use(AUTH_PATHS, authIpLimiter, authLimiter);
  api.use(apiLimiter);
  api.use(publicAuthRouter);
  api.use(platformPublicRouter);
  // Customer links for quotations / invoices (unguessable token, no login)
  api.use(publicSalesRouter);
  // Super-admin API: its own token type; guarded inside the router for /platform/* only
  api.use(platformRoutes);

  // Everything below: authenticateUser → tenantMiddleware → subscription/module → API usage → permissions (per route)
  api.use(authenticate, tenantGuard, moduleGuard, apiUsage);
  api.use(authRoutes);
  api.use(teamRoutes);
  api.use(billingRoutes);
  api.use(dashboardRoutes);
  api.use(reportRoutes);
  api.use(followUpRoutes);
  api.use(pipelineRoutes);
  api.use(crmRoutes);
  api.use(callRoutes);
  api.use(contactCenterRoutes);
  api.use(opsRoutes);
  api.use(messagingRoutes);
  api.use(aiRoutes);
  api.use(salesRoutes);
  api.use(leadSourceRouter);

  app.use('/api/v1', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
