import { CompanySubscription, getPlatformSettings } from '../../models/index.js';
import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import { invalidateTenant } from './tenant.js';
import { flushUsage } from './usage.js';

const DAY = 86400000;

/**
 * Moves lapsed subscriptions to their stored end state (access is already restricted at read time).
 * Trials and cancelled/non-renewing plans → expired; renewing plans → past_due, then expired after the grace period.
 */
export async function expireSubscriptions(now = new Date()) {
  const settings = await getPlatformSettings();
  const graceCutoff = new Date(now.getTime() - (settings.gracePeriodDays ?? 3) * DAY);
  const transitions = [
    [{ status: 'trial', trialEnd: { $lt: now } }, 'expired'],
    [{ status: 'cancelled', endDate: { $lt: now } }, 'expired'],
    [{ status: 'active', autoRenew: false, endDate: { $lt: now } }, 'expired'],
    [{ status: 'active', autoRenew: true, endDate: { $lt: now } }, 'past_due'],
    [{ status: 'past_due', endDate: { $lt: graceCutoff } }, 'expired'],
  ];
  let changed = 0;
  for (const [filter, status] of transitions) {
    const subs = await CompanySubscription.find(filter).select('organizationId status planCode').lean();
    for (const sub of subs) {
      const res = await CompanySubscription.updateOne({ _id: sub._id, status: sub.status }, { $set: { status } });
      if (!res.modifiedCount) continue;
      changed += 1;
      invalidateTenant(sub.organizationId);
      await audit(null, `subscription.${status}`, { orgId: sub.organizationId, module: 'subscriptions', details: { from: sub.status, plan: sub.planCode } });
    }
  }
  if (changed) log.info('subscriptions.expired', { changed });
  return changed;
}

export { flushUsage };
