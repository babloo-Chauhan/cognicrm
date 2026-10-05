import { interpolate } from '../../lib/template.js';
import { speak, translate } from '../telephony/tts.js';

const MAX_STEPS = 50;
const TERMINAL_TYPES = ['queue', 'agent', 'department', 'transfer', 'voicemail', 'record', 'callback', 'end'];

/**
 * Executes an IVR flow (stored as JSON: { nodes, edges }) until it needs caller input or
 * reaches a terminal node.
 *
 * @param flow     IVRFlow document (plain object)
 * @param session  { currentNodeId, language, variables, retries, path }
 * @param options  { input, caller, services, urls }
 *   services.businessHoursStatus(id) → 'open'|'closed'|'holiday'
 *   services.lookupCustomer({ phone, customerId }) → { found, customer }
 *   services.lookupOrder(orderNumber) → order | null
 *   services.httpCall({ url, method, body }) → json
 *   urls.gather(nodeId) → action URL that receives caller input
 * @returns {{ actions: object[], outcome: object|null, session: object, awaitingInput: boolean }}
 */
export async function runIvr(flow, session, { input, caller = {}, services = {}, urls = {} } = {}) {
  const s = {
    currentNodeId: session.currentNodeId || null,
    language: session.language || flow.defaultLanguage || 'en',
    variables: { ...(session.variables || {}) },
    retries: session.retries || 0,
    path: [...(session.path || [])],
  };
  const nodes = new Map((flow.nodes || []).map((n) => [n.id, n]));
  const actions = [];
  const ctx = () => ({ vars: s.variables, caller, language: s.language });
  const text = (value) => interpolate(translate(value, s.language, flow.defaultLanguage || 'en', flow.translations || {}), ctx());
  const say = async (value, data = {}) => {
    const t = text(value);
    if (t) actions.push(await speak(t, s.language, data.voice || {}));
  };

  const next = (node, handle) => {
    const out = (flow.edges || []).filter((e) => e.source === node.id);
    const edge = (handle != null && out.find((e) => e.sourceHandle === String(handle)))
      || out.find((e) => !e.sourceHandle || e.sourceHandle === 'default' || e.sourceHandle === 'next');
    return edge ? nodes.get(edge.target) : null;
  };

  let node;
  let pendingInput = input;
  if (s.currentNodeId && nodes.has(s.currentNodeId)) {
    node = nodes.get(s.currentNodeId);
  } else {
    node = (flow.nodes || []).find((n) => n.type === 'start') || (flow.nodes || [])[0];
    pendingInput = undefined;
  }

  for (let step = 0; step < MAX_STEPS && node; step += 1) {
    const d = node.data || {};
    s.currentNodeId = node.id;
    s.path.push({ nodeId: node.id, at: new Date(), input: pendingInput });

    switch (node.type) {
      case 'start':
        node = next(node);
        break;

      case 'set_language':
        s.language = d.language || s.language;
        node = next(node);
        break;

      case 'tts':
        await say(d.text, d);
        node = next(node);
        break;

      case 'play_audio': {
        const url = typeof d.url === 'object' ? translate(d.url, s.language, flow.defaultLanguage) : d.url;
        if (url) actions.push({ type: 'play', url });
        node = next(node);
        break;
      }

      case 'gather':
      case 'dtmf': {
        if (pendingInput === undefined) {
          const prompts = [];
          if (d.audioUrl) prompts.push({ type: 'play', url: d.audioUrl });
          const promptText = text(d.prompt);
          if (promptText) prompts.push(await speak(promptText, s.language, d.voice || {}));
          actions.push({
            type: 'gather',
            input: d.input || 'dtmf',
            numDigits: d.numDigits || (node.type === 'dtmf' ? 1 : undefined),
            finishOnKey: d.finishOnKey || (d.numDigits ? undefined : '#'),
            timeout: d.timeout || 6,
            language: d.input?.includes('speech') ? (await speak('', s.language)).language : undefined,
            actionUrl: urls.gather ? urls.gather(node.id) : undefined,
            prompts,
          });
          return { actions, outcome: null, session: s, awaitingInput: true };
        }
        const value = String(pendingInput ?? '').trim();
        pendingInput = undefined;
        if (d.variable) s.variables[d.variable] = value;
        const outEdges = (flow.edges || []).filter((e) => e.source === node.id);
        const options = outEdges.map((e) => e.sourceHandle).filter((h) => h && !['default', 'next', 'timeout', 'invalid'].includes(h));
        let handle;
        if (!value) handle = 'timeout';
        else if (options.includes(value)) handle = value;
        else if (options.length && !d.collect) handle = 'invalid';
        else handle = 'next';

        const hasHandle = outEdges.some((e) => e.sourceHandle === handle);
        if ((handle === 'invalid' || handle === 'timeout') && !hasHandle) {
          const maxRetries = d.maxRetries ?? 2;
          if (s.retries < maxRetries) {
            s.retries += 1;
            await say(d.invalidMessage || { en: 'Sorry, I did not get that.', hi: 'Maaf kijiye, samajh nahi aaya.' }, d);
            pendingInput = undefined;
            // Re-run the same gather node
            s.path.pop();
            continue;
          }
        }
        s.retries = 0;
        node = next(node, handle);
        break;
      }

      case 'condition': {
        const ok = evaluateCondition(s.variables, caller, d);
        node = next(node, ok ? 'true' : 'false');
        break;
      }

      case 'route': {
        const rule = (d.rules || []).find((r) => evaluateCondition(s.variables, caller, r));
        node = next(node, rule ? rule.handle : 'default');
        break;
      }

      case 'business_hours': {
        const status = services.businessHoursStatus ? await services.businessHoursStatus(d.businessHoursId) : 'open';
        s.variables.businessHours = status;
        const out = (flow.edges || []).filter((e) => e.source === node.id);
        const handle = status === 'holiday' && !out.some((e) => e.sourceHandle === 'holiday') ? 'closed' : status;
        node = next(node, handle);
        break;
      }

      case 'api_request': {
        let ok = false;
        try {
          if (d.operation === 'customer_lookup' && services.lookupCustomer) {
            const lookupValue = d.inputVariable ? s.variables[d.inputVariable] : undefined;
            const result = await services.lookupCustomer({ phone: caller.phone, customerId: lookupValue });
            ok = Boolean(result?.found);
            s.variables[d.resultVariable || 'customer'] = result?.customer || null;
          } else if (d.operation === 'order_status' && services.lookupOrder) {
            const order = await services.lookupOrder(s.variables[d.inputVariable || 'orderNumber']);
            ok = Boolean(order);
            s.variables[d.resultVariable || 'order'] = order;
          } else if (d.url && services.httpCall) {
            const body = d.body ? JSON.parse(interpolate(JSON.stringify(d.body), ctx())) : undefined;
            s.variables[d.resultVariable || 'api'] = await services.httpCall({ url: interpolate(d.url, ctx()), method: d.method || 'GET', body });
            ok = true;
          }
        } catch (err) {
          s.variables.lastError = err.message;
          ok = false;
        }
        node = next(node, ok ? 'success' : 'error');
        break;
      }

      case 'webhook': {
        if (d.url && services.httpCall) {
          try {
            await services.httpCall({ url: interpolate(d.url, ctx()), method: 'POST', body: { caller, variables: s.variables } });
          } catch (err) {
            s.variables.lastError = err.message;
          }
        }
        node = next(node);
        break;
      }

      default: {
        if (!TERMINAL_TYPES.includes(node.type)) {
          node = next(node);
          break;
        }
        if (d.message || d.text) await say(d.message || d.text, d);
        const outcome = terminalOutcome(node);
        return { actions, outcome, session: { ...s, status: 'completed' }, awaitingInput: false };
      }
    }
  }

  // Ran off the end of the flow (or hit the step limit): hang up politely.
  return { actions, outcome: { type: 'hangup' }, session: { ...s, status: 'completed' }, awaitingInput: false };
}

