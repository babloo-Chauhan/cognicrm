import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Copy, FileText, Globe, Megaphone, MessageCircle, Plus, RefreshCw, Search, ShoppingBag, Store,
} from 'lucide-react';
import { del, get, patch, post } from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { dateTime } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { useTeam } from '../lib/team.js';
import {
  ConfirmDialog, Empty, ErrorAlert, Field, Modal, Skeleton, StatusBadge,
} from '../components/ui.jsx';
import { Button } from '@/components/ui/button';

const TYPES = {
  webhook: { icon: Globe, title: 'Website / API', text: 'Your website’s contact form, Zapier, Pabbly, Make or a Google Sheet send leads to one address.' },
  form: { icon: FileText, title: 'Ready-made web form', text: 'A form page we host. Share the link, or embed it on your website.' },
  justdial: { icon: Search, title: 'Justdial', text: 'Justdial pushes each enquiry here the moment it comes.' },
  indiamart: { icon: ShoppingBag, title: 'IndiaMART', text: 'New enquiries are fetched every few minutes with your CRM key.' },
  meta: { icon: Megaphone, title: 'Facebook & Instagram', text: 'Leads from Meta lead ads arrive as soon as someone fills the form.' },
  google_ads: { icon: Store, title: 'Google Ads', text: 'Lead form assets on your Google ads send leads by webhook.' },
  whatsapp: { icon: MessageCircle, title: 'WhatsApp', text: 'The first message from a new number on your WhatsApp Business number becomes a lead.' },
};
const FORM_FIELDS = [
  { key: 'name', label: 'Name' }, { key: 'phone', label: 'Mobile number' }, { key: 'email', label: 'Email' },
  { key: 'company', label: 'Company' }, { key: 'city', label: 'City' }, { key: 'requirement', label: 'Requirement / message' },
];

function CopyField({ label: text, value, multiline }) {
  const copy = () => { navigator.clipboard?.writeText(value); toast('Copied'); };
  return (
    <div className="flex flex-col gap-1">
      {text && <span className="text-xs font-medium text-muted-foreground">{text}</span>}
      <div className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2">
        {multiline ? <pre className="m-0 max-h-48 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all text-xs">{value}</pre> : <code className="min-w-0 flex-1 break-all text-xs">{value}</code>}
        <Button variant="ghost" size="icon-sm" aria-label={`Copy ${text || ''}`} onClick={copy}><Copy /></Button>
      </div>
    </div>
  );
}

const Steps = ({ children }) => <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-sm">{children}</ol>;

function assignText(source, team) {
  const names = (source.assignUserIds || []).map((id) => team.find((u) => u.id === String(id))?.name).filter(Boolean);
  if (source.assignMode === 'none' || !names.length) return 'Nobody yet: the admin is told and assigns them';
  if (source.assignMode === 'user') return `All go to ${names[0]}`;
  return `Shared in turn: ${names.join(', ')}`;
}

