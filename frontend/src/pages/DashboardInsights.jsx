import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';
import {
  AlarmClock, ArrowRight, CalendarDays, CheckCircle2, ChevronDown, ChevronUp, ChevronsUp, Eye, ListTodo, Trash2,
} from 'lucide-react';
import { del, get, patch } from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { money } from '../lib/format.js';
import { useAuth } from '../lib/auth.jsx';
import { ConfirmDialog, Empty } from '../components/ui.jsx';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TOOLTIP = { background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--popover-foreground)', fontSize: 12 };

function Card({ title, subtitle, action, children, className }) {
  return (
    <section className={cn('card flex flex-col overflow-hidden', className)}>
      <header className="flex items-start gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <h3 className="leading-tight">{title}</h3>
          {subtitle && <p className="m-0 mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className="flex-1 px-5 pb-5">{children}</div>
    </section>
  );
}

const ViewAll = ({ to }) => (
  <Link to={to} className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:no-underline hover:opacity-90">View all<ArrowRight className="size-3" /></Link>
);

function PeriodSelect({ value, onChange, options, label }) {
  return (
    <label className="relative inline-flex items-center">
      <CalendarDays className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
      <select className="input h-8 w-auto py-0 pl-7 pr-7 text-xs" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </label>
  );
}

// "4:45 PM" today, "3 hrs" ago, "Yesterday", or the date
function when(at) {
  const d = new Date(at);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return mins <= 1 ? 'Just now' : `${mins} min`;
  if (mins < 6 * 60) return `${Math.round(mins / 60)} hrs`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (d >= today) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d >= new Date(today.getTime() - 86400000)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const DOT = {
  lead_created: 'bg-success', lead_assigned: 'bg-info', lead_enquiry: 'bg-warning', lead_converted: 'bg-success',
  call: 'bg-chart-5', sms: 'bg-chart-3', whatsapp: 'bg-success', email: 'bg-chart-3',
  deal_created: 'bg-destructive', deal_stage: 'bg-destructive', task_created: 'bg-warning', note: 'bg-muted-foreground',
};

function ActivityFeed({ items }) {
  if (!items.length) return <Empty>No activity yet.</Empty>;
  return (
    <ol className="relative m-0 flex list-none flex-col gap-4 p-0 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-border">
      {items.map((a) => {
        const to = a.leadId ? `/leads/${a.leadId}` : a.dealId ? `/deals/${a.dealId}` : a.contactId ? `/contacts/${a.contactId}` : null;
        return (
          <li key={a.id} className="relative flex gap-3 pl-0">
            <span className={cn('relative z-10 mt-1.5 size-[11px] shrink-0 rounded-full ring-4 ring-card', DOT[a.type] || 'bg-primary')} />
            <span className="min-w-0 flex-1 text-sm">
              {to ? <Link to={to} className="font-medium text-foreground">{a.title}</Link> : <span className="font-medium">{a.title}</span>}
              {a.user && <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">@{a.user.split(' ')[0].toLowerCase()}</span>}
            </span>
            <span className="whitespace-nowrap text-xs text-muted-foreground">{when(a.at)}</span>
          </li>
        );
      })}
    </ol>
  );
}

const PRIORITY = {
  high: { icon: ChevronsUp, cls: 'text-destructive', label: 'High' },
  medium: { icon: ChevronUp, cls: 'text-warning', label: 'Medium' },
  low: { icon: ChevronDown, cls: 'text-success', label: 'Low' },
};
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';

function RecentTasks({ tasks, onChanged }) {
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(null);
  const counters = [
    { label: 'Open', value: tasks.open, icon: ListTodo, cls: 'bg-destructive/12 text-destructive' },
    { label: 'Overdue', value: tasks.overdue, icon: AlarmClock, cls: 'bg-warning/15 text-warning' },
    { label: 'Completed', value: tasks.done, icon: CheckCircle2, cls: 'bg-success/15 text-success' },
  ];
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b pb-3">
        <div><div className="text-2xl font-bold leading-none">{tasks.total.toLocaleString('en-IN')}</div><div className="text-xs text-muted-foreground">Total tasks</div></div>
        {counters.map((c) => (
          <div key={c.label} className="flex items-center gap-2">
            <span className={cn('grid size-8 place-items-center rounded-lg', c.cls)}><c.icon className="size-4" /></span>
            <span><span className="block text-sm font-semibold leading-none">{c.value.toLocaleString('en-IN')}</span><span className="text-[11px] text-muted-foreground">{c.label}</span></span>
          </div>
        ))}
      </div>
      {tasks.recent.length ? (
        <div className="mt-1 text-sm">
          <div className="flex items-center gap-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span className="flex-1">Title</span><span className="w-7 text-center" title="Assignee">Who</span><span className="w-7 text-center" title="Priority">Pri.</span><span className="w-14 text-right">Actions</span>
          </div>
          <ul className="m-0 list-none divide-y p-0">
            {tasks.recent.map((t) => {
              const p = PRIORITY[t.priority] || PRIORITY.medium;
              const late = t.dueAt && new Date(t.dueAt) < new Date();
              return (
                <li key={t.id} className="flex items-center gap-2 py-2">
                  <label className="flex min-w-0 flex-1 items-start gap-2">
                    <input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--primary)]" aria-label={`Mark ${t.title} done`} onChange={async () => { await patch(`/tasks/${t.id}`, { status: 'done' }); onChanged(); }} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{t.title}</span>
                      <span className={cn('block truncate text-xs', late ? 'text-destructive' : 'text-muted-foreground')}>{t.dueAt ? `${late ? 'Overdue · ' : ''}${new Date(t.dueAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : 'No due date'}</span>
                    </span>
                  </label>
                  <span title={t.assignee || 'Unassigned'} className="grid size-7 shrink-0 place-items-center rounded-full bg-destructive/10 text-[10px] font-bold text-destructive">{t.assignee ? initials(t.assignee) : '—'}</span>
                  <span title={`${p.label} priority`} className="grid w-7 shrink-0 place-items-center"><p.icon className={cn('size-4', p.cls)} /></span>
                  <span className="flex w-14 shrink-0 justify-end">
                    <button type="button" className="p-1 text-muted-foreground hover:text-foreground" aria-label="Open tasks" onClick={() => navigate('/tasks')}><Eye className="size-4" /></button>
                    <button type="button" className="p-1 text-muted-foreground hover:text-destructive" aria-label={`Delete ${t.title}`} onClick={() => setDeleting(t)}><Trash2 className="size-4" /></button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : <Empty icon={CheckCircle2}>No open tasks.</Empty>}
      {deleting && <ConfirmDialog danger title="Delete task?" message={`“${deleting.title}” will be deleted.`} confirmLabel="Delete" onClose={() => setDeleting(null)} onConfirm={async () => { await del(`/tasks/${deleting.id}`); onChanged(); }} />}
    </>
  );
}

/** Half-circle gauge of the completion percentage. */
function Gauge({ percent }) {
  const r = 80;
  const len = Math.PI * r;
  const shown = Math.max(0, Math.min(100, percent));
  return (
    <svg viewBox="0 0 200 115" className="mx-auto w-full max-w-[260px]" role="img" aria-label={`${shown}% completed`}>
      <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--muted)" strokeWidth="22" strokeLinecap="round" />
      <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--success)" strokeWidth="22" strokeLinecap="round" strokeDasharray={`${(len * shown) / 100} ${len}`} />
      <text x="100" y="88" textAnchor="middle" className="fill-foreground" style={{ fontSize: 24, fontWeight: 700 }}>{shown}%</text>
      <text x="100" y="106" textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 11 }}>Completed</text>
    </svg>
  );
}

function Chip({ label, value, tone, to }) {
  const body = (
    <span className={cn('flex flex-col rounded-md border-l-[3px] px-3 py-2', tone)}>
      <span className="text-lg font-bold leading-none">{value.toLocaleString('en-IN')}</span>
      <span className="mt-1 text-xs text-muted-foreground">{label}</span>
    </span>
  );
  return to ? <Link to={to} className="text-foreground hover:no-underline">{body}</Link> : body;
}

const TONES = {
  red: 'border-destructive bg-destructive/8 [&>span:first-child]:text-destructive',
  amber: 'border-warning bg-warning/10 [&>span:first-child]:text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]',
  sky: 'border-info bg-info/8 [&>span:first-child]:text-info',
  green: 'border-success bg-success/10 [&>span:first-child]:text-success',
  gray: 'border-muted-foreground bg-muted/60',
};

function LeadStats({ leads, months }) {
  const s = leads.byStatus;
  const data = leads.byMonth.slice(0, months).map((m, i) => ({ month: MONTHS[i], ...m }));
  const chips = [
    { label: 'New', value: s.new || 0, tone: TONES.red, to: '/leads?status=new' },
    { label: 'Contacted', value: s.contacted || 0, tone: TONES.amber, to: '/leads?status=contacted' },
    { label: 'In progress', value: (s.qualified || 0) + (s.proposal || 0) + (s.negotiation || 0), tone: TONES.sky, to: '/leads?status=qualified' },
    { label: 'Won', value: (s.won || 0) + (s.converted || 0), tone: TONES.green, to: '/leads?status=won' },
    { label: 'Lost', value: (s.lost || 0) + (s.unqualified || 0), tone: TONES.gray, to: '/leads?status=lost' },
  ];
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{chips.map((c) => <Chip key={c.label} {...c} />)}</div>
      <div className="mt-4 h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 18, right: 12, left: -18, bottom: 0 }}>
            <defs>
              <linearGradient id="leadArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--success)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--success)" stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" />
            <ChartTooltip contentStyle={TOOLTIP} formatter={(v, n) => [v, n === 'leads' ? 'New leads' : 'Won']} />
            <Area type="monotone" dataKey="leads" stroke="var(--success)" strokeWidth={2} fill="url(#leadArea)" dot={{ r: 3, fill: 'var(--card)', stroke: 'var(--success)', strokeWidth: 2 }}>
              <LabelList dataKey="leads" position="top" fontSize={11} fill="var(--foreground)" formatter={(v) => (v ? v : '')} />
            </Area>
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

function DealStats({ deals, months }) {
  const data = deals.byMonth.slice(0, months).map((m, i) => ({ month: MONTHS[i], ...m }));
  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <Chip label="Open" value={deals.open} tone={TONES.amber} to="/pipelines" />
        <Chip label="Won" value={deals.won} tone={TONES.green} to="/deals?stage=won" />
        <Chip label="Lost" value={deals.lost} tone={TONES.red} to="/deals?stage=lost" />
      </div>
      <div className="mt-4 h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" />
            <ChartTooltip cursor={{ fill: 'var(--accent)', opacity: 0.5 }} contentStyle={TOOLTIP} formatter={(v, _n, p) => [`${v} won · ${money(p.payload.value)}`, 'Deals']} />
            <Bar dataKey="won" fill="var(--chart-4)" radius={[3, 3, 0, 0]} maxBarSize={22} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

/** The dashboard's activity / tasks / performance row and the yearly lead and deal charts. */
export function DashboardInsights() {
  const { hasModule } = useAuth();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(String(thisYear));
  const [period, setPeriod] = useState('month');
  const { data, reload } = useAsync(() => get('/dashboard/insights', { year, period }), [year, period]);
  const years = [[String(thisYear), 'This year'], [String(thisYear - 1), 'Last year'], [String(thisYear - 2), String(thisYear - 2)]];
  if (!data) {
    return <div className="grid gap-6 xl:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="card p-5"><Skeleton className="h-4 w-40" /><Skeleton className="mt-4 h-40 w-full" /></div>)}</div>;
  }
  // This year's charts stop at the current month
  const months = Number(year) === thisYear ? new Date().getMonth() + 1 : 12;
  const yearSelect = <PeriodSelect value={year} onChange={setYear} options={years} label="Year" />;
  return (
    <>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Latest activity" subtitle="Calls, leads, deals and tasks across your CRM" action={hasModule('leads') ? <ViewAll to="/leads" /> : null}>
          <ActivityFeed items={data.activity} />
        </Card>
        {data.tasks && (
          <Card title="Recent tasks" subtitle="Open tasks, soonest due first" action={<ViewAll to="/tasks" />}>
            <RecentTasks tasks={data.tasks} onChanged={reload} />
          </Card>
        )}
        {data.taskPerformance && (
          <Card title="Task performance" subtitle="Tasks due in the period that are done" action={<PeriodSelect value={period} onChange={setPeriod} options={[['week', 'This week'], ['month', 'This month'], ['year', 'This year']]} label="Period" />}>
            <div className="flex h-full flex-col items-center justify-center gap-2 pt-2">
              <Gauge percent={data.taskPerformance.percent} />
              <div className="text-sm"><span className="font-semibold text-success">{data.taskPerformance.done}</span><span className="text-muted-foreground"> / {data.taskPerformance.total} tasks done</span></div>
            </div>
          </Card>
        )}
      </div>
      {(data.leads || data.deals) && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {data.leads && <Card title="Lead stats" subtitle={`New leads by month · ${year}`} action={yearSelect}><LeadStats leads={data.leads} months={months} /></Card>}
          {data.deals && <Card title="Deal stats" subtitle={`Deals won by month · ${year}`} action={yearSelect}><DealStats deals={data.deals} months={months} /></Card>}
        </div>
      )}
    </>
  );
}
