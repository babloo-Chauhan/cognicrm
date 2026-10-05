import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, ChevronLeft, ChevronRight, CircleAlert, Inbox, Loader2, Sparkles,
} from 'lucide-react';
import { label } from '../lib/format.js';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton as ShadSkeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tabs as ShadTabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * Product UI kit on top of shadcn/ui. Pages use these wrappers so the whole app shares one look;
 * the APIs are the ones the pages already used (Modal, Field, StatusBadge, Tabs, Stat, DataTable…).
 */

export function Modal({ title, description, onClose, children, footer, size }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose?.()}>
      <DialogContent className={cn('max-h-[90vh] overflow-y-auto gap-0 p-0', size === 'lg' ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="font-[family-name:var(--font-display)]">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="px-6 py-5">{children}</div>
        {footer && <DialogFooter className="border-t bg-muted/40 px-6 py-3">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

export function Field({ label: text, children, className = '', hint }) {
  return (
    <label className={cn('field', className)}>
      <span>{text}</span>
      {children}
      {hint && <small className="text-xs text-muted-foreground">{hint}</small>}
    </label>
  );
}

const STATUS_TONE = {
  completed: 'success', in_progress: 'info', available: 'success', online: 'info', running: 'success', open: 'success',
  won: 'success', delivered: 'success', read: 'success', qualified: 'success', active: 'success', published: 'success', sent: 'info',
  ringing: 'warning', queued: 'warning', on_hold: 'warning', wrap_up: 'warning', break: 'warning', paused: 'warning',
  pending: 'warning', on_call: 'info', busy: 'danger', failed: 'danger', no_answer: 'danger', abandoned: 'danger',
  lost: 'danger', canceled: 'danger', closed: 'danger', dnc: 'danger', invalid: 'danger', urgent: 'danger', high: 'warning',
  voicemail: 'info', offline: '', draft: '', new: 'info', hot: 'danger', warm: 'warning', cold: '', trial: 'info',
  accepted: 'success', rejected: 'danger', expired: 'danger', revised: '', issued: 'info', partially_paid: 'warning', paid: 'success', overdue: 'danger', void: '',
  proposal: 'info', negotiation: 'warning', contacted: 'info', converted: 'success', suspended: 'danger', refunded: 'warning', success: 'success',
};

const TONE_CLASS = {
  success: 'bg-success/12 text-success border-success/25',
  warning: 'bg-warning/15 text-[color-mix(in_oklch,var(--warning)_75%,var(--foreground))] border-warning/30',
  danger: 'bg-destructive/10 text-destructive border-destructive/25',
  info: 'bg-primary/10 text-primary border-primary/25',
  '': 'bg-muted text-muted-foreground border-transparent',
};

export function StatusBadge({ status, text }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const tone = STATUS_TONE[status] ?? '';
  return (
    <Badge variant="outline" className={cn('gap-1.5 rounded-full px-2.5 font-semibold', TONE_CLASS[tone])}>
      <span className="size-1.5 rounded-full bg-current" />
      {text || label(status)}
    </Badge>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <ShadTabs value={value} onValueChange={onChange} className="mb-5 max-w-full overflow-x-auto">
      <TabsList className="h-10">
        {tabs.map((t) => <TabsTrigger key={t.key} value={t.key} className="px-4">{t.label}</TabsTrigger>)}
      </TabsList>
    </ShadTabs>
  );
}

const STAT_TONES = {
  primary: 'from-chart-1/15 text-chart-1',
  teal: 'from-chart-2/15 text-chart-2',
  amber: 'from-chart-3/20 text-[color-mix(in_oklch,var(--chart-3)_70%,var(--foreground))]',
  rose: 'from-chart-4/15 text-chart-4',
  sky: 'from-chart-5/15 text-chart-5',
};

/** KPI card. `icon` is a lucide component; `tone` picks one of the chart colors. */
export function Stat({ label: text, value, hint, icon: Icon, tone = 'primary' }) {
  return (
    <div className="card group relative overflow-hidden p-4 transition-shadow hover:shadow-pop">
      <div className={cn('pointer-events-none absolute -right-8 -top-8 size-28 rounded-full bg-gradient-to-br to-transparent opacity-70 blur-xl', STAT_TONES[tone])} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">{text}</div>
          <div className="mt-1.5 truncate font-[family-name:var(--font-display)] text-[26px] font-bold leading-none tracking-tight tabular-nums">{value}</div>
          {hint && <div className="mt-2 truncate text-xs text-muted-foreground">{hint}</div>}
        </div>
        {Icon && (
          <div className={cn('grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br to-transparent ring-1 ring-inset ring-current/15', STAT_TONES[tone])}>
            <Icon className="size-5" />
          </div>
        )}
      </div>
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
  const warn = error.code === 'NOT_CONFIGURED' || plan;
  const Icon = warn ? AlertTriangle : CircleAlert;
  return (
    <div role="alert" className={cn('flex items-start gap-3 rounded-lg border px-4 py-3 text-sm', warn ? 'border-warning/30 bg-warning/10' : 'border-destructive/25 bg-destructive/8 text-destructive')}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', warn && 'text-warning')} />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{msg}</span>
        {details && !plan && <span className="opacity-80"> — {details}</span>}
        {plan && (
          <Link to="/billing" className="ml-2 inline-flex items-center gap-1 font-semibold">
            View plans <ArrowRight className="size-3.5" />
          </Link>
        )}
      </div>
    </div>
  );
}

/** Used / limit bar; limit -1 means unlimited. */
export function UsageBar({ label: text, used, limit }) {
  const unlimited = limit === undefined || limit === null || limit < 0;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  const tone = pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-warning' : 'bg-gradient-to-r from-chart-1 to-chart-2';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center text-sm">
        <span className="font-medium">{text}</span>
        <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
          {used.toLocaleString()} / {unlimited ? '∞' : limit.toLocaleString()}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={text}>
        <div className={cn('h-full rounded-full transition-all duration-500', tone)} style={{ width: unlimited ? '0%' : `${Math.max(pct, used ? 2 : 0)}%` }} />
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
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? 'destructive' : 'default'} disabled={busy || Boolean(confirmText && typed !== confirmText)} onClick={run}>
          {busy && <Loader2 className="animate-spin" />}{confirmLabel}
        </Button>
      </>
    )}>
      <div className="flex flex-col gap-3">
        <ErrorAlert error={error} />
        <p className="text-sm text-muted-foreground">{message}</p>
        {confirmText && <Field label={`Type ${confirmText} to confirm`}><input className="input font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} /></Field>}
      </div>
    </Modal>
  );
}

/** Kept for older imports; toasts are rendered by Sonner (see main.jsx). */
export function ToastHost() {
  return null;
}

export function Skeleton({ rows = 4 }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <ShadSkeleton key={i} className="h-4" style={{ width: `${92 - ((i * 17) % 35)}%` }} />)}
    </div>
  );
}

