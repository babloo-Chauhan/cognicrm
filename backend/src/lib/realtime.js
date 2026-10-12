import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import jwt from 'jsonwebtoken';
import { createClient } from 'redis';
import { env } from '../config/env.js';
import { log } from './logger.js';

let io = null;

export function initRealtime(httpServer) {
  io = new Server(httpServer, { cors: { origin: env.corsOrigin.split(','), credentials: true } });
  useRedisAdapter(io);
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      // Same rules as the REST API: HS256 only, and company (tenant) sessions only — never a platform token
      const payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
      if ((payload.typ && payload.typ !== 'tenant') || !payload.org || !payload.sub) throw new Error('not a company session');
      socket.data.user = payload;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    const { sub, org, role } = socket.data.user;
    socket.join(`org:${org}`);
    socket.join(`user:${sub}`);
    if (role === 'admin' || role === 'supervisor') socket.join(`supervisors:${org}`);
  });
  return io;
}

export function emitToOrg(orgId, event, data) {
  io?.to(`org:${orgId}`).emit(event, data);
}

export function emitToUser(userId, event, data) {
  io?.to(`user:${userId}`).emit(event, data);
}

export function emitToSupervisors(orgId, event, data) {
  io?.to(`supervisors:${orgId}`).emit(event, data);
}

export function disconnectUser(userId) {
  io?.in(`user:${userId}`).disconnectSockets(true);
}

export function getIO() {
  return io;
}

/**
 * With REDIS_URL, events emitted on one API instance reach browsers and phones connected to any other
 * instance (needed once there is more than one). Without Redis, a single instance delivers its own events.
 */
function useRedisAdapter(server) {
  if (!env.redisUrl || env.isTest) return;
  const pub = createClient({ url: env.redisUrl, socket: { reconnectStrategy: (n) => Math.min(n * 500, 5000) } });
  const sub = pub.duplicate();
  let warned = false;
  const onError = (err) => {
    if (!warned) log.error('realtime.redis_error', { error: err.message });
    warned = true;
  };
  pub.on('error', onError);
  sub.on('error', onError);
  pub.on('ready', () => { warned = false; });
  Promise.all([pub.connect(), sub.connect()])
    .then(() => {
      server.adapter(createAdapter(pub, sub, { key: 'crm:socket.io' }));
      log.info('realtime.redis_adapter');
    })
    .catch((err) => log.error('realtime.redis_adapter_failed', { error: err.message }));
}
