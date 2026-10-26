import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Bell, Building2, CalendarCheck, CalendarClock, ChevronLeft, ChevronRight, Columns3, Download, Eye, Mail, MessageCircle,
  MessageSquare, MoreVertical, Pencil, Phone, Plus, Search, StickyNote, Trash2, Upload, Users, X,
} from 'lucide-react';
import { del, download, get, patch, post } from '../lib/api.js';
import { label } from '../lib/format.js';
import { useAsync, useDebounced } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useTeam } from '../lib/team.js';
import { toast } from '../lib/toast.js';
import { useCalls } from '../calling/CallContext.jsx';
import {
  ConfirmDialog, Empty, ErrorAlert, Loading, Modal,
} from '../components/ui.jsx';
import { ENTITY_CONFIG, validateEntity } from './entities.js';
import { EntityForm } from './EntityForm.jsx';
import { ImportModal } from './ImportExport.jsx';
import { BulkAssignBar, SelectBox } from './BulkAssign.jsx';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const cfg = ENTITY_CONFIG.leads;
const STATUSES = cfg.filters.find((f) => f.key === 'status').options;
const SOURCES = cfg.fields.find((f) => f.key === 'source').options;
const PAGE_SIZES = [10, 25, 50, 100];

const STATUS_STYLE = {
  new: 'bg-info/15 text-info', contacted: 'bg-warning/20 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]',
  qualified: 'bg-chart-1/15 text-primary', proposal: 'bg-chart-5/15 text-chart-5', negotiation: 'bg-chart-3/20 text-[color-mix(in_oklch,var(--chart-3)_70%,var(--foreground))]',
  won: 'bg-success/15 text-success', converted: 'bg-primary text-primary-foreground', lost: 'bg-destructive/12 text-destructive', unqualified: 'bg-muted text-muted-foreground',
};
const FOLLOW_UP = {
  call: { icon: Phone, text: 'Call', cls: 'text-warning' },
  appointment: { icon: Users, text: 'Meeting', cls: 'text-info' },
  whatsapp: { icon: MessageCircle, text: 'WhatsApp', cls: 'text-success' },
  sms: { icon: MessageSquare, text: 'SMS', cls: 'text-chart-5' },
  email: { icon: Mail, text: 'Email', cls: 'text-chart-3' },
  note: { icon: StickyNote, text: 'Note', cls: 'text-muted-foreground' },
};
const REMINDERS = [['missed', 'Missed'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['none', 'No reminder']];

// Columns the user can hide (Name, select and actions always show)
const COLUMNS = [
  ['lastFollowUp', 'Last follow-up'], ['status', 'Status'], ['source', 'Source'], ['ownerId', 'Assignee'], ['createdAt', 'Created at'],
  ['reminder', 'Reminders'], ['description', 'Description'], ['address', 'Address'], ['phone', 'Phone'],
];
const COLUMN_KEY = 'leads.hiddenColumns';
const SIZE_KEY = 'leads.pageSize';
const readStore = (key, fallback) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const writeStore = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage off */ } };

