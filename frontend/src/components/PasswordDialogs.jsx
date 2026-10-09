import { useState } from 'react';
import { patch, post, setToken } from '../lib/api.js';
import { ErrorAlert, Field, Modal } from './ui.jsx';
import { toast } from '../lib/toast.js';

/** Readable temporary password: no 0/O/1/l look-alikes. */
function tempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const pick = (n) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => chars[x % chars.length]).join('');
  return `${pick(4)}-${pick(4)}-${pick(2)}`;
}

/** Admin sets a new password for a team member; the member is signed out everywhere. */
export function ResetPasswordDialog({ user, onClose }) {
  const [password, setPassword] = useState(tempPassword);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await patch(`/users/${user.id}`, { password });
      setDone(true);
      toast(`Password reset for ${user.name}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const copy = () => navigator.clipboard?.writeText(`Login: ${user.email} (or Employee ID ${user.userCode})\nPassword: ${password}`).then(() => toast('Copied'));
  return (
    <Modal
      title={`Reset password: ${user.name}`}
      description={done
        ? 'Share these details with the employee. They should change the password after signing in.'
        : `${user.name} will be signed out on all devices and must sign in with the new password.`}
      onClose={onClose}
      footer={done
        ? <><button type="button" className="btn" onClick={copy}>Copy login details</button><button type="button" className="btn btn-primary" onClick={onClose}>Done</button></>
        : <><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || password.length < 8} onClick={save}>{busy ? 'Resetting…' : 'Reset password'}</button></>}
    >
      <ErrorAlert error={error} />
      <div className="stack">
        <Field label="New password" hint="At least 8 characters. A random one is filled in for you.">
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="input mono" value={password} readOnly={done} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            {!done && <button type="button" className="btn btn-sm" onClick={() => setPassword(tempPassword())}>Generate</button>}
          </div>
        </Field>
        <div className="small muted">Signs in with <strong>{user.email}</strong> or Employee ID <strong className="mono">{user.userCode}</strong></div>
      </div>
    </Modal>
  );
}

/** The signed-in user changes their own password (current password required). */
export function ChangePasswordDialog({ onClose }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mismatch = form.confirm && form.next !== form.confirm;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post('/auth/change-password', { currentPassword: form.current, newPassword: form.next });
      setToken(res.token); // this browser stays signed in; other devices are signed out
      toast('Password changed. Other devices were signed out.');
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal
      title="Change password"
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !form.current || form.next.length < 8 || form.next !== form.confirm} onClick={save}>{busy ? 'Changing…' : 'Change password'}</button></>}
    >
      <ErrorAlert error={error || (mismatch ? new Error('New passwords do not match') : null)} />
      <div className="stack">
        <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={form.current} onChange={set('current')} /></Field>
        <Field label="New password" hint="At least 8 characters"><input className="input" type="password" autoComplete="new-password" value={form.next} onChange={set('next')} /></Field>
        <Field label="Confirm new password"><input className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} /></Field>
      </div>
    </Modal>
  );
}