/** How to connect each kind of source: the address to paste, and where to paste it. */
function SetupHelp({ source }) {
  const url = source.urls.webhook;
  switch (source.type) {
    case 'webhook': {
      const html = `<form action="${url}" method="POST">\n  <input name="name" placeholder="Your name" required>\n  <input name="phone" placeholder="Mobile number" required>\n  <input name="email" type="email" placeholder="Email">\n  <textarea name="message" placeholder="What do you need?"></textarea>\n  <input name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">\n  <button>Send</button>\n</form>`;
      const sheet = `// Google Sheet → Extensions → Apps Script. Run "setup" once.\nfunction setup() { ScriptApp.newTrigger('sendRow').forSpreadsheet(SpreadsheetApp.getActive()).onFormSubmit().create(); }\nfunction sendRow(e) {\n  UrlFetchApp.fetch('${url}', { method: 'post', contentType: 'application/json', payload: JSON.stringify(e.namedValues) });\n}`;
      return (
        <div className="stack">
          <CopyField label="Lead address (POST JSON or form data)" value={url} />
          <p className="m-0 text-sm text-muted-foreground">Send fields like <code>name</code>, <code>phone</code>, <code>email</code>, <code>company</code>, <code>message</code>. Common names (mobile, full_name, your-email, enquiry …) are understood; anything else is kept in the lead’s remarks.</p>
          <CopyField label="Plain HTML form for your website" value={html} multiline />
          <CopyField label="Google Sheets / Google Forms (Apps Script)" value={sheet} multiline />
          <p className="m-0 text-xs text-muted-foreground">Zapier, Pabbly, Make or LinkedIn lead sync tools: use a “Webhook / HTTP POST” step to the address above.</p>
        </div>
      );
    }
    case 'form':
      return (
        <div className="stack">
          <CopyField label="Form link: share on WhatsApp, Instagram bio, QR code at your shop" value={source.urls.form} />
          <CopyField label="Embed on your website" value={`<iframe src="${source.urls.form}?embed=1" style="width:100%;max-width:520px;height:620px;border:0"></iframe>`} multiline />
          <a className="text-sm" href={source.urls.form} target="_blank" rel="noreferrer">Open the form ↗</a>
        </div>
      );
    case 'justdial':
      return (
        <div className="stack">
          <CopyField label="Lead push URL" value={url} />
          <Steps>
            <li>Send this URL to your Justdial account manager (or support) and ask them to switch on <strong>Lead push / API integration</strong> for your listing.</li>
            <li>Justdial calls it for every new enquiry; we answer <code>RECEIVED</code>.</li>
            <li>Click <em>Send a test lead</em> below to see where leads land.</li>
          </Steps>
        </div>
      );
    case 'indiamart':
      return (
        <div className="stack">
          <Steps>
            <li>Sign in to IndiaMART <strong>Lead Manager</strong> → <strong>Settings</strong> (or Import/Export) → <strong>CRM Integration</strong> / Push API, and generate the <strong>CRM key</strong>.</li>
            <li>Paste it below and save. New enquiries are fetched every 6 minutes (IndiaMART allows one fetch per 5 minutes).</li>
          </Steps>
          <CopyField label="Optional: IndiaMART Push API URL (instant delivery, if IndiaMART enabled it for you)" value={url} />
        </div>
      );
    case 'meta':
      return (
        <div className="stack">
          <CopyField label="Callback URL" value={url} />
          <CopyField label="Verify token" value={source.config.verifyToken} />
          <Steps>
            <li>In <strong>developers.facebook.com</strong> open your app → <strong>Webhooks</strong> → <strong>Page</strong>, paste the callback URL and verify token, and subscribe to <code>leadgen</code>.</li>
            <li>Connect your Facebook Page to the app and create a <strong>Page access token</strong> with <code>leads_retrieval</code>, <code>pages_manage_metadata</code> and <code>pages_show_list</code> (a long-lived / system-user token, so it does not expire).</li>
            <li>Paste the page token and the app secret below. Instagram lead ads use the same Page.</li>
          </Steps>
          {source.config.verifiedAt ? <div className="alert alert-info small">Meta verified this webhook on {dateTime(source.config.verifiedAt)}.</div> : <div className="text-xs text-muted-foreground">Not verified by Meta yet.</div>}
        </div>
      );
    case 'google_ads':
      return (
        <div className="stack">
          <CopyField label="Webhook URL" value={url} />
          <CopyField label="Key" value={source.config.googleKey} />
          <Steps>
            <li>In Google Ads open the <strong>lead form asset</strong> → <strong>Lead delivery options</strong> → <strong>Webhook integration</strong>.</li>
            <li>Paste the webhook URL and key, then click <strong>Send test data</strong>.</li>
          </Steps>
        </div>
      );
    case 'whatsapp':
      return (
        <div className="stack">
          <p className="m-0 text-sm">When someone not yet in your CRM messages your WhatsApp Business number, they become a lead with their first message as the requirement, and the chat is linked to the lead.</p>
          <p className="m-0 text-xs text-muted-foreground">Needs WhatsApp connected in <Link to="/integrations">Integrations</Link> (Meta Cloud API or Twilio).</p>
        </div>
      );
    default:
      return null;
  }
}

