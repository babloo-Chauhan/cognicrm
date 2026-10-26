import { useState } from 'react';
import { UserCheck, X } from 'lucide-react';
import { post } from '../lib/api.js';
import { useTeam } from '../lib/team.js';
import { ErrorAlert, Modal } from '../components/ui.jsx';

const fmt = (n) => n.toLocaleString('en-IN');

/** Header / row checkbox that does not open the lead when clicked. */
export function SelectBox({ checked, indeterminate, onChange, label }) {
  return (
    <input
      type="checkbox" className="size-4 cursor-pointer accent-[var(--primary)]" aria-label={label}
      checked={checked} ref={(el) => { if (el) el.indeterminate = Boolean(indeterminate); }}
      onClick={(e) => e.stopPropagation()} onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/**
 * Shown above the leads list once leads are ticked: how many, "select all N matching", and Assign / Unassign.
 * `selection` is { ids: Set } for ticked rows or { all: true } for every lead matching `filter`.
 */
export function BulkAssignBar({ selection, pageCount, total, filter, onSelectAll, onClear, onDone }) {
  const [open, setOpen] = useState(false);
  const count = selection.all ? total : selection.ids.size;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2 text-sm">
      <strong>{fmt(count)} selected</strong>
      {!selection.all && selection.ids.size === pageCount && total > pageCount && (
        <button type="button" className="btn btn-sm" onClick={onSelectAll}>Select all {fmt(total)} matching leads</button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(true)}><UserCheck className="size-4" />Assign to…</button>
        <button type="button" className="btn btn-sm" onClick={onClear} aria-label="Clear selection"><X className="size-4" />Clear</button>
      </div>
      {open && <AssignDialog selection={selection} count={count} filter={filter} onClose={() => setOpen(false)} onDone={(r) => { setOpen(false); onDone(r); }} />}
    </div>
  );
}

function AssignDialog({ selection, count, filter, onClose, onDone }) {
  const team = useTeam();
  const [picked, setPicked] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  // Same split the server makes: in turn, so the first people get one more when it does not divide evenly
  const share = (i) => Math.floor(count / picked.length) + (i < count % picked.length ? 1 : 0);
  const run = async (userIds) => {
    setSaving(true);
    setError(null);
    try {
      const body = selection.all ? { filter, userIds } : { ids: [...selection.ids], userIds };
      onDone(await post('/leads/bulk-assign', body));
    } catch (e) {
      setError(e);
      setSaving(false);
    }
  };
  return (
    <Modal
      title={`Assign ${fmt(count)} lead${count === 1 ? '' : 's'}`}
      description="Pick one person to give them all, or several to share them in turn (round-robin). Everyone gets a notification."
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn mr-auto" disabled={saving} onClick={() => run([])} title="Take these leads away from whoever has them">Unassign</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!picked.length || saving} onClick={() => run(picked)}>
            {saving ? 'Assigning…' : picked.length > 1 ? `Share between ${picked.length}` : 'Assign'}
          </button>
        </>
      )}
    >
      <ErrorAlert error={error} />
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{picked.length ? `${picked.length} chosen` : 'Choose team members'}</span>
        <span className="flex gap-3">
          <button type="button" className="underline" onClick={() => setPicked(team.map((u) => u.id))}>All</button>
          <button type="button" className="underline" onClick={() => setPicked([])}>None</button>
        </span>
      </div>
      <div className="max-h-[50vh] divide-y overflow-y-auto rounded-md border">
        {team.map((u) => {
          const i = picked.indexOf(u.id);
          return (
            <label key={u.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50">
              <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={i >= 0} onChange={() => toggle(u.id)} />
              <span className="flex-1">{u.name}<span className="ml-2 text-xs text-muted-foreground">{u.email}</span></span>
              {i >= 0 && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">{fmt(share(i))} leads</span>}
            </label>
          );
        })}
      </div>
    </Modal>
  );
}
