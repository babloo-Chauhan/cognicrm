import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { httpRequest } from '../../lib/http.js';
import { safeEqual } from '../../lib/crypto.js';
import { NotConfiguredError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { loadIntegration } from '../telephony/registry.js';
import { twilioSignature } from '../telephony/providers/twilio.js';
import { messagingWebhookUrl } from '../telephony/urls.js';

/**
 * Messaging provider interface (SMS / WhatsApp / email):
 *   channels: string[]
 *   send({ channel, to, from, body, subject, mediaUrls, template }) → { providerMessageId, status }
 *   validateWebhook({ url, params, headers, rawBody }) → boolean
 *   parseWebhook({ params, body }) → [{ kind: 'inbound'|'status', ... }]
 */
export class MessagingProvider {
  constructor(name) { this.name = name; }
}

const TWILIO_STATUS = { queued: 'queued', accepted: 'queued', sending: 'queued', sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed', undelivered: 'failed', received: 'received' };

export class TwilioMessaging extends MessagingProvider {
  constructor({ credentials }) {
    super('twilio');
    if (!credentials?.accountSid || !credentials?.authToken) throw new NotConfiguredError('Twilio messaging');
    this.credentials = credentials;
    this.channels = ['sms', 'whatsapp'];
  }

  async send({ channel, to, from, body, mediaUrls }) {
    const prefix = channel === 'whatsapp' ? 'whatsapp:' : '';
    const res = await httpRequest(`https://api.twilio.com/2010-04-01/Accounts/${this.credentials.accountSid}/Messages.json`, {
      method: 'POST',
      auth: { username: this.credentials.accountSid, password: this.credentials.authToken },
      form: {
        To: `${prefix}${to}`,
        From: `${prefix}${from}`,
        Body: body,
        MediaUrl: mediaUrls,
        StatusCallback: messagingWebhookUrl('twilio'),
      },
    });
    return { providerMessageId: res.sid, status: TWILIO_STATUS[res.status] || 'queued' };
  }

  validateWebhook({ url, params, headers }) {
    const sig = headers['x-twilio-signature'];
    return Boolean(sig) && safeEqual(twilioSignature(this.credentials.authToken, url, params), sig);
  }

  parseWebhook({ params }) {
    const channel = String(params.From || '').startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    const strip = (v) => String(v || '').replace(/^whatsapp:/, '');
    if (params.MessageStatus && params.MessageStatus !== 'received') {
      return [{ kind: 'status', providerMessageId: params.MessageSid, status: TWILIO_STATUS[params.MessageStatus] || 'queued', error: params.ErrorMessage }];
    }
    const attachments = [];
    for (let i = 0; i < Number(params.NumMedia || 0); i += 1) {
      attachments.push({ url: params[`MediaUrl${i}`], contentType: params[`MediaContentType${i}`] });
    }
    return [{ kind: 'inbound', channel, from: strip(params.From), to: strip(params.To), body: params.Body, providerMessageId: params.MessageSid, attachments }];
  }
}

const META_STATUS = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };

/** WhatsApp Business Cloud API (Meta). */
export class MetaWhatsApp extends MessagingProvider {
  constructor({ credentials }) {
    super('meta');
    if (!credentials?.accessToken || !credentials?.phoneNumberId) throw new NotConfiguredError('WhatsApp Cloud API');
    this.credentials = credentials;
    this.channels = ['whatsapp'];
  }

  async send({ to, body, template, mediaUrls }) {
    const payload = { messaging_product: 'whatsapp', to: to.replace(/^\+/, '') };
    if (template) {
      payload.type = 'template';
      payload.template = {
        name: template.name,
        language: { code: template.language || 'en' },
        components: template.parameters?.length
          ? [{ type: 'body', parameters: template.parameters.map((text) => ({ type: 'text', text: String(text) })) }]
          : undefined,
      };
    } else if (mediaUrls?.length) {
      payload.type = 'document';
      payload.document = { link: mediaUrls[0], caption: body };
    } else {
      payload.type = 'text';
      payload.text = { body };
    }
    const res = await httpRequest(`https://graph.facebook.com/v21.0/${this.credentials.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.credentials.accessToken}` },
      json: payload,
    });
    return { providerMessageId: res?.messages?.[0]?.id, status: 'sent' };
  }

  validateWebhook({ headers, rawBody }) {
    const sig = headers['x-hub-signature-256'];
    if (!sig || !this.credentials.appSecret || !rawBody) return false;
    const expected = `sha256=${crypto.createHmac('sha256', this.credentials.appSecret).update(rawBody).digest('hex')}`;
    return safeEqual(expected, sig);
  }

  parseWebhook({ body }) {
    const out = [];
    for (const entry of body?.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        for (const m of v.messages || []) {
          const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.image?.caption || m.document?.caption || '';
          const media = m.image || m.document || m.audio || m.video;
          out.push({
            kind: 'inbound', channel: 'whatsapp', from: `+${m.from}`, to: v.metadata?.display_phone_number,
            phoneNumberId: v.metadata?.phone_number_id, body: text, providerMessageId: m.id,
            name: v.contacts?.[0]?.profile?.name,
            attachments: media ? [{ url: media.id, contentType: media.mime_type, name: media.filename }] : [],
          });
        }
        for (const s of v.statuses || []) {
          out.push({ kind: 'status', providerMessageId: s.id, status: META_STATUS[s.status] || 'sent', error: s.errors?.[0]?.title, phoneNumberId: v.metadata?.phone_number_id });
        }
      }
    }
    return out;
  }
}

export class SmtpEmail extends MessagingProvider {
  constructor({ credentials }) {
    super('smtp');
    if (!credentials?.host || !credentials?.from) throw new NotConfiguredError('SMTP email');
    this.credentials = credentials;
    this.channels = ['email'];
    this.transport = nodemailer.createTransport({
      host: credentials.host, port: credentials.port || 587, secure: Number(credentials.port) === 465,
      auth: credentials.user ? { user: credentials.user, pass: credentials.pass } : undefined,
    });
  }

  async send({ to, subject, body }) {
    const info = await this.transport.sendMail({ from: this.credentials.from, to, subject, text: body });
    return { providerMessageId: info.messageId, status: 'sent' };
  }
}

const FACTORIES = {
  sms: { twilio: (o) => new TwilioMessaging(o) },
  whatsapp: { twilio: (o) => new TwilioMessaging(o), meta: (o) => new MetaWhatsApp(o) },
  email: { smtp: (o) => new SmtpEmail(o) },
};

const ENV = {
  twilio: () => (env.twilio.accountSid ? { accountSid: env.twilio.accountSid, authToken: env.twilio.authToken } : null),
  meta: () => (env.metaWhatsApp.accessToken ? env.metaWhatsApp : null),
  smtp: () => (env.smtp.host ? env.smtp : null),
};

export function registerMessagingProvider(channel, name, factory, envCredentials) {
  FACTORIES[channel] ||= {};
  FACTORIES[channel][name] = factory;
  if (envCredentials) ENV[name] = envCredentials;
}

export async function getMessagingProvider(org, channel) {
  const name = channel === 'sms' ? org.settings?.smsProvider
    : channel === 'whatsapp' ? org.settings?.whatsappProvider
      : org.settings?.emailProvider || 'smtp';
  const factory = name && FACTORIES[channel]?.[name];
  if (!factory) return null;
  const integration = await loadIntegration(org._id, channel, name);
  if (integration) return factory(integration);
  const envCreds = ENV[name]?.();
  return envCreds ? factory({ credentials: envCreds, config: {} }) : null;
}

export function messagingFactory(channel, name) {
  return FACTORIES[channel]?.[name];
}