function SourceEditor({ source, onClose, onSaved }) {
  const team = useTeam();
  const [v, setV] = useState({
    name: source.name, enabled: source.enabled, leadSource: source.leadSource || '', onDuplicate: source.onDuplicate,
    assignMode: source.assignMode, assignUserIds: (source.assignUserIds || []).map(String),
    config: source.type === 'form' ? { ...source.form } : { ...source.config }, credentials: {},
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  const setConfig = (k, val) => setV((s) => ({ ...s, config: { ...s.config, [k]: val } }));
  const setCred = (k, val) => setV((s) => ({ ...s, credentials: { ...s.credentials, [k]: val } }));
  const toggleUser = (id) => set('assignUserIds', v.assignUserIds.includes(id) ? v.assignUserIds.filter((x) => x !== id) : [...v.assignUserIds, id]);
  const fields = v.config.fields || [];
  const fieldOn = (key) => fields.find((f) => f.key === key);
  const toggleField = (key, on) => setConfig('fields', on ? [...fields, { key, label: FORM_FIELDS.find((f) => f.key === key).label, required: false }] : fields.filter((f) => f.key !== key));
  const editField = (key, change) => setConfig('fields', fields.map((f) => (f.key === key ? { ...f, ...change } : f)));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: v.name, enabled: v.enabled, leadSource: v.leadSource, onDuplicate: v.onDuplicate, assignMode: v.assignMode,
        assignUserIds: v.assignMode === 'user' ? v.assignUserIds.slice(0, 1) : v.assignUserIds,
        config: v.config,
        ...(Object.values(v.credentials).some(Boolean) ? { credentials: v.credentials } : {}),
      };
      await patch(`/lead-sources/${source.id}`, body);
      toast('Saved');
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      size="lg" title={`${TYPES[source.type].title} settings`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></>}
    >
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className="input" value={v.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Lead source tag" hint="Saved on each lead's Source, for filters and reports"><input className="input" value={v.leadSource} onChange={(e) => set('leadSource', e.target.value)} /></Field>
        </div>
        <label className="checkbox"><input type="checkbox" checked={v.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Receiving leads</label>

        <div className="rounded-lg border p-3">
          <div className="mb-2 text-sm font-semibold">Who gets the leads</div>
          <div className="flex flex-wrap gap-4 text-sm">
            {[['none', 'Nobody (I assign them)'], ['user', 'One person'], ['round_robin', 'Share in turn (round-robin)']].map(([mode, text]) => (
              <label key={mode} className="flex items-center gap-2"><input type="radio" name="assignMode" checked={v.assignMode === mode} onChange={() => set('assignMode', mode)} />{text}</label>
            ))}
          </div>
          {v.assignMode !== 'none' && (
            <div className="mt-3 max-h-48 divide-y overflow-y-auto rounded-md border">
              {team.map((u) => (
                <label key={u.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50">
                  <input type={v.assignMode === 'user' ? 'radio' : 'checkbox'} name="assignee" checked={v.assignMode === 'user' ? v.assignUserIds[0] === u.id : v.assignUserIds.includes(u.id)}
                    onChange={() => (v.assignMode === 'user' ? set('assignUserIds', [u.id]) : toggleUser(u.id))} />
                  <span className="flex-1">{u.name}</span>
                </label>
              ))}
            </div>
          )}
          <p className="mb-0 mt-2 text-xs text-muted-foreground">They get a notification with the customer’s number (tap to call). Inactive team members are skipped.</p>
        </div>

        <Field label="When the phone or email is already in the CRM">
          <select className="input" value={v.onDuplicate} onChange={(e) => set('onDuplicate', e.target.value)}>
            <option value="merge">Add the enquiry to the existing lead and tell its owner (no duplicate)</option>
            <option value="create">Always create a new lead</option>
          </select>
        </Field>

        {source.type === 'indiamart' && (
          <Field label="IndiaMART CRM key" hint={source.saved.crmKey ? 'Saved (encrypted). Type a new key to replace it.' : 'From IndiaMART Lead Manager → CRM Integration'}>
            <input className="input" type="password" autoComplete="off" placeholder={source.saved.crmKey ? '•••••• (unchanged)' : ''} value={v.credentials.crmKey || ''} onChange={(e) => setCred('crmKey', e.target.value)} />
          </Field>
        )}
        {source.type === 'meta' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Page access token" hint={source.saved.pageAccessToken ? 'Saved (encrypted)' : 'Needs leads_retrieval'}>
              <input className="input" type="password" autoComplete="off" placeholder={source.saved.pageAccessToken ? '•••••• (unchanged)' : ''} value={v.credentials.pageAccessToken || ''} onChange={(e) => setCred('pageAccessToken', e.target.value)} />
            </Field>
            <Field label="App secret" hint={source.saved.appSecret ? 'Saved: webhook signatures are checked' : 'Recommended: checks each webhook is from Meta'}>
              <input className="input" type="password" autoComplete="off" placeholder={source.saved.appSecret ? '•••••• (unchanged)' : ''} value={v.credentials.appSecret || ''} onChange={(e) => setCred('appSecret', e.target.value)} />
            </Field>
          </div>
        )}
        {source.type === 'form' && (
          <div className="stack rounded-lg border p-3">
            <div className="text-sm font-semibold">Form</div>
            <Field label="Heading"><input className="input" value={v.config.title || ''} onChange={(e) => setConfig('title', e.target.value)} /></Field>
            <Field label="Short intro (optional)"><input className="input" value={v.config.intro || ''} onChange={(e) => setConfig('intro', e.target.value)} /></Field>
            <div className="divide-y rounded-md border">
              {FORM_FIELDS.map((f) => {
                const on = fieldOn(f.key);
                return (
                  <div key={f.key} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                    <label className="flex w-40 items-center gap-2"><input type="checkbox" checked={Boolean(on)} onChange={(e) => toggleField(f.key, e.target.checked)} />{f.label}</label>
                    {on && <input className="input h-8 min-w-0 flex-1" value={on.label} onChange={(e) => editField(f.key, { label: e.target.value })} aria-label={`${f.label} label`} />}
                    {on && <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={on.required} onChange={(e) => editField(f.key, { required: e.target.checked })} />Required</label>}
                  </div>
                );
              })}
            </div>
            <Field label="Thank-you message"><input className="input" value={v.config.thankYou || ''} onChange={(e) => setConfig('thankYou', e.target.value)} /></Field>
            <Field label="Or send people to your own thank-you page (optional)"><input className="input" placeholder="https://yourwebsite.com/thank-you" value={v.config.redirectUrl || ''} onChange={(e) => setConfig('redirectUrl', e.target.value)} /></Field>
          </div>
        )}
        {source.type === 'webhook' && (
          <Field label="Thank-you page for plain HTML forms (optional)" hint="Without it, people see a short thank-you message">
            <input className="input" placeholder="https://yourwebsite.com/thank-you" value={v.config.redirectUrl || ''} onChange={(e) => setConfig('redirectUrl', e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function LogsDialog({ source, onClose }) {
  const { data, error, loading } = useAsync(() => get(`/lead-sources/${source.id}/logs`, { limit: 100 }), [source.id]);
  return (
    <Modal size="lg" title={`Recent enquiries: ${source.name}`} description="The last 60 days" onClose={onClose}>
      <ErrorAlert error={error} />
      {loading ? <Skeleton /> : !data?.items.length ? <Empty>No enquiries yet.</Empty> : (
        <div className="divide-y rounded-md border text-sm">
          {data.items.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <StatusBadge status={l.status === 'created' ? 'active' : l.status === 'duplicate' ? 'pending' : 'failed'} text={l.status === 'created' ? 'New lead' : l.status === 'duplicate' ? 'Repeat' : 'Failed'} />
              <span className="min-w-0 flex-1">
                {l.leadId ? <Link to={`/leads/${l.leadId}`}>{l.name || l.phone || l.email}</Link> : (l.name || l.phone || l.email || '—')}
                {l.phone && <span className="ml-2 font-mono text-xs text-muted-foreground">{l.phone}</span>}
                {l.error && <div className="text-xs text-destructive">{l.error}</div>}
              </span>
              <span className="text-xs text-muted-foreground">{dateTime(l.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function SourceCard({ source, team, onChanged }) {
  const T = TYPES[source.type];
  const [editing, setEditing] = useState(false);
  const [logs, setLogs] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const test = () => act(async () => {
    const r = await post(`/lead-sources/${source.id}/test`);
    toast(r.status === 'created' ? 'Test lead added — check Leads and notifications' : `Test: ${r.reason || r.status}`, r.status === 'created' ? 'success' : 'info');
    onChanged();
  });
  const pull = () => act(async () => {
    const r = await post(`/lead-sources/${source.id}/pull`);
    toast(`IndiaMART: ${r.fetched} enquiries, ${r.created} new lead${r.created === 1 ? '' : 's'}`);
    onChanged();
  });
  const needsSetup = (source.type === 'indiamart' && !source.saved.crmKey) || (source.type === 'meta' && !source.saved.pageAccessToken);
  return (
    <div className="card">
      <div className="card-header">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl bg-primary/10 text-primary"><T.icon className="size-5" /></span>
          <div>
            <strong className="text-[15px]">{source.name}</strong>
            <div className="text-xs text-muted-foreground">{T.title} · tag “{source.leadSource}”</div>
          </div>
        </div>
        {needsSetup ? <StatusBadge status="pending" text="Finish setup" /> : <StatusBadge status={source.enabled ? 'active' : 'paused'} text={source.enabled ? 'Receiving' : 'Off'} />}
      </div>
      <div className="card-body stack">
        {source.stats?.lastError && (
          <div className="alert alert-warning flex gap-2 text-sm"><AlertTriangle className="size-4 shrink-0" /><span>{source.stats.lastError}{source.stats.lastErrorAt && <span className="text-xs text-muted-foreground"> · {dateTime(source.stats.lastErrorAt)}</span>}</span></div>
        )}
        <div className="grid grid-cols-3 gap-2 text-center">
          {[['New leads', source.stats?.total || 0], ['Repeat', source.stats?.duplicates || 0], ['Last lead', source.stats?.lastLeadAt ? dateTime(source.stats.lastLeadAt) : '—']].map(([k, val]) => (
            <div key={k} className="rounded-lg bg-muted/50 px-2 py-2"><div className="text-sm font-semibold">{val}</div><div className="text-[11px] text-muted-foreground">{k}</div></div>
          ))}
        </div>
        <div className="text-sm"><span className="text-muted-foreground">Who gets them: </span>{assignText(source, team)}</div>
        <details className="rounded-lg border px-3 py-2" open={needsSetup || !source.stats?.total}>
          <summary className="cursor-pointer text-sm font-medium">How to connect</summary>
          <div className="pt-3"><SetupHelp source={source} /></div>
        </details>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing(true)}>Settings</button>
          {source.type !== 'whatsapp' && <button type="button" className="btn btn-sm" disabled={busy} onClick={test}>Send a test lead</button>}
          {source.type === 'indiamart' && source.saved.crmKey && <button type="button" className="btn btn-sm" disabled={busy} onClick={pull}><RefreshCw className="size-4" />Fetch now</button>}
          <button type="button" className="btn btn-sm" onClick={() => setLogs(true)}>Recent enquiries</button>
          <span className="flex-1" />
          {source.type !== 'whatsapp' && <button type="button" className="btn btn-sm" onClick={() => setConfirm('rotate')} title="If the address leaked: the old one stops working">New address</button>}
          <button type="button" className="btn btn-sm" onClick={() => setConfirm('delete')}>Remove</button>
        </div>
        {source.type === 'indiamart' && source.config?.lastPullOk && <div className="text-xs text-muted-foreground">Last fetched {dateTime(source.config.lastPullOk)}</div>}
      </div>
      {editing && <SourceEditor source={source} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} />}
      {logs && <LogsDialog source={source} onClose={() => setLogs(false)} />}
      {confirm === 'delete' && (
        <ConfirmDialog danger title={`Remove ${source.name}?`} message="Leads already captured stay. New enquiries sent to this address will be refused." confirmLabel="Remove"
          onClose={() => setConfirm(null)} onConfirm={() => act(async () => { await del(`/lead-sources/${source.id}`); setConfirm(null); onChanged(); })} />
      )}
      {confirm === 'rotate' && (
        <ConfirmDialog title="Make a new address?" message="The current address (and verify token / key) stops working at once. You will need to paste the new one wherever the old one was used." confirmLabel="Make new address"
          onClose={() => setConfirm(null)} onConfirm={() => act(async () => { await post(`/lead-sources/${source.id}/rotate`); setConfirm(null); onChanged(); toast('New address made'); })} />
      )}
    </div>
  );
}

export function LeadCapture() {
  const { data, error, loading, reload } = useAsync(() => get('/lead-sources'), []);
  const team = useTeam();
  const [adding, setAdding] = useState(null);
  const [addError, setAddError] = useState(null);
  const add = async (type) => {
    setAdding(type);
    setAddError(null);
    try {
      await post('/lead-sources', { type });
      await reload();
      toast(`${TYPES[type].title} added — follow “How to connect”`);
    } catch (e) {
      setAddError(e);
    } finally {
      setAdding(null);
    }
  };
  const has = new Set((data?.items || []).map((s) => s.type));
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Lead capture</h1>
          <p>Enquiries from your website, Justdial, IndiaMART, Facebook, Instagram, Google Ads and WhatsApp become leads on their own, go to the right person, and they are told at once.</p>
        </div>
      </div>
      <ErrorAlert error={error || addError} />
      <div className="card mb-6">
        <div className="card-header"><h3>Add a source</h3></div>
        <div className="card-body grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(TYPES).map(([type, T]) => (
            <button key={type} type="button" disabled={adding === type || (type === 'whatsapp' && has.has('whatsapp'))} onClick={() => add(type)}
              className="flex flex-col items-start gap-1 rounded-xl border bg-card p-3 text-left transition hover:border-primary/50 hover:bg-primary/5 disabled:opacity-50">
              <span className="flex items-center gap-2 font-semibold"><T.icon className="size-4 text-primary" />{T.title}{has.has(type) && <span className="badge text-[10px]">added</span>}</span>
              <span className="text-xs text-muted-foreground">{T.text}</span>
              <span className="mt-1 flex items-center gap-1 text-xs font-medium text-primary"><Plus className="size-3" />{adding === type ? 'Adding…' : 'Add'}</span>
            </button>
          ))}
        </div>
      </div>
      {loading && !data ? <Skeleton /> : !data?.items.length ? <Empty>No lead sources yet. Add one above.</Empty> : (
        <div className="grid gap-4 xl:grid-cols-2">
          {data.items.map((s) => <SourceCard key={s.id} source={s} team={team} onChanged={reload} />)}
        </div>
      )}
      <p className="mt-6 text-xs text-muted-foreground">LinkedIn lead gen forms need LinkedIn’s partner approval: until then, connect them with Zapier or Make to a Website / API source. Excel or CSV files: use Import on the Leads page.</p>
    </>
  );
}
