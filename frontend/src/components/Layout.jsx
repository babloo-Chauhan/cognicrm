import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { get, post, put } from '../lib/api.js';
import { useRealtime } from '../lib/realtime.jsx';
import { label, dateTime } from '../lib/format.js';
import { Softphone } from '../calling/Softphone.jsx';
import { CallPopup } from '../calling/CallPopup.jsx';
import { WrapUpModal } from '../calling/WrapUpModal.jsx';

const NAV = [
  { section: 'CRM' },
  { to: '/', label: 'Dashboard', icon: '🏠', end: true },
  { to: '/leads', label: 'Leads', icon: '✨' },
  { to: '/contacts', label: 'Contacts', icon: '👤' },
  { to: '/accounts', label: 'Accounts', icon: '🏢' },
  { to: '/deals', label: 'Deals', icon: '💼' },
  { to: '/tickets', label: 'Tickets', icon: '🎫' },
  { to: '/tasks', label: 'Tasks', icon: '✅' },
  { section: 'Sales' },
  { to: '/sales', label: 'Sales pipeline', icon: '📈' },
  { to: '/quotes', label: 'Quotations', icon: '📝' },
  { to: '/invoices', label: 'Invoices', icon: '🧾' },
  { to: '/products', label: 'Products', icon: '📦' },
  { section: 'Communication' },
  { to: '/inbox', label: 'Inbox', icon: '💬' },
  { to: '/calling', label: 'Calling', icon: '📞' },
  { section: 'AI' },
  { to: '/assistant', label: 'Assistant', icon: '🤖' },
  { to: '/voice-agents', label: 'Voice agents', icon: '🎙️', permission: 'voice_agents:manage' },
  { section: 'Admin' },
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

export function Layout() {
  const { user, organization, logout, can } = useAuth();
  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand"><div className="brand-mark">C</div><span>COGNIEOS</span></div>
        {NAV.filter((n) => !n.permission || can(n.permission)).map((n, i) => (n.section
          ? <div key={`s${i}`} className="nav-section">{n.section}</div>
          : (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              <span className="icon" aria-hidden="true">{n.icon}</span>{n.label}
            </NavLink>
          )))}
      </nav>
      <div className="main">
        <header className="topbar">
          <strong>{organization?.name}</strong>
          <span className="spacer" />
          {can('calls:make') && <AgentStatusSelect />}
          <NotificationBell />
          <span className="small muted">{user?.name} · {label(user?.role)}</span>
          <button type="button" className="btn btn-sm" onClick={logout}>Log out</button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
      <Softphone />
      <CallPopup />
      <WrapUpModal />
    </div>
  );
}
