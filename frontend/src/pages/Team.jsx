import { useState } from 'react';
import { del, get, patch, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useAsync } from '../lib/hooks.js';
import { dateTime, label } from '../lib/format.js';
import {
  ConfirmDialog, DataTable, ErrorAlert, Field, Modal, Skeleton, StatusBadge, Tabs,
} from '../components/ui.jsx';
import { toast } from '../lib/toast.js';
import { ResetPasswordDialog } from '../components/PasswordDialogs.jsx';

function UserModal({ initial, roles, onClose, onSaved }) {
  const { can, user: me } = useAuth();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const manage = can('users:update');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name, role: form.role, phone: form.phone || undefined, department: form.department || undefined, designation: form.designation || undefined,
      };
      if (form.id) {
        if (manage && form.id !== me.id) body.active = form.active !== false;
        if (!manage) { delete body.role; delete body.department; delete body.designation; }
        await patch(`/users/${form.id}`, body);
      } else {
        await post('/users', { ...body, email: form.email, password: form.password });
      }
      toast(form.id ? 'User updated' : 'User created');
      onSaved();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal title={form.id ? form.name : 'New user'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save</button></>}>
      <ErrorAlert error={error} />
      <div className="form-grid">
        <Field label="Name"><input className="input" value={form.name || ''} onChange={set('name')} /></Field>
        {!form.id && <Field label="Email"><input className="input" type="email" value={form.email || ''} onChange={set('email')} /></Field>}
        {!form.id && <Field label="Temporary password"><input className="input" type="password" autoComplete="new-password" value={form.password || ''} onChange={set('password')} /></Field>}
        <Field label="Role">
          <select className="input" value={form.role} disabled={!manage && Boolean(form.id)} onChange={set('role')}>
            {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
        </Field>
        <Field label="Department"><input className="input" value={form.department || ''} disabled={!manage && Boolean(form.id)} onChange={set('department')} /></Field>
        <Field label="Designation"><input className="input" value={form.designation || ''} disabled={!manage && Boolean(form.id)} onChange={set('designation')} /></Field>
        <Field label="Phone (for bridge calls)"><input className="input" value={form.phone || ''} onChange={set('phone')} /></Field>
        {form.id && manage && form.id !== me.id && <label className="checkbox"><input type="checkbox" checked={form.active !== false} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>}
      </div>
    </Modal>
  );
}

