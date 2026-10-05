import { Link } from 'react-router-dom';
import { get, patch } from '../lib/api.js';
import { dateTime, duration, percent } from '../lib/format.js';
import { useAuth } from '../lib/auth.jsx';
import { DataTable, Stat, StatusBadge } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { CallButton } from '../calling/CallButton.jsx';

export function Dashboard() {
  const { user } = useAuth();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const stats = useAsync(() => get('/analytics/me', { from: start.toISOString() }), []);
  const tasks = useAsync(() => get('/tasks', { status: 'open', assigneeId: user.id, limit: 10 }), [user.id]);
  const hot = useAsync(() => get('/leads', { sort: '-score', limit: 8 }), []);
  const callbacks = useAsync(() => get('/callbacks', { status: 'pending,notified', mine: 1 }), []);
  const k = stats.data?.kpis || {};

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, {user.name.split(' ')[0]}</h1>
          <p>Here is your day at a glance.</p>
        </div>
      </div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="My calls today" value={k.totalCalls ?? '—'} />
        <Stat label="Connected" value={k.connectedCalls ?? '—'} hint={`Answer rate ${percent(k.answerRate)}`} />
        <Stat label="Avg duration" value={duration(k.averageDuration)} />
        <Stat label="Conversions" value={k.conversions ?? '—'} hint={`Conversion rate ${percent(k.conversionRate)}`} />
      </div>
      <div className="grid grid-2">
        <div className="card">
          <div className="card-header"><h3>My open tasks</h3><Link to="/tasks">All tasks</Link></div>
          <DataTable
            rows={tasks.data?.items}
            empty="No open tasks 🎉"
            columns={[
              { key: 'title', label: 'Task' },
              { key: 'dueAt', label: 'Due', render: (t) => <span style={{ color: t.dueAt && new Date(t.dueAt) < new Date() ? 'var(--danger)' : undefined }}>{dateTime(t.dueAt)}</span> },
              { key: 'done', label: '', render: (t) => <button type="button" className="btn btn-sm" onClick={async () => { await patch(`/tasks/${t.id}`, { status: 'done' }); tasks.reload(); }}>Done</button> },
            ]}
          />
        </div>
        <div className="card">
          <div className="card-header"><h3>Hottest leads</h3><Link to="/leads">All leads</Link></div>
          <DataTable
            rows={hot.data?.items}
            empty="No leads yet."
            columns={[
              { key: 'name', label: 'Lead', render: (l) => <Link to={`/leads/${l.id}`}>{l.name}</Link> },
              { key: 'score', label: 'Score', render: (l) => <StatusBadge status={l.score >= 70 ? 'hot' : l.score >= 40 ? 'warm' : 'cold'} text={String(l.score)} /> },
              { key: 'call', label: '', render: (l) => <CallButton phone={l.phone} name={l.name} related={{ leadId: l.id }} /> },
            ]}
          />
        </div>
        <div className="card">
          <div className="card-header"><h3>My callbacks</h3></div>
          <DataTable
            rows={callbacks.data?.items}
            empty="No callbacks scheduled."
            columns={[
              { key: 'phone', label: 'Customer', render: (c) => c.customerName || c.phone },
              { key: 'scheduledAt', label: 'When', render: (c) => dateTime(c.scheduledAt) },
              { key: 'priority', label: 'Priority', render: (c) => <StatusBadge status={c.priority} /> },
              { key: 'call', label: '', render: (c) => <CallButton phone={c.phone} name={c.customerName} related={c.related || {}} /> },
            ]}
          />
        </div>
      </div>
    </>
  );
}
