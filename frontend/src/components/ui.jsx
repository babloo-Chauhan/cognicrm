import { useEffect } from 'react';
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

export function ErrorAlert({ error }) {
  if (!error) return null;
  const msg = typeof error === 'string' ? error : error.message;
  const details = Array.isArray(error.details) ? error.details.map((d) => (typeof d === 'string' ? d : d.message)).join(' · ') : null;
  return (
    <div className={`alert ${error.code === 'NOT_CONFIGURED' ? 'alert-warning' : ''}`} role="alert">
      {msg}{details ? ` — ${details}` : ''}
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
