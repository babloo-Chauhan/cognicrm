import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

let io = null;

export function initRealtime(httpServer) {
  io = new Server(httpServer, { cors: { origin: env.corsOrigin.split(','), credentials: true } });
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = jwt.verify(token, env.jwtSecret);
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
