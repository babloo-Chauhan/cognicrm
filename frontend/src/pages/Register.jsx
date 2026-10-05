import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, setToken } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useAsync } from '../lib/hooks.js';
import { limitText, priceLabel, startCheckout } from '../lib/checkout.js';
import { ErrorAlert, Field, Skeleton } from '../components/ui.jsx';

const STEPS = ['Company information', 'Admin account', 'Plan', 'Payment / trial', 'Confirmation'];
const INDUSTRIES = ['IT & Software', 'Retail', 'Manufacturing', 'Real Estate', 'Education', 'Healthcare', 'Finance', 'Services', 'Other'];
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const EMPTY = {
  companyName: '', legalName: '', email: '', phone: '', country: 'India', state: '', city: '', address: '', gstNumber: '', website: '', industry: '',
  adminName: '', adminEmail: '', password: '', confirmPassword: '',
};

/** Client-side checks per step; the server validates everything again. */
function stepErrors(step, f) {
  const e = {};
  if (step === 0) {
    if (f.companyName.trim().length < 2) e.companyName = 'Company name is required';
    if (!/^\S+@\S+\.\S+$/.test(f.email)) e.email = 'Enter a valid business email';
    if (f.phone && !/^[+0-9 ()-]{6,20}$/.test(f.phone)) e.phone = 'Enter a valid phone number';
    if (f.gstNumber && /^(in|india)$/i.test(f.country) && !GSTIN.test(f.gstNumber.toUpperCase())) e.gstNumber = 'Enter a valid 15-character GSTIN';
    if (f.website && !/^https?:\/\/\S+\.\S+/.test(f.website)) e.website = 'Start with https://';
  }
  if (step === 1) {
    if (!f.adminName.trim()) e.adminName = 'Your name is required';
    if (f.adminEmail && !/^\S+@\S+\.\S+$/.test(f.adminEmail)) e.adminEmail = 'Enter a valid email';
    if (f.password.length < 8) e.password = 'At least 8 characters';
    if (f.password !== f.confirmPassword) e.confirmPassword = 'Passwords do not match';
  }
  return e;
}

