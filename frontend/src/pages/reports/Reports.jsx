import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Download, Handshake, IndianRupee, PhoneCall, Target, TriangleAlert } from 'lucide-react';
import { get } from '../../lib/api.js';
import { dateTime, duration, label, money } from '../../lib/format.js';
import { DataTable, ErrorAlert, Field, Loading, Stat, StatusBadge, Tabs } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';
import { OwnerName, useTeam } from '../../lib/team.js';
import { PeriodPicker } from './common.jsx';
import { bucketLabel, downloadCsv, PALETTE, usePeriod } from './reportUtils.js';

const SORTS = [
  ['wonValue', 'Revenue won'], ['leadsConverted', 'Leads converted'], ['conversionRate', 'Conversion %'], ['leadsAssigned', 'Leads assigned'],
  ['calls', 'Calls made'], ['remarks', 'Remarks written'], ['tasksDone', 'Tasks done'], ['collected', 'Money collected'], ['staleLeads', 'Neglected leads'],
];

const EXPORT_COLUMNS = [
  ['Employee', (e) => e.name], ['Employee ID', (e) => e.userCode], ['Role', (e) => label(e.role)], ['Designation', (e) => e.designation],
  ['Leads assigned', (e) => e.leadsAssigned], ['Converted', (e) => e.leadsConverted], ['Conversion %', (e) => e.conversionRate],
  ['Lost / unqualified', (e) => e.leadsDropped], ['Never contacted', (e) => e.leadsUntouched], ['Open leads now', (e) => e.openLeads],
  [`Not contacted 7+ days`, (e) => e.staleLeads], ['Calls', (e) => e.calls], ['Connected calls', (e) => e.connectedCalls],
  ['Talk time (min)', (e) => Math.round(e.talkSeconds / 60)], ['Remarks', (e) => e.remarks], ['Tasks done', (e) => e.tasksDone],
  ['Overdue tasks', (e) => e.overdueTasks], ['Quotes sent', (e) => e.quotesSent], ['Deals won', (e) => e.dealsWon],
  ['Revenue won (₹)', (e) => e.wonValue], ['Open pipeline (₹)', (e) => e.pipelineValue], ['Collected (₹)', (e) => e.collected],
  ['Last login', (e) => (e.lastLogin ? new Date(e.lastLogin).toLocaleString('en-IN') : '')],
].map(([l, value]) => ({ label: l, value }));

function Attention({ e }) {
  const items = [];
  if (e.staleLeads) items.push(`${e.staleLeads} lead${e.staleLeads > 1 ? 's' : ''} not contacted 7+ days`);
  if (e.overdueTasks) items.push(`${e.overdueTasks} overdue task${e.overdueTasks > 1 ? 's' : ''}`);
  if (e.leadsUntouched) items.push(`${e.leadsUntouched} never contacted`);
  if (!items.length) return <span className="small muted">—</span>;
  return <span className="small" style={{ color: 'var(--danger)' }} title={items.join('\n')}><TriangleAlert size={13} style={{ verticalAlign: -2 }} /> {items[0]}{items.length > 1 ? ` +${items.length - 1}` : ''}</span>;
}

