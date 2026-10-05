import { Alert, Call, TERMINAL_STATUSES } from '../../models/index.js';
import { tooMany, AppError } from '../../lib/errors.js';
import { matchCallingCode } from '../../lib/phone.js';
import { emitToSupervisors } from '../../lib/realtime.js';

export async function createAlert(orgId, { type, severity = 'warning', message, userId, data, dedupeMinutes = 10 }) {
  if (dedupeMinutes) {
    const recent = await Alert.exists({
      organizationId: orgId, type, userId, createdAt: { $gte: new Date(Date.now() - dedupeMinutes * 60000) },
    });
    if (recent) return null;
  }
  const alert = await Alert.create({ organizationId: orgId, type, severity, message, userId, data });
  emitToSupervisors(String(orgId), 'alert', alert.toJSON());
  return alert;
}

/**
 * Fraud / abuse gate run before every outbound call. Limits are configurable per organization
 * (Organization.settings.fraud).
 */
export async function assertWithinCallLimits(org, { userId, phone, now = new Date() }) {
  const f = org.settings?.fraud || {};
  const orgId = org._id;

  if (f.blockUnexpectedInternational !== false && f.allowedCountryCodes?.length && !matchCallingCode(phone, f.allowedCountryCodes)) {
    await createAlert(orgId, {
      type: 'fraud.international', severity: 'critical', userId,
      message: `Blocked unexpected international call to ${phone}`, data: { phone },
    });
    throw new AppError(403, 'Calls to this country are not allowed for your organization', 'INTERNATIONAL_BLOCKED');
  }

  const active = await Call.countDocuments({ organizationId: orgId, status: { $nin: TERMINAL_STATUSES } });
  if (f.maxConcurrent && active >= f.maxConcurrent) throw tooMany('Maximum concurrent calls reached for your organization');

  if (!userId) return;
  const since = (ms) => new Date(now.getTime() - ms);
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const [perMinute, perHour, perDay] = await Promise.all([
    Call.countDocuments({ organizationId: orgId, agentId: userId, direction: 'outbound', startedAt: { $gte: since(60000) } }),
    Call.countDocuments({ organizationId: orgId, agentId: userId, direction: 'outbound', startedAt: { $gte: since(3600000) } }),
    Call.countDocuments({ organizationId: orgId, agentId: userId, direction: 'outbound', startedAt: { $gte: startOfDay } }),
  ]);
  if (f.callsPerMinute && perMinute >= f.callsPerMinute) throw tooMany('Too many calls per minute');
  if (f.callsPerHour && perHour >= f.callsPerHour) {
    await createAlert(orgId, { type: 'fraud.volume', userId, message: 'Hourly call limit reached', data: { perHour } });
    throw tooMany('Hourly call limit reached');
  }
  if (f.dailyLimit && perDay >= f.dailyLimit) throw tooMany('Daily call limit reached');
  if (f.callsPerHour && perHour >= Math.floor(f.callsPerHour * 0.8)) {
    await createAlert(orgId, { type: 'fraud.volume', severity: 'info', userId, message: 'Unusual calling volume (80% of hourly limit)', data: { perHour } });
  }
}

/** Called after a call finishes: detects repeated failures. */
export async function inspectCompletedCall(org, call) {
  const f = org.settings?.fraud || {};
  if (!call.agentId || !['failed', 'busy', 'no_answer'].includes(call.status)) return;
  const failures = await Call.countDocuments({
    organizationId: org._id, agentId: call.agentId, status: { $in: ['failed'] },
    startedAt: { $gte: new Date(Date.now() - 10 * 60000) },
  });
  if (f.failedCallThreshold && failures >= f.failedCallThreshold) {
    await createAlert(org._id, {
      type: 'fraud.failed_calls', userId: call.agentId,
      message: `${failures} failed calls in the last 10 minutes`, data: { failures },
    });
  }
}
