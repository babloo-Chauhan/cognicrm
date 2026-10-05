import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { label } from '../lib/format.js';

export function Modal({ title, onClose, children, footer, size }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${size === 'lg' ? 'modal-lg' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label: text, children, className = '' }) {
  return (
    <label className={`field ${className}`}>
      <span>{text}</span>
      {children}
    </label>
  );
}

const STATUS_TONE = {
  completed: 'success', in_progress: 'info', available: 'success', online: 'info', running: 'success', open: 'success',
  won: 'success', delivered: 'success', read: 'success', qualified: 'success', active: 'success', published: 'success', sent: 'info',
  ringing: 'warning', queued: 'warning', on_hold: 'warning', wrap_up: 'warning', break: 'warning', paused: 'warning',
  pending: 'warning', on_call: 'info', busy: 'danger', failed: 'danger', no_answer: 'danger', abandoned: 'danger',
  lost: 'danger', canceled: 'danger', closed: 'danger', dnc: 'danger', invalid: 'danger', urgent: 'danger', high: 'warning',
  voicemail: 'info', offline: '', draft: '', new: 'info', hot: 'danger', warm: 'warning', cold: '',
  accepted: 'success', rejected: 'danger', expired: 'danger', revised: '', issued: 'info', partially_paid: 'warning', paid: 'success', overdue: 'danger', void: '',
};

export function StatusBadge({ status, text }) {
  if (!status) return <span className="muted">—</span>;
  const tone = STATUS_TONE[status];
  return <span className={`badge ${tone ? `badge-${tone}` : ''}`}><span className="dot" />{text || label(status)}</span>;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} className={`tab ${value === t.key ? 'active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label: text, value, hint }) {
  return (
    <div className="card stat">
      <div className="label">{text}</div>
      <div className="value">{value}</div>
      {hint && <div className="small muted">{hint}</div>}
    </div>
  );
}

// Errors that an upgrade or renewal fixes get a link to the billing page
const PLAN_CODES = ['MODULE_NOT_IN_PLAN', 'SUBSCRIPTION_INACTIVE', 'PLAN_LIMIT_REACHED'];

export function ErrorAlert({ error }) {
  if (!error) return null;
  const msg = typeof error === 'string' ? error : error.message;
  const details = Array.isArray(error.details)
    ? error.details.map((d) => (typeof d === 'string' ? d : `${d.path?.length ? `${d.path.join('.')}: ` : ''}${d.message || ''}`)).filter(Boolean).join(' · ')
    : null;
  const plan = PLAN_CODES.includes(error.code);
  return (
    <div className={`alert ${error.code === 'NOT_CONFIGURED' || plan ? 'alert-warning' : ''}`} role="alert">
      {msg}{details && !plan ? ` — ${details}` : ''}
      {plan && <> <Link to="/billing"><strong>View plans →</strong></Link></>}
    </div>
  );
}

/** Used / limit bar; limit -1 means unlimited. */
export function UsageBar({ label: text, used, limit }) {
  const unlimited = limit === undefined || limit === null || limit < 0;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  const tone = pct >= 100 ? 'var(--danger)' : pct >= 80 ? 'var(--warning)' : 'var(--primary)';
  return (
    <div className="usage">
      <div className="row"><span>{text}</span><span className="right mono">{used.toLocaleString()} / {unlimited ? '∞' : limit.toLocaleString()}</span></div>
      <div className="usage-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={text}>
        <div style={{ width: unlimited ? '0%' : `${pct}%`, background: tone }} />
      </div>
    </div>
  );
}

/** Confirmation dialog for destructive actions. `confirmText` must be typed when given. */
export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, confirmText, onConfirm, onClose }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try { await onConfirm(); onClose(); } catch (e) { setError(e); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} footer={(
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy || Boolean(confirmText && typed !== confirmText)} onClick={run}>{busy ? 'Working…' : confirmLabel}</button>
      </>
    )}>
      <div className="stack">
        <ErrorAlert error={error} />
        <p style={{ margin: 0 }}>{message}</p>
        {confirmText && <Field label={`Type ${confirmText} to confirm`}><input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} /></Field>}
      </div>
    </Modal>
  );
}

/** Renders toasts raised with toast() from lib/toast.js. */
export function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const on = (e) => {
      setItems((list) => [...list, e.detail]);
      setTimeout(() => setItems((list) => list.filter((t) => t.id !== e.detail.id)), 3500);
    };
    window.addEventListener('app:toast', on);
    return () => window.removeEventListener('app:toast', on);
  }, []);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => <div key={t.id} className={`toast toast-${t.tone}`}>{t.message}</div>)}
    </div>
  );
}

export function Skeleton({ rows = 4 }) {
  return <div className="stack" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" />)}</div>;
}

export function Pagination({ page, limit, total, onChange }) {
  const pages = Math.max(1, Math.ceil((total || 0) / (limit || 1)));
  if (pages <= 1) return null;
  return (
    <div className="row small" style={{ justifyContent: 'flex-end', padding: '10px 14px' }}>
      <span className="muted">Page {page} of {pages} · {total} total</span>
      <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>Previous</button>
      <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>Next</button>
    </div>
  );
}

export function Loading() {
  return <div className="empty">Loading…</div>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

/**
 * Simple data table. columns: [{ key, label, render?(row) }]
 */
export function DataTable({ columns, rows, onRowClick, empty = 'Nothing here yet.' }) {
  if (!rows?.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || r._id || i} className={onRowClick ? 'clickable' : ''} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {columns.map((c) => <td key={c.key}>{c.render ? c.render(r) : (r[c.key] ?? '—')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
