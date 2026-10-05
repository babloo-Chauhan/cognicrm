import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { ErrorAlert, Field } from '../components/ui.jsx';

export function Login() {
  const { login } = useAuth();
  const [form, setForm] = useState({ email: '', password: '', companyCode: '' });
  const [showCode, setShowCode] = useState(false);
  const [choices, setChoices] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e, companyCode = form.companyCode) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await login(form.email, form.password, companyCode.trim().toUpperCase());
      if (res?.requiresCompany) setChoices(res.companies);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <div className="card-body stack">
          <div className="brand" style={{ color: 'var(--text)', padding: 0 }}><div className="brand-mark" style={{ color: '#fff' }}>C</div><span>COGNIEOS CRM</span></div>
          <h1>{choices ? 'Choose a company' : 'Sign in'}</h1>
          <ErrorAlert error={error} />
          {choices ? (
            <div className="stack">
              <p className="muted" style={{ margin: 0 }}>Your email belongs to several companies.</p>
              {choices.map((c) => (
                <button key={c.companyCode} type="button" className="btn" disabled={busy} onClick={() => submit(null, c.companyCode)} style={{ justifyContent: 'space-between' }}>
                  <strong>{c.name}</strong><span className="small muted mono">{c.companyCode}</span>
                </button>
              ))}
              <button type="button" className="btn btn-ghost" onClick={() => setChoices(null)}>Back</button>
            </div>
          ) : (
            <>
              <Field label="Email"><input className="input" type="email" required autoComplete="email" value={form.email} onChange={set('email')} /></Field>
              <Field label="Password"><input className="input" type="password" required autoComplete="current-password" value={form.password} onChange={set('password')} /></Field>
              {showCode
                ? <Field label="Company ID (optional)"><input className="input mono" placeholder="CMP-000001" value={form.companyCode} onChange={set('companyCode')} /></Field>
                : <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setShowCode(true)}>Sign in with a Company ID</button>}
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
              <Link className="btn btn-ghost" to="/register">New here? Register your company</Link>
            </>
          )}
          <p className="small muted" style={{ margin: 0, textAlign: 'center' }}><Link to="/super-admin">Platform admin</Link></p>
        </div>
      </form>
    </div>
  );
}
