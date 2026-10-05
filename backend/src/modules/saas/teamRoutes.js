import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Role, User } from '../../models/index.js';
import { hasPermission, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/common.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import {
  isValidPermission, PERMISSION_GROUPS, permissionMatches, ROLE_PERMISSIONS,
} from '../../lib/permissions.js';
import { publicUser } from '../auth/routes.js';
import { invalidateTenant, permissionsFor } from './tenant.js';
import { checkLimit } from './usage.js';
import { nextUserCode } from './provisioning.js';

const router = Router();
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

/** Anti privilege-escalation: an actor may only hand out permissions it holds itself. */
function canGrant(actor, permissions) {
  return permissions.every((p) => permissionMatches(actor.permissions, p));
}

function roleOf(req, key) {
  const perms = req.tenant.rolePermissions[key] || ROLE_PERMISSIONS[key];
  return perms ? { key, permissions: perms } : null;
}

function assertAssignable(req, roleKey, extraPermissions = []) {
  const role = roleOf(req, roleKey);
  if (!role) throw badRequest(`Unknown role "${roleKey}"`);
  if (!canGrant(req.user, [...role.permissions, ...extraPermissions])) throw forbidden('You cannot assign a role with more access than your own');
}

// ---------------------------------------------------------------- Users
const userSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
  role: z.string().trim().min(1).default('agent'),
  phone: z.string().trim().max(20).optional(),
  extension: z.string().max(10).optional(),
  department: z.string().trim().max(60).optional(),
  designation: z.string().trim().max(60).optional(),
  departmentIds: z.array(objectId).optional(),
  language: z.string().max(10).optional(),
  extraPermissions: z.array(z.string()).optional(),
});

// Everyone in the company can list colleagues (owner / assignee pickers); details stay within the tenant.
router.get('/users', async (req, res) => {
  const filter = { organizationId: req.orgId };
  if (req.query.status === 'active') filter.active = true;
  if (req.query.status === 'inactive') filter.active = false;
  if (req.query.role) filter.role = String(req.query.role);
  const users = await User.find(filter).sort({ name: 1 }).lean();
  res.json({ items: users.map((u) => publicUser(u, req.tenant)) });
});

router.post('/users', requirePermission('users:create', 'users:manage'), validate(userSchema), async (req, res) => {
  const { password, ...data } = req.body;
  data.email = data.email.toLowerCase();
  if (data.extraPermissions?.length && !hasPermission(req.user, 'roles:manage')) throw forbidden('Only role managers can grant extra permissions');
  if (data.extraPermissions?.some((p) => !isValidPermission(p))) throw badRequest('Unknown permission');
  assertAssignable(req, data.role, data.extraPermissions);
  if (await User.exists({ organizationId: req.orgId, email: data.email })) throw conflict('A user with this email already exists in your company');
  await checkLimit(req.orgId, 'users');
  const user = await User.create({
    ...data, organizationId: req.orgId, userCode: await nextUserCode(), passwordHash: await bcrypt.hash(password, 10),
  });
  await audit(req, 'user.create', { module: 'users', resourceType: 'User', resourceId: user._id, details: { role: user.role } });
  res.status(201).json(publicUser(user, req.tenant));
});

router.get('/users/:id', async (req, res) => {
  if (!objectId.safeParse(req.params.id).success) throw badRequest('Invalid id');
  const user = await User.findOne({ _id: req.params.id, organizationId: req.orgId }).lean();
  if (!user) throw notFound('User');
  res.json(publicUser(user, req.tenant));
});

async function lastAdminGuard(req, target, { newRole, active }) {
  const losingAdmin = target.role === 'admin' && ((newRole && newRole !== 'admin') || active === false);
  if (losingAdmin && await User.countDocuments({ organizationId: req.orgId, role: 'admin', active: true }) <= 1) {
    throw badRequest('The company must keep at least one active admin');
  }
}

router.patch('/users/:id', async (req, res) => {
  if (!objectId.safeParse(req.params.id).success) throw badRequest('Invalid id');
  const isSelf = String(req.params.id) === String(req.user._id);
  const canManage = hasPermission(req.user, 'users:update') || hasPermission(req.user, 'users:manage');
  if (!isSelf && !canManage) throw forbidden('Only admins can edit other users');
  const user = await User.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!user) throw notFound('User');
  // Cannot manage someone with more access than yourself (e.g. an HR manager editing the admin)
  if (!isSelf && !canGrant(req.user, permissionsFor(user, req.tenant))) throw forbidden('You cannot edit a user with more access than your own');
  const allowed = isSelf && !canManage
    ? ['name', 'phone', 'language', 'avatarUrl']
    : ['name', 'phone', 'extension', 'role', 'department', 'designation', 'departmentIds', 'language', 'active', 'extraPermissions', 'avatarUrl'];
  if (req.body.role !== undefined && req.body.role !== user.role) {
    if (isSelf && user.role === 'admin') await lastAdminGuard(req, user, { newRole: req.body.role });
    assertAssignable(req, req.body.role, req.body.extraPermissions || user.extraPermissions);
  }
  if (req.body.extraPermissions !== undefined) {
    if (!hasPermission(req.user, 'roles:manage')) throw forbidden('Only role managers can grant extra permissions');
    if (!Array.isArray(req.body.extraPermissions) || req.body.extraPermissions.some((p) => !isValidPermission(p))) throw badRequest('Unknown permission');
    if (!canGrant(req.user, req.body.extraPermissions)) throw forbidden('You cannot grant permissions you do not have');
  }
  if (req.body.active === false && isSelf) throw badRequest('You cannot deactivate yourself');
  if (req.body.active === true && !user.active) await checkLimit(req.orgId, 'users');
  await lastAdminGuard(req, user, { newRole: req.body.role, active: req.body.active });
  for (const k of allowed) if (req.body[k] !== undefined) user[k] = req.body[k];
  if (req.body.password) {
    if (String(req.body.password).length < 8) throw badRequest('Password must be at least 8 characters');
    user.passwordHash = await bcrypt.hash(req.body.password, 10);
    user.tokenVersion += 1;
  }
  if (req.body.active === false || (req.body.role && req.body.role !== user.role)) user.tokenVersion += 1;
  await user.save();
  await audit(req, 'user.update', { module: 'users', resourceType: 'User', resourceId: user._id, details: { fields: Object.keys(req.body).filter((k) => k !== 'password') } });
  res.json(publicUser(user, req.tenant));
});

