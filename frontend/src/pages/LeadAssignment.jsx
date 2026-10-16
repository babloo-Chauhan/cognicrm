import { useState } from 'react';
import { patch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { dateTime } from '../lib/format.js';
import { OwnerName, useTeam } from '../lib/team.js';
import { ErrorAlert } from '../components/ui.jsx';
import { canReassignLead } from '../lib/leadAccess.js';

/** Who has the lead now, who can hand it on, and every hand-over so far. */
export function LeadAssignment({ lead, onChanged }) {
  const auth = useAuth();
  const team = useTeam();
  const isAdmin = auth.can('team_leads:assign');
  const mayAssign = canReassignLead(lead, auth);
  const [picking, setPicking] = useState(false);
  const [to, setTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const assign = async (ownerId) => {
    setSaving(true);
    setError(null);
    try {
      await patch(`/leads/${lead.id}`, { ownerId });
      setPicking(false);
      setTo('');
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };
  const trail = [...(lead.assignments || [])].reverse();
  const youHadIt = !isAdmin && String(lead.ownerId) !== String(auth.user?.id);
  return (
    <div className="card">
      <div className="card-header"><h3>Assigned to</h3></div>
      <div className="card-body stack">
        <ErrorAlert error={error} />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 15 }}>{lead.ownerId ? <OwnerName id={lead.ownerId} /> : 'Nobody (unassigned)'}</strong>
          {mayAssign && !picking && (
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setPicking(true)}>{lead.ownerId ? '⇄ Reassign' : 'Assign'}</button>
              {isAdmin && lead.ownerId && <button type="button" className="btn btn-sm" disabled={saving} onClick={() => assign(null)}>Unassign</button>}
            </div>
          )}
        </div>
        {youHadIt && <div className="small muted">You passed this lead on. You can still see it, but only the admin or the person who has it now can move it.</div>}
        {picking && (
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <select className="input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Assign to">
              <option value="">Choose a team member…</option>
              {team.filter((u) => u.id !== String(lead.ownerId)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <button type="button" className="btn btn-sm btn-primary" disabled={!to || saving} onClick={() => assign(to)}>{saving ? 'Saving…' : 'Assign'}</button>
            <button type="button" className="btn btn-sm" onClick={() => { setPicking(false); setTo(''); }}>Cancel</button>
          </div>
        )}
        {trail.length > 0 && (
          <div>
            <div className="small muted" style={{ marginBottom: 4 }}>History</div>
            {trail.map((a, i) => (
              <div key={i} className="small" style={{ borderTop: '1px solid var(--border)', padding: '6px 0' }}>
                {a.to ? <>→ <strong><OwnerName id={a.to} /></strong></> : <strong>Unassigned</strong>}
                {a.from && <> <span className="muted">from</span> <OwnerName id={a.from} /></>}
                <div className="muted">by <OwnerName id={a.by} /> · {dateTime(a.at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
