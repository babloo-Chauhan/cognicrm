import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  Activity, AlarmClock, Ban, BadgeCheck, Blocks, Building2, CreditCard, FlaskConical, Gauge, IndianRupee, KeyRound, LayoutDashboard,
  Layers, LogOut, Mail, Menu, Receipt, Repeat, Settings, ShieldCheck, Tag, TimerOff, TrendingUp, Users, Wallet,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { AuthShell } from '../../components/AuthShell.jsx';
import {
  pdel, pget, platformToken, ppatch, ppost, pput,
} from '../../lib/api.js';
import { useAsync } from '../../lib/hooks.js';
import { dateTime, label, money } from '../../lib/format.js';
import { limitText } from '../../lib/checkout.js';
import {
  ConfirmDialog, DataTable, ErrorAlert, Field, Modal, Pagination, Skeleton, Stat, StatusBadge, Tabs, UsageBar,
} from '../../components/ui.jsx';
import { toast } from '../../lib/toast.js';

const NAV = [
  { group: 'Overview', items: [['', 'Dashboard', LayoutDashboard]] },
  { group: 'Tenants', items: [['companies', 'Companies', Building2], ['subscriptions', 'Subscriptions', Repeat], ['users', 'Users', Users]] },
  { group: 'Revenue', items: [['plans', 'Plans', Layers], ['payments', 'Payments', CreditCard], ['invoices', 'Invoices', Receipt], ['coupons', 'Coupons', Tag]] },
  { group: 'Platform', items: [['usage', 'Usage', Activity], ['modules', 'Modules & features', Blocks], ['audit', 'Audit logs', ShieldCheck], ['system', 'System settings', Settings]] },
];
const SUB_STATUSES = ['trial', 'active', 'past_due', 'cancelled', 'expired', 'suspended'];
const subTone = (s) => ({ trial: 'pending', active: 'active', past_due: 'overdue', cancelled: 'canceled', expired: 'expired', suspended: 'closed' }[s] || s);

function PlatformLogin({ onLogin }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await ppost('/auth/login', form);
      platformToken.set(res.token);
      onLogin(res.admin);
    } catch (err) { setError(err); }
  };
  return (
    <AuthShell eyebrow="COGNIEOS Platform">
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary"><ShieldCheck className="size-3.5" />Platform owner</span>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight">Super admin console</h1>
          <p className="mt-2 text-muted-foreground">Manage every company, plan and payment on the platform.</p>
        </div>
        <ErrorAlert error={error} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="sa-email">Email</Label>
          <div className="relative"><Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input id="sa-email" className="h-11 pl-10" type="email" required autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="sa-password">Password</Label>
          <div className="relative"><KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input id="sa-password" className="h-11 pl-10" type="password" required autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
        </div>
        <Button type="submit" size="lg" className="h-11 shadow-[0_10px_24px_-10px_var(--primary)]">Sign in</Button>
        <Link className="text-center text-sm" to="/">← Company login</Link>
      </form>
    </AuthShell>
  );
}

const TOOLTIP_STYLE = { background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--popover-foreground)', fontSize: 12 };
const shortMonth = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short' });

