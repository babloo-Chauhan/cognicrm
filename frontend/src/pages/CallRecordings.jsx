import { useState } from 'react';
import { get } from '../lib/api.js';
import { dateTime, duration, label } from '../lib/format.js';
import { useAsync } from '../lib/hooks.js';
import { DataTable, ErrorAlert } from '../components/ui.jsx';
import { RecordingPlayer } from '../calling/RecordingPlayer.jsx';

const PAGE = 25;

/** Talk time; "~" marks an estimate (calls from an older app version, not read from the phone's call log). */
const talk = (c) => (c.answeredAt ? `${c.mode === 'native' && !c.durationFromCallLog ? '~' : ''}${duration(c.durationSeconds || 0)}` : '—');

function Recording({ c }) {
  if (c.hasRecording) return <RecordingPlayer callId={c.id} />;
  if (c.deviceRecording === 'not_found') {
    return <span className="small" style={{ color: 'var(--warning)' }} title="The phone had no recording of this call: its call recorder is off">Recorder off</span>;
  }
  return <span className="muted">—</span>;
}

/** Every call with this lead / contact / deal / account, newest first, each with its recording to play. */
export function CallRecordings({ type, id }) {
  const [limit, setLimit] = useState(PAGE);
  const [onlyRecorded, setOnlyRecorded] = useState(false);
  const { data, error, loading } = useAsync(() => get('/calls', { [`${type}Id`]: id, limit }), [type, id, limit]);
  if (error) return <div className="card"><div className="card-body"><ErrorAlert error={error} /></div></div>;
  const all = data?.items || [];
  const rows = onlyRecorded ? all.filter((c) => c.hasRecording) : all;
  const connected = all.filter((c) => c.answeredAt);
  const recorded = all.filter((c) => c.hasRecording).length;
  return (
    <div className="card">
      <div className="card-header">
        <h3>Calls &amp; recordings</h3>
        {all.length > 0 && (
          <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={onlyRecorded} onChange={(e) => setOnlyRecorded(e.target.checked)} /> Only with recording
          </label>
        )}
      </div>
      {all.length > 0 && (
        <div className="card-body small muted" style={{ paddingBottom: 0 }}>
          {data.total} call{data.total === 1 ? '' : 's'} · {connected.length} connected · talk {duration(connected.reduce((s, c) => s + (c.durationSeconds || 0), 0))} · {recorded} recorded
          {data.total > all.length && ` (latest ${all.length} shown)`}
        </div>
      )}
      <div style={{ opacity: loading ? 0.6 : 1 }}>
        <DataTable
          rows={rows}
          empty={loading ? 'Loading…' : onlyRecorded ? 'No recorded calls yet.' : 'No calls yet.'}
          columns={[
            { key: 'when', label: 'When', render: (c) => dateTime(c.startedAt) },
            { key: 'who', label: 'By', render: (c) => c.agentId?.name || '—' },
            { key: 'dir', label: 'Call', render: (c) => <div>{label(c.direction)}<div className="small muted">{c.disposition?.label || label(c.status)}</div></div> },
            { key: 'talk', label: 'Talk time', render: talk },
            { key: 'rec', label: 'Recording', render: (c) => <Recording c={c} /> },
          ]}
        />
      </div>
      {data?.total > all.length && (
        <div className="card-body" style={{ paddingTop: 8 }}>
          <button type="button" className="btn btn-sm" disabled={loading} onClick={() => setLimit((n) => n + PAGE)}>Show more calls</button>
        </div>
      )}
    </div>
  );
}
