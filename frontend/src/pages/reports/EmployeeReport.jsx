import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ArrowLeft, Handshake, ListChecks, PhoneCall, Target } from 'lucide-react';
import { get } from '../../lib/api.js';
import { dateTime, duration, label, money } from '../../lib/format.js';
import { DataTable, ErrorAlert, Loading, Stat, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';
import { PeriodPicker } from './common.jsx';
import { EmployeeCalls } from './EmployeeCalls.jsx';
import { bucketLabel, PALETTE, usePeriod } from './reportUtils.js';

const ACTIVITY_ICON = {
  call: '📞', note: '📝', lead_created: '✨', lead_converted: '🎉', lead_assigned: '👤', deal_created: '💼', stage_changed: '➡️',
  task_created: '✅', sms: '💬', whatsapp: '🟢', email: '✉️', appointment: '📅', contact_created: '👤',
};

/** Everything about one employee for the chosen period. */
export function EmployeeReport() {
  const { id } = useParams();
  const navigate = useNavigate();
  const period = usePeriod();
  const { data, error, loading } = useAsync(() => get(`/reports/employees/${id}`, { from: period.from, to: period.to }), [id, period.from, period.to]);
  const back = new URLSearchParams(period.params);
  back.delete('owner');
  if (error) return <ErrorAlert error={error} />;
  if (!data) return <Loading />;
  const e = data.employee;
  return (
    <div style={{ opacity: loading ? 0.6 : 1 }}>
      <Link to={`/reports?${back}`} className="small muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 8 }}><ArrowLeft size={14} /> All employees</Link>
      <div className="page-header">
        <div>
          <h1>{e.name}</h1>
          <p>
            {[...new Set([e.designation, label(e.role), e.department, e.userCode].filter(Boolean))].join(' · ')}
            {' · '}Last login {e.lastLogin ? dateTime(e.lastLogin) : 'never'}
            {!e.active && <span className="badge" style={{ marginLeft: 6 }}>inactive</span>}
          </p>
        </div>
        <PeriodPicker period={period} />
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat icon={Target} label="Leads assigned" value={e.leadsAssigned} hint={`${e.leadsConverted} converted (${e.conversionRate}%) · ${e.leadsDropped} lost`} />
        <Stat icon={PhoneCall} tone="teal" label="Calls" value={e.calls} hint={`${e.connectedCalls} connected · talk ${duration(e.talkSeconds)}`} />
        <Stat icon={ListChecks} tone="sky" label="Remarks · tasks done" value={`${e.remarks} · ${e.tasksDone}`} hint={e.overdueTasks ? `${e.overdueTasks} tasks overdue` : 'No overdue tasks'} />
        <Stat icon={Handshake} tone="amber" label="Revenue won" value={money(e.wonValue)} hint={`${e.dealsWon} deals · collected ${money(e.collected)}`} />
      </div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat tone="rose" label="Open leads now" value={e.openLeads} hint={`${e.staleLeads} not contacted 7+ days`} />
        <Stat tone="rose" label="Never contacted" value={e.leadsUntouched} hint="of the leads assigned in the period" />
        <Stat tone="primary" label="Quotes sent" value={e.quotesSent} hint={`Worth ${money(e.quotedValue)}`} />
        <Stat tone="teal" label="Open pipeline" value={money(e.pipelineValue)} hint={`${e.openDeals} open deals`} />
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card"><div className="card-header"><h3>Work by {data.bucket}</h3></div><div className="card-body" style={{ height: 260 }}>
          <ResponsiveContainer>
            <BarChart data={data.byDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tickFormatter={bucketLabel} tick={{ fontSize: 11 }} minTickGap={12} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip labelFormatter={bucketLabel} />
              <Legend />
              <Bar dataKey="leads" name="New leads" fill={PALETTE[0]} />
              <Bar dataKey="calls" name="Calls" fill={PALETTE[1]} />
              <Bar dataKey="remarks" name="Remarks" fill={PALETTE[3]} />
            </BarChart>
          </ResponsiveContainer>
        </div></div>
        <div className="card">
          <div className="card-header"><h3>Their leads by status</h3><span className="small muted">Assigned in this period</span></div>
          <DataTable
            rows={data.leadsByStatus}
            empty="No leads assigned in this period."
            columns={[
              { key: 'status', label: 'Status', render: (s) => <StatusBadge status={s.status} /> },
              { key: 'count', label: 'Leads' },
              { key: 'share', label: 'Share', render: (s) => `${Math.round((s.count / (e.leadsAssigned || 1)) * 100)}%` },
            ]}
          />
          {e.leadsAssigned > 0 && (
            <div className="card-body">
              <button type="button" className="btn btn-sm" onClick={() => navigate(`/leads?ownerId=${e.id}`)}>Open their leads</button>
            </div>
          )}
        </div>
      </div>

      <EmployeeCalls employee={e} summary={data.calls} period={period} />

      <h2 style={{ margin: '24px 0 12px' }}>Follow-ups</h2>
      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-header"><h3>Neglected leads</h3><span className="small muted">Open, not contacted for 7+ days</span></div>
          <DataTable
            rows={data.staleLeads}
            onRowClick={(l) => navigate(`/leads/${l.id}`)}
            empty="All their open leads were contacted in the last week. 👍"
            columns={[
              { key: 'name', label: 'Lead', render: (l) => <div><strong>{l.name}</strong><div className="small muted">{l.company || l.phone}</div></div> },
              { key: 'status', label: 'Status', render: (l) => <StatusBadge status={l.status} /> },
              { key: 'last', label: 'Last contacted', render: (l) => (l.lastContactedAt ? dateTime(l.lastContactedAt) : <span style={{ color: 'var(--danger)' }}>Never</span>) },
            ]}
          />
        </div>
        <div className="card">
          <div className="card-header"><h3>Overdue tasks</h3></div>
          <DataTable
            rows={data.overdueTasks}
            onRowClick={() => navigate('/tasks')}
            empty="No overdue tasks. 👍"
            columns={[
              { key: 'title', label: 'Task' },
              { key: 'priority', label: 'Priority', render: (t) => <StatusBadge status={t.priority} /> },
              { key: 'dueAt', label: 'Was due', render: (t) => <span style={{ color: 'var(--danger)' }}>{dateTime(t.dueAt)}</span> },
            ]}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-header"><h3>Recent activity</h3><span className="small muted">Latest 30 in this period</span></div>
        <DataTable
          rows={data.recentActivity}
          onRowClick={(a) => a.leadId && navigate(`/leads/${a.leadId}`)}
          empty="No activity in this period."
          columns={[
            { key: 'icon', label: '', render: (a) => ACTIVITY_ICON[a.type] || '•' },
            { key: 'title', label: 'What', render: (a) => a.title || label(a.type) },
            { key: 'occurredAt', label: 'When', render: (a) => dateTime(a.occurredAt) },
          ]}
        />
      </div>
    </div>
  );
}
