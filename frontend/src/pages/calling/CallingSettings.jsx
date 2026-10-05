import { useEffect, useState } from 'react';
import { del, get, patch, post, put } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { dateTime, label } from '../../lib/format.js';
import { DataTable, ErrorAlert, Field, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';

const SECRET = /token|secret|pass|key/i;

/** Credential form for one provider; secrets are write-only (never shown again after saving). */
export function IntegrationCard({ kind, provider, fields, existing, onSaved }) {
  const [values, setValues] = useState({});
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(false);
  const save = async () => {
    setError(null);
    setOk(false);
    try {
      const credentials = Object.keys(values).length ? values : undefined;
      await put(`/integrations/${kind}/${provider}`, { credentials, enabled, makeDefault: true });
      setValues({});
      setOk(true);
      onSaved?.();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="card" style={{ boxShadow: 'none' }}>
      <div className="card-header">
        <strong>{label(provider)}</strong>
        {!existing && <span className="badge">Not connected</span>}
        {existing && existing.readable === false && <StatusBadge status="failed" text="Re-enter credentials" />}
        {existing && existing.readable !== false && <StatusBadge status={existing.enabled ? 'active' : 'paused'} text={existing.enabled ? 'Connected' : 'Disabled'} />}
      </div>
      <div className="card-body stack">
        <ErrorAlert error={error} />
        {ok && <div className="alert alert-info">Saved. Credentials are encrypted at rest.</div>}
        {existing?.readable === false && <div className="alert alert-warning small">The saved credentials can’t be read any more (the server encryption key changed). Fill in every field and save again.</div>}
        <div className="form-grid">
          {fields.map((f) => (
            <Field key={f} label={f}>
              <input className="input" type={SECRET.test(f) ? 'password' : 'text'} autoComplete="off" placeholder={existing && existing.readable !== false ? '•••••• (unchanged)' : ''} value={values[f] || ''} onChange={(e) => setValues({ ...values, [f]: e.target.value })} />
            </Field>
          ))}
        </div>
        <div className="row">
          <label className="checkbox"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
          <button type="button" className="btn btn-primary right" disabled={!existing && !Object.keys(values).length} onClick={save}>Save</button>
          {existing && <button type="button" className="btn" onClick={async () => { await del(`/integrations/${kind}/${provider}`); onSaved?.(); }}>Disconnect</button>}
        </div>
      </div>
    </div>
  );
}

function SettingsSection({ title, children }) {
  return (
    <div className="card">
      <div className="card-header"><h3>{title}</h3></div>
      <div className="card-body stack">{children}</div>
    </div>
  );
}

export function CallingSettings() {
  const { can } = useAuth();
  const org = useAsync(() => get('/organization'), []);
  const integrations = useAsync(() => get('/integrations'), []);
  const dispositions = useAsync(() => get('/call-dispositions', { all: 1 }), []);
  const dnc = useAsync(() => (can('compliance:manage') ? get('/compliance/dnc') : Promise.resolve({ items: [] })), []);
  const alerts = useAsync(() => (can('alerts:read') ? get('/alerts') : Promise.resolve({ items: [] })), []);
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [newDispo, setNewDispo] = useState({ code: '', label: '', isConversion: false });
  const [dncInput, setDncInput] = useState('');
  const [customStatus, setCustomStatus] = useState({ key: '', label: '', available: false });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seed the editable copy once settings load
    if (org.data) setS(org.data.settings);
  }, [org.data]);
  if (!s) return <ErrorAlert error={org.error} />;
  const set = (section, key, value) => setS({ ...s, [section]: { ...s[section], [key]: value } });

  const saveSettings = async () => {
    setError(null);
    setSaved(false);
    try {
      await patch('/organization/settings', {
        recording: s.recording, transcription: s.transcription, compliance: s.compliance, fraud: s.fraud,
        wrapUpSeconds: s.wrapUpSeconds, defaultCountryCode: s.defaultCountryCode, timezone: s.timezone, customAgentStatuses: s.customAgentStatuses,
      });
      setSaved(true);
    } catch (e) {
      setError(e);
    }
  };

  const available = integrations.data?.available || {};
  const existing = (kind, provider) => integrations.data?.items?.find((i) => i.kind === kind && i.provider === provider);
  const webhookBase = `${integrations.data?.publicBaseUrl || window.location.origin}/api/v1/webhooks`;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <SettingsSection title="Telephony provider">
        <p className="muted small" style={{ margin: 0 }}>Calls only work with a real provider account. Credentials are encrypted and never shown again. Active provider: <strong>{s.telephonyProvider || 'none'}</strong>.</p>
        <div className="grid grid-3">
          {Object.entries(available.telephony || {}).map(([p, fields]) => (
            <IntegrationCard key={p} kind="telephony" provider={p} fields={fields} existing={existing('telephony', p)} onSaved={() => { integrations.reload(); org.reload(); }} />
          ))}
        </div>
        <div className="small muted">
          Point your provider’s webhooks to <code>{webhookBase}/telephony/&lt;provider&gt;?evt=voice</code> (incoming calls) and messaging to <code>{webhookBase}/messaging/&lt;provider&gt;</code>. {webhookBase.includes('localhost') ? <>Set <code>PUBLIC_BASE_URL</code> on the server to your public HTTPS address — providers can’t reach localhost.</> : null}
        </div>
      </SettingsSection>

      <SettingsSection title="Messaging, email & AI providers">
        <div className="grid grid-3">
          {['sms', 'whatsapp', 'email', 'ai', 'transcription'].flatMap((kind) => Object.entries(available[kind] || {}).map(([p, fields]) => (
            <div key={`${kind}-${p}`} className="stack" style={{ gap: 4 }}>
              <span className="small muted">{label(kind)}</span>
              <IntegrationCard kind={kind} provider={p} fields={fields} existing={existing(kind, p)} onSaved={() => { integrations.reload(); org.reload(); }} />
            </div>
          )))}
        </div>
      </SettingsSection>

      <SettingsSection title="Recording & consent">
        <label className="checkbox"><input type="checkbox" checked={Boolean(s.recording.enabled)} onChange={(e) => set('recording', 'enabled', e.target.checked)} /> Record calls (provider-side, only where legally permitted)</label>
        <div className="form-grid">
          <Field label="Consent announcement">
            <select className="input" value={s.recording.consentMode} onChange={(e) => set('recording', 'consentMode', e.target.value)}>
              <option value="always">Always announce</option>
              <option value="conditional">Announce when recording</option>
              <option value="disabled">Disabled</option>
            </select>
          </Field>
          <Field label="Delete recordings after">
            <select className="input" value={s.recording.retentionDays || ''} onChange={(e) => set('recording', 'retentionDays', e.target.value ? Number(e.target.value) : null)}>
              {[30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
              <option value="">Never</option>
            </select>
          </Field>
          <Field label="Message (English)"><input className="input" value={s.recording.consentMessage?.en || ''} onChange={(e) => set('recording', 'consentMessage', { ...s.recording.consentMessage, en: e.target.value })} /></Field>
          <Field label="Message (Hindi)"><input className="input" value={s.recording.consentMessage?.hi || ''} onChange={(e) => set('recording', 'consentMessage', { ...s.recording.consentMessage, hi: e.target.value })} /></Field>
        </div>
        <label className="checkbox"><input type="checkbox" checked={Boolean(s.transcription.enabled)} onChange={(e) => set('transcription', 'enabled', e.target.checked)} /> Transcribe recordings (needs a transcription provider)</label>
        <label className="checkbox"><input type="checkbox" checked={s.transcription.autoSummary !== false} onChange={(e) => set('transcription', 'autoSummary', e.target.checked)} /> AI call summary (needs an AI provider)</label>
        <label className="checkbox"><input type="checkbox" checked={s.transcription.autoCreateTasks !== false} onChange={(e) => set('transcription', 'autoCreateTasks', e.target.checked)} /> Create tasks from AI action items</label>
      </SettingsSection>

      <SettingsSection title="Compliance">
        <label className="checkbox"><input type="checkbox" checked={s.compliance.respectDnc !== false} onChange={(e) => set('compliance', 'respectDnc', e.target.checked)} /> Block calls to Do-Not-Call numbers and opted-out customers</label>
        <label className="checkbox"><input type="checkbox" checked={Boolean(s.compliance.maskNumbers)} onChange={(e) => set('compliance', 'maskNumbers', e.target.checked)} /> Mask customer numbers for agents</label>
        <label className="checkbox"><input type="checkbox" checked={Boolean(s.compliance.callingHours?.enabled)} onChange={(e) => set('compliance', 'callingHours', { ...s.compliance.callingHours, enabled: e.target.checked })} /> Restrict outbound calling hours</label>
        {s.compliance.callingHours?.enabled && (
          <div className="row">
            <Field label="From"><input className="input" type="time" value={s.compliance.callingHours.start} onChange={(e) => set('compliance', 'callingHours', { ...s.compliance.callingHours, start: e.target.value })} /></Field>
            <Field label="To"><input className="input" type="time" value={s.compliance.callingHours.end} onChange={(e) => set('compliance', 'callingHours', { ...s.compliance.callingHours, end: e.target.value })} /></Field>
          </div>
        )}
        <Field label="Delete call logs after (days, empty = keep)"><input className="input" style={{ width: 160 }} type="number" min="1" value={s.compliance.callLogRetentionDays || ''} onChange={(e) => set('compliance', 'callLogRetentionDays', e.target.value ? Number(e.target.value) : null)} /></Field>
      </SettingsSection>

      <SettingsSection title="Fraud & abuse limits">
        <div className="grid grid-4">
          {[['callsPerMinute', 'Calls / minute / agent'], ['callsPerHour', 'Calls / hour / agent'], ['dailyLimit', 'Daily calls / agent'], ['maxConcurrent', 'Max concurrent calls'], ['maxDurationSeconds', 'Max call duration (s)'], ['failedCallThreshold', 'Failed calls alert (10 min)']].map(([k, l]) => (
            <Field key={k} label={l}><input className="input" type="number" min="1" value={s.fraud[k] ?? ''} onChange={(e) => set('fraud', k, Number(e.target.value))} /></Field>
          ))}
          <Field label="Allowed country codes"><input className="input" value={(s.fraud.allowedCountryCodes || []).join(', ')} onChange={(e) => set('fraud', 'allowedCountryCodes', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} /></Field>
        </div>
        <label className="checkbox"><input type="checkbox" checked={s.fraud.blockUnexpectedInternational !== false} onChange={(e) => set('fraud', 'blockUnexpectedInternational', e.target.checked)} /> Block calls to other countries</label>
      </SettingsSection>

      <SettingsSection title="Agents">
        <div className="row">
          <Field label="Wrap-up time (seconds)"><input className="input" style={{ width: 140 }} type="number" min="0" value={s.wrapUpSeconds} onChange={(e) => setS({ ...s, wrapUpSeconds: Number(e.target.value) })} /></Field>
          <Field label="Default country code"><input className="input" style={{ width: 120 }} value={s.defaultCountryCode} onChange={(e) => setS({ ...s, defaultCountryCode: e.target.value })} /></Field>
          <Field label="Time zone"><input className="input" style={{ width: 180 }} value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} /></Field>
        </div>
        <div className="row">{(s.customAgentStatuses || []).map((c) => <span key={c.key} className="badge">{c.label}{c.available ? ' (available)' : ''} <button type="button" className="btn btn-ghost btn-sm" onClick={() => setS({ ...s, customAgentStatuses: s.customAgentStatuses.filter((x) => x.key !== c.key) })}>✕</button></span>)}</div>
        <div className="row">
          <input className="input" style={{ width: 180 }} placeholder="Custom status (e.g. Training)" value={customStatus.label} onChange={(e) => setCustomStatus({ ...customStatus, label: e.target.value, key: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_') })} />
          <label className="checkbox small"><input type="checkbox" checked={customStatus.available} onChange={(e) => setCustomStatus({ ...customStatus, available: e.target.checked })} /> Can take calls</label>
          <button type="button" className="btn btn-sm" disabled={!customStatus.key} onClick={() => { setS({ ...s, customAgentStatuses: [...(s.customAgentStatuses || []), customStatus] }); setCustomStatus({ key: '', label: '', available: false }); }}>Add status</button>
        </div>
      </SettingsSection>

      <div className="row">
        <ErrorAlert error={error} />
        {saved && <span className="badge badge-success">Settings saved</span>}
        <button type="button" className="btn btn-primary right" onClick={saveSettings}>Save settings</button>
      </div>

      <SettingsSection title="Call dispositions">
        <DataTable
          rows={dispositions.data?.items}
          columns={[
            { key: 'label', label: 'Disposition' },
            { key: 'code', label: 'Code', render: (d) => <code>{d.code}</code> },
            { key: 'isConversion', label: 'Counts as conversion', render: (d) => (d.isConversion ? 'Yes' : '') },
            { key: 'active', label: 'Active', render: (d) => <input type="checkbox" checked={d.active} onChange={async (e) => { await patch(`/call-dispositions/${d.id}`, { active: e.target.checked }); dispositions.reload(); }} aria-label={`Active ${d.label}`} /> },
          ]}
        />
        <div className="row">
          <input className="input" style={{ width: 200 }} placeholder="Label" value={newDispo.label} onChange={(e) => setNewDispo({ ...newDispo, label: e.target.value, code: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_') })} />
          <label className="checkbox small"><input type="checkbox" checked={newDispo.isConversion} onChange={(e) => setNewDispo({ ...newDispo, isConversion: e.target.checked })} /> Conversion</label>
          <button type="button" className="btn btn-sm" disabled={!newDispo.code} onClick={async () => { await post('/call-dispositions', newDispo); setNewDispo({ code: '', label: '', isConversion: false }); dispositions.reload(); }}>Add disposition</button>
        </div>
      </SettingsSection>

      {can('compliance:manage') && (
        <SettingsSection title="Do-Not-Call list">
          <div className="row">
            <textarea className="input" rows={2} style={{ maxWidth: 420 }} placeholder="Numbers, one per line" value={dncInput} onChange={(e) => setDncInput(e.target.value)} />
            <button type="button" className="btn btn-sm" disabled={!dncInput.trim()} onClick={async () => { await post('/compliance/dnc', { phones: dncInput.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean), reason: 'Manual' }); setDncInput(''); dnc.reload(); }}>Add</button>
          </div>
          <DataTable rows={dnc.data?.items} empty="DNC list is empty." columns={[
            { key: 'phone', label: 'Number', render: (d) => <span className="mono">{d.phone}</span> },
            { key: 'source', label: 'Source', render: (d) => label(d.source) },
            { key: 'reason', label: 'Reason' },
            { key: 'createdAt', label: 'Added', render: (d) => dateTime(d.createdAt) },
            { key: 'rm', label: '', render: (d) => <button type="button" className="btn btn-sm" onClick={async () => { await del(`/compliance/dnc/${d.id}`); dnc.reload(); }}>Remove</button> },
          ]} />
        </SettingsSection>
      )}

      {can('alerts:read') && (
        <SettingsSection title="Fraud & security alerts">
          <DataTable rows={alerts.data?.items} empty="No alerts." columns={[
            { key: 'createdAt', label: 'When', render: (a) => dateTime(a.createdAt) },
            { key: 'severity', label: 'Severity', render: (a) => <StatusBadge status={a.severity === 'critical' ? 'failed' : a.severity === 'warning' ? 'pending' : 'sent'} text={a.severity} /> },
            { key: 'message', label: 'Alert' },
            { key: 'ack', label: '', render: (a) => !a.acknowledged && <button type="button" className="btn btn-sm" onClick={async () => { await post(`/alerts/${a.id}/ack`); alerts.reload(); }}>Acknowledge</button> },
          ]} />
        </SettingsSection>
      )}
    </div>
  );
}
