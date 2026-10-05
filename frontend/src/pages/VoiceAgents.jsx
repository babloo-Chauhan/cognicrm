import { useState } from 'react';
import { get, post, put } from '../lib/api.js';
import { dateTime, label } from '../lib/format.js';
import { DataTable, ErrorAlert, Field, StatusBadge } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';

const USE_CASES = ['inbound', 'outbound', 'appointment_booking', 'lead_qualification', 'support', 'faq', 'order_status', 'payment_status', 'follow_up', 'reminder'];

function TestConsole({ agent }) {
  const [sessionId, setSessionId] = useState(null);
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState(null);
  const send = async (message) => {
    setError(null);
    try {
      if (message) setTurns((t) => [...t, { role: 'user', text: message }]);
      const res = await post(`/voice-agents/${agent.id}/test`, { sessionId: sessionId || undefined, message: message || undefined });
      setSessionId(res.sessionId);
      const extra = [];
      if (res.toolCalls?.length) extra.push({ role: 'tool', text: res.toolCalls.map((t) => `🔧 ${t.name}(${JSON.stringify(t.input)})`).join('\n') });
      if (res.reply) extra.push({ role: 'assistant', text: res.reply });
      if (res.escalate) extra.push({ role: 'tool', text: `↪ Hand-off to a human: ${res.escalate.reason}` });
      if (res.endCall) extra.push({ role: 'tool', text: '⏹ Call ended' });
      setTurns((t) => [...t, ...extra]);
      setInput('');
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="card">
      <div className="card-header"><h3>Test console (text)</h3><button type="button" className="btn btn-sm" onClick={() => { setSessionId(null); setTurns([]); }}>Reset</button></div>
      <div className="card-body stack">
        <ErrorAlert error={error} />
        {!sessionId && <button type="button" className="btn" onClick={() => send()}>Start conversation</button>}
        <div className="stack" style={{ maxHeight: 320, overflowY: 'auto' }}>
          {turns.map((t, i) => <div key={i} className={`chat-msg ${t.role === 'user' ? 'user' : ''}`} style={t.role === 'tool' ? { fontSize: 12, background: 'transparent', border: '1px dashed var(--border)' } : undefined}>{t.text}</div>)}
        </div>
        {sessionId && (
          <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); if (input) send(input); }}>
            <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Speak as the caller…" />
            <button type="submit" className="btn btn-primary">Send</button>
          </form>
        )}
      </div>
    </div>
  );
}

