import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTheme } from '@/lib/theme';
import {
  Bell, Bot, Building2, ChartNoAxesCombined, ChevronDown, ChevronsUpDown, CircleHelp, Contact, CreditCard, FileText, Handshake,
  Inbox, LayoutDashboard, ListChecks, LogOut, Menu, Mic, Monitor, Moon, Package, Phone, Plug, Plus, Receipt, Route, Search, Settings,
  Sparkles, Sun, Target, Ticket, Users, Zap,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { get, post, put } from '../lib/api.js';
import { useRealtime } from '../lib/realtime.jsx';
import { label, dateTime } from '../lib/format.js';
import { Softphone } from '../calling/Softphone.jsx';
import { CallPopup } from '../calling/CallPopup.jsx';
import { WrapUpModal } from '../calling/WrapUpModal.jsx';
import { ErrorAlert, Modal } from './ui.jsx';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut,
} from '@/components/ui/command';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// `module` hides an item when the company's plan does not include it; `permission` when the user lacks it
const NAV = [
  {
    group: 'Workspace',
    items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true }],
  },
  {
    group: 'CRM',
    items: [
      { to: '/leads', label: 'Leads', icon: Target, module: 'leads', permission: 'leads:read' },
      { to: '/contacts', label: 'Contacts', icon: Contact, module: 'customers', permission: 'contacts:read' },
      { to: '/accounts', label: 'Accounts', icon: Building2, module: 'customers', permission: 'accounts:read' },
      { to: '/deals', label: 'Deals', icon: Handshake, module: 'deals', permission: 'deals:read' },
      { to: '/pipelines', label: 'Pipelines', icon: Route, module: 'deals', permission: 'deals:read' },
      { to: '/tasks', label: 'Tasks', icon: ListChecks, module: 'tasks' },
      { to: '/tickets', label: 'Tickets', icon: Ticket, module: 'support', permission: 'tickets:read' },
    ],
  },
  {
    group: 'Sales',
    items: [
      { to: '/sales', label: 'Sales pipeline', icon: ChartNoAxesCombined, module: 'invoices', permission: 'sales:read' },
      { to: '/quotes', label: 'Quotations', icon: FileText, module: 'invoices', permission: 'sales:read' },
      { to: '/invoices', label: 'Invoices', icon: Receipt, module: 'invoices', permission: 'sales:read' },
      { to: '/products', label: 'Products', icon: Package, module: 'invoices', permission: 'sales:read' },
    ],
  },
  {
    group: 'Engage',
    items: [
      { to: '/inbox', label: 'Inbox', icon: Inbox, module: 'whatsapp' },
      { to: '/calling', label: 'Calling', icon: Phone, module: 'calling' },
      { to: '/assistant', label: 'AI assistant', icon: Bot, module: 'ai' },
      { to: '/voice-agents', label: 'Voice agents', icon: Mic, module: 'ai', permission: 'voice_agents:manage' },
    ],
  },
  {
    group: 'Admin',
    items: [
      { to: '/team', label: 'Team', icon: Users },
      { to: '/billing', label: 'Billing', icon: CreditCard },
      // Always listed for admins: the page explains how to unlock it when the plan lacks integrations
      { to: '/integrations', label: 'Integrations', icon: Plug, permission: 'settings:manage' },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

function useNavGroups() {
  const { can, hasModule } = useAuth();
  return useMemo(() => NAV
    .map((g) => ({ ...g, items: g.items.filter((n) => (!n.permission || can(n.permission)) && hasModule(n.module)) }))
    .filter((g) => g.items.length), [can, hasModule]);
}

const STATUSES = ['available', 'busy', 'break', 'offline'];
const STATUS_DOT = { available: 'bg-success', online: 'bg-info', busy: 'bg-destructive', on_call: 'bg-info', wrap_up: 'bg-warning', break: 'bg-warning', offline: 'bg-muted-foreground' };

function AgentStatusSelect() {
  const [status, setStatus] = useState(null);
  const [custom, setCustom] = useState([]);
  const { user } = useAuth();
  useEffect(() => {
    get('/agents/me/status').then((s) => setStatus(s.customStatus || s.status)).catch(() => {});
    get('/agents/status').then((r) => setCustom(r.customStatuses || [])).catch(() => {});
  }, []);
  useRealtime('agent:status', (s) => {
    if (String(s.userId) === String(user?.id)) setStatus(s.customStatus || s.status);
  });
  const change = async (value) => {
    const s = await put('/agents/me/status', { status: value });
    setStatus(s.customStatus || s.status);
  };
  // During a call the status is fixed; wrap-up can be ended early by choosing another status.
  const locked = status === 'on_call';
  const current = status || 'offline';
  return (
    <Select value={current} disabled={locked} onValueChange={change}>
      <SelectTrigger size="sm" className="w-[150px]" aria-label="Your agent status">
        <span className={cn('size-2 rounded-full', STATUS_DOT[current] || 'bg-primary')} />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(locked || current === 'wrap_up') && <SelectItem value={current}>{label(current)}</SelectItem>}
        {current === 'online' && <SelectItem value="online">Online</SelectItem>}
        {STATUSES.map((s) => <SelectItem key={s} value={s}>{label(s)}</SelectItem>)}
        {custom.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function NotificationBell() {
  const [data, setData] = useState({ items: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  useEffect(() => { get('/notifications').then(setData).catch(() => {}); }, []);
  useRealtime('notification', (n) => setData((d) => ({ items: [n, ...d.items].slice(0, 50), unread: d.unread + 1 })));
  const onOpenChange = async (next) => {
    setOpen(next);
    if (next && data.unread) {
      await post('/notifications/read').catch(() => {});
      setData((d) => ({ ...d, unread: 0 }));
    }
  };
  const go = (n) => {
    setOpen(false);
    if (n.data?.conversationId) navigate(`/inbox?c=${n.data.conversationId}`);
    else if (n.type === 'voicemail') navigate('/calling?tab=recordings');
    else if (n.type === 'callback_reminder') navigate('/calling?tab=dialer');
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications (${data.unread} unread)`}>
          <Bell />
          {data.unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-4 text-white ring-2 ring-background">
              {data.unread > 9 ? '9+' : data.unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="font-semibold">Notifications</span>
          <Badge variant="secondary">{data.items.length}</Badge>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {data.items.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
              <Bell className="size-6 opacity-40" />You’re all caught up
            </div>
          )}
          {data.items.map((n) => (
            <button type="button" key={n.id} onClick={() => go(n)} className="flex w-full gap-3 border-b px-4 py-3 text-left transition-colors last:border-0 hover:bg-accent">
              <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{n.title}</span>
                <span className="line-clamp-2 block text-xs text-muted-foreground">{n.body}</span>
                <span className="mt-1 block text-[11px] text-muted-foreground">{dateTime(n.createdAt)}</span>
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Trial countdown, expired / suspended notices. Login and billing keep working in every state. */
function SubscriptionBanner() {
  const { company, can } = useAuth();
  const sub = company?.subscription;
  if (!sub) return null;
  const cta = can('billing:manage')
    ? <Link to="/billing" className="ml-auto inline-flex items-center gap-1 rounded-full bg-background/70 px-3 py-1 text-xs font-semibold shadow-sm hover:no-underline">Choose a plan <Zap className="size-3" /></Link>
    : <span className="ml-auto text-xs">Ask your admin to renew.</span>;
  let tone = null;
  let text = null;
  if (sub.status === 'trial') {
    tone = sub.daysLeft <= 3 ? 'warn' : 'info';
    text = <>Your <strong>{sub.planName}</strong> trial ends in <strong>{sub.daysLeft} day{sub.daysLeft === 1 ? '' : 's'}</strong>.</>;
  } else if (!company.premium) {
    tone = 'danger';
    text = <>Your {sub.storedStatus === 'trial' ? 'trial' : 'subscription'} has expired — premium features are paused, your data is safe.</>;
  } else if (sub.status === 'past_due') {
    tone = 'warn';
    text = 'Payment is overdue.';
  } else if (sub.cancelAtPeriodEnd && sub.daysLeft != null) {
    tone = 'info';
    text = `Your subscription ends in ${sub.daysLeft} days.`;
  }
  if (!text) return null;
  return (
    <div role="status" className={cn('flex items-center gap-2 border-b px-6 py-2 text-[13px]',
      tone === 'info' && 'bg-gradient-to-r from-primary/10 via-chart-2/8 to-transparent text-primary',
      tone === 'warn' && 'bg-warning/12 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]',
      tone === 'danger' && 'bg-destructive/10 text-destructive')}
    >
      <Sparkles className="size-4 shrink-0" />
      <span>{text}</span>
      {cta}
    </div>
  );
}

/** Shown when the signed-in email belongs to more than one company. Switching re-checks the password. */
function CompanySwitcher() {
  const { company, companies, switchCompany } = useAuth();
  const [target, setTarget] = useState(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  if (!companies || companies.length < 2) return null;
  const go = async () => {
    setError(null);
    try {
      await switchCompany(target.companyCode, password);
      window.location.assign('/');
    } catch (e) { setError(e); }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2"><Building2 />{company?.name}<ChevronsUpDown className="opacity-50" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Switch company</DropdownMenuLabel>
          {companies.map((c) => (
            <DropdownMenuItem key={c.companyCode} disabled={c.companyCode === company?.companyCode} onSelect={() => setTarget(c)}>
              <Building2 /><span className="flex-1 truncate">{c.name}</span><span className="font-mono text-[10px] text-muted-foreground">{c.companyCode}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {target && (
        <Modal title={`Switch to ${target.name}`} description="Confirm your password for this company." onClose={() => setTarget(null)} footer={<><Button variant="outline" onClick={() => setTarget(null)}>Cancel</Button><Button onClick={go}>Switch</Button></>}>
          <div className="flex flex-col gap-3">
            <ErrorAlert error={error} />
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} aria-label="Password" />
          </div>
        </Modal>
      )}
    </>
  );
}

/** ⌘K / Ctrl+K: jump to any page, search leads/customers, switch theme, sign out. */
function CommandPalette({ open, setOpen }) {
  const groups = useNavGroups();
  const navigate = useNavigate();
  const { setTheme } = useTheme();
  const { logout, hasModule } = useAuth();
  const [query, setQuery] = useState('');
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
  const run = (fn) => { setOpen(false); setQuery(''); fn(); };
  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Jump anywhere or run an action">
      <CommandInput placeholder="Search pages, records and actions…" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {query.trim() && (
          <CommandGroup heading="Search records">
            {hasModule('leads') && <CommandItem value={`search leads ${query}`} onSelect={() => run(() => navigate(`/leads?q=${encodeURIComponent(query.trim())}`))}><Target />Leads matching “{query}”</CommandItem>}
            {hasModule('customers') && <CommandItem value={`search contacts ${query}`} onSelect={() => run(() => navigate(`/contacts?q=${encodeURIComponent(query.trim())}`))}><Contact />Contacts matching “{query}”</CommandItem>}
          </CommandGroup>
        )}
        {groups.map((g) => (
          <CommandGroup key={g.group} heading={g.group}>
            {g.items.map((n) => (
              <CommandItem key={n.to} value={`${g.group} ${n.label}`} onSelect={() => run(() => navigate(n.to))}><n.icon />{n.label}</CommandItem>
            ))}
          </CommandGroup>
        ))}
        <CommandSeparator />
        <CommandGroup heading="Preferences">
          <CommandItem value="theme light" onSelect={() => run(() => setTheme('light'))}><Sun />Light theme</CommandItem>
          <CommandItem value="theme dark" onSelect={() => run(() => setTheme('dark'))}><Moon />Dark theme</CommandItem>
          <CommandItem value="theme system" onSelect={() => run(() => setTheme('system'))}><Monitor />System theme</CommandItem>
          <CommandItem value="sign out logout" onSelect={() => run(logout)}><LogOut />Sign out<CommandShortcut>⇧Q</CommandShortcut></CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

function NavGroup({ group, onNavigate }) {
  const location = useLocation();
  const hasActive = group.items.some((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)));
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col gap-0.5">
      {group.group !== 'Workspace' && (
        <button type="button" onClick={() => setOpen(!open)} className="flex items-center justify-between px-3 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/45 hover:text-sidebar-foreground/80">
          {group.group}
          <ChevronDown className={cn('size-3 transition-transform', !open && '-rotate-90', hasActive && !open && 'text-sidebar-primary')} />
        </button>
      )}
      {open && group.items.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          onClick={onNavigate}
          className={({ isActive }) => cn(
            'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium text-sidebar-foreground/80 transition-all hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:no-underline',
            isActive && 'bg-gradient-to-r from-sidebar-primary/25 to-sidebar-primary/5 text-sidebar-accent-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--sidebar-primary)_25%,transparent)]',
          )}
        >
          {({ isActive }) => (
            <>
              {isActive && <span className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-sidebar-primary shadow-[0_0_12px_var(--sidebar-primary)]" />}
              <n.icon className={cn('size-[18px] shrink-0 transition-colors', isActive ? 'text-sidebar-primary' : 'text-sidebar-foreground/55 group-hover:text-sidebar-accent-foreground')} />
              {n.label}
            </>
          )}
        </NavLink>
      ))}
    </div>
  );
}

function PlanCard() {
  const { company, can } = useAuth();
  const sub = company?.subscription;
  if (!sub) return null;
  const trial = sub.status === 'trial';
  const pct = trial && sub.daysLeft != null ? Math.max(4, Math.min(100, (sub.daysLeft / 14) * 100)) : 100;
  return (
    <div className="relative shrink-0 overflow-hidden rounded-xl border border-sidebar-border bg-gradient-to-br from-sidebar-primary/20 via-sidebar-accent to-sidebar p-2.5">
      <div className="pointer-events-none absolute -right-6 -top-6 size-20 rounded-full bg-sidebar-primary/30 blur-2xl" />
      <div className="relative flex items-center gap-2 text-xs font-semibold text-sidebar-accent-foreground">
        <Sparkles className="size-3.5 text-sidebar-primary" />{company.plan?.name || 'Plan'} {trial ? 'trial' : ''}
      </div>
      <div className="relative mt-1 text-[11px] text-sidebar-foreground/70">
        {trial ? `${sub.daysLeft} days left` : company.premium ? 'Active subscription' : 'Expired — features paused'}
      </div>
      <div className="relative mt-1.5 h-1 overflow-hidden rounded-full bg-sidebar-border">
        <div className="h-full rounded-full bg-gradient-to-r from-sidebar-primary to-chart-2" style={{ width: `${pct}%` }} />
      </div>
      {can('billing:manage') && (
        <Button asChild size="sm" className="relative mt-2 h-7 w-full bg-gradient-to-r from-chart-1 to-[color-mix(in_oklch,var(--chart-1)_70%,var(--chart-2))] text-white shadow-[0_6px_16px_-6px_var(--chart-1)] hover:opacity-95">
          <Link to="/billing" className="hover:no-underline">{trial || !company.premium ? 'Upgrade plan' : 'Manage plan'}</Link>
        </Button>
      )}
    </div>
  );
}

function SidebarBody({ onNavigate, openPalette }) {
  const groups = useNavGroups();
  const { organization, company } = useAuth();
  const brand = organization?.settings?.branding;
  const name = brand?.brandName || organization?.name || 'COGNIEOS';
  return (
    <div className="flex h-full flex-col gap-3 bg-sidebar px-3 py-4 text-sidebar-foreground">
      <Link to="/" onClick={onNavigate} className="flex items-center gap-3 px-2 hover:no-underline">
        {brand?.logoUrl
          ? <img src={brand.logoUrl} alt="" className="size-9 rounded-xl object-cover" />
          : <div className="brand-mark size-9">{name[0]?.toUpperCase()}</div>}
        <div className="min-w-0">
          <div className="truncate font-[family-name:var(--font-display)] text-[15px] font-bold text-sidebar-accent-foreground">{name}</div>
          <div className="font-mono text-[10.5px] text-sidebar-foreground/50">{company?.companyCode}</div>
        </div>
      </Link>
      <button type="button" onClick={openPalette} className="mx-1 flex items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent/60 px-3 py-2 text-[13px] text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
        <Search className="size-4" />Search…
        <kbd className="ml-auto rounded border border-sidebar-border px-1.5 font-mono text-[10px]">Ctrl K</kbd>
      </button>
      <nav aria-label="Main" className="-mx-1 flex-1 overflow-y-auto px-1">
        {groups.map((g) => <NavGroup key={g.group} group={g} onNavigate={onNavigate} />)}
      </nav>
      <PlanCard />
    </div>
  );
}

function ThemeIcon() {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === 'dark' ? <Moon /> : <Sun />;
}

function UserMenu() {
  const { user, logout, company } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 transition-colors hover:bg-accent" aria-label="Account menu">
          <Avatar className="size-8 ring-2 ring-primary/20">
            <AvatarFallback className="bg-gradient-to-br from-chart-1 to-chart-2 text-xs font-bold text-white">{initials(user?.name)}</AvatarFallback>
          </Avatar>
          <span className="hidden text-left leading-tight xl:block">
            <span className="block text-[13px] font-semibold">{user?.name}</span>
            <span className="block text-[11px] text-muted-foreground">{label(user?.role)}</span>
          </span>
          <ChevronDown className="hidden size-3.5 text-muted-foreground xl:block" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <div className="text-sm font-semibold">{user?.name}</div>
          <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">{user?.userCode} · {company?.companyCode}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => navigate('/settings')}><Settings />Settings</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate('/team')}><Users />Team</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate('/billing')}><CreditCard />Billing</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger><ThemeIcon />Theme</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light"><Sun />Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark"><Moon />Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system"><Monitor />System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={logout}><LogOut />Log out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PageTitle() {
  const location = useLocation();
  const groups = useNavGroups();
  const item = groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })))
    .find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)));
  return (
    <div className="hidden min-w-0 items-center gap-2 text-sm sm:flex">
      <span className="text-muted-foreground">{item?.group || 'Workspace'}</span>
      <span className="text-muted-foreground/50">/</span>
      <span className="truncate font-semibold">{item?.label || 'Details'}</span>
    </div>
  );
}

export function Layout() {
  const { can, hasModule } = useAuth();
  const { setTheme, resolvedTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <div className="flex h-full">
      <aside className="hidden w-[264px] shrink-0 border-r border-sidebar-border lg:block">
        <SidebarBody openPalette={() => setPaletteOpen(true)} />
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[280px] border-sidebar-border p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarBody onNavigate={() => setMobileOpen(false)} openPalette={() => { setMobileOpen(false); setPaletteOpen(true); }} />
        </SheetContent>
      </Sheet>

      <div className="main flex-1">
        <SubscriptionBanner />
        <header className="topbar">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu /></Button>
          <PageTitle />
          <CompanySwitcher />
          <span className="spacer" />
          <Button variant="outline" size="sm" className="hidden gap-2 text-muted-foreground md:inline-flex" onClick={() => setPaletteOpen(true)}>
            <Search />Search
            <kbd className="rounded border px-1 font-mono text-[10px]">Ctrl K</kbd>
          </Button>
          {hasModule('leads') && can('leads:create') && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" className="size-8 rounded-full" onClick={() => navigate('/leads?new=1')} aria-label="New lead"><Plus /></Button>
              </TooltipTrigger>
              <TooltipContent>New lead</TooltipContent>
            </Tooltip>
          )}
          {can('calls:make') && hasModule('calling') && <AgentStatusSelect />}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme"><ThemeIcon /></Button>
            </TooltipTrigger>
            <TooltipContent>Toggle light / dark</TooltipContent>
          </Tooltip>
          <NotificationBell />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" asChild aria-label="Help"><a href="mailto:support@cognieos.com"><CircleHelp /></a></Button>
            </TooltipTrigger>
            <TooltipContent>Help & support</TooltipContent>
          </Tooltip>
          <UserMenu />
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} setOpen={setPaletteOpen} />
      {hasModule('calling') && (
        <>
          <Softphone />
          <CallPopup />
          <WrapUpModal />
        </>
      )}
    </div>
  );
}
