import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post } from '../lib/api.js';
import { dateTime, label } from '../lib/format.js';
import { useCalls } from './CallContext.jsx';

/** Realtime inbound call popup with caller context and quick CRM actions. */
export function CallPopup() {
  const { incoming, accept, reject, capabilities } = useCalls();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!incoming) return null;
  const { call, context = {} } = incoming;
  const webrtc = capabilities?.capabilities?.webrtc;

  const createLead = async () => {
    setBusy(true);
    const lead = await post('/leads', { name: `Caller ${call.from}`, phone: call.from, source: 'inbound_call' });
    navigate(`/leads/${lead.id}`);
    setBusy(false);
  };
  const createTask = async () => {
    setBusy(true);
    await post('/tasks', { title: `Follow up with ${context.name || call.from}`, related: { contactId: context.contact?._id, leadId: context.lead?._id } });
    setBusy(false);
  };

  return (
    <aside className="call-popup" role="alertdialog" aria-label="Incoming call">
      <div className="card-header">
        <strong>📞 Incoming call</strong>
        <span className="badge badge-warning">Ringing</span>
      </div>
      <div className="card-body stack">
        {context.aiEscalation && <div className="alert alert-info small"><strong>From AI agent:</strong> {context.aiEscalation.summary || context.aiEscalation.reason}</div>}
        {call.metadata?.aiEscalation && !context.aiEscalation && <div className="alert alert-info small"><strong>From AI agent:</strong> {call.metadata.aiEscalation.summary}</div>}
        <div>
          <div style={{ fontSize: 18, fontWeight: 650 }}>{context.name || 'Unknown caller'}</div>
          <div className="muted">{call.from}{context.company ? ` · ${context.company}` : ''}</div>
          {context.lead && <span className="badge badge-info">Lead · {label(context.lead.status)}</span>}
          {context.contact && <span className="badge badge-success">Contact</span>}
        </div>
        <div className="small stack" style={{ gap: 4 }}>
          <div>Previous calls: <strong>{context.previousCalls?.length || 0}</strong>{context.previousCalls?.[0] && <span className="muted"> · last {dateTime(context.previousCalls[0].startedAt)}</span>}</div>
          {context.lastInteraction && <div>Last interaction: {context.lastInteraction.title}</div>}
          <div>Open deals: {context.openDeals?.length ? context.openDeals.map((d) => d.name).join(', ') : '—'}</div>
          <div>Open tickets: {context.openTickets?.length ? context.openTickets.map((t) => t.subject).join(', ') : '—'}</div>
        </div>
        <div className="row">
          <button type="button" className="btn btn-success" onClick={accept}>{webrtc ? 'Accept' : 'Answer on phone'}</button>
          {webrtc && <button type="button" className="btn btn-danger" onClick={reject}>Reject</button>}
        </div>
        <div className="row">
          {context.contact && <button type="button" className="btn btn-sm" onClick={() => navigate(`/contacts/${context.contact._id || context.contact.id}`)}>Open contact</button>}
          {context.lead && <button type="button" className="btn btn-sm" onClick={() => navigate(`/leads/${context.lead._id || context.lead.id}`)}>Open lead</button>}
          {!context.contact && !context.lead && <button type="button" className="btn btn-sm" disabled={busy} onClick={createLead}>Create lead</button>}
          {!context.contact && <button type="button" className="btn btn-sm" onClick={() => navigate(`/contacts?new=1&phone=${encodeURIComponent(call.from)}`)}>Create contact</button>}
          <button type="button" className="btn btn-sm" disabled={busy} onClick={createTask}>Create task</button>
        </div>
      </div>
    </aside>
  );
}
