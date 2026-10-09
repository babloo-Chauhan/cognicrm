import { useEffect, useState } from 'react';
import { get } from '../lib/api.js';
import { label } from '../lib/format.js';
import { Field } from '../components/ui.jsx';
import { ENTITY_CONFIG } from './entities.js';
import { useTeam } from '../lib/team.js';

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

export function RefSelect({ entity, value, onChange }) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    get(`/${entity}`, { limit: 200 }).then((r) => setItems(r.items)).catch(() => {});
  }, [entity]);
  const cfg = ENTITY_CONFIG[entity];
  return (
    <select className="input" value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">—</option>
      {items.map((i) => <option key={i.id} value={i.id}>{cfg.nameOf(i)}</option>)}
    </select>
  );
}

function toInput(field, value) {
  if (value == null) return '';
  if (field.type === 'date') return String(value).slice(0, 10);
  if (field.type === 'datetime') return new Date(value).toISOString().slice(0, 16);
  return value;
}

/** Create / edit form generated from the entity field config. */
export function EntityForm({ entity, value, onChange }) {
  const cfg = ENTITY_CONFIG[entity];
  const set = (key, v) => onChange({ ...value, [key]: v });
  return (
    <div className="form-grid">
      {cfg.fields.map((f) => {
        const v = value[f.key];
        const common = { className: 'input', required: f.required };
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
              onChange={(e) => set(f.key, f.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : f.type === 'datetime' && e.target.value ? new Date(e.target.value).toISOString() : e.target.value)}
            />
          );
        }
        return <Field key={f.key} label={f.label} className={f.type === 'textarea' ? 'full' : ''}>{input}</Field>;
      })}
    </div>
  );
}
