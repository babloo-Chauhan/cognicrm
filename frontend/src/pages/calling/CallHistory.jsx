import { useState } from 'react';
import { download, get } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { dateTime, duration, label } from '../../lib/format.js';
import { DataTable, ErrorAlert, Field, Modal, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';
import { RecordingPlayer } from '../../calling/RecordingPlayer.jsx';

const STATUSES = ['completed', 'no_answer', 'busy', 'failed', 'abandoned', 'voicemail', 'canceled'];

function CallDetail({ id, onClose }) {
  const { data, error } = useAsync(() => get(`/calls/${id}`), [id]);
  const t = data?.transcript;
  return (
    <Modal title="Call details" size="lg" onClose={onClose}>
      <ErrorAlert error={error} />
      {data && (
        <div className="stack">
          <div className="row" style={{ gap: 20 }}>
            <span>{label(data.call.direction)} · <StatusBadge status={data.call.status} /></span>
            <span>{data.call.from} → {data.call.to}</span>
            <span>{duration(data.call.durationSeconds)}</span>
            <span>{data.agent?.name || '—'}</span>
          </div>
          {data.call.disposition?.label && <div><strong>Disposition:</strong> {data.call.disposition.label}{data.call.disposition.notes ? ` — ${data.call.disposition.notes}` : ''}</div>}
          {data.recordings.map((r) => <div key={r.id} className="row"><span className="muted">{label(r.kind)} recording ({duration(r.duration)})</span><RecordingPlayer recordingId={r.id} /></div>)}
          {t && (
            <div className="card"><div className="card-body stack">
              <h3>AI summary</h3>
              {t.summary ? <p style={{ margin: 0 }}>{t.summary}</p> : <span className="muted">Summary not available ({t.status}).</span>}
              {[['Requirements', t.requirements], ['Objections', t.objections], ['Commitments', t.commitments], ['Next steps', t.nextSteps], ['Action items', t.actionItems]].map(([k, v]) => v?.length > 0 && (
                <div key={k}><strong>{k}:</strong> {v.join('; ')}</div>
              ))}
              {t.topics?.length > 0 && <div className="row">{t.topics.map((x) => <span key={x} className="badge">{x}</span>)}</div>}
              {t.sentiment && <div>Sentiment: <StatusBadge status={t.sentiment} /></div>}
              <details><summary>Transcript</summary><p style={{ whiteSpace: 'pre-wrap' }}>{t.segments?.length ? t.segments.map((s) => `${s.speaker}: ${s.text}`).join('\n') : t.transcript}</p></details>
            </div></div>
          )}
          <details><summary className="muted">Event log</summary><ul className="small">{data.call.events.map((e, i) => <li key={i}>{dateTime(e.at)} — {e.type}</li>)}</ul></details>
        </div>
      )}
    </Modal>
  );
}

export function CallHistory() {
  const { can } = useAuth();
  const [f, setF] = useState({ direction: '', status: '', disposition: '', agentId: '', from: '', to: '', minDuration: '', departmentId: '' });
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  const query = { ...f, from: f.from ? `${f.from}T00:00:00` : '', to: f.to ? `${f.to}T23:59:59` : '' };
  const { data, error } = useAsync(() => get('/calls', { ...query, page, limit: 50 }), [JSON.stringify(query), page]);
  const users = useAsync(() => (can('calls:read_all') ? get('/users') : Promise.resolve({ items: [] })), []);
  const dispositions = useAsync(() => get('/call-dispositions'), []);
  const departments = useAsync(() => get('/departments'), []);
  const set = (k) => (e) => { setPage(1); setF({ ...f, [k]: e.target.value }); };

  return (
    <div className="stack">
      <div className="card"><div className="card-body">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="From"><input className="input" type="date" value={f.from} onChange={set('from')} /></Field>
          <Field label="To"><input className="input" type="date" value={f.to} onChange={set('to')} /></Field>
          <Field label="Direction"><select className="input" value={f.direction} onChange={set('direction')}><option value="">All</option><option value="inbound">Inbound</option><option value="outbound">Outbound</option></select></Field>
          <Field label="Status"><select className="input" value={f.status} onChange={set('status')}><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
          <Field label="Disposition"><select className="input" value={f.disposition} onChange={set('disposition')}><option value="">All</option>{dispositions.data?.items?.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}</select></Field>
          {can('calls:read_all') && <Field label="Agent"><select className="input" value={f.agentId} onChange={set('agentId')}><option value="">All</option>{users.data?.items?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>}
          <Field label="Department"><select className="input" value={f.departmentId} onChange={set('departmentId')}><option value="">All</option>{departments.data?.items?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="Min duration (s)"><input className="input" type="number" style={{ width: 110 }} value={f.minDuration} onChange={set('minDuration')} /></Field>
          <div className="row right">
            <button type="button" className="btn" onClick={() => download('/calls/export', { ...query, format: 'csv' }, 'calls.csv')}>Export CSV</button>
            <button type="button" className="btn" onClick={() => download('/calls/export', { ...query, format: 'xlsx' }, 'calls.xlsx')}>Export Excel</button>
          </div>
        </div>
      </div></div>
      <ErrorAlert error={error} />
      <div className="card">
        <DataTable
          rows={data?.items}
          empty="No calls match these filters."
          onRowClick={(c) => setDetail(c.id)}
          columns={[
            { key: 'date', label: 'Date', render: (c) => dateTime(c.startedAt) },
            { key: 'from', label: 'Caller', render: (c) => <span className="mono">{c.from}</span> },
            { key: 'to', label: 'Receiver', render: (c) => <span className="mono">{c.to}</span> },
            { key: 'direction', label: 'Direction', render: (c) => label(c.direction) },
            { key: 'agent', label: 'Agent', render: (c) => c.agentId?.name || '—' },
            { key: 'duration', label: 'Duration', render: (c) => duration(c.durationSeconds) },
            { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status} /> },
            { key: 'disposition', label: 'Disposition', render: (c) => c.disposition?.label || '—' },
            { key: 'recording', label: 'Recording', render: (c) => (c.hasRecording ? '🎧' : '—') },
            { key: 'transcript', label: 'Transcript', render: (c) => (c.hasTranscript ? '📝' : '—') },
          ]}
        />
        {data && data.total > 50 && (
          <div className="card-body row">
            <button type="button" className="btn btn-sm" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="small muted">Page {page} of {Math.ceil(data.total / 50)}</span>
            <button type="button" className="btn btn-sm" disabled={page * 50 >= data.total} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </div>
      {detail && <CallDetail id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
