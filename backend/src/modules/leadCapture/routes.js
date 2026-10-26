import express, { Router } from 'express';
import mongoose from 'mongoose';
import {
  LEAD_SOURCE_TYPES, LeadCaptureLog, LeadSource, Organization, User,
} from '../../models/index.js';
import { requirePermission } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { encryptJson, safeEqual } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import {
  captureLead, newToken, SOURCE_DEFAULTS, sourceError, sourceUrls,
} from './service.js';
import {
  parseGoogleAds, parseIndiamart, parseJustdial, parseWebhook,
} from './parsers.js';
import {
  credentialsOf, fetchMetaLead, pullIndiamart, validMetaSignature,
} from './connectors.js';

// ---------------------------------------------------------------- public: where enquiries arrive (mounted at /capture)

export const capturePublicRouter = Router();
capturePublicRouter.use(express.urlencoded({ extended: true, limit: '200kb' }));
// navigator.sendBeacon and some form tools post JSON as text/plain
capturePublicRouter.use(express.text({ type: 'text/plain', limit: '200kb' }));

const sourceByToken = (token, select = '') => (typeof token === 'string' && token.length >= 16
  ? LeadSource.findOne({ token, enabled: true }).select(select) : null);

function bodyOf(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return { ...(req.method === 'GET' ? req.query : {}), ...(body && typeof body === 'object' ? body : {}) };
}

