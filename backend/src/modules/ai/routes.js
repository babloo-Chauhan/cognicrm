import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { Activity, Lead, VoiceAgent, VoiceAgentSession } from '../../models/index.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/common.js';
import { notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { getLlm } from './llm.js';
import { getTranscriber } from './transcription.js';
import { nextBestAction, salesForecast, scoreDeal, scoreLead } from './insights.js';
import { generateEmail, qualifyLead, summarizeEmail, summarizeMeeting } from './summaries.js';
import { runAssistant } from './assistant.js';
import { VOICE_AGENT_TOOLS, TOOLS } from './tools.js';
import { startOutboundVoiceAgentCall, testVoiceAgent } from '../voiceAgents/runtime.js';

const router = Router();
const aiLimiter = rateLimit({ windowMs: 60000, limit: env.isTest ? 1000 : 30, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => String(req.user?._id) });

router.get('/ai/status', async (req, res) => {
  const [llm, transcriber] = await Promise.all([getLlm(req.orgId), getTranscriber(req.orgId)]);
  res.json({
    llm: llm ? { provider: llm.name, model: llm.model } : null,
    transcription: transcriber ? { provider: transcriber.name } : null,
    features: {
      leadScoring: 'rules', dealScoring: 'rules', nextBestAction: 'rules', forecast: 'rules',
      assistant: llm ? 'ai' : 'rules', callSummary: llm ? 'ai' : 'unavailable', emailGeneration: llm ? 'ai' : 'unavailable',
      voiceAgent: llm ? 'ai' : 'unavailable',
    },
  });
});

router.post('/ai/assistant', requirePermission('ai:use'), aiLimiter, validate(z.object({
  message: z.string().min(1).max(4000),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).max(20).optional(),
  context: z.object({ entityType: z.string().optional(), entityId: z.string().optional() }).optional(),
})), async (req, res) => {
  res.json(await runAssistant(req.orgId, req.user, req.body));
});

router.get('/ai/next-best-action/:kind/:id', async (req, res) => {
  res.json(await nextBestAction(req.orgId, req.params.kind === 'deal' ? 'deal' : 'lead', req.params.id));
});

router.post('/ai/score/leads', requirePermission('crm:write'), async (req, res) => {
  const leads = await Lead.find({ organizationId: req.orgId, status: { $ne: 'converted' } }).select('_id').lean();
  for (const l of leads) await scoreLead(req.orgId, l._id);
  res.json({ scored: leads.length });
});
router.post('/ai/score/lead/:id', async (req, res) => res.json(await scoreLead(req.orgId, req.params.id)));
router.post('/ai/score/deal/:id', async (req, res) => res.json(await scoreDeal(req.orgId, req.params.id)));
router.get('/ai/forecast', async (req, res) => res.json({ months: await salesForecast(req.orgId) }));

router.post('/ai/email/generate', requirePermission('ai:use'), aiLimiter, validate(z.object({
  purpose: z.string().min(3), tone: z.string().optional(), recipient: z.record(z.string(), z.any()).optional(),
  context: z.record(z.string(), z.any()).optional(), language: z.string().optional(),
})), async (req, res) => res.json(await generateEmail(req.orgId, req.body)));

router.post('/ai/email/summarize', requirePermission('ai:use'), aiLimiter, validate(z.object({ subject: z.string().optional(), body: z.string().min(1) })),
  async (req, res) => res.json(await summarizeEmail(req.orgId, req.body)));

router.post('/ai/meeting/summarize', requirePermission('ai:use'), aiLimiter, validate(z.object({ notes: z.string().min(1).max(100000) })),
  async (req, res) => res.json(await summarizeMeeting(req.orgId, req.body)));

router.post('/ai/qualify/lead/:id', requirePermission('ai:use'), aiLimiter, async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, organizationId: req.orgId }).lean();
  if (!lead) throw notFound('Lead');
  const history = await Activity.find({ organizationId: req.orgId, 'links.leadId': lead._id }).sort({ occurredAt: -1 }).limit(30).lean();
  res.json(await qualifyLead(req.orgId, {
    lead: { name: lead.name, company: lead.company, source: lead.source, industry: lead.industry, companySize: lead.companySize, estimatedValue: lead.estimatedValue },
    history: history.map((h) => ({ type: h.type, title: h.title, at: h.occurredAt, data: h.data })),
  }));
});

