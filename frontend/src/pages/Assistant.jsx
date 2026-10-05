import { useEffect, useRef, useState } from 'react';
import { get, post } from '../lib/api.js';
import { useCalls } from '../calling/CallContext.jsx';

const EXAMPLES = [
  'Show my hot leads.',
  'Which deals need follow-up?',
  'Create a task for Rahul tomorrow to send the proposal',
  "Show today's calls.",
  "Find customers who haven't been contacted in 7 days.",
];

export function Assistant() {
  const { dial } = useCalls();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const endRef = useRef(null);
  useEffect(() => { get('/ai/status').then(setStatus).catch(() => {}); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  const send = async (text) => {
    const message = (text ?? input).trim();
    if (!message) return;
    setInput('');
    const history = messages.filter((m) => m.role !== 'error').map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: 'user', content: message }]);
    setBusy(true);
    try {
      const res = await post('/ai/assistant', { message, history });
      setMessages((m) => [...m, { role: 'assistant', content: res.reply, actions: res.actions, results: res.toolResults }]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'error', content: e.message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>AI sales assistant</h1>
          <p>{status?.llm ? `Powered by ${status.llm.provider} (${status.llm.model}) using controlled CRM tools.` : 'Running in command mode — connect an AI provider in Settings for natural conversation.'}</p>
        </div>
      </div>
      <div className="card">
        <div className="chat">
          <div className="chat-messages" aria-live="polite">
            {messages.length === 0 && (
              <div className="stack" style={{ alignItems: 'center', marginTop: 40 }}>
                <div className="muted">Try one of these:</div>
                <div className="row" style={{ justifyContent: 'center' }}>
                  {EXAMPLES.map((e) => <button type="button" key={e} className="btn btn-sm" onClick={() => send(e)}>{e}</button>)}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role === 'user' ? 'user' : ''}`} style={m.role === 'error' ? { background: 'var(--danger-soft)', color: 'var(--danger)' } : undefined}>
                {m.content}
                {m.actions?.map((a, j) => a.type === 'call' && (
                  <div key={j} style={{ marginTop: 8 }}>
                    <button type="button" className="btn btn-sm btn-success" onClick={() => dial(a.phone, { name: a.name, related: { contactId: a.contactId, leadId: a.leadId } })}>📞 Call {a.name}</button>
                  </div>
                ))}
                {m.results?.length > 0 && (
                  <details className="small" style={{ marginTop: 6 }}>
                    <summary className="muted">Tools used ({m.results.map((r) => r.name).join(', ')})</summary>
                    <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(m.results.map((r) => r.result), null, 2)}</pre>
                  </details>
                )}
              </div>
            ))}
            {busy && <div className="chat-msg muted">Thinking…</div>}
            <div ref={endRef} />
          </div>
          <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input className="input" placeholder="Ask about your leads, deals, calls…" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Message" />
            <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()}>Send</button>
          </form>
        </div>
      </div>
    </>
  );
}
