import { useEffect, useState } from 'react';
import { get } from './api.js';

// One shared request for the company's people, reused by every owner picker / owner column on a page
let cache = null;
let pending = null;

function loadTeam() {
  if (cache) return Promise.resolve(cache);
  pending = pending || get('/users', { limit: 200 })
    .then((r) => { cache = (r.items || []).filter((u) => u.active !== false); return cache; })
    .finally(() => { pending = null; });
  return pending;
}

/** Active members of the signed-in company: [{ id, name, ... }]. */
export function useTeam() {
  const [team, setTeam] = useState(cache || []);
  useEffect(() => { let alive = true; loadTeam().then((t) => alive && setTeam(t)).catch(() => {}); return () => { alive = false; }; }, []);
  return team;
}

export function OwnerName({ id }) {
  const team = useTeam();
  if (!id) return '—';
  return team.find((u) => u.id === String(id))?.name || '…';
}
