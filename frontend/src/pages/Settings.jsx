import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, patch, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { dateTime, label } from '../lib/format.js';
import { DataTable, ErrorAlert, Field, Loading, Modal, Tabs } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { CompanySettings } from './CompanySettings.jsx';
import { phoneChars, validateForm } from '../lib/validation.js';
import { useValidation } from '../lib/useValidation.js';

function Templates() {
  const { data, reload } = useAsync(() => get('/message-templates'), []);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const v = useValidation([
    { key: 'name', label: 'Name', required: true, maxLength: 80 },
    { key: 'language', label: 'Language', maxLength: 10 },
    form?.channel === 'whatsapp' && { key: 'providerTemplateName', label: 'Approved template name', required: true, maxLength: 120 },
    form?.channel === 'email' && { key: 'subject', label: 'Subject', required: true, maxLength: 200 },
    { key: 'body', label: 'Body', type: 'textarea', required: true, maxLength: form?.channel === 'sms' ? 1000 : 4096 },
  ], form);
  const close = () => { setForm(null); v.reset(); };
  const save = async () => {
    if (!v.check()) return;
    setError(null);
    try {
      const body = { name: form.name, channel: form.channel, body: form.body, subject: form.subject, language: form.language, providerTemplateName: form.providerTemplateName || undefined };
      if (form.id) await patch(`/message-templates/${form.id}`, body);
      else await post('/message-templates', body);
      close();
      reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="stack">
      <div className="row"><span className="muted">{'Use {{variables}} in templates. WhatsApp templates must be approved by Meta first.'}</span><button type="button" className="btn btn-primary right" onClick={() => setForm({ channel: 'sms', language: 'en' })}>+ New template</button></div>
      <div className="card">
        <DataTable rows={data?.items} empty="No templates." onRowClick={setForm} columns={[
          { key: 'name', label: 'Name' }, { key: 'channel', label: 'Channel', render: (t) => label(t.channel) }, { key: 'language', label: 'Language' },
          { key: 'body', label: 'Body', render: (t) => <span className="muted">{t.body.slice(0, 80)}</span> },
        ]} />
      </div>
      {form && (
        <Modal title={form.id ? form.name : 'New template'} onClose={close} footer={<><button type="button" className="btn" onClick={close}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
          <ErrorAlert error={error} />
          <div className="form-grid">
            <Field label="Name" required error={v.errors.name}><input className="input" aria-invalid={Boolean(v.errors.name)} value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Channel"><select className="input" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>{['sms', 'whatsapp', 'email'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
            <Field label="Language" error={v.errors.language}><input className="input" aria-invalid={Boolean(v.errors.language)} value={form.language || ''} onChange={(e) => setForm({ ...form, language: e.target.value })} /></Field>
            {form.channel === 'whatsapp' && <Field label="Approved template name" required error={v.errors.providerTemplateName}><input className="input" aria-invalid={Boolean(v.errors.providerTemplateName)} value={form.providerTemplateName || ''} onChange={(e) => setForm({ ...form, providerTemplateName: e.target.value })} /></Field>}
            {form.channel === 'email' && <Field label="Subject" required className="full" error={v.errors.subject}><input className="input" aria-invalid={Boolean(v.errors.subject)} value={form.subject || ''} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>}
            <Field label="Body" required className="full" error={v.errors.body}><textarea className="input" rows={5} aria-invalid={Boolean(v.errors.body)} value={form.body || ''} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function WebChat() {
  const { organization } = useAuth();
  const origin = window.location.origin.replace(':5173', ':5000');
  const snippet = `<script>
  // Minimal COGNIEOS web chat client: POST messages, poll replies.
  const KEY = '${organization.publicChatKey}';
  const API = '${origin}/api/v1/webchat/' + KEY + '/messages';
  const visitorId = localStorage.visitorId || (localStorage.visitorId = crypto.randomUUID());
  async function sendChat(body, name) {
    await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId, body, name }) });
  }
  async function pollChat(since) {
    const r = await fetch(API + '?visitorId=' + visitorId + (since ? '&since=' + since : ''));
    return (await r.json()).items;
  }
</script>`;
  return (
    <div className="card"><div className="card-body stack">
      <p className="muted" style={{ margin: 0 }}>Web chat messages appear in the unified inbox. Embed this on your website:</p>
      <pre className="card" style={{ padding: 12, overflowX: 'auto', boxShadow: 'none' }}><code>{snippet}</code></pre>
    </div></div>
  );
}

function AuditLog() {
  const { data, error } = useAsync(() => get('/audit-logs', { limit: 200 }), []);
  return (
    <div className="card">
      <ErrorAlert error={error} />
      <DataTable rows={data?.items} columns={[
        { key: 'createdAt', label: 'When', render: (a) => dateTime(a.createdAt) },
        { key: 'user', label: 'User', render: (a) => a.userId?.name || '—' },
        { key: 'action', label: 'Action', render: (a) => <code>{a.action}</code> },
        { key: 'resource', label: 'Resource', render: (a) => (a.resourceType ? `${a.resourceType} ${a.resourceId || ''}` : '—') },
        { key: 'ip', label: 'IP' },
      ]} />
    </div>
  );
}

// [key, label, input type, rule] — rules use the shared validation (lib/validation.js)
const BILLING_FIELDS = [
  ['companyName', 'Legal company name', 'text', { maxLength: 150 }], ['gstin', 'GSTIN', 'text', { format: 'gstin' }],
  ['state', 'State (place of business)', 'text', { maxLength: 60 }], ['pan', 'PAN', 'text', { format: 'pan' }],
  ['email', 'Billing email', 'email', { type: 'email' }], ['phone', 'Billing phone', 'tel', { type: 'phone' }],
  ['logoUrl', 'Logo URL (https)', 'url', { format: 'https', maxLength: 500 }], ['upiId', 'UPI ID (shown on invoices)', 'text', { format: 'upi' }],
];
const BANK_FIELDS = [
  ['bankName', 'Bank name', 'text', { maxLength: 100 }], ['branch', 'Branch', 'text', { maxLength: 100 }], ['accountName', 'Account name', 'text', { maxLength: 150 }],
  ['accountNumber', 'Account number', 'text', { format: 'bankAccount' }], ['ifsc', 'IFSC', 'text', { format: 'ifsc' }],
];
const DEFAULT_FIELDS = [
  ['quotePrefix', 'Quotation number prefix', 'text', { maxLength: 12 }], ['invoicePrefix', 'Invoice number prefix', 'text', { maxLength: 12 }],
  ['currency', 'Currency', 'text', { maxLength: 5 }],
  ['quoteValidityDays', 'Quotation valid for (days)', 'number', { type: 'number', integer: true, min: 1, max: 365 }],
  ['paymentTermsDays', 'Payment terms (days)', 'number', { type: 'number', integer: true, min: 0, max: 365 }],
  ['defaultTaxRate', 'Default GST %', 'number', { type: 'number', min: 0, max: 28 }],
];
const rules = (list) => list.map(([key, text, , rule]) => ({ key, label: text, ...rule }));
const TEXT_RULES = [
  { key: 'address', label: 'Address', type: 'textarea', maxLength: 500 },
  { key: 'defaultNotes', label: 'Default notes', type: 'textarea' },
  { key: 'defaultTerms', label: 'Default terms', type: 'textarea' },
];

function Billing() {
  const { can } = useAuth();
  const { data, error, reload } = useAsync(() => get('/sales/settings'), []);
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
  const value = form || data;
  if (error) return <ErrorAlert error={error} />;
  if (!value) return <Loading />;
  const editable = can('settings:manage');
  const set = (k, v) => { setSaved(false); setForm({ ...value, [k]: v }); };
  const setBank = (k, v) => { setSaved(false); setForm({ ...value, bank: { ...value.bank, [k]: v } }); };
  const allErrors = {
    ...validateForm([...rules(BILLING_FIELDS), ...rules(DEFAULT_FIELDS), ...TEXT_RULES], value),
    ...Object.fromEntries(Object.entries(validateForm(rules(BANK_FIELDS), value.bank || {})).map(([k, m]) => [`bank.${k}`, m])),
  };
  const errors = showErrors ? allErrors : {};
  const save = async () => {
    setSaveError(null);
    if (Object.keys(allErrors).length) {
      setShowErrors(true);
      return setSaveError(new Error('Please fix the highlighted fields.'));
    }
    setShowErrors(false);
    try {
      await patch('/organization/settings', { billing: value });
      setSaved(true);
      setForm(null);
      reload();
    } catch (e) {
      setSaveError(e);
    }
  };
  const input = (k, l, type, val, onChange, errorKey = k) => (
    <Field key={k} label={l} error={errors[errorKey]}>
      <input className="input" type={type || 'text'} disabled={!editable} aria-invalid={Boolean(errors[errorKey])} value={val ?? ''} maxLength={type === 'tel' ? 20 : undefined} onChange={(e) => onChange(k, type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : type === 'tel' ? phoneChars(e.target.value) : e.target.value)} />
    </Field>
  );
  return (
    <div className="stack" style={{ gap: 16 }}>
      {!editable && <div className="alert alert-info">Only admins can change billing settings.</div>}
      <ErrorAlert error={saveError} />
      <div className="card">
        <div className="card-header"><h3>Company details on quotations &amp; invoices</h3></div>
        <div className="card-body form-grid">
          {BILLING_FIELDS.map(([k, l, t]) => input(k, l, t, value[k], set))}
          <Field label="Address" className="full" error={errors.address}><textarea className="input" aria-invalid={Boolean(errors.address)} disabled={!editable} value={value.address || ''} onChange={(e) => set('address', e.target.value)} /></Field>
          <p className="small muted full" style={{ margin: 0 }}>GST: customers in the same state (or GSTIN state code) are charged CGST + SGST, others IGST.</p>
        </div>
      </div>
      <div className="card">
        <div className="card-header"><h3>Bank details (printed on invoices)</h3></div>
        <div className="card-body form-grid">{BANK_FIELDS.map(([k, l, t]) => input(k, l, t, value.bank?.[k], setBank, `bank.${k}`))}</div>
      </div>
      <div className="card">
        <div className="card-header"><h3>Numbering &amp; defaults</h3></div>
        <div className="card-body form-grid">
          {DEFAULT_FIELDS.map(([k, l, t]) => input(k, l, t, value[k], set))}
          <p className="small muted full" style={{ margin: 0 }}>Numbers restart every financial year (April–March), e.g. {value.invoicePrefix}/2026-27/0001. Invoices get their number only when issued, so there are no gaps.</p>
          <Field label="Default notes" className="full"><textarea className="input" disabled={!editable} value={value.defaultNotes || ''} onChange={(e) => set('defaultNotes', e.target.value)} /></Field>
          <Field label="Default terms & conditions" className="full"><textarea className="input" disabled={!editable} value={value.defaultTerms || ''} onChange={(e) => set('defaultTerms', e.target.value)} /></Field>
        </div>
      </div>
      {editable && (
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={!form} onClick={save}>Save billing settings</button>
          {saved && <span className="small muted">Saved ✓</span>}
        </div>
      )}
    </div>
  );
}

export function Settings() {
  const { can } = useAuth();
  const tabs = [
    { key: 'company', label: 'Company' },
    { key: 'billing', label: 'Invoice details' },
    { key: 'templates', label: 'Message templates' },
    { key: 'webchat', label: 'Web chat' },
    ...(can('audit:read') ? [{ key: 'audit', label: 'Audit log' }] : []),
  ];
  const [tab, setTab] = useState('company');
  return (
    <>
      <div className="page-header">
        <div><h1>Settings</h1><p>Users and roles are under <Link to="/team">Team</Link>; your plan under <Link to="/billing">Billing</Link>; telephony in <Link to="/calling?tab=settings">Calling → Settings</Link>.</p></div>
      </div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'company' && <CompanySettings />}
      {tab === 'billing' && <Billing />}
      {tab === 'templates' && <Templates />}
      {tab === 'webchat' && <WebChat />}
      {tab === 'audit' && <AuditLog />}
    </>
  );
}
