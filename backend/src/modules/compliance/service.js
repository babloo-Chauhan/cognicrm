import { Contact, DncEntry, Lead } from '../../models/index.js';
import { AppError } from '../../lib/errors.js';
import { phoneVariants } from '../../lib/phone.js';
import { maskPhone } from '../../lib/crypto.js';
import { isWithinWindow } from '../routing/businessHours.js';

export class ComplianceError extends AppError {
  constructor(reason, message) {
    super(403, message, 'COMPLIANCE_BLOCKED', { reason });
  }
}

export async function isOnDnc(orgId, phone) {
  return Boolean(await DncEntry.exists({ organizationId: orgId, phone: { $in: phoneVariants(phone) } }));
}

/**
 * Outbound call compliance gate. Legal rules differ per jurisdiction, so every rule here is
 * driven by organization settings rather than hard-coded assumptions.
 */
export async function assertCanCall(org, { phone, related = {}, now = new Date() }) {
  const compliance = org.settings?.compliance || {};
  if (compliance.respectDnc !== false) {
    if (await isOnDnc(org._id, phone)) throw new ComplianceError('dnc', 'This number is on the Do-Not-Call list');
    const optedOut = await Promise.all([
      related.contactId ? Contact.exists({ _id: related.contactId, organizationId: org._id, doNotCall: true }) : null,
      related.leadId ? Lead.exists({ _id: related.leadId, organizationId: org._id, doNotCall: true }) : null,
    ]);
    if (optedOut.some(Boolean)) throw new ComplianceError('opt_out', 'This customer has opted out of calls');
  }
  const hours = compliance.callingHours;
  if (hours?.enabled) {
    const ok = isWithinWindow({ timezone: hours.timezone || org.settings?.timezone || 'UTC', days: hours.days, start: hours.start, end: hours.end }, now);
    if (!ok) throw new ComplianceError('calling_hours', `Outbound calls are only allowed between ${hours.start} and ${hours.end}`);
  }
}

export async function assertCanMessage(org, { channel, phone, related = {} }) {
  const field = channel === 'whatsapp' ? 'whatsappOptOut' : channel === 'email' ? 'emailOptOut' : 'smsOptOut';
  const optedOut = await Promise.all([
    related.contactId ? Contact.exists({ _id: related.contactId, organizationId: org._id, [field]: true }) : null,
    related.leadId ? Lead.exists({ _id: related.leadId, organizationId: org._id, [field]: true }) : null,
  ]);
  if (optedOut.some(Boolean)) throw new ComplianceError('opt_out', `This customer has opted out of ${channel}`);
  if (channel === 'sms' && phone && (await isOnDnc(org._id, phone)) && org.settings?.compliance?.dncBlocksSms) {
    throw new ComplianceError('dnc', 'This number is on the Do-Not-Call list');
  }
}

/** Opt-out keywords for inbound SMS/WhatsApp. */
export const OPT_OUT_KEYWORDS = ['stop', 'unsubscribe', 'stopall', 'cancel', 'end', 'quit'];

export function serializeCallForUser(call, user, org, canViewFull) {
  const json = call.toJSON ? call.toJSON() : { ...call, id: String(call._id) };
  if (org?.settings?.compliance?.maskNumbers && !canViewFull) {
    json.customerPhone = maskPhone(json.customerPhone);
    if (json.direction === 'inbound') json.from = maskPhone(json.from);
    else json.to = maskPhone(json.to);
  }
  return json;
}
