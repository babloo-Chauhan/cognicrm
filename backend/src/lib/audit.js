import { AuditLog } from '../models/index.js';

/** Records a security-relevant action. Never throws: auditing must not break the request. */
export async function audit(req, action, { resourceType, resourceId, details, orgId, userId } = {}) {
  try {
    await AuditLog.create({
      organizationId: orgId || req?.orgId,
      userId: userId || req?.user?._id,
      action,
      resourceType,
      resourceId: resourceId ? String(resourceId) : undefined,
      ip: req?.ip,
      details,
    });
  } catch (err) {
    console.error('audit log failed', err.message);
  }
}
