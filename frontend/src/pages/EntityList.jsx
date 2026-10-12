import { useEffect, useState } from 'react';
import { Plus, Search, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get, patch, post } from '../lib/api.js';
import { dateTime, label, money } from '../lib/format.js';
import { DataTable, ErrorAlert, Loading, Modal, Pager, StatusBadge } from '../components/ui.jsx';
import { useAsync, useDebounced } from '../lib/hooks.js';
import { ContactActions } from '../calling/CallButton.jsx';
import { ENTITY_CONFIG, validateEntity } from './entities.js';
import { EntityForm } from './EntityForm.jsx';
import { ExportButtons, ImportModal } from './ImportExport.jsx';
import { OwnerName, useTeam } from '../lib/team.js';
import { useAuth } from '../lib/auth.jsx';

const PAGE_SIZE = 50;

function cell(entity, cfg, key, row) {
  const v = row[key];
  if (key === 'name' && entity === 'contacts') return cfg.nameOf(row);
  if (key === 'phone') {
    return (
      <span className="row">
        <span className="mono">{v || '—'}</span>
        <ContactActions phone={v} email={row.email} name={cfg.nameOf(row)} related={{ [`${cfg.type}Id`]: row.id }} />
      </span>
    );
  }
  if (key === 'ownerId' || key === 'assigneeId') return <OwnerName id={v} />;
  if (['status', 'stage', 'priority'].includes(key)) return <StatusBadge status={v} />;
  if (key === 'score') return v != null ? <StatusBadge status={v >= 70 ? 'hot' : v >= 40 ? 'warm' : 'cold'} text={String(v)} /> : '—';
  if (key === 'value' || key === 'unitPrice') return money(v, row.currency);
  if (key === 'taxRate') return v != null ? `${v}%` : '—';
  if (key === 'active') return v ? 'Yes' : 'No';
  if (['createdAt', 'dueAt', 'lastContactedAt'].includes(key)) return dateTime(v);
  if (key === 'expectedCloseDate') return v ? new Date(v).toLocaleDateString() : '—';
  if (key === 'source') return label(v);
  return v ?? '—';
}

