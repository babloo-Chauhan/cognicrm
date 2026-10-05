import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { get, post, put } from '../lib/api.js';
import { useRealtime } from '../lib/realtime.jsx';
import { label, dateTime } from '../lib/format.js';
import { Softphone } from '../calling/Softphone.jsx';
import { CallPopup } from '../calling/CallPopup.jsx';
import { WrapUpModal } from '../calling/WrapUpModal.jsx';
import { ErrorAlert, Modal } from './ui.jsx';

// `module` hides an item when the company's plan does not include it; `permission` when the user lacks it
const NAV = [
  { section: 'CRM' },
  { to: '/', label: 'Dashboard', icon: '🏠', end: true },
  { to: '/leads', label: 'Leads', icon: '✨', module: 'leads', permission: 'leads:read' },
  { to: '/contacts', label: 'Contacts', icon: '👤', module: 'customers', permission: 'contacts:read' },
  { to: '/accounts', label: 'Accounts', icon: '🏢', module: 'customers', permission: 'accounts:read' },
  { to: '/deals', label: 'Deals', icon: '💼', module: 'deals', permission: 'deals:read' },
  { to: '/pipelines', label: 'Pipelines', icon: '🧭', module: 'deals', permission: 'deals:read' },
  { to: '/tasks', label: 'Tasks', icon: '✅', module: 'tasks' },
  { to: '/tickets', label: 'Tickets', icon: '🎫', module: 'support', permission: 'tickets:read' },
  { section: 'Sales' },
  { to: '/sales', label: 'Sales pipeline', icon: '📈', module: 'invoices', permission: 'sales:read' },
  { to: '/quotes', label: 'Quotations', icon: '📝', module: 'invoices', permission: 'sales:read' },
  { to: '/invoices', label: 'Invoices', icon: '🧾', module: 'invoices', permission: 'sales:read' },
  { to: '/products', label: 'Products', icon: '📦', module: 'invoices', permission: 'sales:read' },
  { section: 'Communication' },
  { to: '/inbox', label: 'Inbox', icon: '💬', module: 'whatsapp' },
  { to: '/calling', label: 'Calling', icon: '📞', module: 'calling' },
  { section: 'AI' },
  { to: '/assistant', label: 'Assistant', icon: '🤖', module: 'ai' },
  { to: '/voice-agents', label: 'Voice agents', icon: '🎙️', module: 'ai', permission: 'voice_agents:manage' },
  { section: 'Admin' },
  { to: '/team', label: 'Team', icon: '👥' },
  { to: '/billing', label: 'Billing', icon: '💳' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
];

const STATUSES = ['available', 'busy', 'break', 'offline'];

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
  return (
    <label className="row small" title="Your agent status">
      <span className="muted">Status</span>
      <select className="input" style={{ width: 150 }} value={status || 'offline'} disabled={locked} onChange={(e) => change(e.target.value)}>
        {(locked || status === 'wrap_up') && <option value={status}>{label(status)}</option>}
        {status === 'online' && <option value="online">Online</option>}
        {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        {custom.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
    </label>
  );
}

function NotificationBell() {
  const [data, setData] = useState({ items: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const load = () => get('/notifications').then(setData).catch(() => {});
  useEffect(() => { load(); }, []);
  useRealtime('notification', (n) => setData((d) => ({ items: [n, ...d.items].slice(0, 50), unread: d.unread + 1 })));
  const openPanel = async () => {
    setOpen(!open);
    if (!open && data.unread) {
      await post('/notifications/read');
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
    <div style={{ position: 'relative' }}>
      <button type="button" className="btn btn-ghost btn-icon" onClick={openPanel} aria-label={`Notifications (${data.unread} unread)`}>
        🔔{data.unread > 0 && <span className="badge badge-danger" style={{ marginLeft: 4 }}>{data.unread}</span>}
      </button>
      {open && (
        <div className="card" style={{ position: 'absolute', right: 0, top: 40, width: 340, maxHeight: 420, overflowY: 'auto', zIndex: 40 }}>
          {data.items.length === 0 && <div className="empty">No notifications</div>}
          {data.items.map((n) => (
            <button type="button" key={n.id} onClick={() => go(n)} className="btn btn-ghost" style={{ display: 'block', width: '100%', textAlign: 'left', borderRadius: 0, borderBottom: '1px solid var(--border)', whiteSpace: 'normal' }}>
              <strong>{n.title}</strong>
              <div className="small muted">{n.body}</div>
              <div className="small muted">{dateTime(n.createdAt)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Trial countdown, expired / suspended notices. Login and billing keep working in every state. */
function SubscriptionBanner() {
  const { company, can } = useAuth();
  const sub = company?.subscription;
  if (!sub) return null;
  const billing = can('billing:manage') ? <Link to="/billing"><strong>Choose a plan →</strong></Link> : <span>Ask your admin to renew.</span>;
  if (sub.status === 'trial') {
    return <div className={`banner ${sub.daysLeft <= 3 ? '' : 'banner-info'}`} role="status">Your trial expires in {sub.daysLeft} day{sub.daysLeft === 1 ? '' : 's'}. {billing}</div>;
  }
  if (!company.premium) {
    return <div className="banner banner-danger" role="alert">Your {sub.storedStatus === 'trial' ? 'trial' : 'subscription'} has expired — premium features are paused, your data is safe. {billing}</div>;
  }
  if (sub.status === 'past_due') return <div className="banner" role="alert">Payment is overdue. {billing}</div>;
  if (sub.cancelAtPeriodEnd && sub.daysLeft != null) return <div className="banner banner-info" role="status">Your subscription ends in {sub.daysLeft} days. {billing}</div>;
  return null;
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
      await switchCompany(target, password);
      setTarget(null);
      setPassword('');
      window.location.assign('/');
    } catch (e) { setError(e); }
  };
  return (
    <>
      <select className="input" style={{ width: 180 }} aria-label="Switch company" value={company?.companyCode || ''} onChange={(e) => e.target.value !== company?.companyCode && setTarget(e.target.value)}>
        {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.name}</option>)}
      </select>
      {target && (
        <Modal title="Switch company" onClose={() => setTarget(null)} footer={<><button type="button" className="btn" onClick={() => setTarget(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={go}>Switch</button></>}>
          <div className="stack">
            <ErrorAlert error={error} />
            <p style={{ margin: 0 }}>Confirm your password for {companies.find((c) => c.companyCode === target)?.name}.</p>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} aria-label="Password" />
          </div>
        </Modal>
      )}
    </>
  );
}

function GlobalSearch() {
  const navigate = useNavigate();
  const { hasModule, can } = useAuth();
  const [q, setQ] = useState('');
  const target = hasModule('leads') && can('leads:read') ? '/leads' : hasModule('customers') ? '/contacts' : null;
  if (!target) return null;
  return (
    <form role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(`${target}?q=${encodeURIComponent(q.trim())}`); }}>
      <input className="input search-input" type="search" placeholder="Search leads, customers…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
    </form>
  );
}

export function Layout() {
  const { user, organization, company, logout, can, hasModule } = useAuth();
  const brand = organization?.settings?.branding;
  // Hide items outside the plan or the user's permissions, then drop empty section headers
  const items = NAV.filter((n) => n.section || ((!n.permission || can(n.permission)) && hasModule(n.module)))
    .filter((n, i, all) => !n.section || (all[i + 1] && !all[i + 1].section));
  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          {brand?.logoUrl ? <img src={brand.logoUrl} alt="" width={30} height={30} style={{ borderRadius: 8 }} /> : <div className="brand-mark">{(brand?.brandName || organization?.name || 'C')[0].toUpperCase()}</div>}
          <span>{brand?.brandName || 'COGNIEOS'}</span>
        </div>
        {items.map((n, i) => (n.section
          ? <div key={`s${i}`} className="nav-section">{n.section}</div>
          : (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              <span className="icon" aria-hidden="true">{n.icon}</span>{n.label}
            </NavLink>
          )))}
      </nav>
      <div className="main">
        <SubscriptionBanner />
        <header className="topbar">
          <div>
            <strong>{organization?.name}</strong>
            <div className="small muted mono">{company?.companyCode} · {company?.plan?.name || '—'}</div>
          </div>
          <CompanySwitcher />
          <span className="spacer" />
          <GlobalSearch />
          {can('calls:make') && hasModule('calling') && <AgentStatusSelect />}
          <NotificationBell />
          <a className="btn btn-ghost btn-icon" href="mailto:support@cognieos.com" title="Help & support" aria-label="Help">❔</a>
          <span className="small muted">{user?.name} · {label(user?.role)}</span>
          <button type="button" className="btn btn-sm" onClick={logout}>Log out</button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
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
