import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/index.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { moduleForPath } from '../lib/modules.js';
import { permissionMatches, ROLE_PERMISSIONS } from '../lib/permissions.js';
import { getTenantContext, permissionsFor } from '../modules/saas/tenant.js';
import { apiCallsThisMonth, recordApiCall } from '../modules/saas/usage.js';

export { ROLE_PERMISSIONS };

/**
 * `user.permissions` is resolved per request from the company's Role documents (see authenticate);
 * built-in defaults are the fallback for code paths that load a user directly.
 */
export function hasPermission(user, permission) {
  const granted = [...(user.permissions || ROLE_PERMISSIONS[user.role] || []), ...(user.extraPermissions || [])];
  return permissionMatches(granted, permission);
}

/**
 * Company-user token. Claims are informational for clients: authorization always re-reads the user, company,
 * role and subscription from the database, so an edited token cannot widen access or switch tenant.
 */
export function signToken(user, ctx) {
  return jwt.sign(
    {
      sub: String(user._id),
      org: String(user.organizationId),
      companyId: String(user.organizationId),
      tenantId: ctx?.company?.tenantId,
      role: user.role,
      permissions: ctx ? permissionsFor(user, ctx) : undefined,
      subscriptionStatus: ctx?.subscription?.status,
      tv: user.tokenVersion || 0,
      typ: 'tenant',
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn },
  );
}

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** authenticateUser: valid token → active user of an existing company. */
export async function authenticate(req, _res, next) {
  const token = bearer(req);
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw unauthorized('Invalid or expired token');
  }
  if (payload.typ && payload.typ !== 'tenant') throw unauthorized('Invalid or expired token');
  const user = await User.findById(payload.sub).lean();
  // tokenVersion lets admins force-logout a user (all old tokens become invalid)
  if (!user || !user.active || (user.tokenVersion || 0) !== payload.tv) throw unauthorized('Session is no longer valid');
  // The tenant comes from the stored user, never from the request; a token whose tenant claim disagrees is rejected.
  if (payload.org && payload.org !== String(user.organizationId)) throw unauthorized('Session is no longer valid');
  const ctx = await getTenantContext(user.organizationId);
  if (!ctx) throw unauthorized('Company no longer exists');
  user.permissions = permissionsFor(user, ctx);
  req.user = user;
  req.orgId = user.organizationId;
  req.tenant = ctx;
  next();
}

// Paths a suspended / unapproved / lapsed company can still reach: its session and billing.
const ALWAYS_OPEN = /^\/(auth|billing|plans|notifications|push-tokens)(\/|$)/;

/** tenantMiddleware: blocks suspended or not-yet-approved companies (data is kept). */
export function tenantGuard(req, _res, next) {
  const { status } = req.tenant.company;
  if (status === 'active' || ALWAYS_OPEN.test(req.path)) return next();
  if (status === 'suspended') throw new AppError(403, 'This company account is suspended. Contact support.', 'COMPANY_SUSPENDED');
  throw new AppError(403, 'This company is waiting for approval.', 'COMPANY_PENDING_APPROVAL');
}

/**
 * subscriptionMiddleware: the route's module must be in the company's effective plan. A lapsed trial or
 * subscription falls back to the free plan's modules, so login, billing and the free modules keep working.
 */
export function moduleGuard(req, _res, next) {
  const ctx = req.tenant;
  for (const mod of moduleForPath(req.path)) {
    if (ctx.modules.includes(mod)) continue;
    if (!ctx.premium && ctx.planModules.includes(mod)) {
      throw new AppError(402, `Your ${ctx.subscription?.status === 'trial' || ctx.subscription?.status === 'expired' ? 'trial or subscription' : 'subscription'} has expired. Renew to use ${mod}.`, 'SUBSCRIPTION_INACTIVE', { module: mod, status: ctx.subscription?.status });
    }
    throw new AppError(403, `The ${mod} module is not included in your plan. Upgrade to use it.`, 'MODULE_NOT_IN_PLAN', { module: mod, plan: ctx.plan?.code });
  }
  next();
}

/** Counts API calls per company and enforces the plan's monthly API limit. */
export async function apiUsage(req, _res, next) {
  const limit = req.tenant.limits?.apiCallsPerMonth;
  if (limit !== undefined && limit >= 0 && await apiCallsThisMonth(req.orgId) >= limit) {
    throw new AppError(429, 'Monthly API call limit reached. Upgrade your plan.', 'PLAN_LIMIT_REACHED', { resource: 'apiCallsPerMonth', limit });
  }
  recordApiCall(String(req.orgId));
  next();
}

/** permissionMiddleware: any one of the listed permissions. */
export const requirePermission = (...permissions) => (req, _res, next) => {
  if (!permissions.some((p) => hasPermission(req.user, p))) throw forbidden();
  next();
};

/** authorizeRole: restrict to specific role keys (prefer permissions; this is for role-only rules). */
export const authorizeRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role)) throw forbidden();
  next();
};

/** Maps the HTTP method to a CRUD permission on `resource` (GET → read, POST → create, ...). */
const METHOD_ACTION = { GET: 'read', HEAD: 'read', POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };
export const requireResource = (resource) => (req, _res, next) => {
  if (!hasPermission(req.user, `${resource}:${METHOD_ACTION[req.method] || 'read'}`)) throw forbidden();
  next();
};
