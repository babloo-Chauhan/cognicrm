import { useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { ErrorAlert, Field } from '../components/ui.jsx';

export function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', organizationName: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(form.email, form.password);
      else await register(form);
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
          <h1>{mode === 'login' ? 'Sign in' : 'Create your workspace'}</h1>
          <ErrorAlert error={error} />
          {mode === 'register' && (
            <>
              <Field label="Company name"><input className="input" required value={form.organizationName} onChange={set('organizationName')} /></Field>
              <Field label="Your name"><input className="input" required value={form.name} onChange={set('name')} /></Field>
            </>
          )}
          <Field label="Email"><input className="input" type="email" required autoComplete="email" value={form.email} onChange={set('email')} /></Field>
          <Field label="Password"><input className="input" type="password" required minLength={mode === 'register' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={set('password')} /></Field>
          <button type="submit" className="btn btn-primary" disabled={busy}>{mode === 'login' ? 'Sign in' : 'Create workspace'}</button>
          <button type="button" className="btn btn-ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'New here? Create a workspace' : 'Already have an account? Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
