import { hasPermission } from '../../middleware/auth.js';
import { normalizePhone } from '../../lib/phone.js';
import { getLlm } from './llm.js';
import { ASSISTANT_TOOLS, executeTool, TOOLS, toolDefinitions } from './tools.js';

const MAX_TOOL_ROUNDS = 6;

/** Assistant-only tool: prepares a call that the client (softphone / mobile dialer) places. */
const PREPARE_CALL = {
  name: 'prepare_call',
  description: 'Prepare a phone call to a customer by name or phone number. The user\'s device places the call.',
  input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Customer name or phone' } }, required: ['query'] },
};

async function prepareCall(ctx, { query }) {
  const found = await executeTool({ ...ctx, allowed: ['search_customer'] }, 'search_customer', { query });
  const target = found.contact || found.lead || found.contacts?.[0] || found.leads?.[0];
  const phone = target?.phone || (/^[+\d]/.test(query) ? normalizePhone(query) : null);
  if (!phone) return { ready: false, reason: `No phone number found for "${query}"` };
  const name = target?.name || [target?.firstName, target?.lastName].filter(Boolean).join(' ') || query;
  const action = { type: 'call', phone, name, contactId: found.contact?.id || found.contacts?.[0]?.id, leadId: found.lead?.id || found.leads?.[0]?.id };
  ctx.actions.push(action);
  return { ready: true, ...action };
}

function allowedTools(user) {
  return ASSISTANT_TOOLS.filter((n) => hasPermission(user, TOOLS[n].permission));
}

/**
 * CRM assistant. With an AI provider configured it uses tool calling over explicit CRM tools;
 * without one it falls back to a deterministic command parser (clearly labelled mode: "rules").
 */
