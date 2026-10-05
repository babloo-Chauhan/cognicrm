import { Link, useNavigate } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';
import {
  Activity, ArrowRight, CalendarClock, Check, CheckCircle2, Clock, Contact, Flame, Handshake, IndianRupee, ListChecks, Percent, Phone,
  PhoneCall, Plus, Target, Timer, TrendingUp, Trophy,
} from 'lucide-react';
import { get, patch } from '../lib/api.js';
import { dateTime, duration, money, percent } from '../lib/format.js';
import { useAuth } from '../lib/auth.jsx';
import { Empty, Stat, StatusBadge } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { CallButton } from '../calling/CallButton.jsx';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

const CHART_COLORS = ['var(--chart-1)', 'var(--chart-5)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-2)', 'var(--chart-4)'];

function Panel({ title, icon: Icon, action, children, className }) {
  return (
    <section className={cn('card flex flex-col overflow-hidden', className)}>
      <header className="flex items-center gap-2 border-b px-5 py-3.5">
        {Icon && <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary"><Icon className="size-4" /></span>}
        <h3 className="flex-1">{title}</h3>
        {action}
      </header>
      <div className="flex-1">{children}</div>
    </section>
  );
}

const SeeAll = ({ to, children = 'View all' }) => (
  <Link to={to} className="inline-flex items-center gap-1 text-xs font-semibold hover:no-underline">{children}<ArrowRight className="size-3" /></Link>
);

function heat(score) {
  if (score >= 70) return { label: 'Hot', cls: 'bg-destructive/10 text-destructive' };
  if (score >= 40) return { label: 'Warm', cls: 'bg-warning/15 text-[color-mix(in_oklch,var(--warning)_75%,var(--foreground))]' };
  return { label: 'Cold', cls: 'bg-info/12 text-info' };
}

/** Company KPIs from /dashboard (tenant-scoped on the server; sections outside the plan come back null). */
function CompanyKpis({ data }) {
  if (!data) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="card p-4"><Skeleton className="h-3 w-24" /><Skeleton className="mt-3 h-7 w-16" /><Skeleton className="mt-3 h-3 w-32" /></div>)}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {data.leads && <Stat icon={Target} tone="primary" label="Total leads" value={data.leads.total.toLocaleString()} hint={`+${data.leads.newThisMonth} new this month`} />}
      {data.customers && <Stat icon={Contact} tone="teal" label="Customers" value={data.customers.total.toLocaleString()} hint={`${data.customers.contacts} contacts · ${data.customers.accounts} accounts`} />}
      {data.deals && <Stat icon={Handshake} tone="sky" label="Open deals" value={data.deals.open.toLocaleString()} hint={`${money(data.deals.openValue)} in pipeline`} />}
      <Stat icon={IndianRupee} tone="amber" label="Revenue won" value={money(data.revenue.wonDeals)} hint={data.revenue.invoicesPaid ? `${money(data.revenue.invoicesPaid)} invoices paid` : 'From won deals'} />
      {data.deals && <Stat icon={Trophy} tone="teal" label="Won / lost" value={`${data.deals.won} / ${data.deals.lost}`} hint={`Win rate ${data.conversionRate.deals}%`} />}
      {data.leads && <Stat icon={Percent} tone="primary" label="Lead conversion" value={`${data.conversionRate.leads}%`} hint={`${data.leads.converted} converted`} />}
      {data.pendingTasks !== null && <Stat icon={ListChecks} tone="rose" label="Pending tasks" value={data.pendingTasks} />}
      <Stat icon={Activity} tone="sky" label="Today's activities" value={data.todaysActivities} />
    </div>
  );
}