function Chart({ title, data, dataKey, kind = 'area', format, color = 'var(--chart-1)', icon: Icon, total }) {
  const id = `g-${dataKey}`;
  const axis = { tickLine: false, axisLine: false, fontSize: 11, stroke: 'var(--muted-foreground)' };
  return (
    <section className="card overflow-hidden">
      <header className="flex items-center gap-2 border-b px-5 py-3.5">
        {Icon && <span className="grid size-7 place-items-center rounded-lg" style={{ background: `color-mix(in oklch, ${color} 14%, transparent)`, color }}><Icon className="size-4" /></span>}
        <h3 className="flex-1">{title}</h3>
        {total != null && <span className="font-[family-name:var(--font-display)] text-sm font-bold">{total}</span>}
      </header>
      <div className="h-[230px] px-2 pb-2 pt-4">
        <ResponsiveContainer width="100%" height="100%">
          {kind === 'bar' ? (
            <BarChart data={data} margin={{ left: -12, right: 8 }}>
              <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.95} /><stop offset="100%" stopColor={color} stopOpacity={0.4} /></linearGradient></defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tickFormatter={shortMonth} {...axis} />
              <YAxis allowDecimals={false} tickFormatter={format} {...axis} />
              <Tooltip formatter={format} labelFormatter={shortMonth} contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--accent)', opacity: 0.5 }} />
              <Bar dataKey={dataKey} fill={`url(#${id})`} radius={[6, 6, 2, 2]} maxBarSize={28} />
            </BarChart>
          ) : (
            <AreaChart data={data} margin={{ left: -12, right: 8 }}>
              <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.35} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tickFormatter={shortMonth} {...axis} />
              <YAxis allowDecimals={false} tickFormatter={format} {...axis} />
              <Tooltip formatter={format} labelFormatter={shortMonth} contentStyle={TOOLTIP_STYLE} />
              <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2.5} fill={`url(#${id})`} dot={false} activeDot={{ r: 4 }} />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function Dashboard() {
  const { data, error } = useAsync(() => pget('/dashboard'), []);
  if (!data) return error ? <ErrorAlert error={error} /> : <Skeleton rows={8} />;
  const c = data.cards;
  const fill = (rows, key) => rows.map((r) => ({ ...r, [key]: r[key] || 0 }));
  return (
    <>
      <section className="relative mb-6 overflow-hidden rounded-2xl border bg-sidebar p-6 text-sidebar-foreground shadow-pop sm:p-8">
        <div className="pointer-events-none absolute -right-16 -top-24 size-80 rounded-full bg-chart-1/40 blur-[80px]" />
        <div className="pointer-events-none absolute -bottom-28 left-1/4 size-72 rounded-full bg-chart-3/20 blur-[80px]" />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/60">Platform overview</p>
            <h1 className="mt-1 text-3xl font-extrabold text-sidebar-accent-foreground">{c.totalCompanies} companies · {c.totalUsers} users</h1>
            <p className="mt-2 text-sm text-sidebar-foreground/70">{c.trialCompanies} on trial, {c.activeSubscriptions} paying, {c.expiringSubscriptions} expiring this week.</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-sidebar-foreground/60">Revenue this month</p>
            <p className="bg-gradient-to-r from-sidebar-primary to-chart-2 bg-clip-text font-[family-name:var(--font-display)] text-4xl font-extrabold text-transparent">{money(c.monthlyRevenue)}</p>
          </div>
        </div>
      </section>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat icon={Building2} tone="primary" label="Total companies" value={c.totalCompanies} hint={`${c.pendingCompanies} pending approval`} />
        <Stat icon={BadgeCheck} tone="teal" label="Active companies" value={c.activeCompanies} />
        <Stat icon={FlaskConical} tone="sky" label="Trial companies" value={c.trialCompanies} />
        <Stat icon={TimerOff} tone="rose" label="Expired companies" value={c.expiredCompanies} />
        <Stat icon={Ban} tone="rose" label="Suspended" value={c.suspendedCompanies} />
        <Stat icon={Users} tone="primary" label="Total users" value={c.totalUsers} />
        <Stat icon={IndianRupee} tone="amber" label="Monthly revenue" value={money(c.monthlyRevenue)} />
        <Stat icon={Wallet} tone="amber" label="Annual revenue" value={money(c.annualRevenue)} hint="This calendar year" />
        <Stat icon={Repeat} tone="teal" label="Active subscriptions" value={c.activeSubscriptions} />
        <Stat icon={AlarmClock} tone="sky" label="Expiring in 7 days" value={c.expiringSubscriptions} />
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Chart title="Revenue" icon={IndianRupee} color="var(--chart-1)" data={fill(data.charts.revenue, 'revenue')} dataKey="revenue" kind="bar" format={(v) => money(v)} />
        <Chart title="New companies" icon={Building2} color="var(--chart-2)" data={fill(data.charts.newCompanies, 'companies')} dataKey="companies" kind="bar" />
        <Chart title="User growth" icon={Users} color="var(--chart-5)" data={fill(data.charts.userGrowth, 'users')} dataKey="users" />
        <Chart title="Subscription upgrades" icon={TrendingUp} color="var(--chart-2)" data={fill(data.charts.subscriptionGrowth, 'subscriptions')} dataKey="subscriptions" />
        <Chart title="Churn (cancelled + expired)" icon={TimerOff} color="var(--chart-4)" data={fill(data.charts.churn, 'churned')} dataKey="churned" kind="bar" />
        <Chart title="API usage" icon={Gauge} color="var(--chart-3)" data={fill(data.charts.usage, 'apiCalls')} dataKey="apiCalls" />
      </div>
    </>
  );
}

function CreateCompanyModal({ plans, onClose, onCreated }) {
  const [form, setForm] = useState({ companyName: '', email: '', adminName: '', adminEmail: '', password: '', planCode: 'PROFESSIONAL', trial: true });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const save = async () => {
    setError(null);
    try {
      const res = await ppost('/companies', form);
      toast(`Created ${res.company.companyCode}`);
      onCreated(res.company);
    } catch (e) { setError(e); }
  };
  return (
    <Modal title="Create company" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Create</button></>}>
      <ErrorAlert error={error} />
      <div className="form-grid">
        <Field label="Company name"><input className="input" value={form.companyName} onChange={set('companyName')} /></Field>
        <Field label="Business email"><input className="input" type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Admin name"><input className="input" value={form.adminName} onChange={set('adminName')} /></Field>
        <Field label="Admin email"><input className="input" type="email" value={form.adminEmail} onChange={set('adminEmail')} /></Field>
        <Field label="Admin password"><input className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} /></Field>
        <Field label="Plan">
          <select className="input" value={form.planCode} onChange={set('planCode')}>{plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
        </Field>
        <label className="checkbox"><input type="checkbox" checked={form.trial} onChange={(e) => setForm({ ...form, trial: e.target.checked })} /> Start as trial (paid plans)</label>
      </div>
    </Modal>
  );
}

