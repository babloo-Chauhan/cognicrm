import { useState } from 'react';
import { get, patch, post } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { duration, label } from '../../lib/format.js';
import { DataTable, ErrorAlert, Field, Modal, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';

const STRATEGIES = ['round_robin', 'least_busy', 'longest_idle', 'ring_all', 'random'];
const FALLBACKS = ['voicemail', 'hangup', 'external', 'callback'];
const QUEUE_FIELDS = ['name', 'description', 'departmentId', 'strategy', 'maxWaitTime', 'music', 'positionAnnouncement', 'overflow', 'fallback', 'active'];

function QueueForm({ value, onChange, users, queues, departments }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const agentIds = new Set((value.agents || []).map((a) => a.userId));
  return (
    <div className="form-grid">
      <Field label="Name"><input className="input" value={value.name || ''} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label="Department">
        <select className="input" value={value.departmentId || ''} onChange={(e) => set('departmentId', e.target.value || null)}>
          <option value="">—</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>
      <Field label="Description" className="full"><input className="input" value={value.description || ''} onChange={(e) => set('description', e.target.value)} /></Field>
      <Field label="Strategy">
        <select className="input" value={value.strategy || 'longest_idle'} onChange={(e) => set('strategy', e.target.value)}>
          {STRATEGIES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
      </Field>
      <Field label="Max wait (seconds)"><input className="input" type="number" min="10" value={value.maxWaitTime ?? 300} onChange={(e) => set('maxWaitTime', Number(e.target.value))} /></Field>
      <Field label="Hold music URL"><input className="input" value={value.music || ''} onChange={(e) => set('music', e.target.value)} placeholder="https://…" /></Field>
      <label className="checkbox"><input type="checkbox" checked={value.positionAnnouncement ?? true} onChange={(e) => set('positionAnnouncement', e.target.checked)} /> Announce queue position</label>
      <Field label="Overflow to queue">
        <select className="input" value={value.overflow?.queueId || ''} onChange={(e) => set('overflow', { ...(value.overflow || {}), queueId: e.target.value || null })}>
          <option value="">—</option>
          {queues.filter((q) => q.id !== value.id).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
        </select>
      </Field>
      <Field label="Overflow after (seconds)"><input className="input" type="number" value={value.overflow?.afterSeconds ?? ''} onChange={(e) => set('overflow', { ...(value.overflow || {}), afterSeconds: e.target.value ? Number(e.target.value) : undefined })} /></Field>
      <Field label="Fallback">
        <select className="input" value={value.fallback?.action || 'voicemail'} onChange={(e) => set('fallback', { ...(value.fallback || {}), action: e.target.value })}>
          {FALLBACKS.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
      </Field>
      {value.fallback?.action === 'external' && <Field label="Fallback number"><input className="input" value={value.fallback?.target || ''} onChange={(e) => set('fallback', { ...value.fallback, target: e.target.value })} /></Field>}
      <Field label="Agents" className="full">
        <div className="row">
          {users.map((u) => (
            <label key={u.id} className="checkbox badge">
              <input type="checkbox" checked={agentIds.has(u.id)} onChange={(e) => set('agents', e.target.checked ? [...(value.agents || []), { userId: u.id, priority: 0 }] : value.agents.filter((a) => a.userId !== u.id))} />
              {u.name}
            </label>
          ))}
        </div>
      </Field>
    </div>
  );
}

export function Queues() {
  const { can } = useAuth();
  const { data, error, reload } = useAsync(() => get('/call-queues'), []);
  const users = useAsync(() => get('/users'), []);
  const departments = useAsync(() => get('/departments'), []);
  const [editing, setEditing] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [deptName, setDeptName] = useState('');

  const save = async () => {
    setSaveError(null);
    const { id } = editing;
    const body = Object.fromEntries(QUEUE_FIELDS.filter((k) => editing[k] !== undefined).map((k) => [k, editing[k]]));
    body.agents = (editing.agents || []).map((a) => ({ userId: a.userId, priority: a.priority || 0 }));
    if (!body.music) delete body.music;
    try {
      if (id) await patch(`/call-queues/${id}`, body);
      else await post('/call-queues', body);
      setEditing(null);
      reload();
    } catch (e) {
      setSaveError(e);
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <span className="muted">Queues hold callers until an agent is free, using the selected strategy.</span>
        {can('queues:manage') && <button type="button" className="btn btn-primary right" onClick={() => setEditing({ strategy: 'longest_idle', maxWaitTime: 300, positionAnnouncement: true, agents: [] })}>+ New queue</button>}
      </div>
      <ErrorAlert error={error} />
      <div className="card">
        <DataTable
          rows={data?.items}
          empty="No queues yet."
          onRowClick={can('queues:manage') ? (q) => setEditing(q) : undefined}
          columns={[
            { key: 'name', label: 'Queue' },
            { key: 'strategy', label: 'Strategy', render: (q) => label(q.strategy) },
            { key: 'agents', label: 'Agents', render: (q) => `${q.agentsAvailable}/${q.agents.length} available` },
            { key: 'waiting', label: 'Waiting', render: (q) => q.stats.waitingCalls },
            { key: 'avg', label: 'Avg wait (24h)', render: (q) => duration(q.stats.averageWait) },
            { key: 'abandoned', label: 'Abandoned (24h)', render: (q) => q.stats.abandonedCalls },
            { key: 'active', label: 'Status', render: (q) => <StatusBadge status={q.active ? 'active' : 'paused'} /> },
          ]}
        />
      </div>
      {can('queues:manage') && (
        <div className="card">
          <div className="card-header"><h3>Departments</h3></div>
          <div className="card-body stack">
            <div className="row">{departments.data?.items?.map((d) => <span key={d.id} className="badge">{d.name}</span>)}</div>
            <div className="row">
              <input className="input" style={{ width: 240 }} placeholder="New department" value={deptName} onChange={(e) => setDeptName(e.target.value)} />
              <button type="button" className="btn" disabled={!deptName} onClick={async () => { await post('/departments', { name: deptName }); setDeptName(''); departments.reload(); }}>Add</button>
            </div>
          </div>
        </div>
      )}
      {editing && (
        <Modal title={editing.id ? 'Edit queue' : 'New queue'} size="lg" onClose={() => setEditing(null)} footer={<><button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
          <ErrorAlert error={saveError} />
          <QueueForm value={editing} onChange={setEditing} users={users.data?.items || []} queues={data?.items || []} departments={departments.data?.items || []} />
        </Modal>
      )}
    </div>
  );
}
