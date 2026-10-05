import http from 'node:http';
import mongoose from 'mongoose';
import { env } from './src/config/env.js';
import { createApp } from './src/app.js';
import { initRealtime } from './src/lib/realtime.js';
import { startJobs } from './src/jobs/scheduler.js';

async function main() {
  await mongoose.connect(env.mongoUri);
  console.log('MongoDB connected');

  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server);
  const stopJobs = env.jobsEnabled ? startJobs() : () => {};

  server.listen(env.port, () => {
    console.log(`COGNIEOS CRM API listening on port ${env.port}`);
  });

  const shutdown = async () => {
    stopJobs();
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
