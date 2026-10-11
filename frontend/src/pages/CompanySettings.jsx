import { useRef, useState } from 'react';
import { del, get, patch, upload } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useAsync } from '../lib/hooks.js';
import { ErrorAlert, Field, Skeleton } from '../components/ui.jsx';
import { phoneChars, validateForm } from '../lib/validation.js';
import { toast } from '../lib/toast.js';

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'];
const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];

/** Logo upload with preview; employees see this logo in the web sidebar and in their mobile app. */
function LogoUploader({ value, editable, onChange }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pick = async (file) => {
    if (!file) return;
    setError(null);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return setError(new Error('Choose a PNG, JPG or WebP image'));
    if (file.size > 1024 * 1024) return setError(new Error('The logo must be 1 MB or smaller'));
    setBusy(true);
    try {
      onChange((await upload('/company/logo', file)).logoUrl);
      toast('Logo updated — employees will see it in their app');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const remove = async () => {
    setBusy(true);
    try { onChange((await del('/company/logo')).logoUrl); toast('Logo removed'); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="full flex flex-wrap items-center gap-4">
      <div className="grid size-20 place-items-center overflow-hidden rounded-2xl border bg-muted/40">
        {value ? <img src={value} alt="Company logo" className="size-full object-contain" /> : <span className="text-xs text-muted-foreground">No logo</span>}
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <button type="button" className="btn btn-sm btn-primary" disabled={!editable || busy} onClick={() => fileRef.current?.click()}>{busy ? 'Uploading…' : value ? 'Change logo' : 'Upload logo'}</button>
          {value && <button type="button" className="btn btn-sm" disabled={!editable || busy} onClick={remove}>Remove</button>}
        </div>
        <small className="text-xs text-muted-foreground">PNG, JPG or WebP, up to 1 MB. A square image works best. Shown to your employees in the web app and the mobile app.</small>
        {error && <small className="text-xs text-destructive">{error.message}</small>}
      </div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
    </div>
  );
}

/** Company profile, branding and localisation — all stored per tenant. */
export function CompanySettings() {
  const { can, company, refresh } = useAuth();
  const org = useAsync(() => get('/organization'), []);
  const [profile, setProfile] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [error, setError] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
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

  // One flat view of the form for the shared rules; GSTIN / PIN checks apply to Indian companies
  const india = !p.address.country || /^(in|india)$/i.test(p.address.country.trim());
  const allErrors = validateForm([
    { key: 'name', label: 'Company name', required: true, maxLength: 150 },
    { key: 'legalName', label: 'Legal name', maxLength: 150 },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'phone' },
    { key: 'website', label: 'Website', format: 'https', maxLength: 200 },
    { key: 'taxId', label: 'GST / tax number', ...(india ? { format: 'gstin' } : { maxLength: 20 }) },
    { key: 'industry', label: 'Industry', maxLength: 60 },
    { key: 'line1', label: 'Address', maxLength: 300 },
    { key: 'city', label: 'City', maxLength: 60 },
    { key: 'state', label: 'State', maxLength: 60 },
    { key: 'country', label: 'Country', maxLength: 60 },
    { key: 'postalCode', label: 'Postal code', ...(india ? { format: 'pincode' } : { maxLength: 12 }) },
    { key: 'brandName', label: 'Brand name', maxLength: 60 },
    { key: 'taxName', label: 'Tax name', maxLength: 20 },
    { key: 'defaultRate', label: 'Default tax rate', type: 'number', min: 0, max: 100 },
    { key: 'fromName', label: 'Email sender name', maxLength: 80 },
    { key: 'replyTo', label: 'Reply-to email', type: 'email' },
  ], { ...p, ...p.address, ...pr.branding, ...pr.taxSettings, ...pr.emailSettings });
  const errors = showErrors ? allErrors : {};

  const save = async () => {
    setError(null);
    if (Object.keys(allErrors).length) {
      setShowErrors(true);
      return setError(new Error('Please fix the highlighted fields.'));
    }
    setShowErrors(false);
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

  const input = (value, onChange, props = {}, key = null) => <input className="input" disabled={!editable} aria-invalid={key && errors[key] ? true : undefined} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...props} />;

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
        <Field label="Company name" required error={errors.name}>{input(p.name, (v) => setP('name', v), {}, 'name')}</Field>
        <Field label="Legal name" error={errors.legalName}>{input(p.legalName, (v) => setP('legalName', v), {}, 'legalName')}</Field>
        <Field label="Email" error={errors.email}>{input(p.email, (v) => setP('email', v), { type: 'email' }, 'email')}</Field>
        <Field label="Phone" error={errors.phone}>{input(p.phone, (v) => setP('phone', phoneChars(v)), { type: 'tel', maxLength: 20 }, 'phone')}</Field>
        <Field label="Website" error={errors.website}>{input(p.website, (v) => setP('website', v), { placeholder: 'https://' }, 'website')}</Field>
        <Field label="GST / tax number" error={errors.taxId}>{input(p.taxId, (v) => setP('taxId', v), {}, 'taxId')}</Field>
        <Field label="Industry" error={errors.industry}>{input(p.industry, (v) => setP('industry', v), {}, 'industry')}</Field>
        <Field label="Address" error={errors.line1}>{input(p.address.line1, (v) => setAddr('line1', v), {}, 'line1')}</Field>
        <Field label="City" error={errors.city}>{input(p.address.city, (v) => setAddr('city', v), {}, 'city')}</Field>
        <Field label="State" error={errors.state}>{input(p.address.state, (v) => setAddr('state', v), {}, 'state')}</Field>
        <Field label="Country" error={errors.country}>{input(p.address.country, (v) => setAddr('country', v), {}, 'country')}</Field>
        <Field label="Postal code" error={errors.postalCode}>{input(p.address.postalCode, (v) => setAddr('postalCode', v), {}, 'postalCode')}</Field>
      </div></div>
      <div className="card"><div className="card-header"><h3>Branding</h3></div><div className="card-body form-grid">
        <LogoUploader
          value={pr.branding.logoUrl}
          editable={editable}
          onChange={(url) => { setNested('branding', 'logoUrl', url); org.reload(); refresh(); }}
        />
        <Field label="Brand name" hint="Shown to employees instead of the company name, e.g. in the app" error={errors.brandName}>{input(pr.branding.brandName, (v) => setNested('branding', 'brandName', v), {}, 'brandName')}</Field>
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
        <Field label="Tax name" error={errors.taxName}>{input(pr.taxSettings.taxName, (v) => setNested('taxSettings', 'taxName', v), {}, 'taxName')}</Field>
        <Field label="Default tax rate %" error={errors.defaultRate}>{input(pr.taxSettings.defaultRate, (v) => setNested('taxSettings', 'defaultRate', Number(v)), { type: 'number', min: 0, max: 100 }, 'defaultRate')}</Field>
        <Field label="Email sender name" error={errors.fromName}>{input(pr.emailSettings.fromName, (v) => setNested('emailSettings', 'fromName', v), {}, 'fromName')}</Field>
        <Field label="Reply-to email" error={errors.replyTo}>{input(pr.emailSettings.replyTo, (v) => setNested('emailSettings', 'replyTo', v), { type: 'email' }, 'replyTo')}</Field>
        {['email', 'push', 'inApp'].map((k) => (
          <label key={k} className="checkbox"><input type="checkbox" disabled={!editable} checked={Boolean(pr.notificationSettings[k])} onChange={(e) => setNested('notificationSettings', k, e.target.checked)} /> {k === 'inApp' ? 'In-app' : k[0].toUpperCase() + k.slice(1)} notifications</label>
        ))}
      </div></div>
      {editable && <div className="row"><button type="button" className="btn btn-primary right" onClick={save}>Save changes</button></div>}
    </div>
  );
}