/** Deactivates (keeps call history, ownership and audit references intact) and signs the user out everywhere. */
router.delete('/users/:id', requirePermission('users:delete', 'users:manage'), async (req, res) => {
  if (!objectId.safeParse(req.params.id).success) throw badRequest('Invalid id');
  if (String(req.params.id) === String(req.user._id)) throw badRequest('You cannot delete yourself');
  const user = await User.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!user) throw notFound('User');
  if (!canGrant(req.user, permissionsFor(user, req.tenant))) throw forbidden('You cannot delete a user with more access than your own');
  await lastAdminGuard(req, user, { active: false });
  user.active = false;
  user.tokenVersion += 1;
  await user.save();
  await audit(req, 'user.delete', { module: 'users', resourceType: 'User', resourceId: user._id });
  res.status(204).end();
});

// ---------------------------------------------------------------- Roles & permissions
router.get('/permissions', (_req, res) => res.json({ groups: PERMISSION_GROUPS }));

router.get('/roles', async (req, res) => {
  const [roles, counts] = await Promise.all([
    Role.find({ organizationId: req.orgId }).sort({ system: -1, name: 1 }),
    User.aggregate([{ $match: { organizationId: req.orgId, active: true } }, { $group: { _id: '$role', n: { $sum: 1 } } }]),
  ]);
  const byRole = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  res.json({ items: roles.map((r) => ({ ...r.toJSON(), userCount: byRole[r.key] || 0 })) });
});

const roleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Key: lowercase letters, digits, underscore').optional(),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(z.string()).max(200),
});

function checkPermissionList(req, permissions) {
  const bad = permissions.filter((p) => !isValidPermission(p));
  if (bad.length) throw badRequest(`Unknown permissions: ${bad.join(', ')}`);
  if (!canGrant(req.user, permissions)) throw forbidden('A role cannot have more access than your own');
}

router.post('/roles', requirePermission('roles:manage'), validate(roleSchema), async (req, res) => {
  const key = req.body.key || req.body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  if (!/^[a-z]/.test(key)) throw badRequest('Role name must start with a letter');
  checkPermissionList(req, req.body.permissions);
  if (await Role.exists({ organizationId: req.orgId, key })) throw conflict('A role with this key already exists');
  const role = await Role.create({ ...req.body, key, organizationId: req.orgId, system: false });
  invalidateTenant(req.orgId);
  await audit(req, 'role.create', { module: 'roles', resourceType: 'Role', resourceId: role._id, details: { key, permissions: role.permissions } });
  res.status(201).json(role);
});

router.patch('/roles/:id', requirePermission('roles:manage'), validate(roleSchema.partial()), async (req, res) => {
  if (!objectId.safeParse(req.params.id).success) throw badRequest('Invalid id');
  const role = await Role.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!role) throw notFound('Role');
  if (role.key === 'admin' && req.body.permissions) throw badRequest('The Company Admin role always has full access');
  if (req.body.permissions) checkPermissionList(req, req.body.permissions);
  if (!canGrant(req.user, role.permissions)) throw forbidden('You cannot edit a role with more access than your own');
  for (const k of ['name', 'description', 'permissions']) if (req.body[k] !== undefined) role[k] = req.body[k];
  await role.save();
  invalidateTenant(req.orgId);
  await audit(req, 'role.update', { module: 'roles', resourceType: 'Role', resourceId: role._id, details: { permissions: role.permissions } });
  res.json(role);
});

router.delete('/roles/:id', requirePermission('roles:manage'), async (req, res) => {
  if (!objectId.safeParse(req.params.id).success) throw badRequest('Invalid id');
  const role = await Role.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!role) throw notFound('Role');
  if (role.system) throw badRequest('Built-in roles cannot be deleted');
  if (await User.exists({ organizationId: req.orgId, role: role.key, active: true })) throw conflict('Reassign the users of this role first');
  await role.deleteOne();
  invalidateTenant(req.orgId);
  await audit(req, 'role.delete', { module: 'roles', resourceType: 'Role', resourceId: role._id, details: { key: role.key } });
  res.status(204).end();
});

export default router;
