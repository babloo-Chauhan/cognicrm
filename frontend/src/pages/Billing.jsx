import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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

  return (
    <>
      <div className="page-header">
        <div><h1>Billing & subscription</h1><p>Your plan, usage and invoices.</p></div>
      </div>
      <ErrorAlert error={error} />
      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-header"><h3>Current plan</h3>{sub && <StatusBadge status={sub.status === 'trial' ? 'pending' : sub.status === 'active' ? 'active' : 'expired'} text={label(sub.status)} />}</div>
          <div className="card-body stack">
            <dl className="kv">
              <dt>Plan</dt><dd>{d.plan?.name || '—'}{!d.premium && d.effectivePlanCode && d.effectivePlanCode !== d.plan?.code ? ` (running on ${d.effectivePlanCode} features)` : ''}</dd>
              <dt>Price</dt><dd>{d.plan ? (d.price ? `${money(d.price, d.plan.currency)} / ${sub?.billingCycle === 'yearly' ? 'year' : 'month'}` : priceLabel(d.plan)) : '—'}</dd>
              <dt>Billing cycle</dt><dd>{label(sub?.billingCycle || '—')}</dd>
              <dt>Start date</dt><dd>{dateTime(sub?.startDate)}</dd>
              <dt>{sub?.status === 'trial' ? 'Trial ends' : sub?.cancelAtPeriodEnd ? 'Access until' : 'Renewal date'}</dt>
              <dd>{sub?.status === 'trial' ? dateTime(sub.trialEnd) : sub?.endDate ? dateTime(sub.endDate) : 'No expiry'}</dd>
              {sub?.daysLeft != null && <><dt>Remaining</dt><dd>{sub.daysLeft} days</dd></>}
            </dl>
            {manage && (
              <div className="row">
                {sub?.status === 'cancelled' && sub.endDate && new Date(sub.endDate) > new Date()
                  ? <button type="button" className="btn" onClick={act('/billing/resume')}>Resume subscription</button>
                  : ['active', 'trial', 'past_due'].includes(sub?.status) && d.plan?.code !== 'FREE' && (
                    <button type="button" className="btn btn-danger" onClick={() => setConfirm({ title: 'Cancel subscription', message: 'Paid features stay on until the end of the current period. Your data is kept.', confirmLabel: 'Cancel subscription', danger: true, onConfirm: act('/billing/cancel') })}>Cancel subscription</button>
                  )}
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-header"><h3>Usage</h3><span className="small muted">{d.usage.period}</span></div>
          <div className="card-body stack">
            {USAGE_ROWS.map(([k, text]) => <UsageBar key={k} label={text} used={d.usage[k].used} limit={d.usage[k].limit} />)}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header"><h3>Plans</h3></div>
        <div className="card-body">
          <div className="plan-grid">
            {plans.data?.items.map((p) => {
              const current = p.code === d.plan?.code && d.premium;
              const free = !p.isCustom && !p.priceMonthly;
              return (
                <div key={p.code} className={`plan-card ${current ? 'current' : ''}`}>
                  <strong>{p.name} {current && <span className="badge badge-info">Current</span>}</strong>
                  <span className="price">{priceLabel(p)}</span>
                  <span className="small muted">{p.description}</span>
                  <ul>
                    <li>{limitText(p.limits?.users)} users</li>
                    <li>{limitText(p.limits?.leads)} leads · {limitText(p.limits?.customers)} customers</li>
                    <li>{p.modules.includes('*') ? 'All modules' : p.modules.map(label).join(', ')}</li>
                  </ul>
                  {manage && !current && (p.isCustom
                    ? <a className="btn btn-sm" href="mailto:sales@cognieos.com">Contact sales</a>
                    : free
                      ? <button type="button" className="btn btn-sm" onClick={() => setConfirm({ title: `Switch to ${p.name}`, message: `Features outside the ${p.name} plan will be switched off now. Your data is kept.`, confirmLabel: 'Switch plan', onConfirm: act('/billing/change-plan', { planCode: p.code }) })}>Downgrade</button>
                      : <button type="button" className="btn btn-sm btn-primary" onClick={() => setUpgrade(p)}>{d.plan && p.priceMonthly < (d.plan.priceMonthly || 0) ? 'Downgrade' : 'Upgrade'}</button>)}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {manage && (
        <div className="grid grid-2">
          <div className="card">
            <div className="card-header"><h3>Invoices</h3></div>
            <DataTable rows={invoices.data?.items} empty="No invoices yet." columns={[
              { key: 'number', label: 'Number' },
              { key: 'issuedAt', label: 'Date', render: (i) => dateTime(i.issuedAt) },
              { key: 'planCode', label: 'Plan' },
              { key: 'total', label: 'Total', render: (i) => money(i.total, i.currency) },
              { key: 'status', label: 'Status', render: (i) => <StatusBadge status={i.status} /> },
            ]} />
          </div>
          <div className="card">
            <div className="card-header"><h3>Payment history</h3></div>
            <DataTable rows={payments.data?.items} empty="No payments yet." columns={[
              { key: 'createdAt', label: 'Date', render: (p) => dateTime(p.createdAt) },
              { key: 'planCode', label: 'Plan' },
              { key: 'provider', label: 'Via', render: (p) => label(p.provider) },
              { key: 'amount', label: 'Amount', render: (p) => money(p.amount, p.currency) },
              { key: 'status', label: 'Status', render: (p) => <StatusBadge status={p.status === 'success' ? 'paid' : p.status} text={label(p.status)} /> },
            ]} />
          </div>
        </div>
      )}
      {upgrade && <UpgradeModal plan={upgrade} providers={d.providers} onClose={() => setUpgrade(null)} onDone={() => { setUpgrade(null); reloadAll(); }} />}
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}
