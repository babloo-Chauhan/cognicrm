import { useState } from 'react';
import { get, post } from '../../lib/api.js';
import { dateTime, label, money } from '../../lib/format.js';
import { DataTable, ErrorAlert, Field, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';
import { useCalls } from '../../calling/CallContext.jsx';
import { CallButton } from '../../calling/CallButton.jsx';

/** Preview dialer: see the customer profile first, then call / skip / schedule a callback. */
function PreviewDialer({ campaign }) {
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const [cbAt, setCbAt] = useState('');
  const load = async () => {
    setError(null);
    try {
      setNext(await get(`/call-campaigns/${campaign.id}/next`));
    } catch (e) {
      setError(e);
    }
  };
  const callNow = async () => {
    setError(null);
    try {
      // The softphone picks the call up from realtime call:update events.
      await post(`/call-campaigns/${campaign.id}/contacts/${next.contact.id}/dial`, { mode: 'webrtc' });
      setNext(null);
    } catch (e) {
      setError(e);
    }
  };
  const skip = async () => { await post(`/call-campaigns/${campaign.id}/contacts/${next.contact.id}/skip`); load(); };
  const schedule = async () => {
    await post(`/call-campaigns/${campaign.id}/contacts/${next.contact.id}/callback`, { scheduledAt: new Date(cbAt).toISOString() });
    setCbAt('');
    load();
  };
  const ctx = next?.context;
  return (
    <div className="stack">
      <ErrorAlert error={error} />
      {!next && <button type="button" className="btn btn-primary" onClick={load}>Load next contact</button>}
      {next && !next.contact && <div className="empty">No contacts are due right now. <button type="button" className="btn btn-sm" onClick={load}>Check again</button></div>}
      {next?.contact && (
        <div className="grid grid-2">
          <div className="stack">
            <div>
              <div style={{ fontSize: 18, fontWeight: 650 }}>{ctx?.name || next.contact.name}</div>
              <div className="muted mono">{next.contact.phone}</div>
              {ctx?.company && <div>{ctx.company}</div>}
              <div className="small muted">Attempt {next.contact.attempts + 1}</div>
            </div>
            <div className="row">
              <button type="button" className="btn btn-success" onClick={callNow}>📞 Call</button>
              <button type="button" className="btn" onClick={skip}>Skip</button>
            </div>
            <div className="row">
              <input className="input" style={{ width: 220 }} type="datetime-local" value={cbAt} onChange={(e) => setCbAt(e.target.value)} aria-label="Callback time" />
              <button type="button" className="btn" disabled={!cbAt} onClick={schedule}>Schedule callback</button>
            </div>
          </div>
          <div className="stack small">
            <strong>Previous calls</strong>
            {ctx?.previousCalls?.length ? ctx.previousCalls.slice(0, 5).map((c) => <div key={c._id}>{dateTime(c.startedAt)} · {label(c.status)}{c.disposition?.label ? ` · ${c.disposition.label}` : ''}</div>) : <span className="muted">None</span>}
            <strong>Notes</strong>
            {next.notes?.length ? next.notes.map((n) => <div key={n._id}>{n.body}</div>) : <span className="muted">None</span>}
            <strong>Deals</strong>
            {ctx?.openDeals?.length ? ctx.openDeals.map((d) => <div key={d._id}>{d.name} · {label(d.stage)} · {money(d.value)}</div>) : <span className="muted">None</span>}
            <strong>Tickets</strong>
            {ctx?.openTickets?.length ? ctx.openTickets.map((t) => <div key={t._id}>{t.subject} · {label(t.status)}</div>) : <span className="muted">None</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function PowerDialer({ campaign }) {
  const [joined, setJoined] = useState(false);
  const toggle = async () => {
    await post(`/call-campaigns/${campaign.id}/${joined ? 'leave' : 'join'}`);
    setJoined(!joined);
  };
  return (
    <div className="stack">
      <p className="muted">When you join, the dialer automatically calls the next contact whenever you are available. After each call, finish the wrap-up to get the next one.</p>
      <button type="button" className={`btn ${joined ? 'btn-danger' : 'btn-primary'}`} onClick={toggle}>{joined ? 'Leave campaign' : 'Join & start dialing'}</button>
    </div>
  );
}

export function Dialer() {
  const { dial } = useCalls();
  const [number, setNumber] = useState('');
  const campaigns = useAsync(() => get('/call-campaigns'), []);
  const callbacks = useAsync(() => get('/callbacks', { status: 'pending,notified', mine: 1 }), []);
  const [campaignId, setCampaignId] = useState('');
  const running = campaigns.data?.items?.filter((c) => c.status === 'running') || [];
  const campaign = running.find((c) => c.id === campaignId);
  return (
    <div className="grid grid-2">
      <div className="card">
        <div className="card-header"><h3>Quick dial</h3></div>
        <div className="card-body stack">
          <Field label="Phone number">
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="input mono" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+91 98765 43210" onKeyDown={(e) => e.key === 'Enter' && number && dial(number, { source: 'manual' })} />
              <button type="button" className="btn btn-success" disabled={!number} onClick={() => dial(number, { source: 'manual' })}>📞 Call</button>
            </div>
          </Field>
        </div>
        <div className="card-header"><h3>My callbacks</h3></div>
        <DataTable
          rows={callbacks.data?.items}
          empty="No callbacks due."
          columns={[
            { key: 'who', label: 'Customer', render: (c) => c.customerName || c.phone },
            { key: 'scheduledAt', label: 'When', render: (c) => dateTime(c.scheduledAt) },
            { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status} /> },
            { key: 'call', label: '', render: (c) => <CallButton phone={c.phone} name={c.customerName} related={c.related || {}} /> },
          ]}
        />
      </div>
      <div className="card">
        <div className="card-header"><h3>Campaign dialer</h3></div>
        <div className="card-body stack">
          <select className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} aria-label="Campaign">
            <option value="">Select a running campaign…</option>
            {running.map((c) => <option key={c.id} value={c.id}>{c.name} ({label(c.mode)})</option>)}
          </select>
          {campaign && (campaign.mode === 'preview' ? <PreviewDialer key={campaign.id} campaign={campaign} /> : <PowerDialer key={campaign.id} campaign={campaign} />)}
        </div>
      </div>
    </div>
  );
}