const shortDate = (v) => (v ? new Date(v).toLocaleString(undefined, { month: 'short', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
const AVATAR = ['bg-chart-1/20 text-primary', 'bg-chart-2/20 text-success', 'bg-chart-3/25 text-[color-mix(in_oklch,var(--chart-3)_65%,var(--foreground))]', 'bg-chart-4/20 text-destructive', 'bg-chart-5/20 text-info'];
const avatarTone = (id = '') => AVATAR[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR.length];

/** Missed / Today / Upcoming from the lead's next follow-up. */
function reminderOf(at) {
  if (!at) return null;
  const d = new Date(at);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86400000);
  if (d < Math.min(Date.now(), end)) return { text: 'Missed', icon: Bell, cls: 'text-destructive' };
  if (d < end) return { text: 'Today', icon: CalendarCheck, cls: 'text-success' };
  return { text: 'Upcoming', icon: CalendarClock, cls: 'text-info' };
}

function FilterSelect({ value, onChange, placeholder, options, labelText }) {
  return (
    <select className={cn('input h-9 w-auto min-w-[120px] py-0 text-sm', value && 'border-primary/60 bg-primary/5')} value={value || ''} onChange={(e) => onChange(e.target.value)} aria-label={labelText}>
      <option value="">{placeholder}</option>
      {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
    </select>
  );
}

function Pages({ page, pages, onPage }) {
  const list = [];
  for (let n = 1; n <= pages; n += 1) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 1) list.push(n);
    else if (list[list.length - 1] !== '…') list.push('…');
  }
  return (
    <div className="flex items-center gap-1">
      <button type="button" className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-40" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></button>
      {list.map((n, i) => (n === '…' ? <span key={`e${i}`} className="px-1 text-muted-foreground">…</span> : (
        <button key={n} type="button" onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined}
          className={cn('h-8 min-w-8 rounded-md px-2 text-sm', n === page ? 'border bg-card font-semibold shadow-sm' : 'text-muted-foreground hover:bg-muted')}>{n}</button>
      )))}
      <button type="button" className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-40" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></button>
    </div>
  );
}

