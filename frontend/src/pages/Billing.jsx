import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Check, Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { get, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useAsync } from '../lib/hooks.js';
import { dateTime, label, money } from '../lib/format.js';
import { limitText, priceLabel, startCheckout } from '../lib/checkout.js';
import {
  ConfirmDialog, DataTable, ErrorAlert, Field, Modal, Skeleton, StatusBadge, UsageBar,
} from '../components/ui.jsx';
import { toast } from '../lib/toast.js';

const USAGE_ROWS = [['users', 'Users'], ['customers', 'Customers'], ['leads', 'Leads'], ['deals', 'Deals'], ['storageMb', 'Storage (MB)'], ['apiCalls', 'API calls this month'], ['automations', 'Automations']];

function UpgradeModal({ plan, providers, onClose, onDone }) {
  const [cycle, setCycle] = useState('monthly');
  const [provider, setProvider] = useState(providers[0] || '');
  const [coupon, setCoupon] = useState('');
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    post('/billing/quote', { planCode: plan.code, billingCycle: cycle, couponCode: coupon || undefined })
      .then((q) => alive && (setQuote(q), setError(null)))
      .catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, [plan.code, cycle, coupon]);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      await startCheckout({ planCode: plan.code, billingCycle: cycle, provider, couponCode: coupon });
      toast(`${plan.name} plan is active`);
      onDone();
    } catch (e) {
      if (e.code !== 'CANCELLED') setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Upgrade to ${plan.name}`} onClose={onClose} footer={(
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !quote || (!providers.length && quote.total > 0)} onClick={pay}>
          {busy ? 'Processing…' : quote?.total === 0 ? 'Activate' : `Pay ${money(quote?.total, quote?.currency)}`}
        </button>
      </>
    )}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="row">
          <button type="button" className={`btn btn-sm ${cycle === 'monthly' ? 'active' : ''}`} onClick={() => setCycle('monthly')}>Monthly</button>
          <button type="button" className={`btn btn-sm ${cycle === 'yearly' ? 'active' : ''}`} onClick={() => setCycle('yearly')}>Yearly</button>
        </div>
        <Field label="Coupon code"><input className="input" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} placeholder="Optional" /></Field>
        {providers.length > 1 && (
          <Field label="Pay with">
            <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((p) => <option key={p} value={p}>{label(p)}</option>)}
            </select>
          </Field>
        )}
        {!providers.length && <div className="alert alert-warning">Online payments are not configured on this platform yet. Contact support to upgrade.</div>}
        {quote && (
          <dl className="kv">
            <dt>Price</dt><dd>{money(quote.price, quote.currency)}</dd>
            {quote.discount > 0 && <><dt>Discount</dt><dd>− {money(quote.discount, quote.currency)}</dd></>}
            <dt>Total</dt><dd>{money(quote.total, quote.currency)}</dd>
          </dl>
        )}
        <p className="small muted" style={{ margin: 0 }}>Your plan changes only after the payment is verified by our server.</p>
      </div>
    </Modal>
  );
}

export function Billing() {
  const { can, refresh } = useAuth();
  const manage = can('billing:manage');
  const overview = useAsync(() => get('/billing'), []);
  const plans = useAsync(() => get('/plans'), []);
  const invoices = useAsync(() => (manage ? get('/billing/invoices') : Promise.resolve({ items: [] })), [manage]);
  const payments = useAsync(() => (manage ? get('/billing/payments') : Promise.resolve({ items: [] })), [manage]);
  const [upgrade, setUpgrade] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [error, setError] = useState(null);
  const [params, setParams] = useSearchParams();
  const verifying = useRef(false);

  const reloadAll = () => { overview.reload(); invoices.reload(); payments.reload(); refresh(); };

  // Returning from Stripe Checkout: verify the session server-side (the webhook also confirms it)
  useEffect(() => {
    const paymentId = params.get('payment');
    if (!paymentId || verifying.current) return;
    verifying.current = true;
    if (params.get('cancelled')) {
      toast('Payment cancelled', 'error');
      setParams({});
      return;
    }
    post('/billing/verify', { paymentId, sessionId: params.get('session_id') })
      .then(() => { toast('Payment verified — plan activated'); reloadAll(); })
      .catch(setError)
      .finally(() => setParams({}));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = (path, body) => async () => {
    await post(path, body);
    toast('Subscription updated');
    reloadAll();
  };

  const d = overview.data;
  const sub = d?.subscription;
  if (!d) return overview.error ? <ErrorAlert error={overview.error} /> : <Skeleton rows={6} />;

  const trial = sub?.status === 'trial';
  const ends = trial ? sub.trialEnd : sub?.endDate;
  const POPULAR = 'PROFESSIONAL';

  return (
    <div className="flex flex-col gap-6">
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div><h1>Billing & subscription</h1><p>Your plan, usage, invoices and payments.</p></div>
      </div>
      <ErrorAlert error={error} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        {/* Current plan hero */}
        <section className="relative overflow-hidden rounded-2xl border bg-sidebar p-6 text-sidebar-foreground shadow-pop xl:col-span-2">
          <div className="pointer-events-none absolute -right-20 -top-20 size-64 rounded-full bg-chart-1/40 blur-[70px]" />
          <div className="pointer-events-none absolute -bottom-24 -left-10 size-56 rounded-full bg-chart-2/25 blur-[70px]" />
          <div className="relative flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/60">Current plan</p>
              <h2 className="mt-1 font-[family-name:var(--font-display)] text-3xl font-extrabold text-sidebar-accent-foreground">{d.plan?.name || '—'}</h2>
            </div>
            {sub && <StatusBadge status={trial ? 'trial' : sub.status === 'active' ? 'active' : 'expired'} text={label(sub.status)} />}
          </div>
          <div className="relative mt-4 font-[family-name:var(--font-display)] text-2xl font-bold text-sidebar-accent-foreground">
            {d.plan ? (d.price ? <>{money(d.price, d.plan.currency)}<span className="text-sm font-medium text-sidebar-foreground/60"> / {sub?.billingCycle === 'yearly' ? 'year' : 'month'}</span></> : priceLabel(d.plan)) : '—'}
          </div>
          {!d.premium && d.effectivePlanCode && d.effectivePlanCode !== d.plan?.code && (
            <p className="relative mt-2 text-sm text-[color-mix(in_oklch,var(--chart-4)_80%,white)]">Running on {d.effectivePlanCode} features until you renew.</p>
          )}
          <dl className="relative mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div><dt className="text-sidebar-foreground/55">Billing cycle</dt><dd className="font-medium text-sidebar-accent-foreground">{label(sub?.billingCycle || '—')}</dd></div>
            <div><dt className="text-sidebar-foreground/55">Started</dt><dd className="font-medium text-sidebar-accent-foreground">{sub?.startDate ? new Date(sub.startDate).toLocaleDateString() : '—'}</dd></div>
            <div><dt className="text-sidebar-foreground/55">{trial ? 'Trial ends' : sub?.cancelAtPeriodEnd ? 'Access until' : 'Renews'}</dt><dd className="font-medium text-sidebar-accent-foreground">{ends ? new Date(ends).toLocaleDateString() : 'No expiry'}</dd></div>
            <div><dt className="text-sidebar-foreground/55">Remaining</dt><dd className="font-medium text-sidebar-accent-foreground">{sub?.daysLeft != null ? `${sub.daysLeft} days` : '—'}</dd></div>
          </dl>
          {trial && sub.daysLeft != null && (
            <div className="relative mt-5">
              <div className="h-2 overflow-hidden rounded-full bg-sidebar-border">
                <div className="h-full rounded-full bg-gradient-to-r from-sidebar-primary to-chart-2" style={{ width: `${Math.max(4, Math.min(100, (sub.daysLeft / 14) * 100))}%` }} />
              </div>
              <p className="mt-2 text-xs text-sidebar-foreground/60">Trial progress · pick a plan any time, your data stays.</p>
            </div>
          )}
          {manage && (
            <div className="relative mt-6 flex flex-wrap gap-2">
              {sub?.status === 'cancelled' && sub.endDate && new Date(sub.endDate) > new Date()
                ? <Button variant="secondary" onClick={act('/billing/resume')}>Resume subscription</Button>
                : ['active', 'trial', 'past_due'].includes(sub?.status) && d.plan?.code !== 'FREE' && (
                  <Button variant="ghost" className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" onClick={() => setConfirm({ title: 'Cancel subscription', message: 'Paid features stay on until the end of the current period. Your data is kept.', confirmLabel: 'Cancel subscription', danger: true, onConfirm: act('/billing/cancel') })}>Cancel subscription</Button>
                )}
            </div>
          )}
        </section>

        {/* Usage */}
        <section className="card p-6 xl:col-span-3">
          <div className="mb-5 flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary"><Gauge className="size-4" /></span>
            <h3 className="flex-1">Usage this month</h3>
            <span className="rounded-full bg-muted px-2.5 py-0.5 font-mono text-xs text-muted-foreground">{d.usage.period}</span>
          </div>
          <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
            {USAGE_ROWS.map(([k, text]) => <UsageBar key={k} label={text} used={d.usage[k].used} limit={d.usage[k].limit} />)}
          </div>
        </section>
      </div>

      {/* Plans */}
      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-xl">Plans that scale with you</h2>
            <p className="text-sm text-muted-foreground">Upgrade or downgrade any time. Paid plans activate only after a verified payment.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {plans.data?.items.map((p) => {
            const current = p.code === d.plan?.code && d.premium;
            const free = !p.isCustom && !p.priceMonthly;
            const popular = p.code === POPULAR;
            return (
              <div key={p.code} className={`relative flex flex-col rounded-2xl border bg-card p-5 shadow-soft transition-all hover:-translate-y-1 hover:shadow-pop ${popular ? 'border-primary/60 ring-4 ring-primary/10' : ''} ${current ? 'border-success/60' : ''}`}>
                {popular && <span className="absolute -top-3 left-5 rounded-full bg-gradient-to-r from-chart-1 to-chart-2 px-3 py-0.5 text-[11px] font-bold text-white shadow-md">Most popular</span>}
                <div className="flex items-center justify-between gap-2">
                  <span className="font-[family-name:var(--font-display)] text-lg font-bold">{p.name}</span>
                  {current && <span className="rounded-full bg-success/12 px-2 py-0.5 text-[11px] font-semibold text-success">Current</span>}
                </div>
                <p className="mt-1 min-h-10 text-xs text-muted-foreground">{p.description}</p>
                <div className="mt-3 font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight">
                  {p.isCustom ? 'Custom' : free ? 'Free' : money(p.priceMonthly, p.currency)}
                  {!p.isCustom && !free && <span className="text-sm font-medium text-muted-foreground"> /mo</span>}
                </div>
                {!p.isCustom && !free && <p className="text-xs text-muted-foreground">or {money(p.priceYearly, p.currency)} billed yearly</p>}
                <ul className="mt-4 flex flex-1 flex-col gap-2 text-sm">
                  <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />{limitText(p.limits?.users)} users</li>
                  <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />{limitText(p.limits?.leads)} leads</li>
                  <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />{limitText(p.limits?.customers)} customers</li>
                  <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />{p.modules.includes('*') ? 'Every module' : `${p.modules.length} modules`}</li>
                </ul>
                {manage && !current && (
                  <div className="mt-5">
                    {p.isCustom
                      ? <Button asChild variant="outline" className="w-full"><a href="mailto:sales@cognieos.com" className="hover:no-underline">Contact sales</a></Button>
                      : free
                        ? <Button variant="outline" className="w-full" onClick={() => setConfirm({ title: `Switch to ${p.name}`, message: `Features outside the ${p.name} plan will be switched off now. Your data is kept.`, confirmLabel: 'Switch plan', onConfirm: act('/billing/change-plan', { planCode: p.code }) })}>Downgrade</Button>
                        : <Button className="w-full" variant={popular ? 'default' : 'secondary'} onClick={() => setUpgrade(p)}>{d.plan && p.priceMonthly < (d.plan.priceMonthly || 0) ? 'Downgrade' : 'Upgrade'}<ArrowUpRight /></Button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {manage && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <section className="card overflow-hidden">
            <div className="card-header"><h3>Invoices</h3></div>
            <DataTable rows={invoices.data?.items} empty="No invoices yet." columns={[
              { key: 'number', label: 'Number', render: (i) => <span className="font-mono text-xs">{i.number}</span> },
              { key: 'issuedAt', label: 'Date', render: (i) => dateTime(i.issuedAt) },
              { key: 'planCode', label: 'Plan' },
              { key: 'total', label: 'Total', render: (i) => money(i.total, i.currency) },
              { key: 'status', label: 'Status', render: (i) => <StatusBadge status={i.status} /> },
            ]} />
          </section>
          <section className="card overflow-hidden">
            <div className="card-header"><h3>Payment history</h3></div>
            <DataTable rows={payments.data?.items} empty="No payments yet." columns={[
              { key: 'createdAt', label: 'Date', render: (p) => dateTime(p.createdAt) },
              { key: 'planCode', label: 'Plan' },
              { key: 'provider', label: 'Via', render: (p) => label(p.provider) },
              { key: 'amount', label: 'Amount', render: (p) => money(p.amount, p.currency) },
              { key: 'status', label: 'Status', render: (p) => <StatusBadge status={p.status === 'success' ? 'paid' : p.status} text={label(p.status)} /> },
            ]} />
          </section>
        </div>
      )}
      {upgrade && <UpgradeModal plan={upgrade} providers={d.providers} onClose={() => setUpgrade(null)} onDone={() => { setUpgrade(null); reloadAll(); }} />}
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