export function EntityList({ entity }) {
  const cfg = ENTITY_CONFIG[entity];
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // ?q= comes from the global search / command palette
  const [q, setQ] = useState(() => params.get('q') || '');
  const [filter, setFilter] = useState({});
  const team = useTeam();
  const { user } = useAuth();
  const [creating, setCreating] = useState(null);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const search = useDebounced(q.trim());
  // Back to page 1 whenever the search, filters or entity change
  const [page, setPage] = useState({ n: 1, key: '' });
  const pageKey = JSON.stringify([entity, search, filter]);
  const pageNo = page.key === pageKey ? page.n : 1;
  const { data, loading, error: loadError, reload } = useAsync(
    () => get(`/${entity}`, { q: search || undefined, ...filter, page: pageNo, limit: PAGE_SIZE }),
    [entity, search, filter, pageNo],
  );

  // e.g. /contacts?new=1&phone=… from the inbound call popup
  useEffect(() => {
    if (params.get('q')) setParams({}, { replace: true });
    if (params.get('new')) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- open the create dialog requested by the URL
      setCreating({ phone: params.get('phone') || '' });
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const invalid = (value) => {
    const bad = Object.keys(validateEntity(entity, value)).length > 0;
    setShowErrors(bad);
    return bad;
  };

  // `saving` blocks a second click from creating the record twice
  const save = async () => {
    if (saving) return;
    setError(null);
    if (invalid(creating)) return;
    setSaving(true);
    try {
      const created = await post(`/${entity}`, creating);
      setCreating(null);
      if (cfg.noDetail) reload();
      else navigate(`/${entity}/${created.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (saving) return;
    setError(null);
    if (invalid(editing)) return;
    setSaving(true);
    try {
      await patch(`/${entity}/${editing.id}`, editing);
      setEditing(null);
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const columns = cfg.columns.map((key) => ({
    key,
    label: cfg.fields.find((f) => f.key === key)?.label || label(key),
    render: (row) => cell(entity, cfg, key, row),
  }));
  if (entity === 'tasks') {
    columns.push({
      key: 'actions', label: '',
      render: (row) => row.status === 'open' && (
        <button type="button" className="btn btn-sm" onClick={async (e) => { e.stopPropagation(); await patch(`/tasks/${row.id}`, { status: 'done' }); reload(); }}>Mark done</button>
      ),
    });
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="flex items-center gap-3">
            {cfg.title}
            {data && <span className="rounded-full bg-primary/10 px-2.5 py-0.5 font-sans text-xs font-semibold text-primary">{data.total.toLocaleString('en-IN')}</span>}
          </h1>
          <p>Manage your {cfg.title.toLowerCase()} — search, filter, import and export.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!cfg.noImportExport && <ExportButtons entity={entity} query={{ q, ...filter }} />}
          {!cfg.noImportExport && <Button variant="outline" onClick={() => setImporting(true)}><Upload />Import</Button>}
          <Button onClick={() => setCreating(entity === 'products' ? { active: true, taxRate: 18, unit: 'nos' } : {})} className="shadow-[0_8px_20px_-8px_var(--primary)]"><Plus />New {cfg.singular}</Button>
        </div>
      </div>
      <ErrorAlert error={loadError} />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-3">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input className="input pl-9" placeholder={`Search ${cfg.title.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          </div>
          {cfg.ownerFilter && (
            <select className="input w-auto min-w-[160px]" value={filter.ownerId || ''} onChange={(e) => setFilter({ ...filter, ownerId: e.target.value })} aria-label="Filter by owner">
              <option value="">Everyone's {cfg.title.toLowerCase()}</option>
              {user && <option value={user.id}>My {cfg.title.toLowerCase()}</option>}
              {team.filter((u) => u.id !== user?.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          {(cfg.filters || []).map((f) => (
            <select key={f.key} className="input w-auto min-w-[150px]" value={filter[f.key] || ''} onChange={(e) => setFilter({ ...filter, [f.key]: e.target.value })} aria-label={`Filter by ${f.key}`}>
              <option value="">All {label(f.key)}</option>
              {f.options.map((o) => <option key={o} value={o}>{label(o)}</option>)}
            </select>
          ))}
          {loading && data && <span className="ml-auto text-xs text-muted-foreground">Updating…</span>}
        </div>
        {loading && !data ? <Loading /> : (
          <DataTable
            columns={columns}
            rows={data?.items}
            onRowClick={entity === 'tasks' ? undefined : cfg.noDetail ? (r) => setEditing(r) : (r) => navigate(`/${entity}/${r.id}`)}
            empty={search || Object.values(filter).some(Boolean) ? `No ${cfg.title.toLowerCase()} match your search or filters.` : `No ${cfg.title.toLowerCase()} yet.`}
          />
        )}
        <Pager page={pageNo} pageSize={PAGE_SIZE} total={data?.total} loading={loading} onPage={(n) => { setPage({ n, key: pageKey }); window.scrollTo({ top: 0 }); }} />
      </div>
      {importing && <ImportModal entity={entity} title={cfg.title} onClose={() => setImporting(false)} onImported={reload} />}
      {editing && (
        <Modal
          title={`Edit ${cfg.singular}`}
          onClose={() => { setEditing(null); setShowErrors(false); }}
          footer={<><button type="button" className="btn" onClick={() => { setEditing(null); setShowErrors(false); }}>Cancel</button><button type="button" className="btn btn-primary" disabled={saving} onClick={saveEdit}>{saving ? 'Saving…' : 'Save'}</button></>}
        >
          <ErrorAlert error={error} />
          <EntityForm entity={entity} value={editing} onChange={setEditing} showErrors={showErrors} />
        </Modal>
      )}
      {creating && (
        <Modal
          title={`New ${cfg.singular}`}
          onClose={() => { setCreating(null); setShowErrors(false); }}
          footer={<><button type="button" className="btn" onClick={() => { setCreating(null); setShowErrors(false); }}>Cancel</button><button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Creating…' : 'Create'}</button></>}
        >
          <ErrorAlert error={error} />
          <EntityForm entity={entity} value={creating} onChange={setCreating} showErrors={showErrors} />
        </Modal>
      )}
    </>
  );
}
