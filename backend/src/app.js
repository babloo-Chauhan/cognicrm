import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/common.js';
import authRoutes from './modules/auth/routes.js';
import crmRoutes from './modules/crm/routes.js';
import callRoutes from './modules/calls/routes.js';
import contactCenterRoutes from './modules/contactCenter/routes.js';
import opsRoutes, { publicRouter as recordingPublicRoutes } from './modules/contactCenter/opsRoutes.js';
import messagingRoutes, { webchatRouter } from './modules/messaging/routes.js';
import aiRoutes from './modules/ai/routes.js';
import webhookRoutes from './modules/webhooks/routes.js';
import salesRoutes, { publicSalesRouter } from './modules/sales/routes.js';
import { registerListeners } from './listeners.js';

export function createApp() {
  registerListeners();
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.corsOrigin.split(','), credentials: true }));
  // Keep the raw body for webhook signature validation (Meta X-Hub-Signature-256)
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  const apiLimiter = rateLimit({ windowMs: 60000, limit: env.isTest ? 10000 : 600, standardHeaders: true, legacyHeaders: false });
  const authLimiter = rateLimit({ windowMs: 15 * 60000, limit: env.isTest ? 10000 : 30, standardHeaders: true, legacyHeaders: false });

  // Public endpoints: provider webhooks (signature validated), web chat widget, signed recording links
  api.use(webhookRoutes);
  api.use(webchatRouter);
  api.use(recordingPublicRoutes);
  api.use('/auth/login', authLimiter);
  api.use('/auth/register', authLimiter);
  api.use(apiLimiter);
  api.use(authRoutes);
  // Customer links for quotations / invoices (unguessable token, no login)
  api.use(publicSalesRouter);

  // Everything below requires a valid session
  api.use(authenticate);
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