function terminalOutcome(node) {
  const d = node.data || {};
  switch (node.type) {
    case 'queue': return { type: 'queue', queueId: d.queueId };
    case 'agent': return { type: 'agent', userId: d.userId, timeout: d.timeout };
    case 'department': return { type: 'department', departmentId: d.departmentId };
    case 'transfer': return { type: 'transfer', number: d.number };
    case 'voicemail': return { type: 'voicemail', scope: d.scope || 'ivr', targetId: d.targetId, maxLength: d.maxLength };
    case 'record': return { type: 'voicemail', scope: 'ivr', targetId: d.targetId, maxLength: d.maxLength };
    case 'callback': return { type: 'callback', queueId: d.queueId };
    case 'end':
    default:
      return { type: 'hangup' };
  }
}

export function evaluateCondition(vars, caller, { variable, operator = 'equals', value }) {
  const source = variable?.startsWith('caller.') ? caller[variable.slice(7)] : getPath(vars, variable);
  switch (operator) {
    case 'exists': return source !== undefined && source !== null && source !== '';
    case 'not_exists': return source === undefined || source === null || source === '';
    case 'not_equals': return String(source) !== String(value);
    case 'contains': return String(source ?? '').toLowerCase().includes(String(value).toLowerCase());
    case 'starts_with': return String(source ?? '').startsWith(String(value));
    case 'gt': return Number(source) > Number(value);
    case 'lt': return Number(source) < Number(value);
    case 'equals':
    default: return String(source) === String(value);
  }
}

function getPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/** Validates a flow before publishing. Returns a list of human-readable problems. */
export function validateFlow(flow) {
  const problems = [];
  const nodes = flow.nodes || [];
  const ids = new Set(nodes.map((n) => n.id));
  if (!nodes.some((n) => n.type === 'start')) problems.push('Flow needs a Start node');
  if (nodes.filter((n) => n.type === 'start').length > 1) problems.push('Flow can only have one Start node');
  for (const e of flow.edges || []) {
    if (!ids.has(e.source) || !ids.has(e.target)) problems.push(`Edge ${e.id || ''} points to a missing node`);
  }
  for (const n of nodes) {
    const out = (flow.edges || []).filter((e) => e.source === n.id);
    if (!TERMINAL_TYPES.includes(n.type) && !out.length) problems.push(`Node "${n.data?.label || n.id}" (${n.type}) has no outgoing connection`);
    if (n.type === 'queue' && !n.data?.queueId) problems.push(`Queue node "${n.data?.label || n.id}" has no queue selected`);
    if (n.type === 'transfer' && !n.data?.number) problems.push(`Transfer node "${n.data?.label || n.id}" has no number`);
    if (n.type === 'business_hours' && !n.data?.businessHoursId) problems.push(`Business hours node "${n.data?.label || n.id}" has no schedule selected`);
  }
  return problems;
}
