import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { PlatformUser } from '../../models/index.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import { log } from '../../lib/logger.js';

/** Platform (super-admin) tokens: own secret and `typ`, so company tokens never work here and vice versa. */
export function signPlatformToken(admin) {
  return jwt.sign({ sub: String(admin._id), role: admin.role, tv: admin.tokenVersion || 0, typ: 'platform' }, env.platformJwtSecret, { expiresIn: env.platformJwtExpiresIn });
}

export async function authenticatePlatform(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, env.platformJwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw unauthorized('Invalid or expired token');
  }
  if (payload.typ !== 'platform') throw unauthorized('Invalid or expired token');
  const admin = await PlatformUser.findById(payload.sub).lean();
  if (!admin || !admin.active || (admin.tokenVersion || 0) !== payload.tv) throw unauthorized('Session is no longer valid');
  req.platformUser = admin;
  next();
}

/** `support` platform users are read-only; changes need `super_admin`. */
export function requireSuperAdmin(req, _res, next) {
  if (req.method !== 'GET' && req.platformUser.role !== 'super_admin') throw forbidden('Super admin only');
  next();
}

export async function createPlatformUser({ email, password, name, role = 'super_admin' }) {
  return PlatformUser.create({ email: email.toLowerCase(), name, role, passwordHash: await bcrypt.hash(password, 12) });
}

/** Creates the first super admin from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD when none exists. */
export async function ensureSuperAdmin() {
  const { email, password, name } = env.superAdmin;
  if (!email || !password) return null;
  if (await PlatformUser.exists({})) return null;
  if (password.length < 12) {
    log.warn('platform.super_admin_not_created', { reason: 'SUPER_ADMIN_PASSWORD must be at least 12 characters' });
    return null;
  }
  const admin = await createPlatformUser({ email, password, name });
  log.info('platform.super_admin_created', { email: admin.email });
  return admin;
}
