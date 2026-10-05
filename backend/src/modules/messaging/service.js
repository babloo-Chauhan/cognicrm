import {
  CommunicationConversation, CommunicationMessage, Contact, DncEntry, Lead, MessageTemplate, Organization, PhoneNumber,
} from '../../models/index.js';
import { badRequest, NotConfiguredError, notFound } from '../../lib/errors.js';
import { isValidE164, normalizePhone, phoneVariants } from '../../lib/phone.js';
import { interpolate } from '../../lib/template.js';
import { emitToOrg, emitToUser } from '../../lib/realtime.js';
import { assertCanMessage, OPT_OUT_KEYWORDS } from '../compliance/service.js';
import { findCustomerByPhone } from '../crm/lookup.js';
import { logActivity } from '../timeline/service.js';
import { notify } from '../notifications/service.js';
import { getMessagingProvider } from './providers.js';

/** One conversation per customer identity (phone, email or web visitor). */
export async function getOrCreateConversation(orgId, { phone, email, visitorId, name, related = {}, channel }) {
  const or = [];
  if (phone) or.push({ 'customer.phone': { $in: phoneVariants(phone) } });
  if (email) or.push({ 'customer.email': String(email).toLowerCase() });
  if (visitorId) or.push({ 'customer.visitorId': visitorId });
  if (related.contactId) or.push({ 'related.contactId': related.contactId });
  if (related.leadId) or.push({ 'related.leadId': related.leadId });
  let conv = or.length ? await CommunicationConversation.findOne({ organizationId: orgId, $or: or }).sort({ lastMessageAt: -1 }) : null;
  if (!conv) {
    const finalRelated = { ...related };
    if (phone && !finalRelated.contactId && !finalRelated.leadId) {
      const match = await findCustomerByPhone(orgId, phone);
      if (match.contact) finalRelated.contactId = match.contact._id;
      else if (match.lead) finalRelated.leadId = match.lead._id;
      if (match.contact?.accountId) finalRelated.accountId = match.contact.accountId;
      if (!name) name = match.contact ? `${match.contact.firstName} ${match.contact.lastName || ''}`.trim() : match.lead?.name;
    }
    conv = await CommunicationConversation.create({
      organizationId: orgId,
      customer: { name, phone, email: email?.toLowerCase(), visitorId },
      related: finalRelated,
      channels: channel ? [channel] : [],
    });
  } else {
    if (phone && !conv.customer.phone) conv.customer.phone = phone;
    if (email && !conv.customer.email) conv.customer.email = email.toLowerCase();
    if (name && !conv.customer.name) conv.customer.name = name;
  }
  if (channel && !conv.channels.includes(channel)) conv.channels.push(channel);
  return conv;
}

async function senderNumber(orgId, channel) {
  const cap = channel === 'whatsapp' ? 'capabilities.whatsapp' : 'capabilities.sms';
  return PhoneNumber.findOne({ organizationId: orgId, status: 'active', [cap]: true }).sort({ isDefaultCallerId: -1 }).lean();
}

function broadcastMessage(conv, message) {
  const payload = { conversation: conv.toJSON(), message: message.toJSON() };
  emitToOrg(String(conv.organizationId), 'inbox:message', payload);
}

/** Sends an outbound SMS / WhatsApp / email / chat message. */
export async function sendMessage(orgId, user, {
  channel, to, body, subject, templateId, variables = {}, related = {}, conversationId, mediaUrls,
}) {
  const org = await Organization.findById(orgId).lean();
  let conv = conversationId ? await CommunicationConversation.findOne({ _id: conversationId, organizationId: orgId }) : null;
  if (conversationId && !conv) throw notFound('Conversation');

  let recipient = to;
  if (!recipient && conv) recipient = channel === 'email' ? conv.customer.email : channel === 'chat' || channel === 'webchat' ? conv.customer.visitorId : conv.customer.phone;
  if (!recipient) throw badRequest('Recipient is required');
  if (['sms', 'whatsapp'].includes(channel)) {
    recipient = normalizePhone(recipient, org.settings?.defaultCountryCode);
    if (!isValidE164(recipient)) throw badRequest('Invalid phone number');
  }

  let template = null;
  let text = body;
  if (templateId) {
    template = await MessageTemplate.findOne({ _id: templateId, organizationId: orgId, active: true }).lean();
    if (!template) throw notFound('Template');
    if (template.channel !== channel) throw badRequest('Template channel mismatch');
    text = interpolate(template.body, variables);
    subject = subject || interpolate(template.subject || '', variables);
  }
  if (!text) throw badRequest('Message body is required');

  conv ||= await getOrCreateConversation(orgId, {
    phone: ['sms', 'whatsapp'].includes(channel) ? recipient : undefined,
    email: channel === 'email' ? recipient : undefined,
    visitorId: ['chat', 'webchat'].includes(channel) ? recipient : undefined,
    related, channel,
  });
  if (!conv.channels.includes(channel)) conv.channels.push(channel);
  const finalRelated = { ...(conv.related?.toObject?.() || conv.related || {}), ...related };
  await assertCanMessage(org, { channel, phone: recipient, related: finalRelated });

  const message = new CommunicationMessage({
    organizationId: orgId, conversationId: conv._id, channel, direction: 'outbound', to: recipient, subject, body: text,
    templateId: template?._id, sentBy: user?._id, status: 'queued', attachments: (mediaUrls || []).map((url) => ({ url })),
  });

  if (['sms', 'whatsapp', 'email'].includes(channel)) {
    const provider = await getMessagingProvider(org, channel);
    if (!provider) throw new NotConfiguredError(`A ${channel} provider`);
    const from = channel === 'email' ? undefined : (await senderNumber(orgId, channel))?.number;
    if (channel !== 'email' && provider.name === 'twilio' && !from) throw badRequest(`No phone number with ${channel} capability`);
    message.from = from;
    message.provider = provider.name;
    try {
      const res = await provider.send({
        channel, to: recipient, from, body: text, subject, mediaUrls,
        template: template?.providerTemplateName ? { name: template.providerTemplateName, language: template.language, parameters: Object.values(variables) } : undefined,
      });
      message.providerMessageId = res.providerMessageId;
      message.status = res.status || 'sent';
    } catch (err) {
      message.status = 'failed';
      message.error = err.message;
    }
  } else {
    // In-app / web chat: delivered via our own realtime channel and the widget's polling endpoint
    message.status = 'sent';
  }
  message.statusHistory.push({ status: message.status, at: new Date() });
  await message.save();

  conv.lastMessageAt = new Date();
  conv.lastChannel = channel;
  conv.lastMessagePreview = text.slice(0, 140);
  conv.related = finalRelated;
  await conv.save();
  broadcastMessage(conv, message);
  await logActivity(orgId, {
    type: channel, title: `${channel.toUpperCase()} sent`, related: finalRelated, refType: 'CommunicationMessage', refId: message._id,
    userId: user?._id, data: { body: text.slice(0, 280), status: message.status, direction: 'outbound' },
  });
  if (message.status === 'failed') throw Object.assign(badRequest(`Message failed: ${message.error}`), { status: 502, code: 'PROVIDER_ERROR' });
  return { conversation: conv, message };
}

