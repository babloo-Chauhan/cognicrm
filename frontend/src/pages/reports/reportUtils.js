import { useSearchParams } from 'react-router-dom';

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); };

/** Quick periods; `custom` keeps whatever dates are typed. */
export const PRESETS = [
  ['today', 'Today', () => [fmt(new Date()), fmt(new Date())]],
  ['7d', 'Last 7 days', () => [daysAgo(6), fmt(new Date())]],
  ['month', 'This month', () => { const d = new Date(); return [fmt(new Date(d.getFullYear(), d.getMonth(), 1)), fmt(d)]; }],
  ['lastmonth', 'Last month', () => { const d = new Date(); return [fmt(new Date(d.getFullYear(), d.getMonth() - 1, 1)), fmt(new Date(d.getFullYear(), d.getMonth(), 0))]; }],
  ['30d', 'Last 30 days', () => [daysAgo(29), fmt(new Date())]],
  ['90d', 'Last 90 days', () => [daysAgo(89), fmt(new Date())]],
  ['year', 'This year', () => [fmt(new Date(new Date().getFullYear(), 0, 1)), fmt(new Date())]],
];

/** Report period kept in the URL (?period=month or ?from=…&to=…), so a report can be bookmarked or shared. */
export function usePeriod() {
  const [params, setParams] = useSearchParams();
  const preset = params.get('period') || (params.get('from') ? 'custom' : 'month');
  const found = PRESETS.find(([k]) => k === preset);
  const [from, to] = found ? found[2]() : [params.get('from') || daysAgo(29), params.get('to') || fmt(new Date())];
  const set = (next) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k); }
    setParams(p, { replace: true });
  };
  return {
    preset, from, to, params,
    choose: (key) => (key === 'custom' ? set({ period: null, from, to }) : set({ period: key, from: null, to: null })),
    setDates: (f, t) => set({ period: null, from: f, to: t }),
    set,
  };
}

const BOM = String.fromCharCode(0xfeff);

/** Downloads rows as a CSV file Excel opens directly (UTF-8 BOM keeps ₹ and Hindi names intact). */
export function downloadCsv(filename, columns, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [columns.map((c) => cell(c.label)), ...rows.map((r) => columns.map((c) => cell(c.value(r))))].map((r) => r.join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`${BOM}${text}`], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const PALETTE = ['#4f46e5', '#0d9488', '#e11d48', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#4b5563'];

/** "2026-10" → "Oct 2026", "2026-10-16" → "16 Oct" for chart axes. */
export function bucketLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d || 1);
  return d ? date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : date.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}
