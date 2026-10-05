import {
  Call, Note, Organization, VoiceAgent, VoiceAgentSession,
} from '../../models/index.js';
import { AppError, badRequest, NotConfiguredError, notFound, tooMany } from '../../lib/errors.js';
import { isValidE164, normalizePhone } from '../../lib/phone.js';
import { speak } from '../telephony/tts.js';
import { telephonyWebhookUrl } from '../telephony/urls.js';
import { requireTelephonyProvider } from '../telephony/registry.js';
import { getCustomerContext } from '../crm/lookup.js';
import { assertCanCall } from '../compliance/service.js';
import { getLlm } from '../ai/llm.js';
import { executeTool, toolDefinitions, VOICE_AGENT_TOOLS } from '../ai/tools.js';
import { broadcastCall, resolveCallerId, syncCallActivity } from '../calls/service.js';
import { enqueueActions } from '../routing/service.js';

/**
 * AI voice agent runtime.
 *
 *   Phone → Telephony provider → (provider speech recognition / media stream) → Voice gateway
 *   → STT → LLM agent with CRM tools → TTS → Customer
 *
 * This implementation is the "turn-based gateway": the provider performs speech-to-text with a
 * speech <Gather>, we run the LLM agent with explicit CRM tools, and the provider speaks the reply
 * with TTS. A streaming gateway (media streams + realtime STT/TTS) can implement the same
 * `handleTurn` contract later without changing CRM logic.
 */
const MAX_TOOL_ROUNDS = 4;

function allowedTools(agent) {
  return (agent.tools || []).filter((t) => VOICE_AGENT_TOOLS.includes(t)).concat(['transfer_call', 'end_call'])
    .filter((v, i, a) => a.indexOf(v) === i);
}

function systemPrompt(agent, customer) {
  return [
    `You are ${agent.name}, a ${agent.profile?.role || 'phone assistant'}${agent.profile?.companyName ? ` for ${agent.profile.companyName}` : ''}.`,
    'You are speaking on a phone call: keep replies short (1-3 sentences), natural and easy to listen to. No markdown, lists or emojis.',
    `Supported languages: ${(agent.languages || ['en']).join(', ')}. Reply in the language the caller uses (Hinglish is fine).`,
    agent.prompt || '',
    agent.businessRules?.length ? `Business rules (always follow):\n- ${agent.businessRules.join('\n- ')}` : '',
    agent.knowledgeBase?.length ? `Knowledge base:\n${agent.knowledgeBase.map((k) => `## ${k.title}\n${k.content}`).join('\n\n')}` : '',
    customer?.name ? `Caller: ${customer.name}${customer.company ? ` from ${customer.company}` : ''}. Open deals: ${customer.openDeals?.length || 0}. Open tickets: ${customer.openTickets?.length || 0}.` : 'The caller is not yet in the CRM.',
    'Only use the provided tools to read or change data. Never invent order status, prices or appointments.',
    'If the caller asks for a human, is upset, or the request is outside your scope, call transfer_call.',
    'When the conversation is finished, say goodbye and call end_call.',
  ].filter(Boolean).join('\n\n');
}

function gatherAction(provider, call, session, prompts, agent) {
  return {
    type: 'gather',
    input: 'speech',
    timeout: 6,
    speechTimeout: 'auto',
    language: prompts[0]?.language,
    actionUrl: telephonyWebhookUrl(provider.name, 'voice-agent', { callId: call._id, sessionId: session._id }),
    prompts,
    agentId: String(agent._id),
  };
}

async function assertAgentLimits(org, agent) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [active, today] = await Promise.all([
    Call.countDocuments({ organizationId: org._id, voiceAgentId: agent._id, status: { $in: ['initiated', 'ringing', 'in_progress'] } }),
    Call.countDocuments({ organizationId: org._id, voiceAgentId: agent._id, startedAt: { $gte: startOfDay } }),
  ]);
  if (agent.callLimits?.maxConcurrent && active >= agent.callLimits.maxConcurrent) throw tooMany('Voice agent is at its concurrent call limit');
  if (agent.callLimits?.dailyLimit && today >= agent.callLimits.dailyLimit) throw tooMany('Voice agent reached its daily call limit');
}

