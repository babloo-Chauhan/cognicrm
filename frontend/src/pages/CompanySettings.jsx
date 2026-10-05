import { useState } from 'react';
import { get, patch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useAsync } from '../lib/hooks.js';
import { ErrorAlert, Field, Skeleton } from '../components/ui.jsx';
import { toast } from '../lib/toast.js';

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'];
const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];

/** Company profile, branding and localisation — all stored per tenant. */
export function CompanySettings() {
  const { can, company, refresh } = useAuth();
  const org = useAsync(() => get('/organization'), []);
  const [profile, setProfile] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [error, setError] = useState(null);
  const editable = can('settings:manage');

  if (!org.data) return org.error ? <ErrorAlert error={org.error} /> : <Skeleton />;
  const o = org.data;
  const p = profile || {
    name: o.name || '', legalName: o.legalName || '', email: o.email || '', phone: o.phone || '', website: o.website || '', logoUrl: o.logoUrl || '',
    industry: o.industry || '', taxId: o.taxId || '', address: { line1: '', city: '', state: '', country: '', postalCode: '', ...(o.address || {}) },
  };
  const s = o.settings || {};
  const pr = prefs || {
    timezone: s.timezone || 'Asia/Kolkata', currency: s.currency || 'INR', dateFormat: s.dateFormat || 'DD/MM/YYYY', defaultLanguage: s.defaultLanguage || 'en',
    branding: { brandName: '', logoUrl: '', primaryColor: '#4f46e5', ...(s.branding || {}) },
    notificationSettings: { email: true, push: true, inApp: true, ...(s.notificationSettings || {}) },
    taxSettings: { taxName: 'GST', defaultRate: 18, pricesIncludeTax: false, ...(s.taxSettings || {}) },
    emailSettings: { fromName: '', replyTo: '', ...(s.emailSettings || {}) },
  };
  const setP = (k, v) => setProfile({ ...p, [k]: v });
  const setAddr = (k, v) => setProfile({ ...p, address: { ...p.address, [k]: v } });
  const setPr = (k, v) => setPrefs({ ...pr, [k]: v });
  const setNested = (group, k, v) => setPrefs({ ...pr, [group]: { ...pr[group], [k]: v } });

  const save = async () => {
    setError(null);
    try {
      const clean = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
      await patch('/company/profile', clean);
      await patch('/organization/settings', pr);
      toast('Company settings saved');
      setProfile(null);
      setPrefs(null);
      org.reload();
      refresh();
    } catch (e) {
      setError(e);
    }
  };

  const input = (value, onChange, props = {}) => <input className="input" disabled={!editable} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...props} />;

  return (
    <div className="stack">
      <ErrorAlert error={error} />
      {!editable && <div className="alert alert-info">Only admins can change company settings.</div>}
      <div className="card"><div className="card-header"><h3>Company identity</h3></div><div className="card-body">
        <dl className="kv">
          <dt>Company ID</dt><dd className="mono">{company?.companyCode}</dd>
          <dt>Tenant ID</dt><dd className="mono">{company?.tenantId}</dd>
          <dt>Status</dt><dd>{company?.status}</dd>
        </dl>
      </div></div>
      <div className="card"><div className="card-header"><h3>Business details</h3></div><div className="card-body form-grid">
        <Field label="Company name">{input(p.name, (v) => setP('name', v))}</Field>
        <Field label="Legal name">{input(p.legalName, (v) => setP('legalName', v))}</Field>
        <Field label="Email">{input(p.email, (v) => setP('email', v), { type: 'email' })}</Field>
        <Field label="Phone">{input(p.phone, (v) => setP('phone', v))}</Field>
        <Field label="Website">{input(p.website, (v) => setP('website', v), { placeholder: 'https://' })}</Field>
        <Field label="GST / tax number">{input(p.taxId, (v) => setP('taxId', v))}</Field>
        <Field label="Industry">{input(p.industry, (v) => setP('industry', v))}</Field>
        <Field label="Address">{input(p.address.line1, (v) => setAddr('line1', v))}</Field>
        <Field label="City">{input(p.address.city, (v) => setAddr('city', v))}</Field>
        <Field label="State">{input(p.address.state, (v) => setAddr('state', v))}</Field>
        <Field label="Country">{input(p.address.country, (v) => setAddr('country', v))}</Field>
        <Field label="Postal code">{input(p.address.postalCode, (v) => setAddr('postalCode', v))}</Field>
      </div></div>
      <div className="card"><div className="card-header"><h3>Branding</h3></div><div className="card-body form-grid">
        <Field label="Brand name">{input(pr.branding.brandName, (v) => setNested('branding', 'brandName', v))}</Field>
        <Field label="Logo URL (https)">{input(pr.branding.logoUrl, (v) => setNested('branding', 'logoUrl', v))}</Field>
        <Field label="Primary colour">{input(pr.branding.primaryColor, (v) => setNested('branding', 'primaryColor', v), { type: 'color', style: { height: 38, padding: 4 } })}</Field>
      </div></div>
      <div className="card"><div className="card-header"><h3>Localisation, tax & notifications</h3></div><div className="card-body form-grid">
        <Field label="Time zone">
          <select className="input" disabled={!editable} value={pr.timezone} onChange={(e) => setPr('timezone', e.target.value)}>{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Currency">
          <select className="input" disabled={!editable} value={pr.currency} onChange={(e) => setPr('currency', e.target.value)}>{CURRENCIES.map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Date format">
          <select className="input" disabled={!editable} value={pr.dateFormat} onChange={(e) => setPr('dateFormat', e.target.value)}>{DATE_FORMATS.map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Language">
          <select className="input" disabled={!editable} value={pr.defaultLanguage} onChange={(e) => setPr('defaultLanguage', e.target.value)}>
            <option value="en">English</option><option value="hi">Hindi</option><option value="hinglish">Hinglish</option>
          </select>
        </Field>
        <Field label="Tax name">{input(pr.taxSettings.taxName, (v) => setNested('taxSettings', 'taxName', v))}</Field>
        <Field label="Default tax rate %">{input(pr.taxSettings.defaultRate, (v) => setNested('taxSettings', 'defaultRate', Number(v)), { type: 'number', min: 0, max: 100 })}</Field>
        <Field label="Email sender name">{input(pr.emailSettings.fromName, (v) => setNested('emailSettings', 'fromName', v))}</Field>
        <Field label="Reply-to email">{input(pr.emailSettings.replyTo, (v) => setNested('emailSettings', 'replyTo', v), { type: 'email' })}</Field>
        {['email', 'push', 'inApp'].map((k) => (
          <label key={k} className="checkbox"><input type="checkbox" disabled={!editable} checked={Boolean(pr.notificationSettings[k])} onChange={(e) => setNested('notificationSettings', k, e.target.checked)} /> {k === 'inApp' ? 'In-app' : k[0].toUpperCase() + k.slice(1)} notifications</label>
        ))}
      </div></div>
      {editable && <div className="row"><button type="button" className="btn btn-primary right" onClick={save}>Save changes</button></div>}
    </div>
  );
}
