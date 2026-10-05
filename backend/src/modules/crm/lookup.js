import { Account, Activity, Call, Contact, Deal, Lead, Ticket } from '../../models/index.js';
import { phoneVariants } from '../../lib/phone.js';

/** Finds the CRM records that match a phone number (used by call popups, IVR, AI agents). */
export async function findCustomerByPhone(orgId, phone) {
  if (!phone) return { contact: null, lead: null, account: null };
  const variants = phoneVariants(phone);
  const regexes = variants.filter((v) => v.length >= 10).map((v) => new RegExp(`${v.replace(/[+]/g, '\\+')}$`));
  const phoneFilter = { $or: [{ phone: { $in: variants } }, ...regexes.map((r) => ({ phone: r }))] };
  const [contact, lead] = await Promise.all([
    Contact.findOne({ organizationId: orgId, ...phoneFilter }).lean(),
    Lead.findOne({ organizationId: orgId, status: { $ne: 'converted' }, ...phoneFilter }).sort({ updatedAt: -1 }).lean(),
  ]);
  const account = contact?.accountId ? await Account.findOne({ _id: contact.accountId, organizationId: orgId }).lean() : null;
  return { contact, lead, account };
}

/** Full caller context shown in the inbound call popup and the preview dialer. */
export async function getCustomerContext(orgId, { phone, contactId, leadId } = {}) {
  let contact = null;
  let lead = null;
  let account = null;
  if (contactId) contact = await Contact.findOne({ _id: contactId, organizationId: orgId }).lean();
  if (leadId) lead = await Lead.findOne({ _id: leadId, organizationId: orgId }).lean();
  if (!contact && !lead && phone) ({ contact, lead, account } = await findCustomerByPhone(orgId, phone));
  if (contact?.accountId && !account) account = await Account.findOne({ _id: contact.accountId, organizationId: orgId }).lean();

  const relatedOr = [];
  if (contact) relatedOr.push({ 'related.contactId': contact._id });
  if (lead) relatedOr.push({ 'related.leadId': lead._id });
  const phoneForCalls = phone || contact?.phone || lead?.phone;
  if (phoneForCalls) relatedOr.push({ customerPhone: { $in: phoneVariants(phoneForCalls) } });

  const linkOr = [];
  if (contact) linkOr.push({ 'links.contactId': contact._id });
  if (lead) linkOr.push({ 'links.leadId': lead._id });
  if (account) linkOr.push({ 'links.accountId': account._id });

  const [previousCalls, lastInteraction, openDeals, openTickets] = await Promise.all([
    relatedOr.length ? Call.find({ organizationId: orgId, $or: relatedOr }).sort({ startedAt: -1 }).limit(10).lean() : [],
    linkOr.length ? Activity.findOne({ organizationId: orgId, $or: linkOr }).sort({ occurredAt: -1 }).lean() : null,
    contact || account || lead
      ? Deal.find({
        organizationId: orgId,
        stage: { $nin: ['won', 'lost'] },
        $or: [
          contact && { contactId: contact._id },
          account && { accountId: account._id },
          lead && { leadId: lead._id },
        ].filter(Boolean),
      }).lean()
      : [],
    contact || account
      ? Ticket.find({
        organizationId: orgId,
        status: { $in: ['open', 'pending'] },
        $or: [contact && { contactId: contact._id }, account && { accountId: account._id }].filter(Boolean),
      }).lean()
      : [],
  ]);

  const name = contact ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') : lead?.name || null;
  return {
    phone: phoneForCalls,
    name,
    company: account?.name || contact?.company || lead?.company || null,
    contact, lead, account, previousCalls, lastInteraction, openDeals, openTickets,
  };
}

/** Display name of the lead or contact a record (callback, call…) is linked to. */
export async function relatedName(orgId, related) {
  if (related.leadId) return (await Lead.findOne({ _id: related.leadId, organizationId: orgId }, 'name').lean())?.name;
  if (related.contactId) {
    const c = await Contact.findOne({ _id: related.contactId, organizationId: orgId }, 'firstName lastName').lean();
    return c ? [c.firstName, c.lastName].filter(Boolean).join(' ') : undefined;
  }
  return undefined;
}