// ---------------------------------------------------------------- voice agents
const voiceAgentSchema = z.object({
  name: z.string().min(1),
  profile: z.object({ role: z.string().optional(), companyName: z.string().optional(), greeting: z.string().optional() }).optional(),
  useCases: z.array(z.string()).optional(),
  prompt: z.string().max(20000).optional(),
  knowledgeBase: z.array(z.object({ title: z.string(), content: z.string().max(20000) })).max(50).optional(),
  tools: z.array(z.enum(VOICE_AGENT_TOOLS)).optional(),
  businessRules: z.array(z.string()).optional(),
  escalation: z.object({
    onCustomerRequest: z.boolean().optional(), keywords: z.array(z.string()).optional(), maxTurns: z.number().int().min(1).max(100).optional(),
    queueId: z.string().nullable().optional(),
  }).optional(),
  voice: z.object({ provider: z.string().optional(), voiceId: z.string().optional(), language: z.string().optional() }).optional(),
  languages: z.array(z.string()).optional(),
  callLimits: z.object({ maxDurationSeconds: z.number().int().min(30).optional(), maxConcurrent: z.number().int().min(1).optional(), dailyLimit: z.number().int().min(1).optional() }).optional(),
  phoneNumberIds: z.array(z.string()).optional(),
  status: z.enum(['draft', 'active', 'paused']).optional(),
});

router.get('/voice-agents/tools', (req, res) => {
  res.json({ items: VOICE_AGENT_TOOLS.map((name) => ({ name, description: TOOLS[name].description })) });
});
router.get('/voice-agents', async (req, res) => res.json({ items: await VoiceAgent.find({ organizationId: req.orgId }).sort({ createdAt: -1 }) }));
router.post('/voice-agents', requirePermission('voice_agents:manage'), validate(voiceAgentSchema), async (req, res) => {
  const agent = await VoiceAgent.create({ ...req.body, organizationId: req.orgId });
  await audit(req, 'voice_agent.create', { resourceType: 'VoiceAgent', resourceId: agent._id });
  res.status(201).json(agent);
});
router.get('/voice-agents/:id', async (req, res) => {
  const agent = await VoiceAgent.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!agent) throw notFound('Voice agent');
  res.json(agent);
});
router.put('/voice-agents/:id', requirePermission('voice_agents:manage'), validate(voiceAgentSchema), async (req, res) => {
  const agent = await VoiceAgent.findOneAndUpdate({ _id: req.params.id, organizationId: req.orgId }, req.body, { returnDocument: 'after' });
  if (!agent) throw notFound('Voice agent');
  await audit(req, 'voice_agent.update', { resourceType: 'VoiceAgent', resourceId: agent._id, details: { status: agent.status, tools: agent.tools } });
  res.json(agent);
});
router.get('/voice-agents/:id/sessions', async (req, res) => {
  res.json({ items: await VoiceAgentSession.find({ organizationId: req.orgId, voiceAgentId: req.params.id }).sort({ createdAt: -1 }).limit(100) });
});
router.post('/voice-agents/:id/test', requirePermission('voice_agents:manage'), aiLimiter, validate(z.object({ message: z.string().max(2000).optional(), sessionId: z.string().optional() })),
  async (req, res) => res.json(await testVoiceAgent(req.orgId, req.params.id, req.body)));
router.post('/voice-agents/:id/call', requirePermission('voice_agents:manage'), validate(z.object({ to: z.string(), related: z.record(z.string(), z.string()).optional() })), async (req, res) => {
  const call = await startOutboundVoiceAgentCall(req.orgId, req.params.id, req.body);
  await audit(req, 'voice_agent.call', { resourceType: 'Call', resourceId: call._id });
  res.status(201).json(call);
});

export default router;
