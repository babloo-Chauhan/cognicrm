import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';

/**
 * The hosted lead form (/f/:token): no sign-in. Companies share the link or embed it (?embed=1 drops the page
 * background). Submissions go to the same capture address as any website form.
 */
export function PublicForm() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const embed = params.get('embed') === '1';
  const [form, setForm] = useState(null);
  const [missing, setMissing] = useState(false);
  const [values, setValues] = useState({});
  const [state, setState] = useState('idle'); // idle | sending | done
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/capture/form/${token}`).then(setForm, () => setMissing(true));
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    setState('sending');
    setError('');
    try {
      // UTM tags on the form link (from an ad or post) are kept on the lead
      const utm = Object.fromEntries([...params.entries()].filter(([k]) => k.startsWith('utm_')));
      await api(`/capture/${token}`, { method: 'POST', body: { ...values, ...utm } });
      if (form.redirectUrl) window.top.location.href = form.redirectUrl;
      else setState('done');
    } catch (err) {
      setError(err.message || 'Could not send. Please try again.');
      setState('idle');
    }
  };

  const shell = (children) => (
    <div className={embed ? 'p-4' : 'grid min-h-screen place-items-center bg-muted/40 p-4'}>
      <div className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-soft">{children}</div>
    </div>
  );
  if (missing) return shell(<p className="m-0 text-center text-sm text-muted-foreground">This form is no longer available.</p>);
  if (!form) return shell(<p className="m-0 text-center text-sm text-muted-foreground">Loading…</p>);
  if (state === 'done') {
    return shell(
      <div className="py-6 text-center">
        <div className="text-4xl text-success">✓</div>
        <h1 className="mt-2 text-xl">{form.thankYou}</h1>
      </div>,
    );
  }
  return shell(
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        {form.company && <div className="text-xs font-semibold uppercase tracking-wider text-primary">{form.company}</div>}
        <h1 className="m-0 text-2xl">{form.title}</h1>
        {form.intro && <p className="mb-0 mt-1 text-sm text-muted-foreground">{form.intro}</p>}
      </div>
      {form.fields.map((f) => (
        <label key={f.key} className="field">
          <span>{f.label}{f.required && <span className="text-destructive"> *</span>}</span>
          {f.key === 'requirement'
            ? <textarea className="input min-h-24" required={f.required} value={values[f.key] || ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            : <input className="input" required={f.required} type={f.key === 'email' ? 'email' : f.key === 'phone' ? 'tel' : 'text'} inputMode={f.key === 'phone' ? 'tel' : undefined}
              autoComplete={{ name: 'name', phone: 'tel', email: 'email', company: 'organization', city: 'address-level2' }[f.key]} value={values[f.key] || ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />}
        </label>
      ))}
      {/* Honeypot: hidden from people, filled by bots */}
      <input name="_gotcha" tabIndex={-1} autoComplete="off" className="hidden" value={values._gotcha || ''} onChange={(e) => setValues({ ...values, _gotcha: e.target.value })} aria-hidden="true" />
      {error && <div className="text-sm text-destructive" role="alert">{error}</div>}
      <button type="submit" className="btn btn-primary" disabled={state === 'sending'}>{state === 'sending' ? 'Sending…' : 'Send'}</button>
    </form>,
  );
}
