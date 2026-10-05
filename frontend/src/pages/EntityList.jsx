import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get, patch, post } from '../lib/api.js';
import { dateTime, label, money } from '../lib/format.js';
import { DataTable, ErrorAlert, Loading, Modal, StatusBadge } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { ContactActions } from '../calling/CallButton.jsx';
import { ENTITY_CONFIG } from './entities.js';
import { EntityForm } from './EntityForm.jsx';
import { ExportButtons, ImportModal } from './ImportExport.jsx';

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
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState({});
  const [creating, setCreating] = useState(null);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const { data, loading, error: loadError, reload } = useAsync(() => get(`/${entity}`, { q, ...filter, limit: 100 }), [entity, q, filter]);

  // e.g. /contacts?new=1&phone=… from the inbound call popup
  useEffect(() => {
    if (params.get('new')) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- open the create dialog requested by the URL
      setCreating({ phone: params.get('phone') || '' });
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const save = async () => {
    setError(null);
    try {
      const created = await post(`/${entity}`, creating);
      setCreating(null);
      if (cfg.noDetail) reload();
      else navigate(`/${entity}/${created.id}`);
    } catch (e) {
      setError(e);
    }
  };

  const saveEdit = async () => {
    setError(null);
    try {
      await patch(`/${entity}/${editing.id}`, editing);
      setEditing(null);
      reload();
    } catch (e) {
      setError(e);
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
          <h1>{cfg.title}</h1>
          {data && <p>{data.total} total</p>}
        </div>
        <div className="row">
          <input className="input" style={{ width: 240 }} placeholder={`Search ${cfg.title.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          {(cfg.filters || []).map((f) => (
            <select key={f.key} className="input" style={{ width: 160 }} value={filter[f.key] || ''} onChange={(e) => setFilter({ ...filter, [f.key]: e.target.value })} aria-label={`Filter by ${f.key}`}>
              <option value="">All {label(f.key)}</option>
              {f.options.map((o) => <option key={o} value={o}>{label(o)}</option>)}
            </select>
          ))}
          {!cfg.noImportExport && <ExportButtons entity={entity} query={{ q, ...filter }} />}
          {!cfg.noImportExport && <button type="button" className="btn" onClick={() => setImporting(true)}>Import</button>}
          <button type="button" className="btn btn-primary" onClick={() => setCreating(entity === 'products' ? { active: true, taxRate: 18, unit: 'nos' } : {})}>+ New {cfg.singular}</button>
        </div>
      </div>
      <ErrorAlert error={loadError} />
      <div className="card">
        {loading && !data ? <Loading /> : (
          <DataTable
            columns={columns}
            rows={data?.items}
            onRowClick={entity === 'tasks' ? undefined : cfg.noDetail ? (r) => setEditing(r) : (r) => navigate(`/${entity}/${r.id}`)}
            empty={`No ${cfg.title.toLowerCase()} yet.`}
          />
        )}
      </div>
      {importing && <ImportModal entity={entity} title={cfg.title} onClose={() => setImporting(false)} onImported={reload} />}
      {editing && (
        <Modal
          title={`Edit ${cfg.singular}`}
          onClose={() => setEditing(null)}
          footer={<><button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={saveEdit}>Save</button></>}
        >
          <ErrorAlert error={error} />
          <EntityForm entity={entity} value={editing} onChange={setEditing} />
        </Modal>
      )}
      {creating && (
        <Modal
          title={`New ${cfg.singular}`}
          onClose={() => setCreating(null)}
          footer={<><button type="button" className="btn" onClick={() => setCreating(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Create</button></>}
        >
          <ErrorAlert error={error} />
          <EntityForm entity={entity} value={creating} onChange={setCreating} />
        </Modal>
      )}
    </>
  );
}
