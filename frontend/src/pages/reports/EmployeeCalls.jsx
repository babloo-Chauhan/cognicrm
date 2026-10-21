import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Clock, Download, Mic, Phone, PhoneIncoming } from 'lucide-react';
import { get } from '../../lib/api.js';
import { dateTime, duration } from '../../lib/format.js';
import { DataTable, ErrorAlert, Loading, Pager, Stat, StatusBadge, Tabs } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';
import { RecordingPlayer } from '../../calling/RecordingPlayer.jsx';
import { downloadCsv, PALETTE } from './reportUtils.js';

const FILTERS = [
  { key: 'all', label: 'All calls' }, { key: 'connected', label: 'Connected' }, { key: 'missed', label: 'Not connected' },
  { key: 'recorded', label: 'With recording' }, { key: 'outbound', label: 'Outgoing' }, { key: 'inbound', label: 'Incoming' },
];
const PAGE = 25;
const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

function Duration({ c }) {
  if (!c.connected) return <span className="muted">—</span>;
  return c.durationEstimated
    ? <span title="Called from the mobile app through the phone's dialer: time away from the app, confirmed by the employee">~{duration(c.durationSeconds)}</span>
    : duration(c.durationSeconds);
}

const EXPORT = [
  ['Date & time', (c) => new Date(c.startedAt).toLocaleString('en-IN')], ['Customer', (c) => c.customer], ['Phone', (c) => c.phone],
  ['Direction', (c) => (c.direction === 'inbound' ? 'Incoming' : 'Outgoing')], ['Connected', (c) => (c.connected ? 'Yes' : 'No')],
  ['Duration (seconds)', (c) => c.durationSeconds], ['Duration estimated (mobile dialer)', (c) => (c.durationEstimated ? 'Yes' : 'No')],
  ['Outcome', (c) => c.outcome], ['Notes', (c) => c.notes], ['Recording', (c) => (c.hasRecording ? 'Yes' : c.deviceRecording === 'not_found' ? 'Not found on phone' : 'No')],
].map(([label, value]) => ({ label, value }));

