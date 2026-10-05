import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  AgentStatus, DEFAULT_SETTINGS, Notification, Organization, PushToken, ROLES, User,
} from '../../models/index.js';
import { authenticate, hasPermission, requirePermission, ROLE_PERMISSIONS, signToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/common.js';
import { badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { seedOrganization } from './seed.js';

const router = Router();

const registerSchema = z.object({
  organizationName: z.string().min(2),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

function publicUser(user) {
  const { passwordHash: _hash, tokenVersion: _tv, ...rest } = user.toJSON ? user.toJSON() : user;
  return { ...rest, id: String(user._id || user.id), permissions: ROLE_PERMISSIONS[user.role] };
}

function slugify(name) {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Math.random().toString(36).slice(2, 7)}`;
}

router.post('/auth/register', validate(registerSchema), async (req, res) => {
  const { organizationName, name, email, password } = req.body;
  if (await User.exists({ email: email.toLowerCase() })) throw conflict('Email is already registered');
  const org = await Organization.create({ name: organizationName, slug: slugify(organizationName), settings: DEFAULT_SETTINGS() });
  const user = await User.create({
    organizationId: org._id, name, email, passwordHash: await bcrypt.hash(password, 10), role: 'admin',
  });
  await seedOrganization(org._id);
  await audit(req, 'auth.register', { orgId: org._id, userId: user._id });
  res.status(201).json({ token: signToken(user), user: publicUser(user), organization: org });
});

router.post('/auth/login', validate(z.object({ email: z.string().email(), password: z.string().min(1) })), async (req, res) => {
  const user = await User.findOne({ email: req.body.email.toLowerCase() }).select('+passwordHash');
  if (!user || !user.active || !(await bcrypt.compare(req.body.password, user.passwordHash))) {
    throw unauthorized('Invalid email or password');
  }
  const org = await Organization.findById(user.organizationId);
  await audit(req, 'auth.login', { orgId: user.organizationId, userId: user._id });
  res.json({ token: signToken(user), user: publicUser(user), organization: org });
});

router.get('/auth/me', authenticate, async (req, res) => {
  const org = await Organization.findById(req.orgId);
  res.json({ user: publicUser(req.user), organization: org });
});

// ---------------------------------------------------------------- Users (team management)
const userSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(ROLES).default('agent'),
  phone: z.string().optional(),
  extension: z.string().optional(),
  departmentIds: z.array(z.string()).optional(),
  language: z.string().optional(),
});

router.get('/users', authenticate, async (req, res) => {
  const users = await User.find({ organizationId: req.orgId }).sort({ name: 1 });
  res.json({ items: users.map(publicUser) });
});

router.post('/users', authenticate, requirePermission('users:manage'), validate(userSchema), async (req, res) => {
  const { password, ...data } = req.body;
  if (await User.exists({ email: data.email.toLowerCase() })) throw conflict('Email is already registered');
  const user = await User.create({ ...data, organizationId: req.orgId, passwordHash: await bcrypt.hash(password, 10) });
  await audit(req, 'user.create', { resourceType: 'User', resourceId: user._id, details: { role: user.role } });
  res.status(201).json(publicUser(user));
});

router.patch('/users/:id', authenticate, async (req, res) => {
  const isSelf = String(req.params.id) === String(req.user._id);
  if (!isSelf && !hasPermission(req.user, 'users:manage')) throw badRequest('Only admins can edit other users');
  const user = await User.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!user) throw notFound('User');
  const allowed = isSelf && !hasPermission(req.user, 'users:manage')
    ? ['name', 'phone', 'language']
    : ['name', 'phone', 'extension', 'role', 'departmentIds', 'language', 'active', 'extraPermissions'];
  for (const k of allowed) if (req.body[k] !== undefined) user[k] = req.body[k];
  if (req.body.password) {
    if (String(req.body.password).length < 8) throw badRequest('Password must be at least 8 characters');
    user.passwordHash = await bcrypt.hash(req.body.password, 10);
    user.tokenVersion += 1;
  }
  if (req.body.active === false) user.tokenVersion += 1;
  await user.save();
  await audit(req, 'user.update', { resourceType: 'User', resourceId: user._id, details: { fields: Object.keys(req.body) } });
  res.json(publicUser(user));
});

// ---------------------------------------------------------------- Organization settings
router.get('/organization', authenticate, async (req, res) => {
  res.json(await Organization.findById(req.orgId));
});

const SETTINGS_KEYS = [
  'defaultCountryCode', 'timezone', 'defaultLanguage', 'languages', 'telephonyProvider', 'smsProvider',
  'whatsappProvider', 'wrapUpSeconds', 'recording', 'transcription', 'compliance', 'fraud', 'customAgentStatuses', 'leadScoring', 'billing',
];

router.patch('/organization/settings', authenticate, requirePermission('settings:manage'), async (req, res) => {
  const org = await Organization.findById(req.orgId);
  const settings = { ...DEFAULT_SETTINGS(), ...(org.settings || {}) };
  for (const key of SETTINGS_KEYS) {
    if (req.body[key] === undefined) continue;
    const value = req.body[key];
    settings[key] = value && typeof value === 'object' && !Array.isArray(value) && settings[key] && typeof settings[key] === 'object'
      ? { ...settings[key], ...value }
      : value;
  }
  org.settings = settings;
  org.markModified('settings');
  if (req.body.name) org.name = req.body.name;
  await org.save();
  await audit(req, 'settings.update', { resourceType: 'Organization', resourceId: org._id, details: { keys: Object.keys(req.body) } });
  res.json(org);
});

// ---------------------------------------------------------------- Push tokens & notifications
router.post('/push-tokens', authenticate, validate(z.object({ token: z.string().min(10), platform: z.string().optional(), provider: z.enum(['expo', 'fcm']).optional() })), async (req, res) => {
  await PushToken.updateOne(
    { organizationId: req.orgId, userId: req.user._id, token: req.body.token },
    { $set: { platform: req.body.platform, provider: req.body.provider || 'expo' } },
    { upsert: true },
  );
  res.status(204).end();
});

// How many phones can receive pushes (and dial requests) for the signed-in user.
router.get('/push-tokens', authenticate, async (req, res) => {
  const tokens = await PushToken.find({ organizationId: req.orgId, userId: req.user._id }, 'platform provider').lean();
  res.json({ devices: tokens.length, platforms: [...new Set(tokens.map((t) => t.platform).filter(Boolean))] });
});

router.delete('/push-tokens', authenticate, async (req, res) => {
  await PushToken.deleteMany({ organizationId: req.orgId, userId: req.user._id, token: req.body?.token });
  res.status(204).end();
});

router.get('/notifications', authenticate, async (req, res) => {
  const items = await Notification.find({ organizationId: req.orgId, userId: req.user._id }).sort({ createdAt: -1 }).limit(50);
  res.json({ items, unread: await Notification.countDocuments({ organizationId: req.orgId, userId: req.user._id, read: false }) });
});

router.post('/notifications/read', authenticate, async (req, res) => {
  const filter = { organizationId: req.orgId, userId: req.user._id };
  if (req.body?.ids?.length) filter._id = { $in: req.body.ids };
  await Notification.updateMany(filter, { read: true });
  res.status(204).end();
});

// Agent status document is created lazily for each user
export async function ensureAgentStatus(orgId, userId) {
  return AgentStatus.findOneAndUpdate(
    { userId },
    { $setOnInsert: { organizationId: orgId, userId, status: 'offline', since: new Date() } },
    { upsert: true, returnDocument: 'after' },
  );
}

export default router;
