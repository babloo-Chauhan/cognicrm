import { useState } from 'react';
import { get, patch, post } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { label } from '../../lib/format.js';
import { DataTable, ErrorAlert, Field, Modal, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';
import { useCalls } from '../../calling/CallContext.jsx';

const ROUTING_FIELDS = ['label', 'assignedUserId', 'assignedTeamId', 'ivrFlowId', 'queueId', 'businessHoursId', 'isDefaultCallerId', 'status', 'capabilities'];

function NumberEditor({ initial, onClose, onSaved }) {
  const [n, setN] = useState(initial);
  const [error, setError] = useState(null);
  const users = useAsync(() => get('/users'), []);
  const queues = useAsync(() => get('/call-queues'), []);
  const flows = useAsync(() => get('/ivr'), []);
  const hours = useAsync(() => get('/business-hours'), []);
  const teams = useAsync(() => get('/departments'), []);
  const { capabilities } = useCalls();
  const set = (k, v) => setN({ ...n, [k]: v === '' ? null : v });
  const save = async () => {
    setError(null);
    try {
      if (n.id) await patch(`/phone-numbers/${n.id}`, Object.fromEntries(ROUTING_FIELDS.filter((k) => n[k] !== undefined).map((k) => [k, n[k]])));
      else await post('/phone-numbers', { ...n, provider: n.provider || capabilities?.provider || 'twilio' });
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  const select = (key, items, nameKey = 'name') => (
    <select className="input" value={n[key] || ''} onChange={(e) => set(key, e.target.value)}>
      <option value="">—</option>
      {items?.map((i) => <option key={i.id} value={i.id}>{i[nameKey]}</option>)}
    </select>
  );
  return (
    <Modal title={n.id ? n.number : 'Add phone number'} size="lg" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
      <ErrorAlert error={error} />
      <div className="form-grid">
        {!n.id && <Field label="Number (E.164)"><input className="input" value={n.number || ''} onChange={(e) => set('number', e.target.value)} placeholder="+9180…" /></Field>}
        {!n.id && <Field label="Provider"><input className="input" value={n.provider || capabilities?.provider || ''} onChange={(e) => set('provider', e.target.value)} /></Field>}
        <Field label="Label"><input className="input" value={n.label || ''} onChange={(e) => set('label', e.target.value)} /></Field>
        <Field label="Status"><select className="input" value={n.status || 'active'} onChange={(e) => set('status', e.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>
        <Field label="Assigned user">{select('assignedUserId', users.data?.items)}</Field>
        <Field label="Assigned team">{select('assignedTeamId', teams.data?.items)}</Field>
        <Field label="Inbound IVR">{select('ivrFlowId', flows.data?.items)}</Field>
        <Field label="Inbound queue (if no IVR)">{select('queueId', queues.data?.items)}</Field>
        <Field label="Business hours">{select('businessHoursId', hours.data?.items)}</Field>
        <Field label="Capabilities" className="full">
          <div className="row">
            {['voice', 'sms', 'whatsapp'].map((c) => (
              <label key={c} className="checkbox badge"><input type="checkbox" checked={Boolean(n.capabilities?.[c])} onChange={(e) => setN({ ...n, capabilities: { ...(n.capabilities || {}), [c]: e.target.checked } })} />{label(c)}</label>
            ))}
            <label className="checkbox badge"><input type="checkbox" checked={Boolean(n.isDefaultCallerId)} onChange={(e) => setN({ ...n, isDefaultCallerId: e.target.checked })} />Default caller ID</label>
          </div>
        </Field>
      </div>
      <p className="small muted">Routing: Business hours → IVR → Queue → Assigned user → Voicemail.</p>
    </Modal>
  );
}

export function PhoneNumbers() {
  const { can } = useAuth();
  const { capabilities } = useCalls();
  const { data, error, reload } = useAsync(() => get('/phone-numbers'), []);
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState(null);
  const [actionError, setActionError] = useState(null);
  const manage = can('numbers:manage');
  const provisioning = capabilities?.capabilities?.numberProvisioning;

  const searchNumbers = async () => {
    setActionError(null);
    try {
      setSearch((await get('/phone-numbers/available', { country: 'IN' })).items);
    } catch (e) {
      setActionError(e);
    }
  };
  const buy = async (number) => {
    if (!window.confirm(`Purchase ${number}? Your provider will bill you for it.`)) return;
    await post('/phone-numbers/provision', { number });
    setSearch(null);
    reload();
  };

  return (
    <div className="stack">
      <div className="row">
        <span className="muted">Numbers, caller IDs and inbound routing.</span>
        {manage && (
          <span className="row right">
            {provisioning && <button type="button" className="btn" onClick={searchNumbers}>Buy a number</button>}
            <button type="button" className="btn btn-primary" onClick={() => setEditing({ capabilities: { voice: true } })}>+ Add existing number</button>
          </span>
        )}
      </div>
      <ErrorAlert error={error || actionError} />
      <div className="card">
        <DataTable
          rows={data?.items}
          empty="No phone numbers. Add the numbers you own with your telephony provider."
          onRowClick={manage ? (n) => setEditing(n) : undefined}
          columns={[
            { key: 'number', label: 'Number', render: (n) => <span className="mono">{n.number}</span> },
            { key: 'label', label: 'Label' },
            { key: 'provider', label: 'Provider', render: (n) => label(n.provider) },
            { key: 'caps', label: 'Capabilities', render: (n) => Object.entries(n.capabilities || {}).filter(([, v]) => v).map(([k]) => label(k)).join(', ') },
            { key: 'routing', label: 'Routing', render: (n) => (n.ivrFlowId ? 'IVR' : n.queueId ? 'Queue' : n.assignedUserId ? 'User' : 'Voicemail') },
            { key: 'default', label: 'Caller ID', render: (n) => (n.isDefaultCallerId ? 'Default' : '') },
            { key: 'status', label: 'Status', render: (n) => <StatusBadge status={n.status} /> },
            {
              key: 'webhooks', label: '',
              render: (n) => manage && provisioning && n.providerNumberId && <button type="button" className="btn btn-sm" onClick={async (e) => { e.stopPropagation(); await post(`/phone-numbers/${n.id}/configure-webhooks`); }}>Sync webhooks</button>,
            },
          ]}
        />
      </div>
      {editing && <NumberEditor initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {search && (
        <Modal title="Available numbers" onClose={() => setSearch(null)}>
          <DataTable rows={search} empty="No numbers available." columns={[
            { key: 'number', label: 'Number' },
            { key: 'buy', label: '', render: (n) => <button type="button" className="btn btn-sm btn-primary" onClick={() => buy(n.number)}>Buy</button> },
          ]} />
        </Modal>
      )}
    </div>
  );
}