/** Inbound: the number's voice agent answers. Returns the first actions (greeting + listen). */
export async function startVoiceAgentCall({ org, call, agent, provider }) {
  try {
    await assertAgentLimits(org, agent);
  } catch {
    // Over limit: hand the call to humans instead of failing it.
    return agent.escalation?.queueId ? enqueueActions(call, org, provider, agent.escalation.queueId) : [{ type: 'hangup' }];
  }
  const ctx = await getCustomerContext(org._id, { phone: call.from });
  const session = await VoiceAgentSession.create({
    organizationId: org._id, voiceAgentId: agent._id, callId: call._id,
    customer: { phone: call.from, contactId: ctx.contact?._id, leadId: ctx.lead?._id },
    turns: [{ role: 'assistant', text: agent.profile?.greeting, at: new Date() }],
  });
  call.mode = 'ai';
  call.voiceAgentId = agent._id;
  call.status = 'in_progress';
  call.answeredAt = new Date();
  call.metadata = { ...(call.metadata || {}), voiceAgentSessionId: String(session._id) };
  call.markModified('metadata');
  await call.save();
  broadcastCall(call);
  const greeting = await speak(agent.profile?.greeting || 'Hello! How can I help you?', agent.voice?.language || 'en', agent.voice);
  return [gatherAction(provider, call, session, [greeting], agent)];
}

/** Outbound AI call (follow-ups, reminders, qualification). */
export async function startOutboundVoiceAgentCall(orgId, agentId, { to, related = {} }) {
  const org = await Organization.findById(orgId).lean();
  const agent = await VoiceAgent.findOne({ _id: agentId, organizationId: orgId });
  if (!agent) throw notFound('Voice agent');
  if (agent.status !== 'active') throw badRequest('Voice agent is not active');
  if (!(await getLlm(orgId))) throw new NotConfiguredError('An AI provider');
  const phone = normalizePhone(to, org.settings?.defaultCountryCode);
  if (!isValidE164(phone)) throw badRequest('Invalid phone number');
  await assertCanCall(org, { phone, related });
  await assertAgentLimits(org, agent);
  const provider = await requireTelephonyProvider(orgId);
  provider.require('speechGather');
  const callerNumber = await resolveCallerId(org, null);
  if (!callerNumber) throw new AppError(422, 'No active voice phone number is available as caller ID', 'CALLER_ID_REQUIRED');

  const call = new Call({
    organizationId: orgId, direction: 'outbound', mode: 'ai', status: 'initiated', from: callerNumber.number, to: phone,
    customerPhone: phone, provider: provider.name, voiceAgentId: agent._id, related, source: 'voice_agent', phoneNumberId: callerNumber._id,
  });
  call.conferenceName = `call-${call._id}`;
  await call.save();
  const leg = await provider.makeAutomatedCall({
    call, to: phone, callerId: callerNumber.number,
    url: telephonyWebhookUrl(provider.name, 'voice-agent-start', { callId: call._id }),
  });
  call.providerCallId = leg.providerCallId;
  call.providerLegs = [leg];
  await call.save();
  await syncCallActivity(call);
  broadcastCall(call);
  return call;
}

/** Called when the outbound AI call is answered. */
export async function voiceAgentAnswered(call, provider) {
  const org = await Organization.findById(call.organizationId).lean();
  const agent = await VoiceAgent.findById(call.voiceAgentId);
  if (!agent) return [{ type: 'hangup' }];
  const actions = await startVoiceAgentCall({ org, call, agent, provider });
  return actions;
}

/**
 * Runs one conversational turn. Shared by phone calls and the text test console.
 * @returns {{ reply: string, escalate?: object, endCall?: boolean, toolCalls: object[] }}
 */