export function Pagination({ page, limit, total, onChange }) {
  const pages = Math.max(1, Math.ceil((total || 0) / (limit || 1)));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 border-t px-4 py-3 text-xs">
      <span className="mr-auto text-muted-foreground">Page {page} of {pages} · {total} total</span>
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft />Previous</Button>
      <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>Next<ChevronRight /></Button>
    </div>
  );
}

export function Loading() {
  return (
    <div className="grid place-items-center py-16 text-muted-foreground">
      <Loader2 className="size-6 animate-spin text-primary" aria-label="Loading" />
    </div>
  );
}

export function Empty({ children, icon: Icon = Inbox }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
      <div className="grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-primary/15 to-chart-2/10 text-primary">
        <Icon className="size-5" />
      </div>
      <div>{children}</div>
    </div>
  );
}

/** Small "new / AI" accent chip used in headers. */
export function Spark({ children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-primary/15 to-chart-2/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
      <Sparkles className="size-3" />{children}
    </span>
  );
}

/**
 * Data table. columns: [{ key, label, render?(row) }]
 */
export function DataTable({ columns, rows, onRowClick, empty = 'Nothing here yet.' }) {
  if (!rows?.length) return <Empty>{empty}</Empty>;
  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-muted/50 hover:bg-muted/50">
          {columns.map((c) => <TableHead key={c.key} className="h-10 px-4 text-[11px] font-semibold uppercase tracking-wider">{c.label}</TableHead>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={r.id || r._id || i} className={cn(onRowClick && 'cursor-pointer')} onClick={onRowClick ? () => onRowClick(r) : undefined}>
            {columns.map((c) => <TableCell key={c.key} className="px-4 py-3">{c.render ? c.render(r) : (r[c.key] ?? '—')}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