function RowMenu({ lead, onOpen, onEdit, onDelete }) {
  const { dial } = useCalls();
  const { can, hasModule } = useAuth();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Actions for ${lead.name}`} onClick={(e) => e.stopPropagation()}><MoreVertical className="size-4" /></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={onOpen}><Eye />Open</DropdownMenuItem>
        {can('leads:update') && <DropdownMenuItem onSelect={onEdit}><Pencil />Edit</DropdownMenuItem>}
        {lead.phone && hasModule('calling') && can('calls:make') && <DropdownMenuItem onSelect={() => dial(lead.phone, { name: lead.name, related: { leadId: lead.id } })}><Phone />Call</DropdownMenuItem>}
        {lead.phone && <DropdownMenuItem onSelect={() => window.open(`https://wa.me/${lead.phone.replace(/\D/g, '')}`, '_blank', 'noopener')}><MessageCircle />WhatsApp</DropdownMenuItem>}
        {can('leads:delete') && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={onDelete}><Trash2 />Delete</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The leads list: filters, configurable columns, reminders, last follow-up, bulk assign and page numbers. */
export function LeadsList() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const auth = useAuth();
  const { user, can } = auth;
  const team = useTeam();
  const [q, setQ] = useState(() => params.get('q') || '');
  // ?ownerId= / ?status= come from reports and dashboard cards
  const [filter, setFilter] = useState(() => Object.fromEntries(['ownerId', 'status', 'source', 'reminder'].filter((k) => params.get(k)).map((k) => [k, params.get(k)])));
  const [pageSize, setPageSize] = useState(() => readStore(SIZE_KEY, 25));
  const [hidden, setHidden] = useState(() => readStore(COLUMN_KEY, ['phone']));
  const [creating, setCreating] = useState(null);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [importing, setImporting] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const search = useDebounced(q.trim());
  const key = JSON.stringify([search, filter, pageSize]);
  const [page, setPage] = useState({ n: 1, key: '' });
  const pageNo = page.key === key ? page.n : 1;
  const query = { q: search || undefined, ...filter };
  const { data, loading, error: loadError, reload } = useAsync(() => get('/leads', { ...query, page: pageNo, limit: pageSize }), [key, pageNo]);

  const canBulkAssign = can('team_leads:assign');
  const [selection, setSelection] = useState({ ids: new Set(), key: '' });
  const picked = selection.key === key ? selection : { ids: new Set(), key };
  const [assigned, setAssigned] = useState(null);
  const rows = data?.items || [];
  const pageIds = rows.map((r) => r.id);
  const pickedOnPage = pageIds.filter((id) => picked.all || picked.ids.has(id)).length;
  const setPicked = (ids) => setSelection({ ids, key });
  const pickRow = (id, on) => { const ids = new Set(picked.all ? pageIds : picked.ids); if (on) ids.add(id); else ids.delete(id); setPicked(ids); };
  const pickPage = (on) => { const ids = new Set(picked.all ? [] : picked.ids); for (const id of pageIds) if (on) ids.add(id); else ids.delete(id); setPicked(ids); };

  useEffect(() => {
    if (params.get('new')) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- open the create dialog requested by the URL
      setCreating({ phone: params.get('phone') || '' });
      setParams({}, { replace: true });
    } else if ([...params.keys()].length) setParams({}, { replace: true });
  }, [params, setParams]);

  const setF = (k, v) => setFilter((f) => { const n = { ...f, [k]: v }; if (!v) delete n[k]; return n; });
  const active = search || Object.keys(filter).length > 0;
  const show = (col) => !hidden.includes(col);
  const toggleColumn = (col) => { const next = hidden.includes(col) ? hidden.filter((c) => c !== col) : [...hidden, col]; setHidden(next); writeStore(COLUMN_KEY, next); };
  const ownerName = (id) => team.find((u) => u.id === String(id))?.name;

  const invalid = (value) => { const bad = Object.keys(validateEntity('leads', value)).length > 0; setShowErrors(bad); return bad; };
  const save = async (value, isNew) => {
    if (saving || invalid(value)) return;
    setSaving(true);
    setError(null);
    try {
      if (isNew) { const created = await post('/leads', value); setCreating(null); navigate(`/leads/${created.id}`); } else { await patch(`/leads/${value.id}`, value); setEditing(null); toast('Lead saved'); reload(); }
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };
  const exportAs = async (format) => {
    try { await download('/leads/export', { ...query, format }, `leads.${format}`); } catch (e) { toast(e.message, 'error'); }
  };

  const th = 'whitespace-nowrap px-2.5 py-2 text-left text-xs font-semibold text-muted-foreground';
  const td = 'px-2.5 py-1.5 align-middle';
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-3 text-2xl">
          Leads
          {data && <span className="rounded-full bg-primary/10 px-2.5 py-0.5 font-sans text-xs font-semibold text-primary">{data.total.toLocaleString('en-IN')}</span>}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {can('leads:create') && <Button onClick={() => setCreating({})}><Plus />Add lead</Button>}
          {can('crm:import') && <Button variant="outline" onClick={() => setImporting(true)}><Upload />Import leads</Button>}
          {can('crm:export') && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="Export"><Download /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Export {active ? 'filtered' : 'all'} leads</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => exportAs('xlsx')}>Excel (.xlsx)</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportAs('csv')}>CSV</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="Choose columns"><Columns3 /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Columns</DropdownMenuLabel>
              {COLUMNS.map(([col, text]) => <DropdownMenuCheckboxItem key={col} checked={show(col)} onCheckedChange={() => toggleColumn(col)} onSelect={(e) => e.preventDefault()}>{text}</DropdownMenuCheckboxItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input className="input h-9 pl-9 text-sm" placeholder="Search leads" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search leads" />
        </div>
        <FilterSelect labelText="Status" placeholder="Status" value={filter.status} onChange={(v) => setF('status', v)} options={STATUSES.map((s) => [s, label(s)])} />
        <FilterSelect labelText="Source" placeholder="Source" value={filter.source} onChange={(v) => setF('source', v)} options={SOURCES.map((s) => [s, label(s)])} />
        <FilterSelect labelText="Assignee" placeholder="Assignee" value={filter.ownerId} onChange={(v) => setF('ownerId', v)}
          options={[...(user ? [[user.id, 'Me']] : []), ...(canBulkAssign ? [['none', 'Unassigned']] : []), ...team.filter((u) => u.id !== user?.id).map((u) => [u.id, u.name])]} />
        <FilterSelect labelText="Reminders" placeholder="Reminders" value={filter.reminder} onChange={(v) => setF('reminder', v)} options={REMINDERS} />
        {active && <button type="button" className="inline-flex items-center gap-1 px-2 text-sm font-medium text-primary" onClick={() => { setQ(''); setFilter({}); }}><X className="size-3.5" />Clear filters</button>}
        {loading && data && <span className="ml-auto text-xs text-muted-foreground">Updating…</span>}
      </div>

      <ErrorAlert error={loadError} />
      <div className="card overflow-hidden">
        {assigned && (
          <div className="flex items-center gap-2 border-b bg-success/10 px-4 py-2 text-sm" role="status">
            <span className="flex-1">
              {assigned.perUser.length ? <>Assigned {assigned.assigned} lead{assigned.assigned === 1 ? '' : 's'}: {assigned.perUser.map((p) => `${p.name} ${p.count}`).join(' · ')}</> : <>Unassigned {assigned.assigned} lead{assigned.assigned === 1 ? '' : 's'}</>}
              {assigned.unchanged > 0 && <span className="text-muted-foreground"> ({assigned.unchanged} already with that person)</span>}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => setAssigned(null)}>OK</button>
          </div>
        )}
        {canBulkAssign && (picked.all || picked.ids.size > 0) && (
          <BulkAssignBar selection={picked} pageCount={pageIds.length} total={data?.total || 0} filter={query}
            onSelectAll={() => setSelection({ all: true, ids: new Set(), key })} onClear={() => setPicked(new Set())}
            onDone={(r) => { setAssigned(r); setPicked(new Set()); reload(); }} />
        )}
        {loading && !data ? <Loading /> : !rows.length ? (
          <Empty>{active ? 'No leads match your search or filters.' : 'No leads yet.'}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] border-collapse text-[13px]">
              <thead className="border-b bg-muted/50">
                <tr>
                  {canBulkAssign && <th className={cn(th, 'w-10')}><SelectBox label="Select all on this page" checked={pageIds.length > 0 && pickedOnPage === pageIds.length} indeterminate={pickedOnPage > 0 && pickedOnPage < pageIds.length} onChange={pickPage} /></th>}
                  <th className={th}>Name</th>
                  {show('phone') && <th className={th}>Phone</th>}
                  {show('lastFollowUp') && <th className={th}>Last follow-up</th>}
                  {show('status') && <th className={th}>Status</th>}
                  {show('source') && <th className={th}>Source</th>}
                  {show('ownerId') && <th className={th}>Assignee</th>}
                  {show('createdAt') && <th className={th}>Created at</th>}
                  {show('reminder') && <th className={th}>Reminders</th>}
                  {show('description') && <th className={th}>Description</th>}
                  {show('address') && <th className={th}>Address</th>}
                  <th className={cn(th, 'w-14 text-center')}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((l) => {
                  const fu = l.lastFollowUp && FOLLOW_UP[l.lastFollowUp.type];
                  const rem = reminderOf(l.nextFollowUpAt);
                  const owner = ownerName(l.ownerId);
                  const desc = l.requirement || l.notes;
                  return (
                    <tr key={l.id} className="cursor-pointer hover:bg-muted/40" onClick={() => navigate(`/leads/${l.id}`)}>
                      {canBulkAssign && <td className={td}><SelectBox label={`Select ${l.name}`} checked={Boolean(picked.all || picked.ids.has(l.id))} onChange={(on) => pickRow(l.id, on)} /></td>}
                      <td className={td}>
                        <div className="flex items-start gap-2">
                          <Building2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="max-w-[200px] truncate font-medium">{l.name}</span>
                              {can('leads:update') && <button type="button" className="text-muted-foreground hover:text-primary" aria-label={`Edit ${l.name}`} onClick={(e) => { e.stopPropagation(); setEditing({ ...l }); }}><Pencil className="size-3.5" /></button>}
                            </div>
                            {l.company && <div className="max-w-[220px] truncate text-xs text-muted-foreground">{l.company}</div>}
                          </div>
                        </div>
                      </td>
                      {show('phone') && <td className={cn(td, 'whitespace-nowrap font-mono text-xs')}>{l.phone || '—'}</td>}
                      {show('lastFollowUp') && (
                        <td className={cn(td, 'whitespace-nowrap')} title={l.lastFollowUp ? `${l.lastFollowUp.title || ''} · ${shortDate(l.lastFollowUp.at)}` : 'No follow-up yet'}>
                          {fu ? <span className="inline-flex items-center gap-1.5"><fu.icon className={cn('size-4', fu.cls)} />{fu.text}</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                      )}
                      {show('status') && <td className={td}><span className={cn('whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold', STATUS_STYLE[l.status] || 'bg-muted')}>{label(l.status)}</span></td>}
                      {show('source') && <td className={cn(td, 'whitespace-nowrap')}>{label(l.source)}</td>}
                      {show('ownerId') && (
                        <td className={cn(td, 'whitespace-nowrap')}>
                          {owner ? <span className="inline-flex items-center gap-2"><span className={cn('grid size-6 place-items-center rounded-full text-[10px] font-bold', avatarTone(l.ownerId))}>{initials(owner)}</span>{owner}</span> : <span className="text-muted-foreground">Unassigned</span>}
                        </td>
                      )}
                      {show('createdAt') && <td className={cn(td, 'whitespace-nowrap text-muted-foreground')}>{shortDate(l.createdAt)}</td>}
                      {show('reminder') && (
                        <td className={cn(td, 'whitespace-nowrap')} title={l.nextFollowUpAt ? shortDate(l.nextFollowUpAt) : undefined}>
                          {rem ? <span className="inline-flex items-center gap-1.5"><rem.icon className={cn('size-4', rem.cls)} />{rem.text}</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                      )}
                      {show('description') && <td className={td}><span className="block max-w-[180px] truncate text-muted-foreground" title={desc}>{desc || '—'}</span></td>}
                      {show('address') && <td className={td}><span className="block max-w-[170px] truncate" title={l.address}>{l.address || '—'}</span></td>}
                      <td className={cn(td, 'text-center')} onClick={(e) => e.stopPropagation()}>
                        <RowMenu lead={l} onOpen={() => navigate(`/leads/${l.id}`)} onEdit={() => setEditing({ ...l })} onDelete={() => setDeleting(l)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data?.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
            <span className="text-xs text-muted-foreground">{((pageNo - 1) * pageSize + 1).toLocaleString('en-IN')}–{Math.min(pageNo * pageSize, data.total).toLocaleString('en-IN')} of {data.total.toLocaleString('en-IN')}</span>
            <div className="flex items-center gap-3">
              {data.pages > 1 && <Pages page={pageNo} pages={data.pages} onPage={(n) => { setPage({ n, key }); window.scrollTo({ top: 0 }); }} />}
              <select className="input h-8 w-auto py-0 text-xs" value={pageSize} onChange={(e) => { const n = Number(e.target.value); setPageSize(n); writeStore(SIZE_KEY, n); }} aria-label="Leads per page">
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} items</option>)}
              </select>
            </div>
          </div>
        )}
      </div>

      {importing && <ImportModal entity="leads" title="Leads" onClose={() => setImporting(false)} onImported={reload} />}
      {deleting && <ConfirmDialog danger title={`Delete ${deleting.name}?`} message="The lead and its history will be removed." confirmLabel="Delete" onClose={() => setDeleting(null)} onConfirm={async () => { await del(`/leads/${deleting.id}`); toast('Lead deleted'); reload(); }} />}
      {(creating || editing) && (
        <Modal
          title={creating ? 'New lead' : 'Edit lead'}
          onClose={() => { setCreating(null); setEditing(null); setShowErrors(false); setError(null); }}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => { setCreating(null); setEditing(null); setShowErrors(false); setError(null); }}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={() => save(creating || editing, Boolean(creating))}>{saving ? 'Saving…' : creating ? 'Create' : 'Save'}</button>
            </>
          )}
        >
          <ErrorAlert error={error} />
          <EntityForm entity="leads" value={creating || editing} onChange={creating ? setCreating : setEditing} showErrors={showErrors} />
        </Modal>
      )}
    </>
  );
}
