import { useState } from 'react';
import { del, patch, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { dateTime } from '../lib/format.js';
import { OwnerName, useTeam } from '../lib/team.js';
import { ErrorAlert } from '../components/ui.jsx';
import { canReassignLead } from '../lib/leadAccess.js';

/** Who has the lead now, who else works on it, who can hand it on or add people, and every change so far. */
export function LeadAssignment({ lead, onChanged }) {
  const auth = useAuth();
  const team = useTeam();
  const isAdmin = auth.can('team_leads:assign');
  const mayAssign = canReassignLead(lead, auth);
  const me = String(auth.user?.id || '');
  // 'reassign' moves the lead to someone else; 'add' brings someone in alongside the owner
  const [picking, setPicking] = useState(null);
  const [to, setTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setSaving(true);
    setError(null);
    try {
      await fn();
      setPicking(null);
      setTo('');
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };
  const assign = (ownerId) => run(() => patch(`/leads/${lead.id}`, { ownerId }));
  const addPerson = (userId) => run(() => post(`/leads/${lead.id}/team`, { userId }));
  const removePerson = (userId) => run(() => del(`/leads/${lead.id}/team/${userId}`));
  const trail = [...(lead.assignments || [])].reverse();
  const others = (lead.assignees || []).filter((a) => String(a) !== String(lead.ownerId || ''));
  const onLead = new Set([String(lead.ownerId || ''), ...others.map(String)]);
  const choices = picking === 'add' ? team.filter((u) => !onLead.has(u.id)) : team.filter((u) => u.id !== String(lead.ownerId));
  return (
    <div className="card">
      <div className="card-header"><h3>Assigned to</h3></div>
      <div className="card-body stack">
        <ErrorAlert error={error} />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 15 }}>{lead.ownerId ? <OwnerName id={lead.ownerId} /> : 'Nobody (unassigned)'}</strong>
          {mayAssign && !picking && (
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setPicking('reassign')}>{lead.ownerId ? '⇄ Reassign' : 'Assign'}</button>
              <button type="button" className="btn btn-sm" onClick={() => setPicking('add')} title="Add a senior or colleague — the owner stays the same">+ Add person</button>
              {isAdmin && lead.ownerId && <button type="button" className="btn btn-sm" disabled={saving} onClick={() => assign(null)}>Unassign</button>}
            </div>
          )}
        </div>
        {others.length > 0 && (
          <div>
            <div className="small muted" style={{ marginBottom: 4 }}>Also working on this lead — everyone here sees it, can work on it and assign it on</div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {others.map((id) => (
                <span key={String(id)} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <OwnerName id={id} />
                  {(isAdmin || String(id) === me) && (
                    <button type="button" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', fontSize: 14, lineHeight: 1 }} disabled={saving}
                      title={String(id) === me ? 'Leave this lead' : 'Take off this lead'} aria-label="Remove" onClick={() => removePerson(String(id))}>×</button>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}
        {picking && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="small muted">{picking === 'add' ? 'Add someone to this lead (say a senior to talk to the client). The owner stays the same; they get a notification.' : 'Move the lead to someone else. You keep seeing it.'}</div>
            <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <select className="input" value={to} onChange={(e) => setTo(e.target.value)} aria-label={picking === 'add' ? 'Add person' : 'Assign to'}>
                <option value="">Choose a team member…</option>
                {choices.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <button type="button" className="btn btn-sm btn-primary" disabled={!to || saving} onClick={() => (picking === 'add' ? addPerson(to) : assign(to))}>
                {saving ? 'Saving…' : picking === 'add' ? 'Add' : 'Assign'}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => { setPicking(null); setTo(''); }}>Cancel</button>
            </div>
          </div>
        )}
        {trail.length > 0 && (
          <div>
            <div className="small muted" style={{ marginBottom: 4 }}>History</div>
            {trail.map((a, i) => (
              <div key={i} className="small" style={{ borderTop: '1px solid var(--border)', padding: '6px 0' }}>
                {a.kind === 'added' ? <>+ <strong><OwnerName id={a.to} /></strong> <span className="muted">added</span></>
                  : a.kind === 'removed' ? <>− <strong><OwnerName id={a.from} /></strong> <span className="muted">removed</span></>
                    : a.to ? <>→ <strong><OwnerName id={a.to} /></strong>{a.from && <> <span className="muted">from</span> <OwnerName id={a.from} /></>}</>
                      : <strong>Unassigned</strong>}
                <div className="muted">by <OwnerName id={a.by} /> · {dateTime(a.at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