export async function runAgentTurn({ orgId, agent, session, userText, callId }) {
  const llm = await getLlm(orgId);
  if (!llm) return { reply: null, escalate: { reason: 'AI provider not configured' }, toolCalls: [] };

  session.turns.push({ role: 'user', text: userText, at: new Date() });
  const lower = userText.toLowerCase();
  const wantsHuman = agent.escalation?.onCustomerRequest !== false
    && (agent.escalation?.keywords || []).some((k) => lower.includes(k.toLowerCase()));
  const userTurns = session.turns.filter((t) => t.role === 'user').length;
  if (wantsHuman || (agent.escalation?.maxTurns && userTurns > agent.escalation.maxTurns)) {
    return { reply: null, escalate: { reason: wantsHuman ? 'Customer asked for a human' : 'Conversation too long' }, toolCalls: [] };
  }

  const customer = session.customer?.contactId || session.customer?.leadId || session.customer?.phone
    ? await getCustomerContext(orgId, { phone: session.customer.phone, contactId: session.customer.contactId, leadId: session.customer.leadId })
    : null;
  const allowed = allowedTools(agent);
  const ctx = { orgId, user: null, allowed, origin: 'voice_agent', callId };
  const messages = session.turns
    .filter((t) => t.text)
    .map((t) => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.text }))
    // Anthropic requires the conversation to start with a user message
    .filter((m, i) => !(i === 0 && m.role === 'assistant'));
  const toolCalls = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const res = await llm.complete({ system: systemPrompt(agent, customer), messages, tools: toolDefinitions(allowed), maxTokens: 400 });
    if (!res.toolCalls.length) {
      session.turns.push({ role: 'assistant', text: res.text, at: new Date(), toolCalls });
      return { reply: res.text, toolCalls, endCall: ctx.endCall, escalate: ctx.escalate };
    }
    messages.push({ role: 'assistant', content: res.raw.content });
    const results = [];
    for (const tc of res.toolCalls) {
      let result;
      try {
        result = await executeTool(ctx, tc.name, tc.input);
        if (tc.name === 'create_lead' && result?.id) session.customer = { ...(session.customer || {}), leadId: result.id };
      } catch (err) {
        result = { error: err.message };
      }
      toolCalls.push({ name: tc.name, input: tc.input, result });
      session.collected = { ...(session.collected || {}), [tc.name]: tc.input };
      results.push({ type: 'tool_result', tool_use_id: tc.id, content: JSON.stringify(result).slice(0, 8000) });
    }
    messages.push({ role: 'user', content: results });
    if (ctx.escalate) {
      session.turns.push({ role: 'assistant', text: res.text || '', at: new Date(), toolCalls });
      return { reply: res.text || null, escalate: ctx.escalate, toolCalls };
    }
  }
  return { reply: 'Let me connect you with a colleague who can help.', escalate: { reason: 'Agent could not complete the request' }, toolCalls };
}

/** Phone turn handler (speech result from the provider). */
export async function handleVoiceAgentTurn(call, provider, { sessionId, speech }) {
  const session = await VoiceAgentSession.findOne({ _id: sessionId, organizationId: call.organizationId, callId: call._id });
  const agent = session && await VoiceAgent.findById(session.voiceAgentId);
  if (!session || !agent || session.status !== 'active') return [{ type: 'hangup' }];
  const lang = agent.voice?.language || 'en';

  if (agent.callLimits?.maxDurationSeconds && call.answeredAt && (Date.now() - call.answeredAt) / 1000 > agent.callLimits.maxDurationSeconds) {
    return escalateToHuman(call, provider, session, agent, { reason: 'Maximum AI call duration reached' });
  }
  if (!speech) {
    const silentTurns = (session.collected?.silences || 0) + 1;
    session.collected = { ...(session.collected || {}), silences: silentTurns };
    session.markModified('collected');
    await session.save();
    if (silentTurns >= 3) return [await speak('I could not hear you. Goodbye.', lang, agent.voice), { type: 'hangup' }];
    return [gatherAction(provider, call, session, [await speak('Sorry, I did not catch that. Could you repeat?', lang, agent.voice)], agent)];
  }

  const result = await runAgentTurn({ orgId: call.organizationId, agent, session, userText: speech, callId: call._id });
  session.markModified('turns');
  session.markModified('collected');
  await session.save();

  if (result.escalate) return escalateToHuman(call, provider, session, agent, result.escalate, result.reply);
  const replyAction = await speak(result.reply || '...', lang, agent.voice);
  if (result.endCall) {
    session.status = 'completed';
    await session.save();
    return [replyAction, { type: 'hangup' }];
  }
  return [gatherAction(provider, call, session, [replyAction], agent)];
}

