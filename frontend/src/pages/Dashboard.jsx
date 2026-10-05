import { Link } from 'react-router-dom';
import { get, patch } from '../lib/api.js';
import { dateTime, duration, money, percent } from '../lib/format.js';
import { useAuth } from '../lib/auth.jsx';
import { DataTable, Stat, StatusBadge } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { CallButton } from '../calling/CallButton.jsx';

/** Company KPIs from /dashboard (tenant-scoped on the server; sections outside the plan come back null). */
function CompanyKpis() {
  const { data } = useAsync(() => get('/dashboard'), []);
  if (!data) return <div className="grid grid-4" style={{ marginBottom: 16 }}>{[0, 1, 2, 3].map((i) => <div key={i} className="card stat"><div className="skeleton" /></div>)}</div>;
  const maxStage = Math.max(1, ...(data.pipeline || []).map((s) => s.count));
  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {data.leads && <Stat label="Total leads" value={data.leads.total} hint={`${data.leads.newThisMonth} new this month`} />}
        {data.customers && <Stat label="Customers" value={data.customers.total} hint={`${data.customers.contacts} contacts · ${data.customers.accounts} accounts`} />}
        {data.deals && <Stat label="Deals" value={data.deals.total} hint={`${data.deals.won} won · ${data.deals.lost} lost`} />}
        <Stat label="Revenue (won deals)" value={money(data.revenue.wonDeals)} hint={data.revenue.invoicesPaid ? `${money(data.revenue.invoicesPaid)} invoices paid` : undefined} />
        {data.pendingTasks !== null && <Stat label="Pending tasks" value={data.pendingTasks} />}
        <Stat label="Today's activities" value={data.todaysActivities} />
        {data.leads && <Stat label="Lead conversion" value={`${data.conversionRate.leads}%`} />}
        {data.deals && <Stat label="Deal win rate" value={`${data.conversionRate.deals}%`} />}
      </div>
      {(data.pipeline || data.upcomingMeetings) && (
        <div className="grid grid-2" style={{ marginBottom: 16 }}>
          {data.pipeline && (
            <div className="card">
              <div className="card-header"><h3>Sales pipeline</h3><Link to="/pipelines">Pipelines</Link></div>
              <div className="card-body stack">
                {data.pipeline.map((s) => (
                  <div key={s.key} className="funnel-row">
                    <span className="small">{s.label}</span>
                    <div className="funnel-bar"><div style={{ width: `${(s.count / maxStage) * 100}%` }} /></div>
                    <span className="small mono">{s.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.upcomingMeetings && (
            <div className="card">
              <div className="card-header"><h3>Upcoming meetings</h3></div>
              <DataTable rows={data.upcomingMeetings} empty="No meetings in the next 7 days." columns={[
                { key: 'title', label: 'Meeting' },
                { key: 'startAt', label: 'When', render: (m) => dateTime(m.startAt) },
              ]} />
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function Dashboard() {
  const { user, hasModule } = useAuth();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const calling = hasModule('calling');
  const none = () => Promise.resolve(null);
  const stats = useAsync(() => (calling ? get('/analytics/me', { from: start.toISOString() }) : none()), [calling]);
  const tasks = useAsync(() => (hasModule('tasks') ? get('/tasks', { status: 'open', assigneeId: user.id, limit: 10 }) : none()), [user.id]);
  const hot = useAsync(() => (hasModule('leads') ? get('/leads', { sort: '-score', limit: 8 }) : none()), []);
  const callbacks = useAsync(() => (calling ? get('/callbacks', { status: 'pending,notified', mine: 1 }) : none()), [calling]);
  const k = stats.data?.kpis || {};

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, {user.name.split(' ')[0]}</h1>
          <p>Here is your day at a glance.</p>
        </div>
      </div>
      <CompanyKpis />
      {calling && <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="My calls today" value={k.totalCalls ?? '—'} />
        <Stat label="Connected" value={k.connectedCalls ?? '—'} hint={`Answer rate ${percent(k.answerRate)}`} />
        <Stat label="Avg duration" value={duration(k.averageDuration)} />
        <Stat label="Conversions" value={k.conversions ?? '—'} hint={`Conversion rate ${percent(k.conversionRate)}`} />
      </div>}
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
        {calling && <div className="card">
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
        </div>}
      </div>
    </>
  );
}
