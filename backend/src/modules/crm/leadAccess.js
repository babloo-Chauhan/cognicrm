import { hasPermission } from '../../middleware/auth.js';
import { Lead } from '../../models/index.js';

/**
 * Leads a person may see: the ones they hold now or held before (`assignees`). The company admin
 * (team_leads:view_all) sees every lead. Old leads without `assignees` are matched by owner.
 * Returns an extra filter, or null for "all leads".
 */
export function leadScopeFor(user) {
  if (!user || hasPermission(user, 'team_leads:view_all')) return null;
  return { $or: [{ ownerId: user._id }, { assignees: user._id }] };
}

export const leadScope = (req) => leadScopeFor(req.user);

/** The lead, if this request's user may see it. */
export const visibleLead = (req, id) => Lead.findOne({ _id: id, organizationId: req.orgId, ...(leadScope(req) || {}) });