function Editor({ agent, onSaved }) {
  const [a, setA] = useState(agent);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [callTo, setCallTo] = useState('');
  const tools = useAsync(() => get('/voice-agents/tools'), []);
  const queues = useAsync(() => get('/call-queues'), []);
  const numbers = useAsync(() => get('/phone-numbers'), []);
  const sessions = useAsync(() => (agent.id ? get(`/voice-agents/${agent.id}/sessions`) : Promise.resolve({ items: [] })), [agent.id]);
  const set = (k, v) => setA({ ...a, [k]: v });
  const toggle = (k, v) => set(k, (a[k] || []).includes(v) ? a[k].filter((x) => x !== v) : [...(a[k] || []), v]);

  const save = async () => {
    setError(null);
    setSaved(false);
    const body = {
      name: a.name, profile: a.profile, useCases: a.useCases, prompt: a.prompt, knowledgeBase: a.knowledgeBase, tools: a.tools,
      businessRules: a.businessRules, escalation: { ...a.escalation, queueId: a.escalation?.queueId || null }, voice: a.voice,
      languages: a.languages, callLimits: a.callLimits, phoneNumberIds: a.phoneNumberIds, status: a.status,
    };
    try {
      const res = a.id ? await put(`/voice-agents/${a.id}`, body) : await post('/voice-agents', body);
      setA(res);
      setSaved(true);
      onSaved(res);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="grid grid-detail">
      <div className="stack" style={{ gap: 16 }}>
        <div className="card"><div className="card-body stack">
          <ErrorAlert error={error} />
          {saved && <div className="alert alert-info">Saved.</div>}
          <div className="form-grid">
            <Field label="Agent name"><input className="input" value={a.name || ''} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Status"><select className="input" value={a.status || 'draft'} onChange={(e) => set('status', e.target.value)}>{['draft', 'active', 'paused'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
            <Field label="Role"><input className="input" value={a.profile?.role || ''} onChange={(e) => set('profile', { ...a.profile, role: e.target.value })} /></Field>
            <Field label="Company name"><input className="input" value={a.profile?.companyName || ''} onChange={(e) => set('profile', { ...a.profile, companyName: e.target.value })} /></Field>
            <Field label="Greeting" className="full"><input className="input" value={a.profile?.greeting || ''} onChange={(e) => set('profile', { ...a.profile, greeting: e.target.value })} /></Field>
            <Field label="Instructions (prompt)" className="full"><textarea className="input" rows={5} value={a.prompt || ''} onChange={(e) => set('prompt', e.target.value)} /></Field>
            <Field label="Business rules (one per line)" className="full"><textarea className="input" rows={3} value={(a.businessRules || []).join('\n')} onChange={(e) => set('businessRules', e.target.value.split('\n').filter(Boolean))} /></Field>
            <Field label="Languages"><input className="input" value={(a.languages || []).join(', ')} onChange={(e) => set('languages', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} /></Field>
            <Field label="Voice language"><input className="input" value={a.voice?.language || 'en'} onChange={(e) => set('voice', { ...a.voice, language: e.target.value })} /></Field>
          </div>
          <Field label="Use cases"><div className="row">{USE_CASES.map((u) => <label key={u} className="checkbox badge"><input type="checkbox" checked={(a.useCases || []).includes(u)} onChange={() => toggle('useCases', u)} />{label(u)}</label>)}</div></Field>
          <Field label="Allowed CRM tools (explicit permissions — nothing else is accessible)">
            <div className="stack" style={{ gap: 4 }}>
              {tools.data?.items?.map((t) => <label key={t.name} className="checkbox small"><input type="checkbox" checked={(a.tools || []).includes(t.name) || ['transfer_call', 'end_call'].includes(t.name)} disabled={['transfer_call', 'end_call'].includes(t.name)} onChange={() => toggle('tools', t.name)} /><code>{t.name}</code> <span className="muted">{t.description}</span></label>)}
            </div>
          </Field>
        </div></div>
        <div className="card"><div className="card-header"><h3>Knowledge base</h3><button type="button" className="btn btn-sm" onClick={() => set('knowledgeBase', [...(a.knowledgeBase || []), { title: '', content: '' }])}>+ Article</button></div><div className="card-body stack">
          {(a.knowledgeBase || []).map((k, i) => (
            <div key={i} className="stack">
              <input className="input" placeholder="Title" value={k.title} onChange={(e) => set('knowledgeBase', a.knowledgeBase.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
              <textarea className="input" rows={3} placeholder="Content" value={k.content} onChange={(e) => set('knowledgeBase', a.knowledgeBase.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))} />
            </div>
          ))}
          {!(a.knowledgeBase || []).length && <span className="muted small">Add FAQs, pricing, policies… the agent answers only from this and CRM tools.</span>}
        </div></div>
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <div className="card"><div className="card-header"><h3>Escalation & limits</h3></div><div className="card-body stack">
          <label className="checkbox"><input type="checkbox" checked={a.escalation?.onCustomerRequest !== false} onChange={(e) => set('escalation', { ...a.escalation, onCustomerRequest: e.target.checked })} /> Hand off when the caller asks for a human</label>
          <Field label="Hand-off keywords"><input className="input" value={(a.escalation?.keywords || []).join(', ')} onChange={(e) => set('escalation', { ...a.escalation, keywords: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
          <Field label="Hand-off queue">
            <select className="input" value={a.escalation?.queueId || ''} onChange={(e) => set('escalation', { ...a.escalation, queueId: e.target.value })}>
              <option value="">Voicemail</option>
              {queues.data?.items?.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select>
          </Field>
          <Field label="Max turns"><input className="input" type="number" value={a.escalation?.maxTurns ?? 20} onChange={(e) => set('escalation', { ...a.escalation, maxTurns: Number(e.target.value) })} /></Field>
          <Field label="Max call duration (s)"><input className="input" type="number" value={a.callLimits?.maxDurationSeconds ?? 600} onChange={(e) => set('callLimits', { ...a.callLimits, maxDurationSeconds: Number(e.target.value) })} /></Field>
          <Field label="Max concurrent calls"><input className="input" type="number" value={a.callLimits?.maxConcurrent ?? 5} onChange={(e) => set('callLimits', { ...a.callLimits, maxConcurrent: Number(e.target.value) })} /></Field>
          <Field label="Daily call limit"><input className="input" type="number" value={a.callLimits?.dailyLimit ?? 500} onChange={(e) => set('callLimits', { ...a.callLimits, dailyLimit: Number(e.target.value) })} /></Field>
          <Field label="Answers inbound calls on">
            <div className="stack" style={{ gap: 4 }}>{numbers.data?.items?.map((n) => <label key={n.id} className="checkbox small"><input type="checkbox" checked={(a.phoneNumberIds || []).includes(n.id)} onChange={() => toggle('phoneNumberIds', n.id)} />{n.number}</label>)}</div>
          </Field>
          <button type="button" className="btn btn-primary" onClick={save}>Save agent</button>
        </div></div>
        {a.id && <TestConsole agent={a} />}
        {a.id && a.status === 'active' && (
          <div className="card"><div className="card-header"><h3>Outbound AI call</h3></div><div className="card-body row">
            <input className="input" style={{ flex: 1 }} placeholder="+91…" value={callTo} onChange={(e) => setCallTo(e.target.value)} />
            <button type="button" className="btn" disabled={!callTo} onClick={async () => { try { await post(`/voice-agents/${a.id}/call`, { to: callTo }); setCallTo(''); } catch (e) { setError(e); } }}>Call</button>
          </div></div>
        )}
        {a.id && (
          <div className="card"><div className="card-header"><h3>Recent sessions</h3></div>
            <DataTable rows={sessions.data?.items} empty="No sessions yet." columns={[
              { key: 'createdAt', label: 'When', render: (s) => dateTime(s.createdAt) },
              { key: 'channel', label: 'Channel', render: (s) => label(s.channel) },
              { key: 'status', label: 'Outcome', render: (s) => <StatusBadge status={s.status} /> },
              { key: 'intent', label: 'Intent', render: (s) => s.intent || '—' },
            ]} />
          </div>
        )}
      </div>
    </div>
  );
}

export function VoiceAgents() {
  const { data, reload } = useAsync(() => get('/voice-agents'), []);
  const status = useAsync(() => get('/ai/status'), []);
  const [editing, setEditing] = useState(null);
  return (
    <>
      <div className="page-header">
        <div><h1>AI voice agents</h1><p>Phone agents that talk to callers, use approved CRM tools and hand off to humans with full context.</p></div>
        <div className="row">
          {editing && <button type="button" className="btn" onClick={() => { setEditing(null); reload(); }}>← All agents</button>}
          {!editing && <button type="button" className="btn btn-primary" onClick={() => setEditing({ name: 'New agent', status: 'draft', tools: ['search_customer', 'create_lead', 'create_task'], languages: ['en', 'hi'], profile: { greeting: 'Hello! How can I help you today?' }, escalation: { onCustomerRequest: true, keywords: ['human', 'agent', 'manager'] } })}>+ New agent</button>}
        </div>
      </div>
      {status.data && !status.data.llm && <div className="alert alert-warning" style={{ marginBottom: 16 }}>No AI provider is connected. Voice agents need one (Calling → Settings → AI) and a telephony provider with speech recognition.</div>}
      {editing ? <Editor key={editing.id || 'new'} agent={editing} onSaved={(a) => setEditing(a)} /> : (
        <div className="card">
          <DataTable rows={data?.items} empty="No voice agents yet." onRowClick={setEditing} columns={[
            { key: 'name', label: 'Agent' },
            { key: 'status', label: 'Status', render: (a) => <StatusBadge status={a.status} /> },
            { key: 'useCases', label: 'Use cases', render: (a) => a.useCases.map(label).join(', ') || '—' },
            { key: 'tools', label: 'Tools', render: (a) => a.tools.length },
            { key: 'languages', label: 'Languages', render: (a) => a.languages.join(', ') },
          ]} />
        </div>
      )}
    </>
  );
}
