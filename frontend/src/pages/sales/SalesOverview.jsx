import { Link, useNavigate } from 'react-router-dom';
import { get } from '../../lib/api.js';
import { percent } from '../../lib/format.js';
import { ErrorAlert, Loading, Stat } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';
import { money2 } from './salesUtils.js';

const GUIDE = [
  ['1. Capture the lead', 'Add or import leads, call and qualify them.', '/leads'],
  ['2. Convert', 'Open a qualified lead and click Convert — it creates the contact, account and deal.', '/leads'],
  ['3. Quote', 'On the deal click “New quotation”, add products, GST is calculated for you.', '/deals'],
  ['4. Send & accept', 'Send it by email or WhatsApp. The customer accepts online (or mark it accepted). The deal becomes Won.', '/quotes'],
  ['5. Invoice', 'Create the invoice from the accepted quotation, then issue it — it gets the next invoice number.', '/quotes?status=accepted'],
  ['6. Get paid', 'Record payments (UPI, bank, cash…). Unpaid invoices turn overdue automatically after the due date.', '/invoices'],
];

/** Lead → payment funnel with money totals and the overdue list. */
export function SalesOverview() {
  const navigate = useNavigate();
  const { data, loading, error } = useAsync(() => get('/sales/overview'), []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  const max = Math.max(1, ...data.funnel.map((f) => f.count));
  return (
    <>
      <div className="page-header">
        <div><h1>Sales pipeline</h1><p>From new lead to paid invoice.</p></div>
        <div className="row">
          <button type="button" className="btn" onClick={() => navigate('/invoices/new')}>+ Invoice</button>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/quotes/new')}>+ Quotation</button>
        </div>
      </div>
      <div className="grid grid-4">
        <Stat label="Open deals" value={data.deals.open} hint={money2(data.deals.openValue)} />
        <Stat label="Quotes awaiting reply" value={data.quotes.byStatus.sent?.count || 0} hint={`${money2(data.quotes.pendingValue)} · ${percent(data.quotes.acceptanceRate)} accepted`} />
        <Stat label="Collected" value={money2(data.invoices.collected)} hint={`of ${money2(data.invoices.invoiced)} invoiced`} />
        <Stat label="Outstanding" value={money2(data.invoices.outstanding)} hint={data.invoices.overdueCount ? `${data.invoices.overdueCount} overdue · ${money2(data.invoices.overdueAmount)}` : 'Nothing overdue'} />
      </div>
      <div className="grid grid-detail" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-header"><h3>Funnel</h3><span className="small muted">Lead conversion {percent(data.leads.conversionRate)}</span></div>
          <div className="card-body stack">
            {data.funnel.map((f) => (
              <div key={f.key} className="funnel-row">
                <span className="small">{f.label}</span>
                <div className="funnel-bar" role="img" aria-label={`${f.label}: ${f.count}`}><div style={{ width: `${(f.count / max) * 100}%` }} /></div>
                <strong className="mono">{f.count}</strong>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-header"><h3>Overdue invoices</h3><Link className="small" to="/invoices?status=overdue">All</Link></div>
          <div className="card-body stack small">
            {data.overdue.length === 0 && <span className="muted">No overdue invoices.</span>}
            {data.overdue.map((inv) => (
              <Link key={inv._id} to={`/invoices/${inv._id}`} className="row" style={{ justifyContent: 'space-between' }}>
                <span><strong>{inv.number}</strong> · {inv.customer?.company || inv.customer?.name}</span>
                <span className="mono">{money2(inv.balanceDue, inv.currency)} · due {new Date(inv.dueDate).toLocaleDateString()}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header"><h3>How the process works</h3></div>
        <div className="card-body grid grid-3">
          {GUIDE.map(([t, d, to]) => (
            <Link key={t} to={to} className="guide-step">
              <strong>{t}</strong>
              <span className="small muted">{d}</span>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
