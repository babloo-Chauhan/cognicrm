import { useEffect, useState } from 'react';
import { get } from '../lib/api.js';
import { label } from '../lib/format.js';
import { Field } from '../components/ui.jsx';
import { ENTITY_CONFIG, validateEntity } from './entities.js';
import { phoneChars } from '../lib/validation.js';
import { useTeam } from '../lib/team.js';
import { useDebounced } from '../lib/hooks.js';

/** Picks an active team member (lead owner, task assignee…). */
export function UserSelect({ value, onChange }) {
  const team = useTeam();
  return (
    <select className="input" value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">— Unassigned —</option>
      {team.map((u) => <option key={u.id} value={u.id}>{u.name}{u.designation ? ` · ${u.designation}` : ''}</option>)}
    </select>
  );
}

/**
 * Searchable picker for a related record (account, contact, deal…). It searches the server as you type,
 * so it works with any number of records (a plain <select> would only ever hold the first page).
 */
export function RefSelect({ entity, value, onChange }) {
  const cfg = ENTITY_CONFIG[entity];
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [active, setActive] = useState(0);
  const search = useDebounced(q.trim(), 250);

  // Name of the record already linked (e.g. when editing)
  useEffect(() => {
    if (!value) return undefined;
    let alive = true;
    get(`/${entity}/${value}`).then((r) => alive && setName(cfg.nameOf(r))).catch(() => alive && setName('(not found)'));
    return () => { alive = false; };
  }, [entity, value, cfg]);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    get(`/${entity}`, { q: search || undefined, limit: 20 }).then((r) => alive && setItems(r.items)).catch(() => {});
    return () => { alive = false; };
  }, [entity, search, open]);

  const pick = (item) => {
    onChange(item ? item.id : null);
    setName(item ? cfg.nameOf(item) : '');
    setQ('');
    setOpen(false);
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, items.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === 'Enter' && open && items[active]) { e.preventDefault(); pick(items[active]); }
    if (e.key === 'Escape') { setOpen(false); setQ(''); }
  };

  return (
    <div className="relative">
      <div className="flex gap-1">
        <input
          className="input"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          autoComplete="crm-record"
          placeholder={value ? '' : `Search ${cfg.title.toLowerCase()}…`}
          value={open ? q : (value ? name : '')}
          onFocus={() => { setOpen(true); setActive(0); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
          onKeyDown={onKeyDown}
        />
        {value && <button type="button" className="btn btn-ghost btn-icon" aria-label="Clear" onClick={() => pick(null)}>✕</button>}
      </div>
      {open && (
        <ul role="listbox" className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md">
          {items.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">{search ? 'No matches' : 'Type to search'}</li>}
          {items.map((i, n) => (
            <li
              key={i.id}
              role="option"
              aria-selected={n === active}
              className={`cursor-pointer rounded px-2 py-1.5 ${n === active ? 'bg-accent text-accent-foreground' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(i); }}
              onMouseEnter={() => setActive(n)}
            >
              {cfg.nameOf(i)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function toInput(field, value) {
  if (value == null) return '';
  if (field.type === 'date') return String(value).slice(0, 10);
  if (field.type === 'datetime') return new Date(value).toISOString().slice(0, 16);
  return value;
}

/**
 * Create / edit form generated from the entity field config.
 * A field shows its error once it has been left (blur), or for every field after a save attempt (`showErrors`).
 */
export function EntityForm({ entity, value, onChange, showErrors = false }) {
  const cfg = ENTITY_CONFIG[entity];
  const [touched, setTouched] = useState({});
  // onChange is a state setter: build on the latest value so quick successive changes don't overwrite each other
  const set = (key, v) => onChange((cur) => ({ ...cur, [key]: v }));
  const errors = validateEntity(entity, value);
  return (
    <div className="form-grid">
      {cfg.fields.map((f) => {
        const v = value[f.key];
        const error = (showErrors || touched[f.key]) ? errors[f.key] : null;
        const common = {
          className: 'input',
          required: f.required,
          'aria-invalid': error ? true : undefined,
          // These are customers' details, not the user's: keep Chrome from offering its own name / address.
          // Chrome ignores "off" for address autofill but skips fields whose token it does not recognise.
          autoComplete: 'crm-record',
          placeholder: f.placeholder,
          onBlur: () => setTouched((t) => (t[f.key] ? t : { ...t, [f.key]: true })),
        };
        let input;
        if (f.type === 'select') {
          input = (
            <select {...common} value={v || ''} onChange={(e) => set(f.key, e.target.value)}>
              {!f.options.includes('') && <option value="">—</option>}
              {f.options.map((o) => <option key={o} value={o}>{o ? label(o) : '—'}</option>)}
            </select>
          );
        } else if (f.type === 'textarea') {
          input = <textarea {...common} value={v || ''} onChange={(e) => set(f.key, e.target.value)} />;
        } else if (f.type === 'user') {
          input = <UserSelect value={v} onChange={(id) => set(f.key, id)} />;
        } else if (f.type === 'ref') {
          input = <RefSelect entity={f.ref} value={v} onChange={(id) => set(f.key, id)} />;
        } else if (f.type === 'checkbox') {
          return (
            <label key={f.key} className="checkbox">
              <input type="checkbox" checked={Boolean(v)} onChange={(e) => set(f.key, e.target.checked)} /> {f.label}
            </label>
          );
        } else {
          const type = { email: 'email', phone: 'tel', number: 'number', date: 'date', datetime: 'datetime-local' }[f.type] || 'text';
          input = (
            <input
              {...common}
              type={type}
              value={toInput(f, v)}
              maxLength={f.type === 'phone' ? 20 : undefined}
              onChange={(e) => set(f.key, f.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : f.type === 'datetime' && e.target.value ? new Date(e.target.value).toISOString() : f.type === 'phone' ? phoneChars(e.target.value) : e.target.value)}
            />
          );
        }
        return <Field key={f.key} label={f.label} required={f.required} error={error} className={f.type === 'textarea' ? 'full' : ''}>{input}</Field>;
      })}
    </div>
  );
}