export async function runAssistant(orgId, user, { message, history = [], context = {} }) {
  const allowed = allowedTools(user);
  const ctx = { orgId, user, allowed, origin: 'assistant', actions: [] };
  const llm = await getLlm(orgId);
  if (!llm) return runRuleBased(ctx, message, context);

  const system = [
    'You are the COGNIEOS CRM assistant for sales and support teams.',
    `Today is ${new Date().toISOString().slice(0, 10)}. The user is ${user.name} (role: ${user.role}).`,
    'Use the provided tools to read or change CRM data. Never invent records, numbers or ids.',
    'Answer concisely. Users may write in English, Hindi or Hinglish; reply in the same style.',
    context.entityType ? `The user is currently viewing ${context.entityType} ${context.entityId}.` : '',
  ].filter(Boolean).join('\n');

  const messages = [...history.slice(-10), { role: 'user', content: message }];
  const toolResults = [];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const res = await llm.complete({ system, messages, tools: [...toolDefinitions(allowed), PREPARE_CALL], maxTokens: 1024 });
    if (!res.toolCalls.length) {
      return { mode: 'ai', reply: res.text, toolResults, actions: ctx.actions };
    }
    messages.push({ role: 'assistant', content: res.raw.content });
    const results = [];
    for (const call of res.toolCalls) {
      let result;
      try {
        result = call.name === 'prepare_call' ? await prepareCall(ctx, call.input) : await executeTool(ctx, call.name, call.input);
      } catch (err) {
        result = { error: err.message };
      }
      toolResults.push({ name: call.name, input: call.input, result });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result).slice(0, 20000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { mode: 'ai', reply: 'I could not finish that request. Please try rephrasing it.', toolResults, actions: ctx.actions };
}

// ---------------------------------------------------------------- rule-based fallback
function dueFromText(text) {
  const d = new Date();
  d.setHours(10, 0, 0, 0);
  const m = text.match(/in (\d+) days?/);
  if (/tomorrow|kal/.test(text)) d.setDate(d.getDate() + 1);
  else if (m) d.setDate(d.getDate() + Number(m[1]));
  else if (!/today|aaj/.test(text)) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

const HELP = [
  'Show my hot leads', 'Which deals need follow-up?', 'Create a task for Rahul tomorrow to send the proposal',
  'Summarize this customer', "Show today's calls", "Find customers who haven't been contacted in 7 days", 'Call Rahul',
];

async function runRuleBased(ctx, message, context) {
  const text = String(message || '').toLowerCase().trim();
  const run = async (name, input) => {
    const result = await executeTool(ctx, name, input);
    return { name, input, result };
  };
  let tr;
  let reply;

  if (/hot leads?/.test(text)) {
    tr = await run('list_leads', { filter: 'hot', mine: !/all|team/.test(text) });
    reply = tr.result.length ? `You have ${tr.result.length} hot lead(s): ${tr.result.map((l) => `${l.name} (${l.score})`).join(', ')}.` : 'No hot leads right now.';
  } else if (/deals?.*follow[\s-]?up|follow[\s-]?up.*deals?/.test(text)) {
    tr = await run('list_deals', { needsFollowUp: true, mine: !/all|team/.test(text) });
    reply = tr.result.length ? `${tr.result.length} deal(s) need follow-up: ${tr.result.map((d) => `${d.name} (${d.stage})`).join(', ')}.` : 'No deals need follow-up.';
  } else if (/(create|add|make|banao).*task/.test(text)) {
    const forMatch = message.match(/for\s+([A-Z][\w]*|[a-z]+)(?=\s|$)/i);
    const assigneeName = forMatch && !/tomorrow|today/i.test(forMatch[1]) ? forMatch[1] : undefined;
    const titleMatch = message.match(/(?:to|:)\s+(.+)$/i);
    const title = titleMatch ? titleMatch[1] : `Follow up${assigneeName ? ` (${assigneeName})` : ''}`;
    tr = await run('create_task', {
      title, dueAt: dueFromText(text), assigneeName,
      leadId: context.entityType === 'lead' ? context.entityId : undefined,
      contactId: context.entityType === 'contact' ? context.entityId : undefined,
      dealId: context.entityType === 'deal' ? context.entityId : undefined,
    });
    reply = `Task created: "${tr.result.title}" due ${new Date(tr.result.dueAt).toDateString()}.`;
  } else if (/summari[sz]e/.test(text)) {
    if (!context.entityId || !['contact', 'lead'].includes(context.entityType)) {
      reply = 'Open a contact or lead first, then ask me to summarize it.';
    } else {
      tr = await run('get_customer_summary', { [`${context.entityType}Id`]: context.entityId });
      const r = tr.result;
      reply = `${r.name || 'Customer'}${r.company ? ` (${r.company})` : ''}: ${r.recentCalls.length} recent call(s), ${r.openDeals.length} open deal(s), ${r.openTickets.length} open ticket(s).`
        + (r.lastInteraction ? ` Last interaction: ${r.lastInteraction.title}.` : '');
    }
  } else if (/calls?/.test(text) && /today|aaj|yesterday|week/.test(text) && !/^call\s/.test(text)) {
    const period = /yesterday/.test(text) ? 'yesterday' : /week/.test(text) ? 'week' : 'today';
    tr = await run('list_calls', { period, mine: !/all|team/.test(text) });
    reply = `${tr.result.length} call(s) ${period === 'today' ? 'today' : `in the selected period`}.`;
  } else if (/(not|n't|haven't) been contacted|not contacted|uncontacted/.test(text)) {
    const days = Number(text.match(/(\d+)\s*days?/)?.[1] || 7);
    tr = await run('find_uncontacted', { days });
    reply = `${tr.result.leads.length} lead(s) and ${tr.result.contacts.length} contact(s) not contacted in ${days} days.`;
  } else if (/^(call|phone|dial)\s+/.test(text)) {
    const query = message.replace(/^(call|phone|dial)\s+/i, '').replace(/[.?!]$/, '');
    const result = await prepareCall(ctx, { query });
    tr = { name: 'prepare_call', input: { query }, result };
    reply = result.ready ? `Ready to call ${result.name} at ${result.phone}.` : result.reason;
  } else if (/my deals|show.*deals/.test(text)) {
    tr = await run('list_deals', {});
    reply = `You have ${tr.result.length} open deal(s).`;
  } else if (/my leads|show.*leads/.test(text)) {
    tr = await run('list_leads', { filter: 'all' });
    reply = `You have ${tr.result.length} open lead(s).`;
  } else {
    reply = `AI provider is not configured, so I understand these commands:\n- ${HELP.join('\n- ')}`;
  }
  return { mode: 'rules', reply, toolResults: tr ? [tr] : [], actions: ctx.actions };
}