/** Stores an inbound message, handles opt-outs and notifies the assigned agent. */
export async function receiveMessage(orgId, { channel, from, to, body, subject, providerMessageId, provider, attachments = [], name, visitorId }) {
  if (providerMessageId) {
    const dup = await CommunicationMessage.findOne({ organizationId: orgId, providerMessageId });
    if (dup) return { duplicate: true, message: dup };
  }
  const org = await Organization.findById(orgId).lean();
  const phone = ['sms', 'whatsapp'].includes(channel) ? normalizePhone(from, org.settings?.defaultCountryCode) : undefined;
  const conv = await getOrCreateConversation(orgId, {
    phone, email: channel === 'email' ? from : undefined, visitorId, name, channel,
  });
  const message = await CommunicationMessage.create({
    organizationId: orgId, conversationId: conv._id, channel, direction: 'inbound', from: phone || from, to, body, subject,
    providerMessageId, provider, attachments, status: 'received', statusHistory: [{ status: 'received', at: new Date() }],
  });
  conv.lastMessageAt = new Date();
  conv.lastChannel = channel;
  conv.lastMessagePreview = String(body || '').slice(0, 140);
  conv.unreadCount += 1;
  if (conv.status === 'closed') conv.status = 'open';
  await conv.save();

  // Opt-out keywords ("STOP") → record consent withdrawal for that channel
  if (phone && OPT_OUT_KEYWORDS.includes(String(body || '').trim().toLowerCase())) {
    const field = channel === 'whatsapp' ? 'whatsappOptOut' : 'smsOptOut';
    const variants = phoneVariants(phone);
    await Contact.updateMany({ organizationId: orgId, phone: { $in: variants } }, { [field]: true });
    await Lead.updateMany({ organizationId: orgId, phone: { $in: variants } }, { [field]: true });
    if (channel === 'sms' && org.settings?.compliance?.smsStopAddsDnc) {
      await DncEntry.updateOne({ organizationId: orgId, phone }, { $setOnInsert: { reason: 'SMS STOP', source: 'opt_out' } }, { upsert: true });
    }
  }

  broadcastMessage(conv, message);
  if (conv.assignedTo) {
    emitToUser(String(conv.assignedTo), 'inbox:assigned_message', { conversationId: String(conv._id) });
    await notify(orgId, conv.assignedTo, { type: 'message', title: `New ${channel} message`, body: String(body || '').slice(0, 100), data: { conversationId: String(conv._id) } });
  }
  await logActivity(orgId, {
    type: channel, title: `${channel.toUpperCase()} received`, related: conv.related || {}, refType: 'CommunicationMessage', refId: message._id,
    data: { body: String(body || '').slice(0, 280), direction: 'inbound' },
  });
  return { conversation: conv, message };
}

export async function updateMessageStatus(orgId, { providerMessageId, status, error }) {
  const filter = { providerMessageId, ...(orgId ? { organizationId: orgId } : {}) };
  const message = await CommunicationMessage.findOne(filter);
  if (!message) return null;
  const order = ['queued', 'sent', 'delivered', 'read'];
  // Status callbacks can arrive out of order; never move backwards (failed always wins).
  if (status === 'failed' || order.indexOf(status) > order.indexOf(message.status)) {
    message.status = status;
    if (error) message.error = error;
    message.statusHistory.push({ status, at: new Date() });
    await message.save();
    emitToOrg(String(message.organizationId), 'inbox:status', { messageId: String(message._id), status });
  }
  return message;
}