// A plain HTML <form> posting here (no JavaScript) gets a page back instead of JSON
const fromBrowserForm = (req) => req.is('application/x-www-form-urlencoded') && String(req.headers.accept || '').includes('text/html');
const safeRedirect = (url) => (/^https?:\/\//i.test(String(url || '')) ? String(url) : null);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const thankYouPage = (message) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank you</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px;text-align:center;color:#1f2937">
<div><div style="font-size:44px">✓</div><h1 style="font-size:22px;margin:8px 0">Thank you!</h1><p style="color:#6b7280">${escapeHtml(message)}</p></div></body>`;

/** Public form settings for the hosted form page (/f/:token): fields, title, thank-you text. */
capturePublicRouter.get('/form/:token', async (req, res) => {
  const source = await sourceByToken(req.params.token);
  if (!source || source.type !== 'form') throw notFound('Form');
  const org = await Organization.findById(source.organizationId).select('name branding logoUrl').lean();
  res.json({ ...formConfig(source), company: org?.name });
});

/** Meta webhook verification: the verify token is shown on the source. */
capturePublicRouter.get('/meta/:token', async (req, res) => {
  const source = await sourceByToken(req.params.token);
  const token = String(req.query['hub.verify_token'] || '');
  if (!source || source.type !== 'meta' || req.query['hub.mode'] !== 'subscribe' || !token || !safeEqual(token, source.config?.verifyToken || '')) return res.status(403).end();
  await LeadSource.updateOne({ _id: source._id }, { $set: { 'config.verifiedAt': new Date() } });
  return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
});

/** Meta leadgen events: each names a lead id, read from the Graph API with the page token. */
capturePublicRouter.post('/meta/:token', async (req, res) => {
  const source = await sourceByToken(req.params.token, '+credentials');
  if (!source || source.type !== 'meta') return res.status(404).end();
  const { appSecret } = await credentialsOf(source);
  if (!validMetaSignature(appSecret, req.rawBody, req.headers['x-hub-signature-256'])) return res.status(403).json({ error: 'invalid signature' });
  const changes = (req.body?.entry || []).flatMap((e) => e.changes || []).filter((c) => c.field === 'leadgen' && c.value?.leadgen_id);
  for (const { value } of changes) {
    try {
      await fetchMetaLead(source, value.leadgen_id, { form_id: value.form_id, ad_id: value.ad_id, page_id: value.page_id });
    } catch (err) {
      await sourceError(source, `Facebook lead ${value.leadgen_id}: ${err.message}`);
    }
  }
  // Always 200 once the signature is good: Meta disables webhooks that keep failing; problems show on the source
  res.json({ ok: true, received: changes.length });
});

/** Everything else: website forms, Zapier / Sheets / any app, Justdial, IndiaMART push, Google Ads. */
async function receive(req, res) {
  const source = await sourceByToken(req.params.token);
  if (!source || source.type === 'meta' || source.type === 'whatsapp') return res.status(404).json({ error: 'Unknown or switched-off lead source' });
  const body = bodyOf(req);
  const browser = fromBrowserForm(req);
  // Honeypot fields: people never fill them, spam bots do
  if (['_hp', '_gotcha', 'hp', 'honeypot'].some((k) => String(body[k] || '').trim())) {
    return browser ? res.type('html').send(thankYouPage('We will get back to you soon.')) : res.json({ ok: true });
  }
  let input;
  switch (source.type) {
    case 'justdial': input = parseJustdial(body); break;
    case 'indiamart': input = parseIndiamart(body.RESPONSE || body); break;
    case 'google_ads': {
      const key = source.config?.googleKey;
      if (key && !safeEqual(String(body.google_key || ''), key)) return res.status(403).json({ error: 'Wrong key' });
      input = parseGoogleAds(body);
      break;
    }
    default: input = parseWebhook(body);
  }
  const result = await captureLead(source, input, { payload: body });
  if (source.type === 'justdial') return res.type('text/plain').send('RECEIVED'); // what Justdial looks for
  if (browser) {
    const to = safeRedirect(body.redirect || source.config?.redirectUrl);
    return to ? res.redirect(303, to) : res.type('html').send(thankYouPage(source.config?.thankYou || 'We have received your enquiry and will contact you soon.'));
  }
  const status = result.status === 'failed' ? 422 : result.status === 'created' ? 201 : 200;
  return res.status(status).json({ ok: result.status !== 'failed', status: result.status, ...(result.lead ? { leadId: String(result.lead._id) } : {}), ...(result.reason ? { reason: result.reason } : {}) });
}
capturePublicRouter.get('/:token', receive); // Justdial and Google Sheets scripts may use GET
capturePublicRouter.post('/:token', receive);

// ---------------------------------------------------------------- admin: set up lead sources

export const leadSourceRouter = Router();
leadSourceRouter.use('/lead-sources', requirePermission('settings:manage'));

const FORM_FIELDS = ['name', 'phone', 'email', 'company', 'city', 'requirement'];
const DEFAULT_FORM = [
  { key: 'name', label: 'Your name', required: true },
  { key: 'phone', label: 'Mobile number', required: true },
  { key: 'email', label: 'Email', required: false },
  { key: 'requirement', label: 'What are you looking for?', required: false },
];

function formConfig(source) {
  const c = source.config || {};
  return {
    title: c.title || source.name, intro: c.intro || '', thankYou: c.thankYou || 'Thank you! We will contact you soon.',
    fields: Array.isArray(c.fields) && c.fields.length ? c.fields : DEFAULT_FORM, redirectUrl: c.redirectUrl || '',
  };
}

// Credentials each type takes; only whether they are saved is ever sent back
const CREDENTIAL_KEYS = { indiamart: ['crmKey'], meta: ['pageAccessToken', 'appSecret'] };
// Config the admin may set (the rest — pull times, verification — is the server's)
const CONFIG_KEYS = { form: ['title', 'intro', 'thankYou', 'redirectUrl', 'fields'], webhook: ['redirectUrl', 'thankYou'], meta: ['pageId'], google_ads: [] };

async function toView(source) {
  const s = source.toJSON ? source.toJSON() : { ...source, id: String(source._id) };
  delete s.credentials;
  delete s._id;
  const creds = CREDENTIAL_KEYS[source.type] ? await credentialsOf(source) : {};
  return {
    ...s, urls: sourceUrls(source), saved: Object.fromEntries((CREDENTIAL_KEYS[source.type] || []).map((k) => [k, Boolean(creds[k])])),
    ...(source.type === 'form' ? { form: formConfig(source) } : {}),
  };
}

async function readBody(req, source) {
  const b = req.body || {};
  const out = {};
  if (b.name !== undefined) { if (!String(b.name).trim()) throw badRequest('Give the source a name'); out.name = String(b.name).trim().slice(0, 80); }
  if (b.enabled !== undefined) out.enabled = Boolean(b.enabled);
  if (b.leadSource !== undefined) out.leadSource = String(b.leadSource).trim().toLowerCase().replace(/\s+/g, '_').slice(0, 40) || SOURCE_DEFAULTS[source.type].leadSource;
  if (b.onDuplicate !== undefined) { if (!['merge', 'create'].includes(b.onDuplicate)) throw badRequest('onDuplicate must be merge or create'); out.onDuplicate = b.onDuplicate; }
  if (b.assignMode !== undefined) { if (!['none', 'user', 'round_robin'].includes(b.assignMode)) throw badRequest('Choose how leads are assigned'); out.assignMode = b.assignMode; }
  if (b.assignUserIds !== undefined) {
    const ids = [...new Set((Array.isArray(b.assignUserIds) ? b.assignUserIds : []).map(String))];
    if (ids.some((id) => !mongoose.isValidObjectId(id))) throw badRequest('Invalid team member');
    const found = await User.countDocuments({ _id: { $in: ids }, organizationId: req.orgId, active: true });
    if (found !== ids.length) throw badRequest('Choose active members of your team');
    out.assignUserIds = ids;
  }
  const mode = out.assignMode ?? source.assignMode;
  const users = out.assignUserIds ?? source.assignUserIds ?? [];
  if (mode !== 'none' && !users.length) throw badRequest('Choose who gets the leads');
  if (b.config && typeof b.config === 'object') {
    const config = { ...(source.config || {}) };
    for (const k of CONFIG_KEYS[source.type] || []) if (b.config[k] !== undefined) config[k] = b.config[k];
    if (config.redirectUrl && !safeRedirect(config.redirectUrl)) throw badRequest('The thank-you page must be a full https:// address');
    if (source.type === 'form' && b.config.fields !== undefined) {
      const fields = (Array.isArray(b.config.fields) ? b.config.fields : []).filter((f) => FORM_FIELDS.includes(f?.key))
        .map((f) => ({ key: f.key, label: String(f.label || f.key).slice(0, 80), required: Boolean(f.required) }));
      if (!fields.some((f) => f.key === 'phone' || f.key === 'email')) throw badRequest('The form needs a phone or email field');
      config.fields = fields;
    }
    out.config = config;
  }
  if (b.credentials && typeof b.credentials === 'object' && CREDENTIAL_KEYS[source.type]) {
    const current = await credentialsOf(source);
    for (const k of CREDENTIAL_KEYS[source.type]) {
      if (typeof b.credentials[k] === 'string' && b.credentials[k].trim()) current[k] = b.credentials[k].trim();
      else if (b.credentials[k] === null) delete current[k];
    }
    out.credentials = encryptJson(current);
  }
  return out;
}

const findSource = async (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw notFound('Lead source');
  const source = await LeadSource.findOne({ _id: req.params.id, organizationId: req.orgId }).select('+credentials');
  if (!source) throw notFound('Lead source');
  return source;
};

leadSourceRouter.get('/lead-sources', async (req, res) => {
  const sources = await LeadSource.find({ organizationId: req.orgId }).select('+credentials').sort({ createdAt: 1 });
  res.json({ items: await Promise.all(sources.map(toView)), types: LEAD_SOURCE_TYPES.map((t) => ({ type: t, ...SOURCE_DEFAULTS[t] })) });
});

leadSourceRouter.post('/lead-sources', async (req, res) => {
  const { type } = req.body || {};
  if (!LEAD_SOURCE_TYPES.includes(type)) throw badRequest(`type must be one of ${LEAD_SOURCE_TYPES.join(', ')}`);
  if (type === 'whatsapp' && await LeadSource.exists({ organizationId: req.orgId, type })) throw badRequest('WhatsApp lead capture is already set up');
  const source = new LeadSource({
    organizationId: req.orgId, type, token: newToken(), name: SOURCE_DEFAULTS[type].label, leadSource: SOURCE_DEFAULTS[type].leadSource,
    config: { ...(type === 'meta' ? { verifyToken: newToken() } : {}), ...(type === 'google_ads' ? { googleKey: newToken() } : {}) },
  });
  source.set(await readBody(req, source));
  await source.save();
  await audit(req, 'lead_source.create', { resourceType: 'LeadSource', resourceId: String(source._id), details: { type } });
  res.status(201).json(await toView(source));
});

leadSourceRouter.patch('/lead-sources/:id', async (req, res) => {
  const source = await findSource(req);
  source.set(await readBody(req, source));
  if (req.body?.assignUserIds !== undefined) source.nextAssignee = 0;
  await source.save();
  await audit(req, 'lead_source.update', { resourceType: 'LeadSource', resourceId: String(source._id) });
  res.json(await toView(source));
});

leadSourceRouter.delete('/lead-sources/:id', async (req, res) => {
  const source = await findSource(req);
  await source.deleteOne();
  await audit(req, 'lead_source.delete', { resourceType: 'LeadSource', resourceId: String(source._id), details: { type: source.type, name: source.name } });
  res.status(204).end();
});

/** New public address (and Meta verify token / Google key): the old one stops working at once. */
leadSourceRouter.post('/lead-sources/:id/rotate', async (req, res) => {
  const source = await findSource(req);
  source.token = newToken();
  if (source.type === 'meta') source.config = { ...source.config, verifyToken: newToken(), verifiedAt: undefined };
  if (source.type === 'google_ads') source.config = { ...source.config, googleKey: newToken() };
  source.markModified('config');
  await source.save();
  await audit(req, 'lead_source.rotate', { resourceType: 'LeadSource', resourceId: String(source._id) });
  res.json(await toView(source));
});

leadSourceRouter.get('/lead-sources/:id/logs', async (req, res) => {
  const source = await findSource(req);
  const items = await LeadCaptureLog.find({ organizationId: req.orgId, sourceId: source._id }).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit) || 50, 200))
    .select('-payload').lean();
  res.json({ items: items.map(({ _id, ...l }) => ({ id: String(_id), ...l })) });
});

/** Sends a made-up enquiry through the source so the admin sees where it lands and who is told. */
leadSourceRouter.post('/lead-sources/:id/test', async (req, res) => {
  const source = await findSource(req);
  const phone = `+9190000${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
  const r = await captureLead(source, { name: 'Test enquiry (you can delete this)', phone, requirement: 'Testing the lead source', details: { Test: 'Yes' } }, { payload: { test: true } });
  res.status(r.status === 'failed' ? 422 : 200).json({ status: r.status, reason: r.reason, leadId: r.lead ? String(r.lead._id) : undefined });
});

/** IndiaMART: fetch new enquiries now instead of waiting for the next automatic pull. */
leadSourceRouter.post('/lead-sources/:id/pull', async (req, res) => {
  const source = await findSource(req);
  if (source.type !== 'indiamart') throw badRequest('Only IndiaMART sources are pulled');
  try {
    res.json(await pullIndiamart(source));
  } catch (err) {
    await sourceError(source, err.message);
    throw badRequest(err.message);
  }
});
