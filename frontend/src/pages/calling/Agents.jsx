import { get, post, put } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { useRealtime } from '../../lib/realtime.jsx';
import { dateTime, label } from '../../lib/format.js';
import { DataTable, ErrorAlert, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';

const STATUSES = ['available', 'busy', 'break', 'offline'];

export function Agents() {
  const { can, user } = useAuth();
  const { data, error, reload } = useAsync(() => get('/agents/status'), []);
  useRealtime('agent:status', () => reload());
  const manage = can('agents:manage');
  return (
    <div className="card">
      <ErrorAlert error={error} />
      <DataTable
        rows={data?.items}
        columns={[
          { key: 'name', label: 'Agent' },
          { key: 'role', label: 'Role', render: (a) => label(a.role) },
          { key: 'status', label: 'Status', render: (a) => <StatusBadge status={a.status} text={a.customStatus ? data.customStatuses.find((s) => s.key === a.customStatus)?.label : undefined} /> },
          { key: 'since', label: 'Since', render: (a) => dateTime(a.since) },
          {
            key: 'actions', label: manage ? 'Supervisor actions' : '',
            render: (a) => manage && (
              <span className="row">
                <select className="input" style={{ width: 140 }} value="" onChange={async (e) => { await put(`/agents/${a.userId}/status`, { status: e.target.value }); reload(); }} aria-label={`Change status for ${a.name}`}>
                  <option value="">Set status…</option>
                  {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                  {data.customStatuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                {a.userId !== user.id && <button type="button" className="btn btn-sm btn-danger" onClick={async () => { if (window.confirm(`Force logout ${a.name}?`)) { await post(`/agents/${a.userId}/force-logout`); reload(); } }}>Force logout</button>}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