/** Calls section of the employee report: how many, how long, when, how they ended, and every call with its recording. */
export function EmployeeCalls({ employee, summary, period }) {
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState({ n: 1, key: '' });
  const key = `${filter}:${period.from}:${period.to}`;
  const pageNo = page.key === key ? page.n : 1;
  const [exporting, setExporting] = useState(false);
  const query = { from: period.from, to: period.to, filter: filter === 'all' ? undefined : filter };
  const { data, error, loading } = useAsync(() => get(`/reports/employees/${employee.id}/calls`, { ...query, page: pageNo, limit: PAGE }), [employee.id, key, pageNo]);
  const s = summary;
  const busyHours = s.byHour.filter((h) => h.calls);
  const hours = busyHours.length ? s.byHour.slice(Math.min(...busyHours.map((h) => h.hour)), Math.max(...busyHours.map((h) => h.hour)) + 1) : [];

  const exportAll = async () => {
    setExporting(true);
    try {
      const rows = [];
      for (let p = 1; p <= 50; p++) {
        const r = await get(`/reports/employees/${employee.id}/calls`, { ...query, page: p, limit: 100 });
        rows.push(...r.items);
        if (rows.length >= r.total || !r.items.length) break;
      }
      downloadCsv(`calls-${employee.name.replace(/\s+/g, '-')}-${period.from}-to-${period.to}.csv`, EXPORT, rows);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <h2 style={{ margin: '24px 0 12px' }}>Calls</h2>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat icon={Phone} tone="teal" label="Calls made / received" value={`${s.outbound} / ${s.inbound}`} hint={`${s.total} calls in total`} />
        <Stat icon={PhoneIncoming} tone="primary" label="Connected" value={s.connected} hint={`${s.connectRate}% connected · ${s.notConnected} not connected`} />
        <Stat icon={Clock} tone="amber" label="Total talk time" value={duration(s.talkSeconds)} hint={`Average ${duration(s.averageSeconds)} · longest ${duration(s.longestSeconds)}`} />
        <Stat icon={Mic} tone="rose" label="Recordings" value={s.recorded} hint={s.recorded ? 'Play them in the call list below' : 'No recorded calls in this period'} />
      </div>
      {s.total > 0 && (
        <p className="small muted" style={{ marginTop: -6 }}>
          First call {dateTime(s.firstCallAt)} · last call {dateTime(s.lastCallAt)}.
          {s.estimatedCalls > 0 && <> {s.estimatedCalls} call{s.estimatedCalls > 1 ? 's were' : ' was'} made from an older version of the mobile app — their duration (shown with ~) is the time away from the app, confirmed by the employee.</>}
          {s.recorderOff > 0 && <span style={{ color: 'var(--warning)' }}> {s.recorderOff} connected call{s.recorderOff > 1 ? 's have' : ' has'} no recording: the phone&apos;s call recorder is off — ask the employee to turn on automatic call recording in the phone&apos;s dialer settings.</span>}
        </p>
      )}

      {s.total > 0 && (
        <div className="grid grid-2" style={{ marginBottom: 16 }}>
          <div className="card"><div className="card-header"><h3>Calls by hour of day</h3></div><div className="card-body" style={{ height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={hours}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="hour" tickFormatter={hourLabel} tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip labelFormatter={(h) => `${hourLabel(h)} – ${hourLabel((h + 1) % 24)}`} />
                <Legend />
                <Bar dataKey="connected" stackId="a" name="Connected" fill={PALETTE[1]} />
                <Bar dataKey={(h) => h.calls - h.connected} stackId="a" name="Not connected" fill={PALETTE[2]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div></div>
          <div className="card">
            <div className="card-header"><h3>How the calls ended</h3></div>
            <DataTable
              rows={s.byOutcome}
              columns={[
                { key: 'outcome', label: 'Outcome' },
                { key: 'count', label: 'Calls' },
                { key: 'share', label: 'Share', render: (o) => `${Math.round((o.count / s.total) * 100)}%` },
              ]}
            />
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h3>Call list</h3>
          <button type="button" className="btn btn-sm" disabled={exporting || !data?.total} onClick={exportAll}><Download size={14} /> {exporting ? 'Preparing…' : 'Export Excel (CSV)'}</button>
        </div>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <Tabs value={filter} onChange={setFilter} tabs={FILTERS} />
        </div>
        <ErrorAlert error={error} />
        {!data ? <Loading /> : (
          <div style={{ opacity: loading ? 0.6 : 1 }}>
            <DataTable
              rows={data.items}
              empty="No calls in this period."
              columns={[
                { key: 'when', label: 'When', render: (c) => dateTime(c.startedAt) },
                {
                  key: 'customer', label: 'Customer', render: (c) => {
                    const to = c.contactId ? `/contacts/${c.contactId}` : c.leadId ? `/leads/${c.leadId}` : null;
                    return <div>{to ? <Link to={to}><strong>{c.customer || c.phone}</strong></Link> : <strong>{c.customer || c.phone || '—'}</strong>}{c.customer && <div className="small muted">{c.phone}</div>}</div>;
                  },
                },
                { key: 'dir', label: 'Type', render: (c) => (c.direction === 'inbound' ? '↙ Incoming' : '↗ Outgoing') },
                { key: 'status', label: 'Result', render: (c) => <StatusBadge status={c.connected ? 'completed' : c.status} /> },
                { key: 'duration', label: 'Duration', render: (c) => <Duration c={c} /> },
                { key: 'outcome', label: 'Outcome & notes', render: (c) => (c.outcome || c.notes ? <div><div>{c.outcome}</div>{c.notes && <div className="small muted" style={{ maxWidth: 260 }}>{c.notes}</div>}</div> : <span className="muted">—</span>) },
                { key: 'rec', label: 'Recording', render: (c) => (c.hasRecording ? <RecordingPlayer callId={c.id} />
                  : c.deviceRecording === 'not_found' ? <span className="small" style={{ color: 'var(--warning)' }} title="The employee's phone had no recording of this call: its call recorder is off">Recorder off</span>
                    : <span className="muted">—</span>) },
              ]}
            />
            <Pager page={pageNo} pageSize={PAGE} total={data.total} loading={loading} onPage={(n) => setPage({ n, key })} />
          </div>
        )}
      </div>
    </>
  );
}
