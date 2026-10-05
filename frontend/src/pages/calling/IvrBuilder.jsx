import { useCallback, useMemo, useRef, useState } from 'react';
import {
  addEdge, Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { get, post, put } from '../../lib/api.js';
import { ErrorAlert, Field } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';
import { NODE_TYPES, outputsFor, TERMINAL } from './ivrNodes.js';

function IvrNode({ data, selected }) {
  const meta = NODE_TYPES[data.kind] || {};
  const outs = outputsFor(data.kind, data);
  return (
    <div className={`ivr-node ${selected ? 'selected' : ''}`} style={{ minWidth: Math.max(150, outs.length * 44) }}>
      {data.kind !== 'start' && <Handle type="target" position={Position.Top} />}
      <div className="node-type">{meta.icon} {meta.title}</div>
      <div className="node-title">{data.label || meta.title}</div>
      {outs.length > 0 && (
        <div className="handles">
          {outs.map((h, i) => (
            <span key={h} style={{ position: 'relative', flex: 1, textAlign: 'center' }}>
              {h === 'next' ? '' : h}
              <Handle type="source" position={Position.Bottom} id={h} style={{ left: `${((i + 1) / (outs.length + 1)) * 100}%` }} />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { ivr: IvrNode };

function toFlow(flow) {
  return {
    nodes: (flow.nodes || []).map((n) => ({ id: n.id, type: 'ivr', position: n.position || { x: 0, y: 0 }, data: { ...n.data, kind: n.type } })),
    edges: (flow.edges || []).map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle || 'next', label: e.sourceHandle && e.sourceHandle !== 'next' ? e.sourceHandle : undefined })),
  };
}

function fromFlow(nodes, edges) {
  return {
    nodes: nodes.map((n) => {
      const { kind, ...data } = n.data;
      return { id: n.id, type: kind, position: n.position, data };
    }),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle && e.sourceHandle !== 'next' ? e.sourceHandle : undefined })),
  };
}

/** Text that can be translated per IVR language. */
function TranslatedText({ value, languages, onChange, rows = 2 }) {
  const obj = typeof value === 'object' && value ? value : { [languages[0]]: value || '' };
  return (
    <div className="stack" style={{ gap: 4 }}>
      {languages.map((lang) => (
        <label key={lang} className="field">
          <span>{lang}</span>
          <textarea className="input" rows={rows} value={obj[lang] || ''} onChange={(e) => onChange({ ...obj, [lang]: e.target.value })} />
        </label>
      ))}
    </div>
  );
}

function Inspector({ node, onChange, onDelete, refs, languages }) {
  if (!node) return <div className="muted small">Select a node to configure it. Drag from a node’s bottom handle to connect it.</div>;
  const d = node.data;
  const set = (k, v) => onChange({ ...d, [k]: v });
  const select = (key, items, placeholder) => (
    <select className="input" value={d[key] || ''} onChange={(e) => set(key, e.target.value)}>
      <option value="">{placeholder}</option>
      {(items || []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
    </select>
  );
  return (
    <div className="stack">
      <div className="row"><strong>{NODE_TYPES[d.kind]?.icon} {NODE_TYPES[d.kind]?.title}</strong>{d.kind !== 'start' && <button type="button" className="btn btn-sm btn-danger right" onClick={onDelete}>Delete</button>}</div>
      <Field label="Label"><input className="input" value={d.label || ''} onChange={(e) => set('label', e.target.value)} /></Field>
      {d.kind === 'tts' && <Field label="Text (use {{vars.name}} for variables)"><TranslatedText value={d.text} languages={languages} onChange={(v) => set('text', v)} /></Field>}
      {d.kind === 'play_audio' && <Field label="Audio URL"><input className="input" value={d.url || ''} onChange={(e) => set('url', e.target.value)} /></Field>}
      {(d.kind === 'gather' || d.kind === 'dtmf') && (
        <>
          <Field label="Prompt"><TranslatedText value={d.prompt} languages={languages} onChange={(v) => set('prompt', v)} /></Field>
          <Field label="Menu options (comma separated digits)"><input className="input" value={d.options || ''} onChange={(e) => set('options', e.target.value)} placeholder="1,2,3,0" /></Field>
          <Field label="Number of digits"><input className="input" type="number" min="1" value={d.numDigits || ''} onChange={(e) => set('numDigits', e.target.value ? Number(e.target.value) : undefined)} /></Field>
          <Field label="Save input as variable"><input className="input" value={d.variable || ''} onChange={(e) => set('variable', e.target.value)} placeholder="customerId" /></Field>
          <label className="checkbox small"><input type="checkbox" checked={Boolean(d.collect)} onChange={(e) => set('collect', e.target.checked)} /> Free input (e.g. customer ID) — continue on “next”</label>
          <Field label="Input type"><select className="input" value={d.input || 'dtmf'} onChange={(e) => set('input', e.target.value)}><option value="dtmf">Keypad (DTMF)</option><option value="speech">Speech</option><option value="dtmf speech">Keypad or speech</option></select></Field>
          <Field label="Retries on invalid input"><input className="input" type="number" min="0" max="5" value={d.maxRetries ?? 2} onChange={(e) => set('maxRetries', Number(e.target.value))} /></Field>
        </>
      )}
      {d.kind === 'set_language' && <Field label="Language"><select className="input" value={d.language || ''} onChange={(e) => set('language', e.target.value)}>{languages.map((l) => <option key={l} value={l}>{l}</option>)}</select></Field>}
      {d.kind === 'business_hours' && <Field label="Schedule">{select('businessHoursId', refs.hours, 'Select schedule…')}</Field>}
      {d.kind === 'condition' && (
        <>
          <Field label="Variable (vars path or caller.phone)"><input className="input" value={d.variable || ''} onChange={(e) => set('variable', e.target.value)} placeholder="customer.found" /></Field>
          <Field label="Operator"><select className="input" value={d.operator || 'equals'} onChange={(e) => set('operator', e.target.value)}>{['equals', 'not_equals', 'contains', 'starts_with', 'gt', 'lt', 'exists', 'not_exists'].map((o) => <option key={o} value={o}>{o}</option>)}</select></Field>
          <Field label="Value"><input className="input" value={d.value || ''} onChange={(e) => set('value', e.target.value)} /></Field>
        </>
      )}
      {d.kind === 'route' && (
        <Field label="Rules (first match wins)">
          <div className="stack">
            {(d.rules || []).map((r, i) => (
              <div key={i} className="stack card" style={{ padding: 8, boxShadow: 'none' }}>
                <input className="input" placeholder="Branch name" value={r.handle || ''} onChange={(e) => set('rules', d.rules.map((x, j) => (j === i ? { ...x, handle: e.target.value } : x)))} />
                <input className="input" placeholder="Variable" value={r.variable || ''} onChange={(e) => set('rules', d.rules.map((x, j) => (j === i ? { ...x, variable: e.target.value } : x)))} />
                <input className="input" placeholder="Equals value" value={r.value || ''} onChange={(e) => set('rules', d.rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => set('rules', [...(d.rules || []), { handle: `rule${(d.rules || []).length + 1}`, operator: 'equals' }])}>+ Rule</button>
          </div>
        </Field>
      )}
      {d.kind === 'api_request' && (
        <>
          <Field label="Operation">
            <select className="input" value={d.operation || ''} onChange={(e) => set('operation', e.target.value)}>
              <option value="customer_lookup">CRM: find customer (by ID or caller phone)</option>
              <option value="order_status">CRM: order status</option>
              <option value="">External HTTPS API</option>
            </select>
          </Field>
          {d.operation ? <Field label="Input variable"><input className="input" value={d.inputVariable || ''} onChange={(e) => set('inputVariable', e.target.value)} placeholder="customerId" /></Field>
            : <Field label="URL (https)"><input className="input" value={d.url || ''} onChange={(e) => set('url', e.target.value)} /></Field>}
          <Field label="Store result as"><input className="input" value={d.resultVariable || ''} onChange={(e) => set('resultVariable', e.target.value)} placeholder="customer" /></Field>
        </>
      )}
      {d.kind === 'webhook' && <Field label="Webhook URL (https)"><input className="input" value={d.url || ''} onChange={(e) => set('url', e.target.value)} /></Field>}
      {d.kind === 'queue' && <Field label="Queue">{select('queueId', refs.queues, 'Select queue…')}</Field>}
      {d.kind === 'agent' && <Field label="Agent">{select('userId', refs.users, 'Select agent…')}</Field>}
      {d.kind === 'department' && <Field label="Department">{select('departmentId', refs.departments, 'Select department…')}</Field>}
      {d.kind === 'callback' && <Field label="Callback queue">{select('queueId', refs.queues, 'Any agent')}</Field>}
      {d.kind === 'transfer' && <Field label="Phone number"><input className="input" value={d.number || ''} onChange={(e) => set('number', e.target.value)} placeholder="+91…" /></Field>}
      {(d.kind === 'voicemail' || d.kind === 'record') && <Field label="Max length (seconds)"><input className="input" type="number" value={d.maxLength || 120} onChange={(e) => set('maxLength', Number(e.target.value))} /></Field>}
      {TERMINAL.includes(d.kind) && <Field label="Message before action (optional)"><TranslatedText value={d.message} languages={languages} onChange={(v) => set('message', v)} /></Field>}
    </div>
  );
}

function Builder({ flow, onSaved }) {
  const initial = useMemo(() => toFlow(flow), [flow]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selectedId, setSelectedId] = useState(null);
  const [meta, setMeta] = useState({ name: flow.name, defaultLanguage: flow.defaultLanguage || 'en', languages: (flow.languages || ['en']).join(', ') });
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [sim, setSim] = useState(null);
  const [simInput, setSimInput] = useState('');
  const wrapper = useRef(null);
  // Unique node ids: a per-session seed plus a counter (never collides with saved nodes)
  const [idSeed] = useState(() => Date.now().toString(36));
  const counter = useRef(0);
  const { screenToFlowPosition } = useReactFlow();
  const refs = {
    queues: useAsync(() => get('/call-queues'), []).data?.items,
    users: useAsync(() => get('/users'), []).data?.items,
    departments: useAsync(() => get('/departments'), []).data?.items,
    hours: useAsync(() => get('/business-hours'), []).data?.items,
  };
  const languages = meta.languages.split(',').map((s) => s.trim()).filter(Boolean);
  const selected = nodes.find((n) => n.id === selectedId);

  const onConnect = useCallback((params) => setEdges((eds) => addEdge({
    ...params, id: `e${Date.now()}`, label: params.sourceHandle && params.sourceHandle !== 'next' ? params.sourceHandle : undefined,
  }, eds.filter((e) => !(e.source === params.source && e.sourceHandle === params.sourceHandle)))), [setEdges]);

  const addNode = (kind, position) => {
    if (kind === 'start' && nodes.some((n) => n.data.kind === 'start')) return;
    counter.current += 1;
    const id = `${kind}_${idSeed}_${counter.current}`;
    setNodes((ns) => [...ns, { id, type: 'ivr', position: position || { x: 120 + ns.length * 20, y: 80 + ns.length * 40 }, data: { kind, label: NODE_TYPES[kind].title } }]);
    setSelectedId(id);
  };

  const onDrop = (e) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData('application/ivr-node');
    if (kind) addNode(kind, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const save = async (status) => {
    setError(null);
    setSaved(null);
    const body = {
      name: meta.name, defaultLanguage: meta.defaultLanguage, languages, status, translations: flow.translations || {},
      ...fromFlow(nodes, edges),
    };
    try {
      const res = flow.id ? await put(`/ivr/${flow.id}`, body) : await post('/ivr', body);
      setSaved(status === 'published' ? 'Published — calls to numbers using this IVR now follow it.' : 'Draft saved.');
      onSaved(res);
    } catch (e) {
      setError(e);
    }
  };

  const simulate = async (input) => {
    if (!flow.id) return setError(new Error('Save the flow before simulating.'));
    const res = await post(`/ivr/${flow.id}/simulate`, { session: sim?.session, input: input === undefined ? undefined : input });
    setSim(res);
    setSimInput('');
    return res;
  };

  return (
    <div className="stack">
      <div className="row">
        <input className="input" style={{ width: 240 }} value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} aria-label="Flow name" />
        <Field label="Languages"><input className="input" style={{ width: 170 }} value={meta.languages} onChange={(e) => setMeta({ ...meta, languages: e.target.value })} placeholder="en, hi, hinglish" /></Field>
        <Field label="Default"><input className="input" style={{ width: 90 }} value={meta.defaultLanguage} onChange={(e) => setMeta({ ...meta, defaultLanguage: e.target.value })} /></Field>
        <span className="row right">
          <button type="button" className="btn" onClick={() => simulate()}>Simulate</button>
          <button type="button" className="btn" onClick={() => save('draft')}>Save draft</button>
          <button type="button" className="btn btn-primary" onClick={() => save('published')}>Publish</button>
        </span>
      </div>
      <ErrorAlert error={error} />
      {saved && <div className="alert alert-info">{saved}</div>}
      {sim && (
        <div className="card"><div className="card-body stack small">
          <strong>Simulator</strong>
          {sim.actions.map((a, i) => <div key={i}>{a.type === 'say' ? `🗣 “${a.text}”` : a.type === 'gather' ? `⌨️ Waiting for input${a.prompts?.length ? `: “${a.prompts.map((p) => p.text).join(' ')}”` : ''}` : `▶ ${a.type}`}</div>)}
          {sim.outcome && <div><strong>Outcome:</strong> {sim.outcome.type} {sim.outcome.queueId ? `(queue ${refs.queues?.find((q) => q.id === sim.outcome.queueId)?.name || sim.outcome.queueId})` : ''}</div>}
          {sim.awaitingInput && (
            <div className="row">
              <input className="input" style={{ width: 140 }} value={simInput} onChange={(e) => setSimInput(e.target.value)} placeholder="Digits" aria-label="Simulated input" />
              <button type="button" className="btn btn-sm" onClick={() => simulate(simInput)}>Send</button>
            </div>
          )}
          <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setSim(null)}>Close simulator</button>
        </div></div>
      )}
      <div className="ivr-builder">
        <div className="ivr-palette">
          <div className="small muted">Drag onto the canvas or click</div>
          {Object.entries(NODE_TYPES).map(([k, v]) => (
            <div key={k} className="palette-item" draggable onDragStart={(e) => e.dataTransfer.setData('application/ivr-node', k)} onClick={() => addNode(k)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && addNode(k)}>
              {v.icon} {v.title}
            </div>
          ))}
        </div>
        <div ref={wrapper} onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            deleteKeyCode={['Delete', 'Backspace']}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        <div className="ivr-inspector">
          <Inspector
            node={selected}
            refs={refs}
            languages={languages.length ? languages : ['en']}
            onChange={(data) => setNodes((ns) => ns.map((n) => (n.id === selectedId ? { ...n, data } : n)))}
            onDelete={() => { setNodes((ns) => ns.filter((n) => n.id !== selectedId)); setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId)); setSelectedId(null); }}
          />
        </div>
      </div>
    </div>
  );
}

export function IvrBuilder({ flow, onSaved }) {
  return (
    <ReactFlowProvider>
      <Builder flow={flow} onSaved={onSaved} />
    </ReactFlowProvider>
  );
}