function TeamTab({ period }) {
  const navigate = useNavigate();
  const [sort, setSort] = useState('wonValue');
  const { data, error, loading } = useAsync(() => get('/reports/team', { from: period.from, to: period.to }), [period.from, period.to]);
  if (error) return <ErrorAlert error={error} />;
  if (!data) return <Loading />;
  const t = data.totals;
  const rows = [...data.employees].sort((a, b) => b[sort] - a[sort] || a.name.localeCompare(b.name));
  const chart = rows.filter((e) => e.leadsAssigned || e.leadsConverted || e.calls || e.wonValue).slice(0, 12);
  const open = (e) => navigate(`/reports/employees/${e.id}?${period.params.toString()}`);
  return (
    <div style={{ opacity: loading ? 0.6 : 1 }}>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat icon={Target} label="Leads assigned" value={t.leadsAssigned} hint={`${t.leadsConverted} converted · ${t.conversionRate}%`} />
        <Stat icon={PhoneCall} tone="teal" label="Calls · remarks" value={`${t.calls} · ${t.remarks}`} hint={`${t.connectedCalls} connected · talk ${duration(t.talkSeconds)}`} />
        <Stat icon={Handshake} tone="amber" label="Revenue won" value={money(t.wonValue)} hint={`${t.dealsWon} deals · pipeline ${money(t.pipelineValue)}`} />
        <Stat icon={IndianRupee} tone="rose" label="Collected" value={money(t.collected)} hint={`${t.quotesSent} quotes sent · ${t.overdueTasks} tasks overdue`} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h3>Employee performance</h3>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Field label="Rank by">
              <select className="input" value={sort} onChange={(e) => setSort(e.target.value)}>{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </Field>
            <button type="button" className="btn" onClick={() => downloadCsv(`team-performance-${data.period.from}-to-${data.period.to}.csv`, EXPORT_COLUMNS, rows)}><Download size={15} /> Export Excel (CSV)</button>
          </div>
        </div>
        <DataTable
          rows={rows}
          onRowClick={open}
          empty="No employees yet."
          columns={[
            { key: 'rank', label: '#', render: (e) => rows.indexOf(e) + 1 },
            { key: 'name', label: 'Employee', render: (e) => <div><strong>{e.name}</strong>{!e.active && <span className="badge" style={{ marginLeft: 6 }}>inactive</span>}<div className="small muted">{e.designation || label(e.role)}</div></div> },
            { key: 'leads', label: 'Leads', render: (e) => <div>{e.leadsAssigned}<div className="small muted">{e.openLeads} open now</div></div> },
            { key: 'conv', label: 'Converted', render: (e) => <div>{e.leadsConverted}<div className="small muted">{e.conversionRate}%</div></div> },
            { key: 'calls', label: 'Calls', render: (e) => <div>{e.calls}<div className="small muted">{e.connectedCalls} connected</div></div> },
            { key: 'remarks', label: 'Remarks' , render: (e) => e.remarks },
            { key: 'tasks', label: 'Tasks done', render: (e) => <div>{e.tasksDone}{e.overdueTasks > 0 && <div className="small" style={{ color: 'var(--danger)' }}>{e.overdueTasks} overdue</div>}</div> },
            { key: 'won', label: 'Won', render: (e) => <div>{money(e.wonValue)}<div className="small muted">{e.dealsWon} deals</div></div> },
            { key: 'collected', label: 'Collected', render: (e) => money(e.collected) },
            { key: 'attention', label: 'Needs attention', render: (e) => <Attention e={e} /> },
          ]}
        />
        <div className="card-body small muted">
          Leads, converted and conversion % are for leads <b>assigned in this period</b>. Calls, remarks, tasks, wins and payments are what happened in the period.
          "Open now", neglected leads and overdue tasks are as of today. Click an employee for their full report.
        </div>
      </div>

      {chart.length > 0 && (
        <div className="grid grid-2">
          <div className="card"><div className="card-header"><h3>Leads assigned vs converted</h3></div><div className="card-body" style={{ height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={chart.length > 6 ? -20 : 0} textAnchor={chart.length > 6 ? 'end' : 'middle'} height={chart.length > 6 ? 50 : 30} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="leadsAssigned" name="Assigned" fill={PALETTE[0]} radius={[4, 4, 0, 0]} />
                <Bar dataKey="leadsConverted" name="Converted" fill={PALETTE[1]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div></div>
          <div className="card"><div className="card-header"><h3>Revenue won by employee</h3></div><div className="card-body" style={{ height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={chart} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => money(v)} />
                <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => money(v)} />
                <Bar dataKey="wonValue" name="Won" fill={PALETTE[3]} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div></div>
        </div>
      )}
    </div>
  );
}

function LeadsTab({ period }) {
  const navigate = useNavigate();
  const team = useTeam();
  const ownerId = period.params.get('owner') || '';
  const { data, error, loading } = useAsync(() => get('/reports/leads', { from: period.from, to: period.to, ownerId: ownerId || undefined }), [period.from, period.to, ownerId]);
  if (error) return <ErrorAlert error={error} />;
  if (!data) return <Loading />;
  const t = data.totals;
  return (
    <div style={{ opacity: loading ? 0.6 : 1 }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <Field label="Employee">
          <select className="input" value={ownerId} onChange={(e) => period.set({ owner: e.target.value || null })}>
            <option value="">Whole company</option>
            {team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat icon={Target} label="New leads" value={t.leads} hint={`Worth ${money(t.value)}`} />
        <Stat icon={Handshake} tone="teal" label="Converted" value={t.converted} hint={`${t.conversionRate}% of new leads`} />
        <Stat tone="amber" label="Still open" value={t.open} hint={`${t.untouched} never contacted`} />
        <Stat tone="rose" label="Lost / unqualified" value={t.dropped} />
      </div>
      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card"><div className="card-header"><h3>New and converted leads by {data.bucket}</h3></div><div className="card-body" style={{ height: 260 }}>
          <ResponsiveContainer>
            <LineChart data={data.byDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tickFormatter={bucketLabel} tick={{ fontSize: 11 }} minTickGap={16} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip labelFormatter={bucketLabel} />
              <Legend />
              <Line type="monotone" dataKey="new" name="New" stroke={PALETTE[0]} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="converted" name="Converted" stroke={PALETTE[1]} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div></div>
        <div className="card"><div className="card-header"><h3>Where those leads are now</h3></div><div className="card-body" style={{ height: 260 }}>
          {data.byStatus.length ? (
            <ResponsiveContainer>
              <PieChart>
                <Pie data={data.byStatus.map((s) => ({ ...s, name: label(s.status) }))} dataKey="count" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={2} label>
                  {data.byStatus.map((s, i) => <Cell key={s.status} fill={PALETTE[i % PALETTE.length]} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : <div className="empty">No leads in this period.</div>}
        </div></div>
      </div>
      <div className="grid grid-2">
        <div className="card">
          <div className="card-header"><h3>Lead sources</h3></div>
          <DataTable
            rows={data.bySource}
            empty="No leads in this period."
            columns={[
              { key: 'source', label: 'Source', render: (s) => label(s.source) },
              { key: 'count', label: 'Leads' },
              { key: 'converted', label: 'Converted' },
              { key: 'conversionRate', label: 'Conversion', render: (s) => `${s.conversionRate}%` },
            ]}
          />
        </div>
        <div className="card">
          <div className="card-header"><h3>Neglected leads</h3><span className="small muted">Open, not contacted for {data.staleDays}+ days</span></div>
          <DataTable
            rows={data.staleLeads}
            onRowClick={(l) => navigate(`/leads/${l.id}`)}
            empty="Every open lead was contacted in the last week."
            columns={[
              { key: 'name', label: 'Lead', render: (l) => <div><strong>{l.name}</strong><div className="small muted">{l.company || l.phone}</div></div> },
              { key: 'owner', label: 'Assigned to', render: (l) => <OwnerName id={l.ownerId} /> },
              { key: 'status', label: 'Status', render: (l) => <StatusBadge status={l.status} /> },
              { key: 'last', label: 'Last contacted', render: (l) => (l.lastContactedAt ? dateTime(l.lastContactedAt) : <span style={{ color: 'var(--danger)' }}>Never</span>) },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/** Company admin's reports: how each employee is doing, and where the leads stand. */
export function Reports() {
  const period = usePeriod();
  const tab = period.params.get('tab') || 'team';
  return (
    <>
      <div className="page-header">
        <div><h1>Reports</h1><p>Employee performance and lead reports. Visible to the company admin only.</p></div>
        <PeriodPicker period={period} />
      </div>
      <Tabs
        value={tab}
        onChange={(v) => period.set({ tab: v === 'team' ? null : v })}
        tabs={[{ key: 'team', label: 'Team performance' }, { key: 'leads', label: 'Lead report' }]}
      />
      {tab === 'team' ? <TeamTab period={period} /> : <LeadsTab period={period} />}
    </>
  );
}
