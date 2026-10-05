import { get, patch } from '../../lib/api.js';
import { dateTime, duration, label } from '../../lib/format.js';
import { DataTable, ErrorAlert, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';
import { RecordingPlayer } from '../../calling/RecordingPlayer.jsx';
import { CallButton } from '../../calling/CallButton.jsx';

export function Recordings() {
  const recordings = useAsync(() => get('/recordings', { kind: 'call' }), []);
  const voicemails = useAsync(() => get('/voicemails'), []);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card">
        <div className="card-header"><h3>Voicemail</h3></div>
        <ErrorAlert error={voicemails.error} />
        <DataTable
          rows={voicemails.data?.items}
          empty="No voicemail."
          columns={[
            { key: 'createdAt', label: 'Received', render: (v) => dateTime(v.createdAt) },
            { key: 'from', label: 'From', render: (v) => <span className="row"><span className="mono">{v.from}</span><CallButton phone={v.from} /></span> },
            { key: 'scope', label: 'Box', render: (v) => label(v.scope) },
            { key: 'duration', label: 'Length', render: (v) => duration(v.duration) },
            { key: 'listened', label: '', render: (v) => <StatusBadge status={v.listened ? 'read' : 'new'} text={v.listened ? 'Listened' : 'New'} /> },
            {
              key: 'play', label: '',
              render: (v) => (
                <span className="row" onClick={() => !v.listened && patch(`/voicemails/${v.id}`, { listened: true }).then(voicemails.reload)}>
                  <RecordingPlayer recordingId={v.recordingId} />
                </span>
              ),
            },
          ]}
        />
      </div>
      <div className="card">
        <div className="card-header"><h3>Call recordings</h3><span className="small muted">Played through short-lived signed links. Every access is audited.</span></div>
        <ErrorAlert error={recordings.error} />
        <DataTable
          rows={recordings.data?.items}
          empty="No recordings. Enable recording in Calling → Settings (where legally permitted)."
          columns={[
            { key: 'createdAt', label: 'Date', render: (r) => dateTime(r.createdAt) },
            { key: 'customer', label: 'Customer', render: (r) => r.callId?.customerPhone || '—' },
            { key: 'agent', label: 'Agent', render: (r) => r.callId?.agentId?.name || '—' },
            { key: 'direction', label: 'Direction', render: (r) => label(r.callId?.direction) },
            { key: 'duration', label: 'Length', render: (r) => duration(r.duration) },
            { key: 'deleteAt', label: 'Auto-delete', render: (r) => (r.deleteAt ? dateTime(r.deleteAt) : 'Never') },
            { key: 'play', label: '', render: (r) => <RecordingPlayer recordingId={r.id} /> },
          ]}
        />
      </div>
    </div>
  );
}