function Companies({ subscriptionsView }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const query = { q: params.get('q'), status: params.get('status'), subscriptionStatus: params.get('subscriptionStatus'), plan: params.get('plan'), page: params.get('page') || 1 };
  const list = useAsync(() => pget('/companies', query), [JSON.stringify(query)]);
  const plans = useAsync(() => pget('/plans'), []);
  const [creating, setCreating] = useState(false);
  const setParam = (k, v) => { const next = new URLSearchParams(params); if (v) next.set(k, v); else next.delete(k); next.delete('page'); setParams(next); };
  return (
    <>
      <div className="page-header">
        <div><h1>{subscriptionsView ? 'Subscriptions' : 'Companies'}</h1><p>{list.data?.total ?? '…'} companies</p></div>
        {!subscriptionsView && <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>+ Create company</button>}
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <form role="search" onSubmit={(e) => { e.preventDefault(); setParam('q', q); }}><input className="input search-input" type="search" placeholder="Name, email, CMP-…, TEN-…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search companies" /></form>
        <select className="input" style={{ width: 160 }} value={query.status || ''} onChange={(e) => setParam('status', e.target.value)} aria-label="Company status">
          <option value="">Any status</option>{['active', 'pending', 'suspended'].map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
        <select className="input" style={{ width: 170 }} value={query.subscriptionStatus || ''} onChange={(e) => setParam('subscriptionStatus', e.target.value)} aria-label="Subscription status">
          <option value="">Any subscription</option>{SUB_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
        <select className="input" style={{ width: 160 }} value={query.plan || ''} onChange={(e) => setParam('plan', e.target.value)} aria-label="Plan">
          <option value="">Any plan</option>{plans.data?.items.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
        </select>
      </div>
      <ErrorAlert error={list.error} />
      <div className="card">
        {!list.data ? <div className="card-body"><Skeleton /></div> : (
          <>
            <DataTable rows={list.data.items} onRowClick={(c) => navigate(`/super-admin/companies/${c.id}`)} empty="No companies match." columns={[
              { key: 'name', label: 'Company', render: (c) => <><strong>{c.name}</strong><div className="small muted mono">{c.companyCode} · {c.tenantId}</div></> },
              { key: 'email', label: 'Email' },
              { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status === 'suspended' ? 'closed' : c.status} text={label(c.status)} /> },
              { key: 'plan', label: 'Plan', render: (c) => c.subscription?.planCode || '—' },
              { key: 'sub', label: 'Subscription', render: (c) => (c.subscription ? <StatusBadge status={subTone(c.subscription.status)} text={label(c.subscription.status)} /> : '—') },
              { key: 'ends', label: 'Ends', render: (c) => (c.subscription ? (c.subscription.daysLeft != null ? `${c.subscription.daysLeft}d` : 'Never') : '—') },
              { key: 'users', label: 'Users' },
              { key: 'createdAt', label: 'Created', render: (c) => dateTime(c.createdAt) },
            ]} />
            <Pagination page={list.data.page} limit={list.data.limit} total={list.data.total} onChange={(p) => { const n = new URLSearchParams(params); n.set('page', p); setParams(n); }} />
          </>
        )}
      </div>
      {creating && <CreateCompanyModal plans={plans.data?.items || []} onClose={() => setCreating(false)} onCreated={(c) => navigate(`/super-admin/companies/${c.id}`)} />}
    </>
  );
}

function CompanyDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const detail = useAsync(() => pget(`/companies/${id}`), [id]);
  const users = useAsync(() => pget(`/companies/${id}/users`), [id]);
  const plans = useAsync(() => pget('/plans'), []);
  const modules = useAsync(() => pget('/modules'), []);
  const [tab, setTab] = useState('overview');
  const [confirm, setConfirm] = useState(null);
  const [subForm, setSubForm] = useState(null);
  const [overrides, setOverrides] = useState(null);
  const [error, setError] = useState(null);

  if (!detail.data) return detail.error ? <ErrorAlert error={detail.error} /> : <Skeleton rows={8} />;
  const { company: c, subscription: s, usage, recentAudit, payments } = detail.data;
  const run = (fn, msg) => async () => { setError(null); try { await fn(); toast(msg); detail.reload(); } catch (e) { setError(e); } };
  const mo = overrides || c.moduleOverrides || { enabled: [], disabled: [] };
  const planModules = plans.data?.items.find((p) => p.code === s?.planCode)?.modules || [];
  const inPlan = (m) => planModules.includes('*') || planModules.includes(m);
  const moduleState = (m) => (mo.disabled.includes(m) ? 'off' : mo.enabled.includes(m) ? 'on' : 'plan');
  const setModule = (m, state) => setOverrides({
    enabled: state === 'on' ? [...new Set([...mo.enabled, m])] : mo.enabled.filter((x) => x !== m),
    disabled: state === 'off' ? [...new Set([...mo.disabled, m])] : mo.disabled.filter((x) => x !== m),
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{c.name} <StatusBadge status={c.status === 'suspended' ? 'closed' : c.status} text={label(c.status)} /></h1>
          <p className="mono">{c.companyCode} · {c.tenantId}</p>
        </div>
        <div className="row">
          {c.status === 'pending' && <button type="button" className="btn btn-success" onClick={run(() => ppost(`/companies/${id}/approve`), 'Company approved')}>Approve</button>}
          {c.status === 'suspended'
            ? <button type="button" className="btn" onClick={run(() => ppost(`/companies/${id}/activate`), 'Company activated')}>Activate</button>
            : <button type="button" className="btn" onClick={() => setConfirm({ title: 'Suspend company', message: 'All users are signed out and blocked until the company is activated. Data is kept.', confirmLabel: 'Suspend', danger: true, onConfirm: run(() => ppost(`/companies/${id}/suspend`, { reason: 'Suspended by platform' }), 'Company suspended') })}>Suspend</button>}
          <button type="button" className="btn btn-danger" onClick={() => setConfirm({ title: 'Delete company', message: `Permanently deletes ${c.name} and all of its data. This cannot be undone.`, confirmLabel: 'Delete forever', danger: true, confirmText: c.companyCode, onConfirm: async () => { await pdel(`/companies/${id}`, { confirm: c.companyCode }); toast('Company deleted'); navigate('/super-admin/companies'); } })}>Delete</button>
        </div>
      </div>
      <ErrorAlert error={error} />
      <Tabs tabs={[{ key: 'overview', label: 'Overview' }, { key: 'subscription', label: 'Subscription' }, { key: 'modules', label: 'Modules' }, { key: 'users', label: `Users (${users.data?.items.length ?? '…'})` }, { key: 'activity', label: 'Activity' }]} value={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="grid grid-2">
          <div className="card"><div className="card-header"><h3>Company</h3></div><div className="card-body">
            <dl className="kv">
              <dt>Legal name</dt><dd>{c.legalName || '—'}</dd><dt>Email</dt><dd>{c.email || '—'}</dd><dt>Phone</dt><dd>{c.phone || '—'}</dd>
              <dt>Website</dt><dd>{c.website || '—'}</dd><dt>Tax / GST</dt><dd>{c.taxId || '—'}</dd><dt>Industry</dt><dd>{c.industry || '—'}</dd>
              <dt>Address</dt><dd>{[c.address?.line1, c.address?.city, c.address?.state, c.address?.country].filter(Boolean).join(', ') || '—'}</dd>
              <dt>Created</dt><dd>{dateTime(c.createdAt)}</dd>
              {c.suspendedReason && <><dt>Suspended</dt><dd>{c.suspendedReason}</dd></>}
            </dl>
          </div></div>
          <div className="card"><div className="card-header"><h3>Usage ({usage.period})</h3></div><div className="card-body stack">
            {[['users', 'Users'], ['customers', 'Customers'], ['leads', 'Leads'], ['deals', 'Deals'], ['apiCalls', 'API calls'], ['automations', 'Automations']].map(([k, t]) => <UsageBar key={k} label={t} used={usage[k].used} limit={usage[k].limit} />)}
          </div></div>
        </div>
      )}

      {tab === 'subscription' && (
        <div className="grid grid-2">
          <div className="card"><div className="card-header"><h3>Current subscription</h3></div><div className="card-body stack">
            {s ? (
              <dl className="kv">
                <dt>Plan</dt><dd>{s.planCode}</dd><dt>Status</dt><dd><StatusBadge status={subTone(c.subscription?.status)} text={label(c.subscription?.status)} /></dd>
                <dt>Billing cycle</dt><dd>{label(s.billingCycle)}</dd><dt>Start</dt><dd>{dateTime(s.startDate)}</dd>
                <dt>Trial end</dt><dd>{dateTime(s.trialEnd)}</dd><dt>End</dt><dd>{s.endDate ? dateTime(s.endDate) : 'Never'}</dd>
                <dt>Provider</dt><dd>{s.paymentProvider || '—'}</dd><dt>Custom limits</dt><dd>{s.customLimits ? JSON.stringify(s.customLimits) : '—'}</dd>
              </dl>
            ) : <p className="muted">No subscription.</p>}
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => setSubForm({ planCode: s?.planCode || 'FREE', status: 'active', endDate: '' })}>Change plan</button>
              {[7, 30, 365].map((d) => <button key={d} type="button" className="btn" onClick={run(() => ppost(`/companies/${id}/subscription/extend`, { days: d }), `Extended by ${d} days`)}>+{d}d</button>)}
              <button type="button" className="btn btn-danger" onClick={() => setConfirm({ title: 'Cancel subscription', message: 'Cancel immediately? Premium modules switch off now; data is kept.', confirmLabel: 'Cancel now', danger: true, onConfirm: run(() => ppost(`/companies/${id}/subscription/cancel`, { immediate: true }), 'Subscription cancelled') })}>Cancel</button>
            </div>
          </div></div>
          <div className="card"><div className="card-header"><h3>Payments</h3></div>
            <DataTable rows={payments} empty="No payments." columns={[
              { key: 'createdAt', label: 'Date', render: (p) => dateTime(p.createdAt) }, { key: 'planCode', label: 'Plan' },
              { key: 'amount', label: 'Amount', render: (p) => money(p.amount, p.currency) }, { key: 'status', label: 'Status', render: (p) => <StatusBadge status={p.status === 'success' ? 'paid' : p.status} text={label(p.status)} /> },
            ]} />
          </div>
        </div>
      )}

      {tab === 'modules' && (
        <div className="card"><div className="card-header"><h3>Module access</h3><button type="button" className="btn btn-primary btn-sm" disabled={!overrides} onClick={run(async () => { await pput(`/companies/${id}/modules`, mo); setOverrides(null); }, 'Modules saved')}>Save</button></div>
          <DataTable rows={modules.data?.items || []} columns={[
            { key: 'label', label: 'Module' },
            { key: 'plan', label: `In ${s?.planCode || 'plan'}`, render: (m) => (inPlan(m.key) ? '✔' : '—') },
            {
              key: 'state',
              label: 'Access',
              render: (m) => (
                <select className="input" style={{ width: 190 }} value={moduleState(m.key)} onChange={(e) => setModule(m.key, e.target.value)} aria-label={`${m.label} access`}>
                  <option value="plan">Follow plan ({inPlan(m.key) ? 'on' : 'off'})</option><option value="on">Force on</option><option value="off">Force off</option>
                </select>
              ),
            },
          ]} />
        </div>
      )}

      {tab === 'users' && (
        <div className="card"><DataTable rows={users.data?.items} columns={[
          { key: 'name', label: 'Name', render: (u) => <><strong>{u.name}</strong><div className="small muted mono">{u.userCode}</div></> },
          { key: 'email', label: 'Email' }, { key: 'role', label: 'Role', render: (u) => label(u.role) },
          { key: 'lastLogin', label: 'Last login', render: (u) => dateTime(u.lastLogin) },
          { key: 'active', label: 'Status', render: (u) => <StatusBadge status={u.active ? 'active' : 'closed'} text={u.active ? 'Active' : 'Disabled'} /> },
        ]} /></div>
      )}

      {tab === 'activity' && (
        <div className="card"><DataTable rows={recentAudit} empty="No activity." columns={[
          { key: 'createdAt', label: 'When', render: (a) => dateTime(a.createdAt) }, { key: 'action', label: 'Action', render: (a) => <code>{a.action}</code> },
          { key: 'actor', label: 'By', render: (a) => (a.actorType === 'platform' ? 'Platform' : a.userId?.name || label(a.actorType)) }, { key: 'ip', label: 'IP' },
        ]} /></div>
      )}

      {subForm && (
        <Modal title="Change subscription" onClose={() => setSubForm(null)} footer={<><button type="button" className="btn" onClick={() => setSubForm(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={run(async () => { await pput(`/companies/${id}/subscription`, { planCode: subForm.planCode, status: subForm.status, endDate: subForm.endDate || null }); setSubForm(null); }, 'Subscription updated')}>Save</button></>}>
          <div className="form-grid">
            <Field label="Plan"><select className="input" value={subForm.planCode} onChange={(e) => setSubForm({ ...subForm, planCode: e.target.value })}>{plans.data?.items.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
            <Field label="Status"><select className="input" value={subForm.status} onChange={(e) => setSubForm({ ...subForm, status: e.target.value })}>{SUB_STATUSES.map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
            <Field label="End date (empty = no expiry)"><input className="input" type="date" value={subForm.endDate} onChange={(e) => setSubForm({ ...subForm, endDate: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}

const LIMIT_KEYS = ['users', 'customers', 'leads', 'deals', 'storageMb', 'apiCallsPerMonth', 'automations'];

function PlanModal({ initial, modules, onClose, onSaved }) {
  const [form, setForm] = useState({ priceMonthly: 0, priceYearly: 0, modules: [], limits: {}, isPublic: true, active: true, ...initial });
  const [error, setError] = useState(null);
  const all = form.modules.includes('*');
  const toggle = (m) => setForm({ ...form, modules: form.modules.includes(m) ? form.modules.filter((x) => x !== m) : [...form.modules, m] });
  const save = async () => {
    setError(null);
    try {
      const body = {
        name: form.name, description: form.description, priceMonthly: Number(form.priceMonthly), priceYearly: Number(form.priceYearly),
        limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, Number(form.limits?.[k] ?? -1)])), modules: form.modules,
        isCustom: Boolean(form.isCustom), isPublic: form.isPublic !== false, active: form.active !== false, sortOrder: Number(form.sortOrder) || 0,
      };
      if (initial.id) await ppatch(`/plans/${initial.id}`, body);
      else await ppost('/plans', { ...body, code: form.code });
      toast('Plan saved');
      onSaved();
    } catch (e) { setError(e); }
  };
  return (
    <Modal size="lg" title={initial.id ? `Plan ${initial.code}` : 'New plan'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          {!initial.id && <Field label="Code"><input className="input mono" value={form.code || ''} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} /></Field>}
          <Field label="Name"><input className="input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Description" className="full"><input className="input" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="Price / month (₹)"><input className="input" type="number" min="0" value={form.priceMonthly} onChange={(e) => setForm({ ...form, priceMonthly: e.target.value })} /></Field>
          <Field label="Price / year (₹)"><input className="input" type="number" min="0" value={form.priceYearly} onChange={(e) => setForm({ ...form, priceYearly: e.target.value })} /></Field>
          <Field label="Sort order"><input className="input" type="number" value={form.sortOrder || 0} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} /></Field>
          <div className="row"><label className="checkbox"><input type="checkbox" checked={Boolean(form.isCustom)} onChange={(e) => setForm({ ...form, isCustom: e.target.checked })} /> Custom pricing</label>
            <label className="checkbox"><input type="checkbox" checked={form.isPublic !== false} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })} /> Public</label>
            <label className="checkbox"><input type="checkbox" checked={form.active !== false} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label></div>
        </div>
        <h3>Limits <span className="small muted">(-1 = unlimited)</span></h3>
        <div className="form-grid">{LIMIT_KEYS.map((k) => <Field key={k} label={label(k)}><input className="input" type="number" min="-1" value={form.limits?.[k] ?? -1} onChange={(e) => setForm({ ...form, limits: { ...form.limits, [k]: e.target.value } })} /></Field>)}</div>
        <h3>Modules</h3>
        <label className="checkbox"><input type="checkbox" checked={all} onChange={(e) => setForm({ ...form, modules: e.target.checked ? ['*'] : [] })} /> Everything</label>
        <div className="perm-grid">{modules.map((m) => <label key={m.key} className="checkbox small"><input type="checkbox" disabled={all} checked={all || form.modules.includes(m.key)} onChange={() => toggle(m.key)} /> {m.label}</label>)}</div>
      </div>
    </Modal>
  );
}

function Plans() {
  const plans = useAsync(() => pget('/plans'), []);
  const modules = useAsync(() => pget('/modules'), []);
  const [form, setForm] = useState(null);
  return (
    <>
      <div className="page-header"><div><h1>Plans</h1><p>Prices, limits and modules. Changes apply to every company on the plan.</p></div><button type="button" className="btn btn-primary" onClick={() => setForm({})}>+ New plan</button></div>
      <div className="card">
        {!plans.data ? <div className="card-body"><Skeleton /></div> : <DataTable rows={plans.data.items} onRowClick={setForm} columns={[
          { key: 'name', label: 'Plan', render: (p) => <><strong>{p.name}</strong> <span className="small muted mono">{p.code}</span>{!p.active && <span className="badge">Inactive</span>}</> },
          { key: 'price', label: 'Price', render: (p) => (p.isCustom ? 'Custom' : `${money(p.priceMonthly)}/mo · ${money(p.priceYearly)}/yr`) },
          { key: 'users', label: 'Users', render: (p) => limitText(p.limits?.users) },
          { key: 'leads', label: 'Leads', render: (p) => limitText(p.limits?.leads) },
          { key: 'modules', label: 'Modules', render: (p) => (p.modules.includes('*') ? 'All' : p.modules.length) },
          { key: 'companies', label: 'Companies' },
        ]} />}
      </div>
      {form && <PlanModal initial={form} modules={modules.data?.items || []} onClose={() => setForm(null)} onSaved={() => { setForm(null); plans.reload(); }} />}
    </>
  );
}

function PagedTable({ title, subtitle, path, columns, filters }) {
  const [page, setPage] = useState(1);
  const [extra, setExtra] = useState({});
  const list = useAsync(() => pget(path, { page, ...extra }), [path, page, JSON.stringify(extra)]);
  return (
    <>
      <div className="page-header"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></div>
      {filters && <div className="row" style={{ marginBottom: 12 }}>{filters(extra, (v) => { setPage(1); setExtra(v); })}</div>}
      <ErrorAlert error={list.error} />
      <div className="card">
        {!list.data ? <div className="card-body"><Skeleton /></div> : <><DataTable rows={list.data.items} columns={columns} /><Pagination page={list.data.page} limit={list.data.limit} total={list.data.total} onChange={setPage} /></>}
      </div>
    </>
  );
}

const companyCell = { key: 'company', label: 'Company', render: (r) => (r.company ? <Link to={`/super-admin/companies/${r.company.id}`}>{r.company.name}</Link> : '—') };

function Coupons() {
  const list = useAsync(() => pget('/coupons'), []);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const save = async () => {
    setError(null);
    try {
      await ppost('/coupons', {
        code: form.code, percentOff: form.percentOff ? Number(form.percentOff) : undefined, amountOff: form.amountOff ? Number(form.amountOff) : undefined,
        validUntil: form.validUntil || undefined, maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : undefined,
      });
      setForm(null);
      list.reload();
    } catch (e) { setError(e); }
  };
  return (
    <>
      <div className="page-header"><div><h1>Coupons</h1></div><button type="button" className="btn btn-primary" onClick={() => setForm({})}>+ New coupon</button></div>
      <div className="card"><DataTable rows={list.data?.items} empty="No coupons." columns={[
        { key: 'code', label: 'Code', render: (c) => <code>{c.code}</code> },
        { key: 'off', label: 'Discount', render: (c) => (c.percentOff ? `${c.percentOff}%` : money(c.amountOff)) },
        { key: 'redemptions', label: 'Used', render: (c) => `${c.redemptions}${c.maxRedemptions ? ` / ${c.maxRedemptions}` : ''}` },
        { key: 'validUntil', label: 'Valid until', render: (c) => dateTime(c.validUntil) },
        { key: 'active', label: 'Active', render: (c) => <button type="button" className="btn btn-sm" onClick={async () => { await ppatch(`/coupons/${c.id}`, { active: !c.active }); list.reload(); }}>{c.active ? 'Disable' : 'Enable'}</button> },
      ]} /></div>
      {form && (
        <Modal title="New coupon" onClose={() => setForm(null)} footer={<><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Create</button></>}>
          <ErrorAlert error={error} />
          <div className="form-grid">
            <Field label="Code"><input className="input mono" value={form.code || ''} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="% off"><input className="input" type="number" min="0" max="100" value={form.percentOff || ''} onChange={(e) => setForm({ ...form, percentOff: e.target.value })} /></Field>
            <Field label="₹ off"><input className="input" type="number" min="0" value={form.amountOff || ''} onChange={(e) => setForm({ ...form, amountOff: e.target.value })} /></Field>
            <Field label="Valid until"><input className="input" type="date" value={form.validUntil || ''} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} /></Field>
            <Field label="Max redemptions"><input className="input" type="number" min="1" value={form.maxRedemptions || ''} onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}

function Usage() {
  const { data, error } = useAsync(() => pget('/usage'), []);
  return (
    <>
      <div className="page-header"><div><h1>Usage</h1><p>API calls per company this month ({data?.period}).</p></div></div>
      <ErrorAlert error={error} />
      <div className="card"><DataTable rows={data?.items} empty="No usage recorded yet." columns={[companyCell, { key: 'apiCalls', label: 'API calls', render: (u) => u.apiCalls.toLocaleString() }, { key: 'automationRuns', label: 'Automation runs' }]} /></div>
    </>
  );
}

function Modules() {
  const modules = useAsync(() => pget('/modules'), []);
  const plans = useAsync(() => pget('/plans'), []);
  const has = (p, m) => p.modules.includes('*') || p.modules.includes(m);
  return (
    <>
      <div className="page-header"><div><h1>Modules & features</h1><p>Which plan includes which module. Edit a plan to change it, or override per company.</p></div></div>
      <div className="card"><DataTable rows={modules.data?.items} columns={[
        { key: 'label', label: 'Module' },
        ...(plans.data?.items || []).map((p) => ({ key: p.code, label: p.name, render: (m) => (has(p, m.key) ? '✔' : '—') })),
      ]} /></div>
    </>
  );
}

function System() {
  const health = useAsync(() => pget('/system/health'), []);
  const settings = useAsync(() => pget('/settings'), []);
  const plans = useAsync(() => pget('/plans'), []);
  const admins = useAsync(() => pget('/admins'), []);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const s = form || settings.data;
  const save = async () => {
    setError(null);
    try {
      const { trialEnabled, trialDays, trialPlanCode, defaultPlanCode, requireApproval, gracePeriodDays } = s;
      await ppatch('/settings', { trialEnabled, trialDays: Number(trialDays), trialPlanCode, defaultPlanCode, requireApproval, gracePeriodDays: Number(gracePeriodDays) });
      toast('Settings saved');
      setForm(null);
      settings.reload();
    } catch (e) { setError(e); }
  };
  const h = health.data;
  return (
    <>
      <div className="page-header"><div><h1>System</h1></div></div>
      <div className="grid grid-2">
        <div className="card"><div className="card-header"><h3>System health</h3><button type="button" className="btn btn-sm" onClick={health.reload}>Refresh</button></div><div className="card-body">
          {h ? (
            <dl className="kv">
              <dt>Status</dt><dd><StatusBadge status={h.status === 'ok' ? 'active' : 'failed'} text={h.status} /></dd><dt>Database</dt><dd>{h.database} ({h.dbPingMs} ms)</dd>
              <dt>Environment</dt><dd>{h.environment}</dd><dt>Node</dt><dd>{h.node}</dd><dt>Uptime</dt><dd>{Math.round(h.uptimeSeconds / 60)} min</dd>
              <dt>Memory</dt><dd>{h.memoryMb.rss} MB RSS</dd><dt>API calls (month)</dt><dd>{h.apiCallsThisMonth.toLocaleString()}</dd>
            </dl>
          ) : <Skeleton />}
        </div></div>
        <div className="card"><div className="card-header"><h3>Trial & signup</h3></div><div className="card-body stack">
          <ErrorAlert error={error} />
          {s ? (
            <div className="form-grid">
              <label className="checkbox"><input type="checkbox" checked={s.trialEnabled} onChange={(e) => setForm({ ...s, trialEnabled: e.target.checked })} /> Trials enabled</label>
              <label className="checkbox"><input type="checkbox" checked={s.requireApproval} onChange={(e) => setForm({ ...s, requireApproval: e.target.checked })} /> New companies need approval</label>
              <Field label="Trial days"><input className="input" type="number" min="0" value={s.trialDays} onChange={(e) => setForm({ ...s, trialDays: e.target.value })} /></Field>
              <Field label="Grace period (days)"><input className="input" type="number" min="0" value={s.gracePeriodDays} onChange={(e) => setForm({ ...s, gracePeriodDays: e.target.value })} /></Field>
              <Field label="Trial plan"><select className="input" value={s.trialPlanCode} onChange={(e) => setForm({ ...s, trialPlanCode: e.target.value })}>{plans.data?.items.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
              <Field label="Fallback plan (after expiry)"><select className="input" value={s.defaultPlanCode} onChange={(e) => setForm({ ...s, defaultPlanCode: e.target.value })}>{plans.data?.items.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
            </div>
          ) : <Skeleton />}
          <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-end' }} disabled={!form} onClick={save}>Save</button>
        </div></div>
        <div className="card"><div className="card-header"><h3>Platform admins</h3></div>
          <DataTable rows={admins.data?.items} columns={[{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'role', label: 'Role', render: (a) => label(a.role) }, { key: 'lastLogin', label: 'Last login', render: (a) => dateTime(a.lastLogin) }]} />
        </div>
      </div>
    </>
  );
}

function PlatformNav({ admin, onNavigate }) {
  return (
    <div className="flex h-full flex-col gap-3 bg-gradient-to-b from-[oklch(0.2_0.06_300)] to-sidebar px-3 py-4 text-sidebar-foreground">
      <div className="flex items-center gap-3 px-2">
        <div className="brand-mark size-9"><ShieldCheck className="size-4" /></div>
        <div>
          <div className="font-[family-name:var(--font-display)] text-[15px] font-bold text-sidebar-accent-foreground">Platform</div>
          <div className="text-[11px] text-sidebar-foreground/55">{admin.email}</div>
        </div>
      </div>
      <nav aria-label="Platform" className="flex-1 overflow-y-auto">
        {NAV.map((g) => (
          <div key={g.group} className="flex flex-col gap-0.5">
            <div className="px-3 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/45">{g.group}</div>
            {g.items.map(([to, text, Icon]) => (
              <NavLink
                key={to}
                to={`/super-admin/${to}`}
                end={!to}
                onClick={onNavigate}
                className={({ isActive }) => cn('flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:no-underline', isActive && 'bg-gradient-to-r from-sidebar-primary/25 to-sidebar-primary/5 text-sidebar-accent-foreground')}
              >
                {({ isActive }) => <><Icon className={cn('size-[18px]', isActive ? 'text-sidebar-primary' : 'text-sidebar-foreground/55')} />{text}</>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </div>
  );
}

export function SuperAdminApp() {
  const [navOpen, setNavOpen] = useState(false);
  const [admin, setAdmin] = useState(null);
  const [loading, setLoading] = useState(Boolean(platformToken.get()));
  useEffect(() => {
    platformToken.onUnauthorized(() => { platformToken.set(null); setAdmin(null); });
    if (platformToken.get()) pget('/auth/me').then((r) => setAdmin(r.admin)).catch(() => platformToken.set(null)).finally(() => setLoading(false));
  }, []);
  if (loading) return <Skeleton />;
  if (!admin) return <PlatformLogin onLogin={setAdmin} />;
  const logout = () => { platformToken.set(null); setAdmin(null); };
  return (
    <div className="flex h-full">
      <aside className="hidden w-[256px] shrink-0 border-r border-sidebar-border lg:block"><PlatformNav admin={admin} /></aside>
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-[270px] p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Platform navigation</SheetTitle>
          <PlatformNav admin={admin} onNavigate={() => setNavOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="main flex-1">
        <header className="topbar">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation"><Menu /></Button>
          <span className="inline-flex items-center gap-2 font-semibold"><ShieldCheck className="size-4 text-primary" />Super admin console</span>
          <span className="spacer" />
          <span className="hidden text-right leading-tight sm:block">
            <span className="block text-[13px] font-semibold">{admin.name}</span>
            <span className="block text-[11px] text-muted-foreground">{label(admin.role)}</span>
          </span>
          <Button variant="outline" size="sm" onClick={logout}><LogOut />Log out</Button>
        </header>
        <main className="content">
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="companies" element={<Companies />} />
            <Route path="companies/:id" element={<CompanyDetail />} />
            <Route path="subscriptions" element={<Companies subscriptionsView />} />
            <Route path="plans" element={<Plans />} />
            <Route path="payments" element={<PagedTable title="Payments" path="/payments" columns={[{ key: 'createdAt', label: 'Date', render: (p) => dateTime(p.createdAt) }, companyCell, { key: 'planCode', label: 'Plan' }, { key: 'provider', label: 'Provider', render: (p) => label(p.provider) }, { key: 'amount', label: 'Amount', render: (p) => money(p.amount, p.currency) }, { key: 'status', label: 'Status', render: (p) => <StatusBadge status={p.status === 'success' ? 'paid' : p.status} text={label(p.status)} /> }]} filters={(v, set) => <select className="input" style={{ width: 160 }} value={v.status || ''} onChange={(e) => set({ status: e.target.value })} aria-label="Payment status"><option value="">Any status</option>{['pending', 'success', 'failed', 'refunded'].map((x) => <option key={x}>{x}</option>)}</select>} />} />
            <Route path="invoices" element={<PagedTable title="Invoices" path="/invoices" columns={[{ key: 'number', label: 'Number' }, companyCell, { key: 'issuedAt', label: 'Date', render: (i) => dateTime(i.issuedAt) }, { key: 'planCode', label: 'Plan' }, { key: 'total', label: 'Total', render: (i) => money(i.total, i.currency) }, { key: 'status', label: 'Status', render: (i) => <StatusBadge status={i.status} /> }]} />} />
            <Route path="coupons" element={<Coupons />} />
            <Route path="users" element={<PagedTable title="Users" subtitle="Users of every company" path="/users" filters={(v, set) => <input className="input search-input" type="search" placeholder="Search name or email" value={v.q || ''} onChange={(e) => set({ q: e.target.value })} aria-label="Search users" />} columns={[{ key: 'name', label: 'Name', render: (u) => <><strong>{u.name}</strong><div className="small muted mono">{u.userCode}</div></> }, { key: 'email', label: 'Email' }, companyCell, { key: 'role', label: 'Role', render: (u) => label(u.role) }, { key: 'lastLogin', label: 'Last login', render: (u) => dateTime(u.lastLogin) }, { key: 'active', label: 'Status', render: (u) => <StatusBadge status={u.active ? 'active' : 'closed'} text={u.active ? 'Active' : 'Disabled'} /> }]} />} />
            <Route path="usage" element={<Usage />} />
            <Route path="modules" element={<Modules />} />
            <Route path="audit" element={<PagedTable title="Audit logs" subtitle="Every company and platform action" path="/audit-logs" filters={(v, set) => <><select className="input" style={{ width: 170 }} value={v.actorType || ''} onChange={(e) => set({ ...v, actorType: e.target.value })} aria-label="Actor"><option value="">Any actor</option><option value="user">Company users</option><option value="platform">Platform</option><option value="system">System</option></select><input className="input" style={{ width: 200 }} placeholder="Action, e.g. auth.login" value={v.action || ''} onChange={(e) => set({ ...v, action: e.target.value })} aria-label="Action" /></>} columns={[{ key: 'createdAt', label: 'When', render: (a) => dateTime(a.createdAt) }, { key: 'action', label: 'Action', render: (a) => <code>{a.action}</code> }, companyCell, { key: 'actor', label: 'By', render: (a) => a.platformUserId?.name || a.userId?.name || label(a.actorType) }, { key: 'ip', label: 'IP' }, { key: 'userAgent', label: 'Device', render: (a) => <span className="small muted">{(a.userAgent || '').slice(0, 40)}</span> }]} />} />
            <Route path="system" element={<System />} />
            <Route path="*" element={<Navigate to="/super-admin" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
