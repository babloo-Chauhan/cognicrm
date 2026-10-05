import { AuditLog } from '../models/index.js';
import { log } from './logger.js';

/**
 * Records a security-relevant action. Never throws: auditing must not break the request.
 * Company actions are scoped by organizationId; platform (super-admin) actions set platformUserId.
 */
export async function audit(req, action, {
  resourceType, resourceId, details, orgId, userId, module,
} = {}) {
  try {
    const platformUserId = req?.platformUser?._id;
    await AuditLog.create({
      organizationId: orgId || req?.orgId,
      userId: userId || req?.user?._id,
      platformUserId,
      actorType: platformUserId ? 'platform' : (userId || req?.user ? 'user' : 'system'),
      action,
      module: module || action.split('.')[0],
      resourceType,
      resourceId: resourceId ? String(resourceId) : undefined,
      ip: req?.ip,
      userAgent: req?.headers?.['user-agent']?.slice(0, 300),
      details,
    });
  } catch (err) {
    log.error('audit.failed', { error: err.message });
  }
}
