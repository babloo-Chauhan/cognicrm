import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Building2, ChevronRight, Eye, EyeOff, KeyRound, Loader2, Mail,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { ErrorAlert } from '../components/ui.jsx';
import { AuthShell } from '../components/AuthShell.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function IconInput({ icon: Icon, trailing, ...props }) {
  return (
    <div className="relative">
      <Icon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input className="h-11 pl-10 pr-10" {...props} />
      {trailing && <div className="absolute right-1.5 top-1/2 -translate-y-1/2">{trailing}</div>}
    </div>
  );
}

export function Login() {
  const { login } = useAuth();
  const [form, setForm] = useState({ email: '', password: '', companyCode: '' });
  const [showCode, setShowCode] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
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
    <AuthShell>
      {choices ? (
        <div className="flex flex-col gap-5">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight">Choose a company</h1>
            <p className="mt-2 text-muted-foreground">Your email belongs to several companies.</p>
          </div>
          <ErrorAlert error={error} />
          <div className="flex flex-col gap-2">
            {choices.map((c) => (
              <button
                key={c.companyCode}
                type="button"
                disabled={busy}
                onClick={() => submit(null, c.companyCode)}
                className="group flex items-center gap-3 rounded-xl border bg-card p-4 text-left shadow-soft transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-pop disabled:opacity-60"
              >
                <span className="grid size-10 place-items-center rounded-lg bg-gradient-to-br from-chart-1/20 to-chart-2/15 text-primary"><Building2 className="size-5" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{c.name}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{c.companyCode}</span>
                </span>
                <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </button>
            ))}
          </div>
          <Button variant="ghost" onClick={() => setChoices(null)}>Back</Button>
        </div>
      ) : (
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight">Welcome back</h1>
            <p className="mt-2 text-muted-foreground">Sign in to your company workspace.</p>
          </div>
          <ErrorAlert error={error} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <IconInput icon={Mail} id="email" type="email" required autoComplete="email" placeholder="you@company.com" value={form.email} onChange={set('email')} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <IconInput
              icon={KeyRound}
              id="password"
              type={showPassword ? 'text' : 'password'}
              required
              autoComplete="current-password"
              placeholder="••••••••"
              value={form.password}
              onChange={set('password')}
              trailing={(
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOff /> : <Eye />}
                </Button>
              )}
            />
          </div>
          {showCode ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="companyCode">Company ID <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <IconInput icon={Building2} id="companyCode" className="h-11 pl-10 font-mono uppercase" placeholder="CMP-000001" value={form.companyCode} onChange={set('companyCode')} />
            </div>
          ) : (
            <button type="button" className="-mt-2 self-start text-sm font-medium text-primary hover:underline" onClick={() => setShowCode(true)}>Sign in with a Company ID</button>
          )}
          <Button type="submit" size="lg" className="h-11 text-[15px] shadow-[0_10px_24px_-10px_var(--primary)]" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}{busy ? 'Signing in…' : 'Sign in'}{!busy && <ArrowRight />}
          </Button>
          <div className="relative py-1 text-center text-xs text-muted-foreground">
            <span className="relative z-10 bg-background px-3">New to COGNIEOS?</span>
            <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
          </div>
          <Button asChild variant="outline" size="lg" className="h-11">
            <Link to="/register" className="hover:no-underline">Register your company</Link>
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Platform owner? <Link to="/super-admin" className="font-medium">Open the admin console</Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
