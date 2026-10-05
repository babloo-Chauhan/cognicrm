import { NotConfiguredError } from '../../lib/errors.js';
import { getLlm } from './llm.js';

const list = { type: 'array', items: { type: 'string' } };

export const CALL_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '2-4 sentence summary of the call' },
    requirements: { ...list, description: 'What the customer needs or asked for' },
    problems: { ...list, description: 'Problems or pain points raised' },
    objections: { ...list, description: 'Objections raised by the customer' },
    commitments: { ...list, description: 'Commitments made by either side' },
    nextSteps: { ...list, description: 'Agreed next steps' },
    actionItems: {
      type: 'array',
      description: 'Concrete follow-up tasks for the agent',
      items: { type: 'object', properties: { title: { type: 'string' }, dueInDays: { type: 'number' } }, required: ['title'] },
    },
    topics: { ...list, description: 'Short topic tags' },
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'mixed'] },
  },
  required: ['summary', 'requirements', 'problems', 'objections', 'commitments', 'nextSteps', 'actionItems', 'topics', 'sentiment'],
};

async function requireLlm(orgId) {
  const llm = await getLlm(orgId);
  if (!llm) throw new NotConfiguredError('An AI provider');
  return llm;
}

export async function summarizeCallTranscript(orgId, { transcript, context = {} }) {
  const llm = await requireLlm(orgId);
  return llm.extract({
    name: 'record_call_summary',
    system: 'You analyse sales and support phone calls for a CRM. Be factual: only include what was actually said. Transcripts may mix English and Hindi (Hinglish); always answer in English.',
    prompt: `Call context: ${JSON.stringify(context)}\n\nTranscript:\n${transcript}`,
    schema: CALL_SUMMARY_SCHEMA,
  });
}

export async function summarizeEmail(orgId, { subject, body }) {
  const llm = await requireLlm(orgId);
  return llm.extract({
    name: 'record_email_summary',
    system: 'Summarise customer emails for a CRM user. Be concise and factual.',
    prompt: `Subject: ${subject || ''}\n\n${body}`,
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' }, intent: { type: 'string' }, actionItems: list,
        sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'mixed'] },
      },
      required: ['summary', 'intent', 'actionItems', 'sentiment'],
    },
  });
}

export async function generateEmail(orgId, { purpose, tone = 'professional', recipient = {}, context = {}, language = 'English' }) {
  const llm = await requireLlm(orgId);
  return llm.extract({
    name: 'record_email',
    system: `You write ${tone} business emails for sales and support teams. Write in ${language}. Do not invent facts, prices or commitments that are not in the context.`,
    prompt: `Purpose: ${purpose}\nRecipient: ${JSON.stringify(recipient)}\nCRM context: ${JSON.stringify(context)}`,
    schema: {
      type: 'object',
      properties: { subject: { type: 'string' }, body: { type: 'string' } },
      required: ['subject', 'body'],
    },
  });
}

export async function summarizeMeeting(orgId, { notes }) {
  const llm = await requireLlm(orgId);
  return llm.extract({
    name: 'record_meeting_summary',
    system: 'Summarise meeting notes or transcripts for a CRM.',
    prompt: notes,
    schema: {
      type: 'object',
      properties: { summary: { type: 'string' }, decisions: list, actionItems: list, nextSteps: list },
      required: ['summary', 'decisions', 'actionItems', 'nextSteps'],
    },
  });
}

/** Qualifies a lead (BANT-style) from its data and conversation history. */
export async function qualifyLead(orgId, { lead, history }) {
  const llm = await requireLlm(orgId);
  return llm.extract({
    name: 'record_qualification',
    system: 'You qualify B2B sales leads using Budget, Authority, Need and Timeline. Only use the evidence provided; say "unknown" when evidence is missing.',
    prompt: `Lead: ${JSON.stringify(lead)}\nHistory: ${JSON.stringify(history)}`,
    schema: {
      type: 'object',
      properties: {
        qualified: { type: 'boolean' },
        budget: { type: 'string' }, authority: { type: 'string' }, need: { type: 'string' }, timeline: { type: 'string' },
        reasoning: { type: 'string' },
      },
      required: ['qualified', 'budget', 'authority', 'need', 'timeline', 'reasoning'],
    },
  });
}
