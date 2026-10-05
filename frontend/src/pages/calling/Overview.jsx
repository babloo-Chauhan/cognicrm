import { useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { get } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { useRealtime } from '../../lib/realtime.jsx';
import { duration, percent } from '../../lib/format.js';
import { DataTable, ErrorAlert, Field, Stat, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';

const PALETTE = ['#2f5bea', '#12805c', '#c4302b', '#a35c00', '#7c3aed', '#0891b2', '#db2777', '#4b5563'];

function LiveBoard() {
  const { data, error, reload } = useAsync(() => get('/supervisor/dashboard'), []);
  useRealtime('agent:status', () => reload());
  useRealtime('call:update', () => reload());
  if (error) return <ErrorAlert error={error} />;
  if (!data) return null;
  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Agents online" value={data.agentsOnline} hint={`${data.agentsAvailable} available · ${data.agentsBusy} busy`} />
        <Stat label="Calls waiting" value={data.callsWaiting} hint={`Avg wait ${duration(data.averageWait)}`} />
        <Stat label="Active calls" value={data.activeCalls} />
        <Stat label="Calls today" value={data.callsToday} hint={`${data.missedCalls} missed · ${data.abandonedCalls} abandoned`} />
      </div>
      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-header"><h3>Agents</h3><span className="small muted">Realtime · AHT {duration(data.averageHandleTime)}</span></div>
          <DataTable
            rows={data.agents}
            columns={[
              { key: 'name', label: 'Agent' },
              { key: 'status', label: 'Status', render: (a) => <StatusBadge status={a.status} text={a.customStatus} /> },
              { key: 'currentCall', label: 'Current call', render: (a) => (a.currentCall ? `${a.currentCall.customerPhone} · ${duration((Date.now() - new Date(a.currentCall.startedAt)) / 1000)}` : '—') },
              { key: 'callsToday', label: 'Calls today' },
              { key: 'conversionRate', label: 'Conversion', render: (a) => percent(a.conversionRate) },
            ]}
          />
        </div>
        <div className="card">
          <div className="card-header"><h3>Queues</h3></div>
          <DataTable
            rows={data.queues}
            empty="No queues configured."
            columns={[
              { key: 'name', label: 'Queue' },
              { key: 'waiting', label: 'Waiting' },
              { key: 'longestWaitSeconds', label: 'Longest wait', render: (q) => duration(q.longestWaitSeconds) },
              { key: 'strategy', label: 'Strategy', render: (q) => q.strategy.replace(/_/g, ' ') },
            ]}
          />
        </div>
      </div>
    </>
  );
}

export function Overview() {
  const { can } = useAuth();
  const [range, setRange] = useState(() => ({ from: new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }));
  const isSupervisor = can('analytics:read');
  const { data, error } = useAsync(
    () => get(isSupervisor ? '/analytics/calls' : '/analytics/me', { from: `${range.from}T00:00:00`, to: `${range.to}T23:59:59` }),
    [range.from, range.to, isSupervisor],
  );
  const k = data?.kpis || {};
  return (
    <>
      {can('supervisor:monitor') && <LiveBoard />}
      <div className="row" style={{ marginBottom: 12 }}>
        <h2>{isSupervisor ? 'Call analytics' : 'My call analytics'}</h2>
        <div className="row right">
          <Field label="From"><input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label="To"><input className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        </div>
      </div>
      <ErrorAlert error={error} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Total calls" value={k.totalCalls ?? '—'} hint={`${k.inboundCalls ?? 0} in · ${k.outboundCalls ?? 0} out`} />
        <Stat label="Connected" value={k.connectedCalls ?? '—'} hint={`Answer rate ${percent(k.answerRate)}`} />
        <Stat label="Missed / abandoned" value={`${k.missedCalls ?? 0} / ${k.abandonedCalls ?? 0}`} hint={`Avg wait ${duration(k.averageWaitTime)}`} />
        <Stat label="Avg duration" value={duration(k.averageDuration)} hint={`Conversion ${percent(k.conversionRate)}`} />
      </div>
      {data && (
        <div className="grid grid-2">
          <div className="card"><div className="card-header"><h3>Calls by day</h3></div><div className="card-body" style={{ height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={data.byDay}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="inbound" stackId="a" fill={PALETTE[0]} name="Inbound" />
                <Bar dataKey="outbound" stackId="a" fill={PALETTE[1]} name="Outbound" />
              </BarChart>
            </ResponsiveContainer>
          </div></div>
          <div className="card"><div className="card-header"><h3>Average duration</h3></div><div className="card-body" style={{ height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={data.byDay}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => duration(v)} />
                <Line type="monotone" dataKey="averageDuration" stroke={PALETTE[4]} strokeWidth={2} name="Avg duration" />
              </LineChart>
            </ResponsiveContainer>
          </div></div>
          {isSupervisor && (
            <div className="card"><div className="card-header"><h3>Calls & conversions by agent</h3></div><div className="card-body" style={{ height: 260 }}>
              <ResponsiveContainer>
                <BarChart data={data.byAgent}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="total" fill={PALETTE[0]} name="Calls" />
                  <Bar dataKey="connected" fill={PALETTE[1]} name="Connected" />
                  <Bar dataKey="conversions" fill={PALETTE[3]} name="Conversions" />
                </BarChart>
              </ResponsiveContainer>
            </div></div>
          )}
          <div className="card"><div className="card-header"><h3>Dispositions</h3></div><div className="card-body" style={{ height: 260 }}>
            {data.byDisposition.length ? (
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={data.byDisposition} dataKey="count" nameKey="disposition" outerRadius={90} label>
                    {data.byDisposition.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : <div className="empty">No dispositions yet.</div>}
          </div></div>
          {isSupervisor && data.byDepartment.length > 0 && (
            <div className="card"><div className="card-header"><h3>Calls by department</h3></div><div className="card-body" style={{ height: 260 }}>
              <ResponsiveContainer>
                <BarChart data={data.byDepartment}>
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="total" fill={PALETTE[5]} name="Calls" />
                </BarChart>
              </ResponsiveContainer>
            </div></div>
          )}
        </div>
      )}
    </>
  );
}