export function Register() {
  const { startSession, refresh } = useAuth();
  const plans = useAsync(() => get('/public/plans'), []);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(EMPTY);
  const [touched, setTouched] = useState(false);
  const [planCode, setPlanCode] = useState('PROFESSIONAL');
  const [cycle, setCycle] = useState('monthly');
  const [mode, setMode] = useState('trial');
  const [provider, setProvider] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [result, setResult] = useState(null);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const errors = touched ? stepErrors(step, form) : {};
  const plan = plans.data?.items.find((p) => p.code === planCode);
  const providers = plans.data?.providers || [];
  const paid = plan && !plan.isCustom && plan.priceMonthly > 0;

  const next = () => {
    setTouched(true);
    if (Object.keys(stepErrors(step, form)).length) return;
    setTouched(false);
    setStep(step + 1);
  };

  const field = (k, text, props = {}) => (
    <Field label={text} className={props.full ? 'full' : ''}>
      <input className="input" value={form[k]} onChange={set(k)} aria-invalid={Boolean(errors[k])} {...props} full={undefined} />
      {errors[k] && <span className="small" style={{ color: 'var(--danger)' }}>{errors[k]}</span>}
    </Field>
  );

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payNow = mode === 'pay' && paid;
      const res = await post('/auth/register', {
        ...form, gstNumber: form.gstNumber.toUpperCase(), planCode, trial: !payNow,
      });
      setToken(res.token); // lets the payment step call the API before the app takes over
      setResult(res);
      if (payNow) {
        try {
          await startCheckout({ planCode, billingCycle: cycle, provider: provider || providers[0] });
          setNotice({ tone: 'success', text: `Payment verified — ${plan.name} is active.` });
        } catch (err) {
          setNotice({ tone: 'warning', text: `Your workspace is ready on the free plan. ${err.message}. You can upgrade any time from Billing.` });
        }
      }
      setStep(4);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const enter = () => {
    startSession(result);
    refresh();
  };

  return (
    <div className="auth-page">
      <div className="card wizard">
        <div className="card-body stack">
          <div className="brand" style={{ color: 'var(--text)', padding: 0 }}><div className="brand-mark" style={{ color: '#fff' }}>C</div><span>COGNIEOS CRM</span></div>
          <h1>Create your company workspace</h1>
          <ol className="steps" aria-label="Registration steps">
            {STEPS.map((s, i) => <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>{i + 1}. {s}</li>)}
          </ol>
          <ErrorAlert error={error} />

          {step === 0 && (
            <div className="form-grid">
              {field('companyName', 'Company name *', { autoFocus: true })}
              {field('legalName', 'Legal name')}
              {field('email', 'Business email *', { type: 'email', autoComplete: 'email' })}
              {field('phone', 'Phone', { type: 'tel' })}
              {field('country', 'Country')}
              {field('state', 'State')}
              {field('city', 'City')}
              {field('gstNumber', 'GST / VAT number', { style: { textTransform: 'uppercase' } })}
              {field('address', 'Address', { full: true })}
              {field('website', 'Website', { placeholder: 'https://' })}
              <Field label="Industry">
                <select className="input" value={form.industry} onChange={set('industry')}>
                  <option value="">Select…</option>
                  {INDUSTRIES.map((i) => <option key={i}>{i}</option>)}
                </select>
              </Field>
            </div>
          )}

          {step === 1 && (
            <div className="form-grid">
              {field('adminName', 'Your name *', { autoFocus: true, autoComplete: 'name' })}
              {field('adminEmail', 'Login email', { type: 'email', placeholder: form.email, autoComplete: 'username' })}
              {field('password', 'Password *', { type: 'password', autoComplete: 'new-password' })}
              {field('confirmPassword', 'Confirm password *', { type: 'password', autoComplete: 'new-password' })}
              <p className="small muted full" style={{ margin: 0 }}>You become the Company Admin. Leave the login email empty to use the business email.</p>
            </div>
          )}

          {step === 2 && (plans.loading && !plans.data ? <Skeleton /> : (
            <div className="stack">
              <div className="row">
                <button type="button" className={`btn btn-sm ${cycle === 'monthly' ? 'active' : ''}`} onClick={() => setCycle('monthly')}>Monthly</button>
                <button type="button" className={`btn btn-sm ${cycle === 'yearly' ? 'active' : ''}`} onClick={() => setCycle('yearly')}>Yearly</button>
              </div>
              <div className="plan-grid" role="radiogroup" aria-label="Plans">
                {plans.data?.items.map((p) => (
                  <button key={p.code} type="button" role="radio" aria-checked={planCode === p.code} className={`plan-card ${planCode === p.code ? 'selected' : ''}`} onClick={() => setPlanCode(p.code)}>
                    <strong>{p.name}</strong>
                    <span className="price">{priceLabel(p, cycle)}</span>
                    <span className="small muted">{p.description}</span>
                    <ul>
                      <li>{limitText(p.limits?.users)} users</li>
                      <li>{limitText(p.limits?.leads)} leads · {limitText(p.limits?.customers)} customers</li>
                      <li>{p.modules.includes('*') ? 'All modules' : `${p.modules.length} modules`}</li>
                    </ul>
                  </button>
                ))}
              </div>
              {plan?.isCustom && <div className="alert alert-info">Enterprise pricing is arranged with our team. You can start with a trial now.</div>}
            </div>
          ))}

          {step === 3 && (
            <div className="stack">
              <label className="checkbox"><input type="radio" name="mode" checked={mode === 'trial'} onChange={() => setMode('trial')} /> Start a free trial of <strong>{plan?.name}</strong> — no card needed</label>
              {paid && (
                <label className="checkbox">
                  <input type="radio" name="mode" checked={mode === 'pay'} onChange={() => setMode('pay')} disabled={!providers.length} />
                  Pay now ({priceLabel(plan, cycle)}){!providers.length && <span className="muted"> — online payments are not configured yet</span>}
                </label>
              )}
              {mode === 'pay' && providers.length > 1 && (
                <Field label="Pay with">
                  <select className="input" value={provider || providers[0]} onChange={(e) => setProvider(e.target.value)}>
                    {providers.map((p) => <option key={p} value={p}>{p === 'razorpay' ? 'Razorpay (UPI, cards, netbanking)' : 'Stripe (cards)'}</option>)}
                  </select>
                </Field>
              )}
              <div className="card"><div className="card-body">
                <dl className="kv">
                  <dt>Company</dt><dd>{form.companyName}</dd>
                  <dt>Admin</dt><dd>{form.adminName} · {form.adminEmail || form.email}</dd>
                  <dt>Plan</dt><dd>{plan?.name} ({mode === 'pay' && paid ? priceLabel(plan, cycle) : 'trial'})</dd>
                </dl>
              </div></div>
            </div>
          )}

          {step === 4 && result && (
            <div className="stack">
              <div className="alert alert-info">Your workspace is ready. Keep these details — the Company ID can be used to sign in.</div>
              {notice && <div className={`alert ${notice.tone === 'success' ? 'alert-info' : 'alert-warning'}`}>{notice.text}</div>}
              <dl className="kv">
                <dt>Company ID</dt><dd className="mono">{result.company.companyCode}</dd>
                <dt>Tenant ID</dt><dd className="mono">{result.company.tenantId}</dd>
                <dt>Admin email</dt><dd>{result.user.email}</dd>
                <dt>Admin user ID</dt><dd className="mono">{result.user.userCode}</dd>
                <dt>Subscription</dt><dd>{result.company.subscription?.planName} · {result.company.subscription?.status}{result.company.subscription?.daysLeft != null ? ` · ${result.company.subscription.daysLeft} days left` : ''}</dd>
              </dl>
            </div>
          )}

          <div className="row">
            {step > 0 && step < 4 && <button type="button" className="btn" onClick={() => setStep(step - 1)} disabled={busy}>Back</button>}
            {step < 3 && <button type="button" className="btn btn-primary right" onClick={next}>Continue</button>}
            {step === 3 && <button type="button" className="btn btn-primary right" onClick={submit} disabled={busy}>{busy ? 'Creating workspace…' : mode === 'pay' && paid ? 'Create & pay' : 'Create workspace'}</button>}
            {step === 4 && <button type="button" className="btn btn-primary right" onClick={enter}>Go to dashboard</button>}
          </div>
          {step < 4 && <p className="small muted" style={{ margin: 0 }}>Already have an account? <Link to="/">Sign in</Link></p>}
        </div>
      </div>
    </div>
  );
}
