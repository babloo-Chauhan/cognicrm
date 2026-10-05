import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/index.js';
import { forbidden, unauthorized } from '../lib/errors.js';

/**
 * Role → permission map. `*` grants everything; `crm:*` grants every permission starting with `crm:`.
 * Organizations can grant extra permissions per user through `user.extraPermissions`.
 */
export const ROLE_PERMISSIONS = {
  admin: ['*'],
  supervisor: [
    'crm:*', 'calls:make', 'calls:read_all', 'calls:control_all', 'recordings:read', 'transcripts:read',
    'queues:manage', 'agents:manage', 'supervisor:*', 'campaigns:manage', 'callbacks:manage', 'analytics:read',
    'inbox:all', 'messages:send', 'numbers:view_full', 'ivr:manage', 'business_hours:manage', 'dispositions:manage',
    'voicemail:all', 'compliance:manage', 'ai:use', 'alerts:read', 'billing:manage',
  ],
  agent: ['crm:*', 'calls:make', 'messages:send', 'ai:use', 'recordings:read_own', 'transcripts:read'],
  user: ['crm:*', 'ai:use'],
};

export function hasPermission(user, permission) {
  const granted = [...(ROLE_PERMISSIONS[user.role] || []), ...(user.extraPermissions || [])];
  return granted.some((p) => p === '*' || p === permission || (p.endsWith(':*') && permission.startsWith(p.slice(0, -1))));
}

export function signToken(user) {
  return jwt.sign(
    { sub: String(user._id), org: String(user.organizationId), role: user.role, tv: user.tokenVersion || 0 },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn },
  );
}

export async function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw unauthorized('Invalid or expired token');
  }
  const user = await User.findById(payload.sub).lean();
  // tokenVersion lets supervisors force-logout a user (all old tokens become invalid)
  if (!user || !user.active || (user.tokenVersion || 0) !== payload.tv) throw unauthorized('Session is no longer valid');
  req.user = user;
  req.orgId = user.organizationId;
  next();
}

export const requirePermission = (...permissions) => (req, _res, next) => {
  if (!permissions.some((p) => hasPermission(req.user, p))) throw forbidden();
  next();
};