export function Users() {
  const { can, user } = useAuth();
  const [q, setQ] = useState('');
  const users = useAsync(() => get('/users'), []);
  const roles = useAsync(() => get('/roles'), []);
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [resetting, setResetting] = useState(null);
  const roleName = (key) => roles.data?.items.find((r) => r.key === key)?.name || label(key);
  const rows = (users.data?.items || []).filter((u) => !q || `${u.name} ${u.email} ${u.role} ${u.department || ''}`.toLowerCase().includes(q.toLowerCase()));
  if (!users.data) return users.error ? <ErrorAlert error={users.error} /> : <Skeleton />;
  return (
    <div className="stack">
      <div className="row">
        <input className="input search-input" placeholder="Search users…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
        {can('users:create') && <button type="button" className="btn btn-primary right" onClick={() => setForm({ role: 'employee' })}>+ Add user</button>}
      </div>
      <div className="card">
        <DataTable
          rows={rows}
          onRowClick={(u) => (can('users:update') || u.id === user.id) && setForm(u)}
          columns={[
            { key: 'name', label: 'Name', render: (u) => <><strong>{u.name}</strong><div className="small muted mono">{u.userCode}</div></> },
            { key: 'email', label: 'Email' },
            { key: 'role', label: 'Role', render: (u) => roleName(u.role) },
            { key: 'department', label: 'Department', render: (u) => [u.department, u.designation].filter(Boolean).join(' · ') || '—' },
            { key: 'lastLogin', label: 'Last login', render: (u) => dateTime(u.lastLogin) },
            { key: 'active', label: 'Status', render: (u) => <StatusBadge status={u.active ? 'active' : 'closed'} text={u.active ? 'Active' : 'Disabled'} /> },
            {
              key: 'x',
              label: '',
              render: (u) => u.active && u.id !== user.id && (
                <span className="row" style={{ flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                  {can('users:update') && <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setResetting(u); }}>Reset password</button>}
                  {can('users:delete') && <button type="button" className="btn btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); setConfirm(u); }}>Remove</button>}
                </span>
              ),
            },
          ]}
        />
      </div>
      {resetting && <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />}
      {form && <UserModal initial={form} roles={roles.data?.items || []} onClose={() => setForm(null)} onSaved={() => { setForm(null); users.reload(); }} />}
      {confirm && (
        <ConfirmDialog
          title="Remove user"
          message={`${confirm.name} will be signed out and can no longer log in. Their records and history are kept.`}
          confirmLabel="Remove"
          danger
          onConfirm={async () => { await del(`/users/${confirm.id}`); toast('User removed'); users.reload(); }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function RoleModal({ initial, groups, onClose, onSaved }) {
  const [form, setForm] = useState({ permissions: [], ...initial });
  const [error, setError] = useState(null);
  const locked = form.key === 'admin';
  const toggle = (p) => setForm({ ...form, permissions: form.permissions.includes(p) ? form.permissions.filter((x) => x !== p) : [...form.permissions, p] });
  const save = async () => {
    setError(null);
    try {
      const body = { name: form.name, description: form.description, ...(locked ? {} : { permissions: form.permissions }) };
      if (form.id) await patch(`/roles/${form.id}`, body);
      else await post('/roles', body);
      toast('Role saved');
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  // A wildcard like leads:* covers every leads permission
  const covered = (p) => form.permissions.includes('*') || form.permissions.includes(p) || form.permissions.includes(`${p.split(':')[0]}:*`);
  return (
    <Modal size="lg" title={form.id ? `Role: ${form.name}` : 'New role'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <Field label="Name"><input className="input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Description"><input className="input" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        </div>
        {locked ? <div className="alert alert-info">The Company Admin role always has full access.</div> : groups.map((g) => (
          <fieldset key={g.group} className="card" style={{ padding: 12 }}>
            <legend className="small" style={{ fontWeight: 600 }}>{g.group}</legend>
            <div className="perm-grid">
              {g.permissions.map((p) => {
                const viaWildcard = covered(p.key) && !form.permissions.includes(p.key);
                return (
                  <label key={p.key} className="checkbox small" title={p.key}>
                    <input type="checkbox" checked={covered(p.key)} disabled={viaWildcard} onChange={() => toggle(p.key)} /> {p.label}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </Modal>
  );
}

export function Roles() {
  const { can } = useAuth();
  const roles = useAsync(() => get('/roles'), []);
  const perms = useAsync(() => get('/permissions'), []);
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const manage = can('roles:manage');
  if (!roles.data) return roles.error ? <ErrorAlert error={roles.error} /> : <Skeleton />;
  return (
    <div className="stack">
      <div className="row">
        <span className="muted">Roles decide what each user can see and do. Built-in roles can be edited; custom roles can be added.</span>
        {manage && <button type="button" className="btn btn-primary right" onClick={() => setForm({ name: '', permissions: [] })}>+ New role</button>}
      </div>
      <div className="card">
        <DataTable
          rows={roles.data.items}
          onRowClick={manage ? setForm : undefined}
          columns={[
            { key: 'name', label: 'Role', render: (r) => <><strong>{r.name}</strong> {r.system && <span className="badge">Built-in</span>}<div className="small muted">{r.description}</div></> },
            { key: 'permissions', label: 'Permissions', render: (r) => (r.permissions.includes('*') ? 'Full access' : `${r.permissions.length} permissions`) },
            { key: 'userCount', label: 'Users' },
            { key: 'x', label: '', render: (r) => manage && !r.system && <button type="button" className="btn btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); setConfirm(r); }}>Delete</button> },
          ]}
        />
      </div>
      {form && <RoleModal initial={form} groups={perms.data?.groups || []} onClose={() => setForm(null)} onSaved={() => { setForm(null); roles.reload(); }} />}
      {confirm && <ConfirmDialog title="Delete role" message={`Delete the ${confirm.name} role?`} danger confirmLabel="Delete" onConfirm={async () => { await del(`/roles/${confirm.id}`); roles.reload(); }} onClose={() => setConfirm(null)} />}
    </div>
  );
}

export function TeamPage() {
  const [tab, setTab] = useState('users');
  return (
    <>
      <div className="page-header"><div><h1>Team</h1><p>Users, roles and permissions of your company.</p></div></div>
      <Tabs tabs={[{ key: 'users', label: 'Users' }, { key: 'roles', label: 'Roles & permissions' }]} value={tab} onChange={setTab} />
      {tab === 'users' ? <Users /> : <Roles />}
    </>
  );
}