function PipelineChart({ stages }) {
  const total = stages.reduce((a, s) => a + s.count, 0);
  if (!total) return <Empty icon={TrendingUp}>No deals in the pipeline yet. <Link to="/deals?new=1">Create your first deal</Link></Empty>;
  return (
    <div className="h-[260px] px-2 pb-2 pt-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={stages} margin={{ top: 4, right: 12, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="barFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.95} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.45} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" />
          <ChartTooltip
            cursor={{ fill: 'var(--accent)', opacity: 0.5 }}
            contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--popover-foreground)', fontSize: 12 }}
            formatter={(v, _n, p) => [`${v} deals · ${money(p.payload.value)}`, p.payload.label]}
          />
          <Bar dataKey="count" radius={[8, 8, 2, 2]} maxBarSize={46}>
            {stages.map((s, i) => <Cell key={s.key} fill={s.key === 'won' ? 'var(--chart-2)' : s.key === 'lost' ? 'var(--chart-4)' : CHART_COLORS[i % 4] === 'var(--chart-1)' ? 'url(#barFill)' : CHART_COLORS[i % 4]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function Dashboard() {
  const { user, hasModule, can, company } = useAuth();
  const navigate = useNavigate();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const calling = hasModule('calling');
  const none = () => Promise.resolve(null);
  const dash = useAsync(() => get('/dashboard'), []);
  const stats = useAsync(() => (calling ? get('/analytics/me', { from: start.toISOString() }) : none()), [calling]);
  const tasks = useAsync(() => (hasModule('tasks') ? get('/tasks', { status: 'open', assigneeId: user.id, limit: 8 }) : none()), [user.id]);
  const hot = useAsync(() => (hasModule('leads') ? get('/leads', { sort: '-score', limit: 6 }) : none()), []);
  const callbacks = useAsync(() => (calling ? get('/callbacks', { status: 'pending,notified', mine: 1 }) : none()), [calling]);
  const k = stats.data?.kpis || {};
  const d = dash.data;

  const quick = [
    hasModule('leads') && can('leads:create') && { label: 'New lead', icon: Target, to: '/leads?new=1' },
    hasModule('customers') && can('contacts:create') && { label: 'New contact', icon: Contact, to: '/contacts?new=1' },
    hasModule('deals') && can('deals:create') && { label: 'New deal', icon: Handshake, to: '/deals?new=1' },
    hasModule('tasks') && { label: 'New task', icon: ListChecks, to: '/tasks?new=1' },
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-6">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl border bg-sidebar p-6 text-sidebar-foreground shadow-pop sm:p-8">
        <div className="pointer-events-none absolute -right-16 -top-24 size-80 rounded-full bg-chart-1/40 blur-[80px]" />
        <div className="pointer-events-none absolute -bottom-28 left-1/3 size-72 rounded-full bg-chart-2/25 blur-[80px]" />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-sm text-sidebar-foreground/70">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
            <h1 className="mt-1 text-3xl font-extrabold text-sidebar-accent-foreground sm:text-[34px]">
              {greeting()}, <span className="bg-gradient-to-r from-sidebar-primary to-chart-2 bg-clip-text text-transparent">{user.name.split(' ')[0]}</span> 👋
            </h1>
            <p className="mt-2 max-w-xl text-sm text-sidebar-foreground/75">
              {d?.pendingTasks ? `You have ${d.pendingTasks} open task${d.pendingTasks === 1 ? '' : 's'}` : 'Your task list is clear'}
              {d?.deals ? ` and ${d.deals.open} deal${d.deals.open === 1 ? '' : 's'} in play worth ${money(d.deals.openValue)}.` : '.'}
              {company?.plan?.name ? ` You're on the ${company.plan.name} plan.` : ''}
            </p>
          </div>
          {quick.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {quick.map((q) => (
                <Button key={q.to} variant="secondary" className="border border-sidebar-border bg-sidebar-accent/80 text-sidebar-accent-foreground backdrop-blur hover:bg-sidebar-accent" onClick={() => navigate(q.to)}>
                  <Plus className="text-sidebar-primary" />{q.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </section>

      <CompanyKpis data={d} />

      {calling && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat icon={PhoneCall} tone="primary" label="My calls today" value={k.totalCalls ?? '—'} />
          <Stat icon={CheckCircle2} tone="teal" label="Connected" value={k.connectedCalls ?? '—'} hint={`Answer rate ${percent(k.answerRate)}`} />
          <Stat icon={Timer} tone="sky" label="Avg duration" value={duration(k.averageDuration)} />
          <Stat icon={Trophy} tone="amber" label="Conversions" value={k.conversions ?? '—'} hint={`Conversion rate ${percent(k.conversionRate)}`} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {d?.pipeline && (
          <Panel title="Sales pipeline" icon={TrendingUp} className="xl:col-span-2" action={<SeeAll to="/pipelines">Pipelines</SeeAll>}>
            <PipelineChart stages={d.pipeline} />
          </Panel>
        )}
        {d?.upcomingMeetings && (
          <Panel title="Upcoming meetings" icon={CalendarClock}>
            {d.upcomingMeetings.length ? (
              <ul className="divide-y">
                {d.upcomingMeetings.map((m) => (
                  <li key={m.id || m._id} className="flex items-center gap-3 px-5 py-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-chart-5/20 to-chart-1/10 text-center leading-none text-info">
                      <span className="text-[10px] font-semibold uppercase">{new Date(m.startAt).toLocaleDateString(undefined, { month: 'short' })}</span>
                      <span className="text-sm font-bold">{new Date(m.startAt).getDate()}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{m.title}</span>
                      <span className="block text-xs text-muted-foreground">{dateTime(m.startAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : <Empty icon={CalendarClock}>No meetings in the next 7 days.</Empty>}
          </Panel>
        )}
      </div>

      <div className={cn('grid grid-cols-1 gap-6', calling ? 'xl:grid-cols-3' : 'lg:grid-cols-2')}>

        {hasModule('tasks') && (
          <Panel title="My open tasks" icon={ListChecks} action={<SeeAll to="/tasks" />}>
            {tasks.data?.items?.length ? (
              <ul className="divide-y">
                {tasks.data.items.map((t) => {
                  const late = t.dueAt && new Date(t.dueAt) < new Date();
                  return (
                    <li key={t.id} className="group flex items-center gap-3 px-5 py-3">
                      <button
                        type="button"
                        aria-label={`Mark ${t.title} done`}
                        onClick={async () => { await patch(`/tasks/${t.id}`, { status: 'done' }); tasks.reload(); dash.reload(); }}
                        className="grid size-5 shrink-0 place-items-center rounded-full border-2 border-muted-foreground/40 text-transparent transition-colors hover:border-success hover:bg-success hover:text-white"
                      ><Check className="size-3" /></button>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{t.title}</span>
                        <span className={cn('flex items-center gap-1 text-xs', late ? 'text-destructive' : 'text-muted-foreground')}><Clock className="size-3" />{t.dueAt ? `${late ? 'Overdue · ' : ''}${dateTime(t.dueAt)}` : 'No due date'}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : <Empty icon={CheckCircle2}>No open tasks — nice work 🎉</Empty>}
          </Panel>
        )}

        {hasModule('leads') && (
          <Panel title="Hottest leads" icon={Flame} action={<SeeAll to="/leads" />}>
            {hot.data?.items?.length ? (
              <ul className="divide-y">
                {hot.data.items.map((l) => {
                  const h = heat(l.score || 0);
                  return (
                    <li key={l.id} className="flex items-center gap-3 px-5 py-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-chart-1 to-chart-2 text-xs font-bold text-white">{l.name.slice(0, 2).toUpperCase()}</span>
                      <span className="min-w-0 flex-1">
                        <Link to={`/leads/${l.id}`} className="block truncate text-sm font-medium text-foreground">{l.name}</Link>
                        <span className="block truncate text-xs text-muted-foreground">{[l.company, l.phone].filter(Boolean).join(' · ') || 'No contact details'}</span>
                      </span>
                      <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', h.cls)}>{h.label} · {l.score ?? 0}</span>
                      {calling && <CallButton phone={l.phone} name={l.name} related={{ leadId: l.id }} />}
                    </li>
                  );
                })}
              </ul>
            ) : <Empty icon={Target}>No leads yet. <Link to="/leads?new=1">Add your first lead</Link></Empty>}
          </Panel>
        )}

        {calling && (
          <Panel title="My callbacks" icon={Phone}>
            {callbacks.data?.items?.length ? (
              <ul className="divide-y">
                {callbacks.data.items.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{c.customerName || c.phone}</span>
                      <span className="block text-xs text-muted-foreground">{dateTime(c.scheduledAt)}</span>
                    </span>
                    <StatusBadge status={c.priority} />
                    <CallButton phone={c.phone} name={c.customerName} related={c.related || {}} />
                  </li>
                ))}
              </ul>
            ) : <Empty icon={Phone}>No callbacks scheduled.</Empty>}
          </Panel>
        )}
      </div>
    </div>
  );
}
