import { useState } from 'react';
import { get, post } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { useRealtime } from '../../lib/realtime.jsx';
import { duration, label } from '../../lib/format.js';
import { DataTable, ErrorAlert, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';
import { useCalls } from '../../calling/CallContext.jsx';

export function ActiveCalls() {
  const { can } = useAuth();
  const { capabilities } = useCalls();
  const caps = capabilities?.capabilities || {};
  const { data, error, reload } = useAsync(() => get('/calls/active'), []);
  const [actionError, setActionError] = useState(null);
  useRealtime('call:update', () => reload());

  const monitor = async (id, mode) => {
    setActionError(null);
    try {
      await post(`/calls/${id}/monitor`, { mode });
    } catch (e) {
      setActionError(e);
    }
  };
  const supervisor = can('supervisor:monitor');
  return (
    <div className="card">
      <ErrorAlert error={error || actionError} />
      <DataTable
        rows={data?.items}
        empty="No active calls right now."
        columns={[
          { key: 'direction', label: 'Direction', render: (c) => label(c.direction) },
          { key: 'customerPhone', label: 'Customer', render: (c) => <span className="mono">{c.customerPhone}</span> },
          { key: 'agent', label: 'Agent', render: (c) => c.agentId?.name || (c.status === 'queued' ? 'Waiting in queue' : '—') },
          { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status} /> },
          { key: 'mode', label: 'Mode', render: (c) => label(c.mode) },
          { key: 'time', label: 'Time', render: (c) => duration((Date.now() - new Date(c.answeredAt || c.startedAt)) / 1000) },
          {
            key: 'actions', label: supervisor ? 'Supervisor' : '',
            render: (c) => supervisor && c.status === 'in_progress' && (
              <span className="row">
                <button type="button" className="btn btn-sm" disabled={!caps.monitorListen} onClick={() => monitor(c.id, 'listen')} title="Listen silently">🎧 Listen</button>
                <button type="button" className="btn btn-sm" disabled={!caps.monitorWhisper} onClick={() => monitor(c.id, 'whisper')} title="Speak to the agent only">🗣 Whisper</button>
                <button type="button" className="btn btn-sm" disabled={!caps.monitorBarge} onClick={() => monitor(c.id, 'barge')} title="Join the call">📢 Barge</button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => post(`/calls/${c.id}/hangup`).then(reload)}>End</button>
              </span>
            ),
          },
        ]}
      />
      {supervisor && !caps.monitorListen && <div className="card-body small muted">Your telephony provider does not support live monitoring, so those controls are disabled.</div>}
    </div>
  );
}
