import http from 'node:http';
import mongoose from 'mongoose';
import { env } from './src/config/env.js';
import { createApp } from './src/app.js';
import { initRealtime } from './src/lib/realtime.js';
import { startJobs } from './src/jobs/scheduler.js';
import { log } from './src/lib/logger.js';
import { runSaasMigrations } from './src/modules/saas/migrate.js';
import { flushUsage } from './src/modules/saas/usage.js';
import { ensureSuperAdmin } from './src/modules/platform/auth.js';

async function main() {
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 15000 });
  log.info('mongodb.connected', { db: mongoose.connection.name });
  await runSaasMigrations();
  await ensureSuperAdmin();

  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server);
  const stopJobs = env.jobsEnabled ? startJobs() : () => {};
  // API-call counters are buffered in memory; flushed on every instance (jobs may be disabled on web nodes)
  const usageTimer = setInterval(() => flushUsage().catch((err) => log.error('usage.flush_failed', { error: err.message })), 15000);

  server.listen(env.port, () => {
    log.info('server.listening', { port: env.port, environment: env.nodeEnv });
  });
  server.on('error', (err) => {
    log.error('server.error', { error: err.message, code: err.code });
    process.exit(1);
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log.info('server.shutdown', { signal });
    stopJobs();
    clearInterval(usageTimer);
    // Stop accepting connections, let in-flight requests finish (max 10s), then close the database
    const force = setTimeout(() => process.exit(1), 10000);
    force.unref();
    server.close(async () => {
      await flushUsage().catch(() => null);
      await mongoose.disconnect();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error('unhandled_rejection', { error: err?.message }));
}

main().catch((err) => {
  log.error('startup_failed', { error: err.message, code: err.code });
  process.exit(1);
});
