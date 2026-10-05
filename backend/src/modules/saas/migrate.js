import {
  CompanySubscription, getPlatformSettings, Organization, User,
} from '../../models/index.js';
import { log } from '../../lib/logger.js';
import { ensureDefaultPlans, findPlan } from './plans.js';
import {
  nextCompanyCode, nextUserCode, randomTenantId, seedCompanyDefaults,
} from './provisioning.js';

/**
 * Idempotent startup migration from the single-tenant-era data to the SaaS model. Only touches documents
 * that are missing the new fields, so it is cheap after the first run.
 *  - companies get a company code, tenant id and status;
 *  - companies that existed before subscriptions are grandfathered on ENTERPRISE (active, no end date)
 *    so nothing they use today is switched off — the platform owner can move them to a plan later;
 *  - built-in roles and the default pipeline are seeded per company;
 *  - users get a user code; the old global unique email index becomes unique per company.
 */
export async function runSaasMigrations() {
  await ensureDefaultPlans();
  await getPlatformSettings();
  let changed = 0;

  const orgs = await Organization.find({ $or: [{ companyCode: { $exists: false } }, { tenantId: { $exists: false } }, { status: { $exists: false } }] }).sort({ createdAt: 1 });
  for (const org of orgs) {
    if (!org.companyCode) org.companyCode = await nextCompanyCode();
    if (!org.tenantId) org.tenantId = randomTenantId();
    if (!org.status) org.status = 'active';
    await org.save();
    changed += 1;
  }

  const enterprise = await findPlan('ENTERPRISE');
  const withSub = new Set((await CompanySubscription.find({}).select('organizationId').lean()).map((s) => String(s.organizationId)));
  const allOrgs = await Organization.find({}).select('_id').lean();
  for (const org of allOrgs) {
    if (withSub.has(String(org._id))) continue;
    await CompanySubscription.create({
      organizationId: org._id, planId: enterprise._id, planCode: enterprise.code, status: 'active', billingCycle: 'none',
      startDate: new Date(), endDate: null, autoRenew: false, paymentProvider: 'legacy',
    });
    await seedCompanyDefaults(org._id);
    changed += 1;
  }

  for (const user of await User.find({ userCode: { $exists: false } }).sort({ createdAt: 1 })) {
    user.userCode = await nextUserCode();
    await user.save();
    changed += 1;
  }

  const indexes = await User.collection.indexes().catch(() => []);
  const legacy = indexes.find((i) => i.name === 'email_1' && i.unique);
  if (legacy) {
    await User.collection.dropIndex('email_1');
    log.info('migration.user_email_index', { from: 'unique global', to: 'unique per company' });
  }
  await User.createIndexes();

  if (changed) log.info('migration.saas', { changed });
  return changed;
}
