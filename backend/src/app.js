import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
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
import { registerListeners } from './listeners.js';

const DB_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

export function createApp() {
  registerListeners();
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.corsOrigin.split(',').map((o) => o.trim()), credentials: true }));
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
  const apiLimiter = rateLimit({ windowMs: 60000, limit: env.isTest ? 10000 : 600, standardHeaders: true, legacyHeaders: false });
  const authLimiter = rateLimit({ windowMs: 15 * 60000, limit: env.isTest ? 10000 : 30, standardHeaders: true, legacyHeaders: false });

  // Public endpoints: provider webhooks (signature validated), web chat widget, signed recording links
  api.use(publicBillingRouter); // plan catalog + payment webhooks
  api.use(webhookRoutes);
  api.use(webchatRouter);
  api.use(recordingPublicRoutes);
  api.use(['/auth/login', '/auth/register', '/platform/auth/login', '/auth/switch-company'], authLimiter);
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
  api.use(pipelineRoutes);
  api.use(crmRoutes);
  api.use(callRoutes);
  api.use(contactCenterRoutes);
  api.use(opsRoutes);
  api.use(messagingRoutes);
  api.use(aiRoutes);
  api.use(salesRoutes);

  app.use('/api/v1', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
