import { useState } from 'react';
import { get, patch, post } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { duration, label, percent } from '../../lib/format.js';
import { DataTable, ErrorAlert, Field, Modal, Stat, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function CampaignEditor({ initial, onClose, onSaved }) {
  const [c, setC] = useState(initial);
  const [error, setError] = useState(null);
  const users = useAsync(() => get('/users'), []);
  const numbers = useAsync(() => get('/phone-numbers'), []);
  const dispositions = useAsync(() => get('/call-dispositions'), []);
  const set = (k, v) => setC({ ...c, [k]: v });
  const setSchedule = (k, v) => setC({ ...c, schedule: { ...c.schedule, [k]: v } });
  const save = async () => {
    setError(null);
    const body = {
      name: c.name, description: c.description, mode: c.mode, agentIds: c.agentIds, callerIdNumberId: c.callerIdNumberId || undefined,
      schedule: c.schedule, retryPolicy: c.retryPolicy, dispositionRules: c.dispositionRules, predictive: c.predictive,
    };
    try {
      if (c.id) await patch(`/call-campaigns/${c.id}`, body);
      else await post('/call-campaigns', body);
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal title={c.id ? 'Edit campaign' : 'New campaign'} size="lg" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
      <ErrorAlert error={error} />
      <div className="form-grid">
        <Field label="Name"><input className="input" value={c.name || ''} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Dialing mode">
          <select className="input" value={c.mode} onChange={(e) => set('mode', e.target.value)}>
            <option value="preview">Preview — agent reviews before each call</option>
            <option value="power">Power — next call starts automatically</option>
            <option value="predictive">Predictive — paced over-dialing (needs compliance sign-off)</option>
          </select>
        </Field>
        <Field label="Caller ID">
          <select className="input" value={c.callerIdNumberId || ''} onChange={(e) => set('callerIdNumberId', e.target.value)}>
            <option value="">Select a number…</option>
            {numbers.data?.items?.filter((n) => n.capabilities?.voice).map((n) => <option key={n.id} value={n.id}>{n.number}{n.label ? ` (${n.label})` : ''}</option>)}
          </select>
        </Field>
        <Field label="Time zone"><input className="input" value={c.schedule.timezone} onChange={(e) => setSchedule('timezone', e.target.value)} /></Field>
        <Field label="Calling window start"><input className="input" type="time" value={c.schedule.start} onChange={(e) => setSchedule('start', e.target.value)} /></Field>
        <Field label="Calling window end"><input className="input" type="time" value={c.schedule.end} onChange={(e) => setSchedule('end', e.target.value)} /></Field>
        <Field label="Days" className="full">
          <div className="row">{DAYS.map((d, i) => (
            <label key={d} className="checkbox badge"><input type="checkbox" checked={c.schedule.days.includes(i)} onChange={(e) => setSchedule('days', e.target.checked ? [...c.schedule.days, i] : c.schedule.days.filter((x) => x !== i))} />{d}</label>
          ))}</div>
        </Field>
        <Field label="Max attempts"><input className="input" type="number" min="1" max="10" value={c.retryPolicy.maxAttempts} onChange={(e) => set('retryPolicy', { ...c.retryPolicy, maxAttempts: Number(e.target.value) })} /></Field>
        <Field label="Retry delay (minutes)"><input className="input" type="number" min="1" value={c.retryPolicy.retryDelayMinutes} onChange={(e) => set('retryPolicy', { ...c.retryPolicy, retryDelayMinutes: Number(e.target.value) })} /></Field>
        <Field label="Agents" className="full">
          <div className="row">{users.data?.items?.map((u) => (
            <label key={u.id} className="checkbox badge"><input type="checkbox" checked={c.agentIds.includes(u.id)} onChange={(e) => set('agentIds', e.target.checked ? [...c.agentIds, u.id] : c.agentIds.filter((x) => x !== u.id))} />{u.name}</label>
          ))}</div>
        </Field>
        <Field label="Disposition rules" className="full">
          <div className="stack">
            {(c.dispositionRules || []).map((r, i) => (
              <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
                <select className="input" value={r.code} onChange={(e) => set('dispositionRules', c.dispositionRules.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))}>
                  {dispositions.data?.items?.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}
                </select>
                <select className="input" value={r.action} onChange={(e) => set('dispositionRules', c.dispositionRules.map((x, j) => (j === i ? { ...x, action: e.target.value } : x)))}>
                  {['complete', 'retry', 'dnc', 'callback'].map((a) => <option key={a} value={a}>{label(a)}</option>)}
                </select>
                <button type="button" className="btn btn-sm" onClick={() => set('dispositionRules', c.dispositionRules.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => set('dispositionRules', [...(c.dispositionRules || []), { code: 'not_interested', action: 'complete' }])}>+ Add rule</button>
          </div>
        </Field>
        {c.mode === 'predictive' && (
          <div className="full alert alert-warning stack">
            <strong>Predictive dialing safeguards</strong>
            <span className="small">Predictive dialing can cause abandoned calls. Pacing is capped by the maximum dial ratio and automatically falls back to 1:1 when the abandon rate exceeds the limit. Make sure this is permitted in every jurisdiction you call.</span>
            <div className="row">
              <label className="checkbox"><input type="checkbox" checked={Boolean(c.predictive?.enabled)} onChange={(e) => set('predictive', { ...c.predictive, enabled: e.target.checked })} /> Enable predictive pacing</label>
              <label className="checkbox"><input type="checkbox" checked={Boolean(c.predictive?.complianceAcknowledged)} onChange={(e) => set('predictive', { ...c.predictive, complianceAcknowledged: e.target.checked })} /> I confirm this is compliant</label>
            </div>
            <div className="row">
              <Field label="Max abandon rate (%)"><input className="input" type="number" min="0" max="10" step="0.5" value={(c.predictive?.maxAbandonRate ?? 0.03) * 100} onChange={(e) => set('predictive', { ...c.predictive, maxAbandonRate: Number(e.target.value) / 100 })} /></Field>
              <Field label="Max dial ratio"><input className="input" type="number" min="1" max="3" step="0.1" value={c.predictive?.maxDialRatio ?? 1.5} onChange={(e) => set('predictive', { ...c.predictive, maxDialRatio: Number(e.target.value) })} /></Field>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function CampaignDetail({ id, onClose }) {
  const { data, reload } = useAsync(() => get(`/call-campaigns/${id}`), [id]);
  const contacts = useAsync(() => get(`/call-campaigns/${id}/contacts`), [id]);
  const [csv, setCsv] = useState('');
  const [importResult, setImportResult] = useState(null);
  const { can } = useAuth();
  if (!data) return null;
  const importRows = async () => {
    const rows = csv.split(/\r?\n/).map((l) => l.split(',').map((x) => x.trim())).filter((r) => r.some(Boolean))
      .map(([a, b]) => (b ? { name: a, phone: b } : { phone: a }));
    setImportResult(await post(`/call-campaigns/${id}/contacts`, { rows }));
    setCsv('');
    reload();
    contacts.reload();
  };
  const act = async (action) => {
    try {
      await post(`/call-campaigns/${id}/${action}`);
      reload();
    } catch (e) {
      setImportResult({ error: e.message });
    }
  };
  const c = data.campaign;
  return (
    <Modal title={c.name} size="lg" onClose={onClose}>
      <div className="stack">
        <div className="row">
          <StatusBadge status={c.status} /> <span className="muted">{label(c.mode)} dialer</span>
          {can('campaigns:manage') && (
            <span className="row right">
              {['draft', 'paused'].includes(c.status) && <button type="button" className="btn btn-sm btn-primary" onClick={() => act(c.status === 'draft' ? 'start' : 'resume')}>{c.status === 'draft' ? 'Start' : 'Resume'}</button>}
              {c.status === 'running' && <button type="button" className="btn btn-sm" onClick={() => act('pause')}>Pause</button>}
              {c.status !== 'completed' && <button type="button" className="btn btn-sm" onClick={() => act('complete')}>Complete</button>}
            </span>
          )}
        </div>
        {importResult?.error && <div className="alert">{importResult.error}</div>}
        <div className="grid grid-4">
          <Stat label="Calls" value={data.calls} />
          <Stat label="Connect rate" value={percent(data.connectRate)} />
          <Stat label="Avg talk time" value={duration(data.averageTalkTime)} />
          <Stat label="Conversions" value={data.conversions} />
        </div>
        <div className="row">{Object.entries(data.contactsByStatus).map(([k, v]) => <span key={k} className="badge">{label(k)}: {v}</span>)}</div>
        {can('campaigns:manage') && (
          <Field label="Import contacts (one per line: name, phone — or just phone)">
            <textarea className="input" rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'Rahul Sharma, 9876543210\n9811111111'} />
            <div className="row" style={{ marginTop: 6 }}>
              <button type="button" className="btn btn-sm" disabled={!csv.trim()} onClick={importRows}>Import</button>
              {importResult && !importResult.error && <span className="small muted">Added {importResult.added} · invalid {importResult.invalid} · DNC {importResult.dnc} · duplicates {importResult.duplicates}</span>}
            </div>
          </Field>
        )}
        <DataTable
          rows={contacts.data?.items}
          empty="No contacts in this campaign."
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'phone', label: 'Phone', render: (x) => <span className="mono">{x.phone}</span> },
            { key: 'status', label: 'Status', render: (x) => <StatusBadge status={x.status} /> },
            { key: 'attempts', label: 'Attempts' },
            { key: 'lastDisposition', label: 'Last disposition', render: (x) => label(x.lastDisposition) || '—' },
          ]}
        />
      </div>
    </Modal>
  );
}

export function Campaigns() {
  const { can } = useAuth();
  const { data, error, reload } = useAsync(() => get('/call-campaigns'), []);
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);
  const blank = {
    name: '', mode: 'preview', agentIds: [], schedule: { timezone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5], start: '10:00', end: '18:00' },
    retryPolicy: { maxAttempts: 3, retryDelayMinutes: 60 }, dispositionRules: [], predictive: { enabled: false, complianceAcknowledged: false },
  };
  return (
    <div className="stack">
      <div className="row">
        <span className="muted">Outbound calling campaigns with preview, power and predictive dialing.</span>
        {can('campaigns:manage') && <button type="button" className="btn btn-primary right" onClick={() => setEditing(blank)}>+ New campaign</button>}
      </div>
      <ErrorAlert error={error} />
      <div className="card">
        <DataTable
          rows={data?.items}
          empty="No campaigns yet."
          onRowClick={(c) => setDetail(c.id)}
          columns={[
            { key: 'name', label: 'Campaign' },
            { key: 'mode', label: 'Mode', render: (c) => label(c.mode) },
            { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status} /> },
            { key: 'progress', label: 'Progress', render: (c) => `${c.stats.completed}/${c.stats.total}` },
            { key: 'connected', label: 'Connected', render: (c) => c.stats.connected },
            { key: 'converted', label: 'Converted', render: (c) => c.stats.converted },
            { key: 'edit', label: '', render: (c) => can('campaigns:manage') && <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setEditing({ ...blank, ...c }); }}>Edit</button> },
          ]}
        />
      </div>
      {editing && <CampaignEditor initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {detail && <CampaignDetail id={detail} onClose={() => { setDetail(null); reload(); }} />}
    </div>
  );
}
