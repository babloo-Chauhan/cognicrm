import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get } from '../../lib/api.js';
import { label } from '../../lib/format.js';
import { DataTable, ErrorAlert, Loading, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';
import { customerName, docNumber, INVOICE_STATUSES, money2, QUOTE_STATUSES } from './salesUtils.js';

const date = (v) => (v ? new Date(v).toLocaleDateString() : '—');

/** Quotation or invoice list. Also used embedded on deal / contact / account pages through `filter`. */
export function DocList({ kind, filter, embedded = false }) {
  const navigate = useNavigate();
  const path = kind === 'quote' ? 'quotes' : 'invoices';
  const [q, setQ] = useState('');
  const [params] = useSearchParams();
  const [status, setStatus] = useState(embedded ? '' : params.get('status') || '');
  const { data, loading, error } = useAsync(() => get(`/${path}`, { q, status, ...filter, limit: 100 }), [path, q, status, JSON.stringify(filter)]);

  const columns = [
    { key: 'number', label: kind === 'quote' ? 'Quotation' : 'Invoice', render: (r) => <strong>{docNumber(r, kind)}</strong> },
    { key: 'customer', label: 'Customer', render: customerName },
    { key: 'total', label: 'Total', render: (r) => <span className="mono">{money2(r.totals?.total, r.currency)}</span> },
    kind === 'invoice'
      ? { key: 'balanceDue', label: 'Balance', render: (r) => <span className="mono">{r.status === 'void' ? '—' : money2(r.balanceDue, r.currency)}</span> }
      : { key: 'validUntil', label: 'Valid until', render: (r) => date(r.validUntil) },
    kind === 'invoice' ? { key: 'dueDate', label: 'Due', render: (r) => date(r.dueDate) } : { key: 'issueDate', label: 'Date', render: (r) => date(r.issueDate) },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ];

  const table = loading && !data ? <Loading /> : (
    <DataTable columns={columns} rows={data?.items} onRowClick={(r) => navigate(`/${path}/${r.id}`)} empty={kind === 'quote' ? 'No quotations yet.' : 'No invoices yet.'} />
  );
  if (embedded) return <><ErrorAlert error={error} />{table}</>;

  const statuses = kind === 'quote' ? QUOTE_STATUSES : ['unpaid', ...INVOICE_STATUSES];
  return (
    <>
      <div className="page-header">
        <div><h1>{kind === 'quote' ? 'Quotations' : 'Invoices'}</h1>{data && <p>{data.total} total</p>}</div>
        <div className="row">
          <input className="input" style={{ width: 220 }} placeholder="Search number or customer…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          <select className="input" style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            {statuses.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
          <button type="button" className="btn btn-primary" onClick={() => navigate(`/${path}/new`)}>+ New {kind === 'quote' ? 'quotation' : 'invoice'}</button>
        </div>
      </div>
      <ErrorAlert error={error} />
      <div className="card">{table}</div>
    </>
  );
}
