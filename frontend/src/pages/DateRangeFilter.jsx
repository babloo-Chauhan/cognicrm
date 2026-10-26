import { useState } from 'react';
import { CalendarDays, ChevronDown, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const dayEnd = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/** Preset ranges, worked out in the user's own time (Monday starts the week). */
const DATE_PRESETS = [
  ['today', 'Today', () => [dayStart(new Date()), dayEnd(new Date())]],
  ['yesterday', 'Yesterday', () => { const y = addDays(new Date(), -1); return [dayStart(y), dayEnd(y)]; }],
  ['this_week', 'This week', () => { const n = new Date(); return [dayStart(addDays(n, -((n.getDay() + 6) % 7))), dayEnd(n)]; }],
  ['last_7', 'Last 7 days', () => [dayStart(addDays(new Date(), -6)), dayEnd(new Date())]],
  ['this_month', 'This month', () => { const n = new Date(); return [new Date(n.getFullYear(), n.getMonth(), 1), dayEnd(n)]; }],
  ['last_month', 'Last month', () => { const n = new Date(); return [new Date(n.getFullYear(), n.getMonth() - 1, 1), dayEnd(new Date(n.getFullYear(), n.getMonth(), 0))]; }],
  ['last_30', 'Last 30 days', () => [dayStart(addDays(new Date(), -29)), dayEnd(new Date())]],
];
// Follow-ups also look ahead
const FOLLOW_UP_PRESETS = [
  ['tomorrow', 'Tomorrow', () => { const t = addDays(new Date(), 1); return [dayStart(t), dayEnd(t)]; }],
  ['next_7', 'Next 7 days', () => [new Date(), dayEnd(addDays(new Date(), 7))]],
];

// <input type="datetime-local"> value in local time
const localValue = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fmt = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * Date & time filter for a list: which date (created / next follow-up), a preset or a custom from–to with times.
 * `value` is { dateField, from, to, range } (ISO strings); onChange(null) clears it.
 */
export function DateRangeFilter({ value, onChange, fields = [['created', 'Created date'], ['followUp', 'Follow-up date']] }) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState(value?.dateField || 'created');
  const [from, setFrom] = useState(localValue(value?.from));
  const [to, setTo] = useState(localValue(value?.to));
  const presets = field === 'followUp' ? [...DATE_PRESETS.slice(0, 1), ...FOLLOW_UP_PRESETS, ...DATE_PRESETS.slice(1)] : DATE_PRESETS;
  const pick = (key, range) => {
    const [a, b] = range();
    onChange({ dateField: field, from: a.toISOString(), to: b.toISOString(), range: key });
    setOpen(false);
  };
  const applyCustom = () => {
    if (!from && !to) return;
    onChange({ dateField: field, from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(to).toISOString() : undefined, range: 'custom' });
    setOpen(false);
  };
  const all = [...DATE_PRESETS, ...FOLLOW_UP_PRESETS];
  const fieldLabel = (fields.find(([k]) => k === (value?.dateField || 'created')) || fields[0])[1].replace(' date', '');
  const text = !value ? 'Date' : value.range === 'custom'
    ? `${fieldLabel}: ${value.from ? fmt(value.from) : '…'} – ${value.to ? fmt(value.to) : '…'}`
    : `${fieldLabel}: ${all.find(([k]) => k === value.range)?.[1] || 'Range'}`;
  const invalid = from && to && new Date(from) > new Date(to);
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) { setField(value?.dateField || 'created'); setFrom(localValue(value?.from)); setTo(localValue(value?.to)); } }}>
      <div className={cn('inline-flex h-9 items-center rounded-md border bg-card text-sm', value && 'border-primary/60 bg-primary/5')}>
        <PopoverTrigger asChild>
          <button type="button" className="inline-flex h-full items-center gap-1.5 px-3" aria-label="Date filter">
            <CalendarDays className="size-4 text-muted-foreground" /><span className="max-w-[260px] truncate">{text}</span><ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        {value && <button type="button" className="grid h-full place-items-center border-l px-2 text-muted-foreground hover:text-foreground" aria-label="Clear date filter" onClick={() => onChange(null)}><X className="size-3.5" /></button>}
      </div>
      <PopoverContent align="start" className="w-[320px] p-3">
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-xs font-medium">
          {fields.map(([k, t]) => (
            <button key={k} type="button" onClick={() => setField(k)} className={cn('rounded-md px-2 py-1.5', field === k ? 'bg-card shadow-sm' : 'text-muted-foreground')}>{t}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {presets.map(([key, t, range]) => (
            <button key={key} type="button" onClick={() => pick(key, range)}
              className={cn('rounded-md border px-2 py-1.5 text-left text-sm hover:border-primary/50 hover:bg-primary/5', value?.range === key && value?.dateField === field && 'border-primary bg-primary/10 font-medium')}>{t}</button>
          ))}
        </div>
        <div className="mt-3 border-t pt-3">
          <div className="mb-2 text-xs font-semibold text-muted-foreground">Custom date &amp; time</div>
          <label className="mb-2 flex flex-col gap-1 text-xs">From<input type="datetime-local" className="input h-9 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="flex flex-col gap-1 text-xs">To<input type="datetime-local" className="input h-9 text-sm" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          {invalid && <div className="mt-1 text-xs text-destructive">“From” is after “To”.</div>}
          <button type="button" className="btn btn-primary btn-sm mt-3 w-full" disabled={(!from && !to) || invalid} onClick={applyCustom}>Apply</button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