/**
 * Warm hand-off to a human: builds context (customer, summary, intent, history, collected data),
 * attaches it to the call so the agent popup shows it, then routes the caller to the escalation queue.
 */
export async function escalateToHuman(call, provider, session, agent, { reason }, lastReply) {
  const org = await Organization.findById(call.organizationId).lean();
  const customer = await getCustomerContext(call.organizationId, {
    phone: session.customer?.phone || call.from, contactId: session.customer?.contactId, leadId: session.customer?.leadId,
  });
  const transcript = session.turns.map((t) => `${t.role === 'user' ? 'Caller' : 'AI'}: ${t.text}`).join('\n');
  let summary = transcript.split('\n').slice(-6).join(' | ');
  let intent = null;
  const llm = await getLlm(call.organizationId);
  if (llm && session.turns.length > 1) {
    const extracted = await llm.extract({
      name: 'handoff',
      system: 'Summarise this AI phone conversation for the human agent taking over. Be brief and factual.',
      prompt: transcript,
      schema: { type: 'object', properties: { summary: { type: 'string' }, intent: { type: 'string' } }, required: ['summary', 'intent'] },
    }).catch(() => null);
    if (extracted) ({ summary, intent } = extracted);
  }
  const context = {
    reason,
    customer: { name: customer.name, company: customer.company, phone: customer.phone },
    summary,
    intent,
    previousInteractions: customer.previousCalls.slice(0, 5).map((c) => ({ at: c.startedAt, status: c.status, disposition: c.disposition?.label })),
    collected: session.collected,
  };
  session.status = 'escalated';
  session.summary = summary;
  session.intent = intent;
  session.escalationContext = context;
  session.escalatedToQueueId = agent.escalation?.queueId;
  await session.save();

  call.metadata = { ...(call.metadata || {}), aiEscalation: context };
  call.markModified('metadata');
  call.answeredAt = null;
  call.mode = 'webrtc';
  await call.save();
  await Note.create({
    organizationId: call.organizationId,
    body: `AI agent hand-off (${reason}). ${summary}`,
    related: { ...(call.related?.toObject?.() || call.related || {}), callId: call._id },
  });

  const lang = agent.voice?.language || 'en';
  const actions = [];
  if (lastReply) actions.push(await speak(lastReply, lang, agent.voice));
  actions.push(await speak(lang.startsWith('hi') ? 'Main aapko hamare team member se jod raha hoon.' : 'Let me connect you with a member of our team.', lang, agent.voice));
  if (agent.escalation?.queueId) actions.push(...(await enqueueActions(call, org, provider, agent.escalation.queueId)));
  else {
    const { voicemailActions } = await import('../routing/service.js');
    actions.push(...(await voicemailActions(call, provider, { scope: 'ivr' })));
  }
  return actions;
}

/** Text-mode test console for configuring agents without a phone line. */
export async function testVoiceAgent(orgId, agentId, { message, sessionId }) {
  const agent = await VoiceAgent.findOne({ _id: agentId, organizationId: orgId });
  if (!agent) throw notFound('Voice agent');
  let session = sessionId ? await VoiceAgentSession.findOne({ _id: sessionId, organizationId: orgId, voiceAgentId: agentId }) : null;
  if (!session) {
    session = await VoiceAgentSession.create({
      organizationId: orgId, voiceAgentId: agentId, channel: 'test', turns: [{ role: 'assistant', text: agent.profile?.greeting, at: new Date() }],
    });
    if (!message) return { sessionId: session._id, reply: agent.profile?.greeting };
  }
  const result = await runAgentTurn({ orgId, agent, session, userText: message });
  if (result.escalate) session.status = 'escalated';
  if (result.endCall) session.status = 'completed';
  session.markModified('turns');
  session.markModified('collected');
  await session.save();
  return { sessionId: session._id, reply: result.reply, escalate: result.escalate, endCall: result.endCall, toolCalls: result.toolCalls };
}
